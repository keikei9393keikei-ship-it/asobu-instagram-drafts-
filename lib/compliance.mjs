// lib/compliance.mjs — リールの校閲（CLAUDE.md §4 のうち、機械で判定できるもの）
//
// check-reels.mjs（PRの前・CI）と publish-reel.mjs（投稿の直前）が同じものを使う。
// 「安心させる一文が毎回言い方を変えているか」のような、読まないと分からないことは
// compliance-checker エージェントが見る。ここでは見ない。
//
// 結果は { errors, warnings }。errors が1つでもあれば投稿しない。

import { createHash } from 'node:crypto';
import { GREETING_RE, venueHits, pastDates, hashtags, mondayOf, MAX_CAPTION, MAX_HASHTAGS } from './rules.mjs';
import { totalSeconds } from './reel-schema.mjs';

export const VOICEVOX_CREDIT = 'VOICEVOX:ずんだもん';
export const MAX_REELS_PER_WEEK = 5;
const SECONDS_MIN = 18;
const SECONDS_MAX = 24;
const HEAD_LINE_MAX = 7;

/** 校閲の対象になる中身のハッシュ。中身を直したのに校閲をやり直していないと、ここがずれる */
export function contentHash(spec) {
  const { date, caption, foot, scenes, voice } = spec;
  return createHash('sha256').update(JSON.stringify({ date, caption, foot, scenes, voice })).digest('hex').slice(0, 16);
}

/** 画面に出る文字（見出し・説明・枠・セリフ）。{n} は数え終わった値に置き換える */
function sceneTexts(spec) {
  const out = [];
  for (const s of spec.scenes || []) {
    const head = String(s.head || '').replace('{n}', s.countTo ?? '');
    out.push({ where: '見出し', text: head, scene: s });
    for (const k of ['sub', 'note', 'say']) {
      if (s[k]) out.push({ where: { sub: '説明', note: '枠', say: 'セリフ' }[k], text: String(s[k]).replace(/<\/?b>/g, ''), scene: s });
    }
  }
  return out;
}

// 言葉の禁止リスト（CLAUDE.md §4 ルール5）。[正規表現, 理由]
const BANNED = [
  [/大募集/, '「大募集」は人が集まっていない場所に見える'],
  [/大歓迎|歓迎です|歓迎します/, '「歓迎」は迎える側の姿勢。読み手にできることを書く（「できます」）'],
  [/お待ちしています|お待ちしております/, '露骨な勧誘に見える'],
  [/まずは一度どうぞ/, '露骨な勧誘に見える'],
  [/浮く|浮いて|浮かない/, '「浮く」は生々しい言葉。やわらかく言い換える'],
  [/気まずい|気まずく/, '「気まずい」は生々しい言葉。やわらかく言い換える'],
  [/下手/, '「下手」は生々しい言葉。やわらかく言い換える'],
  [/にはなりません/, '「◯◯にはなりません」は、否定した場面を読み手に想像させる。実際に起きることを書く'],
  [/出会い|婚活|恋活/, '出会い目的に見える'],
];

/** 参加人数らしき表記。「1人で来る」はよい。範囲（20〜30人）と5人以上はエラー、2〜4人は警告 */
function peopleHits(text) {
  const errors = [], warnings = [];
  for (const m of text.matchAll(/(\d+)\s*[〜~～\-－]\s*(\d+)\s*(人|名)/g)) errors.push(m[0]);
  for (const m of text.matchAll(/(?<![\d〜~～\-－])(\d+)\s*(人|名)/g)) {
    const n = Number(m[1]);
    if (n >= 5) errors.push(m[0]);
    else if (n >= 2) warnings.push(m[0]);
  }
  for (const m of text.matchAll(/数十人|何十人|大人数|大勢/g)) errors.push(m[0]);
  return { errors, warnings };
}

/** LINEグループの話（CLAUDE.md §4 ルール3）。コートの「サービスライン」などは対象外 */
function lineHits(text) {
  const hits = [];
  for (const m of text.matchAll(/(?<![A-Za-z])LINE(?![A-Za-z])/gi)) hits.push(m[0]);
  for (const m of text.matchAll(/ライン(グループ|招待|交換|追加|ID|ＩＤ|登録|に招待)|オープンチャット|オプチャ/g)) hits.push(m[0]);
  return hits;
}

/**
 * 1本のリールを校閲する。
 * @param {object} spec reels/<名前>.json の中身
 * @param {object} opt  { today: 'YYYY-MM-DD', now: Date }
 */
export function checkReel(spec, { today, now = new Date() } = {}) {
  const errors = [];
  const warnings = [];
  const caption = String(spec.caption || '');
  const scenes = sceneTexts(spec);
  const all = [{ where: 'キャプション', text: caption }, ...scenes];

  // ── キャプション ──
  if (!caption.trim()) errors.push('caption（キャプション）がありません');
  else {
    if (!GREETING_RE.test(caption)) errors.push('キャプションの1行目が名乗りになっていません（§4 ルール6）');
    if (caption.length > MAX_CAPTION) errors.push(`キャプションが${caption.length}文字。上限は${MAX_CAPTION}文字`);
    const tags = hashtags(caption);
    if (tags.length > MAX_HASHTAGS) errors.push(`ハッシュタグが${tags.length}個。上限は${MAX_HASHTAGS}個`);
    // 600円・ラケット無料貸出・室内用シューズは毎回そろえて書く（§4 ルール4）
    if (!/600円/.test(caption)) errors.push('キャプションに参加費（600円）がありません（§4 ルール4）');
    if (!(/ラケット/.test(caption) && /(無料|貸し出|貸出)/.test(caption))) errors.push('キャプションに「ラケットは無料で貸し出す」がありません（§4 ルール4）');
    if (!(/(室内用|体育館シューズ|室内シューズ)/.test(caption))) errors.push('キャプションに「室内用の靴（シューズ）」がありません（§4 ルール4）');
    if (!/DM/.test(caption)) warnings.push('締めにDMの案内がありません（§4 ルール7）');
  }

  // ── 全部の文字 ──
  for (const { where, text } of all) {
    for (const hit of venueHits(text)) errors.push(`${where}に会場名らしき表記「${hit}」（§4 ルール2）`);
    for (const hit of lineHits(text)) errors.push(`${where}にLINEの話「${hit}」（§4 ルール3）`);
    const people = peopleHits(text);
    for (const hit of people.errors) errors.push(`${where}に参加人数らしき表記「${hit}」（§4 ルール4）`);
    for (const hit of people.warnings) warnings.push(`${where}の「${hit}」が参加人数でないか確かめる（§4 ルール4）`);
    if (/体育館代/.test(text)) errors.push(`${where}に「体育館代」。「会場代」と書く（§4 ルール4）`);
    if (/(持ち物|必要なもの|必要なのは|用意するのは|そろえるのは)[^。\n]*600円|(シューズ|靴)と600円/.test(text)) {
      errors.push(`${where}で600円を持ち物に混ぜています。参加費として別の文にする（§4 ルール4）`);
    }
    for (const [re, why] of BANNED) {
      const m = text.match(re);
      if (m) errors.push(`${where}に「${m[0]}」— ${why}`);
    }
    if (/ことはありません/.test(text)) warnings.push(`${where}に「ことはありません」。ないものを数える書き方になっていないか確かめる（§4 ルール5）`);
  }
  for (const [text, hit] of pastDates(all.map((x) => x.text), now)) errors.push(`「${text}」はもう過ぎた日付です（${hit}）`);

  // ── 見出し（大きい文字） ──
  for (const s of spec.scenes || []) {
    const head = String(s.head || '');
    if (/円/.test(head) || (s.countTo !== undefined && /\{n\}\s*円/.test(head))) {
      errors.push(`見出し「${head.replace(/\n/g, ' ')}」に金額。金額は見出しにしない（§4 ルール4）`);
    }
    for (const line of head.replace('{n}', s.countTo ?? '').split('\n')) {
      if ([...line].length > HEAD_LINE_MAX) warnings.push(`見出しの1行「${line}」が${[...line].length}文字（${HEAD_LINE_MAX}文字以内が目安）`);
    }
  }

  // ── 予定日・尺・素材 ──
  if (spec.date && today && spec.date < today) errors.push(`予定日 ${spec.date} が過ぎています`);
  if (spec.needsFootage) errors.push('実写の素材が要るネタ（needsFootage）は、自動のリールにできません。撮影リストへ回す');
  const seconds = totalSeconds(spec.scenes);
  if (seconds < SECONDS_MIN || seconds > SECONDS_MAX) warnings.push(`長さが${seconds.toFixed(1)}秒（${SECONDS_MIN}〜${SECONDS_MAX}秒が目安。20秒前後）`);
  const ds = new Set((spec.scenes || []).map((s) => s.d));
  if ((spec.scenes || []).length >= 3 && ds.size === 1) warnings.push('場面の秒数が全部同じ。フックは短く、結論は長めに変える（§5.5）');

  // ── 声 ──
  const says = (spec.scenes || []).filter((s) => s.say && String(s.say).trim());
  if (spec.voice) {
    if (!caption.includes(VOICEVOX_CREDIT)) errors.push(`声を付けるリールは、キャプションに「${VOICEVOX_CREDIT}」の表記が要ります（VOICEVOX の規約）`);
    if (!says.length) warnings.push('voice があるのに、セリフ（say）のある場面がありません');
  } else if (says.length) {
    warnings.push('セリフ（say）があるのに voice がありません。声は付かず、吹き出しだけが出ます');
  }

  return { errors: [...new Set(errors)], warnings: [...new Set(warnings)] };
}

/**
 * 予定の並びを見る。1日1本まで、週（月〜日）5本まで。
 * @param {{name:string, date?:string}[]} reels 予定日のあるリール（投稿済みも含めて渡す）
 * @returns {Map<string, string[]>} 名前 → エラー
 */
export function scheduleProblems(reels) {
  const out = new Map();
  const add = (n, msg) => out.set(n, [...(out.get(n) || []), msg]);
  const byDate = new Map();
  for (const r of reels) if (r.date) byDate.set(r.date, [...(byDate.get(r.date) || []), r.name]);
  for (const [date, names] of byDate) {
    if (names.length > 1) for (const n of names) add(n, `${date} にリールが${names.length}本あります（${names.join('・')}）。1日1本まで`);
  }
  const byWeek = new Map();
  for (const r of reels) if (r.date) byWeek.set(mondayOf(r.date), [...(byWeek.get(mondayOf(r.date)) || []), r]);
  for (const [monday, list] of byWeek) {
    if (list.length <= MAX_REELS_PER_WEEK) continue;
    const sorted = list.slice().sort((a, b) => a.date.localeCompare(b.date));
    for (const r of sorted.slice(MAX_REELS_PER_WEEK)) {
      add(r.name, `${monday} からの週にリールが${list.length}本。週${MAX_REELS_PER_WEEK}本まで（この1本は上限を超えた分）`);
    }
  }
  return out;
}
