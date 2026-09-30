// render-telop.mjs — telops/<名前>.json から、映像に重ねる透明テロップ（1080×1920 PNG）を作る
//
//   npm run telop                … telops/ の全部を dist/telops/<名前>/ に書き出す
//   npm run telop -- diet        … 1つだけ
//
// 撮影した動画に、編集アプリ（Instagram・CapCut など）で画像として重ねて使う。
// 見た目はリールの見出しと同じ（オレンジの袋文字＋白い説明枠）。

import { chromium } from 'playwright';
import { readFile, readdir, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(ROOT, 'telops');
const DIST = path.join(ROOT, 'dist', 'telops');
const TEMPLATE_URL = pathToFileURL(path.join(ROOT, 'telop.html')).href;

async function renderSet(browser, name) {
  const spec = JSON.parse(await readFile(path.join(SRC, `${name}.json`), 'utf8'));
  const out = path.join(DIST, name);
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });

  const page = await browser.newPage({ viewport: { width: 1080, height: 1920 }, deviceScaleFactor: 1 });
  await page.goto(TEMPLATE_URL, { waitUntil: 'networkidle' });
  await page.evaluate(async () => {
    await document.fonts.load('900 200px "Zen Maru Gothic"');
    await document.fonts.load('700 48px "Zen Maru Gothic"');
    await document.fonts.ready;
  });
  const stage = await page.$('#stage');
  for (const [i, it] of spec.items.entries()) {
    await page.evaluate((x) => window.renderTelop(x), it);
    const file = `${String(i + 1).padStart(2, '0')}.png`;
    await stage.screenshot({ path: path.join(out, file), omitBackground: true });
    console.log(`  ${name}/${file}  ${it.t || ''}  ${it.head.replace(/\n/g, ' ')}`);
  }
  await page.close();
}

const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
if (!existsSync(SRC)) { console.log('telops/ がありません。'); process.exit(0); }
const names = (await readdir(SRC)).filter((n) => n.endsWith('.json')).map((n) => n.replace(/\.json$/, ''))
  .filter((n) => only.length === 0 || only.includes(n)).sort();
await mkdir(DIST, { recursive: true });
const browser = await chromium.launch();
for (const n of names) await renderSet(browser, n);
await browser.close();
console.log(`done. ${names.length} sets -> dist/telops/`);
