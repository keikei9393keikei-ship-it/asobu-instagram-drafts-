// render.mjs — weeks/<date>/cards.json からカード画像を生成し dist/ に出力する
// GitHub Actions（PCオフでも動く）で実行。ローカルでも `npm run render` で確認可。
import { chromium } from 'playwright';
import { readFile, readdir, mkdir, cp, writeFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const WEEKS = path.join(ROOT, 'weeks');
const DIST = path.join(ROOT, 'dist');
const TEMPLATE_URL = pathToFileURL(path.join(ROOT, 'template.html')).href;

const layoutOrder = (l) => (l === 'cover' ? 0 : l === 'qa' ? 1 : 2);

async function listWeeks() {
  if (!existsSync(WEEKS)) return [];
  const names = await readdir(WEEKS);
  const out = [];
  for (const n of names) {
    const dir = path.join(WEEKS, n);
    if ((await stat(dir)).isDirectory() && existsSync(path.join(dir, 'cards.json'))) out.push(n);
  }
  return out.sort();
}

async function renderWeek(browser, week) {
  const dir = path.join(WEEKS, week);
  const cards = JSON.parse(await readFile(path.join(dir, 'cards.json'), 'utf8'));
  const outDir = path.join(DIST, week);
  await mkdir(outDir, { recursive: true });

  const page = await browser.newPage({ viewport: { width: 1080, height: 1400 }, deviceScaleFactor: 1 });
  await page.goto(TEMPLATE_URL, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  const count = await page.evaluate((c) => window.renderCards(c), cards);
  // カード描画後に使われるグリフを確実に読み込む
  await page.evaluate(async () => {
    await Promise.all([
      document.fonts.load('900 122px "Zen Maru Gothic"'),
      document.fonts.load('700 33px "Zen Maru Gothic"'),
      document.fonts.load('500 46px "Zen Kaku Gothic New"'),
      document.fonts.load('500 30px "IBM Plex Mono"'),
    ]);
    await document.fonts.ready;
  });
  await page.waitForTimeout(600);

  const els = await page.$$('.card');
  const files = [];
  for (let i = 0; i < els.length; i++) {
    const lay = cards[i]?.layout || 'card';
    const name = `${String(i + 1).padStart(2, '0')}_${lay}.png`;
    await els[i].screenshot({ path: path.join(outDir, name) });
    files.push(name);
  }
  await page.close();

  // caption
  let caption = '';
  if (existsSync(path.join(dir, 'caption.txt'))) {
    caption = await readFile(path.join(dir, 'caption.txt'), 'utf8');
    await cp(path.join(dir, 'caption.txt'), path.join(outDir, 'caption.txt'));
  }

  await writeFile(path.join(outDir, 'index.html'), weekPage(week, files, caption));
  console.log(`  ${week}: ${count} cards`);
  return { week, files, caption };
}

function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

function weekPage(week, files, caption) {
  const imgs = files.map(f => `
    <figure>
      <img src="./${f}" alt="${f}">
      <figcaption>${f} <a href="./${f}" download>保存</a></figcaption>
    </figure>`).join('');
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>遊部 投稿 ${week}</title>
<style>
  body{margin:0;font-family:system-ui,"Hiragino Sans","Yu Gothic",sans-serif;background:#141814;color:#eef0e9;padding:18px 14px 60px;}
  h1{font-size:1.1rem;margin:0 0 4px;} .sub{color:#9aa396;font-size:.85rem;margin:0 0 18px;}
  a{color:#8CC152;} a:hover{color:#a7d977;}
  .grid{display:grid;gap:14px;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));}
  figure{margin:0;background:#1e241f;border:1px solid #2b322c;border-radius:10px;padding:8px;}
  img{width:100%;border-radius:6px;display:block;}
  figcaption{font-size:.72rem;color:#9aa396;margin-top:6px;display:flex;justify-content:space-between;gap:8px;}
  .cap{margin-top:22px;} .cap h2{font-size:.95rem;margin:0 0 6px;}
  textarea{width:100%;min-height:260px;background:#1e241f;color:#eef0e9;border:1px solid #2b322c;border-radius:8px;padding:12px;font:inherit;font-size:.9rem;line-height:1.6;}
  button{margin-top:8px;background:#1F5A3A;color:#fff;border:none;border-radius:7px;padding:9px 16px;font:inherit;font-weight:700;cursor:pointer;}
  p.back{margin:0 0 14px;}
</style></head><body>
<p class="back"><a href="../">← 一覧へ</a></p>
<h1>遊部（ASOBU）投稿 ${week}</h1>
<p class="sub">画像を長押しで保存。キャプションは下のボックスからコピー。</p>
<div class="grid">${imgs}</div>
<div class="cap"><h2>キャプション</h2>
<textarea id="cap" readonly>${esc(caption)}</textarea>
<button onclick="navigator.clipboard.writeText(document.getElementById('cap').value).then(()=>{this.textContent='コピーしました';})">キャプションをコピー</button>
</div>
</body></html>`;
}

function indexPage(weeks) {
  // フォルダ名の日付が今日より前なら「済」を付ける。スマホで過去の週を選んでしまうのを防ぐ。
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const rows = weeks.slice().reverse().map(w => {
    const d = new Date(`${w}T00:00:00`);
    const past = !Number.isNaN(d.valueOf()) && d < today;
    return `<li><a href="./${w}/">${w}</a>${past ? '<span class="past">済</span>' : ''}</li>`;
  }).join('');
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>遊部 投稿カード</title>
<style>body{margin:0;font-family:system-ui,"Hiragino Sans",sans-serif;background:#141814;color:#eef0e9;padding:24px 16px;}
h1{font-size:1.15rem;} a{color:#8CC152;font-size:1.05rem;} li{margin:10px 0;}
.past{margin-left:10px;font-size:.72rem;color:#8b9186;border:1px solid #3a423b;border-radius:999px;padding:2px 9px;vertical-align:middle;}
li:has(.past) a{color:#6f7a6c;}</style></head>
<body><h1>遊部（ASOBU）投稿カード</h1><p style="color:#9aa396;font-size:.85rem;">週を選ぶ → 画像を保存＋キャプションをコピー → Instagramで投稿</p>
<ul>${rows}</ul></body></html>`;
}

const weeks = await listWeeks();
if (!weeks.length) { console.log('weeks/ に cards.json がありません'); process.exit(0); }
await mkdir(DIST, { recursive: true });
const browser = await chromium.launch();
for (const w of weeks) await renderWeek(browser, w);
await browser.close();
await writeFile(path.join(DIST, 'index.html'), indexPage(weeks));
console.log(`done. ${weeks.length} weeks -> dist/`);
