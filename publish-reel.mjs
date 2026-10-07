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
//   RESULT_FILE      … 任意。投稿した・失敗したときに結果をJSONで書く先（record-run.mjs が data ブランチと Issue に回す）
//
// 投稿の前に必ず通すもの（どれか1つでも引っかかれば投稿しない）:
//   - 形（lib/reel-schema）と校閲（lib/compliance）。ファイルの checks は信用せず、ここでやり直す
//   - 予定の並び（同じ日に2本ない・週5本まで）と、同じ文の使い回し
//   - 動画URLがひらけるか
//   - 直近の投稿：同じキャプションがもう出ていればスキップ。今日（日本時間）すでにリールがあれば止める。
//     今週（月〜日）すでに5本あれば止める。直近の投稿を確かめられなければ、投稿しない側に倒す

import { readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { todayJST, hourJST, toJstDate, mondayOf, dedupeKey, hashtags } from './lib/rules.mjs';
import { validateReel, totalSeconds } from './lib/reel-schema.mjs';
import { checkReel, scheduleProblems, MAX_REELS_PER_WEEK } from './lib/compliance.mjs';
import { collectPosts, findDupes } from './lib/dupes.mjs';
import { redact } from './lib/diagnose.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(ROOT, 'reels');

const MODE = (process.env.MODE || 'check').trim();

// カードは21〜23時、リールは18〜21時。同じ日に両方あっても、出る時間がずれる
const FROM = Number(process.env.REEL_FROM_JST || 18);
const TO = Number(process.env.REEL_TO_JST || 21);

const API_BASE = process.env.IG_API_BASE || 'https://graph.instagram.com';
const API_VERSION = process.env.IG_API_VERSION || 'v23.0';
const IG_USER_ID = (process.env.IG_USER_ID || 'me').trim();
const RESULT_FILE = process.env.RESULT_FILE || '';

// リールの投稿の上限は、日本時間の暦の日で1本、月〜日の週で5本（自分で決めた運用の上限。APIの上限よりずっと厳しい）。
// 「24時間以内」で数えると、前日の遅い時刻に出した日は翌日の18〜21時がすべて塞がって出し損ねるため、暦で数える

let target = null; // 結果に書く「何を投稿しようとしていたか」

/** 結果を書く（RESULT_FILE があるときだけ）。秘密らしい文字列は伏せる */
async function writeResult(result) {
  if (!RESULT_FILE) return;
  const body = { kind: 'reel', mode: MODE, target, at: new Date().toISOString(), ...result };
  if (body.error) body.error = redact(body.error).slice(0, 500);
  await writeFile(RESULT_FILE, JSON.stringify(body, null, 2));
}

async function fail(msg) {
  console.error(`\n❌ ${redact(msg)}`);
  await writeResult({ ok: false, error: msg });
  process.exit(1);
}
// 想定していない例外（通信が切れた等）でも、結果を残してから終わる。残らないと Issue で知らせられない
process.on('unhandledRejection', (e) => fail(`想定していない失敗: ${e?.message || e}`));
process.on('uncaughtException', (e) => fail(`想定していない失敗: ${e?.message || e}`));
function req(name) {
  if (!process.env[name]) return fail(`環境変数 ${name} が設定されていません`);
}

async function api(endpoint, params) {
  const body = new URLSearchParams({ ...params, access_token: process.env.IG_ACCESS_TOKEN });
  const r = await fetch(`${API_BASE}/${API_VERSION}/${endpoint}`, { method: 'POST', body });
  const json = await r.json().catch(() => ({}));
  if (!r.ok || json.error) await fail(apiError(endpoint, r, json));
  return json;
}
async function apiGet(endpoint, params) {
  const qs = new URLSearchParams({ ...params, access_token: process.env.IG_ACCESS_TOKEN });
  const r = await fetch(`${API_BASE}/${API_VERSION}/${endpoint}?${qs}`);
  const json = await r.json().catch(() => ({}));
  if (!r.ok || json.error) await fail(apiError(endpoint, r, json));
  return json;
}

/** Metaのエラーは、原因の見分けに要る code も一緒に出す（lib/diagnose が code=190 などで判定する） */
function apiError(endpoint, r, json) {
  const e = json?.error;
  return `${endpoint} でエラー: ${e?.message || `HTTP ${r.status}`}` + (e ? ` (code=${e.code} subcode=${e.error_subcode ?? '-'})` : '');
}

async function headStatus(url) {
  try {
    const r = await fetch(url, { method: 'HEAD' });
    return r.status;
  } catch {
    return 0;
  }
}

/**
 * 直近の投稿を見て、出してよいかを決める。
 * 確かめられなければ apiGet が fail する（＝投稿しない側に倒れる）。
 * @returns {'ok' | 'duplicate'}
 */
async function guardRecent(caption) {
  const json = await apiGet(`${IG_USER_ID}/media`, { fields: 'caption,timestamp,media_product_type', limit: '25' });
  const media = json.data || [];
  const key = dedupeKey(caption);
  if (media.some((m) => dedupeKey(m.caption || '') === key)) return 'duplicate';
  const today = todayJST();
  const days = media.filter((m) => m.media_product_type === 'REELS' && m.timestamp).map((m) => toJstDate(m.timestamp));
  if (days.includes(today)) await fail(`今日（${today}）はもうリールを投稿しています。リールは1日1本までなので、今回は投稿しません`);
  const thisWeek = days.filter((d) => mondayOf(d) === mondayOf(today)).length;
  if (thisWeek >= MAX_REELS_PER_WEEK) await fail(`今週（${mondayOf(today)}〜）はもうリールを${thisWeek}本投稿しています。週${MAX_REELS_PER_WEEK}本までなので、今回は投稿しません`);
  return 'ok';
}

async function load(name) {
  const file = path.join(SRC, `${name}.json`);
  if (!existsSync(file)) await fail(`reels/${name}.json がありません`);
  let spec;
  try {
    spec = JSON.parse(await readFile(file, 'utf8'));
  } catch (e) {
    await fail(`reels/${name}.json を読めません: ${e.message}`);
  }
  const errors = validateReel(spec);
  if (errors.length) await fail(`reels/${name}.json の形が正しくありません:\n   - ${errors.join('\n   - ')}`);
  if (!spec.caption) await fail(`reels/${name}.json に caption がありません`);
  const base = process.env.PAGES_BASE_URL;
  if (!base) await fail('環境変数 PAGES_BASE_URL が設定されていません');
  return { name, spec, url: `${base.replace(/\/$/, '')}/reels/${name}.mp4` };
}

/** reels/ の全部を { name, spec } で読む。読めないファイルがあれば止める
 *  （黙って飛ばすと、今日の分が壊れていたときに「出すものなし」で終わってしまう） */
async function loadAll() {
  const out = [];
  for (const f of (await readdir(SRC)).filter((n) => n.endsWith('.json')).sort()) {
    try {
      out.push({ name: f.replace(/\.json$/, ''), spec: JSON.parse(await readFile(path.join(SRC, f), 'utf8')) });
    } catch (e) {
      await fail(`reels/${f} を読めません: ${e.message}`);
    }
  }
  return out;
}

/** 今日の日付が入ったリールを探す。2本以上あれば、黙って1本を選ばずに止める */
async function findToday() {
  const today = todayJST();
  const hits = (await loadAll()).filter((r) => r.spec.date === today).map((r) => r.name);
  if (hits.length > 1) await fail(`今日（${today}）のリールが${hits.length}本あります（${hits.join('・')}）。1日1本までなので、date を直してください`);
  return hits[0] || null;
}

async function check({ name, spec, url }) {
  const caption = spec.caption;
  const tags = hashtags(caption);
  const today = todayJST();

  // 校閲（check-reels.mjs と同じもの）。ファイルの checks は信用しない
  const { errors, warnings } = checkReel(spec, { today });
  const problems = [...errors];
  const all = await loadAll();
  problems.push(...(scheduleProblems(all.filter((r) => r.spec.date).map((r) => ({ name: r.name, date: r.spec.date }))).get(name) || []));
  for (const [s, ids] of findDupes(collectPosts(ROOT, { today }))) {
    if (ids.includes(`reels/${name}`)) problems.push(`「${s}」が ${ids.filter((x) => x !== `reels/${name}`).join('・')} と同じ文です`);
  }

  const seconds = totalSeconds(spec.scenes);
  const status = await headStatus(url);
  if (status !== 200) problems.push(`動画URLがひらけません（HTTP ${status}）: ${url}\n     Pagesが未公開か、build-cards がまだ終わっていない可能性があります`);

  console.log(`\n■ リールの確認 — reels/${name}\n`);
  console.log(`予定日   : ${spec.date || '(なし)'}`);
  console.log(`長さ     : ${seconds.toFixed(1)}秒 / 場面 ${spec.scenes.length}`);
  console.log(`動画URL  : ${status === 200 ? '✅' : '❌'} ${url}`);
  console.log(`キャプション ${caption.length}文字 / ハッシュタグ ${tags.length}個\n`);
  console.log(caption.split('\n').map((l) => `  │ ${l}`).join('\n'));
  for (const w of warnings) console.log(`  △ ${w}`);

  if (problems.length) {
    console.log('\n──────── 投稿できません ────────');
    for (const p of problems) console.log(`  ❌ ${p}`);
    await fail(`校閲を通りません（${problems.length}件）: ${problems[0]}`);
  }
  console.log('\n✅ チェックはすべて通りました。');
}

/** 動画は変換に時間がかかる。カードより長めに待つ */
async function waitReady(containerId) {
  for (let i = 0; i < 100; i++) {
    const { status_code, status } = await apiGet(containerId, { fields: 'status_code,status' });
    if (status_code === 'FINISHED') return;
    if (status_code === 'ERROR' || status_code === 'EXPIRED') {
      await fail(`動画の変換に失敗しました (status_code=${status_code}) ${status || ''}`);
    }
    process.stdout.write('.');
    await new Promise((r) => setTimeout(r, 3000));
  }
  await fail('動画の変換が5分たっても終わりませんでした');
}

async function publish({ spec, url }) {
  await req('IG_ACCESS_TOKEN');
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
  await writeResult({ ok: true, mediaId: id });
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
if (!name) await fail('環境変数 REEL に reels/ のファイル名（拡張子なし）を指定してください');
target = `reels/${name}`;

const reel = await load(name);
await check(reel);

if (MODE === 'publish' || MODE === 'scheduled') {
  await req('IG_ACCESS_TOKEN');
  if ((await guardRecent(reel.spec.caption)) === 'duplicate') {
    console.log('\n同じ内容がすでに投稿されています。重複を避けてスキップしました。');
    await writeResult({ ok: true, skipped: 'duplicate' });
    process.exit(0);
  }
  await publish(reel);
} else {
  console.log('\n（確認しただけで投稿はしていません。投稿するには MODE=publish）');
}
