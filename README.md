# ASOBU Instagram Drafts（新パイプライン）

遊部（ASOBU）のInstagram投稿カードを **クラウド（GitHub Actions）で自動生成** する。
PCがオフでも、GitHub上でカード画像（**1080×1350 PNG**・確定デザイン）とキャプションが作られ、
**GitHub Pages** のページに並ぶ。スマホでそのURLを開いて画像保存＋キャプションコピー → Instagramで手動投稿。

デザイン仕様は作業場の `research/asobu-team/sns/card-design.md` に準拠（クリーム地＋二重フレーム／3レイアウト cover・qa・single）。

## スマホでの使い方

1. `https://keikei9393keikei-ship-it.github.io/asobu-instagram-drafts-/` を開く（初回ビルド後に有効）
2. 投稿日を選ぶ
3. 画像を長押しで保存 ＋「キャプションをコピー」
4. Instagramアプリで投稿（日時指定 or その場で）

## 投稿を追加・編集する（PCがオンのとき）

1. `weeks/<投稿日 YYYY-MM-DD>/` を作る
   - `cards.json` … カード定義（`card-design.md` のスキーマ。`layout` = `cover` / `qa` / `single`）
   - `caption.txt` … 貼り付け用キャプション（頭「こんにちは！…」＋締め＋固定ハッシュタグ入り）
2. `git add -A && git commit -m "add 9/8" && git push`
3. GitHub Actions が走り、Pages が更新される（毎週日曜22:00 JSTにも自動再ビルド）

## 初期設定（1回だけ）

GitHub リポジトリの **Settings → Pages → Build and deployment → Source = "GitHub Actions"**

## ローカル確認（任意）

```
npm install
npx playwright install chromium
npm run render
# dist/index.html をブラウザで開く
```

## 構成

| ファイル | 役割 |
|---|---|
| `template.html` | カードの見た目。`window.renderCards(cards)` を持つ |
| `render.mjs` | Playwright で各カードを 1080×1350 PNG 化、Pages用サイトを `dist/` に生成 |
| `.github/workflows/build.yml` | ビルド＆Pagesデプロイ |
| `weeks/<日付>/` | 投稿ごとの `cards.json` ＋ `caption.txt` |
| `drafts/2026-08-*` | 旧パイプラインが生成した過去ドラフト（保管） |
| `legacy/` | 旧パイプライン（Python/Pillow・毎日生成）。停止済み。参照用に保管 |
