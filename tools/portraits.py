#!/usr/bin/env python3
"""Crop the head of each full-size class render (assets/classes/full) into a square portrait."""
import glob, os
from PIL import Image
base = os.path.join(os.path.dirname(__file__), '../server/public/assets/classes')
for f in glob.glob(base + '/full/*.png'):
    im = Image.open(f).convert('RGBA')
    w, h = im.size
    side = min(w + 20, h)
    box = (max(0, (w - side) // 2), 0, max(0, (w - side) // 2) + side, side)
    out = Image.new('RGBA', (side, side), (0, 0, 0, 0))
    out.paste(im.crop(box), (0, 0))
    out.resize((96, 96), Image.LANCZOS).save(os.path.join(base, os.path.basename(f)))
print('ok')
