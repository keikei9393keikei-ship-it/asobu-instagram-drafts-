// 校閲の規則（lib/compliance.mjs）が、わざと入れた違反をちゃんと拾うかを確かめる
//   npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkReel, scheduleProblems, contentHash, VOICEVOX_CREDIT } from '../lib/compliance.mjs';
import { validateReel } from '../lib/reel-schema.mjs';

const GREETING = 'こんばんは！和歌山市でバドミントンサークルをしています🏸';
const FACTS = '持ってくるのは室内用の靴だけで、ラケットは無料で貸し出します。参加費は会場代として1回600円です。';
const today = '2026-10-07';
const now = new Date('2026-10-07T12:00:00+09:00');

/** 規則をすべて満たす1本。テストごとに一部だけ壊す */
function good(over = {}) {
  return {
    date: '2026-10-13',
    caption: `${GREETING}\n\n秋から始める人の話です。\n\n${FACTS}\n\n聞きたいことはDMでどうぞ🙌\n\n#バドミントン`,
    foot: '和歌山市のバドミントンサークル',
    scenes: [
      { t: 0, d: 2.6, head: '秋から\n始める', sub: 'いちばん多い季節' },
      { t: 2.6, d: 4.2, head: '靴だけで\nいい', sub: '外を歩いていない\n室内用の靴' },
      { t: 6.8, d: 3.6, head: 'ラケットは\n借りられる' },
      { t: 10.4, d: 4.4, head: 'ひとりで\n来る人が多い' },
      { t: 14.8, d: 5.2, head: '気になったら', note: '聞きたいことは <b>DM</b> で' },
    ],
    ...over,
  };
}
const errorsOf = (spec) => checkReel(spec, { today, now }).errors.join('\n');
const warningsOf = (spec) => checkReel(spec, { today, now }).warnings.join('\n');

test('規則をすべて満たすものは通る', () => {
  const r = checkReel(good(), { today, now });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(validateReel(good()), []);
});

test('名乗りがない', () => {
  assert.match(errorsOf(good({ caption: good().caption.replace(GREETING, 'こんにちは') })), /名乗り/);
});

test('600円・ラケット・室内用の靴のどれかが欠ける', () => {
  assert.match(errorsOf(good({ caption: good().caption.replace('1回600円', '1回の会場代') })), /600円/);
  assert.match(errorsOf(good({ caption: good().caption.replace('ラケットは無料で貸し出します。', '') })), /ラケット/);
  assert.match(errorsOf(good({ caption: good().caption.replace('室内用の靴', '靴') })), /室内用/);
});

test('会場名・LINE・参加人数', () => {
  assert.match(errorsOf(good({ caption: `${good().caption}\n会場は◯◯市民体育館です` })), /会場名/);
  assert.equal(errorsOf(good({ caption: `${good().caption}\n和歌山市内の体育館で活動します` })), '');
  assert.match(errorsOf(good({ caption: `${good().caption}\nLINEグループに招待します` })), /LINE/);
  assert.match(errorsOf(good({ caption: `${good().caption}\nラインに招待します` })), /LINE/);
  // コートの線の話はLINEではない
  assert.equal(errorsOf(good({ scenes: good().scenes.map((s, i) => (i === 1 ? { ...s, sub: 'サービスラインの内側' } : s)) })), '');
  assert.match(errorsOf(good({ caption: `${good().caption}\n毎回20〜30人来ています` })), /参加人数/);
  assert.match(errorsOf(good({ caption: `${good().caption}\n12人くらいです` })), /参加人数/);
  assert.equal(errorsOf(good({ caption: `${good().caption}\n1人で来る人が多いです` })), '');
  assert.match(warningsOf(good({ caption: `${good().caption}\n4人でコートに入ります` })), /参加人数でないか/);
});

test('金額の見出し・600円を持ち物に混ぜる・体育館代', () => {
  const scenes = good().scenes.map((s, i) => (i === 2 ? { ...s, head: '1回\n{n}円', countTo: 600 } : s));
  assert.match(errorsOf(good({ scenes })), /金額/);
  assert.match(errorsOf(good({ caption: `${good().caption}\n持ち物はシューズと600円だけ` })), /持ち物/);
  assert.match(errorsOf(good({ caption: `${good().caption}\n体育館代です` })), /体育館代/);
});

test('禁止の言い回し', () => {
  for (const w of ['大募集', '初心者大歓迎', 'DMお待ちしています', 'まずは一度どうぞ', '浮くことはない', '気まずい', '下手でも', '手持ち無沙汰にはなりません', '出会い']) {
    assert.notEqual(errorsOf(good({ caption: `${good().caption}\n${w}` })), '', w);
  }
});

test('過ぎた日付と予定日', () => {
  assert.match(errorsOf(good({ caption: `${good().caption}\n9/27に活動します` })), /過ぎた日付/);
  assert.match(errorsOf(good({ date: '2026-10-01' })), /予定日/);
});

test('要撮影と声のクレジット', () => {
  assert.match(errorsOf(good({ needsFootage: true })), /撮影/);
  assert.match(errorsOf(good({ voice: { speaker: 'zundamon' } })), /VOICEVOX/);
  assert.equal(errorsOf(good({ voice: { speaker: 'zundamon' }, caption: `${good().caption}\n${VOICEVOX_CREDIT}` })), '');
});

test('尺と見出しの長さは警告', () => {
  const long = good({ scenes: [...good().scenes, { t: 20, d: 9, head: 'もう少し' }] });
  assert.match(warningsOf(long), /長さが29/);
  const wide = good({ scenes: good().scenes.map((s, i) => (i === 0 ? { ...s, head: 'とても長い見出しの行\n2行目' } : s)) });
  assert.match(warningsOf(wide), /見出しの1行/);
});

test('1日1本・週5本', () => {
  const p = scheduleProblems([{ name: 'a', date: '2026-10-13' }, { name: 'b', date: '2026-10-13' }]);
  assert.ok(p.get('a') && p.get('b'));
  const week = ['12', '13', '14', '15', '16', '17', '18'].map((d, i) => ({ name: `r${i}`, date: `2026-10-${d}` }));
  // 10/12（月）〜10/18（日）が同じ週。7本のうち6本目と7本目が上限を超える
  const w = scheduleProblems(week);
  assert.deepEqual([...w.keys()].sort(), ['r5', 'r6']);
});

test('中身を直すとハッシュが変わる', () => {
  assert.notEqual(contentHash(good()), contentHash(good({ caption: `${good().caption}!` })));
  assert.equal(contentHash(good()), contentHash({ ...good(), checks: { ok: true } }));
});
