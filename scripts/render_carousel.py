#!/usr/bin/env python3
"""Render a seven-slide ASOBU Instagram carousel with deterministic Japanese typography."""

from __future__ import annotations

import json
import zipfile
from pathlib import Path
from typing import Iterable

from PIL import Image, ImageDraw, ImageFont

SIZE = 1080
COLORS = {
    "green": "#146B5E",
    "cream": "#FFF8E8",
    "lime": "#B8D958",
    "yellow": "#FFD35C",
    "dark": "#12483F",
    "white": "#FFFFFF",
}
FONT_REGULAR = "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"
FONT_BOLD = "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc"


def font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont:
    path = FONT_BOLD if bold else FONT_REGULAR
    return ImageFont.truetype(path, size, index=0)


def centered_text(draw: ImageDraw.ImageDraw, box: tuple[int, int, int, int], text: str,
                  size: int, fill: str, bold: bool = True, spacing: int = 8) -> None:
    """Fit centered multiline Japanese text into a fixed box by reducing point size as needed."""
    left, top, right, bottom = box
    usable_width, usable_height = right - left, bottom - top
    current = size
    while current >= 26:
        chosen = font(current, bold)
        bbox = draw.multiline_textbbox((0, 0), text, font=chosen, spacing=spacing, align="center")
        width, height = bbox[2] - bbox[0], bbox[3] - bbox[1]
        if width <= usable_width and height <= usable_height:
            x = left + (usable_width - width) / 2
            y = top + (usable_height - height) / 2
            draw.multiline_text((x, y), text, font=chosen, fill=fill, spacing=spacing, align="center")
            return
        current -= 2
    draw.multiline_text((left, top), text, font=font(26, bold), fill=fill, spacing=spacing, align="center")


def pill(draw: ImageDraw.ImageDraw, text: str, y: int) -> None:
    fnt = font(36, True)
    box = draw.textbbox((0, 0), text, font=fnt)
    width = box[2] - box[0]
    x = (SIZE - width) // 2 - 36
    draw.rounded_rectangle((x, y, SIZE - x, y + 76), radius=38, fill=COLORS["lime"])
    draw.text((SIZE / 2, y + 38), text, font=fnt, fill=COLORS["dark"], anchor="mm")


def dots(draw: ImageDraw.ImageDraw, y: int) -> None:
    for x in range(210, 880, 34):
        draw.ellipse((x, y, x + 12, y + 12), fill=COLORS["lime"])


def racket(draw: ImageDraw.ImageDraw, x: int, y: int, scale: float = 1.0, flip: bool = False) -> None:
    """Draw a minimal, brand-safe badminton racket decoration."""
    head_w, head_h = int(120 * scale), int(175 * scale)
    handle_w, handle_h = int(22 * scale), int(150 * scale)
    if flip:
        x = SIZE - x - head_w
    draw.ellipse((x, y, x + head_w, y + head_h), outline=COLORS["green"], width=max(3, int(7 * scale)))
    for offset in range(20, head_w, 20):
        draw.line((x + offset, y + 18, x + offset - 20, y + head_h - 18), fill=COLORS["lime"], width=max(1, int(2 * scale)))
    for offset in range(25, head_h, 25):
        draw.line((x + 12, y + offset, x + head_w - 12, y + offset), fill=COLORS["lime"], width=max(1, int(2 * scale)))
    cx = x + head_w / 2
    draw.line((cx, y + head_h - 8, cx + (-22 if flip else 22), y + head_h + handle_h), fill=COLORS["green"], width=max(8, int(handle_w)))
    grip_x = cx + (-22 if flip else 22)
    draw.rounded_rectangle((grip_x - handle_w, y + head_h + handle_h - 40, grip_x + handle_w, y + head_h + handle_h + 8), radius=9, fill=COLORS["lime"])


def shuttle(draw: ImageDraw.ImageDraw, x: int, y: int, scale: float = 1.0) -> None:
    width, height = int(90 * scale), int(120 * scale)
    for i in range(5):
        start_x = x + int((i + 0.5) * width / 5)
        draw.line((x + width // 2, y + height - 24, start_x, y + 12), fill=COLORS["green"], width=max(2, int(3 * scale)))
    draw.arc((x, y, x + width, y + height - 30), 200, 340, fill=COLORS["green"], width=max(3, int(4 * scale)))
    draw.ellipse((x + width // 2 - 24, y + height - 40, x + width // 2 + 24, y + height + 8), fill=COLORS["yellow"], outline=COLORS["green"], width=max(2, int(3 * scale)))


def bird(draw: ImageDraw.ImageDraw, x: int, y: int, scale: float = 1.0) -> None:
    radius = int(42 * scale)
    draw.ellipse((x - radius, y - radius, x + radius, y + radius), fill=COLORS["yellow"], outline=COLORS["green"], width=max(2, int(3 * scale)))
    draw.ellipse((x + radius - 10, y - 18, x + radius + 38, y + 22), fill=COLORS["yellow"], outline=COLORS["green"], width=max(2, int(3 * scale)))
    draw.ellipse((x - 15, y - 12, x - 7, y - 4), fill=COLORS["dark"])
    draw.ellipse((x + 15, y - 12, x + 23, y - 4), fill=COLORS["dark"])
    draw.polygon([(x - 6, y + 6), (x + 6, y + 6), (x, y + 17)], fill=COLORS["green"])


def base_slide() -> tuple[Image.Image, ImageDraw.ImageDraw]:
    image = Image.new("RGB", (SIZE, SIZE), COLORS["green"])
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((38, 38, SIZE - 38, SIZE - 38), radius=46, fill=COLORS["cream"])
    draw.pieslice((-170, 760, 280, 1210), 185, 355, fill=COLORS["lime"])
    draw.pieslice((790, -160, 1240, 300), 10, 175, fill=COLORS["yellow"])
    return image, draw


def make_slide(index: int, text: str, title: str, brand: dict) -> Image.Image:
    image, draw = base_slide()
    lines = [line.strip() for line in text.split("\n") if line.strip()]
    is_last = index == 7

    if index == 1:
        draw.text((SIZE / 2, 132), f"{brand['club_name']}｜{brand['city']}", font=font(31, True), fill=COLORS["green"], anchor="mm")
        centered_text(draw, (145, 290, 935, 575), "\n".join(lines), 92, COLORS["green"], True, 18)
        dots(draw, 610)
        draw.text((SIZE / 2, 715), "初心者向け社会人バドミントンサークル", font=font(34, True), fill=COLORS["green"], anchor="mm")
        draw.text((810, 920), "SWIPE →", font=font(33, True), fill=COLORS["green"], anchor="mm")
        racket(draw, 25, 105, 0.70)
        shuttle(draw, 850, 160, 0.95)
        bird(draw, 820, 795, 1.2)
    elif is_last:
        draw.text((SIZE / 2, 135), f"{brand['club_name']}｜{brand['city']}", font=font(31, True), fill=COLORS["green"], anchor="mm")
        centered_text(draw, (125, 245, 955, 540), "\n".join(lines[:2]), 86, COLORS["green"], True, 18)
        dots(draw, 610)
        lower = "\n".join(lines[2:]) if len(lines) > 2 else "質問はDMへ"
        centered_text(draw, (200, 670, 880, 810), lower, 50, COLORS["green"], True, 10)
        draw.text((SIZE / 2, 890), "初心者・一人参加歓迎", font=font(38, True), fill=COLORS["green"], anchor="mm")
        racket(draw, 80, 690, 0.95)
        shuttle(draw, 860, 160, 0.9)
        bird(draw, 840, 780, 1.1)
    else:
        if index % 2 == 0:
            pill(draw, f"QUESTION {((index + 1) // 2):02d}", 108)
        else:
            pill(draw, f"ANSWER {(index // 2):02d}", 108)
        centered_text(draw, (105, 285, 975, 565), lines[0], 94, COLORS["green"], True, 14)
        dots(draw, 600)
        support = "\n".join(lines[1:])
        if support:
            centered_text(draw, (150, 660, 930, 800), support, 50, COLORS["green"], True, 10)
        draw.text((120, 920), brand['club_name'], font=font(33, True), fill=COLORS["white"], anchor="mm")
        if index % 2 == 0:
            draw.text((900, 920), "→", font=font(55, True), fill=COLORS["yellow"], anchor="mm")
        racket(draw, 785, 660, 0.78, flip=True)
        shuttle(draw, 120, 740, 0.85)
        if index in (3, 6):
            bird(draw, 820, 770, 0.9)
    return image


def render_carousel(output_dir: Path, topic: dict, brand: dict, target_date: str) -> list[Path]:
    images_dir = output_dir / "images"
    images_dir.mkdir(parents=True, exist_ok=True)
    slides: Iterable[str] = topic["slides"]
    result: list[Path] = []
    for index, slide in enumerate(slides, start=1):
        path = images_dir / f"{index:02d}.png"
        image = make_slide(index, slide, topic["title"], brand)
        image.save(path, format="PNG", optimize=True)
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
        "note": "投稿前にcaption.mdとchecklist.mdを確認してください。",
    }
    (images_dir / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    return result
