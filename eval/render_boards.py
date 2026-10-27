"""Render the synthetic eval boards in eval/cases.json to JPEGs (1280x960).

Styles: chalk (green board, wooden frame), white (whiteboard, black marker), white-blue (blue marker),
chalk-tilted (photo taken at an angle), chalk-faded (low contrast), chalk-clutter (posters and
scribbles around the board). Deterministic: a fixed random seed per case.

    python3 eval/render_boards.py eval/cases.json eval/data/boards
"""
import json
import random
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'


def font(size):
    try:
        return ImageFont.truetype(FONT, size)
    except OSError:
        return ImageFont.load_default()


def render(case, out):
    style = case['style']
    rnd = random.Random(case['id'])
    img = Image.new('RGB', (1280, 960), (196, 170, 140))
    d = ImageDraw.Draw(img)
    d.rectangle([0, 800, 1280, 960], fill=(120, 98, 72))                     # floor / desk
    if 'clutter' in style:
        for _ in range(6):                                                   # posters and notices on the wall
            x, y = rnd.randint(0, 1150), rnd.choice([rnd.randint(0, 60), rnd.randint(770, 860)])
            d.rectangle([x, y, x + rnd.randint(60, 140), y + rnd.randint(40, 90)], fill=tuple(rnd.randint(60, 230) for _ in range(3)))
    white = style.startswith('white')
    board_fill = (245, 245, 240) if white else (34, 74, 52)
    frame = (150, 150, 150) if white else (92, 64, 40)
    ink = (20, 60, 170) if style == 'white-blue' else (25, 25, 25) if white else (235, 238, 230)
    if 'faded' in style:
        ink, board_fill = (120, 140, 125), (52, 82, 62)
    d.rectangle([140, 120, 1140, 760], fill=frame)
    d.rectangle([166, 146, 1114, 734], fill=board_fill)
    y = 170
    for i, line in enumerate(case['lines']):
        size = 44 if i == 0 else 34
        d.text((200 + rnd.randint(-6, 6), y), line, font=font(size), fill=ink)
        y += 92 if i == 0 else 88
    if 'clutter' in style:
        for _ in range(5):                                                   # half-erased scribbles
            x, yy = rnd.randint(700, 1050), rnd.randint(200, 680)
            d.line([x, yy, x + rnd.randint(30, 80), yy + rnd.randint(-20, 20)], fill=(90, 120, 100), width=3)
    if 'tilted' in style:
        img = img.rotate(4, resample=Image.BICUBIC, fillcolor=(196, 170, 140))
    img = img.filter(ImageFilter.GaussianBlur(0.6))
    img.save(out, 'JPEG', quality=85)


def main():
    cases = json.loads(Path(sys.argv[1]).read_text())['boards']
    out = Path(sys.argv[2])
    out.mkdir(parents=True, exist_ok=True)
    for c in cases:
        render(c, out / f"{c['id']}.jpg")
    print(f'rendered {len(cases)} boards to {out}')


if __name__ == '__main__':
    main()
