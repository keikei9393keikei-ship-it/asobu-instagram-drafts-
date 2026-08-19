#!/usr/bin/env python3
"""Create one ASOBU Instagram draft from the rotating local topic library."""

from __future__ import annotations

import argparse
import json
from datetime import date, datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from render_carousel import render_carousel

ROOT = Path(__file__).resolve().parents[1]
TOPICS_PATH = ROOT / "content-library" / "topics.json"
BRAND_PATH = ROOT / "config" / "brand.json"
DRAFTS_DIR = ROOT / "drafts"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Create a daily ASOBU Instagram draft")
    parser.add_argument(
        "--date",
        dest="target_date",
        help="Target date in YYYY-MM-DD. Defaults to today's date in Asia/Tokyo.",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Overwrite the generated files if the target draft folder already exists.",
    )
    return parser.parse_args()


def get_target_date(value: str | None) -> date:
    if value:
        return date.fromisoformat(value)
    return datetime.now(ZoneInfo("Asia/Tokyo")).date()


def write_text(path: Path, text: str, force: bool) -> None:
    if path.exists() and not force:
        raise FileExistsError(f"{path} already exists. Use --force to overwrite it.")
    path.write_text(text, encoding="utf-8")


def main() -> None:
    args = parse_args()
    target = get_target_date(args.target_date)
    topics = json.loads(TOPICS_PATH.read_text(encoding="utf-8"))
    brand = json.loads(BRAND_PATH.read_text(encoding="utf-8"))

    # The rotation is reproducible and independent of workflow run timing.
    topic = topics[target.toordinal() % len(topics)]
    output_dir = DRAFTS_DIR / target.isoformat()
    output_dir.mkdir(parents=True, exist_ok=True)

    hashtags = " ".join(brand["base_hashtags"])
    title = topic["title"]
    slides = topic["slides"]

    caption = f"""# {title}

**作成日：** {target.isoformat()}  
**テーマ：** {topic['pillar']}  
**投稿形式：** 自動生成された7枚のInstagramカルーセル

{topic['caption_body']}

{brand['city']}で、{brand['activity_time']}を中心に活動しています。{brand['primary_venue']}です。参加費は{brand['participation_fee']}。ラケットとシャトルは無料で貸し出しています。

次回日程と参加方法はプロフィールのリンクからご確認ください。参加前の質問はDMでも大丈夫です。

{hashtags}
"""

    canva_copy_lines = [
        f"# Canva用テキスト｜{title}",
        "",
        "**使い方：** Canvaの『ASOBU｜初心者ガイド型』テンプレートを複製し、各ページの見出しだけを下の文言に差し替えます。色・フォント・ロゴ・CTA位置は変えません。",
        "",
    ]
    for index, slide in enumerate(slides, start=1):
        canva_copy_lines.extend([f"## {index}枚目", slide, ""])
    canva_copy = "\n".join(canva_copy_lines)

    image_brief = f"""# 自動生成画像の確認｜{title}

**保存先：** `images/`  
**形式：** 正方形1080×1080pxのPNG画像7枚、およびZIPファイル  
**デザイン方針：** {topic['visual_direction']}  
**固定配色：** ダークグリーン、アイボリー、ライムグリーン、控えめなイエロー。

## 投稿前の手順

1. `images/01.png`から`images/07.png`までをページ順に確認する。
2. 会場、時間、参加費、プロフィールリンク先が当日の実態と一致するか`checklist.md`で確認する。
3. `images/ASOBU_{target.isoformat()}_carousel.zip`をダウンロードして解凍する。
4. Instagramアプリで画像7枚を順に選択し、`caption.md`の本文を貼り付ける。
5. 自動生成画像の文字を変えたい場合は、`canva-copy.md`を参考にCanvaで編集し直す。
"""

    rules = "\n".join(f"- [ ] {rule}" for rule in brand["content_rules"])
    checklist = f"""# 投稿前チェックリスト｜{title}

## 事実確認

- [ ] 投稿内の会場表記が「{brand['primary_venue']}」または当日の実態に合っている。
- [ ] 投稿内の時間が「{brand['activity_time']}」または当日の実態に合っている。
- [ ] 投稿内の費用が「{brand['participation_fee']}」または当日の実態に合っている。
- [ ] プロフィールのリンク先に最新の日程・参加方法が載っている。

## 素材・文章

{rules}
- [ ] 『バトミントン』の誤表記がない。
- [ ] 1枚目に短く大きい見出しがある。
- [ ] 7枚目に「次回日程はプロフィールから」またはDMへの導線がある。

## 投稿後

- [ ] 実際の投稿日・URL・反応を`published/{target.isoformat()}.md`へ記録する。
"""

    readme = f"""# {target.isoformat()} の投稿下書き

このフォルダには、今日のInstagram投稿を確認して手動投稿するための原稿と完成画像一式があります。

| ファイル | 内容 |
|---|---|
| `caption.md` | キャプション、ハッシュタグ、投稿の意図 |
| `canva-copy.md` | 7枚のカルーセルに貼る短い文言 |
| `image-brief.md` | 自動生成画像の確認と投稿手順 |
| `images/` | Instagram用PNG画像7枚、ZIPファイル、生成一覧 |
| `checklist.md` | 事実確認と投稿前後の確認項目 |

**今日のテーマ：** {title}
"""

    write_text(output_dir / "caption.md", caption, args.force)
    write_text(output_dir / "canva-copy.md", canva_copy, args.force)
    write_text(output_dir / "image-brief.md", image_brief, args.force)
    write_text(output_dir / "checklist.md", checklist, args.force)
    write_text(output_dir / "README.md", readme, args.force)
    render_carousel(output_dir, topic, brand, target.isoformat())
    print(f"Created draft and images: {output_dir.relative_to(ROOT)} ({topic['id']})")


if __name__ == "__main__":
    main()
