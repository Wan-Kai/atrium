"""Builds first launch's Chinese title font: Huiwen Mincho cut down to the characters titles use.

Usage (fontTools comes through uv; nothing is installed for good):

    git show prototype/ui:prototypes/fonts/huiwen-title-N.woff2 > /tmp/fonts/huiwen-title-N.woff2  (N = 0..16)
    uvx --from 'fonttools[woff]' python scripts/subset-title-font.py /tmp/fonts "<every title's text>"

The prototype's split files (`prototype/ui` branch) each hold part of the common characters; the
script keeps the characters given from each, merges them into one font and writes
`packages/ui/src/design/fonts/huiwen-title.woff2`. It fails when a character is in none of them.
Only titles get this font (design-language, "字体"), so run it again whenever a title changes.
"""

import glob
import os
import sys

from fontTools import subset
from fontTools.merge import Merger
from fontTools.ttLib import TTFont

OUT = os.path.join(os.path.dirname(__file__), "..", "packages", "ui", "src", "design", "fonts", "huiwen-title.woff2")


def main(source: str, text: str) -> None:
    """Cuts each split file down to the characters needed, then merges what is left."""
    need = sorted({ch for ch in text if ord(ch) > 0x2E80})
    found: set[str] = set()
    parts: list[str] = []
    for path in sorted(glob.glob(os.path.join(source, "huiwen-title-*.woff2"))):
        font = TTFont(path)
        chars = [ch for ch in need if ord(ch) in font.getBestCmap()]
        if not chars:
            continue
        found.update(chars)
        options = subset.Options()
        options.layout_features = ["*"]
        options.name_IDs = ["*"]
        options.notdef_outline = True
        subsetter = subset.Subsetter(options)
        subsetter.populate(unicodes=[ord(ch) for ch in chars])
        subsetter.subset(font)
        font.flavor = None
        part = path.replace(".woff2", ".part.ttf")
        font.save(part)
        parts.append(part)
    missing = [ch for ch in need if ch not in found]
    if missing:
        sys.exit(f"not in the split files: {''.join(missing)}")
    merged = Merger().merge(parts)
    merged.flavor = "woff2"
    merged.save(OUT)
    print(f"{len(need)} characters -> {os.path.normpath(OUT)}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
