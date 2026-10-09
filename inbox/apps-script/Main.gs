// Main.gs — 遊部（ASOBU）の受信箱
//
// Google スプレッドシートに貼る Apps Script。15分ごとに Instagram の DM とコメントを取りに行き、
//   1. 「受信箱」シートに、返信待ちの会話を1行ずつ並べる（本文・相手の名前はこのシートの中だけ）
//   2. 新しく届いたものは Claude API で分類して、返信の下書きを書く（送信はしない）
//   3. 初参加の相談が新しく来たときだけ、自分あてにメールで知らせる（件名は件数と期限だけ）
//   4. 件数・優先度・期限だけを GitHub の data ブランチの inbox-summary.json に書く（管理ボードが読む）
//
// 分類と下書きの規則は、リポジトリの .claude/agents/staff/inbox-triager.md と CLAUDE.md §1 を main から読む。
// セットアップの手順は inbox/README.md。

var SHEET = '受信箱';
var LOG_SHEET = '動き';
var HEADERS = ['キー', '種類', '優先度', '状態', '期限', '最後の受信', '相手', '届いた文', '下書き', '下書きの検査', '分類の理由', '送る前にやること', '更新',
  '_updated', '_lastInboundId', '_notifiedId', '_category'];
var COL = {};
HEADERS.forEach(function (h, i) { COL[h] = i; });
var HIDDEN_FROM = HEADERS.indexOf('_updated');

function onOpen() {
  SpreadsheetApp.getUi().createMenu('遊部の受信箱')
    .addItem('今すぐ取り込む', 'pollInbox')
    .addItem('設定を確かめる', 'checkSetup')
    .addItem('はじめの準備（1回だけ）', 'setup')
    .addToUi();
}

/** はじめの準備：シートを作り、15分ごとの実行を登録する */
function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SHEET) || ss.insertSheet(SHEET);
  sh.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight('bold');
  sh.setFrozenRows(1);
  sh.hideColumns(HIDDEN_FROM + 1, HEADERS.length - HIDDEN_FROM);
  sh.setColumnWidth(COL['届いた文'] + 1, 320);
  sh.setColumnWidth(COL['下書き'] + 1, 360);
  sh.getRange(2, COL['状態'] + 1, 1000, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList([STATUS.waiting, STATUS.replied, STATUS.skip], true).build());
  sh.getRange(2, COL['届いた文'] + 1, 1000, 6).setWrap(true).setVerticalAlignment('top');
  var log = ss.getSheetByName(LOG_SHEET) || ss.insertSheet(LOG_SHEET);
  log.getRange(1, 1, 1, 3).setValues([['時刻', '結果', 'メモ']]).setFontWeight('bold');

  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'pollInbox') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('pollInbox').timeBased().everyMinutes(15).create();
  SpreadsheetApp.getActive().toast('準備ができました。15分ごとに取り込みます。まず「設定を確かめる」を押してください。');
}

/** 設定の確認：プロパティ・Instagram の権限・Claude・GitHub を1つずつ試す（何も書かない） */
function checkSetup() {
  var lines = [];
  var ok = true;
  var step = function (label, fn) {
    try { lines.push('✅ ' + label + (fn() || '')); } catch (e) { ok = false; lines.push('❌ ' + label + '：' + redact_(e.message)); }
  };
  step('Instagram のトークン', function () { var o = igOwn_(); return '（@' + o.username + '）'; });
  step('DM を読む権限（instagram_business_manage_messages）', function () { return '（会話 ' + igConversations_().length + '件）'; });
  step('コメントを読む権限（instagram_business_manage_comments）', function () { return '（コメント ' + igComments_().length + '件）'; });
  step('リポジトリの規則書', function () { var r = triageRules_(); return r.facts ? '' : '（CLAUDE.md の §1 が見つかりません）'; });
  step('Claude API', function () { var t = claudeTriage_('dm', ['日曜の練習に、未経験でも参加できますか？'], triageRules_()); return '（試しの分類：' + PRIORITY_LABEL[t.category] + '）'; });
  step('GitHub のトークン', function () {
    var res = UrlFetchApp.fetch('https://api.github.com/repos/' + REPO, { headers: { Authorization: 'Bearer ' + prop_('GITHUB_TOKEN', true) }, muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) throw new Error('HTTP ' + res.getResponseCode());
    var p = JSON.parse(res.getContentText()).permissions || {};
    if (!p.push) throw new Error('書き込みの権限がありません（Contents: Read and write）');
  });
  var msg = lines.join('\n') + (ok ? '\n\nすべて通りました。' : '\n\n❌ のところを inbox/README.md の手順で直してください。');
  Logger.log(msg);
  try { SpreadsheetApp.getUi().alert('設定の確認', msg, SpreadsheetApp.getUi().ButtonSet.OK); } catch (e) { /* トリガーから呼ばれたとき */ }
}

/** 15分ごとに動く本体 */
function pollInbox() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return; // 前の回がまだ動いている
  try {
    var result = poll_();
    log_('ok', result);
  } catch (e) {
    log_('失敗', redact_(e.message));
    throw e; // Apps Script の失敗通知（メール）にも乗せる
  } finally {
    lock.releaseLock();
  }
}

function poll_() {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET);
  if (!sh) throw new Error('「' + SHEET + '」シートがありません。メニューの「はじめの準備」を押してください');
  var own = igOwn_();
  var rows = readRows_(sh);
  var byKey = {};
  rows.forEach(function (r) { byKey[r[COL['キー']]] = r; });
  var rules = null;
  var getRules = function () { if (!rules) { try { rules = triageRules_(); } catch (e) { rules = { error: e.message }; } } return rules; };
  var triaged = 0;
  var newFirst = [];

  var upsert = function (key, kind, state, updated) {
    var row = byKey[key];
    if (!row) { row = HEADERS.map(function () { return ''; }); row[COL['キー']] = key; rows.push(row); byKey[key] = row; }
    row[COL['種類']] = kind === 'dm' ? 'DM' : 'コメント';
    row[COL['_updated']] = updated || row[COL['_updated']];
    row[COL['相手']] = state.partner;
    row[COL['最後の受信']] = state.lastInboundAt ? new Date(state.lastInboundAt) : '';
    var isNew = state.lastInboundId && String(row[COL['_lastInboundId']]) !== String(state.lastInboundId);
    if (state.replied) {
      row[COL['状態']] = STATUS.replied;
      row[COL['期限']] = '';
    } else if (isNew) {
      row[COL['届いた文']] = state.pendingTexts.join('\n―\n');
      var t;
      var r = getRules();
      try {
        if (r.error) throw new Error(r.error);
        t = claudeTriage_(kind, state.pendingTexts, r);
      } catch (e) {
        t = { category: guessCategory(state.pendingTexts.join('\n')), reason: '（Claude で分類できず、言葉だけで仮に分けました：' + redact_(e.message) + '）', draft: '', todo: ['下書きを書く'] };
      }
      triaged++;
      row[COL['_category']] = t.category;
      row[COL['優先度']] = PRIORITY_LABEL[t.category];
      row[COL['下書き']] = t.draft;
      var problems = checkDraft(t.draft, r.banned || []);
      row[COL['下書きの検査']] = !t.draft ? '' : problems.length ? '要手直し：' + problems.join('／') : 'OK';
      row[COL['分類の理由']] = t.reason;
      row[COL['送る前にやること']] = (t.todo || []).join('\n');
      row[COL['状態']] = t.category === 'none' ? STATUS.skip : STATUS.waiting;
      row[COL['期限']] = t.category === 'none' ? '' : new Date(dueFrom(state.lastInboundAt));
      row[COL['_lastInboundId']] = state.lastInboundId;
      row[COL['更新']] = new Date();
      if (t.category === 'first' && String(row[COL['_notifiedId']]) !== String(state.lastInboundId)) {
        newFirst.push(row);
        row[COL['_notifiedId']] = state.lastInboundId;
      }
    }
    // 新しいメッセージが無ければ、依頼主が手で変えた状態（返信済み・対応不要）はそのまま残す
  };

  // DM：前の回から動いた会話だけ、メッセージを読む
  igConversations_().forEach(function (c) {
    var key = 'dm:' + c.id;
    var row = byKey[key];
    if (row && String(row[COL['_updated']]) === String(c.updated_time)) return;
    upsert(key, 'dm', conversationState(igMessages_(c.id), own), c.updated_time);
  });

  // コメント（コメントの権限が無くても DM は続ける）
  var commentNote = '';
  try {
    igComments_().forEach(function (c) {
      var st = commentState(c, own);
      if (st) upsert('c:' + c.id, 'comment', st, c.timestamp);
    });
  } catch (e) {
    commentNote = '／コメントは読めませんでした：' + redact_(e.message);
  }

  sortRows_(rows);
  writeRows_(sh, rows);

  if (newFirst.length) notifyFirst_(newFirst);

  var summary = buildSummary(rows.map(function (r) {
    return { priority: r[COL['_category']], status: r[COL['状態']], due: r[COL['期限']] ? new Date(r[COL['期限']]).toISOString() : '' };
  }), new Date());
  var pushed = pushSummary_(summary);
  return '返信待ち ' + summary.unreplied + '件（初参加 ' + summary.byPriority.first + '）・分類 ' + triaged + '件' +
    (newFirst.length ? '・通知 ' + newFirst.length + '件' : '') + (pushed ? '・ボードに反映' : '') + commentNote;
}

function readRows_(sh) {
  var n = sh.getLastRow() - 1;
  if (n <= 0) return [];
  return sh.getRange(2, 1, n, HEADERS.length).getValues();
}

function writeRows_(sh, rows) {
  var n = sh.getLastRow() - 1;
  if (n > 0) sh.getRange(2, 1, n, HEADERS.length).clearContent();
  if (rows.length) sh.getRange(2, 1, rows.length, HEADERS.length).setValues(rows);
  sh.getRange(2, COL['期限'] + 1, Math.max(rows.length, 1), 2).setNumberFormat('m/d H:mm');
}

/** 返信待ち → 優先度 → 期限の順 */
function sortRows_(rows) {
  var rank = function (r) { return r[COL['状態']] === STATUS.waiting ? 0 : 1; };
  var pri = function (r) { var i = PRIORITY_ORDER.indexOf(r[COL['_category']]); return i < 0 ? 9 : i; };
  var due = function (r) { return r[COL['期限']] ? new Date(r[COL['期限']]).getTime() : Infinity; };
  rows.sort(function (a, b) { return rank(a) - rank(b) || pri(a) - pri(b) || due(a) - due(b); });
}

/** 初参加の相談が新しく来たときだけ。件名は件数と期限だけで、名前と本文は入れない */
function notifyFirst_(rows) {
  var dues = rows.map(function (r) { return new Date(r[COL['期限']]).toISOString(); }).sort();
  var to = prop_('NOTIFY_EMAIL') || Session.getEffectiveUser().getEmail();
  MailApp.sendEmail(to, notifySubject(rows.length, dues[0]),
    '初参加の相談が届いています。受信箱シートで下書きを確かめて、Instagram のアプリから返信してください。\n\n' +
    SpreadsheetApp.getActiveSpreadsheet().getUrl() + '\n\n（名前とメッセージの本文は、このメールには書いていません）');
}

/** 中身が変わったとき、または3時間たったときだけ GitHub に書く（data ブランチのコミットを増やしすぎないため） */
function pushSummary_(summary) {
  var props = PropertiesService.getScriptProperties();
  var prev = null;
  try { prev = JSON.parse(props.getProperty('LAST_SUMMARY') || 'null'); } catch (e) { prev = null; }
  var stale = !prev || Date.now() - new Date(prev.updatedAt).getTime() > 3 * 3600 * 1000;
  if (sameSummary(prev, summary) && !stale) return false;
  githubPutSummary_(summary);
  props.setProperty('LAST_SUMMARY', JSON.stringify(summary));
  return true;
}

function log_(result, note) {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(LOG_SHEET);
  if (!sh) return;
  sh.insertRowAfter(1);
  sh.getRange(2, 1, 1, 3).setValues([[new Date(), result, note]]);
  if (sh.getLastRow() > 200) sh.deleteRows(201, sh.getLastRow() - 200);
}
