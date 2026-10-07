// scripts/make-voices.mjs — voices/<名前>/script.txt から、ずんだもんの声（WAV）を作る
//
//   node scripts/make-voices.mjs grip          … voices/grip/01.wav, 02.wav … を書き出す
//   npm run voices -- grip                     … 同じ
//
// VOICEVOX ENGINE（CPU版）を使う。入れ方は scripts/setup-voicevox.sh。
// ENGINE が動いていなければ、このスクリプトが起動して、終わったら止める。
//
// 台本は「01（0.15秒〜 / 枠2.45秒）ラケットの握り方、3つだけなのだ！」の書式。
// 行頭の番号が出力ファイル名になり、全角カッコの中は読み飛ばす。
// 文言は台本どおりに読ませる（書き換えない）。
//
// 前後の無音は ffmpeg で削る（silenceremove start_threshold=-40dB を前後に）。
// 声を場面に合わせる処理（1.3倍まで速める）は render-reel-se.mjs の仕事なので、ここではやらない。

import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VOICES_ROOT = process.env.VOICES_DIR || path.join(ROOT, 'voices');
const FFMPEG = process.env.FFMPEG || 'ffmpeg';

const HOST = process.env.VOICEVOX_HOST || '127.0.0.1';
const PORT = Number(process.env.VOICEVOX_PORT || 50021);
const BASE = `http://${HOST}:${PORT}`;
const ENGINE_DIR = process.env.VOICEVOX_DIR || path.join(os.homedir(), '.cache', 'voicevox', 'engine');

const SPEAKER_NAME = 'ずんだもん';
const STYLE_NAME = 'ノーマル';
const SPEED = 1.15;       // 話す速さ。ほかは初期値のまま
const TRIM = 'silenceremove=start_periods=1:start_threshold=-40dB,areverse,' +
             'silenceremove=start_periods=1:start_threshold=-40dB,areverse';

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.slice(-1500)))));
  });
}

/** 台本を読んで [{ n, text }] にする。番号の行だけを拾い、見出しの行は読み飛ばす */
export function parseScript(src) {
  const lines = [];
  for (const raw of src.split('\n')) {
    const m = raw.match(/^(\d{1,3})（[^）]*）\s*(.+?)\s*$/);
    if (m) lines.push({ n: Number(m[1]), text: m[2] });
  }
  return lines;
}

async function engineUp() {
  try {
    const r = await fetch(`${BASE}/version`, { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch { return false; }
}

/** ENGINE が動いていなければ起動する。起動したときだけ、あとで止める */
async function ensureEngine() {
  if (await engineUp()) return null;
  const exe = path.join(ENGINE_DIR, 'run');
  if (!existsSync(exe)) {
    throw new Error(`VOICEVOX ENGINE が見つかりません（${exe}）。先に bash scripts/setup-voicevox.sh を流してください。`);
  }
  const child = spawn(exe, ['--host', HOST, '--port', String(PORT), '--cpu_num_threads', String(Math.max(1, os.cpus().length))], {
    cwd: ENGINE_DIR, stdio: ['ignore', 'ignore', 'ignore'], detached: false,
  });
  child.on('error', (e) => { throw e; });
  for (let i = 0; i < 180; i++) {            // 最大 3 分待つ（初回はモデルの読み込みが長い）
    if (await engineUp()) return child;
    if (child.exitCode !== null) throw new Error(`ENGINE がすぐ終了しました（exit ${child.exitCode}）`);
    await sleep(1000);
  }
  child.kill();
  throw new Error('ENGINE が 3 分たっても立ち上がりません');
}

/** 名前から話者 ID を探す（ずんだもん／ノーマル。通常は 3） */
async function findStyleId() {
  const speakers = await (await fetch(`${BASE}/speakers`)).json();
  const sp = speakers.find((s) => s.name === SPEAKER_NAME);
  if (!sp) throw new Error(`話者「${SPEAKER_NAME}」が見つかりません`);
  const st = sp.styles.find((s) => s.name === STYLE_NAME && (!s.type || s.type === 'talk'));
  if (!st) throw new Error(`「${SPEAKER_NAME}」に「${STYLE_NAME}」のスタイルがありません`);
  return st.id;
}

async function synth(text, speaker) {
  const q = await fetch(`${BASE}/audio_query?speaker=${speaker}&text=${encodeURIComponent(text)}`, { method: 'POST' });
  if (!q.ok) throw new Error(`audio_query ${q.status}: ${await q.text()}`);
  const query = await q.json();
  query.speedScale = SPEED;                  // 話す速さ以外は初期値のまま
  const s = await fetch(`${BASE}/synthesis?speaker=${speaker}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(query),
  });
  if (!s.ok) throw new Error(`synthesis ${s.status}: ${await s.text()}`);
  return Buffer.from(await s.arrayBuffer());
}

async function main() {
  const names = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  if (names.length === 0) { console.error('使い方: node scripts/make-voices.mjs <名前>'); process.exit(2); }

  const jobs = [];
  for (const name of names) {
    const scriptPath = path.join(VOICES_ROOT, name, 'script.txt');
    if (!existsSync(scriptPath)) { console.error(`${scriptPath} がありません`); process.exit(2); }
    const lines = parseScript(await readFile(scriptPath, 'utf8'));
    if (lines.length === 0) { console.error(`${scriptPath} に「01（…）文」の行がありません`); process.exit(2); }
    jobs.push({ name, lines });
  }

  const engine = await ensureEngine();
  try {
    const speaker = await findStyleId();
    console.log(`  話者: ${SPEAKER_NAME}（${STYLE_NAME}） id=${speaker} / 速さ ${SPEED}`);
    for (const { name, lines } of jobs) {
      const outDir = path.join(VOICES_ROOT, name);
      await mkdir(outDir, { recursive: true });
      for (const { n, text } of lines) {
        const id = String(n).padStart(2, '0');
        const raw = path.join(outDir, `.raw_${id}.wav`);
        const out = path.join(outDir, `${id}.wav`);
        await writeFile(raw, await synth(text, speaker));
        await run(FFMPEG, ['-y', '-loglevel', 'error', '-i', raw, '-af', TRIM, out]);
        await rm(raw, { force: true });
        console.log(`  ${name}/${id}.wav  ${text}`);
      }
      console.log(`  ${name}: 声 ${lines.length} 個 -> voices/${name}/`);
    }
  } finally {
    if (engine) engine.kill();
  }
}

// 他のスクリプトから parseScript だけ使えるように、直接流したときだけ main を動かす
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPathSafe(import.meta.url)) {
  main().catch((e) => { console.error(`ERROR: ${e.message}`); process.exit(1); });
}

function fileURLToPathSafe(u) { return fileURLToPath(u); }
