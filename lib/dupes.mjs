// lib/dupes.mjs — 投稿どうしで同じ文を使い回していないかを調べる部品
//
// CLAUDE.md の文章ルール5（同じ文を2本以上の投稿にそのまま入れない）の見張り役。
// weeks/<日付>/ のカードと、reels/<名前>.json のリールを、同じ物差しで比べる。

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { GREETING_RE } from './rules.mjs';

export const MIN_LEN = 12; // これより短い文は定型句として扱わない

/** 文に切り分けて、比べる価値のある長さのものだけ返す */
function split(text) {
  const out = [];
  for (const s of String(text || '').split(/(?<=。)/)) {
    const v = s.trim();
    if (v.length >= MIN_LEN) out.push(v);
  }
  return out;
}

/** キャプションの本文から文を取り出す。名乗り・箇条書き・ハッシュタグは外す */
export function captionSentences(caption) {
  const out = [];
  const body = String(caption || '').split('#バドミントン')[0];
  for (const line of body.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('▫️')) continue;   // 箇条書きは重なって当然なので外す
    if (GREETING_RE.test(t)) continue;         // 冒頭の名乗りは毎回同じでよい
    out.push(...split(t));
  }
  return out;
}

/** weeks/<日付>/ の文 */
export function weekSentences(root, week) {
  const out = [];
  const capPath = join(root, 'weeks', week, 'caption.txt');
  if (existsSync(capPath)) out.push(...captionSentences(readFileSync(capPath, 'utf8')));
  const cardPath = join(root, 'weeks', week, 'cards.json');
  if (existsSync(cardPath)) {
    for (const c of JSON.parse(readFileSync(cardPath, 'utf8'))) out.push(...split(c.body));
  }
  return out;
}

/** リールの文（キャプションと、場面の説明・セリフ） */
export function reelSentences(spec) {
  const out = captionSentences(spec.caption);
  for (const s of spec.scenes || []) for (const k of ['sub', 'say']) out.push(...split(String(s[k] || '').replace(/\n/g, '')));
  return out;
}

/** 投稿の一覧（id と日付と文）を集める。ALL でなければ今日以降と日付なしだけ */
export function collectPosts(root, { all = false, today } = {}) {
  const posts = [];
  const weeksDir = join(root, 'weeks');
  if (existsSync(weeksDir)) {
    for (const w of readdirSync(weeksDir).filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x)).sort()) {
      if (!all && w < today) continue;
      posts.push({ id: `weeks/${w}`, date: w, sentences: weekSentences(root, w) });
    }
  }
  const reelsDir = join(root, 'reels');
  if (existsSync(reelsDir)) {
    for (const f of readdirSync(reelsDir).filter((x) => x.endsWith('.json')).sort()) {
      let spec;
      try { spec = JSON.parse(readFileSync(join(reelsDir, f), 'utf8')); } catch { continue; }
      if (!all && spec.date && spec.date < today) continue;
      posts.push({ id: `reels/${f.replace(/\.json$/, '')}`, date: spec.date || null, sentences: reelSentences(spec) });
    }
  }
  return posts;
}

/** 2本以上に出てくる文を [文, [id…]] で、多い順に返す */
export function findDupes(posts) {
  const seen = new Map();
  for (const p of posts) {
    for (const s of new Set(p.sentences)) {
      if (!seen.has(s)) seen.set(s, []);
      seen.get(s).push(p.id);
    }
  }
  return [...seen.entries()].filter(([, ids]) => ids.length >= 2).sort((a, b) => b[1].length - a[1].length);
}
