// render-reel.mjs — reels/<名前>.json から 1080×1920 のリール動画（MP4）を作る
//
//   npm run reel                 … reels/ の全部を dist/reels/ に書き出す
//   npm run reel -- beginner     … 1本だけ
//   npm run reel -- --force      … 中身が変わっていなくても書き出し直す
//
// reel.html を Playwright で開き、1フレームずつ seek して撮る。
// 同じ t なら必ず同じ絵になる作りなので、何度流しても同じ動画ができる。
// 最後に ffmpeg でつなぐ（GitHub の ubuntu ランナーには ffmpeg が入っている）。

import { chromium } from 'playwright';
import { readFile, readdir, mkdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateReel, totalSeconds } from './lib/reel-schema.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(ROOT, 'reels');
const DIST = path.join(ROOT, 'dist', 'reels');
const TEMPLATE_URL = pathToFileURL(path.join(ROOT, 'reel.html')).href;

const FPS = 24;
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const FORCE = process.argv.includes('--force');
// 書き出した動画の元になったもののハッシュ。Actions では dist/reels/ をキャッシュするので、
// 中身が同じなら描き直さずに済む（1本あたり数分かかるため）
const HASHES = path.join(DIST, '.hashes');
// 見た目と書き出し方を決めるファイル。どれかが変わったら全部描き直す
const SHARED = ['reel.html', 'render-reel.mjs', 'assets/mascot.png'];

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

async function renderOne(browser, name) {
  const spec = JSON.parse(await readFile(path.join(SRC, `${name}.json`), 'utf8'));
  const errors = validateReel(spec);
  if (errors.length) throw new Error(`reels/${name}.json の形が正しくありません:\n   - ${errors.join('\n   - ')}`);
  const seconds = totalSeconds(spec.scenes);
  const out = path.join(DIST, `${name}.mp4`);
  const hash = await sourceHash(spec);
  const hashFile = path.join(HASHES, `${name}.txt`);
  if (!FORCE && existsSync(out) && existsSync(hashFile) && (await readFile(hashFile, 'utf8')) === hash) {
    console.log(`  ${name}: 変わっていないので書き出しを省きました -> dist/reels/${name}.mp4`);
    return;
  }
  const frames = Math.round(seconds * FPS);
  const tmp = path.join(DIST, `.frames-${name}`);
  await rm(tmp, { recursive: true, force: true });
  await mkdir(tmp, { recursive: true });

  const page = await browser.newPage({ viewport: { width: 1080, height: 1920 }, deviceScaleFactor: 1 });
  await page.goto(TEMPLATE_URL, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate((s) => window.renderReel(s.scenes, s.foot), spec);
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

  // Instagram のリールは音声トラックのない動画を受け付けないことがあるので、
  // 無音のAACを1本入れておく。音はアプリ側で付ける前提（§5.5）。
  await run(FFMPEG, [
    '-y', '-loglevel', 'error',
    '-framerate', String(FPS),
    '-i', path.join(tmp, 'f_%05d.png'),
    '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
    '-shortest',
    '-c:v', 'libx264', '-profile:v', 'high', '-crf', '18',
    '-pix_fmt', 'yuv420p', '-r', '30',
    '-c:a', 'aac', '-b:a', '96k',
    '-movflags', '+faststart',
    out,
  ]);
  await rm(tmp, { recursive: true, force: true });
  await mkdir(HASHES, { recursive: true });
  await writeFile(hashFile, hash);
  console.log(`  ${name}: ${seconds.toFixed(1)}秒 / ${frames}フレーム -> dist/reels/${name}.mp4`);
}

const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
if (!existsSync(SRC)) {
  console.log('reels/ がありません。');
  process.exit(0);
}
const names = (await readdir(SRC))
  .filter((n) => n.endsWith('.json'))
  .map((n) => n.replace(/\.json$/, ''))
  .filter((n) => only.length === 0 || only.includes(n))
  .sort();

await mkdir(DIST, { recursive: true });
// 全部を書き出すときは、もう JSON の無い動画を消す。キャッシュから戻した古い動画が Pages に残らないように
if (only.length === 0) {
  for (const f of await readdir(DIST)) {
    const m = f.match(/^(.+)\.mp4$/);
    if (m && !names.includes(m[1])) {
      await rm(path.join(DIST, f), { force: true });
      await rm(path.join(HASHES, `${m[1]}.txt`), { force: true });
      console.log(`  ${m[1]}: reels/ に無いので消しました`);
    }
  }
}
// CHROMIUM_PATH を指定すると、入っている Chromium をそのまま使う（Playwright の版と合わないときの逃げ道）
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
for (const n of names) await renderOne(browser, n);
await browser.close();
console.log(`done. ${names.length} reels -> dist/reels/`);
