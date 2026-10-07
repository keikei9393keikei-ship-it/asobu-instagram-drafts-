// check-reels.mjs — reels/*.json を校閲する（CLAUDE.md §4 の機械で判定できる部分）
//
//   npm run check:reels                  … 未投稿分（予定日が今日以降・日付なし）を校閲する
//   npm run check:reels -- --all         … 投稿済みも含めて全部
//   npm run check:reels -- --write       … 結果を各ファイルの checks に書き込む（PRに載せる前に必ず）
//   npm run check:reels -- --strict      … checks が無い・古い・不合格のものもエラーにする（CIで使う）
//   npm run check:reels -- firsttime     … 名前を指定するとそれだけ
//
// 見ること：形（lib/reel-schema）、文章ルール（lib/compliance）、予定の並び（1日1本・週5本）、
// 同じ文の使い回し（weeks/ と reels/ をまとめて。lib/dupes）。
// エラーが1つでもあれば終了コード1。校閲を通っていないものはPRに載せない。

import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { todayJST } from './lib/rules.mjs';
import { validateReel } from './lib/reel-schema.mjs';
import { checkReel, scheduleProblems, contentHash } from './lib/compliance.mjs';
import { collectPosts, findDupes } from './lib/dupes.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(ROOT, 'reels');
const args = process.argv.slice(2);
const ALL = args.includes('--all');
const WRITE = args.includes('--write');
const STRICT = args.includes('--strict');
const only = args.filter((a) => !a.startsWith('-'));
const today = process.env.TODAY || todayJST();

const files = (await readdir(SRC)).filter((f) => f.endsWith('.json')).sort();
const reels = [];
for (const f of files) {
  const name = f.replace(/\.json$/, '');
  const raw = await readFile(path.join(SRC, f), 'utf8');
  let spec = null;
  try { spec = JSON.parse(raw); } catch (e) { reels.push({ name, raw, parseError: e.message }); continue; }
  reels.push({ name, raw, spec });
}

// 予定の並びは、投稿済みも含めた全部で見る（今週すでに出た分も週5本に数える）
const schedule = scheduleProblems(reels.filter((r) => r.spec?.date).map((r) => ({ name: r.name, date: r.spec.date })));

// 同じ文の使い回し。リールが絡むものだけ、そのリールのエラーにする
const dupes = findDupes(collectPosts(ROOT, { all: ALL, today }));
const dupeErrors = new Map();
for (const [s, ids] of dupes) {
  for (const id of ids.filter((x) => x.startsWith('reels/'))) {
    const others = ids.filter((x) => x !== id).join('・');
    const n = id.slice('reels/'.length);
    dupeErrors.set(n, [...(dupeErrors.get(n) || []), `「${s}」が ${others} と同じ文です。言い方を変える（§4 ルール5）`]);
  }
}

const inScope = (r) => (only.length ? only.includes(r.name) : ALL || !r.spec?.date || r.spec.date >= today);
let failed = 0, checked = 0, written = 0;

for (const r of reels.filter(inScope)) {
  checked++;
  console.log(`\n■ reels/${r.name}${r.spec?.date ? `（${r.spec.date}）` : '（日付なし）'}`);
  if (r.parseError) {
    console.log(`  ❌ JSONとして読めません: ${r.parseError}`);
    failed++;
    continue;
  }
  const schemaErrors = validateReel(r.spec);
  const { errors, warnings } = schemaErrors.length
    ? { errors: schemaErrors.map((e) => `形: ${e}`), warnings: [] }
    : checkReel(r.spec, { today });
  errors.push(...(schedule.get(r.name) || []), ...(dupeErrors.get(r.name) || []));

  const hash = contentHash(r.spec);
  const stored = r.spec.checks;
  if (STRICT && !WRITE) {
    if (!stored) errors.push('checks がありません。`npm run check:reels -- --write` を流してからコミットする');
    else if (stored.hash !== hash) errors.push('checks が古いです（中身を直したあと校閲をやり直していない）。`--write` を流す');
  }

  for (const e of errors) console.log(`  ❌ ${e}`);
  for (const w of warnings) console.log(`  △ ${w}`);
  if (!errors.length) console.log(`  ✅ 通過${warnings.length ? `（注意 ${warnings.length}件）` : ''}`);
  if (errors.length) failed++;

  if (WRITE && !schemaErrors.length) {
    const next = { ok: errors.length === 0, hash, errors, warnings };
    // 中身も結果も変わっていなければ、日時を書き換えない（無駄な差分を作らない）
    const same = stored && stored.hash === hash && stored.ok === next.ok
      && JSON.stringify(stored.errors) === JSON.stringify(errors) && JSON.stringify(stored.warnings) === JSON.stringify(warnings);
    if (!same) {
      const spec = { ...r.spec, checks: { ...next, at: new Date().toISOString() } };
      await writeFile(path.join(SRC, `${r.name}.json`), `${JSON.stringify(spec, null, 2)}\n`);
      written++;
    }
  }
}

console.log(`\n${checked}本を校閲しました（${ALL ? '全件' : only.length ? '指定分' : `未投稿分・${today} 以降と日付なし`}）。` +
  (WRITE ? ` checks を${written}本に書き込みました。` : ''));
if (failed) {
  console.log(`❌ ${failed}本が通りません。直してから、もう一度流してください。`);
  process.exit(1);
}
console.log('✅ すべて通りました。');
