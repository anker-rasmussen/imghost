#!/usr/bin/env python3
"""Sync the fleet showroom's assets from the Blender universe repo into static/showroom/assets/ and write
static/showroom/js/data.js (canon from fleet.canon.json + every asset that exists, with content-hashed URLs).

    python3 tools/showroom/sync_assets.py            # or: make showroom-build

Idempotent and cheap to re-run: files are only re-copied / re-encoded when the source is newer. Ships whose export is
still running (no meta.json yet) and rooms that are incomplete are skipped, so the site always builds against whatever
is finished. Run tools/showroom/stamp.py afterwards (the Makefile target does both).

Env: BLENDER_REPO (default ../blender next to this repo), FONTTOOLS_PYTHON (a python with fontTools+brotli, only
needed when a webfont is missing).
"""
from __future__ import annotations

import glob
import hashlib
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
TOOLS = Path(__file__).resolve().parent
SITE = ROOT / "static" / "showroom"
ASSETS = SITE / "assets"
BLENDER = Path(os.environ.get("BLENDER_REPO", ROOT.parent / "blender"))
U = BLENDER / "universe"
RENDERS = U / "renders"
SHIPS_SRC = U / "web" / "ships"
ROOMS_SRC = U / "web" / "showroom"

POSTER_W = (1280, 640)
POSTER_Q = 76
SIL_W = 1200

# webfonts: (source ttf, output name). Subset to Latin + punctuation; variable axes are kept.
FONTS = [
    (U / "fonts" / "Jost.ttf", "jost"),
    (U / "fonts" / "CormorantGaramond.ttf", "cormorant"),
    (U / "fonts" / "ShareTechMono-Regular.ttf", "sharetechmono"),
    (U / "fonts" / "Cinzel.ttf", "cinzel"),
    (U / "fonts" / "SairaStencilOne-Regular.ttf", "sairastencil"),
    (U / "fonts" / "BarlowCondensed-Medium.ttf", "barlowcond-500"),
    (U / "fonts" / "BarlowCondensed-SemiBold.ttf", "barlowcond-600"),
    (U / "fonts" / "BlackOpsOne-Regular.ttf", "blackops"),
    (U / "fonts" / "PlayfairDisplay.ttf", "playfair"),
    (U / "fonts" / "PlayfairDisplay-Italic.ttf", "playfair-italic"),
    (TOOLS / "fonts" / "Michroma-Regular.ttf", "michroma"),
]
UNICODES = "U+0020-007E,U+00A0-00FF,U+0131,U+0152-0153,U+02C6,U+02DA,U+02DC,U+2000-206F,U+2070-209F,U+20AC," \
           "U+2122,U+2190-2199,U+2212,U+2215,U+2248,U+2260,U+2264-2265,U+25A0-25FF"

log = lambda *a: print(*a, flush=True)


def fresh(src: Path, dst: Path) -> bool:
    return dst.exists() and dst.stat().st_mtime >= src.stat().st_mtime


def h16(p: Path) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()[:16]


def url(p: Path) -> str:
    """Site-relative, content-hashed URL (the edge caches static files for hours)."""
    return f"{p.relative_to(SITE).as_posix()}?v={h16(p)}"


def copy(src: Path, dst: Path) -> Path:
    if not fresh(src, dst):
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)
        log(f"  copy {src.name} -> {dst.relative_to(SITE)} ({dst.stat().st_size / 1e6:.1f} MB)")
    return dst


def webp(src: Path, dst: Path, width: int, q: int = POSTER_Q) -> Path:
    if fresh(src, dst):
        return dst
    dst.parent.mkdir(parents=True, exist_ok=True)
    with Image.open(src) as im:
        im = im.convert("RGB")
        if im.width > width:
            im = im.resize((width, round(im.height * width / im.width)), Image.LANCZOS)
        im.save(dst, "WEBP", quality=q, method=6)
    log(f"  webp {src.name} -> {dst.relative_to(SITE)} ({dst.stat().st_size / 1e3:.0f} kB)")
    return dst


def alpha_mask(src: Path, dst: Path, width: int) -> Path:
    """White-on-alpha logo / mark, cropped to its alpha bbox (tinted in CSS with mask-image)."""
    if fresh(src, dst):
        return dst
    dst.parent.mkdir(parents=True, exist_ok=True)
    with Image.open(src) as im:
        a = im.convert("RGBA").getchannel("A")
        a = a.crop(a.getbbox())
        if a.width > width:
            a = a.resize((width, round(a.height * width / a.width)), Image.LANCZOS)
        out = Image.new("RGBA", a.size, (255, 255, 255, 0))
        out.putalpha(a)
        out.save(dst, "WEBP", lossless=True, quality=100, method=6)
    log(f"  mask {src.name} -> {dst.relative_to(SITE)} ({dst.stat().st_size / 1e3:.0f} kB)")
    return dst


def save_silhouette(mask: Image.Image, dst: Path) -> None:
    mask = mask.crop(mask.getbbox())
    if mask.width > SIL_W:
        mask = mask.resize((SIL_W, max(1, round(mask.height * SIL_W / mask.width))), Image.LANCZOS)
    out = Image.new("RGBA", mask.size, (255, 255, 255, 0))
    out.putalpha(mask)
    dst.parent.mkdir(parents=True, exist_ok=True)
    out.save(dst, "WEBP", lossless=True, quality=100, method=6)


def silhouette_from_glb(glb: Path, dst: Path) -> bool:
    if fresh(glb, dst):
        return True
    pgm = dst.with_suffix(".pgm")
    try:
        subprocess.run(["node", str(TOOLS / "glb_silhouette.mjs"), str(glb), str(pgm), str(SIL_W)],
                       check=True, capture_output=True, text=True, timeout=120)
        with Image.open(pgm) as im:
            save_silhouette(im.convert("L"), dst)
        log(f"  silhouette (glb) {glb.name} -> {dst.relative_to(SITE)}")
        return True
    except (subprocess.SubprocessError, OSError) as e:
        log(f"  ! silhouette from {glb.name} failed: {e}")
        return False
    finally:
        pgm.unlink(missing_ok=True)


def silhouette_from_render(png: Path, dst: Path, flip: bool, crop: list | None) -> bool:
    """v2_*_silhouette.png: black on white, side view above top view. Keep the side view, nose to the left
    (canon `sil_flip` for sheets drawn nose-right, `sil_crop` [x0,y0,x1,y1] fractions where the views overlap)."""
    if fresh(png, dst) and dst.stat().st_mtime >= (TOOLS / "fleet.canon.json").stat().st_mtime:
        return True
    with Image.open(png) as im:
        g = im.convert("L")
    if crop:
        w, h = g.size
        g = g.crop((round(crop[0] * w), round(crop[1] * h), round(crop[2] * w), round(crop[3] * h)))
    ink = g.point(lambda v: 255 if v < 128 else 0)
    w, h = ink.size
    rows = [ink.crop((0, y, w, y + 1)).getbbox() is not None for y in range(h)]
    bands, start = [], None
    for y, r in enumerate(rows + [False]):
        if r and start is None:
            start = y
        elif not r and start is not None:
            bands.append((start, y))
            start = None
    if not bands:
        return False
    if len(bands) > 1:  # split at the widest empty gap: everything above it is the side view
        gaps = [(bands[i + 1][0] - bands[i][1], i) for i in range(len(bands) - 1)]
        cut = max(gaps)[1]
        top, bottom = bands[0][0], bands[cut][1]
    else:
        top, bottom = bands[0]
    side = ink.crop((0, top, w, bottom))
    if flip:
        side = side.transpose(Image.FLIP_LEFT_RIGHT)
    save_silhouette(side, dst)
    log(f"  silhouette (render) {png.name} -> {dst.relative_to(SITE)}")
    return True


def fonts() -> dict:
    out = {}
    py = os.environ.get("FONTTOOLS_PYTHON", sys.executable)
    for src, name in FONTS:
        dst = ASSETS / "fonts" / f"{name}.woff2"
        if not dst.exists():
            if not src.exists():
                log(f"  ! font source missing: {src}")
                continue
            dst.parent.mkdir(parents=True, exist_ok=True)
            r = subprocess.run([py, "-m", "fontTools.subset", str(src), f"--output-file={dst}", "--flavor=woff2",
                                f"--unicodes={UNICODES}", "--layout-features=*", "--no-hinting",
                                "--desubroutinize"], capture_output=True, text=True)
            if r.returncode:
                log(f"  ! font subset failed for {src.name} (set FONTTOOLS_PYTHON to a python with fontTools+brotli)")
                log(r.stderr[-400:])
                continue
            log(f"  font {src.name} -> {dst.relative_to(SITE)} ({dst.stat().st_size / 1e3:.0f} kB)")
        out[name] = url(dst)
    lic = ASSETS / "fonts" / "LICENSES.md"
    if (U / "fonts" / "LICENSES.md").exists():
        text = (U / "fonts" / "LICENSES.md").read_text()
        text += ("| Michroma-Regular.ttf | Michroma | Atlantia wordmark / showroom display | "
                 "The Michroma Project Authors |\n\nWeb copies are Latin subsets converted to WOFF2.\n")
        lic.write_text(text)
    return out


def size_class(classes: list, length: float) -> dict:
    return next(c for c in classes if length <= c["max"])


def first(patterns: list[str]) -> Path | None:
    for p in patterns:
        hits = sorted(glob.glob(str(RENDERS / p)))
        if hits:
            return Path(hits[0])
    return None


def ship_entry(canon: dict, s: dict, manifest: dict) -> dict:
    mk, M = s["maker"], s["model"]
    c = size_class(canon["size_classes"], s["length"])
    e = {**{k: v for k, v in s.items() if not k.startswith("sil_")}, "id": M.lower(), "class": c["name"], "crew": c["crew"], "poster": None, "silhouette": None, "glb": None}

    # poster still
    src = first([f"{mk}_v2_hero_{M}.png", f"v2_{mk}_{M}_hero.png", f"{mk}_capital_hero_{M}.png",
                 f"{mk}_hero_{M}.png", f"{mk}_hero_{M}_a.png", f"{mk}_hero_{M}_*.png"])
    if src:
        big = webp(src, ASSETS / "posters" / mk / f"{M}.webp", POSTER_W[0])
        small = webp(src, ASSETS / "posters" / mk / f"{M}-640.webp", POSTER_W[1], 72)
        with Image.open(big) as im:
            e["poster"] = {"src": url(big), "small": url(small), "w": im.width, "h": im.height}

    # real-time model: only once the exporter has written its meta.json (a glb without one may be mid-write)
    meta_p = SHIPS_SRC / M / "meta.json"
    glb_src = SHIPS_SRC / M / f"{M}.glb"
    meta = manifest.get(M)
    if meta is None and meta_p.exists():
        meta = json.loads(meta_p.read_text())
    if meta and glb_src.exists():
        glb = copy(glb_src, ASSETS / "ships" / f"{M}.glb")
        kinds = {}
        for a in meta.get("light_anchors", []):
            k = a.get("extras", {}).get("kind", "")
            kinds[k] = kinds.get(k, 0) + 1
        mats = [m["name"] for m in meta.get("materials", [])]
        e["glb"] = {"src": url(glb), "bytes": glb.stat().st_size, "tris": meta.get("tris"),
                    "draw_calls": meta.get("draw_calls"), "has_gear": bool(meta.get("has_gear")),
                    "export_length": meta.get("length"), "lights": kinds,
                    "retro": "retro_glow" in mats or "retro_plume" in mats}

    # exporter thumbnail (small turntable still): shown where no studio poster exists yet
    th = SHIPS_SRC / M / "thumb.png"
    e["thumb"] = None
    if th.exists():
        dst_t = webp(th, ASSETS / "thumbs" / f"{M}.webp", 640, 76)
        with Image.open(dst_t) as im:
            e["thumb"] = {"src": url(dst_t), "small": url(dst_t), "w": im.width, "h": im.height}
        if not e["poster"]:
            e["poster"] = e["thumb"]

    # silhouette: crisp from the glb when there is one, else from the concept sheet
    dst = ASSETS / "silhouettes" / f"{M}.webp"
    ok = False
    if e["glb"] and s.get("sil_source") != "render":   # canon can force the concept sheet (very dense hulls)
        ok = silhouette_from_glb(glb_src, dst)
    if not ok:
        png = RENDERS / f"v2_{mk}_{M}_silhouette.png"
        ok = png.exists() and silhouette_from_render(png, dst, s.get("sil_flip", False), s.get("sil_crop"))
    if ok and dst.exists():
        with Image.open(dst) as im:
            e["silhouette"] = {"src": url(dst), "aspect": round(im.height / im.width, 4)}

    for line in s.get("hail", []):
        line["src"] = url(ASSETS / line["src"])
    return e


def room_entry(mid: str) -> dict | None:
    d = ROOMS_SRC / mid
    need = ["room.glb", "env.hdr", "bg.hdr", "showroom.json"]
    if not all((d / f).exists() for f in need):
        return None
    info = json.loads((d / "showroom.json").read_text())
    files = {f: copy(d / f, ASSETS / "rooms" / mid / f) for f in need[:3]}
    return {"glb": url(files["room.glb"]), "env": url(files["env.hdr"]), "bg": url(files["bg.hdr"]),
            "bytes": sum(p.stat().st_size for p in files.values()), "info": info}


def main() -> None:
    if not U.exists():
        sys.exit(f"universe not found at {U} (set BLENDER_REPO)")
    canon = json.loads((TOOLS / "fleet.canon.json").read_text())
    manifest = {}
    mp = SHIPS_SRC / "manifest.json"
    if mp.exists():  # whole-fleet manifest, written once every export is complete
        m = json.loads(mp.read_text())
        for e in (m.get("ships") if isinstance(m, dict) else m) or []:
            if isinstance(e, dict) and e.get("model"):
                manifest[e["model"]] = e

    log("fonts")
    fonts()

    log("makers")
    makers = []
    for mk in canon["makers"]:
        mid = mk["id"]
        e = {k: v for k, v in mk.items() if k not in ("logo", "hero_render", "wide_render")}
        e["logo"] = url(alpha_mask(BLENDER / mk["logo"]["src"], ASSETS / "brands" / mid / "logo.webp", 1400))
        e["mark"] = url(alpha_mask(BLENDER / mk["logo"]["mark"], ASSETS / "brands" / mid / "mark.webp", 512))
        for key, name in (("hero_render", "hero"), ("wide_render", "wide")):
            src = RENDERS / mk[key]
            if src.exists():
                big = webp(src, ASSETS / "makers" / f"{mid}-{name}.webp", 1600)
                small = webp(src, ASSETS / "makers" / f"{mid}-{name}-640.webp", 640, 72)
                with Image.open(big) as im:
                    e[name] = {"src": url(big), "small": url(small), "w": im.width, "h": im.height}
            else:
                e[name] = None
        e["room"] = room_entry(mid)
        log(f"  {mid}: room {'yes' if e['room'] else 'not yet'}")
        makers.append(e)

    log("ships")
    ships = [ship_entry(canon, s, manifest) for s in canon["ships"]]
    for s in ships:
        log(f"  {s['maker']:9s} {s['model']:17s} glb={'yes' if s['glb'] else '-':3s} "
            f"poster={'yes' if s['poster'] else '-':3s} silhouette={'yes' if s['silhouette'] else '-'}")

    data = {"fleet": canon["fleet"], "makers": makers, "ships": ships}
    out = SITE / "js" / "data.js"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("// GENERATED by tools/showroom/sync_assets.py from tools/showroom/fleet.canon.json + the exported\n"
                   "// assets. Do not edit by hand: edit the canon and run `make showroom-build`.\n"
                   "export default " + json.dumps(data, indent=1, ensure_ascii=False) + ";\n")
    total = sum(p.stat().st_size for p in ASSETS.rglob("*") if p.is_file())
    log(f"wrote {out.relative_to(ROOT)}; assets total {total / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
