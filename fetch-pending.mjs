// fetch-pending.mjs — 承認待ち（開いている週次PR）のリールを取ってくる
//
//   node fetch-pending.mjs
//
// build.yml が、リールを書き出す前に走らせる。開いているPRのうち、
//   - ラベル weekly-reels が付いている
//   - このリポジトリのブランチから出ている（フォークからのPRは取り込まない）
// ものだけを対象に、そのPRで足した・直した reels/*.json を pending-src/<PR番号>/ に置く。
// そのあと render-reel.mjs が dist/pending/<PR番号>/ に書き出し、ボードの「承認待ち」で再生できる。
//
// pending/ の動画は、投稿に使うURL（/reels/<名前>.mp4）とは別の場所。承認前の動画が投稿されることはない。
// もう承認待ちでないPRの動画（dist/pending/<番号>/）は、ここで消す（キャッシュから戻ってきても残さない）。

import { mkdir, writeFile, rm, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(ROOT, 'pending-src');
const DIST = path.join(ROOT, 'dist', 'pending');
const REPO = process.env.GITHUB_REPOSITORY || 'keikei9393keikei-ship-it/asobu-instagram-drafts-';
const TOKEN = process.env.GITHUB_TOKEN || '';
export const PR_LABEL = 'weekly-reels';

async function gh(endpoint, { raw = false } = {}) {
  const headers = { Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
  const r = await fetch(`https://api.github.com${endpoint}`, { headers });
  if (!r.ok) throw new Error(`GitHub API ${endpoint.split('?')[0]} → HTTP ${r.status}`);
  return raw ? r.text() : r.json();
}

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

let pulls = [];
let listed = false;
try {
  pulls = (await gh(`/repos/${REPO}/pulls?state=open&per_page=50`))
    .filter((pr) => pr.labels?.some((l) => l.name === PR_LABEL) && pr.head?.repo?.full_name === REPO);
  listed = true;
} catch (e) {
  // 取れなくてもビルドは止めない（承認待ちのプレビューが出ないだけ）
  console.log(`承認待ちのPRを取れませんでした: ${e.message}`);
}

const kept = new Set();
for (const pr of pulls) {
  try {
    const files = await gh(`/repos/${REPO}/pulls/${pr.number}/files?per_page=100`);
    const reels = files.filter((f) => /^reels\/[^/]+\.json$/.test(f.filename) && f.status !== 'removed');
    if (!reels.length) continue;
    const dir = path.join(OUT, String(pr.number));
    await mkdir(dir, { recursive: true });
    for (const f of reels) {
      const text = await gh(`/repos/${REPO}/contents/${f.filename}?ref=${pr.head.sha}`, { raw: true });
      await writeFile(path.join(dir, path.basename(f.filename)), text);
    }
    kept.add(String(pr.number));
    console.log(`  #${pr.number}: ${reels.length}本 -> pending-src/${pr.number}/`);
  } catch (e) {
    // 1本のPRが取れなくても、ほかのPRとビルドは止めない。前回の動画は残しておく
    kept.add(String(pr.number));
    console.log(`  #${pr.number}: 取れませんでした（${e.message}）。前回のプレビューを残します`);
  }
}

// もう承認待ちでないPRの動画を消す。一覧が取れなかったときは消さない（取れないだけで全部消えてしまうため）
if (listed && existsSync(DIST)) {
  for (const d of await readdir(DIST)) {
    if (!kept.has(d)) {
      await rm(path.join(DIST, d), { recursive: true, force: true });
      console.log(`  dist/pending/${d}: もう承認待ちではないので消しました`);
    }
  }
}
console.log(`承認待ちのPR ${kept.size}本`);
