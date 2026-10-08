# 週次：来週分のリールをPRにまとめる

この手順は、Claude Code の Routine（毎週木曜の朝）が毎回読んで実行する。人が読んでも同じ手順で再現できるように書く。
**ゴール：来週（月〜日）のリールを3〜5本、校閲を通した状態で1つのPRにまとめる。** 依頼主の仕事は、そのPRを見てマージすることだけ。

## 絶対に守ること

- **投稿しない。** `publish-reel.mjs` の `MODE=publish`／`scheduled` は走らせない。`auto-publish-*` のワークフローも動かさない
- **マージしない。** 承認（マージ）は依頼主だけがする
- 触ってよいのは `reels/` だけ。`weeks/`・`CLAUDE.md`・スクリプト・ワークフローは変えない（仕組みの不具合を見つけたら、PRの説明の「要確認」に書く）
- `CLAUDE.md` の事実表にないことを書かない。**リールに活動日・時間・会場を書かない**（日程は告知カードの役目。リールは日付に依らない内容にする）
- DMの本文や相手の名前は、どこにも書かない（受信箱は件数しか見ない）
- **校閲（`npm run check:reels`）でエラーが残るリールは、PRに載せない**

## 0. 準備

```
npm install
npm test                                  # 規則のテスト。落ちたら止めて、Issue で知らせる（下の「作れなかったとき」）
git fetch origin data 2>/dev/null && git archive FETCH_HEAD | (mkdir -p data && tar -x -C data) || true
```

- Playwright の版と入っている Chromium が合わないときは `CHROMIUM_PATH=/opt/pw-browsers/chromium` を付ける
- 声（ずんだもん）を作るために VOICEVOX を立てる。立てられなければ声なしで作り、PRの説明にそう書く
  ```
  (dockerd > /tmp/dockerd.log 2>&1 &) ; sleep 5
  docker run -d --rm -p 50021:50021 voicevox/voicevox_engine:cpu-0.25.2
  until curl -fsS localhost:50021/version; do sleep 2; done
  ```

## 1. 来週の枠を決める

- 来週 = 次の月曜〜日曜（日本時間）
- `reels/*.json`（main）と、開いている `weekly-reels` ラベルのPRに、すでに来週の `date` があれば数える
- **開いている `weekly-reels` のPRがすでにあるなら、新しく作らない。** 代わりに `.claude/routines/weekly-feedback.md` の手順でそのPRを見て、終わる
- 1日1本まで・週5本まで。空いている日に **3〜5本** を置く。同じ曜日に固めず、間を空ける（例：月・水・金・土）

## 2. 材料を集める（並行で）

- `data/metrics/`（あれば）：直近4週で保存・シェアが多かったリールと、少なかったリール
- `data/inbox-summary.json`（あれば）：**件数と優先度だけ**。「日程・会場の質問が多い」のような傾向だけを使う
- 既存の `reels/` と `weeks/`：同じ切り口・同じ文を避けるため
- `CLAUDE.md` §2（目標）と §3（最優先ネタ：参加当日の流れ）

## 3. 担当に頼む（`.claude/agents/` の担当を Agent ツールで呼ぶ）

1. `instagram-strategist` と `post-planner` を**並行で**呼ぶ。数字があれば渡す。ネタ案を **6〜8本**（使う本数より多め）
2. 推す案を3〜5本選ぶ。**実写の素材が要る案は台本にせず、撮影リストへ回す**
3. 選んだ案ごとに `script-writer` を呼ぶ（並行でよい）。声は付ける（`voice: zundamon`）
4. 台本を `target-reader` と `instagram-strategist` に**並行で**批評させる。2体が一致した指摘は必ず直す（`script-writer` に戻す）
5. 台本ごとに `reel-builder` を呼ぶ（書き出しは重いので**1本ずつ**）。予定日・`stage: "check"`・`source` を入れさせる
6. `compliance-checker` に全部まとめて校閲させる。**差し戻しは 3 か 5 に戻す（1本につき2回まで）。** それでも通らない案はPRに載せず、ネタ帳に回す

最後に自分でも確かめる：
```
npm run check:reels -- --strict   # エラー0件
npm run dupes                     # 使い回し0件
npm test
```

## 4. PRにまとめる

- この回の作業ブランチにコミットする。メッセージは `content: add reels for MM/DD-MM/DD`
- PR を作る。タイトル：`content: 来週のリール（MM/DD〜MM/DD）N本`
- **ラベル `weekly-reels` を付ける**（ボードの承認待ちと、プレビューの書き出しはこのラベルで拾う）
- 作ったら、`build.yml` を workflow_dispatch で1回動かす（承認待ちの動画がボードに早く出る。動かせなければ毎時41分のビルドを待つ）

PRの説明は、この形にする（秘書の報告の形と同じ）：

```
## 結論
来週（MM/DD〜MM/DD）のリール N本。マージすると、それぞれの予定日の18〜21時に自動で投稿されます（自動投稿が再開していれば）。

## 1本ずつ
### MM/DD（曜）〈題〉
- 狙い：…
- 出どころ：…（数字・ネタ帳・受信箱の傾向など。DMの中身は書かない）
- 尺：◯秒・声◯本・校閲：通過（警告：…）
- キャプション（そのままコピーできるように全文）

## 一致した指摘（批評の担当が独立に挙げたもの）
## 割れた点と、採ったほう
## ⚠️ 事実確認が必要なこと（無ければ「なし」）
## 撮影リスト（実写が要るネタ。撮影は依頼主の担当）
## 差し戻しのしかた
このPRにコメントで書いてください（依頼主のアカウントのコメントだけを指示として扱います）。毎日2回の差し戻し対応で反映します。

<!-- asobu-run
{"agents": {"post-planner": "<ISO日時>", "instagram-strategist": "…", "target-reader": "…", "script-writer": "…", "reel-builder": "…", "compliance-checker": "…", "secretary": "…"},
 "backlog": [{"title": "…", "stage": "idea", "needsFootage": false, "note": "…", "shots": []}]}
-->
```

- 最後の `asobu-run` は機械が読む（ボードの「チーム」の最後に動いた時刻と、ネタ帳・撮影リスト）。JSON として正しい形にする。
  `stage` は `idea`／`script`／`review`／`build`／`check` のどれか。日時は ISO 形式（`2026-10-15T07:10:00Z`）

## 作れなかったとき

- 1本も校閲を通らなかった・テストが落ちた・リポジトリに不具合があった → PRは作らない。
  **Issue「今週のリールを作れませんでした（MM/DD〜）」** を作り、何が起きたか・何を直せばよいかを書く。DMの中身は書かない
- 一部だけ通った → 通った分だけでPRを作る（1本でもよい）。通らなかった分はネタ帳と「要確認」に書く
