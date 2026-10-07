// scripts/reel-all.mjs — 声 → 映像 → 合成を1回で流す
//
//   npm run reel:all -- grip
//
//   1. node scripts/make-voices.mjs <名前>   voices/<名前>/script.txt から声（WAV）を作る
//   2. node render-reel.mjs <名前>           映像だけの MP4 を作る
//   3. node render-reel-se.mjs <名前>        効果音と声を重ねる（映像はコピーなので変わらない）
//
// 2 と 3 の前後で映像データの md5 を比べて、合成で映像が変わっていないことも確かめる。
// 合成は音声の長さ（ちょうど全場面の合計秒）で切るため、映像の最後の1フレーム（0.03秒）だけは
// 落ちる（render-reel-se.mjs の -shortest。もとからの動き）。なので「合成後と同じ枚数までの」md5 で比べる。
// 声の台本（voices/<名前>/script.txt）がなければ、1 を飛ばして効果音だけを重ねる。
//
// package.json に "reel:all": "node render-reel.mjs $NAME && …" と書いても、npm の `-- 名前` は
// 文の最後にしか付かないので、名前を3つの手順に渡せない。そのため、このスクリプトが受け取って配る。

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, copyFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FFMPEG = process.env.FFMPEG || 'ffmpeg';

const name = process.argv.slice(2).find((a) => !a.startsWith('-'));
if (!name) { console.error('使い方: npm run reel:all -- <名前>'); process.exit(2); }

function step(label, args) {
  console.log(`\n== ${label}`);
  const r = spawnSync('node', args, { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) { console.error(`ERROR: 「${label}」が失敗しました（exit ${r.status}）`); process.exit(r.status || 1); }
}

/** 映像データだけの md5（音声は見ない）。limit があれば、先頭からその枚数まで */
function videoMd5(file, limit) {
  const args = ['-v', 'error', '-i', file, '-map', '0:v', '-c', 'copy', ...(limit ? ['-frames:v', String(limit)] : []), '-f', 'md5', '-'];
  const r = spawnSync(FFMPEG, args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim().replace(/^MD5=/, '');
}

function videoFrames(file) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v', '-count_packets',
    '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', file], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  return Number(r.stdout.trim());
}

const script = path.join(ROOT, 'voices', name, 'script.txt');
if (existsSync(script)) step('1/3 声を作る', ['scripts/make-voices.mjs', name]);
else console.log(`\n== 1/3 声: voices/${name}/script.txt がないので飛ばします（効果音だけになります）`);

step('2/3 映像を作る', ['render-reel.mjs', name]);
const mp4 = path.join(ROOT, 'dist', 'reels', `${name}.mp4`);
// 3 は同じファイルを上書きするので、合成前のものを取っておく
const tmp = mkdtempSync(path.join(os.tmpdir(), 'asobu-reelall-'));
const pre = path.join(tmp, 'pre.mp4');
copyFileSync(mp4, pre);
const framesBefore = videoFrames(pre);

step('3/3 効果音と声を重ねる', ['render-reel-se.mjs', name]);
const framesAfter = videoFrames(mp4);
const before = videoMd5(pre, framesAfter);   // 合成後と同じ枚数まで
const after = videoMd5(mp4);
rmSync(tmp, { recursive: true, force: true });

console.log(`\n映像 フレーム数  合成前 ${framesBefore} / 合成後 ${framesAfter}`);
console.log(`映像 md5（先頭 ${framesAfter} フレーム）\n  合成前 ${before}\n  合成後 ${after}\n  -> ${before === after ? '同じ（映像は変わっていません）' : '違います！'}`);
if (before !== after) process.exit(1);
console.log(`\ndone. dist/reels/${name}.mp4`);
