// record-run.mjs — 投稿の結果を data ブランチに残し、失敗したら Issue で知らせる
//
//   node record-run.mjs <結果のJSON>      （publish-reel.mjs が RESULT_FILE に書いたもの）
//
// Actions の投稿ワークフローの最後に `if: always()` で走らせる。
//   - data ブランチの runs/publish.json に「最後の結果」と「直近30回の履歴」を書く
//     （ボードの「投稿済み」と警告はここを読む。data ブランチがまだ無ければ作る）
//   - 失敗したら、ラベル publish-error の Issue を作る（開いていればコメントを足す）。
//     GitHub のアプリに通知が届くので、ボードを開かなくても気づける
//   - 成功したら、開いている publish-error の Issue を閉じる
//
// 結果のファイルが無い（＝今日は出すものがなかった・時間帯の外だった）ときは何もしない。
// 記録に失敗しても、投稿そのものの成否は変えない（警告を出して終わる）。
//
// 必要な環境変数（Actions が自動で入れる）: GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_SERVER_URL, GITHUB_RUN_ID

import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { redact, diagnose } from './lib/diagnose.mjs';

const file = process.argv[2];
const REPO = process.env.GITHUB_REPOSITORY;
const TOKEN = process.env.GITHUB_TOKEN;
const RUN_URL = REPO && process.env.GITHUB_RUN_ID
  ? `${process.env.GITHUB_SERVER_URL || 'https://github.com'}/${REPO}/actions/runs/${process.env.GITHUB_RUN_ID}` : null;
const LABEL = 'publish-error';
const HISTORY = 30;
const BOT = ['-c', 'user.name=github-actions[bot]', '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com'];

const warn = (msg) => console.log(`::warning::${redact(msg)}`);

if (!file || !existsSync(file)) {
  console.log('記録する結果はありません（今日は出すものがなかったか、時間帯の外でした）。');
  process.exit(0);
}
const result = JSON.parse(await readFile(file, 'utf8'));
result.error = result.error ? redact(result.error) : undefined;
result.runUrl = RUN_URL;

const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();

/** data ブランチの runs/publish.json を更新する。ほかの実行と重なったら取り直して3回まで */
async function recordToDataBranch() {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const dir = await mkdtemp(path.join(process.env.RUNNER_TEMP || tmpdir(), 'data-'));
    try {
      let exists = true;
      try { git('.', 'ls-remote', '--exit-code', '--heads', 'origin', 'data'); } catch { exists = false; }
      if (exists) {
        git('.', 'fetch', '--depth=1', 'origin', '+refs/heads/data:refs/remotes/origin/data');
        git('.', 'worktree', 'add', '--detach', dir, 'origin/data');
      } else {
        // data ブランチを新しく作る。main とは履歴を共有しない
        git('.', 'worktree', 'add', '--detach', dir, 'HEAD');
        git(dir, 'checkout', '--orphan', 'data-new');
        git(dir, 'rm', '-rf', '-q', '.');
      }
      const target = path.join(dir, 'runs', 'publish.json');
      const prev = existsSync(target) ? JSON.parse(await readFile(target, 'utf8')) : { history: [] };
      const next = { last: result, history: [result, ...(prev.history || [])].slice(0, HISTORY) };
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, `${JSON.stringify(next, null, 2)}\n`);
      git(dir, 'add', 'runs/publish.json');
      git(dir, ...BOT, 'commit', '-q', '-m', `data: ${result.ok ? 'record' : 'record failed'} ${result.target || 'publish'}`);
      git(dir, 'push', '-q', 'origin', 'HEAD:refs/heads/data');
      console.log('data ブランチの runs/publish.json に記録しました。');
      return;
    } catch (e) {
      if (attempt === 3) throw e;
      console.log(`data ブランチへの書き込みをやり直します（${attempt}回目）`);
    } finally {
      try { git('.', 'worktree', 'remove', '--force', dir); } catch { await rm(dir, { recursive: true, force: true }); }
    }
  }
}

async function gh(method, endpoint, body) {
  const r = await fetch(`https://api.github.com/repos/${REPO}${endpoint}`, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok && r.status !== 422) throw new Error(`GitHub API ${method} ${endpoint} → HTTP ${r.status}`);
  return r.status === 204 ? null : r.json().catch(() => null);
}

/** 失敗は Issue で知らせる。成功したら開いている Issue を閉じる */
async function notify() {
  if (!REPO || !TOKEN) return warn('GITHUB_TOKEN が無いので Issue での通知は飛ばしました');
  const open = (await gh('GET', `/issues?state=open&labels=${LABEL}&per_page=5`)) || [];
  if (result.ok) {
    if (result.skipped) return;
    for (const i of open) {
      await gh('POST', `/issues/${i.number}/comments`, { body: `次の投稿（${result.target}）は成功しました。閉じます。\n\n${RUN_URL || ''}` });
      await gh('PATCH', `/issues/${i.number}`, { state: 'closed', state_reason: 'completed' });
    }
    return;
  }
  const { cause, action } = diagnose(result.error);
  const body = [
    `**${result.target || 'リール'}** の投稿に失敗しました。**投稿はされていません。**`,
    '',
    `- 原因：${cause}`,
    `- 対処：${action}`,
    `- メッセージ：\`${(result.error || '').replace(/`/g, "'")}\``,
    RUN_URL ? `- ログ：${RUN_URL}` : null,
    '',
    '直したら Actions の auto-publish-reel を手動で実行すると、すぐに出し直せます（時間帯の判定は飛ばされます）。',
  ].filter((x) => x !== null).join('\n');
  if (open.length) {
    await gh('POST', `/issues/${open[0].number}/comments`, { body });
    console.log(`Issue #${open[0].number} にコメントを足しました。`);
  } else {
    await gh('POST', '/labels', { name: LABEL, color: 'd03b3b', description: '自動投稿の失敗（record-run.mjs が作る）' });
    const i = await gh('POST', '/issues', { title: 'リール投稿エラー', body, labels: [LABEL] });
    console.log(`Issue #${i?.number} を作りました。`);
  }
}

try { await recordToDataBranch(); } catch (e) { warn(`data ブランチに記録できませんでした: ${e.message}`); }
try { await notify(); } catch (e) { warn(`Issue で知らせられませんでした: ${e.message}`); }
