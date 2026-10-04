"""Draw the NSIS installer artwork for each plan from the plan's app icon.

NSIS wants a 150x57 header and a 164x314 sidebar. The header sits behind the
page title the wizard paints itself, so it stays white with only the mark on
the right; the sidebar owns its whole column, so it carries the full tile and
the plan name.
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
FONT = "C:/Windows/Fonts/arialbd.ttf"
TILE_TOP = (38, 49, 63)  # the mark's gradient, so the sidebar reads as one tile
TILE_BOTTOM = (15, 20, 27)

# tier dir -> (plan name, None for the free build)
TIERS = {
    "icons": "Fovea",
    "icons-pro": "Fovea Pro",
    "icons-studio": "Fovea Studio",
}


def gradient(size):
    w, h = size
    img = Image.new("RGB", (w, h))
    for y in range(h):
        t = y / max(1, h - 1)
        img.paste(
            tuple(round(a + (b - a) * t) for a, b in zip(TILE_TOP, TILE_BOTTOM)),
            (0, y, w, y + 1),
        )
    return img


def header(mark: Image.Image) -> Image.Image:
    out = Image.new("RGB", (150, 57), (255, 255, 255))
    size = 44
    tile = mark.resize((size, size), Image.LANCZOS)
    out.paste(tile, (150 - size - 6, (57 - size) // 2), tile)
    return out


def sidebar(mark: Image.Image, name: str) -> Image.Image:
    out = gradient((164, 314))
    tile = 116
    art = mark.resize((tile, tile), Image.LANCZOS)
    out.paste(art, ((164 - tile) // 2, 46), art)
    draw = ImageDraw.Draw(out)
    font = ImageFont.truetype(FONT, 19)
    bbox = draw.textbbox((0, 0), name, font=font)
    draw.text(
        ((164 - (bbox[2] - bbox[0])) // 2 - bbox[0], 182 - bbox[1]),
        name,
        font=font,
        fill=(233, 240, 246),
    )
    return out


def main() -> None:
    for tier, name in TIERS.items():
        d = ROOT / tier
        mark = Image.open(d / "icon.png").convert("RGBA")
        header(mark).save(d / "nsis-header.bmp")
        sidebar(mark, name).save(d / "nsis-sidebar.bmp")
        print(f"wrote {d / 'nsis-header.bmp'} + nsis-sidebar.bmp")


if __name__ == "__main__":
    main()
