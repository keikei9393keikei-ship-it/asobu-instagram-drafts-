// render-reel.mjs — reels/<名前>.json から 1080×1920 のリール動画（MP4）を作る
//
//   npm run reel                 … reels/ の全部を dist/reels/ に書き出す
//   npm run reel -- beginner     … 1本だけ
//
// reel.html を Playwright で開き、1フレームずつ seek して撮る。
// 同じ t なら必ず同じ絵になる作りなので、何度流しても同じ動画ができる。
// 最後に ffmpeg でつなぐ（GitHub の ubuntu ランナーには ffmpeg が入っている）。

import { chromium } from 'playwright';
import { readFile, readdir, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(ROOT, 'reels');
const DIST = path.join(ROOT, 'dist', 'reels');
const TEMPLATE_URL = pathToFileURL(path.join(ROOT, 'reel.html')).href;

const FPS = 24;
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

/** 場面の長さを足して全体の秒数を出す */
function totalSeconds(scenes) {
  return scenes.reduce((end, s) => Math.max(end, s.t + s.d), 0);
}

async function renderOne(browser, name) {
  const spec = JSON.parse(await readFile(path.join(SRC, `${name}.json`), 'utf8'));
  const seconds = totalSeconds(spec.scenes);
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

  const out = path.join(DIST, `${name}.mp4`);
  await run(FFMPEG, [
    '-y', '-loglevel', 'error',
    '-framerate', String(FPS),
    '-i', path.join(tmp, 'f_%05d.png'),
    '-c:v', 'libx264', '-profile:v', 'high', '-crf', '18',
    '-pix_fmt', 'yuv420p', '-r', '30',
    '-movflags', '+faststart',
    out,
  ]);
  await rm(tmp, { recursive: true, force: true });
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
const browser = await chromium.launch();
for (const n of names) await renderOne(browser, n);
await browser.close();
console.log(`done. ${names.length} reels -> dist/reels/`);
