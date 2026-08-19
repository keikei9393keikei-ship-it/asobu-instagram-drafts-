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
    parser.add_argument("--date", dest="target_date", help="Target date in YYYY-MM-DD. Defaults to today's date in Asia/Tokyo.")
    parser.add_argument("--force", action="store_true", help="Overwrite generated files if the target draft folder already exists.")
    return parser.parse_args()


def get_target_date(value: str | None) -> date:
    return date.fromisoformat(value) if value else datetime.now(ZoneInfo("Asia/Tokyo")).date()


def write_text(path: Path, text: str, force: bool) -> None:
    if path.exists() and not force:
        raise FileExistsError(f"{path} already exists. Use --force to overwrite it.")
    path.write_text(text, encoding="utf-8")


def bullet_lines(values: list[str]) -> str:
    return "\n".join(f"・{value}" for value in values)


def main() -> None:
    args = parse_args()
    target = get_target_date(args.target_date)
    topics = json.loads(TOPICS_PATH.read_text(encoding="utf-8"))
    brand = json.loads(BRAND_PATH.read_text(encoding="utf-8"))

    topic = topics[target.toordinal() % len(topics)]
    output_dir = DRAFTS_DIR / target.isoformat()
    output_dir.mkdir(parents=True, exist_ok=True)

    title = topic["title"]
    outline = topic.get("caption_outline") or topic["slides"][1:6]
    hashtags = topic.get("hashtags") or brand["base_hashtags"]
    hashtag_line = " ".join(hashtags)
    plan = topic.get("carousel_plan", [])

    caption = f"""{title}

{topic['caption_body']}

【画像ごとに紹介していること】
{bullet_lines(outline)}

【参加前の基本情報】
📍 会場：{brand['primary_venue']}
🕒 時間：{brand['activity_time']}を中心に活動
💰 参加費：{brand['participation_fee']}
🏸 道具：ラケット・シャトルは無料で貸し出し

【参加方法】
次回日程と参加方法はプロフィールのリンクからご確認ください。
一人参加や初心者の方も、気になることがあればDMで事前にご相談いただけます。

{hashtag_line}
"""

    carousel_copy_lines = [
        f"# カルーセル内容｜{title}",
        "",
        "このファイルは自動生成画像7枚の内容確認用です。画像を修正・差し替える場合にも、この順序を基準にしてください。",
        "",
    ]
    for index, slide in enumerate(plan, start=1):
        page_type = slide.get("page_type", "point")
        carousel_copy_lines.extend([f"## {index}枚目｜{page_type}"])
        for key, value in slide.items():
            if key == "page_type":
                continue
            if isinstance(value, list):
                carousel_copy_lines.append(f"**{key}：**")
                carousel_copy_lines.extend(f"- {item}" if isinstance(item, str) else f"- {'｜'.join(item)}" for item in value)
            else:
                carousel_copy_lines.append(f"**{key}：** {value}")
        carousel_copy_lines.append("")
    carousel_copy = "\n".join(carousel_copy_lines)

    image_brief = f"""# 自動生成画像の確認｜{title}

**保存先：** `images/`  
**形式：** 正方形1080×1080pxのPNG画像7枚、およびZIPファイル  
**構成：** 1枚目は表紙、2〜5枚目はテーマ別の詳細、6枚目は参加前の基本情報、7枚目は参加導線です。  
**固定配色：** ダークグリーン、アイボリー、ライムグリーン、控えめなイエロー。

## 投稿前の手順

1. `images/01.png`から`images/07.png`までをページ順に確認する。
2. 画像6枚目の会場・時間・参加費と、当日の実態が一致するか`checklist.md`で確認する。
3. `images/ASOBU_{target.isoformat()}_carousel.zip`をダウンロードして解凍する。
4. Instagramアプリで画像7枚を順に選択し、`caption.md`の本文を貼り付ける。
5. 当日の事実と合わない場合は、投稿を見送るか、該当箇所を修正してから投稿する。
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
- [ ] 7枚の画像が「表紙 → 詳細ポイント → 基本情報 → 参加導線」の順になっている。
- [ ] `caption.md`の「画像ごとに紹介していること」と画像2〜6枚目の内容が一致している。
- [ ] ハッシュタグが投稿テーマと地域に合っている。
- [ ] 『バトミントン』の誤表記がない。

## 投稿後

- [ ] 実際の投稿日・URL・反応を`published/{target.isoformat()}.md`へ記録する。
"""

    readme = f"""# {target.isoformat()} の投稿下書き

このフォルダには、今日のInstagram投稿を確認して手動投稿するための原稿と完成画像一式があります。

| ファイル | 内容 |
|---|---|
| `caption.md` | Instagramへ貼り付ける本文とテーマ別ハッシュタグ |
| `carousel-copy.md` | 7枚の画像に載せた情報の確認用原稿 |
| `image-brief.md` | 自動生成画像の確認と投稿手順 |
| `images/` | Instagram用PNG画像7枚、ZIPファイル、生成一覧 |
| `checklist.md` | 事実確認と投稿前後の確認項目 |

**今日のテーマ：** {title}
"""

    write_text(output_dir / "caption.md", caption, args.force)
    write_text(output_dir / "carousel-copy.md", carousel_copy, args.force)
    write_text(output_dir / "image-brief.md", image_brief, args.force)
    write_text(output_dir / "checklist.md", checklist, args.force)
    write_text(output_dir / "README.md", readme, args.force)
    render_carousel(output_dir, topic, brand, target.isoformat())
    print(f"Created draft and images: {output_dir.relative_to(ROOT)} ({topic['id']})")


if __name__ == "__main__":
    main()
