// lib/voice.mjs — ずんだもんの声を VOICEVOX エンジンで作る
//
// 場面の say（セリフ）を1本ずつ WAV にして、render-reel.mjs が動画の音声として並べる。
// エンジンは HTTP で話す（/audio_query → /synthesis）。Actions では Docker で立てる（build.yml）。
//
// 利用規約（2026-10 時点で確認）：商用・非商用ともに使える。条件はクレジット表記
// 「VOICEVOX:ずんだもん」。動画の説明欄か動画内に、見に行けば分かる程度に書く。
// → キャプションへの表記は lib/compliance.mjs が必須にしている。動画内にも小さく出す（reel.html）。

import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

export const VOICEVOX_URL = (process.env.VOICEVOX_URL || 'http://localhost:50021').replace(/\/$/, '');
/** 話し手の名前 → VOICEVOX のスタイル ID（ずんだもん ノーマル = 3） */
export const SPEAKERS = { zundamon: 3 };
/** 場面が始まってから話し始めるまで（見出しが出そろうのを待つ） */
export const SAY_DELAY = 0.35;
/** 話し終わってから場面が切り替わるまでに残す余白 */
export const SAY_TAIL = 0.15;
const DEFAULT_SPEED = 1.1;

/** 読み間違えやすい語の読み。場面の yomi で足せる（場面の指定が優先） */
export const DEFAULT_YOMI = { 遊部: 'あそぶ', ASOBU: 'あそぶ', DM: 'ディーエム', '600円': 'ろっぴゃくえん' };

/** 実際に読ませる文。読みを置き換える。改行は吹き出しの折り返し位置なので、声では無視する */
export function speechText(scene) {
  let text = String(scene.say || '').replace(/\n/g, '');
  const yomi = { ...DEFAULT_YOMI, ...(scene.yomi || {}) };
  // 長い表記から置き換える（「遊部」と「遊」のように重なるとき、長いほうを先に）
  for (const k of Object.keys(yomi).sort((a, b) => b.length - a.length)) text = text.split(k).join(yomi[k]);
  return text;
}

function voiceParams(spec) {
  const speaker = SPEAKERS[spec.voice?.speaker];
  if (speaker === undefined) throw new Error(`voice.speaker「${spec.voice?.speaker}」は使えません（使えるのは ${Object.keys(SPEAKERS).join(' / ')}）`);
  return { speaker, speed: spec.voice?.speed ?? DEFAULT_SPEED };
}

/** 同じ文・同じ声なら同じファイル名になる（作り直さずに済む） */
export function voiceKey(text, { speaker, speed }) {
  return createHash('sha256').update(JSON.stringify({ text, speaker, speed, v: 1 })).digest('hex').slice(0, 20);
}

/** WAV の長さ（秒）。ヘッダの fmt と data から読む */
export function wavSeconds(buf) {
  let off = 12, byteRate = 0;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') byteRate = buf.readUInt32LE(off + 16);
    if (id === 'data') return byteRate ? size / byteRate : 0;
    off += 8 + size + (size % 2);
  }
  throw new Error('WAV の data が見つかりません');
}

export async function engineUp(url = VOICEVOX_URL) {
  try {
    const r = await fetch(`${url}/version`);
    return r.ok ? (await r.text()).replace(/"/g, '') : null;
  } catch {
    return null;
  }
}

async function synth(text, { speaker, speed }, url) {
  const q = await fetch(`${url}/audio_query?${new URLSearchParams({ text, speaker: String(speaker) })}`, { method: 'POST' });
  if (!q.ok) throw new Error(`VOICEVOX audio_query → HTTP ${q.status}`);
  const query = await q.json();
  Object.assign(query, { speedScale: speed, outputSamplingRate: 44100, outputStereo: true, prePhonemeLength: 0.05, postPhonemeLength: 0.1 });
  const s = await fetch(`${url}/synthesis?speaker=${speaker}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(query),
  });
  if (!s.ok) throw new Error(`VOICEVOX synthesis → HTTP ${s.status}`);
  return Buffer.from(await s.arrayBuffer());
}

/** セリフのある場面を [{ i, text, file }] で返す（まだ作らない） */
export function plannedLines(spec, dir) {
  if (!spec.voice) return [];
  const params = voiceParams(spec);
  return (spec.scenes || []).map((s, i) => ({ s, i })).filter(({ s }) => s.say && s.say.trim()).map(({ s, i }) => {
    const text = speechText(s);
    return { i, text, file: path.join(dir, `${voiceKey(text, params)}.wav`) };
  });
}

/**
 * セリフの WAV を用意する。作ってあるものは使い回す。
 * 声が場面に収まらないときは、勝手に場面を伸ばさずにエラーにする（決めた尺を崩さないため）。
 * @returns {Promise<{ i:number, file:string, seconds:number, start:number }[]>}
 */
export async function prepareVoice(spec, dir, url = VOICEVOX_URL) {
  const lines = plannedLines(spec, dir);
  if (!lines.length) return [];
  const params = voiceParams(spec);
  await mkdir(dir, { recursive: true });
  const missing = lines.filter((l) => !existsSync(l.file));
  if (missing.length && !(await engineUp(url))) {
    throw new Error(`VOICEVOX エンジンに届きません（${url}）。セリフ${missing.length}本の音声がまだ作られていません。` +
      'Actions では build.yml の「Start VOICEVOX」で立てる。手元では docker run -d -p 50021:50021 voicevox/voicevox_engine:cpu-0.25.2');
  }
  const out = [];
  const tooLong = [];
  for (const l of lines) {
    if (!existsSync(l.file)) await writeFile(l.file, await synth(l.text, params, url));
    const seconds = wavSeconds(await readFile(l.file));
    const scene = spec.scenes[l.i];
    if (SAY_DELAY + seconds + SAY_TAIL > scene.d) {
      tooLong.push(`場面${l.i + 1}「${scene.say}」の声が${seconds.toFixed(2)}秒。場面の${scene.d}秒に収まりません（${(SAY_DELAY + seconds + SAY_TAIL).toFixed(1)}秒以上にするか、セリフを短くする）`);
    }
    out.push({ i: l.i, file: l.file, seconds, start: scene.t + SAY_DELAY });
  }
  if (tooLong.length) throw new Error(tooLong.join('\n'));
  return out;
}
