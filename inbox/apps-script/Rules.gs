// Rules.gs — 受信箱の判断（外に何も問い合わせない部分）
//
// Apps Script の外でも動くように、ここには UrlFetchApp や SpreadsheetApp を書かない。
// リポジトリの test/inbox.test.mjs が、このファイルを node で読み込んで確かめている。

/** 優先度の値 → シートに出す名前（並べる順もこの順） */
var PRIORITY_LABEL = { first: '初参加の相談', schedule: '日程・会場の質問', other: 'その他', none: '返信不要' };
var PRIORITY_ORDER = ['first', 'schedule', 'other', 'none'];

/** 状態（シートの「状態」の列。依頼主が手で変えてよい） */
var STATUS = { waiting: '返信待ち', replied: '返信済み', skip: '対応不要' };

/** 返信の目安。相手の最後のメッセージから24時間 */
var REPLY_WINDOW_HOURS = 24;

/** Claude に頼めなかったときの、言葉だけでの仮の分類 */
function guessCategory(text) {
  var t = String(text || '');
  if (/初めて|はじめて|初参加|未経験|初心者|体験|見学|行ってみたい|参加したい|参加できます|1人でも|一人でも|ひとりでも|持ち物|ラケット/.test(t)) return 'first';
  if (/日程|いつ|何時|時間|場所|会場|どこ|曜日|次回|今月|来月/.test(t)) return 'schedule';
  if (/^[\s　!！?？。、.,~〜ー👍🙏😊🏸🙌✨❤️♥️]*$/.test(t) || /^(ありがとう|有難う|ありがとうございま)/.test(t.trim())) return 'none';
  return 'other';
}

/** ISO の時刻に24時間を足す */
function dueFrom(iso) {
  var t = new Date(iso).getTime();
  if (isNaN(t)) return null;
  return new Date(t + REPLY_WINDOW_HOURS * 3600 * 1000).toISOString();
}

/**
 * 会話のメッセージ（新しい順でも古い順でもよい）から、いまの状態を出す。
 * @param {{id:string, created_time:string, from:{id?:string, username?:string}, message?:string}[]} messages
 * @param {{id:string, username:string}} own こちらのアカウント
 */
function conversationState(messages, own) {
  var list = (messages || []).filter(function (m) { return m && m.created_time; }).slice();
  list.sort(function (a, b) { return new Date(a.created_time) - new Date(b.created_time); });
  var isOwn = function (m) {
    var f = m.from || {};
    return (own.id && String(f.id) === String(own.id)) || (own.username && f.username === own.username);
  };
  var lastOwnAt = -1;
  for (var i = list.length - 1; i >= 0; i--) { if (isOwn(list[i])) { lastOwnAt = i; break; } }
  var inbound = list.slice(lastOwnAt + 1).filter(function (m) { return !isOwn(m); });
  var lastInbound = null;
  for (var j = list.length - 1; j >= 0; j--) { if (!isOwn(list[j])) { lastInbound = list[j]; break; } }
  var partner = lastInbound ? (lastInbound.from || {}).username || '' : '';
  return {
    replied: inbound.length === 0,
    lastInboundId: lastInbound ? lastInbound.id : '',
    lastInboundAt: lastInbound ? new Date(lastInbound.created_time).toISOString() : '',
    partner: partner,
    // まだ返していない分だけ（古い順・最大5通）。分類と下書きに使う
    pendingTexts: inbound.slice(-5).map(function (m) { return String(m.message || '（文字のないメッセージ）'); }),
  };
}

/**
 * コメント1件の状態。こちらが返信していれば返信済み。
 * @param {{id:string, text?:string, timestamp:string, username?:string, from?:{id?:string, username?:string}, replies?:{data:object[]}}} c
 */
function commentState(c, own) {
  var author = (c.from && c.from.username) || c.username || '';
  var isOwnUser = function (u, id) { return (own.username && u === own.username) || (own.id && id && String(id) === String(own.id)); };
  if (isOwnUser(author, c.from && c.from.id)) return null; // 自分のコメントは対象外
  var replies = (c.replies && c.replies.data) || [];
  var replied = replies.some(function (r) { return isOwnUser((r.from && r.from.username) || r.username, r.from && r.from.id); });
  return {
    replied: replied,
    lastInboundId: c.id,
    lastInboundAt: new Date(c.timestamp).toISOString(),
    partner: author,
    pendingTexts: [String(c.text || '')],
  };
}

/**
 * 下書きの検査。CLAUDE.md §4 のうち、返信でも守ること。
 * @param {string} draft
 * @param {{re:string, why:string}[]} banned lib/phrases.json の banned
 * @returns {string[]} 引っかかったこと（空なら問題なし）
 */
function checkDraft(draft, banned) {
  var text = String(draft || '');
  var out = [];
  if (!text.trim()) return out;
  var venueRe = /([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}A-Za-z0-9]{1,12})体育館(?!シューズ)/gu;
  var m;
  while ((m = venueRe.exec(text))) { if (!/(和歌山)?市内の$/.test(m[1])) out.push('会場名らしき表記「' + m[0] + '」'); }
  if (/(?<![A-Za-z])LINE(?![A-Za-z])/i.test(text) || /ライン(グループ|招待|交換|追加|ID)|オープンチャット|オプチャ/.test(text)) out.push('LINE の話（参加の段取りは【参加の案内】に空けておく）');
  var range = text.match(/\d+\s*[〜~～\-－]\s*\d+\s*(人|名)/);
  if (range) out.push('参加人数らしき表記「' + range[0] + '」');
  var many = /(?<![\d〜~～\-－])(\d+)\s*(人|名)/g;
  while ((m = many.exec(text))) { if (Number(m[1]) >= 5) out.push('参加人数らしき表記「' + m[0] + '」'); }
  if (/体育館代/.test(text)) out.push('「体育館代」→「会場代」');
  (banned || []).forEach(function (b) {
    var hit = text.match(new RegExp(b.re));
    if (hit) out.push('「' + hit[0] + '」— ' + b.why);
  });
  return out;
}

/**
 * 公開してよい要約（件数・優先度・期限だけ）。build-status.mjs の pickInbox と同じ形。
 * @param {{priority:string, status:string, due:string}[]} rows
 */
function buildSummary(rows, now) {
  var by = { first: 0, schedule: 0, other: 0 };
  var deadlines = [];
  (rows || []).forEach(function (r) {
    if (r.status !== STATUS.waiting || !(r.priority in by)) return;
    by[r.priority]++;
    if (r.due) deadlines.push({ priority: r.priority, due: new Date(r.due).toISOString() });
  });
  deadlines.sort(function (a, b) { return a.due < b.due ? -1 : a.due > b.due ? 1 : 0; });
  return {
    updatedAt: (now || new Date()).toISOString(),
    unreplied: by.first + by.schedule + by.other,
    byPriority: by,
    deadlines: deadlines.slice(0, 20),
  };
}

/** 集計時刻を除いて中身が同じか（同じなら GitHub に書かない） */
function sameSummary(a, b) {
  if (!a || !b) return false;
  var strip = function (s) { return JSON.stringify({ u: s.unreplied, b: s.byPriority, d: s.deadlines }); };
  return strip(a) === strip(b);
}

/** 通知メールの件名。名前と本文は入れない */
function notifySubject(count, due) {
  var d = new Date(due);
  var jst = new Date(d.getTime() + 9 * 3600 * 1000);
  var label = (jst.getUTCMonth() + 1) + '/' + jst.getUTCDate() + ' ' + jst.getUTCHours() + ':' + ('0' + jst.getUTCMinutes()).slice(-2);
  return '初参加の相談 ' + count + '件（返信期限 ' + label + '）';
}

/** CLAUDE.md から §1（サークルの基本情報）だけを切り出す */
function factsSection(claudeMd) {
  var s = String(claudeMd || '');
  var a = s.indexOf('## 1.');
  var b = s.indexOf('## 2.', a + 1);
  return a >= 0 ? s.slice(a, b > a ? b : undefined).trim() : '';
}

/** エージェント定義の先頭（--- で囲んだ部分）を外す */
function stripFrontmatter(md) {
  return String(md || '').replace(/^---\n[\s\S]*?\n---\n/, '').trim();
}
