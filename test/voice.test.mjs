// ずんだもんの声の部品（lib/voice.mjs）のうち、エンジンなしで確かめられるところ
//   npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { speechText, wavSeconds, plannedLines, voiceKey } from '../lib/voice.mjs';
import { validateReel } from '../lib/reel-schema.mjs';

/** 指定の長さの無音 WAV（44.1kHz・16bit・ステレオ）を作る */
function wav(seconds) {
  const rate = 44100, ch = 2, bytes = 2;
  const data = Math.round(seconds * rate) * ch * bytes;
  const b = Buffer.alloc(44 + data);
  b.write('RIFF', 0); b.writeUInt32LE(36 + data, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(ch, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * ch * bytes, 28); b.writeUInt16LE(ch * bytes, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(data, 40);
  return b;
}

test('WAV の長さを読む', () => {
  assert.equal(wavSeconds(wav(2.5)).toFixed(3), '2.500');
});

test('読みの補正と、改行は声では無視する', () => {
  assert.equal(speechText({ say: '遊部は\nDMで' }), 'あそぶはディーエムで');
  assert.equal(speechText({ say: '体験', yomi: { 体験: 'たいけん' } }), 'たいけん');
});

test('セリフのある場面だけが声になる。voice が無ければ作らない', () => {
  const spec = { voice: { speaker: 'zundamon' }, scenes: [{ t: 0, d: 3, head: 'a', say: 'なのだ' }, { t: 3, d: 3, head: 'b' }] };
  assert.deepEqual(plannedLines(spec, '/tmp/v').map((l) => l.i), [0]);
  assert.deepEqual(plannedLines({ ...spec, voice: undefined }, '/tmp/v'), []);
  assert.throws(() => plannedLines({ ...spec, voice: { speaker: 'nobody' } }, '/tmp/v'), /使えません/);
});

test('同じ文・同じ声なら同じファイル名、速さが違えば別', () => {
  assert.equal(voiceKey('a', { speaker: 3, speed: 1.1 }), voiceKey('a', { speaker: 3, speed: 1.1 }));
  assert.notEqual(voiceKey('a', { speaker: 3, speed: 1.1 }), voiceKey('a', { speaker: 3, speed: 1.2 }));
});

test('voice の形', () => {
  const base = { scenes: [{ t: 0, d: 3, head: 'a' }] };
  assert.deepEqual(validateReel({ ...base, voice: { speaker: 'zundamon', speed: 1.2 } }), []);
  assert.match(validateReel({ ...base, voice: { speaker: 'zundamon', speed: 3 } }).join(), /0\.8〜1\.5/);
  assert.match(validateReel({ ...base, voice: { speaker: 'zundamon', pitch: 1 } }).join(), /知らないキー/);
});
