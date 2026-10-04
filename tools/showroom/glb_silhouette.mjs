// Side-view silhouette of a ship glb, rasterised from its triangles (no GPU, no three.js scene).
// usage: node glb_silhouette.mjs <in.glb> <out.pgm> [width=1200]
// Writes a binary PGM (255 = ship, 0 = empty), cropped to the ship's side extent: x = glTF +Z (nose, which points
// to -Z, ends up on the LEFT), y = glTF +Y. Skinned meshes (landing gear) and exhaust/FX meshes are skipped so the
// silhouette is the ship in flight. sync_assets.py converts the PGM into a WebP alpha mask.
import fs from 'node:fs';
import { MeshoptDecoder } from '../../static/showroom/vendor/three/addons/libs/meshopt_decoder.module.js';

const [, , inp, out, widthArg = '1200'] = process.argv;
const W = parseInt(widthArg, 10);
const buf = fs.readFileSync(inp);
const jsonLen = buf.readUInt32LE(12);
const json = JSON.parse(buf.toString('utf8', 20, 20 + jsonLen));
let bin = null;
for (let off = 20 + jsonLen; off < buf.length;) {
  const len = buf.readUInt32LE(off), type = buf.readUInt32LE(off + 4);
  if (type === 0x004e4942) bin = new Uint8Array(buf.buffer, buf.byteOffset + off + 8, len);
  off += 8 + len;
}
await MeshoptDecoder.ready;

const views = json.bufferViews.map((bv) => {
  const ext = bv.extensions?.EXT_meshopt_compression;
  if (ext) {
    const src = bin.slice(ext.byteOffset || 0, (ext.byteOffset || 0) + ext.byteLength);
    const dst = new Uint8Array(ext.count * ext.byteStride);
    MeshoptDecoder.decodeGltfBuffer(dst, ext.count, ext.byteStride, src, ext.mode, ext.filter);
    return dst;
  }
  if (!bin) return new Uint8Array(0);
  return bin.slice(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength);
});

const NCOMP = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
const CT = { 5120: [1, 'getInt8', 127], 5121: [1, 'getUint8', 255], 5122: [2, 'getInt16', 32767],
  5123: [2, 'getUint16', 65535], 5125: [4, 'getUint32', 0], 5126: [4, 'getFloat32', 0] };
function readAccessor(i) {
  const a = json.accessors[i], bv = json.bufferViews[a.bufferView], data = views[a.bufferView];
  const n = NCOMP[a.type], [size, getter, max] = CT[a.componentType];
  const stride = bv.byteStride || n * size;
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const outArr = new Float64Array(a.count * n);
  for (let k = 0; k < a.count; k++) {
    for (let j = 0; j < n; j++) {
      let v = dv[getter]((a.byteOffset || 0) + k * stride + j * size, true);
      if (a.normalized && max) v = Math.max(v / max, -1);
      outArr[k * n + j] = v;
    }
  }
  return outArr;
}

// column-major 4x4 helpers
const mul = (a, b) => {
  const o = new Float64Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]; o[c * 4 + r] = s;
  }
  return o;
};
function local(node) {
  if (node.matrix) return Float64Array.from(node.matrix);
  const [x, y, z, w] = node.rotation || [0, 0, 0, 1];
  const [sx, sy, sz] = node.scale || [1, 1, 1];
  const [tx, ty, tz] = node.translation || [0, 0, 0];
  return Float64Array.from([
    (1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0,
    2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0,
    2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
    tx, ty, tz, 1]);
}

const SKIP = /plume|rcs_glow|glow_card|flare/i;
const tris = [];                                  // flat [z0,y0,z1,y1,z2,y2, ...] in world metres
function visit(ni, parent) {
  const node = json.nodes[ni];
  const m = mul(parent, local(node));
  if (node.mesh !== undefined && node.skin === undefined) {
    for (const p of json.meshes[node.mesh].primitives) {
      const mat = p.material !== undefined ? json.materials[p.material].name || '' : '';
      if (SKIP.test(mat) || (p.mode !== undefined && p.mode !== 4)) continue;
      const pos = readAccessor(p.attributes.POSITION);
      const idx = p.indices !== undefined ? readAccessor(p.indices) : null;
      const count = idx ? idx.length : pos.length / 3;
      const P = (k) => {
        const x = pos[k * 3], y = pos[k * 3 + 1], z = pos[k * 3 + 2];
        return [m[2] * x + m[6] * y + m[10] * z + m[14], m[1] * x + m[5] * y + m[9] * z + m[13]];
      };
      for (let t = 0; t + 2 < count; t += 3) {
        const a = P(idx ? idx[t] : t), b = P(idx ? idx[t + 1] : t + 1), c = P(idx ? idx[t + 2] : t + 2);
        tris.push(a[0], a[1], b[0], b[1], c[0], c[1]);
      }
    }
  }
  for (const c of node.children || []) visit(c, m);
}
const I = Float64Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
for (const ni of json.scenes[json.scene || 0].nodes) visit(ni, I);

let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
for (let i = 0; i < tris.length; i += 2) {
  minX = Math.min(minX, tris[i]); maxX = Math.max(maxX, tris[i]);
  minY = Math.min(minY, tris[i + 1]); maxY = Math.max(maxY, tris[i + 1]);
}
const s = (W - 1) / (maxX - minX);
const H = Math.max(1, Math.ceil((maxY - minY) * s) + 1);
const img = new Uint8Array(W * H);
// scanline fill (pixel centres), y flipped so +Y is up in the image
for (let i = 0; i < tris.length; i += 6) {
  const px = [], py = [];
  for (let k = 0; k < 3; k++) { px.push((tris[i + 2 * k] - minX) * s); py.push((maxY - tris[i + 2 * k + 1]) * s); }
  const y0 = Math.max(0, Math.floor(Math.min(...py))), y1 = Math.min(H - 1, Math.ceil(Math.max(...py)));
  for (let y = y0; y <= y1; y++) {
    const yc = y + 0.5; let xa = Infinity, xb = -Infinity;
    for (let e = 0; e < 3; e++) {
      const ax = px[e], ay = py[e], bx = px[(e + 1) % 3], by = py[(e + 1) % 3];
      if ((ay <= yc && by >= yc) || (by <= yc && ay >= yc)) {
        const x = ay === by ? Math.min(ax, bx) : ax + (yc - ay) * (bx - ax) / (by - ay);
        const x2 = ay === by ? Math.max(ax, bx) : x;
        xa = Math.min(xa, x); xb = Math.max(xb, x2);
      }
    }
    if (xa > xb) { xa = Math.min(...px); xb = xa; if (Math.max(...py) - Math.min(...py) > 1) continue; }
    const r = y * W;
    for (let x = Math.max(0, Math.floor(xa)); x <= Math.min(W - 1, Math.floor(xb)); x++) img[r + x] = 255;
  }
}
fs.writeFileSync(out, Buffer.concat([Buffer.from(`P5\n${W} ${H}\n255\n`), Buffer.from(img)]));
console.log(JSON.stringify({ width: W, height: H, length_m: +(maxX - minX).toFixed(2), height_m: +(maxY - minY).toFixed(2) }));
