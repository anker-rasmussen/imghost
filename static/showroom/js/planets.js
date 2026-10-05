// Exterior-mode worlds: Earth from the Aurelia film plate, procedural Mars / Moon / Mercury painted into canvases at
// first use (seamless in longitude, ~1k px, cached), plus a Fresnel atmosphere shell. No downloads beyond our own plate.
import * as THREE from 'three';

const cache = new Map();

// ------------------------------------------------------------------ seamless value noise (period 1 in u)
function makeNoise(seed) {
  const P = 256, perm = new Uint8Array(P * 2), val = new Float32Array(P);
  let s = seed >>> 0 || 1;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < P; i++) { perm[i] = i; val[i] = rnd(); }
  for (let i = P - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [perm[i], perm[j]] = [perm[j], perm[i]]; }
  for (let i = 0; i < P; i++) perm[P + i] = perm[i];
  const h = (x, y) => val[perm[(perm[x & 255] + y) & 255]];
  const fade = (t) => t * t * (3 - 2 * t);
  // u wraps with period `px` lattice cells
  const noise = (u, v, px) => {
    const x = u * px, y = v * px;
    const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
    const x0 = ((xi % px) + px) % px, x1 = (x0 + 1) % px;
    const a = h(x0, yi), b = h(x1, yi), c = h(x0, yi + 1), d = h(x1, yi + 1);
    const fx = fade(xf), fy = fade(yf);
    return (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy;
  };
  const fbm = (u, v, base, oct, gain = 0.5) => {
    let sum = 0, amp = 1, norm = 0, px = base;
    for (let o = 0; o < oct; o++) { sum += amp * noise(u, v, px); norm += amp; amp *= gain; px *= 2; }
    return sum / norm;
  };
  return { fbm, rnd };
}

const STYLE = {
  mars: { seed: 4, lo: [92, 38, 24], hi: [206, 112, 66], dark: [70, 36, 26], maria: 0.42, craters: 90, caps: true, dust: 0.08 },
  moon: { seed: 9, lo: [120, 118, 114], hi: [196, 193, 186], dark: [70, 70, 72], maria: 0.46, craters: 420, rays: 6 },
  mercury: { seed: 17, lo: [104, 95, 86], hi: [178, 166, 150], dark: [84, 78, 72], maria: 0.3, craters: 520, rays: 3 },
};

/** { map, bump } canvases for a procedural body */
function paint(kind) {
  const st = STYLE[kind], W = 1024, H = 512;
  const { fbm, rnd } = makeNoise(st.seed);
  const alb = new Float32Array(W * H * 3), hgt = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    const v = y / H, lat = (v - 0.5) * Math.PI;
    for (let x = 0; x < W; x++) {
      const u = x / W;
      const n = fbm(u, v * 0.5, 6, 6);                 // terrain
      const m = fbm(u + 0.37, v * 0.5 + 0.11, 3, 4);   // large albedo provinces (maria / dark regions)
      let t = Math.min(1, Math.max(0, (n - 0.25) * 1.9));
      const dark = Math.min(1, Math.max(0, (st.maria - m) * 6));
      const i = (y * W + x) * 3;
      for (let c = 0; c < 3; c++) {
        let col = st.lo[c] + (st.hi[c] - st.lo[c]) * t;
        col = col * (1 - dark * 0.75) + st.dark[c] * dark * 0.75;
        alb[i + c] = col;
      }
      if (st.dust) {                                    // Martian dust bands
        const band = 0.5 + 0.5 * Math.sin(lat * 7 + fbm(u, v, 2, 3) * 6);
        for (let c = 0; c < 3; c++) alb[i + c] *= 1 - st.dust + st.dust * band * 1.6;
      }
      if (st.caps) {                                    // polar caps
        const cap = Math.min(1, Math.max(0, (Math.abs(lat) - 1.25 + (n - 0.5) * 0.25) * 6));
        for (let c = 0; c < 3; c++) alb[i + c] = alb[i + c] * (1 - cap) + 236 * cap;
      }
      hgt[y * W + x] = n * 0.6 - dark * 0.25;
    }
  }
  // craters: bowl + bright rim, a few with ray systems; widened by 1/cos(lat) so they stay round on the sphere
  for (let k = 0; k < st.craters; k++) {
    const cu = rnd(), cv = 0.08 + rnd() * 0.84, r0 = Math.pow(rnd(), 3) * 0.028 + 0.002;
    const lat = (cv - 0.5) * Math.PI, sx = 1 / Math.max(0.2, Math.cos(lat));
    const rx = Math.ceil(r0 * W * sx), ry = Math.ceil(r0 * W);
    const cx = Math.floor(cu * W), cy = Math.floor(cv * H);
    const ray = st.rays && k < st.rays;
    const R = ray ? 6 : 1.35;
    for (let dy = -Math.ceil(ry * R); dy <= Math.ceil(ry * R); dy++) {
      const y = cy + dy; if (y < 0 || y >= H) continue;
      for (let dx = -Math.ceil(rx * R); dx <= Math.ceil(rx * R); dx++) {
        const x = ((cx + dx) % W + W) % W;
        const d = Math.hypot(dx / rx, dy / ry);
        const j = y * W + x, i = j * 3;
        if (d < 1) { hgt[j] -= 0.35 * (1 - d * d) * Math.min(1, r0 * 60); for (let c = 0; c < 3; c++) alb[i + c] *= 0.88 + 0.08 * d; }
        else if (d < 1.35) { const rim = 1 - Math.abs(d - 1.12) / 0.23; hgt[j] += 0.18 * rim * Math.min(1, r0 * 60); for (let c = 0; c < 3; c++) alb[i + c] = Math.min(255, alb[i + c] * (1 + 0.18 * rim)); }
        else if (ray) {
          const ang = Math.atan2(dy, dx), streak = Math.pow(Math.max(0, Math.sin(ang * 9 + k)), 12) * (1 - (d - 1.35) / (R - 1.35));
          for (let c = 0; c < 3; c++) alb[i + c] = Math.min(255, alb[i + c] + 45 * streak);
        }
      }
    }
  }
  const toCanvas = (fill) => {
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const g = cv.getContext('2d'), img = g.createImageData(W, H);
    fill(img.data); g.putImageData(img, 0, 0); return cv;
  };
  const map = toCanvas((d) => { for (let j = 0; j < W * H; j++) { d[j * 4] = alb[j * 3]; d[j * 4 + 1] = alb[j * 3 + 1]; d[j * 4 + 2] = alb[j * 3 + 2]; d[j * 4 + 3] = 255; } });
  let lo = Infinity, hi = -Infinity;
  for (const v of hgt) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  const bump = toCanvas((d) => { for (let j = 0; j < W * H; j++) { const v = 255 * (hgt[j] - lo) / (hi - lo || 1); d[j * 4] = d[j * 4 + 1] = d[j * 4 + 2] = v; d[j * 4 + 3] = 255; } });
  return { map, bump };
}

const ATMO = { earth: [[0.35, 0.62, 1.0], 1.35], mars: [[1.0, 0.62, 0.42], 0.45] };

/** Fresnel glow shell, brighter on the lit side (log-depth aware) */
function atmosphere(radius, kind) {
  const [col, strength] = ATMO[kind];
  return new THREE.Mesh(new THREE.SphereGeometry(radius * 1.028, 96, 64), new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(...col) }, uSun: { value: new THREE.Vector3(0, 1, 0) }, uStrength: { value: strength } },
    vertexShader: `#include <common>
      #include <logdepthbuf_pars_vertex>
      varying vec3 vN; varying vec3 vV; varying vec3 vW;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz); vW = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * mv;
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: `#include <logdepthbuf_pars_fragment>
      uniform vec3 uColor; uniform vec3 uSun; uniform float uStrength;
      varying vec3 vN; varying vec3 vV; varying vec3 vW;
      void main() {
        #include <logdepthbuf_fragment>
        float f = pow(1.0 - clamp(dot(vN, vV), 0.0, 1.0), 2.6);
        float day = smoothstep(-0.35, 0.55, dot(vW, normalize(uSun)));
        gl_FragColor = vec4(uColor * f * (0.12 + day) * uStrength, 1.0);
      }`,
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
  }));
}

/** A lit world for exterior mode. kind: earth | mars | moon | mercury */
export function buildPlanet(kind, radius, { earthUrl } = {}) {
  const group = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0, envMapIntensity: 0 });
  if (kind === 'earth' && earthUrl) {
    const tex = new THREE.TextureLoader().load(earthUrl);
    tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
    Object.assign(mat, { map: tex, roughness: 0.75 });
  } else if (STYLE[kind]) {
    if (!cache.has(kind)) {
      const { map, bump } = paint(kind);
      const m = new THREE.CanvasTexture(map); m.colorSpace = THREE.SRGBColorSpace; m.anisotropy = 4;
      const b = new THREE.CanvasTexture(bump);
      cache.set(kind, { m, b });
    }
    const { m, b } = cache.get(kind);
    Object.assign(mat, { map: m, bumpMap: b, bumpScale: 4 });
  }
  // worlds are lit only by the exterior key (no hall probe): a darker albedo keeps them from blowing out under AgX
  mat.color.setScalar(kind === 'earth' ? 0.16 : 0.22);
  const body = new THREE.Mesh(new THREE.SphereGeometry(radius, 128, 96), mat);
  body.rotation.y = Math.PI * 0.85;                    // the texture seam faces away from the hall
  group.add(body);
  let atmo = null;
  if (ATMO[kind]) { atmo = atmosphere(radius, kind); group.add(atmo); }
  return {
    group,
    setSun(dir) { if (atmo) atmo.material.uniforms.uSun.value.copy(dir); },
    dispose() { body.geometry.dispose(); mat.map && kind === 'earth' && mat.map.dispose(); mat.dispose(); if (atmo) { atmo.geometry.dispose(); atmo.material.dispose(); } },
  };
}
