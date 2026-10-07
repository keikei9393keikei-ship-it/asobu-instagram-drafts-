// weeks/ のカードと reels/ のリールをつきあわせて、
// そのまま使い回されている文を洗い出す。
//
//   npm run dupes            … 未投稿分どうしの重複だけ（既定）
//   npm run dupes -- --all   … 投稿済みも含めた全件
//
// CLAUDE.md の文章ルール5（決まり文句を全投稿に入れない）の見張り役。
// 同じ文が2本以上に出たら、言い方を変えるか、1本に絞る。
// 冒頭の名乗りは毎回同じで入れる決まりなので、重複として数えない（lib/dupes.mjs）。

import { todayJST } from './lib/rules.mjs';
import { collectPosts, findDupes } from './lib/dupes.mjs';

const ALL = process.argv.includes('--all');
const today = todayJST();

const posts = collectPosts('.', { all: ALL, today });
const dupes = findDupes(posts);

const scope = ALL ? '全件' : `未投稿分（${today} 以降）`;
if (dupes.length === 0) {
  console.log(`使い回されている文はありません。（${scope} ${posts.length}本）`);
  process.exit(0);
}

console.log(`そのまま使い回されている文が ${dupes.length} 件あります。（${scope} ${posts.length}本）\n`);
for (const [s, ids] of dupes) {
  console.log(`  ${ids.length}回  ${s}`);
  console.log(`        ${ids.join(' ')}`);
}
console.log('\n言い方を変えるか、1本に絞ってください。');
process.exit(1);
