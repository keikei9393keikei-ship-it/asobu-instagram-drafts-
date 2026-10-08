// render-reel.mjs — reels/<名前>.json から 1080×1920 のリール動画（MP4）を作る
//
//   npm run reel                 … reels/ の全部を dist/reels/ に書き出す
//   npm run reel -- beginner     … 1本だけ
//   npm run reel -- --force      … 中身が変わっていなくても書き出し直す
//   node render-reel.mjs --needs-voice … 声を新しく作る必要があれば yes、なければ no を出すだけ（build.yml が使う）
//   node render-reel.mjs --keep-going  … 1本が失敗しても残りを書き出す。失敗は <出力先>/errors.json に書く
//                                         （承認待ちのプレビューで使う。1本の不備でビルド全体を止めないため）
//
// 読む場所と書く場所は環境変数で変えられる（承認待ちのプレビューを dist/pending/<PR番号>/ に出すため）：
//   REELS_SRC（既定 reels/）・REELS_OUT（既定 dist/reels/）。声の置き場は常に dist/reels/.voice/ を共有する
//
// voice のあるリールは、場面の say を VOICEVOX でずんだもんの声にして、その場面の頭（SAY_DELAY 秒後）に重ねる。
// 声のないリールは今までどおり無音の音声トラックを1本入れる。
//
// reel.html を Playwright で開き、1フレームずつ seek して撮る。
// 同じ t なら必ず同じ絵になる作りなので、何度流しても同じ動画ができる。
// 最後に ffmpeg でつなぐ（GitHub の ubuntu ランナーには入っていないので build.yml で入れている）。

import { chromium } from 'playwright';
import { readFile, readdir, mkdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateReel, totalSeconds } from './lib/reel-schema.mjs';
import { prepareVoice, plannedLines } from './lib/voice.mjs';
import { VOICEVOX_CREDIT } from './lib/compliance.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(ROOT, process.env.REELS_SRC || 'reels');
const DIST = path.resolve(ROOT, process.env.REELS_OUT || path.join('dist', 'reels'));
const rel = (p) => path.relative(ROOT, p);
const TEMPLATE_URL = pathToFileURL(path.join(ROOT, 'reel.html')).href;

const FPS = 24;
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const FORCE = process.argv.includes('--force');
const KEEP_GOING = process.argv.includes('--keep-going');
// 書き出した動画の元になったもののハッシュ。Actions では dist/reels/ をキャッシュするので、
// 中身が同じなら描き直さずに済む（1本あたり数分かかるため）
const HASHES = path.join(DIST, '.hashes');
// 見た目と書き出し方を決めるファイル。どれかが変わったら全部描き直す
const SHARED = ['reel.html', 'render-reel.mjs', 'assets/mascot.png', 'lib/voice.mjs'];
// 作った声の置き場。dist/reels/ ごとキャッシュされるので、動画を描き直すときも声は作り直さずに済む。
// 承認待ちのプレビューも同じ置き場を使う（マージしたあとに同じ声を作り直さない）
const VOICE_DIR = path.join(ROOT, 'dist', 'reels', '.voice');

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.slice(-1500)))));
  });
}

/** 絵と音に効く部分だけでハッシュを取る。キャプションや checks を直しただけなら描き直さない */
async function sourceHash(spec) {
  const h = createHash('sha256');
  for (const f of SHARED) h.update(f).update(await readFile(path.join(ROOT, f)));
  h.update(JSON.stringify({ scenes: spec.scenes, foot: spec.foot, voice: spec.voice }));
  return h.digest('hex');
}

/** 声を、それぞれの開始時刻まで遅らせてから重ねる。最後に無音を足して、長さは映像に合わせる（-shortest） */
function voiceFilter(voice) {
  const parts = voice.map((v, k) => {
    const ms = Math.round(v.start * 1000);
    return `[${k + 1}:a]aformat=sample_rates=44100:channel_layouts=stereo,adelay=${ms}|${ms}[v${k}]`;
  });
  const mix = voice.length === 1 ? '[v0]anull' : `${voice.map((_, k) => `[v${k}]`).join('')}amix=inputs=${voice.length}:duration=longest:normalize=0`;
  return `${parts.join(';')};${mix},apad[aout]`;
}

/** 動画が今の中身のまま書き出し済みか */
async function upToDate(name, spec) {
  const out = path.join(DIST, `${name}.mp4`);
  const hashFile = path.join(HASHES, `${name}.txt`);
  return !FORCE && existsSync(out) && existsSync(hashFile) && (await readFile(hashFile, 'utf8')) === (await sourceHash(spec));
}

async function renderOne(browser, name) {
  const spec = JSON.parse(await readFile(path.join(SRC, `${name}.json`), 'utf8'));
  const errors = validateReel(spec);
  if (errors.length) throw new Error(`${rel(SRC)}/${name}.json の形が正しくありません:\n   - ${errors.join('\n   - ')}`);
  const seconds = totalSeconds(spec.scenes);
  const out = path.join(DIST, `${name}.mp4`);
  if (await upToDate(name, spec)) {
    console.log(`  ${name}: 変わっていないので書き出しを省きました -> ${rel(out)}`);
    return false;
  }
  const hash = await sourceHash(spec);
  const hashFile = path.join(HASHES, `${name}.txt`);
  // 声は先に作る。場面に収まらなければ、ここで止まる（描き出しに何分もかけたあとで気づかないように）
  let voice = [];
  try {
    voice = await prepareVoice(spec, VOICE_DIR);
  } catch (e) {
    throw new Error(`${rel(SRC)}/${name}: ${e.message}`);
  }
  const frames = Math.round(seconds * FPS);
  const tmp = path.join(DIST, `.frames-${name}`);
  await rm(tmp, { recursive: true, force: true });
  await mkdir(tmp, { recursive: true });

  const page = await browser.newPage({ viewport: { width: 1080, height: 1920 }, deviceScaleFactor: 1 });
  await page.goto(TEMPLATE_URL, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  const opts = {
    credit: spec.voice ? VOICEVOX_CREDIT : '',
    say: Object.fromEntries(voice.map((v) => [v.i, { start: v.start, seconds: v.seconds }])),
  };
  await page.evaluate(([s, o]) => window.renderReel(s.scenes, s.foot, o), [spec, opts]);
  // 見出しに使う太いグリフを先に読み込ませる。抜けると一瞬だけ別書体で写る
  await page.evaluate(async () => {
    await Promise.all([
      document.fonts.load('900 190px "Zen Maru Gothic"'),
      document.fonts.load('700 46px "Zen Maru Gothic"'),
    ]);
    await document.fonts.ready;
  });

  const stage = await page.$('#stage');
  for (let f = 0; f < frames; f++) {
    await page.evaluate((t) => window.seek(t), f / FPS);
    await stage.screenshot({ path: path.join(tmp, `f_${String(f).padStart(5, '0')}.png`) });
  }
  await page.close();

  // 音声トラック。声があれば各場面の頭に重ね、なければ無音のAACを1本入れる
  // （Instagram のリールは音声トラックのない動画を受け付けないことがあるため。BGMはアプリ側で付ける §5.5）
  const audio = voice.length
    ? [
      ...voice.flatMap((v) => ['-i', v.file]),
      '-filter_complex', voiceFilter(voice),
      '-map', '0:v', '-map', '[aout]',
    ]
    : ['-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100'];
  await run(FFMPEG, [
    '-y', '-loglevel', 'error',
    '-framerate', String(FPS),
    '-i', path.join(tmp, 'f_%05d.png'),
    ...audio,
    '-shortest',
    '-c:v', 'libx264', '-profile:v', 'high', '-crf', '18',
    '-pix_fmt', 'yuv420p', '-r', '30',
    '-c:a', 'aac', '-b:a', '128k',
    '-movflags', '+faststart',
    out,
  ]);
  await rm(tmp, { recursive: true, force: true });
  await mkdir(HASHES, { recursive: true });
  await writeFile(hashFile, hash);
  console.log(`  ${name}: ${seconds.toFixed(1)}秒 / ${frames}フレーム${voice.length ? ` / 声${voice.length}本` : ''} -> ${rel(out)}`);
  return true;
}

const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
if (!existsSync(SRC)) {
  console.log(`${rel(SRC)}/ がありません。`);
  process.exit(0);
}
const names = (await readdir(SRC))
  .filter((n) => n.endsWith('.json'))
  .map((n) => n.replace(/\.json$/, ''))
  .filter((n) => only.length === 0 || only.includes(n))
  .sort();

// 声を新しく作る必要があるか（描き直すリールのうち、まだ作っていないセリフがあるか）だけを答える
if (process.argv.includes('--needs-voice')) {
  let needs = false;
  for (const n of names) {
    const spec = JSON.parse(await readFile(path.join(SRC, `${n}.json`), 'utf8'));
    if (!spec.voice || (await upToDate(n, spec))) continue;
    if (plannedLines(spec, VOICE_DIR).some((l) => !existsSync(l.file))) needs = true;
  }
  console.log(needs ? 'yes' : 'no');
  process.exit(0);
}

await mkdir(DIST, { recursive: true });
// 全部を書き出すときは、もう JSON の無い動画を消す。キャッシュから戻した古い動画が Pages に残らないように
if (only.length === 0) {
  for (const f of await readdir(DIST)) {
    const m = f.match(/^(.+)\.mp4$/);
    if (m && !names.includes(m[1])) {
      await rm(path.join(DIST, f), { force: true });
      await rm(path.join(HASHES, `${m[1]}.txt`), { force: true });
      console.log(`  ${m[1]}: ${rel(SRC)}/ に無いので消しました`);
    }
  }
}
// CHROMIUM_PATH を指定すると、入っている Chromium をそのまま使う（Playwright の版と合わないときの逃げ道）
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
let rendered = 0;
const failures = {};
for (const n of names) {
  try {
    if (await renderOne(browser, n)) rendered++;
  } catch (e) {
    if (!KEEP_GOING) throw e;
    failures[n] = String(e.message).slice(0, 600);
    console.log(`  ❌ ${n}: ${failures[n]}`);
  }
}
await browser.close();
if (KEEP_GOING) {
  // 失敗の一覧（ボードの承認待ちに出す）。失敗がなければ消す
  const errFile = path.join(DIST, 'errors.json');
  if (Object.keys(failures).length) await writeFile(errFile, JSON.stringify(failures, null, 2));
  else await rm(errFile, { force: true });
}
// Actions に「何か書き出したか」を伝える。書き出したときだけキャッシュを保存する（build.yml）
if (process.env.GITHUB_OUTPUT && rendered) await writeFile(process.env.GITHUB_OUTPUT, 'rendered=true\n', { flag: 'a' });
console.log(`done. ${names.length} reels -> ${rel(DIST)}/（書き出し ${rendered}本${Object.keys(failures).length ? `・失敗 ${Object.keys(failures).length}本` : ''}）`);
