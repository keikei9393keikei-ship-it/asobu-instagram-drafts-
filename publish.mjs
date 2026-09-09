// publish.mjs — weeks/<日付>/ のカードとキャプションを Instagram に投稿する（半自動）
//
// GitHub Actions の「Actions → publish-instagram → Run workflow」から手動で実行する。
// まず mode=check（下書き確認）で中身を確かめ、問題なければ mode=publish で投稿する。
//
// 画像は Pages 上の公開URLを Instagram に渡す方式なので、先に build-cards が成功して
// Pages が公開されている必要がある（APIは画像ファイルを直接受け取れない）。
//
// 必要な環境変数:
//   WEEK             … weeks/ 配下のフォルダ名（例 2026-09-10）
//   MODE             … 'check'（既定・投稿しない） / 'publish'
//   IG_USER_ID       … InstagramのプロアカウントのユーザーID
//   IG_ACCESS_TOKEN  … instagram_business_content_publish を含むアクセストークン
//   PAGES_BASE_URL   … 例 https://<user>.github.io/<repo>
//   IG_API_BASE      … 任意。既定は https://graph.instagram.com
//   IG_API_VERSION   … 任意。既定は v23.0（Metaが古い版を廃止したらここを上げる）

import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

const WEEK = req('WEEK');
const MODE = (process.env.MODE || 'check').trim();
const PAGES_BASE_URL = req('PAGES_BASE_URL').replace(/\/+$/, '');
const API_BASE = (process.env.IG_API_BASE || 'https://graph.instagram.com').replace(/\/+$/, '');
const API_VERSION = process.env.IG_API_VERSION || 'v23.0';

// Instagram側の制限
const MAX_CAROUSEL = 10;   // カルーセルは最大10枚
const MAX_CAPTION = 2200;  // キャプションの最大文字数
const MAX_HASHTAGS = 30;   // ハッシュタグの最大個数

function req(name) {
  const v = process.env[name];
  if (!v || !v.trim()) fail(`環境変数 ${name} が設定されていません`);
  return v.trim();
}

function fail(msg) {
  console.error(`\n❌ ${msg}\n`);
  process.exit(1);
}

/** cards.json の並びから、render.mjs が出力するファイル名を復元する */
function fileNames(cards) {
  return cards.map((c, i) => `${String(i + 1).padStart(2, '0')}_${c.layout || 'card'}.png`);
}

async function loadWeek() {
  const dir = path.join(ROOT, 'weeks', WEEK);
  if (!existsSync(dir)) {
    const available = existsSync(path.join(ROOT, 'weeks'))
      ? (await readdir(path.join(ROOT, 'weeks'))).join(', ')
      : '(なし)';
    fail(`weeks/${WEEK} が見つかりません。あるのは: ${available}`);
  }
  const cardsPath = path.join(dir, 'cards.json');
  if (!existsSync(cardsPath)) fail(`weeks/${WEEK}/cards.json がありません`);

  let cards;
  try {
    cards = JSON.parse(await readFile(cardsPath, 'utf8'));
  } catch (e) {
    fail(`weeks/${WEEK}/cards.json を読めません: ${e.message}`);
  }
  if (!Array.isArray(cards) || cards.length === 0) fail(`cards.json が空です`);

  const captionPath = path.join(dir, 'caption.txt');
  if (!existsSync(captionPath)) fail(`weeks/${WEEK}/caption.txt がありません`);
  const caption = (await readFile(captionPath, 'utf8')).trim();

  return { cards, caption, urls: fileNames(cards).map((f) => `${PAGES_BASE_URL}/${WEEK}/${f}`) };
}

/** 投稿前の自己チェック。ここで落とせるものは投稿前に落とす */
async function check({ cards, caption, urls }) {
  const problems = [];

  if (cards.length > MAX_CAROUSEL) {
    problems.push(`カードが${cards.length}枚。Instagramのカルーセルは最大${MAX_CAROUSEL}枚まで`);
  }
  if (caption.length > MAX_CAPTION) {
    problems.push(`キャプションが${caption.length}文字。上限は${MAX_CAPTION}文字`);
  }
  const tags = caption.match(/#[^\s#]+/g) || [];
  if (tags.length > MAX_HASHTAGS) {
    problems.push(`ハッシュタグが${tags.length}個。上限は${MAX_HASHTAGS}個`);
  }
  // 会場名は投稿に出さない運用（CLAUDE.md）。「◯◯体育館」という固有名が混ざっていないか見る。
  // 「和歌山市内の体育館」はOK、「体育館シューズ」は持ち物なので対象外。
  const venueRe = /([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}A-Za-z0-9]{1,12})体育館(?!シューズ)/gu;
  for (const m of caption.matchAll(venueRe)) {
    if (!/(和歌山)?市内の$/.test(m[1])) {
      problems.push(`キャプションに会場名らしき表記があります: 「${m[0]}」（会場は投稿に出さない運用）`);
    }
  }

  console.log(`\n■ 投稿内容の確認 — weeks/${WEEK}\n`);
  console.log(`カード ${cards.length}枚 / キャプション ${caption.length}文字 / ハッシュタグ ${tags.length}個\n`);

  console.log('画像URL（Instagramが取りに行く先）:');
  let unreachable = 0;
  for (const url of urls) {
    const status = await headStatus(url);
    const ok = status.ok && /^image\//.test(status.type || '');
    if (!ok) unreachable++;
    console.log(`  ${ok ? '✅' : '❌'} ${url}  ${status.label}`);
  }
  if (unreachable > 0) {
    problems.push(
      `画像URLが${unreachable}件ひらけません。` +
      `Pagesが公開されていないか、まだビルドされていない可能性があります` +
      `（Settings → Pages → Source = GitHub Actions。無料プランでは公開リポジトリのみ。そのあと build-cards の成功が必要）`
    );
  }

  console.log('\nキャプション:\n');
  console.log(caption.split('\n').map((l) => `  │ ${l}`).join('\n'));

  if (problems.length) {
    console.error('\n──────── 投稿できません ────────');
    problems.forEach((p) => console.error(`  ❌ ${p}`));
    console.error('');
    process.exit(1);
  }
  console.log('\n✅ チェックはすべて通りました。');
}

async function headStatus(url) {
  try {
    const r = await fetch(url, { method: 'HEAD', redirect: 'follow' });
    return { ok: r.ok, type: r.headers.get('content-type'), label: `HTTP ${r.status}` };
  } catch (e) {
    return { ok: false, type: null, label: `接続できません (${e.message})` };
  }
}

/** Graph API 呼び出し。エラーはMetaの本文をそのまま見せる */
async function api(endpoint, params) {
  const url = `${API_BASE}/${API_VERSION}/${endpoint}`;
  const body = new URLSearchParams({ ...params, access_token: process.env.IG_ACCESS_TOKEN });
  const r = await fetch(url, { method: 'POST', body });
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); } catch { json = null; }
  if (!r.ok || !json || json.error) {
    const e = json?.error;
    fail(
      `Instagram API エラー (${r.status}) — ${url}\n   ` +
      (e ? `${e.message}\n   type=${e.type} code=${e.code} subcode=${e.error_subcode ?? '-'} trace=${e.fbtrace_id ?? '-'}`
         : text.slice(0, 500))
    );
  }
  return json;
}

async function apiGet(endpoint, params) {
  const qs = new URLSearchParams({ ...params, access_token: process.env.IG_ACCESS_TOKEN });
  const r = await fetch(`${API_BASE}/${API_VERSION}/${endpoint}?${qs}`);
  const json = await r.json().catch(() => null);
  if (!r.ok || !json || json.error) {
    fail(`Instagram API エラー (${r.status}) — ${json?.error?.message || 'レスポンスを読めません'}`);
  }
  return json;
}

/** コンテナが投稿できる状態になるまで待つ */
async function waitReady(containerId, label) {
  for (let i = 0; i < 30; i++) {
    const { status_code, status } = await apiGet(containerId, { fields: 'status_code,status' });
    if (status_code === 'FINISHED') return;
    if (status_code === 'ERROR' || status_code === 'EXPIRED') {
      fail(`${label} の準備に失敗しました (status_code=${status_code}) ${status || ''}`);
    }
    process.stdout.write('.');
    await new Promise((r) => setTimeout(r, 3000));
  }
  fail(`${label} の準備が90秒たっても終わりませんでした`);
}

async function publish({ caption, urls }) {
  const igUserId = req('IG_USER_ID');
  req('IG_ACCESS_TOKEN');

  let creationId;

  if (urls.length === 1) {
    console.log('\n単一画像として投稿します…');
    const { id } = await api(`${igUserId}/media`, { image_url: urls[0], caption });
    creationId = id;
  } else {
    console.log(`\nカルーセル ${urls.length}枚 のコンテナを作成中…`);
    const children = [];
    for (const [i, image_url] of urls.entries()) {
      const { id } = await api(`${igUserId}/media`, { image_url, is_carousel_item: 'true' });
      console.log(`  ${i + 1}/${urls.length} ok (${id})`);
      children.push(id);
    }
    const { id } = await api(`${igUserId}/media`, {
      media_type: 'CAROUSEL',
      children: children.join(','),
      caption,
    });
    creationId = id;
  }

  process.stdout.write('投稿の準備待ち');
  await waitReady(creationId, 'コンテナ');
  console.log('');

  const { id } = await api(`${igUserId}/media_publish`, { creation_id: creationId });
  console.log(`\n✅ 投稿しました。media id = ${id}`);
  console.log('   Instagramアプリで表示を確認してください。');
}

const week = await loadWeek();
await check(week);

if (MODE === 'publish') {
  await publish(week);
} else {
  console.log('\n（mode=check のため投稿はしていません）');
  console.log('このまま投稿するには、Run workflow で mode に publish を選んで実行してください。');
}
