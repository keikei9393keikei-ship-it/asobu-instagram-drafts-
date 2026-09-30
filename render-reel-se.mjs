// render-reel-se.mjs — dist/reels/<名前>.mp4 に効果音（SE）を足す
//
//   npm run reel:se               … reels/ の全部に SE を足す
//   npm run reel:se -- next27     … 1本だけ
//
// BGM・ナレーションは権利の処理が要るので入れない方針（CLAUDE.md §5.5）。
// ここで足すのは ffmpeg で合成した効果音だけ（whoosh/chime/pop）なので、
// 誰の権利にも触れない。まず `npm run reel` で無音の動画を作ってから、
// このスクリプトで同じファイルに上書きする。
//
// 声（ずんだもんなど）を入れたいときは voices/<名前>/ に WAV/MP3 を場面の順に置く
// （01.wav, 02.wav … が1番目、2番目の場面）。各場面の頭に重ね、場面より長ければ
// 最大1.3倍まで速める。声が入るぶん、効果音は控えめにして声を聞き取りやすくする。
//
// 効果音を置くタイミングは reel.html の seek(t) の計算をなぞっている
// （local = 場面が始まってからの秒数）：
//   - 場面が変わるたびに whoosh
//   - fx:"flash" か countTo がある場面は、白い閃光のピーク（local=0.30秒）に chime
//   - note がある場面は、白い枠が出はじめるタイミングに pop
//     （出はじめる時刻は見出しの行数で決まる。reel.html の after 計算と同じ式）

import { readFile, readdir, mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(ROOT, 'reels');
const DIST = path.join(ROOT, 'dist', 'reels');
const FFMPEG = process.env.FFMPEG || 'ffmpeg';

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.slice(-1500)))));
  });
}

function totalSeconds(scenes) {
  return scenes.reduce((end, s) => Math.max(end, s.t + s.d), 0);
}

/** headline の行数から、note（白い枠）が出はじめる秒（場面開始からの相対）を出す。reel.html の after と同じ式 */
function noteStartLocal(scene) {
  const lines = String(scene.head).replace('{n}', scene.countTo ?? '').split('\n').length;
  const after = 0.10 + lines * 0.11;
  return after + 0.06;
}

async function synth(tmp) {
  const whoosh = path.join(tmp, 'whoosh.wav');
  const chime = path.join(tmp, 'chime.wav');
  const pop = path.join(tmp, 'pop.wav');

  await run(FFMPEG, ['-y', '-loglevel', 'error', '-f', 'lavfi',
    '-i', 'anoisesrc=color=pink:duration=0.30:sample_rate=44100:amplitude=1',
    '-af', 'highpass=f=500,lowpass=f=4500,afade=t=in:st=0:d=0.02,afade=t=out:st=0.08:d=0.22,volume=0.35',
    whoosh]);

  await run(FFMPEG, ['-y', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'sine=frequency=1318.5:duration=0.45:sample_rate=44100',
    '-f', 'lavfi', '-i', 'sine=frequency=1975.5:duration=0.45:sample_rate=44100',
    '-filter_complex', '[0]volume=0.5[a];[1]volume=0.28[b];[a][b]amix=inputs=2:duration=longest,afade=t=in:st=0:d=0.005,afade=t=out:st=0.10:d=0.35',
    chime]);

  await run(FFMPEG, ['-y', '-loglevel', 'error', '-f', 'lavfi',
    '-i', 'sine=frequency=300:duration=0.14:sample_rate=44100',
    '-af', 'afade=t=in:st=0:d=0.003,afade=t=out:st=0.03:d=0.11,volume=0.45',
    pop]);

  return { whoosh, chime, pop };
}

const AUDIO_RE = /\.(wav|mp3|m4a|aac|ogg)$/i;
const VOICES_ROOT = process.env.VOICES_DIR || path.join(ROOT, 'voices');

function probeSeconds(file) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file]);
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('error', reject);
    p.on('close', () => resolve(Number(out.trim()) || 0));
  });
}

/** voices/<名前>/ の音声ファイルを、名前順に並べて返す */
async function listVoices(name) {
  const dir = path.join(VOICES_ROOT, name);
  if (!existsSync(dir)) return [];
  return (await readdir(dir)).filter((f) => AUDIO_RE.test(f)).sort().map((f) => path.join(dir, f));
}

async function addSe(name, se) {
  const specPath = path.join(SRC, `${name}.json`);
  const videoPath = path.join(DIST, `${name}.mp4`);
  if (!existsSync(specPath)) { console.log(`  ${name}: reels/${name}.json がありません。skip`); return; }
  if (!existsSync(videoPath)) { console.log(`  ${name}: dist/reels/${name}.mp4 がありません。先に npm run reel。skip`); return; }

  const spec = JSON.parse(await readFile(specPath, 'utf8'));
  const total = totalSeconds(spec.scenes);

  // 効果音の置き場所を集める
  const hits = []; // { file, atMs }
  for (const s of spec.scenes) {
    hits.push({ file: se.whoosh, atMs: Math.round(s.t * 1000) });
    if (s.fx === 'flash' || s.countTo != null) {
      hits.push({ file: se.chime, atMs: Math.round((s.t + 0.30) * 1000) });
    }
    if (s.note) {
      hits.push({ file: se.pop, atMs: Math.round((s.t + noteStartLocal(s)) * 1000) });
    }
  }

  // 声：i番目のファイルを i番目の場面の頭（+0.15秒）に置く。長すぎれば速める
  const voices = await listVoices(name);
  if (voices.length && voices.length !== spec.scenes.length) {
    console.log(`  ⚠️ ${name}: 声が${voices.length}個、場面が${spec.scenes.length}個。先頭から順に当てます`);
  }
  const voiceHits = [];
  for (const [i, file] of voices.slice(0, spec.scenes.length).entries()) {
    const sc = spec.scenes[i];
    const room = sc.d - 0.25;                       // 場面の終わりの手前までに収めたい
    const len = await probeSeconds(file);
    const tempo = len > room ? Math.min(1.3, len / room) : 1;
    if (len / tempo > room + 0.05) console.log(`  ⚠️ ${name}: ${i + 1}番目の声が場面より長いです（${len.toFixed(1)}秒 > ${sc.d}秒）。短く録り直してください`);
    voiceHits.push({ file, atMs: Math.round((sc.t + 0.15) * 1000), tempo });
  }
  const seGain = voiceHits.length ? 0.55 : 1;      // 声があるときは効果音を小さく

  const tmp = await mkdtemp(path.join(os.tmpdir(), 'asobu-se-'));
  try {
    const all = [...hits.map((h) => ({ ...h, gain: seGain, tempo: 1 })), ...voiceHits.map((h) => ({ ...h, gain: 1 }))];
    const inputs = all.flatMap((h) => ['-i', h.file]);
    const chains = all.map((h, i) =>
      `[${i}:a]aformat=sample_rates=44100:channel_layouts=mono,${h.tempo !== 1 ? `atempo=${h.tempo.toFixed(3)},` : ''}volume=${h.gain},adelay=${h.atMs}|${h.atMs}[s${i}]`).join(';');
    const labels = all.map((_, i) => `[s${i}]`).join('');
    const filter = `${chains};${labels}amix=inputs=${all.length}:duration=longest:normalize=0,` +
      `apad=whole_dur=${total},atrim=0:${total},alimiter=limit=0.9`;
    const mixed = path.join(tmp, 'mixed.wav');
    await run(FFMPEG, ['-y', '-loglevel', 'error', ...inputs, '-filter_complex', filter, mixed]);

    // 読み込み元と書き出し先が同じファイルだと ffmpeg が壊れるので、いったん tmp に出してから置き換える
    const out = path.join(tmp, 'out.mp4');
    await run(FFMPEG, ['-y', '-loglevel', 'error',
      '-i', videoPath, '-i', mixed,
      '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k', '-shortest',
      out]);
    await rm(videoPath, { force: true });
    await run('cp', [out, videoPath]);
    console.log(`  ${name}: 効果音 ${hits.length}個${voiceHits.length ? ` + 声 ${voiceHits.length}個` : ''} -> dist/reels/${name}.mp4`);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
if (!existsSync(SRC)) { console.log('reels/ がありません。'); process.exit(0); }
const names = (await readdir(SRC))
  .filter((n) => n.endsWith('.json'))
  .map((n) => n.replace(/\.json$/, ''))
  .filter((n) => only.length === 0 || only.includes(n))
  .sort();

const tmpSe = await mkdtemp(path.join(os.tmpdir(), 'asobu-se-src-'));
try {
  const se = await synth(tmpSe);
  for (const n of names) await addSe(n, se);
} finally {
  await rm(tmpSe, { recursive: true, force: true });
}
console.log(`done. ${names.length}本に効果音を足しました。`);
