// lib/diagnose.mjs — 失敗の文言から「原因と対処」を引く。秘密らしい文字列を消す。
//
// 対処の中身は CLAUDE.md §7「自動投稿が失敗したときの見かた」の表と同じ。
// ボード（status.json）と、失敗を知らせる Issue の両方がこれを使う。

/** トークンや鍵らしい文字列を伏せる。ログやボードに出す前に必ず通す */
export function redact(text) {
  return String(text ?? '')
    .replace(/(access_token=)[^&\s"']+/gi, '$1***')
    .replace(/\b(IG|EAA)[A-Za-z0-9_-]{30,}/g, '***')          // Instagram / Facebook のトークン
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}/g, '***')          // GitHub のトークン
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}/g, '***')
    .replace(/\bsk-ant-[A-Za-z0-9_-]{10,}/g, '***');          // Anthropic の鍵
}

/** 秘密らしい文字列が含まれているか（guard-public が dist/ を調べるのに使う） */
export function looksSecret(text) {
  return redact(text) !== String(text ?? '');
}

const RULES = [
  {
    re: /API access blocked|code=200\b/,
    cause: 'MetaがアプリのAPIアクセスを止めています（不正ログインの検知が多い）',
    action: 'Instagramアプリに本人確認の要求が来ていないか見て、メールと電話番号の確認をする。ログインアクティビティに覚えのない場所がないかも確かめる',
  },
  {
    re: /Session has expired|Invalid OAuth access token|code=190\b|Error validating access token/i,
    cause: 'アクセストークンの期限切れ、または無効',
    action: 'Meta for Developers でトークンを取り直し、GitHub の Secrets の IG_ACCESS_TOKEN を更新する',
  },
  {
    re: /画像URLが\d+件ひらけません|動画URLがひらけません/,
    cause: 'Pagesが未公開か、ビルドが終わっていない',
    action: 'Actions の build-cards が成功しているか確かめる。終わっていれば次の回で投稿される',
  },
  {
    re: /spawn ffmpeg ENOENT|ffmpeg: not found/,
    cause: 'ビルドのランナーに ffmpeg が入っていない（リール動画を作れない）',
    action: 'build.yml の「Install ffmpeg」の手順が消えていないか確かめる',
  },
  {
    re: /Executable doesn't exist|playwright install/,
    cause: 'Playwright のブラウザが入っていない',
    action: 'build.yml の npx playwright install の手順を確かめる',
  },
  {
    re: /体育館|会場名/,
    cause: '原稿に会場名らしき表記がある',
    action: '原稿（weeks/ か reels/）を直してPRを出す',
  },
  {
    re: /過ぎた日付/,
    cause: '原稿に過ぎた日付が入っている',
    action: '日付を直すか、投稿日を変える',
  },
  {
    re: /名乗り/,
    cause: 'キャプションの冒頭の名乗りが抜けている',
    action: 'キャプションの1行目を名乗りにする（CLAUDE.md §4 ルール6）',
  },
  {
    re: /permission|code=10\b|code=3\b/i,
    cause: 'トークンに必要な権限が足りない',
    action: 'Meta for Developers でアプリに権限を足し、トークンを取り直して IG_ACCESS_TOKEN を更新する',
  },
];

/** 失敗の文言から { cause, action } を返す。当てはまらなければ汎用の案内 */
export function diagnose(text) {
  const t = String(text ?? '');
  for (const r of RULES) if (r.re.test(t)) return { cause: r.cause, action: r.action };
  return {
    cause: '想定していない失敗',
    action: 'Actions のログで ❌ の行を読む。投稿はされていないので、慌てて直さなくてよい',
  };
}
