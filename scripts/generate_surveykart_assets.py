#!/usr/bin/env python3
"""Generate 3D animated GIF assets and vector favicon for SurveyKart.

The 3D Kart carries an unmistakable 3D Survey Questionnaire / Clipboard
(with golden clip, checkmarks, and survey lines sitting inside the Kart basket).
"""

from __future__ import annotations

import math
import os
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
IMG_DIR = os.path.join(ROOT, "static", "images")


def _draw_wheel(draw: ImageDraw.ImageDraw, wx: float, wy: float, r: float, angle: float, ss: int = 3):
    """Draw a 3D wheel with depth shadow, tire, rim, and rotating spokes."""
    off = max(2, int(1.6 * ss))
    draw.ellipse((wx - r + off, wy - r + off * 0.8, wx + r + off, wy + r + off * 0.8),
                 fill=(11, 52, 41, 255))
    draw.ellipse((wx - r, wy - r, wx + r, wy + r),
                 fill=(20, 97, 79, 255), outline=(10, 54, 43, 255), width=max(2, ss))
    ir = r * 0.60
    draw.ellipse((wx - ir, wy - ir, wx + ir, wy + ir),
                 fill=(250, 246, 236, 255), outline=(201, 162, 39, 255), width=max(2, ss))
    for k in range(4):
        a = angle + k * (math.pi / 2)
        sx = wx + math.cos(a) * (ir * 0.85)
        sy = wy + math.sin(a) * (ir * 0.85)
        draw.line((wx, wy, sx, sy), fill=(201, 162, 39, 255), width=max(2, ss))
    hr = r * 0.24
    draw.ellipse((wx - hr, wy - hr, wx + hr, wy + hr), fill=(201, 162, 39, 255))


def _draw_checkmark(draw: ImageDraw.ImageDraw, x0: float, y0: float, box_s: float,
                    width: int, color=(255, 255, 255, 255)):
    """Draw a crisp checkmark inside a box at (x0, y0, x0+box_s, y0+box_s)."""
    p1 = (x0 + box_s * 0.20, y0 + box_s * 0.54)
    p2 = (x0 + box_s * 0.43, y0 + box_s * 0.77)
    p3 = (x0 + box_s * 0.82, y0 + box_s * 0.24)
    draw.line([p1, p2, p3], fill=color, width=width, joint="curve")


def _draw_3d_survey_sheet(draw: ImageDraw.ImageDraw, x0: float, y0: float, w: float, h: float,
                          ss: int, active_row: int = 2, depth: float = 4.5):
    """Draw a 3D extruded Survey Clipboard / Questionnaire sheet with checkmarks & lines."""
    dx = depth * ss
    dy = -depth * 0.65 * ss
    x1, y1 = x0 + w, y0 + h

    # Back stacked survey sheet peeking out on the right for multi-page 3D feel
    bx0, by0 = x0 + 5 * ss, y0 + 2 * ss
    bx1, by1 = x1 + 6.5 * ss, y1 - 2 * ss
    draw.rounded_rectangle(
        (bx0, by0, bx1, by1),
        radius=5 * ss,
        fill=(230, 241, 236, 255),
        outline=(118, 162, 146, 255),
        width=max(2, int(1.6 * ss)),
    )

    # 3D right/top extrusion of main survey board
    draw.rounded_rectangle(
        (x0 + dx * 0.7, y0 - dy * 0.4, x1 + dx * 0.7, y1 - dy * 0.4),
        radius=6 * ss,
        fill=(18, 82, 66, 255),
    )

    # Crisp white main Survey Questionnaire page
    draw.rounded_rectangle(
        (x0, y0, x1, y1),
        radius=6 * ss,
        fill=(255, 255, 255, 255),
        outline=(20, 97, 79, 255),
        width=max(2, int(2.2 * ss)),
    )

    # 3D Golden Clipboard Clip centered at top of Survey
    cw = w * 0.46
    ch = 7.5 * ss
    cx0 = x0 + (w - cw) / 2
    cy0 = y0 - ch * 0.48
    # Clip shadow / 3D base
    draw.rounded_rectangle(
        (cx0, cy0 + 1.5 * ss, cx0 + cw, cy0 + ch + 1.5 * ss),
        radius=3 * ss,
        fill=(142, 108, 18, 255),
    )
    draw.rounded_rectangle(
        (cx0, cy0, cx0 + cw, cy0 + ch),
        radius=3 * ss,
        fill=(232, 192, 68, 255),
        outline=(150, 114, 18, 255),
        width=max(2, int(1.5 * ss)),
    )
    # Clip top shine dot
    draw.line(
        (cx0 + 4 * ss, cy0 + 2.3 * ss, cx0 + cw - 4 * ss, cy0 + 2.3 * ss),
        fill=(255, 246, 205, 255),
        width=max(1, int(1.3 * ss)),
    )

    # Survey checklist rows (3 bold rows so it reads unmistakably as a Survey even at 40px!)
    margin_x = x0 + 6.5 * ss
    box_s = 9.5 * ss
    row_ys = [
        y0 + 10.5 * ss,
        y0 + 23.5 * ss,
        y0 + 36.5 * ss,
    ]
    line_lengths = [0.86, 0.76, 0.82]

    for idx, ry in enumerate(row_ys):
        if ry + box_s > y1 - 3 * ss:
            break
        is_gold = (idx == active_row)
        box_fill = (201, 162, 39, 255) if is_gold else (25, 130, 103, 255)
        box_out = (146, 112, 18, 255) if is_gold else (14, 78, 62, 255)
        draw.rounded_rectangle(
            (margin_x, ry, margin_x + box_s, ry + box_s),
            radius=2.3 * ss,
            fill=box_fill,
            outline=box_out,
            width=max(1, int(1.2 * ss)),
        )
        _draw_checkmark(draw, margin_x, ry, box_s, width=max(2, int(2.1 * ss)))

        # Question text bar + secondary option bar
        lx0 = margin_x + box_s + 4.5 * ss
        max_lw = (x1 - 6.5 * ss) - lx0
        lw = max_lw * line_lengths[idx]
        ly_top = ry + 2.4 * ss
        ly_sub = ry + 6.8 * ss
        draw.line((lx0, ly_top, lx0 + lw, ly_top), fill=(26, 48, 40, 255), width=max(2, int(2.6 * ss)))
        draw.line((lx0, ly_sub, lx0 + lw * 0.62, ly_sub), fill=(138, 162, 152, 255), width=max(2, int(1.8 * ss)))


def generate_logo_gif(out_path: str, size: int = 128, frames_n: int = 20):
    """Render a smooth looping 3D SurveyKart animated GIF: a 3D Kart carrying a 3D Survey."""
    ss = 4  # 4x supersampling (512x512) for razor-sharp edges at 38px-128px
    W = size * ss
    frames = []

    for f in range(frames_n):
        t = f / frames_n
        phase = 2 * math.pi * t
        bob = math.sin(phase) * (3.2 * ss)
        doc_bob = math.sin(phase - 0.35) * (4.2 * ss)
        tilt = math.sin(phase) * (1.2 * ss)

        img = Image.new("RGBA", (W, W), (0, 0, 0, 0))
        d = ImageDraw.Draw(img)

        pad = 5 * ss
        # 3D Tile Extrusion Base (bottom emerald ledge)
        d.rounded_rectangle(
            (pad, pad + 9 * ss, W - pad, W - pad + 4 * ss),
            radius=26 * ss,
            fill=(13, 70, 56, 255),
        )
        # Main Ivory-Gold 3D Cameo Tile
        d.rounded_rectangle(
            (pad, pad, W - pad, W - pad - 4 * ss),
            radius=26 * ss,
            fill=(248, 244, 235, 255),
            outline=(206, 190, 156, 255),
            width=3 * ss,
        )
        # Subtle inner warm rim
        in_pad = 10 * ss
        d.rounded_rectangle(
            (in_pad, in_pad, W - in_pad, W - in_pad - 4 * ss),
            radius=21 * ss,
            outline=(234, 225, 206, 255),
            width=2 * ss,
        )

        # Ground shadow beneath the 3D Kart
        sh_w = (40 - math.sin(phase) * 3.0) * ss
        sh_y = 107 * ss
        d.ellipse(
            (W / 2 - sh_w + 3 * ss, sh_y - 4.5 * ss, W / 2 + sh_w + 3 * ss, sh_y + 4.5 * ss),
            fill=(216, 207, 188, 255),
        )

        ky = bob * 0.55

        # 1. Back wall of 3D Kart Basket (drawn BEHIND the Survey so Survey sits INSIDE the Kart!)
        back_basket = [
            (37 * ss, 56 * ss + ky),
            (106 * ss, 56 * ss + ky),
            (97 * ss, 84 * ss + ky),
            (45 * ss, 84 * ss + ky),
        ]
        d.polygon(back_basket, fill=(215, 234, 224, 255), outline=(29, 138, 111, 255))

        # 2. 3D Survey Clipboard / Questionnaire sitting inside the Kart & rising proudly above rim!
        active_row = int((t * 3) % 3)
        _draw_3d_survey_sheet(
            d,
            x0=46 * ss,
            y0=19 * ss + doc_bob,
            w=50 * ss,
            h=61 * ss,
            ss=ss,
            active_row=active_row,
            depth=3.5,
        )

        # 3. Front open 3D wireframe Kart Basket (drawn IN FRONT of lower Survey so you see the
        #    Survey sitting inside the Kart basket!)
        basket_tint = Image.new("RGBA", (W, W), (0, 0, 0, 0))
        bd = ImageDraw.Draw(basket_tint)
        front_poly = [
            (33 * ss, 59 * ss + ky),
            (104 * ss, 59 * ss + ky + tilt * 0.2),
            (94 * ss, 87 * ss + ky + tilt * 0.2),
            (43 * ss, 87 * ss + ky),
        ]
        bd.polygon(front_poly, fill=(20, 97, 79, 165))
        img = Image.alpha_composite(img, basket_tint)
        d = ImageDraw.Draw(img)

        # Crisp 3D Kart outer frame & metallic wire bars
        d.polygon(front_poly, outline=(13, 70, 56, 255), width=3 * ss)
        d.line((37 * ss, 69 * ss + ky, 100 * ss, 69 * ss + ky + tilt * 0.15),
               fill=(172, 238, 210, 245), width=int(2.4 * ss))
        d.line((40 * ss, 78 * ss + ky, 97 * ss, 78 * ss + ky + tilt * 0.15),
               fill=(172, 238, 210, 245), width=int(2.4 * ss))
        for gx in (54, 69, 84):
            d.line((gx * ss, 60 * ss + ky, (gx - 2) * ss, 86 * ss + ky),
                   fill=(172, 238, 210, 225), width=int(2.2 * ss))

        # Top golden rim bar of Kart
        d.line((31 * ss, 59 * ss + ky, 106 * ss, 59 * ss + ky + tilt * 0.2),
               fill=(201, 162, 39, 255), width=int(5.2 * ss))
        d.line((32 * ss, 57.5 * ss + ky, 105 * ss, 57.5 * ss + ky + tilt * 0.2),
               fill=(250, 232, 165, 255), width=int(1.8 * ss))

        # Kart Handle (left side sweeping up with golden grip)
        d.line((17 * ss, 41 * ss + ky, 28 * ss, 41 * ss + ky),
               fill=(201, 162, 39, 255), width=6 * ss)
        d.line((27 * ss, 41 * ss + ky, 43 * ss, 87 * ss + ky),
               fill=(13, 70, 56, 255), width=5 * ss)
        # Lower chassis bar to wheels
        d.line((43 * ss, 87 * ss + ky, 92 * ss, 92 * ss + ky),
               fill=(13, 70, 56, 255), width=int(4.5 * ss))

        # Rotating 3D Wheels
        wheel_angle = phase * 2
        _draw_wheel(d, 51 * ss, 98 * ss + ky * 0.35, 10.5 * ss, wheel_angle, ss=ss)
        _draw_wheel(d, 85 * ss, 98 * ss + ky * 0.35, 10.5 * ss, wheel_angle, ss=ss)

        # Twinkling golden insight star near top-left/right
        sx = 27 * ss + math.cos(phase) * 3 * ss
        sy = 25 * ss + math.sin(phase) * 3 * ss
        sr = (4.2 + 1.3 * math.sin(phase * 2)) * ss
        d.line((sx - sr, sy, sx + sr, sy), fill=(201, 162, 39, 255), width=int(2.2 * ss))
        d.line((sx, sy - sr, sx, sy + sr), fill=(201, 162, 39, 255), width=int(2.2 * ss))

        # Diagonal specular sheen sweeping across the 3D tile
        if 0.08 <= t <= 0.42:
            prog = (t - 0.08) / 0.34
            lx = int((-25 + prog * 175) * ss)
            sheen = Image.new("RGBA", (W, W), (0, 0, 0, 0))
            sd = ImageDraw.Draw(sheen)
            sd.polygon(
                [(lx, pad), (lx + 18 * ss, pad), (lx - 22 * ss, W - pad), (lx - 40 * ss, W - pad)],
                fill=(255, 255, 255, 78),
            )
            img = Image.alpha_composite(img, sheen)

        small = img.resize((size, size), Image.Resampling.LANCZOS)
        alpha = small.getchannel("A")
        mask = Image.eval(alpha, lambda a: 255 if a <= 128 else 0)
        p_img = small.convert("RGB").quantize(colors=250, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
        p_img.paste(255, mask)
        frames.append(p_img)

    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    frames[0].save(
        out_path,
        save_all=True,
        append_images=frames[1:],
        duration=65,
        loop=0,
        transparency=255,
        disposal=2,
        optimize=True,
    )


def _draw_mini_survey_card(draw: ImageDraw.ImageDraw, cx: float, cy: float, w: float, h: float,
                           header_col, border_col, kind: str, ss: int):
    """Draw a 3D mini Survey Question Sheet/Card (instead of a plain box) for the Kart demo GIF."""
    x0, y0 = cx - w / 2, cy - h / 2
    x1, y1 = cx + w / 2, cy + h / 2

    # 3D card shadow / extrusion
    draw.rounded_rectangle(
        (x0 + 3 * ss, y0 + 2.5 * ss, x1 + 3 * ss, y1 + 2.5 * ss),
        radius=4 * ss,
        fill=(18, 70, 56, 255),
    )
    # White survey card body
    draw.rounded_rectangle(
        (x0, y0, x1, y1),
        radius=4 * ss,
        fill=(255, 255, 255, 255),
        outline=border_col + (255,),
        width=max(2, int(1.6 * ss)),
    )
    # Colored survey question header strip
    hh = 7.5 * ss
    draw.rounded_rectangle(
        (x0 + 1.5 * ss, y0 + 1.5 * ss, x1 - 1.5 * ss, y0 + hh),
        radius=3 * ss,
        fill=header_col + (255,),
    )
    # Mini survey content by question type
    if kind == "check":
        for r_i in range(2):
            ry = y0 + hh + (3.5 + r_i * 9.5) * ss
            bx = x0 + 4 * ss
            bs = 6.2 * ss
            draw.rounded_rectangle((bx, ry, bx + bs, ry + bs), radius=1.5 * ss, fill=header_col + (255,))
            _draw_checkmark(draw, bx, ry, bs, width=max(1, int(1.4 * ss)))
            draw.line((bx + bs + 3 * ss, ry + 3 * ss, x1 - 4 * ss, ry + 3 * ss),
                      fill=(34, 56, 48, 255), width=max(2, int(1.8 * ss)))
    elif kind == "bars":
        # Constant sum / allocation bars on survey sheet
        widths = [0.78, 0.52, 0.66]
        for r_i, wf in enumerate(widths):
            ry = y0 + hh + (4.2 + r_i * 6.5) * ss
            bx = x0 + 4.5 * ss
            maxw = (w - 9 * ss)
            draw.line((bx, ry, bx + maxw, ry), fill=(230, 236, 232, 255), width=max(2, int(2.8 * ss)))
            draw.line((bx, ry, bx + maxw * wf, ry), fill=header_col + (255,), width=max(2, int(2.8 * ss)))
    else:
        # Delta / Matrix grid cells on survey sheet
        gx0 = x0 + 4.5 * ss
        gy0 = y0 + hh + 3.5 * ss
        gw = w - 9 * ss
        gh = h - hh - 7.5 * ss
        draw.rectangle((gx0, gy0, gx0 + gw, gy0 + gh), outline=header_col + (255,), width=max(1, ss))
        draw.line((gx0 + gw / 2, gy0, gx0 + gw / 2, gy0 + gh), fill=header_col + (255,), width=max(1, ss))
        draw.line((gx0, gy0 + gh / 2, gx0 + gw, gy0 + gh / 2), fill=header_col + (255,), width=max(1, ss))


def generate_kart_demo_gif(out_path: str, w_px: int = 320, h_px: int = 190, frames_n: int = 24):
    """Animated 3D Kart graphic for the Landing Page: Survey sheets & question cards in the Kart."""
    ss = 2
    W, H = w_px * ss, h_px * ss
    frames = []

    cards = [
        {"kind": "check", "hdr": (25, 130, 103), "bdr": (20, 97, 79), "x": 124, "y": 77},
        {"kind": "check", "hdr": (29, 138, 111), "bdr": (20, 97, 79), "x": 154, "y": 73},
        {"kind": "bars", "hdr": (201, 162, 39), "bdr": (150, 116, 20), "x": 185, "y": 69},
        {"kind": "grid", "hdr": (91, 74, 145), "bdr": (63, 50, 105), "x": 216, "y": 75},
    ]

    for f in range(frames_n):
        t = f / frames_n
        phase = 2 * math.pi * t
        img = Image.new("RGBA", (W, H), (250, 246, 238, 255))
        d = ImageDraw.Draw(img)

        for gy in range(132, 185, 15):
            d.line((20 * ss, gy * ss, (w_px - 20) * ss, gy * ss), fill=(228, 218, 198, 255), width=2)

        d.ellipse((98 * ss, 152 * ss, 248 * ss, 165 * ss), fill=(224, 216, 198, 255))

        bob = math.sin(phase) * (2.8 * ss)
        ky = bob * 0.6

        # Back wall of 3D Kart basket
        d.polygon(
            [(104 * ss, 86 * ss + ky), (242 * ss, 86 * ss + ky),
             (226 * ss, 134 * ss + ky), (118 * ss, 134 * ss + ky)],
            fill=(218, 236, 227, 255),
            outline=(29, 138, 111, 255),
        )

        # Central tall 3D Master Survey Clipboard rising behind the question cards
        _draw_3d_survey_sheet(
            d,
            x0=145 * ss,
            y0=22 * ss + bob * 0.8,
            w=54 * ss,
            h=68 * ss,
            ss=ss,
            active_row=int((t * 3) % 3),
            depth=3.0,
        )

        # 4 Survey Question Cards dropping smoothly into the Kart basket
        for idx, it in enumerate(cards):
            drop_window = idx * 0.18
            local_t = (t - drop_window) % 1.0
            drop_y = -26 * ss * math.exp(-local_t * 9.0) * math.cos(local_t * 12.0)
            cy = it["y"] * ss + bob + drop_y
            _draw_mini_survey_card(
                d,
                it["x"] * ss,
                cy,
                28 * ss,
                32 * ss,
                header_col=it["hdr"],
                border_col=it["bdr"],
                kind=it["kind"],
                ss=ss,
            )

        # Translucent front 3D Kart Basket so the Survey sheets are visibly inside the Kart
        overlay = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        od = ImageDraw.Draw(overlay)
        front_poly = [
            (102 * ss, 90 * ss + ky), (242 * ss, 90 * ss + ky),
            (226 * ss, 135 * ss + ky), (118 * ss, 135 * ss + ky),
        ]
        od.polygon(front_poly, fill=(20, 97, 79, 175))
        img = Image.alpha_composite(img, overlay)
        d = ImageDraw.Draw(img)
        d.polygon(front_poly, outline=(13, 70, 56, 255), width=2 * ss)

        for ry in (104, 119):
            d.line((108 * ss, ry * ss + ky, 235 * ss, ry * ss + ky),
                   fill=(172, 238, 210, 225), width=2 * ss)
        for rx in (138, 166, 194, 218):
            d.line((rx * ss, 91 * ss + ky, (rx - 4) * ss, 133 * ss + ky),
                   fill=(172, 238, 210, 195), width=2 * ss)

        # Gold Rim + Handle
        d.line((98 * ss, 90 * ss + ky, 245 * ss, 90 * ss + ky),
               fill=(201, 162, 39, 255), width=5 * ss)
        d.line((74 * ss, 62 * ss + ky, 92 * ss, 62 * ss + ky),
               fill=(201, 162, 39, 255), width=6 * ss)
        d.line((90 * ss, 62 * ss + ky, 118 * ss, 136 * ss + ky),
               fill=(13, 70, 56, 255), width=5 * ss)
        d.line((118 * ss, 136 * ss + ky, 224 * ss, 141 * ss + ky),
               fill=(13, 70, 56, 255), width=5 * ss)

        _draw_wheel(d, 134 * ss, 150 * ss + ky * 0.3, 12.5 * ss, phase * 2, ss=ss)
        _draw_wheel(d, 210 * ss, 150 * ss + ky * 0.3, 12.5 * ss, phase * 2, ss=ss)

        for k in range(3):
            ang = phase + k * 2.1
            px = (172 + math.cos(ang) * 82) * ss
            py = (44 + math.sin(ang * 2) * 12) * ss
            r = 4 * ss
            d.line((px - r, py, px + r, py), fill=(201, 162, 39, 255), width=2 * ss)
            d.line((px, py - r, px, py + r), fill=(201, 162, 39, 255), width=2 * ss)

        small = img.resize((w_px, h_px), Image.Resampling.LANCZOS)
        frames.append(small.convert("RGB").convert("P", palette=Image.Palette.ADAPTIVE, colors=256))

    frames[0].save(
        out_path,
        save_all=True,
        append_images=frames[1:],
        duration=75,
        loop=0,
        optimize=True,
    )


FAVICON_SVG = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 44 44" fill="none">
  <rect x="2" y="4" width="40" height="39" rx="12" fill="#0d4638"/>
  <rect x="2" y="2" width="40" height="39" rx="12" fill="#f8f4eb" stroke="#d4c39e" stroke-width="1.5"/>
  <!-- 3D Survey Clipboard inside Kart -->
  <rect x="17" y="7" width="18" height="21" rx="3" fill="#14614f"/>
  <rect x="15.5" y="8" width="18" height="21" rx="3" fill="#ffffff" stroke="#14614f" stroke-width="1.4"/>
  <rect x="20.5" y="6" width="8" height="3.6" rx="1.5" fill="#e8c044" stroke="#967212" stroke-width="0.9"/>
  <!-- Checkboxes + Survey Lines -->
  <rect x="18" y="12" width="3.8" height="3.8" rx="0.9" fill="#198267"/>
  <path d="M18.8 13.9 L19.7 14.8 L21.2 12.8" stroke="#ffffff" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"/>
  <line x1="23.2" y1="13.9" x2="30.8" y2="13.9" stroke="#1a3028" stroke-width="1.5" stroke-linecap="round"/>
  <rect x="18" y="17.5" width="3.8" height="3.8" rx="0.9" fill="#c9a227"/>
  <path d="M18.8 19.4 L19.7 20.3 L21.2 18.3" stroke="#ffffff" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"/>
  <line x1="23.2" y1="19.4" x2="29.8" y2="19.4" stroke="#1a3028" stroke-width="1.5" stroke-linecap="round"/>
  <!-- 3D Kart Basket & Handle -->
  <path d="M7.5 15 H11.8 L15.5 29.5 H32.8 L36 20.5 H13.2" stroke="#0d4638" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"/>
  <polygon points="13.4,20.5 35.8,20.5 32.8,29.2 15.6,29.2" fill="#14614f" fill-opacity="0.76"/>
  <line x1="12.8" y1="20.5" x2="36.2" y2="20.5" stroke="#c9a227" stroke-width="2.4" stroke-linecap="round"/>
  <line x1="14.5" y1="25" x2="34.2" y2="25" stroke="#aceed2" stroke-width="1.1"/>
  <!-- 3D Wheels -->
  <circle cx="18.5" cy="34.2" r="3.3" fill="#14614f" stroke="#0d4638" stroke-width="1.2"/>
  <circle cx="18.5" cy="34.2" r="1.4" fill="#c9a227"/>
  <circle cx="29.8" cy="34.2" r="3.3" fill="#14614f" stroke="#0d4638" stroke-width="1.2"/>
  <circle cx="29.8" cy="34.2" r="1.4" fill="#c9a227"/>
</svg>
"""


if __name__ == "__main__":
    logo_gif = os.path.join(IMG_DIR, "surveykart-3d-logo.gif")
    demo_gif = os.path.join(IMG_DIR, "surveykart-kart-demo.gif")
    fav_svg = os.path.join(IMG_DIR, "favicon.svg")
    generate_logo_gif(logo_gif)
    generate_kart_demo_gif(demo_gif)
    with open(fav_svg, "w", encoding="utf-8") as fh:
        fh.write(FAVICON_SVG)
    print("Generated:", logo_gif, os.path.getsize(logo_gif), "bytes")
    print("Generated:", demo_gif, os.path.getsize(demo_gif), "bytes")
    print("Generated:", fav_svg, os.path.getsize(fav_svg), "bytes")
