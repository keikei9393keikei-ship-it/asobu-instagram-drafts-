# ASOBU Instagram Drafts

ASOBUのInstagram投稿を、毎日日本時間8:00にGitHubへ自動保存するためのリポジトリです。日替わりの投稿テーマ、キャプション、チェックリストに加え、Instagram向けの正方形PNG画像7枚を自動生成します。Instagramへの最終投稿だけは、内容を確認したうえで手動で行います。

## 毎日の流れ

1. `drafts/YYYY-MM-DD/README.md`を開く。
2. `caption.md`で本文・ハッシュタグを確認する。
3. `checklist.md`で会場、時間、費用、リンク先が当日の情報と一致するか確認する。
4. `images/ASOBU_YYYY-MM-DD_carousel.zip`をダウンロードして解凍する。
5. `images/01.png`から`images/07.png`までを順に確認する。文字を変えたい場合だけ、`canva-copy.md`を参考にCanvaで調整する。
6. InstagramアプリでPNG画像7枚を順に選び、`caption.md`の本文を貼り付けて手動投稿する。
7. 必要に応じて、実際の投稿日・URL・反応を`published/`に記録する。

## 自動生成されるもの

| 保存場所 | 内容 |
|---|---|
| `drafts/YYYY-MM-DD/caption.md` | キャプションとハッシュタグ |
| `drafts/YYYY-MM-DD/checklist.md` | 会場、時間、料金、写真などの投稿前確認 |
| `drafts/YYYY-MM-DD/images/01.png`〜`07.png` | Instagramカルーセル用の1080×1080px完成画像 |
| `drafts/YYYY-MM-DD/images/ASOBU_YYYY-MM-DD_carousel.zip` | 投稿用画像7枚をまとめたZIPファイル |
| `drafts/YYYY-MM-DD/canva-copy.md` | Canvaで手動編集したい場合のページ別文言 |

## 手動実行

GitHubの **Actions** 画面から「Create daily ASOBU Instagram draft」を開き、**Run workflow**を押すと、その場で下書きと画像を作れます。指定日で作り直す必要がある場合は`target_date`に`YYYY-MM-DD`を入れて実行します。

## 運用上の注意

投稿前に、会場、時間、参加費、参加方法が当日の情報と一致することを確認してください。参加者が識別できる写真を使う場合は、事前に掲載許可を得てください。画像は定型デザインとして自動生成されるため、活動写真を使いたい場合だけCanvaで写真を追加してください。投稿の効果を見ながら、`content-library/topics.json`のテーマや文章はいつでも更新できます。
