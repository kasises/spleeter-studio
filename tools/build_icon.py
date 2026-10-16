"""Generate PNG and Windows ICO assets from the deterministic app mark."""

from pathlib import Path

from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parents[1]
SIZE = 512


def blend(start, end, amount):
    return tuple(round(start[index] + (end[index] - start[index]) * amount) for index in range(3))


def rounded_rectangle(draw, box, radius, fill):
    left, top, right, bottom = box
    diameter = radius * 2
    draw.rectangle((left + radius, top, right - radius, bottom), fill=fill)
    draw.rectangle((left, top + radius, right, bottom - radius), fill=fill)
    draw.pieslice((left, top, left + diameter, top + diameter), 180, 270, fill=fill)
    draw.pieslice((right - diameter, top, right, top + diameter), 270, 360, fill=fill)
    draw.pieslice((left, bottom - diameter, left + diameter, bottom), 90, 180, fill=fill)
    draw.pieslice((right - diameter, bottom - diameter, right, bottom), 0, 90, fill=fill)


def build():
    image = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    pixels = Image.new("RGB", (SIZE, SIZE))
    source = pixels.load()
    for y in range(SIZE):
        for x in range(SIZE):
            amount = (x + y) / (SIZE * 2)
            source[x, y] = blend((18, 24, 27), (7, 9, 10), amount)

    mask = Image.new("L", (SIZE, SIZE), 0)
    rounded_rectangle(ImageDraw.Draw(mask), (16, 16, 496, 496), radius=104, fill=255)
    image.alpha_composite(Image.composite(pixels.convert("RGBA"), Image.new("RGBA", (SIZE, SIZE)), mask))
    draw = ImageDraw.Draw(image)

    bars = [(96, 220, 130, 292), (151, 158, 185, 354), (206, 104, 240, 408),
            (261, 138, 295, 374), (316, 181, 350, 331), (371, 224, 405, 288)]
    gradient = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    gradient_draw = ImageDraw.Draw(gradient)
    for x in range(96, 406):
        amount = (x - 96) / (405 - 96)
        if amount < 0.55:
            color = blend((32, 213, 196), (53, 189, 214), amount / 0.55)
        else:
            color = blend((53, 189, 214), (255, 181, 74), (amount - 0.55) / 0.45)
        gradient_draw.line((x, 80, x, 432), fill=color + (255,))
    wave_mask = Image.new("L", (SIZE, SIZE), 0)
    wave_mask_draw = ImageDraw.Draw(wave_mask)
    for box in bars:
        rounded_rectangle(wave_mask_draw, box, radius=17, fill=255)
    image.alpha_composite(Image.composite(gradient, Image.new("RGBA", (SIZE, SIZE)), wave_mask))

    assets = ROOT / "assets"
    assets.mkdir(exist_ok=True)
    image.save(assets / "icon.png", optimize=True)
    image.save(assets / "icon.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])


if __name__ == "__main__":
    build()
