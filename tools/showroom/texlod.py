#!/usr/bin/env python3
"""Texture LODs for a ship glb: a base glb with every texture capped at 1024 px, plus standalone WebP files at 2048 px
and full resolution for the textures that are larger. The viewer loads the base glb for every hull and streams the
larger textures only for hulls that are big on screen (always for the focused one), so both download and VRAM scale
with what is actually seen.

    python3 tools/showroom/texlod.py <src.glb> <out_base.glb> <lod_dir> [quality]

Resampling: Lanczos in linear light for colour / emissive (sRGB decoded first), straight Lanczos for data maps
(ORM), Lanczos + per-texel renormalisation for tangent-space normal maps, premultiplied alpha for textures with
transparency (decals) so edges do not halo. The full-resolution LOD is the original WebP, byte for byte.
Geometry, meshopt streams, materials and node extras are copied untouched; the BIN chunk is compacted.
"""
from __future__ import annotations

import io
import json
import struct
import sys
from pathlib import Path

import numpy as np
from PIL import Image

LEVELS = (1024, 2048)
ALIGN = 16


def read_glb(p):
    b = Path(p).read_bytes()
    n = struct.unpack("<I", b[12:16])[0]
    j = json.loads(b[20:20 + n])
    off = 20 + n
    ln = struct.unpack("<I", b[off:off + 4])[0]
    return j, b[off + 8:off + 8 + ln]


def write_glb(p, j, bin_):
    bin_ = bytes(bin_) + b"\0" * ((4 - len(bin_) % 4) % 4)
    j["buffers"][0]["byteLength"] = len(bin_)
    js = json.dumps(j, separators=(",", ":")).encode()
    js += b" " * ((4 - len(js) % 4) % 4)
    total = 12 + 8 + len(js) + 8 + len(bin_)
    with open(p, "wb") as f:
        f.write(b"glTF" + struct.pack("<II", 2, total))
        f.write(struct.pack("<I", len(js)) + b"JSON" + js)
        f.write(struct.pack("<I", len(bin_)) + b"BIN\0" + bin_)


def image_slots(j):
    """image index -> set of material slots that use it (colour / emissive / normal / data)"""
    tex_src = {}
    for i, t in enumerate(j.get("textures", [])):
        src = t.get("source", (t.get("extensions") or {}).get("EXT_texture_webp", {}).get("source"))
        tex_src[i] = src
    slots = {}
    for m in j.get("materials", []):
        pbr = m.get("pbrMetallicRoughness", {})
        for key, kind in ((pbr.get("baseColorTexture"), "color"), (m.get("emissiveTexture"), "color"),
                          (m.get("normalTexture"), "normal"), (pbr.get("metallicRoughnessTexture"), "data"),
                          (m.get("occlusionTexture"), "data")):
            if key is not None:
                slots.setdefault(tex_src[key["index"]], set()).add(kind)
    return slots


def srgb_to_lin(x):
    return np.where(x <= 0.04045, x / 12.92, ((x + 0.055) / 1.055) ** 2.4)


def lin_to_srgb(x):
    x = np.clip(x, 0, 1)
    return np.where(x <= 0.0031308, x * 12.92, 1.055 * np.power(x, 1 / 2.4) - 0.055)


def resize(im: Image.Image, size, kind):
    w, h = im.size
    s = size / max(w, h)
    nw, nh = max(1, round(w * s)), max(1, round(h * s))
    a = np.asarray(im.convert("RGBA"), dtype=np.float32) / 255.0
    rgb, alpha = a[..., :3], a[..., 3:4]
    has_alpha = alpha.min() < 1.0
    if kind == "color":
        rgb = srgb_to_lin(rgb)
    if has_alpha:
        rgb = rgb * alpha
    chans = [rgb[..., c] for c in range(3)] + ([alpha[..., 0]] if has_alpha else [])
    out = [np.asarray(Image.fromarray(c.astype(np.float32), "F").resize((nw, nh), Image.LANCZOS)) for c in chans]
    rgb2 = np.stack(out[:3], -1)
    if has_alpha:
        al = np.clip(out[3], 0, 1)[..., None]
        rgb2 = np.where(al > 1e-4, rgb2 / np.maximum(al, 1e-4), 0)
    if kind == "color":
        rgb2 = lin_to_srgb(rgb2)
    elif kind == "normal":
        v = rgb2 * 2 - 1
        v /= np.maximum(np.linalg.norm(v, axis=-1, keepdims=True), 1e-6)
        rgb2 = v * 0.5 + 0.5
    rgb2 = np.clip(rgb2, 0, 1)
    if has_alpha:
        arr = np.concatenate([rgb2, al], -1)
        return Image.fromarray((arr * 255 + 0.5).astype(np.uint8), "RGBA")
    return Image.fromarray((rgb2 * 255 + 0.5).astype(np.uint8), "RGB")


def encode_webp(im, quality):
    buf = io.BytesIO()
    im.save(buf, "WEBP", quality=quality, method=6, exact=True)
    return buf.getvalue()


def build(src, out_base, lod_dir, quality=82):
    j, bin_ = read_glb(src)
    slots = image_slots(j)
    lod_dir = Path(lod_dir)
    lod_dir.mkdir(parents=True, exist_ok=True)
    replace, lods = {}, []
    for i, img in enumerate(j.get("images", [])):
        bv = j["bufferViews"][img["bufferView"]]
        data = bin_[bv.get("byteOffset", 0):bv.get("byteOffset", 0) + bv["byteLength"]]
        with Image.open(io.BytesIO(data)) as im:
            im.load()
            w, h = im.size
            kinds = slots.get(i, {"data"})
            kind = "normal" if "normal" in kinds else "color" if "color" in kinds else "data"
            if max(w, h) <= LEVELS[0]:
                continue
            files = {}
            name = (img.get("name") or f"img{i}").replace("/", "_")
            if max(w, h) > LEVELS[1]:
                p = lod_dir / f"{i:02d}_{name}@2048.webp"
                p.write_bytes(encode_webp(resize(im, LEVELS[1], kind), quality))
                files["2048"] = p
                full = lod_dir / f"{i:02d}_{name}@full.webp"
                full.write_bytes(data)
                files["full"] = full
            else:
                full = lod_dir / f"{i:02d}_{name}@full.webp"
                full.write_bytes(data)
                files["2048"] = full
            replace[img["bufferView"]] = encode_webp(resize(im, LEVELS[0], kind), quality)
            lods.append({"image": i, "name": img.get("name"), "kind": kind, "size": max(w, h), "files": files})
    # compact the BIN: every live byte range (plain bufferViews and meshopt streams in buffer 0), replaced images
    out = bytearray()
    def put(data):
        out.extend(b"\0" * ((ALIGN - len(out) % ALIGN) % ALIGN))
        off = len(out)
        out.extend(data)
        return off
    for i, bv in enumerate(j["bufferViews"]):
        ext = (bv.get("extensions") or {}).get("EXT_meshopt_compression")
        if ext is not None and ext.get("buffer", 0) == 0:
            ext["byteOffset"] = put(bin_[ext.get("byteOffset", 0):ext.get("byteOffset", 0) + ext["byteLength"]])
        if bv.get("buffer", 0) == 0:
            data = replace.get(i, bin_[bv.get("byteOffset", 0):bv.get("byteOffset", 0) + bv["byteLength"]])
            bv["byteOffset"] = put(data)
            bv["byteLength"] = len(data)
    write_glb(out_base, j, out)
    return lods


if __name__ == "__main__":
    q = int(sys.argv[4]) if len(sys.argv) > 4 else 82
    res = build(sys.argv[1], sys.argv[2], sys.argv[3], q)
    print(json.dumps([{k: (str(v) if k != "files" else {a: str(b) for a, b in v.items()}) for k, v in r.items()} for r in res], indent=1))
