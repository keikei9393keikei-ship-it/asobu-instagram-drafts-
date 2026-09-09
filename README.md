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

## Instagramへの半自動投稿

Actions から手動で実行すると、Pages上の画像URLを使って Instagram に投稿する。
**自動では動かない。**必ず自分でボタンを押す。

### 初期設定（1回だけ）

1. Instagramを**プロアカウント**にする（ビジネス or クリエイター）
2. Meta for Developers でアプリを作り、Instagram の製品を追加。
   `instagram_business_basic` と `instagram_business_content_publish` を含むアクセストークンを取得する
3. リポジトリの **Settings → Secrets and variables → Actions** に登録
   - Secrets: `IG_USER_ID`（InstagramのユーザーID）、`IG_ACCESS_TOKEN`（アクセストークン）
   - Variables（任意）: `PAGES_BASE_URL`、`IG_API_VERSION`（Metaが版を廃止したときに上げる）

### 投稿のしかた

1. `weeks/<日付>/` を push して **build-cards** が成功し、Pages に画像が並んでいることを確認
2. **Actions → publish-instagram → Run workflow**
3. `week` にフォルダ名（例 `2026-09-10`）、`mode` は **まず `check`**
   → 画像URLが全部ひらけるか、キャプション、ハッシュタグ数、会場名が残っていないかを確認できる
4. 問題なければ同じ手順で `mode` を **`publish`** にして実行 → 投稿される

### 制限

- カルーセルは最大10枚、キャプション2200文字、ハッシュタグ30個まで（`check` が事前に弾く）
- 1日に投稿できる本数に上限がある（100件程度）
- **予約投稿はAPIにない。**実行した時点で投稿される
- リール（動画）は動画の公開URLが必要で、GitHubは動画置き場に向かないため対象外。手動投稿のまま

## 構成

| ファイル | 役割 |
|---|---|
| `template.html` | カードの見た目。`window.renderCards(cards)` を持つ |
| `render.mjs` | Playwright で各カードを 1080×1350 PNG 化、Pages用サイトを `dist/` に生成 |
| `.github/workflows/build.yml` | ビルド＆Pagesデプロイ |
| `publish.mjs` | Pages上の画像URLを使って Instagram に投稿（手動実行） |
| `.github/workflows/publish.yml` | 上記を Actions から手動実行するためのワークフロー |
| `weeks/<日付>/` | 投稿ごとの `cards.json` ＋ `caption.txt` |
| `drafts/2026-08-*` | 旧パイプラインが生成した過去ドラフト（保管） |
| `legacy/` | 旧パイプライン（Python/Pillow・毎日生成）。停止済み。参照用に保管 |
