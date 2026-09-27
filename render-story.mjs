// render-story.mjs — stories/<名前>.json からストーリー用の静止画（1080×1920 PNG）を作る
//
//   npm run story                … stories/ の全部を dist/stories/ に書き出す
//   npm run story -- next        … 1枚だけ
//
// 見た目はリールと同じ reel.html を使う。場面を1つだけ流して、
// 見出し・札・説明・白枠が出そろった時刻（SETTLED 秒）で1枚撮る。
// 静止画なので、上端の進行バーは消しておく。

import { chromium } from 'playwright';
import { readFile, readdir, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(ROOT, 'stories');
const DIST = path.join(ROOT, 'dist', 'stories');
const TEMPLATE_URL = pathToFileURL(path.join(ROOT, 'reel.html')).href;

// 場面の長さと撮る時刻。入場の動きは1.2秒ほどで終わるので、余裕を見て2.5秒で撮る
const SCENE_D = 10;
const SETTLED = 2.5;

async function renderOne(browser, name) {
  const spec = JSON.parse(await readFile(path.join(SRC, `${name}.json`), 'utf8'));
  const scene = { ...spec.scene, t: 0, d: SCENE_D };

  const page = await browser.newPage({ viewport: { width: 1080, height: 1920 }, deviceScaleFactor: 1 });
  await page.goto(TEMPLATE_URL, { waitUntil: 'networkidle' });
  await page.addStyleTag({ content: '.bar{display:none !important;}' });
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate((s) => window.renderReel([s.scene], s.foot), { scene, foot: spec.foot });
  await page.evaluate(async () => {
    await Promise.all([
      document.fonts.load('900 190px "Zen Maru Gothic"'),
      document.fonts.load('700 46px "Zen Maru Gothic"'),
    ]);
    await document.fonts.ready;
  });
  await page.evaluate((t) => window.seek(t), SETTLED);

  const out = path.join(DIST, `${name}.png`);
  await (await page.$('#stage')).screenshot({ path: out });
  await page.close();
  console.log(`  ${name} -> dist/stories/${name}.png`);
}

const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
if (!existsSync(SRC)) {
  console.log('stories/ がありません。');
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
console.log(`done. ${names.length} stories -> dist/stories/`);
