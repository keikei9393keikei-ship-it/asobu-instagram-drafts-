# ASOBU Instagram Drafts

ASOBUのInstagram投稿を、毎日日本時間8:00にGitHubへ下書き保存するためのリポジトリです。Instagramへの投稿は自動化せず、内容を確認したうえでCanvaとInstagramアプリから手動で行います。

## 毎日の流れ

1. `drafts/YYYY-MM-DD/README.md`を開く。
2. `caption.md`でキャプションとハッシュタグを確認する。
3. Canvaで「ASOBU｜初心者ガイド型」テンプレートを複製する。
4. `canva-copy.md`の7枚分の文言を貼り替える。
5. `image-brief.md`に従って画像を選び、PNGで書き出す。
6. `checklist.md`で会場、時間、費用、リンク先、写真掲載許可を確認する。
7. Instagramアプリから手動で投稿し、必要に応じて`published/`に記録する。

## Canvaで最初に準備するテンプレート

| テンプレート名 | サイズ・ページ数 | 用途 | 固定する要素 |
|---|---|---|---|
| ASOBU｜初心者ガイド型 | 1080×1080px・7ページ | 初心者、一人参加、持ち物、料金、FAQ | 緑・アイボリー・ライム・黄色の配色、ASOBU名、ラケット・シャトルの装飾、最終ページのCTA |
| ASOBU｜日程型 | 1080×1080px・3〜5ページ | 最新日程、会場、参加方法 | 配色、ASOBU名、プロフィールリンクへのCTA |
| ASOBU｜活動レポート型 | 1080×1080px・3〜5ページ | 活動の雰囲気、準備、許可済み写真 | 配色、ASOBU名、次回案内のCTA |

## 手動実行

GitHubの **Actions** 画面から「Create daily ASOBU Instagram draft」を開き、**Run workflow**を押すと、その場で下書きを作れます。指定日で作り直す必要がある場合は`target_date`に`YYYY-MM-DD`を入れて実行します。

## 運用上の注意

投稿前に、会場、時間、参加費、参加方法が当日の情報と一致することを確認してください。参加者が識別できる写真を使う場合は、事前に掲載許可を得てください。投稿の効果を見ながら、`content-library/topics.json`のテーマや文章はいつでも更新できます。
