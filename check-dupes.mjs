// weeks/*/caption.txt と cards.json をつきあわせて、
// そのまま使い回されている文を洗い出す。
//
//   npm run dupes            … 未投稿分どうしの重複だけ（既定）
//   npm run dupes -- --all   … 投稿済みも含めた全件
//
// CLAUDE.md の文章ルール5（決まり文句を全投稿に入れない）の見張り役。
// 同じ文が2本以上に出たら、言い方を変えるか、1本に絞る。

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ALL = process.argv.includes('--all');
const MIN_LEN = 12;          // これより短い文は定型句として扱わない
const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);

const weeks = readdirSync('weeks')
  .filter((w) => /^\d{4}-\d{2}-\d{2}$/.test(w))
  .filter((w) => ALL || w >= today)
  .sort();

/** キャプションとカード本文から、比較したい文だけを取り出す */
function sentences(week) {
  const out = [];
  const capPath = join('weeks', week, 'caption.txt');
  if (existsSync(capPath)) {
    const body = readFileSync(capPath, 'utf8').split('#バドミントン')[0];
    for (const line of body.split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('▫️')) continue;   // 箇条書きは重なって当然なので外す
      for (const s of t.split(/(?<=。)/)) {
        const v = s.trim();
        if (v.length >= MIN_LEN) out.push(v);
      }
    }
  }
  const cardPath = join('weeks', week, 'cards.json');
  if (existsSync(cardPath)) {
    for (const c of JSON.parse(readFileSync(cardPath, 'utf8'))) {
      for (const s of String(c.body || '').split(/(?<=。)/)) {
        const v = s.trim();
        if (v.length >= MIN_LEN) out.push(v);
      }
    }
  }
  return out;
}

const seen = new Map();
for (const w of weeks) {
  for (const s of new Set(sentences(w))) {
    if (!seen.has(s)) seen.set(s, []);
    seen.get(s).push(w);
  }
}

const dupes = [...seen.entries()]
  .filter(([, ws]) => ws.length >= 2)
  .sort((a, b) => b[1].length - a[1].length);

const scope = ALL ? '全件' : `未投稿分（${today} 以降）`;
if (dupes.length === 0) {
  console.log(`使い回されている文はありません。（${scope} ${weeks.length}本）`);
  process.exit(0);
}

console.log(`そのまま使い回されている文が ${dupes.length} 件あります。（${scope} ${weeks.length}本）\n`);
for (const [s, ws] of dupes) {
  console.log(`  ${ws.length}回  ${s}`);
  console.log(`        ${ws.join(' ')}`);
}
console.log('\n言い方を変えるか、1本に絞ってください。');
process.exit(1);
