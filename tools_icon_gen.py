#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成手相观纹启动图标（纯 stdlib，无需 PIL）：朱砂印章 + 简化掌纹剪影，超采样抗锯齿。"""
import math
import os
import struct
import zlib

RES = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                   "mobile/android/app/src/main/res")

PAPER = (246, 239, 224)      # 宣纸底
SEAL = (168, 64, 47)         # 朱砂
SEAL_DEEP = (150, 71, 46)
WHITE = (255, 247, 232)      # 掌印


def write_png(path, w, h, px):
    """px: list of rows, each row list of (r,g,b,a)"""
    raw = bytearray()
    for row in px:
        raw.append(0)
        for r, g, b, a in row:
            raw += bytes((r, g, b, a))

    def chunk(typ, data):
        c = struct.pack(">I", len(data)) + typ + data
        return c + struct.pack(">I", zlib.crc32(typ + data) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)
    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr)
                + chunk(b"IDAT", zlib.compress(bytes(raw), 6)) + chunk(b"IEND", b""))


def rr_dist(x, y, cx, cy, hw, hh, r):
    """到圆角矩形边界的带符号距离（内部为负）。cx,cy 中心；hw,hh 半宽半高；r 圆角半径。"""
    dx = abs(x - cx) - (hw - r)
    dy = abs(y - cy) - (hh - r)
    ox = max(dx, 0.0)
    oy = max(dy, 0.0)
    return math.hypot(ox, oy) + min(max(dx, dy), 0.0) - r


def seg_dist(px_, py_, x1, y1, x2, y2):
    """点到线段距离"""
    vx, vy = x2 - x1, y2 - y1
    wx, wy = px_ - x1, py_ - y1
    t = max(0.0, min(1.0, (wx * vx + wy * vy) / (vx * vx + vy * vy)))
    return math.hypot(px_ - (x1 + t * vx), py_ - (y1 + t * vy))


def arc_dist(px_, py_, cx, cy, r, a0, a1):
    """到圆弧段距离（角度制）"""
    ang = math.degrees(math.atan2(py_ - cy, px_ - cx))
    # 归一到 [0,360)
    def norm(a):
        return (a % 360.0 + 360.0) % 360.0
    a0, a1, ang = norm(a0), norm(a1), norm(ang)
    if a0 <= a1:
        inside = a0 <= ang <= a1
    else:
        inside = ang >= a0 or ang <= a1
    if inside:
        return abs(math.hypot(px_ - cx, py_ - cy) - r)
    p0 = (cx + r * math.cos(math.radians(a0)), cy + r * math.sin(math.radians(a0)))
    p1 = (cx + r * math.cos(math.radians(a1)), cy + r * math.sin(math.radians(a1)))
    return min(seg_dist(px_, py_, *p0, *p1), seg_dist(px_, py_, *p1, *p0))


def draw_palm(seal_shape="square"):
    """绘制掌印剪影的带符号距离场（负值在掌内），归一化坐标 0..1。"""
    def field(x, y):
        d = 1e9
        # 掌心主体（圆角矩形，宽扁）
        d = min(d, rr_dist(x, y, 0.50, 0.660, 0.155, 0.135, 0.10))
        # 四根手指（竖圆角条，长短中长；间距 0.066、半宽 0.031 → 留缝隙）
        for fx, flen in [(0.402, 0.150), (0.468, 0.208), (0.534, 0.192), (0.600, 0.142)]:
            fw = 0.031
            top = 0.660 - 0.135 + 0.02 - flen  # 从掌顶往上
            d = min(d, rr_dist(x, y, fx, top + flen / 2 + 0.02, fw, flen / 2, fw))
        # 拇指（斜圆帽条，根部接在掌内）
        ang = math.radians(40)
        tx, ty = 0.375, 0.635
        d = min(d, seg_dist(x, y, tx, ty,
                            tx - 0.105 * math.cos(ang), ty - 0.105 * math.sin(ang)) - 0.047)
        return d
    return field


def draw_lines():
    """三条主线（朱砂弧线画在白色掌印上）的带符号距离场。"""
    def field(x, y):
        d = 1e9
        # 感情线（上弧）
        d = min(d, arc_dist(x, y, 0.500, 0.700, 0.115, 205, 335))
        # 智慧线（中弧，稍平）
        d = min(d, arc_dist(x, y, 0.470, 0.740, 0.125, 215, 330))
        # 生命线（下弧，包住拇指根部）
        d = min(d, arc_dist(x, y, 0.520, 0.760, 0.135, 230, 150))
        return d
    return field


def render(w, h, mode="icon"):
    """mode: icon=完整图标(纸底+印章+掌纹) | round=圆形裁切 | foreground=自适应前景(透明边距)"""
    SS = 4  # 超采样
    W, H = w * SS, h * SS
    palm = draw_palm()
    lines = draw_lines()

    # 印章与内容在画布中的几何（归一化）
    if mode == "foreground":
        # 108dp 画布，安全区约 2/3 → 印章占中心 58%
        scx, scy, shw, shh, rad = 0.5, 0.5, 0.29, 0.29, 0.075
    else:
        scx, scy, shw, shh, rad = 0.5, 0.5, 0.36, 0.36, 0.10

    px = []
    for y in range(H):
        row = []
        ny = (y + 0.5) / H
        for x in range(W):
            nx = (x + 0.5) / W

            r, g, b, a = PAPER + (255,)
            if mode == "round":
                if math.hypot(nx - 0.5, ny - 0.5) > 0.5:
                    r, g, b, a = 0, 0, 0, 0
            elif mode == "foreground":
                r, g, b, a = 0, 0, 0, 0

            # 印章（垂直渐变 朱砂→深朱）
            ds = rr_dist(nx, ny, scx, scy, shw, shh, rad)
            if ds < 0:
                t = max(0.0, min(1.0, (ny - (scy - shh)) / (2 * shh)))
                r = int(SEAL[0] + (SEAL_DEEP[0] - SEAL[0]) * t)
                g = int(SEAL[1] + (SEAL_DEEP[1] - SEAL[1]) * t)
                b = int(SEAL[2] + (SEAL_DEEP[2] - SEAL[2]) * t)
                a = 255

                # 白色掌印
                dp = palm(nx, ny)
                if dp < 0:
                    r, g, b = WHITE

                # 三条主线（朱砂弧线）
                dl = lines(nx, ny)
                if dl < 0.006 and dp < 0:
                    r, g, b = SEAL_DEEP

            row.append((r, g, b, a))
        px.append(row)

    # 盒式降采样（含 alpha）
    out = []
    for y in range(h):
        orow = []
        for x in range(w):
            rs = gs = bs = as_ = cnt = 0
            for sy in range(SS):
                for sx in range(SS):
                    pr, pg, pb, pa = px[y * SS + sy][x * SS + sx]
                    rs += pr * pa; gs += pg * pa; bs += pb * pa; as_ += pa; cnt += 255
            if as_ == 0:
                orow.append((0, 0, 0, 0))
            else:
                orow.append((round(rs / as_), round(gs / as_), round(bs / as_), round(as_ * 255 / cnt)))
        out.append(orow)
    return out


def main():
    icon_sizes = {"mipmap-mdpi": 48, "mipmap-hdpi": 72, "mipmap-xhdpi": 96,
                  "mipmap-xxhdpi": 144, "mipmap-xxxhdpi": 192}
    for d, s in icon_sizes.items():
        p = os.path.join(RES, d)
        os.makedirs(p, exist_ok=True)
        write_png(os.path.join(p, "ic_launcher.png"), s, s, render(s, s, "icon"))
        write_png(os.path.join(p, "ic_launcher_round.png"), s, s, render(s, s, "round"))
        fg = int(s * 108 / 48)
        write_png(os.path.join(p, "ic_launcher_foreground.png"), fg, fg, render(fg, fg, "foreground"))
        print("✓", d, s, "fg", fg)


if __name__ == "__main__":
    main()
