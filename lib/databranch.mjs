// lib/databranch.mjs — data ブランチ（ボット専用・main と履歴を共有しない）にファイルを書く
//
// record-run.mjs（投稿の結果）と fetch-metrics.mjs（投稿後の数字）が使う。
// Actions の checkout が持っている認証で push する。ほかの実行と重なったら取り直して3回まで試す。

import { mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

const BOT = ['-c', 'user.name=github-actions[bot]', '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com'];
const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();

/**
 * data ブランチを作業用の場所に取り出し、update(dir) で書き換えてから push する。
 * update は書き換えたファイルのパス（dir からの相対）を返す。空なら何もしない。
 * @param {(dir: string) => Promise<string[]>} update
 * @param {string} message コミットメッセージ
 * @returns {Promise<boolean>} 何か書いたか
 */
export async function writeDataBranch(update, message) {
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
      const changed = await update(dir);
      if (!changed.length) return false;
      git(dir, 'add', ...changed);
      if (!git(dir, 'status', '--porcelain')) return false; // 中身が同じなら何もしない
      git(dir, ...BOT, 'commit', '-q', '-m', message);
      git(dir, 'push', '-q', 'origin', 'HEAD:refs/heads/data');
      return true;
    } catch (e) {
      if (attempt === 3) throw e;
      console.log(`data ブランチへの書き込みをやり直します（${attempt}回目）`);
    } finally {
      try { git('.', 'worktree', 'remove', '--force', dir); } catch { await rm(dir, { recursive: true, force: true }); }
    }
  }
  return false;
}
