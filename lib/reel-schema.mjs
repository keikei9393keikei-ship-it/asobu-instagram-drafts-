// lib/reel-schema.mjs — reels/<名前>.json の形を確かめる（依存なし）
//
// 書き間違い（キー名の打ち間違い・秒数の抜け・使えない fx など）を、
// 動画を書き出す前と投稿する前に止めるためのもの。
// 新しく足したフィールドはすべて任意。既存のリールはそのまま通る。

/** 制作ラインの段階。ボードの並びもこの順 */
export const STAGES = ['idea', 'script', 'review', 'build', 'check', 'awaiting', 'scheduled', 'published'];
export const STAGE_LABELS = {
  idea: 'ネタ案', script: '台本', review: '批評', build: '制作', check: '校閲',
  awaiting: '承認待ち', scheduled: '投稿予定', published: '投稿済み',
};
export const SOURCE_TYPES = ['idea', 'metrics', 'inbox-faq', 'manual'];
const FX = ['speed', 'flash'];

const TOP_KEYS = ['date', 'caption', 'foot', 'scenes', 'stage', 'source', 'needsFootage', 'voice', 'checks'];
const SCENE_KEYS = ['t', 'd', 'head', 'sub', 'badge', 'note', 'countTo', 'fx', 'say', 'yomi'];

const isStr = (v) => typeof v === 'string';
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** 正しい暦日か（2026-02-30 のようなものは false） */
export function isValidDate(s) {
  if (!isStr(s) || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** 問題を文字列の配列で返す。空なら形は正しい */
export function validateReel(spec) {
  const errors = [];
  if (!isObj(spec)) return ['JSONの一番外側がオブジェクトではありません'];

  for (const k of Object.keys(spec)) {
    if (!TOP_KEYS.includes(k)) errors.push(`知らないキー「${k}」があります（打ち間違いでは？ 使えるのは ${TOP_KEYS.join(' / ')}）`);
  }
  if (spec.date !== undefined && !isValidDate(spec.date)) errors.push(`date は YYYY-MM-DD の正しい日付にしてください: ${JSON.stringify(spec.date)}`);
  if (spec.caption !== undefined && (!isStr(spec.caption) || !spec.caption.trim())) errors.push('caption が空か、文字列ではありません');
  if (spec.foot !== undefined && !isStr(spec.foot)) errors.push('foot は文字列にしてください');
  if (spec.stage !== undefined && !STAGES.includes(spec.stage)) errors.push(`stage は ${STAGES.join(' / ')} のどれかにしてください: ${JSON.stringify(spec.stage)}`);
  if (spec.source !== undefined) {
    if (!isObj(spec.source) || !SOURCE_TYPES.includes(spec.source.type)) {
      errors.push(`source は { "type": ${SOURCE_TYPES.join('|')}, "note": "…" } の形にしてください`);
    } else if (spec.source.note !== undefined && !isStr(spec.source.note)) {
      errors.push('source.note は文字列にしてください');
    }
  }
  if (spec.needsFootage !== undefined && typeof spec.needsFootage !== 'boolean') errors.push('needsFootage は true / false にしてください');
  if (spec.voice !== undefined) {
    if (!isObj(spec.voice) || !isStr(spec.voice.speaker)) errors.push('voice は { "speaker": "zundamon" } の形にしてください');
    else if (spec.voice.speed !== undefined && !(isNum(spec.voice.speed) && spec.voice.speed >= 0.8 && spec.voice.speed <= 1.5)) {
      errors.push('voice.speed（話す速さ）は 0.8〜1.5 の数字にしてください（省くと 1.1）');
    }
    for (const k of Object.keys(spec.voice)) if (!['speaker', 'speed'].includes(k)) errors.push(`voice に知らないキー「${k}」があります`);
  }
  if (spec.checks !== undefined && (!isObj(spec.checks) || typeof spec.checks.ok !== 'boolean')) errors.push('checks は校閲スクリプトが書く欄です（ok が true / false のオブジェクト）');

  if (!Array.isArray(spec.scenes) || spec.scenes.length === 0) {
    errors.push('scenes が空です');
    return errors;
  }
  let end = 0;
  spec.scenes.forEach((s, i) => {
    const at = `場面${i + 1}`;
    if (!isObj(s)) { errors.push(`${at} がオブジェクトではありません`); return; }
    for (const k of Object.keys(s)) {
      if (!SCENE_KEYS.includes(k)) errors.push(`${at}: 知らないキー「${k}」（使えるのは ${SCENE_KEYS.join(' / ')}）`);
    }
    if (!isNum(s.t) || s.t < 0) errors.push(`${at}: t（開始秒）が数字ではありません`);
    if (!isNum(s.d) || s.d <= 0) errors.push(`${at}: d（表示秒）が正の数字ではありません`);
    if (!isStr(s.head) || !s.head.trim()) errors.push(`${at}: head（見出し）が空です`);
    for (const k of ['sub', 'badge', 'note', 'say']) {
      if (s[k] !== undefined && !isStr(s[k])) errors.push(`${at}: ${k} は文字列にしてください`);
    }
    if (s.countTo !== undefined) {
      if (!isNum(s.countTo)) errors.push(`${at}: countTo は数字にしてください`);
      else if (!isStr(s.head) || !s.head.includes('{n}')) errors.push(`${at}: countTo があるのに head に {n} がありません`);
    }
    if (s.fx !== undefined && !FX.includes(s.fx)) errors.push(`${at}: fx は ${FX.join(' / ')} のどちらかです: ${JSON.stringify(s.fx)}`);
    if (s.yomi !== undefined && (!isObj(s.yomi) || !Object.values(s.yomi).every(isStr))) errors.push(`${at}: yomi は { "表記": "よみ" } の形にしてください`);
    // 場面は前の場面の終わりから始まる。すき間や重なりがあると動画が途切れる
    if (isNum(s.t) && isNum(s.d)) {
      if (Math.abs(s.t - end) > 0.001) errors.push(`${at}: 開始 ${s.t}秒 が、前の場面の終わり ${+end.toFixed(3)}秒 とずれています`);
      end = s.t + s.d;
    }
  });
  return errors;
}

/** 場面の長さを足して全体の秒数を出す */
export function totalSeconds(scenes) {
  return (scenes || []).reduce((end, s) => Math.max(end, s.t + s.d), 0);
}
