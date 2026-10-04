#!/usr/bin/env python3
"""Fetch every asset the showroom references (stamped URLs in index.html, js/, css/, the generated manifest, and the
three.js modules the viewer imports) from a running server and report anything that is not 200.

    make showroom-dev &   python3 tools/showroom/check_urls.py [http://127.0.0.1:8765/showroom/]
"""
import re
import sys
import urllib.request
from pathlib import Path
from urllib.parse import urljoin

SITE = Path(__file__).resolve().parents[2] / "static" / "showroom"
base = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8765/showroom/"
REF = re.compile(r"""["'(]((?:\.{1,2}/)?[\w./-]+\.(?:js|css|json|glb|hdr|webp|png|woff2|mp3))(\?v=[0-9a-f]{16})?["')]""")
BARE = re.compile(r"""from\s+'(three(?:/addons/[\w./-]+)?)'""")
IMPORTMAP = {"three": "/showroom/vendor/three/build/three.module.js", "three/addons/": "/showroom/vendor/three/addons/"}

urls = set()
for f in [SITE / "index.html", *SITE.glob("js/*.js"), *SITE.glob("css/*.css")]:
    text = f.read_text()
    page_rel = f.parent.relative_to(SITE).as_posix()
    for m in REF.finditer(text):
        rel, v = m.group(1), m.group(2) or ""
        if rel.startswith("."):
            urls.add(urljoin(urljoin(base, page_rel + "/" if page_rel != "." else ""), rel) + v)
        elif "/" in rel and not rel.startswith("three/"):
            urls.add(urljoin(base, rel) + v)
    for m in BARE.finditer(text):
        spec = m.group(1)
        urls.add(urljoin(base, IMPORTMAP["three"]) if spec == "three" else urljoin(base, IMPORTMAP["three/addons/"] + spec[len("three/addons/"):]))
# imports inside the vendored addons (relative)
for f in (SITE / "vendor/three/addons").rglob("*.js"):
    for m in re.finditer(r"""from\s+'(\.{1,2}/[\w./-]+)'""", f.read_text()):
        urls.add(urljoin(urljoin(base, f.relative_to(SITE).as_posix()), m.group(1)))

bad, total = [], 0
for u in sorted(urls):
    try:
        req = urllib.request.Request(u, method="HEAD")
        with urllib.request.urlopen(req, timeout=10) as r:
            total += int(r.headers.get("content-length") or 0)
            if r.status != 200:
                bad.append((r.status, u))
    except Exception as e:  # noqa: BLE001
        bad.append((getattr(e, "code", e), u))
print(f"{len(urls)} urls checked, {len(bad)} failing, {total / 1e6:.1f} MB referenced")
for code, u in bad:
    print(f"  {code}  {u}")
sys.exit(1 if bad else 0)
