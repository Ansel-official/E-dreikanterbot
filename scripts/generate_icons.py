#!/usr/bin/env python3
"""生成 PWA 图标（零外部资源，纯 Pillow 绘制）。"""
import os
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "public", "icons")
os.makedirs(OUT, exist_ok=True)

SS = 4  # 超采样倍数


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def gradient(size, top, bottom):
    img = Image.new("RGB", (size, size))
    draw = ImageDraw.Draw(img)
    for y in range(size):
        t = y / max(1, size - 1)
        draw.line([(0, y), (size, y)], fill=lerp(top, bottom, t))
    return img


def rounded_mask(size, radius):
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return mask


def draw_mark(img, scale=1.0, offset=(0, 0)):
    """在渐变底图上画白色几何 E + 青绿色圆点。"""
    size = img.size[0]
    d = ImageDraw.Draw(img)
    cx = size / 2 + offset[0]
    cy = size / 2 + offset[1]

    # E 的几何参数（相对画布 0~1，再乘 scale）
    def box(x0, y0, x1, y1, r):
        w = size * scale
        left = cx + (x0 - 0.5) * w
        top = cy + (y0 - 0.5) * w
        right = cx + (x1 - 0.5) * w
        bottom = cy + (y1 - 0.5) * w
        d.rounded_rectangle([left, top, right, bottom], radius=size * scale * r, fill=(255, 255, 255, 255))

    box(0.28, 0.22, 0.40, 0.78, 0.028)   # 竖
    box(0.28, 0.22, 0.72, 0.335, 0.026)  # 上横
    box(0.28, 0.437, 0.63, 0.553, 0.026) # 中横
    box(0.28, 0.658, 0.72, 0.775, 0.026) # 下横

    # 右下角圆点
    r = size * scale * 0.055
    px = cx + (0.735 - 0.5) * size * scale
    py = cy + (0.745 - 0.5) * size * scale
    d.ellipse([px - r, py - r, px + r, py + r], fill=(126, 231, 255, 255))


def make(size, maskable=False):
    big = size * SS
    top = (91, 124, 255)
    bottom = (43, 61, 168)
    bg = gradient(big, top, bottom).convert("RGBA")
    draw_mark(bg, scale=0.78 if maskable else 0.92)
    if maskable:
        # 安全区：内容缩到 78%，四周留渐变
        pass
    if not maskable:
        bg.putalpha(rounded_mask(big, int(big * 0.22)))
    return bg.resize((size, size), Image.LANCZOS)


for name, size, maskable in [
    ("icon-192.png", 192, False),
    ("icon-512.png", 512, False),
    ("icon-maskable-512.png", 512, True),
    ("apple-touch-icon.png", 180, False),
    ("icon-64.png", 64, False),
]:
    make(size, maskable).save(os.path.join(OUT, name), optimize=True)
    print("wrote", name)

# 真实 ICO
ico = make(64, False)
ico.save(os.path.join(ROOT, "public", "favicon.ico"), sizes=[(16, 16), (32, 32), (48, 48), (64, 64)])
print("wrote favicon.ico")
