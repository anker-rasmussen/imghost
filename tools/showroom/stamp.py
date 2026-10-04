#!/usr/bin/env python3
"""Content-hash every module / stylesheet / font URL in the showroom (`?v=<sha256[:16]>`).

Cloudflare caches static files for hours, so a changed file must change its URL. JS modules import each other, so a
module's hash depends on the stamped hashes of what it imports: files are stamped leaf-first (dependency order), then
index.html. tests/integration.rs re-checks every `?v=` in the site and fails on a stale one.

    python3 tools/showroom/stamp.py          # or: make showroom-stamp
"""
from __future__ import annotations

import hashlib
import re
import sys
from pathlib import Path

SITE = Path(__file__).resolve().parents[2] / "static" / "showroom"
# relative refs inside JS (static + dynamic imports) and CSS (url())
JS_REF = re.compile(r"""(['"])(\.{1,2}/[\w./-]+\.(?:js|css|json))(?:\?v=[0-9a-f]{16})?\1""")
CSS_REF = re.compile(r"""url\((['"]?)((?!data:|https?:|/)[^'")?]+)(?:\?v=[0-9a-f]{16})?\1\)""")
HTML_REF = re.compile(r"""((?:src|href)=")((?!https?:|/|#)[\w./-]+\.(?:js|css|webp|png|svg|ico|woff2))(?:\?v=[0-9a-f]{16})?(")""")


def h16(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()[:16]


def refs(p: Path) -> list[Path]:
    text = p.read_text()
    pat = JS_REF if p.suffix == ".js" else CSS_REF
    out = []
    for m in pat.finditer(text):
        out.append((p.parent / m.group(2)).resolve())
    return out


def stamp_file(p: Path) -> bool:
    text = p.read_text()
    if p.suffix == ".js":
        new = JS_REF.sub(lambda m: f"{m.group(1)}{m.group(2)}?v={h16((p.parent / m.group(2)).resolve())}{m.group(1)}", text)
    else:
        new = CSS_REF.sub(lambda m: f"url({m.group(1)}{m.group(2)}?v={h16((p.parent / m.group(2)).resolve())}{m.group(1)})", text)
    if new != text:
        p.write_text(new)
        return True
    return False


def main() -> None:
    files = sorted([*SITE.glob("js/**/*.js"), *SITE.glob("css/**/*.css")])
    done: set[Path] = set()
    order: list[Path] = []

    def visit(p: Path, stack: tuple = ()) -> None:
        if p in done:
            return
        if p in stack:
            sys.exit(f"import cycle: {' -> '.join(x.name for x in stack + (p,))}")
        for d in refs(p):
            if not d.exists():
                sys.exit(f"{p.relative_to(SITE)} references missing {d}")
            if d.suffix in (".js", ".css"):
                visit(d, stack + (p,))
        done.add(p)
        order.append(p)

    for f in files:
        visit(f.resolve())
    changed = [p for p in order if stamp_file(p)]

    index = SITE / "index.html"
    html = index.read_text()
    new = HTML_REF.sub(lambda m: f"{m.group(1)}{m.group(2)}?v={h16(SITE / m.group(2))}{m.group(3)}", html)
    if new != html:
        index.write_text(new)
        changed.append(index)
    for p in changed:
        print(f"stamped {p.relative_to(SITE)}")
    if not changed:
        print("all stamps current")


if __name__ == "__main__":
    main()
