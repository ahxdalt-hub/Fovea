"""Draw the paid-plan icon variants from the base app mark.

A plan badge has to survive being scaled to 16 px, so the mark is a solid
accent pill low on the tile — the word on it reads at 128 px and above, and
below that the pill still registers as "this is a different build".
"""

from PIL import Image, ImageDraw, ImageFont
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ICONS = ROOT / "icons"
INK = (15, 20, 27, 255)  # --bg deep end, so the word sits flat on the pill
AQUA = (47, 212, 190, 255)  # the lit half of the mark
WHITE = (255, 255, 255, 255)
OUTLINE = (11, 16, 23, 255)  # keeps the pill separable over the mark's strokes
FONT = "C:/Windows/Fonts/arialbd.ttf"

# Pro wears white, Studio wears the brand aqua; both are legible on the dark
# tile and on the grey/aqua halves of the mark.
TIERS = {"pro": ("PRO", WHITE), "studio": ("STUDIO", AQUA)}


def badge(word: str, pill_color: Image.Image) -> Image.Image:
    img = Image.open(ICONS / "icon.png").convert("RGBA")
    w, h = img.size
    draw = ImageDraw.Draw(img)

    font = ImageFont.truetype(FONT, int(h * 0.13))
    bbox = draw.textbbox((0, 0), word, font=font)
    text_w, text_h = bbox[2] - bbox[0], bbox[3] - bbox[1]

    pad_x = int(text_w * 0.22) + int(h * 0.03)
    pad_y = int(h * 0.028)
    pill_w = text_w + 2 * pad_x
    pill_h = text_h + 2 * pad_y
    x0 = (w - pill_w) // 2
    y0 = int(h * 0.72)
    draw.rounded_rectangle(
        (x0, y0, x0 + pill_w, y0 + pill_h),
        radius=pill_h // 2,
        fill=pill_color,
        outline=OUTLINE,
        width=int(h * 0.008),
    )
    draw.text(
        (x0 + (pill_w - text_w) // 2 - bbox[0], y0 + (pill_h - text_h) // 2 - bbox[1]),
        word,
        font=font,
        fill=INK,
    )
    return img


def main() -> None:
    for tier, (word, pill_color) in TIERS.items():
        out = ROOT / f"icons-{tier}"
        out.mkdir(exist_ok=True)
        badge(word, pill_color).save(out / "icon.png")
        print(f"wrote {out / 'icon.png'}")


if __name__ == "__main__":
    main()
