// guard-public.mjs — Pages に出す前に dist/ を調べ、出してはいけないものがあれば止める
//
//   npm run guard
//
// dist/ はそのまま公開される。次のどれかが見つかったら終了コード1でビルドを落とす。
//   - トークンや鍵らしい文字列（lib/diagnose.mjs の redact が伏せる形のもの）
//   - status.json に、DMの本文や相手の名前を入れそうなキー（text / username など）
//   - status.json の inbox に、決まった形（件数・優先度・期限）以外のもの

import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { looksSecret } from './lib/diagnose.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(ROOT, process.argv[2] || 'dist');
const TEXT_EXT = new Set(['.json', '.html', '.txt', '.js', '.css', '.md']);
const FORBIDDEN_KEYS = new Set(['text', 'message', 'messages', 'username', 'from', 'sender', 'access_token', 'token']);
const INBOX_KEYS = new Set(['available', 'updatedAt', 'unreplied', 'byPriority', 'first', 'schedule', 'other', 'deadlines', 'priority', 'due']);

const problems = [];

async function* walk(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else yield p;
  }
}

function scanKeys(v, at, allowed) {
  if (Array.isArray(v)) return v.forEach((x, i) => scanKeys(x, `${at}[${i}]`, allowed));
  if (!v || typeof v !== 'object') return;
  for (const [k, x] of Object.entries(v)) {
    if (FORBIDDEN_KEYS.has(k)) problems.push(`status.json の ${at}.${k} は出してはいけないキーです`);
    if (allowed && !allowed.has(k)) problems.push(`status.json の ${at}.${k} は受信箱の要約に無いキーです`);
    scanKeys(x, `${at}.${k}`, allowed);
  }
}

if (!existsSync(DIST)) {
  console.log(`${path.relative(ROOT, DIST)}/ がありません。何も調べずに終わります。`);
  process.exit(0);
}

let files = 0;
for await (const f of walk(DIST)) {
  if (!TEXT_EXT.has(path.extname(f))) continue;
  files++;
  const text = await readFile(f, 'utf8');
  if (looksSecret(text)) problems.push(`${path.relative(ROOT, f)} にトークンや鍵らしい文字列があります`);
}

const statusFile = path.join(DIST, 'status.json');
if (existsSync(statusFile)) {
  const status = JSON.parse(await readFile(statusFile, 'utf8'));
  const { inbox, ...rest } = status;
  scanKeys(rest, '$', null);
  scanKeys(inbox, '$.inbox', INBOX_KEYS);
}

if (problems.length) {
  console.error('\n──────── 公開できません ────────');
  for (const p of problems) console.error(`  ❌ ${p}`);
  console.error('\n  dist/ は Pages でそのまま公開されます。出どころを直してからビルドし直してください。');
  process.exit(1);
}
console.log(`✅ 公開してよい内容です（${files}ファイルを確認）`);
