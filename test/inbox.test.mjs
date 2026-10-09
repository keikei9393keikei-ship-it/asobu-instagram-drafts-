// 受信箱の Apps Script（inbox/apps-script/Rules.gs）の判断を node で確かめる
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const ctx = {};
vm.createContext(ctx);
vm.runInContext(readFileSync(new URL('../inbox/apps-script/Rules.gs', import.meta.url), 'utf8'), ctx);
const banned = JSON.parse(readFileSync(new URL('../lib/phrases.json', import.meta.url), 'utf8')).banned;
const own = { id: '900', username: 'asobu_wakayama' };
const msg = (id, t, from, message) => ({ id, created_time: t, from, message });

test('会話：最後がこちらなら返信済み', () => {
  const s = ctx.conversationState([
    msg('m1', '2026-10-08T10:00:00+0000', { id: '1', username: 'a' }, '参加できますか'),
    msg('m2', '2026-10-08T11:00:00+0000', { id: '900', username: 'asobu_wakayama' }, 'できます'),
  ], own);
  assert.equal(s.replied, true);
  assert.equal(s.lastInboundId, 'm1');
});

test('会話：こちらの返事のあとに届いた分だけを下書きの材料にする（新しい順で来ても）', () => {
  const s = ctx.conversationState([
    msg('m4', '2026-10-08T13:00:00+0000', { id: '1', username: 'a' }, '日曜は何時からですか'),
    msg('m3', '2026-10-08T12:00:00+0000', { id: '1', username: 'a' }, 'ありがとうございます'),
    msg('m2', '2026-10-08T11:00:00+0000', { id: '900' }, 'できます'),
    msg('m1', '2026-10-08T10:00:00+0000', { id: '1', username: 'a' }, '参加できますか'),
  ], own);
  assert.equal(s.replied, false);
  assert.equal(s.lastInboundId, 'm4');
  assert.equal(s.lastInboundAt, '2026-10-08T13:00:00.000Z');
  assert.deepEqual([...s.pendingTexts], ['ありがとうございます', '日曜は何時からですか']);
  assert.equal(s.partner, 'a');
});

test('コメント：こちらが返信していれば返信済み。自分のコメントは対象外', () => {
  const c = { id: 'c1', text: '初心者でも大丈夫ですか', timestamp: '2026-10-08T10:00:00+0000', username: 'b',
    replies: { data: [{ id: 'r1', username: 'asobu_wakayama' }] } };
  assert.equal(ctx.commentState(c, own).replied, true);
  assert.equal(ctx.commentState({ ...c, replies: undefined }, own).replied, false);
  assert.equal(ctx.commentState({ ...c, username: 'asobu_wakayama' }, own), null);
});

test('言葉だけの仮の分類', () => {
  assert.equal(ctx.guessCategory('未経験なんですが参加できますか？'), 'first');
  assert.equal(ctx.guessCategory('次回はいつですか'), 'schedule');
  assert.equal(ctx.guessCategory('ありがとうございました！'), 'none');
  assert.equal(ctx.guessCategory('🙏'), 'none');
  assert.equal(ctx.guessCategory('写真に写っていましたか'), 'other');
});

test('下書きの検査：会場名・LINE・人数・禁止の言い回しを拾う（lib/phrases.json と同じ言葉）', () => {
  assert.deepEqual([...ctx.checkDraft('和歌山市内の体育館でやっています。持ち物は体育館シューズだけです🏸', banned)], []);
  const hits = ctx.checkDraft('◯◯市民体育館でやっています。LINEに招待しますね。毎回20〜30人です。大歓迎です！お待ちしています', banned);
  assert.ok(hits.some((h) => h.includes('会場名')));
  assert.ok(hits.some((h) => h.includes('LINE')));
  assert.ok(hits.some((h) => h.includes('20〜30人')));
  assert.ok(hits.some((h) => h.includes('大歓迎')));
  assert.ok(hits.some((h) => h.includes('お待ちしています')));
  assert.deepEqual([...ctx.checkDraft('サービスラインの外です。2人で来る人もいます', banned)], []);
  assert.deepEqual([...ctx.checkDraft('', banned)], []);
});

test('要約：返信待ちだけを数え、期限の近い順。公開してよいキーだけ', () => {
  const s = ctx.buildSummary([
    { priority: 'schedule', status: '返信待ち', due: '2026-10-09T12:00:00.000Z' },
    { priority: 'first', status: '返信待ち', due: '2026-10-09T15:00:00.000Z' },
    { priority: 'first', status: '返信済み', due: '' },
    { priority: 'none', status: '対応不要', due: '' },
    { priority: 'other', status: '返信待ち', due: '' },
  ], new Date('2026-10-09T00:00:00Z'));
  assert.equal(s.unreplied, 3);
  assert.deepEqual({ ...s.byPriority }, { first: 1, schedule: 1, other: 1 });
  assert.deepEqual(JSON.parse(JSON.stringify(s.deadlines.map((d) => d.priority))), ['schedule', 'first']);
  assert.deepEqual(Object.keys(s).sort(), ['byPriority', 'deadlines', 'unreplied', 'updatedAt']);
  assert.equal(ctx.sameSummary(s, { ...s, updatedAt: '2026-10-10T00:00:00Z' }), true);
  assert.equal(ctx.sameSummary(s, { ...s, unreplied: 2 }), false);
});

test('要約はボードの pickInbox を通っても形が変わらない', async () => {
  const s = ctx.buildSummary([{ priority: 'first', status: '返信待ち', due: '2026-10-09T15:00:00.000Z' }], new Date('2026-10-09T00:00:00Z'));
  const src = readFileSync(new URL('../build-status.mjs', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('function pickInbox'), src.indexOf('function pickBacklog'));
  const pickInbox = new Function(`${fn}; return pickInbox;`)();
  const picked = pickInbox(JSON.parse(JSON.stringify(s)));
  assert.equal(picked.available, true);
  assert.equal(picked.unreplied, 1);
  assert.deepEqual(picked.deadlines, [{ priority: 'first', due: '2026-10-09T15:00:00.000Z' }]);
  assert.equal(picked.updatedAt, s.updatedAt);
});

test('期限・通知の件名・規則書の切り出し', () => {
  assert.equal(ctx.dueFrom('2026-10-08T12:00:00+0000'), '2026-10-09T12:00:00.000Z');
  assert.equal(ctx.notifySubject(1, '2026-10-09T12:00:00.000Z'), '初参加の相談 1件（返信期限 10/9 21:00）');
  const md = readFileSync(new URL('../CLAUDE.md', import.meta.url), 'utf8');
  const facts = ctx.factsSection(md);
  assert.match(facts, /^## 1\. サークルの基本情報/);
  assert.match(facts, /600円/);
  assert.doesNotMatch(facts, /## 2\./);
  const agent = ctx.stripFrontmatter(readFileSync(new URL('../.claude/agents/staff/inbox-triager.md', import.meta.url), 'utf8'));
  assert.doesNotMatch(agent, /^---/);
  assert.match(agent, /【日程と会場】/);
});
