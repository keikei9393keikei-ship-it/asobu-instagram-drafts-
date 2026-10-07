// publish-reel.mjs — reels/<名前>.json のリール動画を Instagram に投稿する
//
// カードの投稿は publish.mjs、リールはこちら。別にしてあるのは、
// 投稿する時間帯も、APIの投げ方（media_type=REELS）も違うため。
//
// 動画は Pages 上の公開URLを Instagram に渡す方式なので、先に build-cards が成功して
// Pages が公開されている必要がある（APIは動画ファイルを直接受け取れない）。
//
// 必要な環境変数:
//   MODE             … 'check'（既定・投稿しない） / 'publish' / 'scheduled'（今日の日付のリールがあれば投稿）
//   REEL             … 'publish' のときに投稿する reels/ のファイル名（拡張子なし）
//   IG_ACCESS_TOKEN  … instagram_business_content_publish を含むアクセストークン
//   IG_USER_ID       … 任意。既定は 'me'
//   PAGES_BASE_URL   … 例 https://<user>.github.io/<repo>
//   REEL_FROM_JST    … 任意。scheduled が投稿してよい時間帯の開始（既定 18）
//   REEL_TO_JST      … 任意。同じく終了（既定 21）
//   IGNORE_WINDOW    … 任意。'true' なら時間帯の判定を飛ばす（手動実行のとき）

import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  todayJST, hourJST, GREETING_RE, dedupeKey, venueHits, hashtags, MAX_CAPTION, MAX_HASHTAGS,
} from './lib/rules.mjs';
import { validateReel, totalSeconds } from './lib/reel-schema.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(ROOT, 'reels');

const MODE = (process.env.MODE || 'check').trim();

// カードは21〜23時、リールは18〜21時。同じ日に両方あっても、出る時間がずれる
const FROM = Number(process.env.REEL_FROM_JST || 18);
const TO = Number(process.env.REEL_TO_JST || 21);

const API_BASE = process.env.IG_API_BASE || 'https://graph.instagram.com';
const API_VERSION = process.env.IG_API_VERSION || 'v23.0';
const IG_USER_ID = (process.env.IG_USER_ID || 'me').trim();

function fail(msg) {
  console.error(`\n❌ ${msg}`);
  process.exit(1);
}
function req(name) {
  if (!process.env[name]) fail(`環境変数 ${name} が設定されていません`);
}

async function api(endpoint, params) {
  const body = new URLSearchParams({ ...params, access_token: process.env.IG_ACCESS_TOKEN });
  const r = await fetch(`${API_BASE}/${API_VERSION}/${endpoint}`, { method: 'POST', body });
  const json = await r.json().catch(() => ({}));
  if (!r.ok || json.error) fail(`${endpoint} でエラー: ${json?.error?.message || `HTTP ${r.status}`}`);
  return json;
}
async function apiGet(endpoint, params) {
  const qs = new URLSearchParams({ ...params, access_token: process.env.IG_ACCESS_TOKEN });
  const r = await fetch(`${API_BASE}/${API_VERSION}/${endpoint}?${qs}`);
  const json = await r.json().catch(() => ({}));
  if (!r.ok || json.error) fail(`${endpoint} でエラー: ${json?.error?.message || `HTTP ${r.status}`}`);
  return json;
}

async function headStatus(url) {
  try {
    const r = await fetch(url, { method: 'HEAD' });
    return r.status;
  } catch {
    return 0;
  }
}

async function alreadyPosted(caption) {
  const key = dedupeKey(caption);
  try {
    const json = await apiGet(`${IG_USER_ID}/media`, { fields: 'caption', limit: '10' });
    return (json.data || []).some((m) => dedupeKey(m.caption || '') === key);
  } catch (e) {
    console.log(`   （直近の投稿を確認できませんでした: ${e.message}。そのまま進みます）`);
    return false;
  }
}

async function load(name) {
  const file = path.join(SRC, `${name}.json`);
  if (!existsSync(file)) fail(`reels/${name}.json がありません`);
  let spec;
  try {
    spec = JSON.parse(await readFile(file, 'utf8'));
  } catch (e) {
    fail(`reels/${name}.json を読めません: ${e.message}`);
  }
  const errors = validateReel(spec);
  if (errors.length) fail(`reels/${name}.json の形が正しくありません:\n   - ${errors.join('\n   - ')}`);
  if (!spec.caption) fail(`reels/${name}.json に caption がありません`);
  const base = process.env.PAGES_BASE_URL;
  if (!base) fail('環境変数 PAGES_BASE_URL が設定されていません');
  return { name, spec, url: `${base.replace(/\/$/, '')}/reels/${name}.mp4` };
}

/** 今日の日付が入ったリールを探す */
async function findToday() {
  const today = todayJST();
  const names = (await readdir(SRC)).filter((n) => n.endsWith('.json')).map((n) => n.replace(/\.json$/, ''));
  for (const n of names.sort()) {
    const spec = JSON.parse(await readFile(path.join(SRC, `${n}.json`), 'utf8'));
    if (spec.date === today) return n;
  }
  return null;
}

async function check({ name, spec, url }) {
  const problems = [];
  const caption = spec.caption;

  if (caption.length > MAX_CAPTION) problems.push(`キャプションが${caption.length}文字。上限は${MAX_CAPTION}文字`);
  const tags = hashtags(caption);
  if (tags.length > MAX_HASHTAGS) problems.push(`ハッシュタグが${tags.length}個。上限は${MAX_HASHTAGS}個`);
  if (!GREETING_RE.test(caption)) problems.push('キャプションの冒頭が名乗りで始まっていません');

  // 会場名は投稿に出さない運用（CLAUDE.md §4-2）。「和歌山市内の体育館」はOK
  for (const hit of venueHits(caption)) problems.push(`キャプションに会場名らしき表記があります: 「${hit}」`);

  const seconds = totalSeconds(spec.scenes);
  const status = await headStatus(url);
  if (status !== 200) problems.push(`動画URLがひらけません（HTTP ${status}）: ${url}\n     Pagesが未公開か、build-cards がまだ終わっていない可能性があります`);

  console.log(`\n■ リールの確認 — reels/${name}\n`);
  console.log(`予定日   : ${spec.date || '(なし)'}`);
  console.log(`長さ     : ${seconds.toFixed(1)}秒 / 場面 ${spec.scenes.length}`);
  console.log(`動画URL  : ${status === 200 ? '✅' : '❌'} ${url}`);
  console.log(`キャプション ${caption.length}文字 / ハッシュタグ ${tags.length}個\n`);
  console.log(caption.split('\n').map((l) => `  │ ${l}`).join('\n'));

  if (problems.length) {
    console.log('\n──────── 投稿できません ────────');
    for (const p of problems) console.log(`  ❌ ${p}`);
    process.exit(1);
  }
  console.log('\n✅ チェックはすべて通りました。');
}

/** 動画は変換に時間がかかる。カードより長めに待つ */
async function waitReady(containerId) {
  for (let i = 0; i < 100; i++) {
    const { status_code, status } = await apiGet(containerId, { fields: 'status_code,status' });
    if (status_code === 'FINISHED') return;
    if (status_code === 'ERROR' || status_code === 'EXPIRED') {
      fail(`動画の変換に失敗しました (status_code=${status_code}) ${status || ''}`);
    }
    process.stdout.write('.');
    await new Promise((r) => setTimeout(r, 3000));
  }
  fail('動画の変換が5分たっても終わりませんでした');
}

async function publish({ spec, url }) {
  req('IG_ACCESS_TOKEN');
  console.log('\nリールのコンテナを作成中…');
  const { id: creationId } = await api(`${IG_USER_ID}/media`, {
    media_type: 'REELS',
    video_url: url,
    caption: spec.caption,
    share_to_feed: 'true',
  });
  console.log(`  ok (${creationId})`);

  process.stdout.write('動画の変換待ち');
  await waitReady(creationId);
  console.log('');

  const { id } = await api(`${IG_USER_ID}/media_publish`, { creation_id: creationId });
  console.log(`\n✅ 投稿しました。media id = ${id}`);
  console.log('   Instagramアプリで表示を確認してください。');
}

if (MODE === 'scheduled' && process.env.IGNORE_WINDOW !== 'true') {
  const h = hourJST();
  if (h < FROM || h >= TO) {
    console.log(`いまは日本時間 ${h}時台です。リールを投稿するのは ${FROM}:00〜${TO}:00 の回だけなので、何もせず終了します。`);
    process.exit(0);
  }
}

let name = process.env.REEL;
if (MODE === 'scheduled') {
  name = await findToday();
  if (!name) {
    console.log(`今日（${todayJST()}）に予定されたリールはありません。何もせず終了します。`);
    process.exit(0);
  }
}
if (!name) fail('環境変数 REEL に reels/ のファイル名（拡張子なし）を指定してください');

const reel = await load(name);
await check(reel);

if (MODE === 'publish' || MODE === 'scheduled') {
  if (MODE === 'scheduled' && (await alreadyPosted(reel.spec.caption))) {
    console.log('\n同じ内容がすでに投稿されています。重複を避けてスキップしました。');
    process.exit(0);
  }
  await publish(reel);
} else {
  console.log('\n（確認しただけで投稿はしていません。投稿するには MODE=publish）');
}
