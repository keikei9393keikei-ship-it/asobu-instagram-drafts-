// lib/rules.mjs — CLAUDE.md §4（文章ルール）のうち、機械で判定できるものを1か所に集めたもの
//
// publish.mjs / publish-reel.mjs / render.mjs / check-dupes.mjs が同じ規則を
// それぞれコピーして持っていたので、ここにまとめた。判定を変えるときはここだけ直す。

/** 日本時間の「いま」。toISOString() の結果がそのまま日本時間として読める */
export const jst = () => new Date(Date.now() + 9 * 3600 * 1000);
/** 日本時間の今日（YYYY-MM-DD） */
export const todayJST = () => jst().toISOString().slice(0, 10);
/** 日本時間の「時」（0〜23） */
export const hourJST = () => Number(jst().toISOString().slice(11, 13));

// 全投稿の冒頭につける名乗り（ルール6）。昼は「こんにちは」、夜は「こんばんは」
export const GREETING_TAIL = '！和歌山市でバドミントンサークルをしています🏸';
export const GREETING_RE = new RegExp(`^(こんにちは|こんばんは)${GREETING_TAIL}`);

export function greetingNow(h = hourJST()) {
  return `${h >= 5 && h < 17 ? 'こんにちは' : 'こんばんは'}${GREETING_TAIL}`;
}

/** 二重投稿の突き合わせに使う鍵。名乗りは全投稿で同じなので、落としてから比べる */
export function dedupeKey(caption) {
  return String(caption || '').replace(GREETING_RE, '').replace(/\s+/g, '').slice(0, 60);
}

/** 会場名らしき表記（ルール2）。「和歌山市内の体育館」はOK、「体育館シューズ」は持ち物なので対象外 */
export function venueHits(text) {
  const venueRe = /([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}A-Za-z0-9]{1,12})体育館(?!シューズ)/gu;
  const hits = [];
  for (const m of String(text || '').matchAll(venueRe)) {
    if (!/(和歌山)?市内の$/.test(m[1])) hits.push(m[0]);
  }
  return hits;
}

/** 文字列の並びから「9/6」「9月6日」のような日付を拾い、今日より前のものを [表記, 説明] で返す。
 *  年をまたぐ表記のため、今日にいちばん近い年の同じ日付として解釈する。 */
export function pastDates(texts, now = new Date()) {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const found = new Map();
  for (const t of texts) {
    if (typeof t !== 'string') continue;
    const ms = [...t.matchAll(/(?<![\d\/])(\d{1,2})\/(\d{1,2})(?![\d\/])/g),
                ...t.matchAll(/(\d{1,2})月(\d{1,2})日/g)];
    for (const m of ms) {
      const mo = Number(m[1]), d = Number(m[2]);
      if (mo < 1 || mo > 12 || d < 1 || d > 31) continue;
      let best = null;
      for (const y of [today.getFullYear() - 1, today.getFullYear(), today.getFullYear() + 1]) {
        const cand = new Date(y, mo - 1, d);
        if (cand.getMonth() !== mo - 1) continue; // 2/30 のような無効な日付
        if (!best || Math.abs(cand - today) < Math.abs(best - today)) best = cand;
      }
      if (best && best < today) found.set(m[0], `${best.getFullYear()}年${mo}月${d}日`);
    }
  }
  return [...found];
}

/** カード（weeks/<日付>/cards.json）から、日付や禁止語を探す対象の文字列を集める */
export function cardTexts(cards) {
  const out = [];
  for (const c of cards || []) for (const k of ['headline', 'body', 'sub', 'cta', 'label']) {
    if (typeof c[k] === 'string') out.push(c[k]);
  }
  return out;
}

/** ハッシュタグの一覧 */
export const hashtags = (caption) => String(caption || '').match(/#[^\s#]+/g) || [];

// Instagram側の制限
export const MAX_CAROUSEL = 10;
export const MAX_CAPTION = 2200;
export const MAX_HASHTAGS = 30;
