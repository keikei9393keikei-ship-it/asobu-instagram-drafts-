// build-status.mjs — 管理ボードが読む dist/status.json を作る
//
//   npm run status
//
// 読むもの（どれも無ければ空のまま進む）:
//   reels/*.json                main にあるリール（＝承認済み）
//   data/                       data ブランチの中身（build.yml が取ってくる）
//     metrics/<名前>.json        投稿後の数字
//     runs/publish.json          投稿の結果（成功・失敗）
//     runs/agents.json           担当ごとの最後に動いた時刻
//     pipeline/backlog.json      ネタ案〜校閲で止まっているもの・撮影リスト
//     inbox-summary.json         受信箱の件数・優先度・期限だけ
//   GitHub API（読み取りのみ。GITHUB_TOKEN が無ければ認証なしで読む。公開リポジトリなので読めるが、
//              回数制限があり、ログ（❌ の行）は認証がないと読めない）
//     開いている週次PR（weekly-reels ラベル）と、その中のリール
//     投稿系ワークフローの最後の実行と、失敗したときの ❌ の行
//
// ⚠️ status.json は公開される。DMの本文や相手の名前、トークンは入れない。
//    受信箱の要約は決まったキーの数値と日時だけを拾い、ほかは捨てる（pickInbox）。

import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { todayJST } from './lib/rules.mjs';
import { validateReel, totalSeconds, STAGES, STAGE_LABELS } from './lib/reel-schema.mjs';
import { redact, diagnose } from './lib/diagnose.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.resolve(ROOT, process.env.DATA_DIR || 'data');
const DIST = path.join(ROOT, 'dist');
const REPO = process.env.GITHUB_REPOSITORY || 'keikei9393keikei-ship-it/asobu-instagram-drafts-';
const TOKEN = process.env.GITHUB_TOKEN || '';
const PR_LABEL = 'weekly-reels';
// 予定日を過ぎても投稿の記録がないとき、何日前までを警告にするか。
// それより古いものは「記録なし」として並べるだけにする（自動投稿を止めていた時期の分が警告で埋まらないように）
const OVERDUE_ALERT_DAYS = 3;

// ボードに出す投稿系のワークフロー
const WORKFLOWS = [
  { file: 'auto-publish-reel.yml', label: 'リールの自動投稿' },
  { file: 'auto-publish.yml', label: 'カードの自動投稿' },
  { file: 'build.yml', label: 'ビルドとPages' },
];

const today = todayJST();
const alerts = [];

async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function gh(endpoint, { raw = false } = {}) {
  if (process.env.GITHUB_API === 'off') return null;
  const headers = {
    Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
  try {
    const r = await fetch(`https://api.github.com${endpoint}`, { headers });
    if (!r.ok) {
      console.log(`  （GitHub API ${endpoint.split('?')[0]} → HTTP ${r.status}。この項目は空にします）`);
      return null;
    }
    return raw ? r.text() : r.json();
  } catch (e) {
    console.log(`  （GitHub API に届きません: ${e.message}。この項目は空にします）`);
    return null;
  }
}

/** キャプションの名乗りと空行を飛ばした最初の文を、一覧用の見出しにする */
function titleOf(spec, name) {
  const line = String(spec.caption || '').split('\n').slice(1).map((l) => l.trim()).find(Boolean);
  return (line || spec.scenes?.[0]?.head?.replace(/\n/g, '') || name).slice(0, 40);
}

function reelSummary(name, spec) {
  return {
    name,
    title: titleOf(spec, name),
    date: spec.date || null,
    seconds: +totalSeconds(spec.scenes).toFixed(1),
    source: spec.source ? { type: spec.source.type, note: String(spec.source.note || '').slice(0, 80) } : null,
    needsFootage: !!spec.needsFootage,
    checks: spec.checks
      ? { ok: !!spec.checks.ok, at: spec.checks.at || null,
          errors: (spec.checks.errors || []).map(String).slice(0, 20),
          warnings: (spec.checks.warnings || []).map(String).slice(0, 20) }
      : null,
  };
}

// ── main のリール ─────────────────────────────────────────
async function loadMainReels() {
  const dir = path.join(ROOT, 'reels');
  if (!existsSync(dir)) return [];
  const out = [];
  for (const f of (await readdir(dir)).filter((n) => n.endsWith('.json')).sort()) {
    const name = f.replace(/\.json$/, '');
    const spec = await readJson(path.join(dir, f));
    const errors = spec ? validateReel(spec) : ['JSONとして読めません'];
    if (errors.length) {
      alerts.push({ level: 'error', title: `reels/${f} の形が正しくありません`, detail: errors.slice(0, 3).join(' / '),
        action: 'ファイルを直してPRを出す' });
      continue;
    }
    out.push({ name, spec });
  }
  return out;
}

// ── data ブランチ ─────────────────────────────────────────
async function loadMetrics() {
  const dir = path.join(DATA, 'metrics');
  const out = {};
  if (!existsSync(dir)) return out;
  for (const f of (await readdir(dir)).filter((n) => n.endsWith('.json'))) {
    const m = await readJson(path.join(dir, f));
    if (m && Array.isArray(m.snapshots)) out[f.replace(/\.json$/, '')] = m;
  }
  return out;
}

const NUM_KEYS = ['views', 'reach', 'saved', 'shares', 'likes', 'comments', 'follows', 'avg_watch_ms'];
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function latestSnapshot(m) {
  const s = m.snapshots.slice().sort((a, b) => String(a.at).localeCompare(String(b.at))).at(-1) || {};
  return Object.fromEntries([['at', s.at || null], ...NUM_KEYS.map((k) => [k, num(s[k])])]);
}

/** 日本時間の日付（YYYY-MM-DD）から、その週の月曜を返す */
function mondayOf(ymd) {
  const d = new Date(`${ymd}T00:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7; // 月=0
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}
function addDays(ymd, n) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const toJstDate = (iso) => new Date(new Date(iso).getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);

const WEEK_KEYS = ['views', 'saved', 'shares', 'likes', 'comments', 'follows'];

/** 直近4週（今週を含まない、終わった週）の合計。投稿した週に数える */
function weeklyMetrics(published) {
  const thisMonday = mondayOf(today);
  const weeks = [];
  for (let i = 4; i >= 1; i--) {
    const start = addDays(thisMonday, -7 * i);
    weeks.push({ start, end: addDays(start, 6), posts: 0, ...Object.fromEntries(WEEK_KEYS.map((k) => [k, null])) });
  }
  for (const p of published) {
    if (!p.postedAt || !p.metrics) continue;
    const w = weeks.find((x) => x.start === mondayOf(toJstDate(p.postedAt)));
    if (!w) continue;
    w.posts++;
    for (const k of WEEK_KEYS) {
      if (p.metrics[k] !== null) w[k] = (w[k] ?? 0) + p.metrics[k];
    }
  }
  return weeks;
}

/** 受信箱の要約。決まったキーの数値と日時しか通さない（本文・名前が混ざっても捨てる） */
function pickInbox(src) {
  if (!src || typeof src !== 'object') return { available: false };
  const isoOrNull = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:\d{2})$/.test(v) ? v : null);
  const count = (v) => (Number.isInteger(v) && v >= 0 ? v : 0);
  const PRIORITIES = ['first', 'schedule', 'other'];
  const by = src.byPriority && typeof src.byPriority === 'object' ? src.byPriority : {};
  const deadlines = Array.isArray(src.deadlines) ? src.deadlines : [];
  return {
    available: true,
    updatedAt: isoOrNull(src.updatedAt),
    unreplied: count(src.unreplied),
    byPriority: Object.fromEntries(PRIORITIES.map((p) => [p, count(by[p])])),
    deadlines: deadlines
      .filter((d) => d && PRIORITIES.includes(d.priority) && isoOrNull(d.due))
      .map((d) => ({ priority: d.priority, due: d.due }))
      .sort((a, b) => a.due.localeCompare(b.due))
      .slice(0, 20),
  };
}

function pickBacklog(src) {
  const items = Array.isArray(src?.items) ? src.items : [];
  return items
    .filter((i) => i && STAGES.includes(i.stage) && STAGES.indexOf(i.stage) <= STAGES.indexOf('check'))
    .map((i) => ({
      title: String(i.title || '（無題）').slice(0, 60),
      stage: i.stage,
      needsFootage: !!i.needsFootage,
      note: String(i.note || '').slice(0, 120),
      shots: Array.isArray(i.shots) ? i.shots.map((s) => String(s).slice(0, 80)).slice(0, 10) : [],
      updatedAt: typeof i.updatedAt === 'string' ? i.updatedAt : null,
    }));
}

// ── チーム ───────────────────────────────────────────────
async function loadTeam() {
  const runs = (await readJson(path.join(DATA, 'runs', 'agents.json'), {})) || {};
  const files = [];
  const walk = async (dir) => {
    if (!existsSync(dir)) return;
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.name.endsWith('.md')) files.push(p);
    }
  };
  await walk(path.join(ROOT, '.claude', 'agents'));
  const team = [];
  for (const f of files.sort()) {
    const fm = (await readFile(f, 'utf8')).match(/^---\n([\s\S]*?)\n---/);
    if (!fm) continue;
    const get = (k) => (fm[1].match(new RegExp(`^${k}:\\s*(.*)$`, 'm')) || [])[1]?.trim() || '';
    const name = get('name');
    const desc = get('description');
    // 「【secretary の指示先／企画担当】…」から役割名だけを抜く
    const role = (desc.match(/／([^】]+)】/) || [])[1] || (name === 'secretary' ? '秘書・窓口' : '');
    const last = runs[name];
    team.push({ name, role, color: get('color'), lastRunAt: typeof last === 'string' ? last : null });
  }
  return team;
}

// ── GitHub（週次PR・ワークフロー） ─────────────────────────
async function loadPendingPRs() {
  const pulls = await gh(`/repos/${REPO}/pulls?state=open&per_page=50`);
  if (!Array.isArray(pulls)) return [];
  const out = [];
  for (const pr of pulls) {
    if (!pr.labels?.some((l) => l.name === PR_LABEL)) continue;
    // 他人のフォークから来たPRは取り込まない（ボードに出す＝公開の場で動画を作ることになるため）
    if (pr.head?.repo?.full_name !== REPO) continue;
    const files = (await gh(`/repos/${REPO}/pulls/${pr.number}/files?per_page=100`)) || [];
    const reels = [];
    for (const f of files) {
      if (!/^reels\/[^/]+\.json$/.test(f.filename) || f.status === 'removed') continue;
      const text = await gh(`/repos/${REPO}/contents/${f.filename}?ref=${pr.head.sha}`, { raw: true });
      let spec = null;
      try { spec = JSON.parse(text); } catch { /* 読めないものは形のエラーとして出す */ }
      const name = path.basename(f.filename, '.json');
      const errors = spec ? validateReel(spec) : ['JSONとして読めません'];
      reels.push({
        ...(spec && !errors.length ? reelSummary(name, spec) : { name, title: name, date: spec?.date || null }),
        caption: spec?.caption ? String(spec.caption) : '',
        schemaErrors: errors,
        // 動画のプレビューは M5（build.yml が dist/pending/ に描き出す）で入る
        video: existsSync(path.join(DIST, 'pending', String(pr.number), `${name}.mp4`))
          ? `pending/${pr.number}/${name}.mp4` : null,
      });
    }
    out.push({ number: pr.number, title: pr.title, url: pr.html_url, updatedAt: pr.updated_at, reels });
  }
  return out;
}

/** 失敗した実行のログから ❌ の行を拾う（公開リポジトリのログなので、もともと誰でも読めるもの） */
async function failureLines(runId) {
  const jobs = await gh(`/repos/${REPO}/actions/runs/${runId}/jobs`);
  const failed = jobs?.jobs?.find((j) => j.conclusion === 'failure');
  if (!failed) return [];
  const log = await gh(`/repos/${REPO}/actions/jobs/${failed.id}/logs`, { raw: true });
  if (!log) return [];
  return String(log).split('\n')
    .map((l) => l.replace(/^\S+Z\s/, '').trim())
    // 原稿やAPIの失敗は ❌ で始まる行に出る。仕組みの失敗（コマンドが無い等）は Error: の行に出る
    .filter((l) => l.startsWith('❌') || /^(\w*Error|##\[error\])/.test(l) || /\bError: /.test(l))
    .filter((l) => !/Process completed with exit code/.test(l))
    .slice(0, 3)
    .map((l) => redact(l).slice(0, 200));
}

async function loadWorkflows() {
  const out = [];
  for (const w of WORKFLOWS) {
    // いちばん新しい「終わった回」の結果を見る。時間帯の外で何もせず終わった回も success になる
    const runs = await gh(`/repos/${REPO}/actions/workflows/${w.file}/runs?per_page=1&status=completed`);
    const run = runs?.workflow_runs?.[0];
    if (!run) { out.push({ ...w, lastRunAt: null, conclusion: null, url: null }); continue; }
    const entry = { ...w, lastRunAt: run.updated_at, conclusion: run.conclusion, url: run.html_url };
    out.push(entry);
    if (run.conclusion === 'failure') {
      const lines = await failureLines(run.id);
      const { cause, action } = diagnose(lines.join('\n'));
      alerts.push({ level: 'error', title: `${w.label}が失敗しました`, detail: lines.join(' / ') || cause, cause, action, url: run.html_url, at: run.updated_at });
    }
  }
  return out;
}

// ── 組み立て ─────────────────────────────────────────────
const reels = await loadMainReels();
const metrics = await loadMetrics();
const publishLog = await readJson(path.join(DATA, 'runs', 'publish.json'), null);
const backlog = pickBacklog(await readJson(path.join(DATA, 'pipeline', 'backlog.json'), null));
const inbox = pickInbox(await readJson(path.join(DATA, 'inbox-summary.json'), null));

const scheduled = [];
const published = [];
const unrecorded = [];
const undated = [];
for (const { name, spec } of reels) {
  const m = metrics[name];
  const base = reelSummary(name, spec);
  if (m?.media_id || spec.stage === 'published') {
    published.push({ ...base, postedAt: m?.posted_at || null, permalink: m?.permalink || null,
      metrics: m ? latestSnapshot(m) : null });
  } else if (!spec.date) {
    undated.push(base);
  } else if (spec.date >= today) {
    scheduled.push(base);
  } else {
    unrecorded.push(base);
    if (spec.date >= addDays(today, -OVERDUE_ALERT_DAYS)) {
      alerts.push({ level: 'warn', title: `「${base.title}」が予定日（${spec.date}）を過ぎても投稿されていません`,
        cause: 'マージが予定日に間に合わなかったか、自動投稿が失敗した',
        action: 'ボードのワークフロー欄で失敗がないか見る。出し直すなら date を変えてPRを出す' });
    }
  }
}
scheduled.sort((a, b) => a.date.localeCompare(b.date));
published.sort((a, b) => String(b.postedAt || b.date).localeCompare(String(a.postedAt || a.date)));

const pending = await loadPendingPRs();
const workflows = await loadWorkflows();

if (publishLog && publishLog.ok === false) {
  const { cause, action } = diagnose(publishLog.error);
  alerts.push({ level: 'error', title: `投稿に失敗しました（${publishLog.target || '不明'}）`,
    detail: redact(publishLog.error || '').slice(0, 200), cause, action, url: publishLog.runUrl || null, at: publishLog.at || null });
}
if (inbox.available && inbox.byPriority.first > 0) {
  alerts.push({ level: 'info', title: `初参加の相談が ${inbox.byPriority.first}件 返信を待っています`,
    action: 'ドライブの受信箱シートで下書きを確かめて、Instagramから返信する' });
}

// 段階ごとの本数。ネタ案〜校閲は backlog、承認待ちは週次PR、投稿予定・投稿済みは main と数字から
const stageItems = Object.fromEntries(STAGES.map((s) => [s, []]));
for (const b of backlog) stageItems[b.stage].push({ title: b.title });
for (const pr of pending) for (const r of pr.reels) stageItems.awaiting.push({ title: r.title, date: r.date, pr: pr.number });
for (const r of scheduled) stageItems.scheduled.push({ title: r.title, date: r.date });
for (const r of published) stageItems.published.push({ title: r.title, date: r.date });

const shootingList = backlog.filter((b) => b.needsFootage).map((b) => ({ title: b.title, shots: b.shots, note: b.note }));
for (const r of [...scheduled, ...undated]) if (r.needsFootage) shootingList.push({ title: r.title, shots: [], note: `予定日 ${r.date || '未定'}` });

const status = {
  version: 1,
  generatedAt: new Date().toISOString(),
  today,
  stages: STAGES.map((s) => ({ key: s, label: STAGE_LABELS[s], count: stageItems[s].length, items: stageItems[s] })),
  pending,
  scheduled,
  undated,
  published,
  unrecorded,
  metrics: { weeks: weeklyMetrics(published), available: Object.keys(metrics).length > 0 },
  inbox,
  shootingList,
  team: await loadTeam(),
  workflows,
  alerts,
  sources: { data: existsSync(DATA), github: workflows.some((w) => w.lastRunAt) },
};

await mkdir(DIST, { recursive: true });
await writeFile(path.join(DIST, 'status.json'), JSON.stringify(status, null, 2));
console.log(`status.json: 段階 ${status.stages.map((s) => `${s.label}${s.count}`).join(' ')} / 警告 ${alerts.length}件`);
