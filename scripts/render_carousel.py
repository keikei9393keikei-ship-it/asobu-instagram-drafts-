#!/usr/bin/env python3
"""Render an information-rich seven-slide ASOBU Instagram carousel."""

from __future__ import annotations

import json
import zipfile
from pathlib import Path
from typing import Any, Iterable

from PIL import Image, ImageDraw, ImageFont

SIZE = 1080
COLORS = {
    "green": "#146B5E",
    "cream": "#FFF8E8",
    "lime": "#B8D958",
    "yellow": "#FFD35C",
    "dark": "#12483F",
    "white": "#FFFFFF",
    "muted": "#E7F0D7",
}
FONT_REGULAR = "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"
FONT_BOLD = "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc"


def font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(FONT_BOLD if bold else FONT_REGULAR, size, index=0)


def wrap_japanese(text: str, max_chars: int) -> str:
    """Wrap Japanese copy predictably without depending on browser layout."""
    normalized = "".join(str(text).replace("\n", " ").split())
    if not normalized:
        return ""
    lines: list[str] = []
    current = ""
    for char in normalized:
        current += char
        if len(current) >= max_chars:
            if char in "、。！？｜・":
                continue
            lines.append(current)
            current = ""
    if current:
        lines.append(current)
    return "\n".join(lines)


def fit_text(
    draw: ImageDraw.ImageDraw,
    box: tuple[int, int, int, int],
    text: str,
    size: int,
    fill: str,
    *,
    bold: bool = True,
    spacing: int = 10,
    align: str = "left",
    min_size: int = 22,
) -> None:
    left, top, right, bottom = box
    available_width, available_height = right - left, bottom - top
    current = size
    while current >= min_size:
        chosen = font(current, bold)
        bbox = draw.multiline_textbbox((0, 0), text, font=chosen, spacing=spacing, align=align)
        width, height = bbox[2] - bbox[0], bbox[3] - bbox[1]
        if width <= available_width and height <= available_height:
            if align == "center":
                x = left + (available_width - width) / 2
            elif align == "right":
                x = right - width
            else:
                x = left
            y = top + (available_height - height) / 2
            draw.multiline_text((x, y), text, font=chosen, fill=fill, spacing=spacing, align=align)
            return
        current -= 2
    draw.multiline_text((left, top), text, font=font(min_size, bold), fill=fill, spacing=spacing, align=align)


def rounded_card(
    draw: ImageDraw.ImageDraw,
    box: tuple[int, int, int, int],
    *,
    fill: str = COLORS["white"],
    outline: str | None = None,
    radius: int = 28,
    width: int = 3,
) -> None:
    draw.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width if outline else 1)


def pill(draw: ImageDraw.ImageDraw, text: str, x: int, y: int, *, fill: str = COLORS["lime"], text_color: str = COLORS["dark"]) -> None:
    chosen = font(27, True)
    bbox = draw.textbbox((0, 0), text, font=chosen)
    width = bbox[2] - bbox[0]
    draw.rounded_rectangle((x, y, x + width + 44, y + 58), radius=29, fill=fill)
    draw.text((x + 22, y + 29), text, font=chosen, fill=text_color, anchor="lm")


def page_marker(draw: ImageDraw.ImageDraw, index: int) -> None:
    draw.text((950, 82), f"{index:02d} / 07", font=font(27, True), fill=COLORS["green"], anchor="rm")
    for item in range(7):
        x = 412 + item * 34
        fill = COLORS["green"] if item == index - 1 else COLORS["muted"]
        draw.ellipse((x, 1000, x + 16, 1016), fill=fill)


def racket(draw: ImageDraw.ImageDraw, x: int, y: int, scale: float = 1.0, flip: bool = False) -> None:
    head_w, head_h = int(120 * scale), int(175 * scale)
    handle_w, handle_h = int(22 * scale), int(150 * scale)
    if flip:
        x = SIZE - x - head_w
    draw.ellipse((x, y, x + head_w, y + head_h), outline=COLORS["green"], width=max(3, int(7 * scale)))
    for offset in range(20, head_w, 20):
        draw.line((x + offset, y + 18, x + offset - 20, y + head_h - 18), fill=COLORS["lime"], width=max(1, int(2 * scale)))
    for offset in range(25, head_h, 25):
        draw.line((x + 12, y + offset, x + head_w - 12, y + offset), fill=COLORS["lime"], width=max(1, int(2 * scale)))
    center = x + head_w / 2
    end_x = center + (-22 if flip else 22)
    draw.line((center, y + head_h - 8, end_x, y + head_h + handle_h), fill=COLORS["green"], width=max(8, int(handle_w)))
    draw.rounded_rectangle((end_x - handle_w, y + head_h + handle_h - 40, end_x + handle_w, y + head_h + handle_h + 8), radius=9, fill=COLORS["lime"])


def shuttle(draw: ImageDraw.ImageDraw, x: int, y: int, scale: float = 1.0) -> None:
    width, height = int(90 * scale), int(120 * scale)
    for item in range(5):
        start_x = x + int((item + 0.5) * width / 5)
        draw.line((x + width // 2, y + height - 24, start_x, y + 12), fill=COLORS["green"], width=max(2, int(3 * scale)))
    draw.arc((x, y, x + width, y + height - 30), 200, 340, fill=COLORS["green"], width=max(3, int(4 * scale)))
    draw.ellipse((x + width // 2 - 24, y + height - 40, x + width // 2 + 24, y + height + 8), fill=COLORS["yellow"], outline=COLORS["green"], width=max(2, int(3 * scale)))


def base_slide(index: int) -> tuple[Image.Image, ImageDraw.ImageDraw]:
    image = Image.new("RGB", (SIZE, SIZE), COLORS["green"])
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((34, 34, SIZE - 34, SIZE - 34), radius=50, fill=COLORS["cream"])
    if index % 2:
        draw.pieslice((-220, 770, 250, 1240), 185, 355, fill=COLORS["lime"])
        draw.pieslice((820, -170, 1260, 280), 10, 175, fill=COLORS["yellow"])
    else:
        draw.pieslice((-130, -120, 300, 300), 190, 350, fill=COLORS["yellow"])
        draw.pieslice((805, 770, 1280, 1250), 0, 175, fill=COLORS["lime"])
    return image, draw


def draw_header(draw: ImageDraw.ImageDraw, brand: dict[str, Any], index: int, kicker: str) -> None:
    draw.text((126, 84), f"{brand['club_name']}｜{brand['city']}", font=font(26, True), fill=COLORS["green"], anchor="lm")
    page_marker(draw, index)
    pill(draw, kicker, 120, 130)


def draw_cover(draw: ImageDraw.ImageDraw, slide: dict[str, Any], brand: dict[str, Any], index: int) -> None:
    draw_header(draw, brand, index, str(slide.get("kicker", "ASOBU GUIDE")))
    headline = str(slide.get("headline", ""))
    fit_text(draw, (115, 270, 965, 500), headline, 86, COLORS["green"], spacing=16, align="center")
    rounded_card(draw, (130, 555, 950, 720), fill=COLORS["white"], outline=COLORS["muted"], radius=30)
    fit_text(draw, (180, 585, 900, 670), wrap_japanese(str(slide.get("summary", "")), 21), 35, COLORS["dark"], bold=False, spacing=8, align="center")
    draw.text((SIZE / 2, 780), str(slide.get("footer", "7枚で参加前のポイントを確認")), font=font(31, True), fill=COLORS["green"], anchor="mm")
    draw.text((SIZE / 2, 870), "SWIPE  ▶", font=font(39, True), fill=COLORS["green"], anchor="mm")
    racket(draw, 55, 720, 0.65)
    shuttle(draw, 868, 710, 0.9)


def draw_point(draw: ImageDraw.ImageDraw, slide: dict[str, Any], brand: dict[str, Any], index: int) -> None:
    number = int(slide.get("number", index - 1))
    draw_header(draw, brand, index, f"POINT {number}")
    fit_text(draw, (120, 245, 960, 430), str(slide.get("headline", "")), 72, COLORS["green"], spacing=14, align="center")
    rounded_card(draw, (110, 480, 970, 650), fill=COLORS["white"], outline=COLORS["muted"])
    fit_text(draw, (160, 510, 920, 603), wrap_japanese(str(slide.get("detail", "")), 25), 31, COLORS["dark"], bold=False, spacing=7, align="center")
    rounded_card(draw, (120, 704, 960, 862), fill=COLORS["green"], radius=28)
    draw.text((165, 747), str(slide.get("fact_label", "POINT")), font=font(25, True), fill=COLORS["lime"], anchor="lm")
    fit_text(draw, (165, 764, 900, 836), wrap_japanese(str(slide.get("fact_value", "")), 22), 39, COLORS["white"], spacing=6, align="left")
    microcopy = wrap_japanese(str(slide.get("microcopy", "")), 30)
    fit_text(draw, (155, 895, 925, 960), microcopy, 25, COLORS["green"], bold=False, spacing=5, align="center")


def draw_info(draw: ImageDraw.ImageDraw, slide: dict[str, Any], brand: dict[str, Any], index: int) -> None:
    draw_header(draw, brand, index, "BASIC INFO")
    fit_text(draw, (135, 235, 945, 375), str(slide.get("headline", "参加前の基本情報")), 60, COLORS["green"], spacing=11, align="center")
    facts = slide.get("facts", [])
    cards = [(120, 430, 505, 600), (575, 430, 960, 600), (120, 640, 505, 810), (575, 640, 960, 810)]
    for card, fact in zip(cards, facts):
        label, value = fact
        rounded_card(draw, card, fill=COLORS["white"], outline=COLORS["muted"], radius=24)
        draw.text((card[0] + 32, card[1] + 35), str(label), font=font(24, True), fill=COLORS["green"], anchor="la")
        fit_text(draw, (card[0] + 32, card[1] + 70, card[2] - 28, card[3] - 28), wrap_japanese(str(value), 14), 32, COLORS["dark"], spacing=6, align="left")
    rounded_card(draw, (120, 860, 960, 945), fill=COLORS["yellow"], radius=24)
    fit_text(draw, (155, 878, 925, 928), wrap_japanese(str(slide.get("note", "")), 30), 23, COLORS["dark"], bold=False, spacing=4, align="center")


def draw_cta(draw: ImageDraw.ImageDraw, slide: dict[str, Any], brand: dict[str, Any], index: int) -> None:
    draw_header(draw, brand, index, "NEXT STEP")
    fit_text(draw, (130, 240, 950, 410), str(slide.get("headline", "次回日程はプロフィールから")), 68, COLORS["green"], spacing=13, align="center")
    for offset, step in enumerate(slide.get("steps", [])):
        top = 485 + offset * 120
        rounded_card(draw, (140, top, 940, top + 92), fill=COLORS["white"], outline=COLORS["muted"], radius=22)
        draw.text((180, top + 46), str(step), font=font(31, True), fill=COLORS["dark"], anchor="lm")
    draw.rounded_rectangle((150, 862, 930, 950), radius=30, fill=COLORS["green"])
    draw.text((SIZE / 2, 906), str(slide.get("footer", "初心者・一人参加歓迎")), font=font(36, True), fill=COLORS["white"], anchor="mm")
    shuttle(draw, 75, 780, 0.75)
    racket(draw, 900, 750, 0.58, flip=True)


def legacy_plan(topic: dict[str, Any]) -> list[dict[str, Any]]:
    slides = list(topic.get("slides", []))
    return [
        {"page_type": "cover", "kicker": topic.get("pillar", "ASOBU GUIDE"), "headline": slides[0], "summary": topic.get("caption_body", ""), "footer": "7枚で参加前のポイントを確認"},
        *[
            {"page_type": "point", "number": index - 1, "headline": slide, "detail": topic.get("caption_body", ""), "microcopy": "参加前の質問はDMで相談できます。", "fact_label": "ASOBU", "fact_value": "初心者・一人参加歓迎"}
            for index, slide in enumerate(slides[1:5], start=2)
        ],
        {"page_type": "info", "headline": slides[5], "facts": [["活動", "土日 19:00〜21:00"], ["会場", "主に松下体育館"], ["費用", "1回600円"], ["貸出", "ラケット・シャトル無料"]], "note": "最新日程はプロフィールで確認してください。"},
        {"page_type": "cta", "headline": slides[6], "steps": ["1｜プロフィールで最新日程を確認", "2｜都合のよい日を選ぶ", "3｜質問はDMで気軽に相談"], "footer": "初心者・一人参加歓迎"},
    ]


def make_slide(index: int, slide: dict[str, Any], brand: dict[str, Any]) -> Image.Image:
    image, draw = base_slide(index)
    page_type = slide.get("page_type", "point")
    if page_type == "cover":
        draw_cover(draw, slide, brand, index)
    elif page_type == "info":
        draw_info(draw, slide, brand, index)
    elif page_type == "cta":
        draw_cta(draw, slide, brand, index)
    else:
        draw_point(draw, slide, brand, index)
    return image


def render_carousel(output_dir: Path, topic: dict[str, Any], brand: dict[str, Any], target_date: str) -> list[Path]:
    images_dir = output_dir / "images"
    images_dir.mkdir(parents=True, exist_ok=True)
    slides: Iterable[dict[str, Any]] = topic.get("carousel_plan") or legacy_plan(topic)
    result: list[Path] = []
    for index, slide in enumerate(slides, start=1):
        path = images_dir / f"{index:02d}.png"
        make_slide(index, slide, brand).save(path, format="PNG", optimize=True)
        result.append(path)

    archive = images_dir / f"ASOBU_{target_date}_carousel.zip"
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as zipped:
        for path in result:
            zipped.write(path, path.name)

    manifest = {
        "title": topic["title"],
        "date": target_date,
        "files": [path.name for path in result],
        "archive": archive.name,
        "layout_version": "information-card-v2",
        "note": "投稿前にcaption.mdとchecklist.mdを確認してください。",
    }
    (images_dir / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    return result
