#!/usr/bin/env python3
# Cut the wordmark's font, web/src/fonts/box-yard-wordmark.woff2, from Sora (SIL OFL 1.1, web/src/fonts/OFL-Sora.txt),
# and print the crate Y that BrandLogo.tsx draws in it:
#
#   python3 scripts/wordmark-font.py <Sora variable font>   (needs: pip install fonttools brotli shapely)
#
# The source is Sora[wght].ttf from github.com/sora-xor/sora-font, or the latin file of @fontsource-variable/sora
# (files/sora-latin-wght-normal.woff2), which the shipped file came from. Only "BOX YARD" is ever set in it, so it keeps
# those glyphs at one weight: about 1 KB, small enough that Vite inlines it into the stylesheet and the wordmark paints
# with the first frame.
import sys
from pathlib import Path

from fontTools import subset
from fontTools.pens.recordingPen import RecordingPen
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont
from shapely.geometry import Polygon, box
from shapely.ops import unary_union

TEXT = "BOX YARD"
AXES = {"wght": 600}  # SemiBold
FAMILY = "Box Yard Wordmark"
OUT = Path(__file__).resolve().parent.parent / "web/src/fonts/box-yard-wordmark.woff2"

if len(sys.argv) != 2:
    sys.exit("usage: python3 scripts/wordmark-font.py <Sora variable font>")

font = instantiateVariableFont(TTFont(sys.argv[1]), AXES)

# The Y of YARD is drawn, not set: the logo's crate (web/public/icons/box-yard-icon.svg) as a cap-height square, with
# Sora's Y cut out of it where the crate has its Y-shaped gap. What's left is the crate's three planks, a light top
# and an amber and a dark side, which BrandLogo.tsx draws (CRATE_Y) and rounds with a clip like the logo's corners.
cap = font["OS/2"].sCapHeight
glyph = font.getBestCmap()[ord("Y")]
pen = RecordingPen()
font.getGlyphSet()[glyph].draw(pen)
contours = []
for op, args in pen.value:
    if op == "moveTo":
        contours.append([args[0]])
    elif op == "lineTo":
        contours[-1].append(args[0])
    elif op not in ("closePath", "endPath"):
        sys.exit(f"Sora's Y has a curve ({op}): cut it by hand")
shift = (cap - font["hmtx"][glyph][0]) / 2  # centred in the square
y_shape = unary_union([Polygon([(x + shift, y) for x, y in c]).buffer(0) for c in contours])
planks = list(box(0, 0, cap, cap).difference(y_shape).geoms)
if len(planks) != 3:
    sys.exit(f"cutting the Y left {len(planks)} pieces, not 3")
top = max(planks, key=lambda p: p.centroid.y)
left, right = sorted((p for p in planks if p is not top), key=lambda p: p.centroid.x)


def svg_path(piece):
    # Half units, y down: a 1000-unit em is 0.0005em per step.
    num = lambda v: f"{round(v * 2) / 2:g}"
    return "M" + " ".join(f"{num(x)} {num(cap - y)}" for x, y in piece.exterior.coords[:-1]) + "Z"


print(f"CRATE_Y in web/src/components/BrandLogo.tsx (viewBox 0 0 {cap} {cap}, cap height {cap / font['head'].unitsPerEm:g}em):")
for piece, fill in ((top, "#fcd34d"), (left, "#f59e0b"), (right, "#b45309")):
    print(f'  {{ d: "{svg_path(piece)}", fill: "{fill}" }},')

options = subset.Options()
options.flavor = "woff2"
options.layout_features = ["kern"]
options.name_IDs = [0, 1, 2, 3, 4, 5, 6, 13, 14]
options.hinting = False
options.notdef_outline = False
subsetter = subset.Subsetter(options)
subsetter.populate(text=TEXT)
subsetter.subset(font)

# A modified copy (this one is cut down and pinned to one weight) goes by its own name, so it never stands in for Sora.
name = font["name"]
for name_id in (16, 17, 21, 22, 25):
    name.removeNames(nameID=name_id)
for name_id, value in {1: FAMILY, 2: "Regular", 3: f"{FAMILY.replace(' ', '')}; cut from Sora", 4: FAMILY, 6: FAMILY.replace(" ", "") + "-Regular"}.items():
    name.removeNames(nameID=name_id)
    name.setName(value, name_id, 3, 1, 0x409)
name.removeNames(nameID=13)
name.removeNames(nameID=14)
name.setName("This Font Software is licensed under the SIL Open Font License, Version 1.1.", 13, 3, 1, 0x409)
name.setName("https://openfontlicense.org", 14, 3, 1, 0x409)
font["OS/2"].usWeightClass = AXES["wght"]

subset.save_font(font, str(OUT), options)
print(f"{OUT}: {OUT.stat().st_size} bytes")
