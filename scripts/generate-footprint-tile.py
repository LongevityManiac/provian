#!/usr/bin/env python3
"""
Generate tile-footprint.png matching the Provian tile design language.

Style: Dark navy rounded-square with 3D depth, blue-to-purple gradient footprint icon.
Size: 1024x1024 to match existing tiles.
"""

import math
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter, ImageFont

SIZE = 1024
CENTER = SIZE // 2

# Color palette (matching Provian theme)
BG_COLOR = (13, 17, 35)          # #0D1121 - deep navy background
TILE_BG = (30, 36, 60)           # #1E243C - tile face
TILE_BORDER = (50, 60, 90)       # #323C5A - subtle border
SHADOW_COLOR = (5, 8, 20)        # Very dark shadow

# Gradient endpoints for the icon
GRAD_BLUE = (59, 130, 246)       # #3B82F6 - Trust Blue
GRAD_CYAN = (6, 182, 212)        # #06B6D4 - Electric Cyan
GRAD_PURPLE = (168, 85, 247)     # #A855F7 - Purple
GRAD_PINK = (236, 72, 153)       # #EC4899 - Pink


def lerp_color(c1, c2, t):
    """Linear interpolate between two RGB colors."""
    return tuple(int(c1[i] + (c2[i] - c1[i]) * t) for i in range(3))


def draw_rounded_rect(draw, bbox, radius, fill, outline=None):
    """Draw a rounded rectangle."""
    x0, y0, x1, y1 = bbox
    draw.rounded_rectangle(bbox, radius=radius, fill=fill, outline=outline)


def create_gradient_mask(width, height, direction='diagonal'):
    """Create a gradient alpha mask."""
    mask = Image.new('L', (width, height), 0)
    for y in range(height):
        for x in range(width):
            if direction == 'diagonal':
                t = (x / width + y / height) / 2
            elif direction == 'vertical':
                t = y / height
            else:
                t = x / width
            mask.putpixel((x, y), int(t * 255))
    return mask


def draw_footprint(img, cx, cy, scale=1.0):
    """
    Draw a stylized footprint icon at center (cx, cy) with the given scale.
    Footprint = oval sole + 5 toe dots, rendered with blue-to-purple gradient.
    """
    draw = ImageDraw.Draw(img)

    # Sole (large oval, slightly elongated)
    sole_w = int(140 * scale)
    sole_h = int(200 * scale)
    sole_y_offset = int(30 * scale)  # Push sole down a bit

    # Draw sole with gradient by drawing horizontal slices
    for y_off in range(-sole_h, sole_h + 1):
        # Ellipse equation: (x/a)^2 + (y/b)^2 <= 1
        a = sole_w
        b = sole_h
        if abs(y_off) > b:
            continue
        x_span = a * math.sqrt(1 - (y_off / b) ** 2)

        py = int(cy + sole_y_offset + y_off)
        px_left = int(cx - x_span)
        px_right = int(cx + x_span)

        if px_left >= px_right:
            continue

        # Gradient based on position in the icon
        t = (y_off + sole_h) / (2 * sole_h)
        color = lerp_color(GRAD_CYAN, GRAD_PURPLE, t)

        draw.line([(px_left, py), (px_right, py)], fill=color, width=1)

    # Toe positions (5 toes in an arc above the sole)
    toe_radius = int(32 * scale)
    toe_y_base = cy - int(190 * scale)
    toe_spread = int(135 * scale)

    toes = [
        (cx - toe_spread, toe_y_base + int(30 * scale), int(28 * scale)),     # Pinky
        (cx - int(70 * scale), toe_y_base + int(5 * scale), int(30 * scale)),  # Ring
        (cx, toe_y_base - int(10 * scale), int(34 * scale)),                   # Middle
        (cx + int(70 * scale), toe_y_base + int(5 * scale), int(30 * scale)),  # Index
        (cx + toe_spread, toe_y_base + int(30 * scale), int(28 * scale)),     # Big toe (right)
    ]

    for i, (tx, ty, tr) in enumerate(toes):
        # Gradient per toe based on x position
        t = i / (len(toes) - 1) if len(toes) > 1 else 0.5
        for r_off in range(-tr, tr + 1):
            y_pos = ty + r_off
            x_span = math.sqrt(max(0, tr ** 2 - r_off ** 2))
            x_left = int(tx - x_span)
            x_right = int(tx + x_span)
            if x_left >= x_right:
                continue
            color = lerp_color(GRAD_BLUE, GRAD_PURPLE, t)
            # Add slight vertical gradient within each toe
            vt = (r_off + tr) / (2 * tr) if tr > 0 else 0.5
            color = lerp_color(color, lerp_color(GRAD_CYAN, GRAD_PINK, t), vt * 0.3)
            draw.line([(x_left, y_pos), (x_right, y_pos)], fill=color, width=1)


def add_glow(img, color, radius=30):
    """Add a subtle glow behind the icon."""
    glow = Image.new('RGBA', img.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(glow)
    # Draw a soft ellipse at center
    cx, cy = CENTER, CENTER
    r = 250
    draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(*color, 40))
    glow = glow.filter(ImageFilter.GaussianBlur(radius=radius))
    return Image.alpha_composite(img, glow)


def main():
    # Create base image
    img = Image.new('RGBA', (SIZE, SIZE), (*BG_COLOR, 255))
    draw = ImageDraw.Draw(img)

    # Draw shadow (offset down-right)
    shadow_offset = 12
    shadow_radius = 120
    shadow_layer = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
    shadow_draw = ImageDraw.Draw(shadow_layer)
    shadow_draw.rounded_rectangle(
        [100 + shadow_offset, 80 + shadow_offset, 924 + shadow_offset, 944 + shadow_offset],
        radius=140,
        fill=(*SHADOW_COLOR, 160),
    )
    shadow_layer = shadow_layer.filter(ImageFilter.GaussianBlur(radius=40))
    img = Image.alpha_composite(img, shadow_layer)

    draw = ImageDraw.Draw(img)

    # Draw tile background (rounded square)
    tile_bbox = [100, 80, 924, 944]
    tile_radius = 140

    # Tile body - slightly darker base for 3D effect
    draw.rounded_rectangle(
        [tile_bbox[0] + 2, tile_bbox[1] + 6, tile_bbox[2] + 2, tile_bbox[3] + 6],
        radius=tile_radius,
        fill=(20, 25, 45, 255),
    )

    # Main tile face
    draw.rounded_rectangle(tile_bbox, radius=tile_radius, fill=(*TILE_BG, 255))

    # Subtle border/bevel
    draw.rounded_rectangle(
        tile_bbox, radius=tile_radius, fill=None, outline=(*TILE_BORDER, 80), width=2
    )

    # Top-left highlight for 3D effect (subtle light edge)
    highlight_layer = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
    highlight_draw = ImageDraw.Draw(highlight_layer)
    highlight_draw.rounded_rectangle(
        [tile_bbox[0], tile_bbox[1], tile_bbox[2], tile_bbox[1] + 300],
        radius=tile_radius,
        fill=(255, 255, 255, 12),
    )
    # Mask to only show within the tile
    mask = Image.new('L', (SIZE, SIZE), 0)
    mask_draw = ImageDraw.Draw(mask)
    mask_draw.rounded_rectangle(tile_bbox, radius=tile_radius, fill=255)
    highlight_layer.putalpha(ImageChops_multiply_alpha(highlight_layer, mask))
    img = Image.alpha_composite(img, highlight_layer)

    # Add glow behind the footprint
    img = add_glow(img, GRAD_CYAN, radius=60)

    # Draw the footprint icon
    draw_footprint(img, CENTER, CENTER + 20, scale=1.15)

    # Save - repo-root-relative path so the script runs from any clone.
    output_path = Path(__file__).resolve().parent.parent / 'assets' / 'images' / 'tile-footprint.png'
    img_rgb = img.convert('RGB')
    img_rgb.save(str(output_path), 'PNG', quality=95)
    print(f'Saved to {output_path}')
    print(f'Size: {img_rgb.size}')


def ImageChops_multiply_alpha(rgba_img, alpha_mask):
    """Multiply the alpha channel of an RGBA image with a grayscale mask."""
    r, g, b, a = rgba_img.split()
    from PIL import ImageChops
    new_a = ImageChops.multiply(a, alpha_mask)
    return new_a


if __name__ == '__main__':
    main()
