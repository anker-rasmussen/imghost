#!/usr/bin/env python3
"""Re-encode a ship / room glb's textures as KTX2 (Basis UASTC level 2 + Zstandard, mipmapped) for the showroom.

    python3 tools/showroom/ktx2_encode.py <in.glb> <out.glb>

GPU-compressed textures stay compressed in VRAM (BC7 / ASTC / ETC2 after transcoding), ~4-6x less memory than the
WebP originals, which the GPU must hold fully decoded. Steps (all local, our own assets only):
  1. WebP -> PNG inside the glb (Pillow): the KTX tools only read PNG/JPEG
  2. gltf-transform uastc (KTX-Software `ktx create` under the hood; sRGB vs linear per glTF slot)
  3. gltf-transform meshopt --level medium (the exporter's own geometry compression, re-applied)
Tools: KTX-Software at ~/.local/opt/ktx (see static/showroom/vendor/VENDORED.md), @gltf-transform/cli via npx.
Run heavy batches with nice -n 19; --jobs bounds concurrent encoders.
"""
import io
import json
import os
import struct
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image

KTX_BIN = Path.home() / ".local" / "opt" / "ktx" / "bin"
JOBS = os.environ.get("KTX_JOBS", "2")


def read_glb(p):
    b = Path(p).read_bytes()
    assert b[:4] == b"glTF", p
    n = struct.unpack("<I", b[12:16])[0]
    j = json.loads(b[20:20 + n])
    off = 20 + n
    ln = struct.unpack("<I", b[off:off + 4])[0]
    return j, bytearray(b[off + 8:off + 8 + ln])


def write_glb(p, j, bin_):
    while len(bin_) % 4:
        bin_ += b"\0"
    js = json.dumps(j, separators=(",", ":")).encode()
    js += b" " * ((4 - len(js) % 4) % 4)
    total = 12 + 8 + len(js) + 8 + len(bin_)
    j["buffers"][0]["byteLength"] = len(bin_)
    js = json.dumps(j, separators=(",", ":")).encode()
    js += b" " * ((4 - len(js) % 4) % 4)
    total = 12 + 8 + len(js) + 8 + len(bin_)
    with open(p, "wb") as f:
        f.write(b"glTF" + struct.pack("<II", 2, total))
        f.write(struct.pack("<I", len(js)) + b"JSON" + js)
        f.write(struct.pack("<I", len(bin_)) + b"BIN\0" + bytes(bin_))


def webp_to_png(src, dst):
    j, bin_ = read_glb(src)
    for img in j.get("images", []):
        if img.get("mimeType") != "image/webp":
            continue
        bv = j["bufferViews"][img["bufferView"]]
        data = bytes(bin_[bv.get("byteOffset", 0):bv.get("byteOffset", 0) + bv["byteLength"]])
        with Image.open(io.BytesIO(data)) as im:
            out = io.BytesIO()
            im.save(out, "PNG", compress_level=1)
        while len(bin_) % 4:
            bin_ += b"\0"
        j["bufferViews"].append({"buffer": 0, "byteOffset": len(bin_), "byteLength": out.tell()})
        bin_ += out.getvalue()
        img["bufferView"] = len(j["bufferViews"]) - 1
        img["mimeType"] = "image/png"
    for t in j.get("textures", []):
        ext = (t.get("extensions") or {}).pop("EXT_texture_webp", None)
        if ext is not None:
            t["source"] = ext["source"]
        if t.get("extensions") == {}:
            del t["extensions"]
    for key in ("extensionsUsed", "extensionsRequired"):
        if key in j:
            j[key] = [e for e in j[key] if e != "EXT_texture_webp"]
            if not j[key]:
                del j[key]
    write_glb(dst, j, bin_)


def gt(*args):
    env = dict(os.environ, PATH=f"{KTX_BIN}:{os.environ['PATH']}")
    r = subprocess.run(["nice", "-n", "19", "npx", "-y", "@gltf-transform/cli", *args], capture_output=True, text=True, env=env)
    if r.returncode:
        sys.exit(f"gltf-transform {args[0]} failed:\n{r.stderr[-800:]}")


def main():
    src, dst = sys.argv[1:3]
    with tempfile.TemporaryDirectory(dir=Path(dst).parent) as td:
        a, b = Path(td) / "a.glb", Path(td) / "b.glb"
        webp_to_png(src, a)
        gt("uastc", str(a), str(b), "--level", "2", "--zstd", "18", "--jobs", JOBS)
        gt("meshopt", str(b), dst, "--level", "medium")
    print(f"{Path(src).name}: {Path(src).stat().st_size / 1e6:.1f} MB -> {Path(dst).stat().st_size / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
