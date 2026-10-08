// fetch-metrics.mjs — 投稿済みリールの数字を Instagram から取り込み、data ブランチの metrics/ に残す
//
//   MODE=probe node fetch-metrics.mjs   … 権限が足りているかだけを確かめる（何も書かない）
//   MODE=fetch node fetch-metrics.mjs   … 数字を取り込み、data ブランチに書く（既定）
//
// Actions の fetch-metrics.yml が毎日動かす。トークンは IG_ACCESS_TOKEN（GitHub Secrets）。
//
// しくみ：
//   1. 直近の投稿（最大100件）を取り、リール（media_product_type=REELS）だけにする
//   2. キャプションで reels/<名前>.json と突き合わせる（名乗りを除いて比べる。publish-reel と同じ鍵）
//   3. 合ったものだけインサイトを取り、data:metrics/<名前>.json に「その日の数字」を1件足す（同じ日なら上書き）
//   4. トークンの生死を data:runs/token.json に残す（ボードの警告に使う）
//
// 必要な権限：instagram_business_basic と instagram_business_manage_insights。
// 足りないときは probe が止まり、何をすればよいかを出す（M6 の手順。CLAUDE.md §7.10）。
//
// ⚠️ ログは公開される。キャプション本文は出さない（名前と数字だけ）。トークンは redact で伏せる。

import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dedupeKey, todayJST } from './lib/rules.mjs';
import { redact } from './lib/diagnose.mjs';
import { writeDataBranch } from './lib/databranch.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const MODE = (process.env.MODE || 'fetch').trim();
const API_BASE = (process.env.IG_API_BASE || 'https://graph.instagram.com').replace(/\/+$/, '');
const API_VERSION = process.env.IG_API_VERSION || 'v23.0';
const IG_USER_ID = (process.env.IG_USER_ID || '').trim() || 'me';
const TOKEN = process.env.IG_ACCESS_TOKEN || '';
const SNAPSHOTS = 120; // 1本あたり残す日数（約4か月）

// 取りたい指標。リールで使えない指標があっても、ほかは取れるように1つずつ試す
const METRICS = ['views', 'reach', 'saved', 'shares', 'likes', 'comments', 'total_interactions', 'ig_reels_avg_watch_time', 'follows'];
const RENAME = { ig_reels_avg_watch_time: 'avg_watch_ms' };

class ApiError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

async function apiGet(endpoint, params = {}) {
  const qs = new URLSearchParams({ ...params, access_token: TOKEN });
  const r = await fetch(`${API_BASE}/${API_VERSION}/${endpoint}?${qs}`);
  const json = await r.json().catch(() => null);
  if (!r.ok || !json || json.error) {
    const e = json?.error;
    throw new ApiError(`${endpoint.split('?')[0]}: ${e?.message || `HTTP ${r.status}`} (code=${e?.code ?? '-'})`, e?.code);
  }
  return json;
}

/** 直近の投稿（最大 limit 件） */
async function recentMedia(limit = 100) {
  const out = [];
  let after;
  while (out.length < limit) {
    const page = await apiGet(`${IG_USER_ID}/media`, {
      fields: 'id,caption,media_product_type,timestamp,permalink', limit: '50', ...(after ? { after } : {}),
    });
    out.push(...(page.data || []));
    after = page.paging?.cursors?.after;
    if (!page.paging?.next || !after) break;
  }
  return out.slice(0, limit);
}

/** 1本のインサイト。まとめて頼み、だめなら1つずつ（リールで使えない指標があるため） */
async function insights(mediaId, metrics = METRICS) {
  const read = (json) => Object.fromEntries((json.data || []).map((d) => [d.name, d.values?.[0]?.value ?? d.total_value?.value ?? null]));
  try {
    return { values: read(await apiGet(`${mediaId}/insights`, { metric: metrics.join(',') })), unsupported: [] };
  } catch (e) {
    if (e.code === 190 || e.code === 10 || e.code === 200) throw e; // トークン・権限の問題は1つずつ試しても同じ
    const values = {};
    const unsupported = [];
    for (const m of metrics) {
      try { Object.assign(values, read(await apiGet(`${mediaId}/insights`, { metric: m }))); } catch { unsupported.push(m); }
    }
    return { values, unsupported };
  }
}

async function loadReels() {
  const dir = path.join(ROOT, 'reels');
  const out = [];
  for (const f of (await readdir(dir)).filter((n) => n.endsWith('.json'))) {
    try {
      const spec = JSON.parse(await readFile(path.join(dir, f), 'utf8'));
      if (spec.caption) out.push({ name: f.replace(/\.json$/, ''), key: dedupeKey(spec.caption) });
    } catch { /* 読めないものは飛ばす（校閲で止まる） */ }
  }
  return out;
}

function fail(msg) {
  console.error(`\n❌ ${redact(msg)}`);
  process.exit(1);
}

const SETUP_STEPS = `
──────── あなたがやること（数字の取り込みに必要な権限）────────
  1. Meta for Developers → アプリ → Instagram → 「API setup with Instagram login」を開く
  2. 権限に instagram_business_manage_insights を足す（instagram_business_basic と content_publish はそのまま）
  3. 「Generate token」でアクセストークンを取り直す（Instagram のアカウントで許可する画面が出る）
  4. GitHub → Settings → Secrets and variables → Actions → IG_ACCESS_TOKEN を新しいトークンに更新する
  5. Actions → fetch-metrics → Run workflow で mode=probe を選び、✅ になるか確かめる
  ※ 投稿用のトークンも同じものなので、更新したあとも投稿はそのまま動く
`;

if (!TOKEN) fail('IG_ACCESS_TOKEN が設定されていません');

// ── 権限の確認 ─────────────────────────────────────────────
let me;
try {
  me = await apiGet(IG_USER_ID, { fields: 'id,username,account_type' });
} catch (e) {
  fail(`トークンを確かめられません: ${e.message}\n   トークンの期限切れなら、Meta で取り直して IG_ACCESS_TOKEN を更新してください`);
}
console.log(`✅ トークンは有効です（@${me.username ?? '?'}・${me.account_type ?? '?'}）`);

let media;
try {
  media = await recentMedia(MODE === 'probe' ? 25 : 100);
} catch (e) {
  fail(`投稿の一覧を取れません: ${e.message}`);
}
const reelsMedia = media.filter((m) => m.media_product_type === 'REELS');
console.log(`   直近の投稿 ${media.length}件のうち、リール ${reelsMedia.length}件`);

if (MODE === 'probe') {
  const sample = reelsMedia[0] || media[0];
  if (!sample) {
    console.log('   投稿が1件も無いので、インサイトの権限は確かめられません（権限の設定だけ済ませておけば、投稿後に取れます）');
    process.exit(0);
  }
  try {
    const { values, unsupported } = await insights(sample.id);
    const got = Object.keys(values).filter((k) => values[k] !== null);
    console.log(`✅ インサイトを取れました（${sample.media_product_type}・${sample.timestamp?.slice(0, 10)}）`);
    console.log(`   取れた指標   : ${got.join(', ') || '(なし)'}`);
    console.log(`   取れない指標 : ${unsupported.join(', ') || '(なし)'}`);
    if (unsupported.includes('follows')) console.log('   ※ リール単体のフォロー数はAPIで取れません。ボードでは「—」と出ます');
    process.exit(0);
  } catch (e) {
    console.error(`\n❌ インサイトを取れません: ${redact(e.message)}`);
    if (e.code === 10 || e.code === 200 || /permission/i.test(e.message)) console.error(SETUP_STEPS);
    process.exit(1);
  }
}

// ── 取り込み ─────────────────────────────────────────────
const reels = await loadReels();
const today = todayJST();
const results = [];
for (const m of reelsMedia) {
  const hit = reels.find((r) => r.key === dedupeKey(m.caption || ''));
  if (!hit) continue;
  try {
    const { values } = await insights(m.id);
    const snap = { at: today };
    for (const k of METRICS) snap[RENAME[k] || k] = typeof values[k] === 'number' ? values[k] : null;
    results.push({ name: hit.name, media_id: m.id, permalink: m.permalink, posted_at: m.timestamp, snap });
    console.log(`   ${hit.name}: 再生 ${snap.views ?? '—'} / 保存 ${snap.saved ?? '—'} / シェア ${snap.shares ?? '—'}`);
  } catch (e) {
    if (e.code === 10 || e.code === 200) fail(`インサイトの権限がありません: ${e.message}\n${SETUP_STEPS}`);
    console.log(`   ${hit.name}: 取れませんでした（${redact(e.message)}）`);
  }
}
console.log(`突き合わせできたリール ${results.length}本`);

if (process.env.DRY_RUN === 'true') {
  console.log('（DRY_RUN のため data ブランチには書きません）');
  process.exit(0);
}

await writeDataBranch(async (dir) => {
  const changed = [];
  for (const r of results) {
    const rel = `metrics/${r.name}.json`;
    const file = path.join(dir, rel);
    const prev = existsSync(file) ? JSON.parse(await readFile(file, 'utf8')) : { snapshots: [] };
    const snapshots = [...(prev.snapshots || []).filter((s) => s.at !== r.snap.at), r.snap]
      .sort((a, b) => a.at.localeCompare(b.at)).slice(-SNAPSHOTS);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify({ media_id: r.media_id, permalink: r.permalink, posted_at: r.posted_at, snapshots }, null, 2)}\n`);
    changed.push(rel);
  }
  const tokenFile = path.join(dir, 'runs', 'token.json');
  await mkdir(path.dirname(tokenFile), { recursive: true });
  await writeFile(tokenFile, `${JSON.stringify({ ok: true, checkedAt: new Date().toISOString() }, null, 2)}\n`);
  changed.push('runs/token.json');
  return changed;
}, `data: metrics ${today} (${results.length} reels)`);
console.log('data ブランチに書きました。');
