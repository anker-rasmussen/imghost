// Real-time showroom: a maker's baked room (emissive lightmaps + planar floor reflection + HDR probe) or, until a
// room is exported, a procedural studio in the maker's colours; the selected ship on the turntable with a real-time
// key-light shadow. Ships too big for the hall stand on a dealer pedestal as a 1:N scale model.
// Loaded lazily (dynamic import) the first time someone opens a showroom, so the landing page never pulls three.js.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { Reflector } from 'three/addons/objects/Reflector.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { rigShip } from './rig.js?v=886d45a05c4f8e20';
import { SafeKTX2Loader } from './ktx2.js?v=01483ad04d1ddd13';
import { buildPlanet } from './planets.js?v=880a9062e2d65f42';
import data from './data.js?v=6eccc3943f11efc8';

const v3 = (a) => new THREE.Vector3(a[0], a[1], a[2]);
/** raycaster that also sees layer 1 (the giants outside) */
function mkRay(...a) { const r = new THREE.Raycaster(...a); r.layers.enableAll(); return r; }
const IDLE_MS = 45000;                                 // loop sleeps after this long without input (wakes on any)
const CAM_MARGIN = 0.35;                                  // camera keeps this far from any hull box, wall or pillar
const _v = new THREE.Vector3();
const ease = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);

// ---------------------------------------------------------------- plan-view geometry (spin clearance)
/** convex hull of [x, z] points (monotone chain), counter-clockwise */
export function hull2(pts) {
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const q of p) { while (lo.length > 1 && cr(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (up.length > 1 && cr(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}
/** smallest enclosing circle of [x, z] points (Welzl, iterative): the spin axis of a hull and its swept radius */
export function minCircle(pts) {
  const P = pts.slice();
  for (let i = P.length - 1; i > 0; i--) { const j = (i * 7919) % (i + 1); [P[i], P[j]] = [P[j], P[i]]; }   // deterministic shuffle
  const in_ = (c, q) => Math.hypot(q[0] - c.x, q[1] - c.z) <= c.r + 1e-7;
  const two = (a, b) => ({ x: (a[0] + b[0]) / 2, z: (a[1] + b[1]) / 2, r: Math.hypot(a[0] - b[0], a[1] - b[1]) / 2 });
  const three = (a, b, c) => {
    const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
    if (Math.abs(d) < 1e-12) { const cs = [two(a, b), two(a, c), two(b, c)]; return cs.sort((u, v) => v.r - u.r)[0]; }
    const A = a[0] ** 2 + a[1] ** 2, B = b[0] ** 2 + b[1] ** 2, C = c[0] ** 2 + c[1] ** 2;
    const x = (A * (b[1] - c[1]) + B * (c[1] - a[1]) + C * (a[1] - b[1])) / d, z = (A * (c[0] - b[0]) + B * (a[0] - c[0]) + C * (b[0] - a[0])) / d;
    return { x, z, r: Math.hypot(a[0] - x, a[1] - z) };
  };
  let c = { x: 0, z: 0, r: -1 };
  for (let i = 0; i < P.length; i++) {
    if (c.r >= 0 && in_(c, P[i])) continue;
    c = { x: P[i][0], z: P[i][1], r: 0 };
    for (let j = 0; j < i; j++) {
      if (in_(c, P[j])) continue;
      c = two(P[i], P[j]);
      for (let k = 0; k < j; k++) if (!in_(c, P[k])) c = three(P[i], P[j], P[k]);
    }
  }
  return c;
}
/** distance from (x, z) to segment a-b */
function segDist(x, z, a, b) {
  const dx = b[0] - a[0], dz = b[1] - a[1], L = dx * dx + dz * dz;
  const k = L ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / L)) : 0;
  return Math.hypot(x - a[0] - k * dx, z - a[1] - k * dz);
}
/** is (x, z) inside the convex counter-clockwise polygon? */
export function inHull(x, z, H) {
  for (let i = 0, n = H.length; i < n; i++) {
    const a = H[i], b = H[(i + 1) % n];
    if ((b[0] - a[0]) * (z - a[1]) - (b[1] - a[1]) * (x - a[0]) < 0) return false;
  }
  return H.length > 2;
}

function disposeTree(root) {
  root.traverse((o) => {
    o.geometry?.dispose();
    const ms = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
    for (const m of ms) {
      for (const k of Object.keys(m)) { const v = m[k]; if (v && v.isTexture) v.dispose(); }
      m.dispose();
    }
  });
}

/** room description used when a maker has no baked room yet (same schema as showroom.json) */
function studioInfo() {
  return {
    turntable: { center: [0, 0.3, 0], radius: 15, top: 0.3, max_ship_length: 44 },
    camera: { position: [-26, 7.5, 30], target: [0, 4, 0], fov: 40, orbit_min_distance: 8, orbit_max_distance: 90, min_height: 0.9, max_height: 45 },
    key_light: { direction: [0.3, -1, 0.2], intensity: 2.6, color: [1, 0.97, 0.92] },
    fill_light: { direction: [0, 1, 0], intensity: 0.3, color: [1, 1, 1] },
    floor_reflect: 0.2, floor_blur: [3, 1.5], tone_mapping: { exposure: 1.0 }, ship: { yaw_deg: 150 },
    studio: true,
  };
}

export class Viewer {
  constructor(canvas, { onTap, onLost, onDrag, onHover } = {}) {
    this.canvas = canvas;
    // antialias off on the canvas: everything is drawn through the composer's 4x MSAA target, the canvas only receives
    // the final full-screen pass (a multisampled backbuffer there is pure resolve cost)
    const r = this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance',
      logarithmicDepthBuffer: true });   // 5 cm close-ups and 5 km giants in one depth buffer
    r.toneMapping = THREE.AgXToneMapping;
    r.shadowMap.enabled = true;
    r.shadowMap.autoUpdate = false;                     // re-rendered only when a caster moves (see tick)
    this.shadowDirty = 8;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    this.dprMax = Math.min(devicePixelRatio || 1, 2);   // native resolution; adaptive scaling only when over budget
    this.dpr = this.dprMax;
    r.setPixelRatio(this.dpr);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.05, 20000);
    this.camera.layers.enable(1);
    const c = this.controls = new OrbitControls(this.camera, canvas);
    c.enableDamping = true; c.dampingFactor = 0.06; c.rotateSpeed = 0.7;
    c.enablePan = true; c.screenSpacePanning = true; c.panSpeed = 0.7;
    c.maxPolarAngle = THREE.MathUtils.degToRad(89);

    // the composer renders off-screen, where the canvas' own antialias does not apply: give it 4x MSAA
    const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
    this.composer = new EffectComposer(r, rt);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.22, 0.5, 0.95);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    this.pmrem = new THREE.PMREMGenerator(r);
    // KTX2 (Basis UASTC) hull and room textures stay GPU-compressed in VRAM; WebP glbs still load as before
    this.ktx2 = new SafeKTX2Loader().setWorkerLimit(1).detectSupport(r);   // one in-page transcoder instance
    this.gltf = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).setKTX2Loader(this.ktx2);
    this.rgbe = new RGBELoader();
    this.clock = new THREE.Clock();
    this.room = null; this.ship = null; this.tween = null;
    this.spin = !matchMedia('(prefers-reduced-motion: reduce)').matches;
    this._S0 = { gearT: 1, gearDir: 1, nav: true, strobe: true, thrust: 0, retro: 0, retroTarget: 0, rcs: 0 };
    this.roomToken = 0; this.fleetToken = 0; this.fleet = null;
    this.running = false;
    this.slow = 0;
    this.perf = /[?&]perf=1\b/.test(location.search) ? { ms: [], submit: [], gpu: [], cpu: [], shown: 0 } : null;
    this.lodAll = /[?&]lod=full\b/.test(location.search);   // reference renders: every hull at full texture res

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(canvas);
    canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.stop(); onLost?.(); });
    // tap (not drag) on the ship
    let down = null;
    canvas.addEventListener('pointerdown', (e) => { down = [e.clientX, e.clientY]; });
    canvas.addEventListener('pointerup', (e) => {
      if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 6 || !this.fleet) return;
      const hit = this.pick(e.clientX, e.clientY);
      if (hit) onTap?.(hit.model);
    });
    // affordances: grab / grabbing cursor, pointer + rim highlight + "click to hail" over the hull
    c.addEventListener('start', () => { this.dragging = true; canvas.style.cursor = 'grabbing'; onDrag?.(); });
    for (const ev of ['pointerdown', 'pointermove', 'wheel', 'touchstart']) canvas.addEventListener(ev, () => this.poke(), { passive: true });
    addEventListener('keydown', () => this.poke());
    document.addEventListener('visibilitychange', () => { if (!document.hidden) this.poke(); });
    canvas.parentElement?.addEventListener('click', () => this.poke());   // HUD buttons (gear, lights, tour...)
    c.addEventListener('end', () => { this.dragging = false; canvas.style.cursor = ''; });
    let hoverAt = 0, hoverEv = null;
    canvas.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'touch') return;
      hoverEv = e;
      const now = performance.now();
      if (now - hoverAt < 90 || this.dragging || this.walk || !this.fleet) return;
      hoverAt = now;
      const rect = canvas.getBoundingClientRect();
      const hit = this.pick(e.clientX, e.clientY);
      if (this.hovered !== hit) { this.hovered?.rig?.setHighlight(0); hit?.rig?.setHighlight(1); this.hovered = hit; }
      canvas.style.cursor = hit ? 'pointer' : '';
      onHover?.(hit ? hit.model : null, e.clientX - rect.left, e.clientY - rect.top, hit === this.ship);
    });
    canvas.addEventListener('pointerleave', () => { this.hovered?.rig?.setHighlight(0); this.hovered = null; canvas.style.cursor = ''; onHover?.(null); void hoverEv; });

    // walk mode: drag to look (mouse or touch outside the virtual stick)
    let look = null;
    canvas.addEventListener('pointerdown', (e) => { if (this.walk) { look = [e.clientX, e.clientY]; canvas.setPointerCapture?.(e.pointerId); } });
    canvas.addEventListener('pointermove', (e) => {
      if (!this.walk || !look) return;
      const w = this.walk;
      w.yaw -= (e.clientX - look[0]) * 0.0032;
      w.pitch = THREE.MathUtils.clamp(w.pitch - (e.clientY - look[1]) * 0.0032, -1.25, 1.25);
      look = [e.clientX, e.clientY];
    });
    for (const ev of ['pointerup', 'pointercancel']) canvas.addEventListener(ev, () => { look = null; });
    this.resize();
  }

  /** the focused hull's system state (gear, lights, thrust...) */
  get S() { return this.ship?.S || this._S0; }

  // ---------------------------------------------------------------- lifecycle
  start() {
    this.lastInput = performance.now();
    this.sleeping = false;
    if (this.running) return;
    this.running = true; this.clock.getDelta();
    this.renderer.setAnimationLoop(() => this.tick());
  }
  stop() { this.running = false; this.renderer.setAnimationLoop(null); }

  /** any visitor input keeps the loop alive; after IDLE_MS at rest the loop stops on a full-resolution frame */
  poke() {
    this.lastInput = performance.now();
    if (this.sleeping && this.room) { this.sleeping = false; this.start(); }
  }

  resize() {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    this.camera.aspect = w / h;
    const fov = this.room?.info.camera.fov ?? 40;
    if (!this.ship?.outdoor && !this.walk) this.camera.fov = w / h < 0.8 ? Math.min(62, fov * 1.25) : fov;
    this.camera.updateProjectionMatrix();
    if (this.sleeping) this.redraw();
  }

  /** Open a maker's hall (if not already) and focus `ship`; progress(fraction, label) covers the room and the
   *  focused hull only; the rest of the line-up streams in afterwards. */
  async show(maker, ship, progress = () => {}, lineup = []) {
    this.maker = maker;
    this.lineup = lineup.length ? lineup : [ship];
    if (this.walk) this.setWalk(false);
    const needRoom = this.room?.id !== maker.id;
    const total = (needRoom && maker.room ? maker.room.bytes : 0) + (this.fleet?.get(ship.id)?.state === 'ready' ? 0 : ship.glb.bytes);
    const got = {};
    const tick = (key, label) => (e) => {
      if (!e.lengthComputable && !e.total) return;
      got[key] = e.loaded;
      const sum = Object.values(got).reduce((a, b) => a + b, 0);
      progress(Math.min(1, sum / Math.max(total, 1)), `${label} · ${(sum / 1e6).toFixed(1)} / ${(total / 1e6).toFixed(1)} MB`);
    };
    progress(0, 'Preparing');
    if (needRoom) {
      // start the focused hull download in parallel with the room
      const early = this.gltf.loadAsync(ship.glb.src, tick('ship', `Loading ${ship.name}`)).catch(() => null);
      await this.loadRoom(maker, tick);
      this.setupFleet(maker, ship);
      const e = this.fleet.get(ship.id);
      if (e) e.prefetch = early;
    }
    await this.focus(ship, tick('ship', `Loading ${ship.name}`), needRoom);
    this.readyAt ??= performance.now();
    this.start();
  }

  // ---------------------------------------------------------------- room
  async loadRoom(maker, tick) {
    const token = ++this.roomToken;
    const info = maker.room ? maker.room.info : studioInfo();
    let built;
    if (maker.room) {
      const [gl, env, bg] = await Promise.all([
        this.gltf.loadAsync(maker.room.glb, tick('room', 'Loading showroom')),
        this.rgbe.loadAsync(maker.room.env, tick('env', 'Loading light probe')),
        this.rgbe.loadAsync(maker.room.bg, tick('bg', 'Loading backdrop')),
      ]);
      if (token !== this.roomToken) { disposeTree(gl.scene); env.dispose(); bg.dispose(); return; }
      this.disposeRoom();                               // first: building sets scene.environment / background / exterior
      built = this.buildBakedRoom(info, gl, env, bg);
    } else {
      this.disposeRoom();
      built = this.buildStudio(maker.theme, info);
    }
    this.room = { id: maker.id, info, totem: maker.totem || null, ...built };
    this.room.floorMeshes = [];
    this.room.group.updateMatrixWorld(true);
    this.room.group.traverse((o) => {
      if (!o.isMesh) return;
      if (/floor/.test(o.name)) this.room.floorMeshes.push(o);
      if (/glass/.test(o.name)) {                       // window(s) onto the giants outside
        const b = new THREE.Box3().setFromObject(o);
        this.room.glassBox = this.room.glassBox ? this.room.glassBox.union(b) : b;
      }
    });
    this.scene.add(this.room.group);
    this.renderer.toneMappingExposure = info.tone_mapping?.exposure ?? 1;
    // the hall exposure is tuned for the interior; outside is space: keep the backdrop near its own exposure so
    // faint scatter in bg.hdr reads as black sky (with stars and the authored planet / dock), not grey haze
    const cave = /ceres|asteroid|cavern|hollow/i.test(`${maker.yard?.where || ''} ${maker.yard?.copy || ''}`);
    this.bgIntensity = this.scene.backgroundIntensity = Math.min(1, (cave ? 2 : 1.1) / this.renderer.toneMappingExposure);   // caves stay lit rock
    this.resize();
  }

  buildBakedRoom(info, gl, envTex, bgTex) {
    const group = new THREE.Group();
    const reflective = new Set(info.room?.reflective || ['room_floor']);
    gl.scene.traverse((o) => {
      if (!o.isMesh) return;
      const m = o.material;
      if (m.emissiveMap) {                              // baked lightmap: shown unlit
        const k = m.emissiveIntensity ?? 1;
        const basic = new THREE.MeshBasicMaterial({ map: m.emissiveMap, color: new THREE.Color(k, k, k), side: THREE.DoubleSide });
        if (reflective.has(o.name)) {                   // drawn additively over the planar reflection
          basic.transparent = true; basic.blending = THREE.AdditiveBlending; basic.depthWrite = true; o.renderOrder = 1;
        }
        m.emissiveMap = null; m.dispose();
        o.material = basic;
      } else if (m.transparent) {                       // glazing
        m.side = THREE.DoubleSide; m.depthWrite = false; o.renderOrder = 3;
      }
    });
    group.add(gl.scene);
    envTex.mapping = THREE.EquirectangularReflectionMapping;
    const envRT = this.pmrem.fromEquirectangular(envTex);
    envTex.dispose();
    bgTex.mapping = THREE.EquirectangularReflectionMapping;
    this.scene.environment = envRT.texture;
    this.scene.background = bgTex;
    this.extGroup = new THREE.Group();
    this.scene.add(this.extGroup);
    this.addExterior(this.extGroup, info);
    this.scene.fog = null;
    const rot = THREE.MathUtils.degToRad(info.env?.rotation_y || 0);
    this.scene.environmentRotation.set(0, rot, 0);
    this.scene.backgroundRotation.set(0, rot, 0);
    const hall = info.hall;
    const floor = this.addFloorReflection(group, info, 2 * hall.half_width, hall.glass_y - hall.back_y, -(hall.back_y + hall.glass_y) / 2, info.turntable.top);
    this.addLights(group, info);
    return { group, envRT, bgTex, floor };
  }

  /** Outside the glass: a starfield behind the authored backdrop (not in cave halls) and an exterior key + cool rim
   *  that light only while a giant outside is in focus (indoor bays keep the baked hall look). */
  addExterior(group, info) {
    const m = this.maker || {};
    const cave = /ceres|asteroid|cavern|hollow/i.test(`${m.yard?.where || ''} ${m.yard?.copy || ''}`);
    if (!cave) {
      const n = 3500, pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
      let seed = 7;
      const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
      for (let i = 0; i < n; i++) {
        const u = rnd() * 2 - 1, a = rnd() * Math.PI * 2, r = Math.sqrt(1 - u * u), R = 7000;
        pos.set([Math.cos(a) * r * R, u * R, Math.sin(a) * r * R], i * 3);
        const b = 0.25 + Math.pow(rnd(), 6) * 2.5, warm = rnd();
        col.set([b * (0.85 + 0.15 * warm), b * 0.92, b * (1.05 - 0.15 * warm)], i * 3);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      const stars = new THREE.Points(g, new THREE.PointsMaterial({ size: 1.6, sizeAttenuation: false, vertexColors: true, depthWrite: false, fog: false }));
      stars.renderOrder = -2; stars.frustumCulled = false;
      group.add(stars);
    }
    const sun = info.sun_dir ? v3(info.sun_dir).normalize() : new THREE.Vector3(0.45, -0.35, -0.82).normalize();
    const key = new THREE.DirectionalLight(0xfff4e6, 0);
    key.position.copy(sun.clone().multiplyScalar(-4000));
    const rim = new THREE.DirectionalLight(new THREE.Color(m.theme?.accent || '#8fb4ff').lerp(new THREE.Color(0.6, 0.75, 1), 0.6), 0);
    rim.position.set(-sun.x * -3000, 1500, sun.z * 3000);
    group.add(key, key.target, rim, rim.target);
    // exterior mode backdrop: black sky + stars + the maker's world, lit by the exterior key (caves keep
    // their rock). Built on first use: the planet textures are painted procedurally.
    const WORLD = { atlantia: 'earth', helios: 'mercury', cydonia: 'mars', kingsley: 'moon' };
    this.exterior = { key, rim, glass: [], cave, kind: cave ? null : WORLD[m.id], planet: null, group,
      bg: this.scene.background, sky: new THREE.Color(0x020203) };
    group.traverse((o) => { if (o.isMesh && /glass/.test(o.name)) this.exterior.glass.push(o); });
  }

  /** crossfade the hall (shell, frames, floor, indoor hulls) in or out over ~0.6 s */
  fadeRoom(show) {
    const r = this.room; if (!r) return;
    if (!r.fadeMats) {
      r.fadeMats = [];
      r.group.traverse((o) => {
        if (!o.isMesh || !o.material || o.material.isShadowMaterial || o.isReflector || o.material.isShaderMaterial) return;
        const m = o.material;
        if (!r.fadeMats.some((x) => x.m === m)) r.fadeMats.push({ m, op: m.opacity, tr: m.transparent, dw: m.depthWrite });
      });
    }
    const cur = this.roomFade ? this.roomFade.k : (r.group.visible ? 1 : 0);
    const to = show ? 1 : 0;
    if (cur === to && !this.roomFade) return;
    const instant = matchMedia('(prefers-reduced-motion: reduce)').matches || !this.running;
    this.roomFade = { from: cur, to, k: cur, start: performance.now(), dur: instant ? 0 : 600 };
    r.group.visible = true;
    this.stepFade(performance.now());
  }
  stepFade(now) {
    const f = this.roomFade, r = this.room; if (!f || !r) return;
    const u = f.dur ? Math.min(1, (now - f.start) / f.dur) : 1;
    f.k = f.from + (f.to - f.from) * u;
    const partial = f.k > 0.001 && f.k < 0.999;
    for (const x of r.fadeMats) {
      const tr = partial ? true : x.tr;
      if (x.m.transparent !== tr) { x.m.transparent = tr; x.m.needsUpdate = true; }
      x.m.opacity = x.op * f.k;
      x.m.depthWrite = partial ? false : x.dw;
    }
    // indoor hulls and the hall's reflector / shadows / lights go with the room
    r.group.traverse((o) => { if (o.isReflector || o.isLight || o.material?.isShadowMaterial) o.visible = f.k > 0.999; });
    // with the hall faded out only the focused giant remains: indoor hulls and the other giants step aside
    for (const e of this.fleet?.values() || []) if (e !== this.ship) e.holder.visible = f.k > 0.02;
    if (u >= 1) {
      r.group.visible = f.to > 0;
      for (const x of r.fadeMats) { x.m.opacity = x.op; if (x.m.transparent !== x.tr) { x.m.transparent = x.tr; x.m.needsUpdate = true; } x.m.depthWrite = x.dw; }
      this.roomFade = null;
    }
  }

  /** looking out at a giant: exterior lights up, the glass stops mirroring the bright hall */
  setOutside(on, target) {
    const x = this.exterior; if (!x) return;
    // same exterior look in every hall: intensities normalised by the hall's exposure
    const ex = this.renderer.toneMappingExposure || 1;
    const gain = (on && this.ship?.model.hero?.key_gain) || 1;   // dark hulls (Cydonia charcoal) may ask for more key
    x.key.intensity = on ? 7 * gain / ex : 0; x.rim.intensity = on ? 3 / ex : 0;
    this.fadeRoom(!on);
    if (on) for (const e of this.fleet?.values() || []) if (e.outdoor) e.holder.visible = e === this.ship;   // giant to giant
    if (target) {
      x.key.target.position.copy(target); x.rim.target.position.copy(target);
      // light the side the visitor sees: key from over the viewer's shoulder, cool rim from behind the hull
      const toCam = this.camera.position.clone().sub(target).setY(0).normalize();
      const side = new THREE.Vector3(-toCam.z, 0, toCam.x);
      x.key.position.copy(target).addScaledVector(toCam, 3000).addScaledVector(side, 1800).add(new THREE.Vector3(0, 2200, 0));
      x.rim.position.copy(target).addScaledVector(toCam, -3000).addScaledVector(side, -1200).add(new THREE.Vector3(0, 900, 0));
    }
    // at the hall's interior exposure even a faint pane of glass mirrors the lit hall into a grey veil: when the
    // visitor is looking out, the glass is simply not drawn (it is perfectly clear from up close anyway)
    for (const g of x.glass) g.visible = !on;
    // the baked bg.hdr is a view from the probe (dock walls and all); from the glass it reads as grey haze, so
    // exterior mode swaps it for black sky, stars and the maker's planet (caves keep their lit rock)
    if (on && x.kind && !x.planet) {
      x.planet = buildPlanet(x.kind, 2600, { earthUrl: data.backdrops?.earth });
      x.planet.group.position.set(3200, -2300, -9000);
      x.group.add(x.planet.group);
    }
    this.outside = on;
    if (!x.cave) this.scene.background = on ? x.sky : x.bg;   // black sky; the starfield is crisp point sprites
    if (x.planet) {
      x.planet.group.visible = on;
      if (on && target) {
        // the world hangs far behind the focused giant, low and to one side, lit by the same exterior key
        const look = target.clone().sub(this.camera.position).normalize();
        const side = new THREE.Vector3(-look.z, 0, look.x).normalize();
        x.planet.group.position.copy(target).addScaledVector(look, 9000).addScaledVector(side, 2600).add(new THREE.Vector3(0, -1900, 0));
      }
      x.planet.setSun(x.key.position.clone().sub(x.key.target.position).normalize());
    }
  }

  buildStudio(theme, info) {
    const group = new THREE.Group();
    const dark = new THREE.Color(theme.mode === 'dark' ? theme.bg : '#1b1c1e');
    const accent = new THREE.Color(theme.accent);
    const ink = new THREE.Color(theme.ink);
    this.scene.background = dark.clone();
    this.scene.fog = null;
    this.scene.environmentRotation.set(0, 0, 0);

    // light probe: a dark box with three soft boxes (one tinted by the brand), prefiltered once
    const envScene = new THREE.Scene();
    const box = new THREE.Mesh(new THREE.BoxGeometry(80, 36, 80), new THREE.MeshBasicMaterial({ color: dark.clone().multiplyScalar(0.5), side: THREE.BackSide }));
    box.position.y = 14; envScene.add(box);
    const panel = (w, h, color, pos, rotX = 0, rotY = 0) => {
      const p = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide }));
      p.position.set(...pos); p.rotation.set(rotX, rotY, 0); envScene.add(p);
    };
    panel(34, 12, new THREE.Color(1, 0.98, 0.95).multiplyScalar(7), [0, 31, 0], Math.PI / 2);
    panel(6, 26, ink.clone().multiplyScalar(2.2), [-39, 12, -6], 0, Math.PI / 2);
    panel(6, 26, accent.clone().multiplyScalar(2.5), [39, 12, 8], 0, -Math.PI / 2);
    panel(40, 3, new THREE.Color(1, 1, 1).multiplyScalar(1.2), [0, 3, -39]);
    const envRT = this.pmrem.fromScene(envScene, 0.02);
    disposeTree(envScene);
    this.scene.environment = envRT.texture;

    // turntable: a satin disc with a hairline accent ring
    const tt = info.turntable;
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(tt.radius, tt.radius + 0.15, tt.top, 128),
      new THREE.MeshStandardMaterial({ color: dark.clone().lerp(new THREE.Color(0.5, 0.5, 0.5), 0.12), roughness: 0.45, metalness: 0.05 }));
    disc.position.y = tt.top / 2; disc.receiveShadow = true;
    const ring = new THREE.Mesh(new THREE.RingGeometry(tt.radius + 0.25, tt.radius + 0.36, 160),
      new THREE.MeshBasicMaterial({ color: accent.clone().multiplyScalar(1.3), toneMapped: false }));
    ring.rotation.x = -Math.PI / 2; ring.position.y = 0.012;
    group.add(disc, ring);

    // floor: a soft pool of light that fades exactly into the backdrop colour (no horizon line)
    const c = document.createElement('canvas'); c.width = c.height = 512;
    const g = c.getContext('2d');
    const rg = g.createRadialGradient(256, 256, 0, 256, 256, 256);
    const hex = (col) => `#${col.getHexString(THREE.SRGBColorSpace)}`;
    const pool = dark.clone().lerp(new THREE.Color(0.55, 0.55, 0.55), 0.11);
    rg.addColorStop(0, hex(pool));
    rg.addColorStop(0.22, hex(dark.clone().lerp(pool, 0.55)));
    rg.addColorStop(0.6, hex(dark));
    rg.addColorStop(1, hex(dark));
    g.fillStyle = rg; g.fillRect(0, 0, 512, 512);
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
    const floorMesh = new THREE.Mesh(new THREE.CircleGeometry(160, 96), new THREE.MeshBasicMaterial({ map: tex }));
    floorMesh.rotation.x = -Math.PI / 2;
    group.add(floorMesh);
    const floor = { dispose() {} };
    this.addLights(group, info);
    return { group, envRT, bgTex: null, floor };
  }

  /** planar reflection under the additive floor, blurred (polished concrete / marble is not a mirror) */
  addFloorReflection(group, info, w, d, z, y) {
    const k = info.floor_reflect ?? 0.16;
    const refl = new Reflector(new THREE.PlaneGeometry(w, d), {
      textureWidth: Math.round(innerWidth * 0.5), textureHeight: Math.round(innerHeight * 0.5),
      color: new THREE.Color(k, k, k), clipBias: 0.003,
    });
    refl.rotation.x = -Math.PI / 2; refl.position.set(0, y, z);
    refl.material.depthWrite = false; refl.renderOrder = -1;
    group.add(refl);
    const rt = refl.getRenderTarget();
    const tmp = rt.clone();
    const mat = new THREE.ShaderMaterial({
      uniforms: { tex: { value: null }, dir: { value: new THREE.Vector2() }, cap: { value: 0.6 } },
      vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      // each tap is soft-clamped first: ceiling softboxes and emissive cards would otherwise smear into bright blobs
      // (polished concrete reflects shapes, not light sources at full HDR strength)
      fragmentShader: `uniform sampler2D tex; uniform vec2 dir; uniform float cap; varying vec2 vUv;
        vec4 s(vec2 uv) { vec4 c = texture2D(tex, uv); c.rgb = c.rgb / (1.0 + max(vec3(0.0), c.rgb - cap)); return c; }
        void main() {
          vec4 c = s(vUv) * 0.2270270270;
          c += (s(vUv + dir * 1.3846153846) + s(vUv - dir * 1.3846153846)) * 0.3162162162;
          c += (s(vUv + dir * 3.2307692308) + s(vUv - dir * 3.2307692308)) * 0.0702702703;
          gl_FragColor = c;
        }`,
      depthTest: false, depthWrite: false,
    });
    const quad = new FullScreenQuad(mat);
    const radii = info.floor_blur ?? [3, 1.5];
    const render = refl.onBeforeRender;
    refl.onBeforeRender = function (r, s, cam, ...rest) {
      render.call(this, r, s, cam, ...rest);
      if (tmp.width !== rt.width || tmp.height !== rt.height) tmp.setSize(rt.width, rt.height);
      const prev = r.getRenderTarget();
      for (const rad of radii) {
        mat.uniforms.tex.value = rt.texture; mat.uniforms.dir.value.set(rad / rt.width, 0);
        r.setRenderTarget(tmp); quad.render(r);
        mat.uniforms.tex.value = tmp.texture; mat.uniforms.dir.value.set(0, rad / rt.height);
        r.setRenderTarget(rt); quad.render(r);
      }
      r.setRenderTarget(prev);
    };
    return { refl, tmp, dispose() { refl.dispose(); tmp.dispose(); mat.dispose(); quad.dispose(); } };
  }

  addLights(group, info) {
    const tt = info.turntable, top = tt.top, hall = info.hall;
    const key = new THREE.DirectionalLight(new THREE.Color(...info.key_light.color), info.key_light.intensity);
    const kd = v3(info.key_light.direction).normalize();
    // the shadow camera covers the whole hall floor: every indoor bay gets a real-time contact shadow
    const cz = 0;
    const R = tt.radius + 8;                            // the turntable hull is the only real-time shadow caster
    key.position.copy(kd.clone().multiplyScalar(-(R * 3 + 40))).add(new THREE.Vector3(0, top, cz));
    key.target.position.set(0, top, cz);
    key.castShadow = true;
    key.shadow.mapSize.setScalar(matchMedia('(max-width: 760px)').matches ? 2048 : 4096);
    Object.assign(key.shadow.camera, { left: -R, right: R, top: R, bottom: -R, near: 1, far: R * 6 + 80 });
    key.shadow.bias = -0.0005; key.shadow.normalBias = 0.05; key.shadow.radius = 5;
    group.add(key, key.target);
    if (info.fill_light) {
      const fill = new THREE.DirectionalLight(new THREE.Color(...info.fill_light.color), info.fill_light.intensity);
      fill.position.copy(v3(info.fill_light.direction).normalize().multiplyScalar(-80));
      group.add(fill, fill.target);
    }
    // contact-shadow catchers (the floor itself is baked): the turntable top and the hall floor
    const mk = (geo, y) => {
      const m = new THREE.Mesh(geo, new THREE.ShadowMaterial({ opacity: 0.5, depthWrite: false }));
      m.rotation.x = -Math.PI / 2; m.position.y = y; m.receiveShadow = true; m.renderOrder = 2; group.add(m); return m;
    };
    mk(new THREE.CircleGeometry(tt.radius, 96), top + 0.012);
    void hall;
  }

  /** floor height under (x, z): ray down onto the baked floor mesh (turntable top included) */
  floorAt(x, z) {
    const r = this.room;
    if (!r?.floorMeshes?.length) return r?.info.turntable.top ?? 0;
    const ray = mkRay(new THREE.Vector3(x, 60, z), new THREE.Vector3(0, -1, 0), 0, 200);
    const hit = ray.intersectObjects(r.floorMeshes, false)[0];
    return hit ? hit.point.y : r.info.turntable.top;
  }

  disposeRoom() {
    this.disposeFleet();
    if (!this.room) return;
    const r = this.room;
    this.scene.remove(r.group);
    r.floor.dispose();
    disposeTree(r.group);
    r.envRT.dispose();
    r.bgTex?.dispose();
    this.scene.environment = null; this.scene.background = null; this.scene.fog = null;
    if (this.extGroup) { this.scene.remove(this.extGroup); disposeTree(this.extGroup); this.extGroup = null; }
    this.exterior = null; this.outside = false; this.roomFade = null;
    this.room = null;
    this.hallCatcher = null;
  }

  // ---------------------------------------------------------------- the hall: every hull of the line-up in its bay
  /** Lay out the maker's line-up: a ghost silhouette per bay, then load hulls focused-first, indoor, outdoor. */
  setupFleet(maker, focused) {
    this.disposeFleet();
    const info = this.room.info;
    const byModel = new Map((info.bays || []).map((b) => [b.model, b]));
    this.fleet = new Map();
    this.spinCache = null;
    for (const s of this.lineup) {
      // a room without bays (legacy export): only the focused hull, on the turntable
      const bay = byModel.get(s.model) || (byModel.size || s.id !== focused.id ? null
        : { model: s.model, position: [0, null, 0], yaw_deg: info.ship?.yaw_deg ?? 160, indoor: true, turntable: true });
      if (!bay || !s.glb) continue;
      const e = { id: s.id, model: s, bay, outdoor: bay.indoor === false, holder: new THREE.Group(), rig: null, state: 'pending',
        S: { gearT: 1, gearDir: 1, nav: true, strobe: true, thrust: 0, retro: 0, retroTarget: 0, rcs: 0 }, spinYaw: 0, extras: [] };
      const p = bay.position;
      const y = p[1] == null ? this.floorAt(p[0], p[2]) : p[1];
      e.base = new THREE.Vector3(p[0], y, p[2]);
      e.yaw = THREE.MathUtils.degToRad(bay.yaw_deg || 0);
      e.holder.position.copy(e.base);
      e.holder.rotation.y = e.yaw;
      e.holder.userData.entry = e;
      this.scene.add(e.holder);
      this.fleet.set(s.id, e);
    }
  }

  /** silhouette card standing in the bay until the hull streams in */
  addGhost(e) {
    const sil = e.model.silhouette;
    if (!sil || e.outdoor) return;                      // giants outside just appear when ready
    const L = e.model.length, H = L * sil.aspect;
    const tex = new THREE.TextureLoader().load(sil.src);
    const m = new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0.1, depthWrite: false, side: THREE.DoubleSide, color: 0xffffff });
    const g = new THREE.Mesh(new THREE.PlaneGeometry(L, H), m);
    g.rotation.y = Math.PI / 2;                       // side view along the hull's z axis
    g.position.y = H / 2;
    e.ghost = g;
    e.holder.add(g);
  }

  disposeFleet() {
    if (!this.fleet) return;
    ++this.fleetToken;
    for (const e of this.fleet.values()) {
      this.scene.remove(e.holder);
      if (e.ghost) disposeTree(e.ghost);
      for (const s of e.lodSlots || []) { if (s.base !== s.cur) { s.base.dispose(); s.base.image?.close?.(); } }
      e.lodSlots = null;
      e.rig?.dispose();
    }
    this.fleet = null;
    this.ship = null;
  }

  async loadEntry(e, onProgress) {
    if (e.state === 'ready') return e;
    if (e.promise) return e.promise;
    e.state = 'loading';
    const token = this.fleetToken;
    e.promise = (async () => {
      const gl = (e.prefetch && await e.prefetch) || await this.gltf.loadAsync(e.model.glb.src, onProgress);
      e.prefetch = null;
      if (token !== this.fleetToken) { disposeTree(gl.scene); return null; }
      const rig = rigShip(gl, { realLights: false, length: e.model.length });
      this.indexLods(e, gl);
      e.rig = rig;
      this.placeEntry(e);
      if (e.ghost) { e.holder.remove(e.ghost); disposeTree(e.ghost); e.ghost = null; }
      if (this.outside && e !== this.ship) e.holder.visible = false;   // arrived while the hall is faded out
      else if (e.outdoor && e !== this.ship && !this.bayVisible(e)) e.holder.visible = false;   // behind a wall: never uploaded
      this.redraw();
      e.state = 'ready';
      return e;
    })();
    return e.promise;
  }

  placeEntry(e) {
    const root = e.rig.root;
    // decimated giants have open/flipped faces at some angles: draw both sides so they never look shredded.
    // Giants live on layer 1: the main camera sees them, the floor-reflection camera (layer 0) skips them
    if (e.outdoor) root.traverse((o) => { if (o.isMesh && !o.material.transparent) o.material.side = THREE.DoubleSide; if (o.isMesh || o.isSprite) o.layers.set(1); });
    // grazing-angle hull plating stays crisp at distance
    const aniso = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    root.traverse((o) => { if (o.isMesh) for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap']) { const tx = o.material[k]; if (tx && tx.anisotropy !== aniso) { tx.anisotropy = aniso; tx.needsUpdate = true; } } });
    root.position.set(0, 0, 0); root.scale.setScalar(1); root.rotation.set(0, 0, 0);
    e.holder.add(root);
    // bounds in the hull's own frame (holder is rotated; measure with the root detached from it)
    e.holder.remove(root); root.updateMatrixWorld(true);
    const box = e.rig.bounds();
    e.holder.add(root);
    const size = box.getSize(new THREE.Vector3());
    e.localBox = box.clone();
    e.len = Math.max(size.x, size.z);
    e.fits = true; e.N = 1; e.plinthR = 0;
    // spin axis: the centre of the hull's smallest plan-view enclosing circle sits on the bay centre, so a turn
    // about the bay sweeps exactly that circle (an AABB centre would swing the long end out further)
    const plan = this.planOf(root);
    const cx = plan.c.x, cz = plan.c.z, cy = (box.min.y + box.max.y) / 2;
    // indoor: stand on the bay floor (hover a little if the hull has no gear); outdoor: bay position is the hull centre
    // real bays: position is the ground contact point (lowest point of the hull, gear down); legacy stub bays put
    // outdoor giants by their centre and float gearless indoor hulls a little
    const real = e.bay.ground !== undefined || e.bay.length !== undefined;
    const y = real ? -box.min.y : e.outdoor ? -cy : -box.min.y + (e.rig.hasGear ? 0 : Math.max(0.6, size.y * 0.12));
    // only the turntable hull gets a real-time shadow: the other bays have theirs baked into the floor
    if (real && !e.bay.turntable) root.traverse((o) => { if (o.isMesh) o.castShadow = false; });
    root.position.set(-cx, y, -cz);
    // the plan in the bay's frame (axis at the origin): hull outline, sampled points, swept radius, height band
    e.plan = { hull: plan.hull.map((q) => [q[0] - cx, q[1] - cz]), pts: plan.pts.map((q) => [q[0] - cx, q[1] - cz, q[2] + y]),
      r: Math.max(plan.c.r, e.bay.spin_radius || 0), y0: box.min.y + y, y1: box.max.y + y };
    e.holder.updateMatrixWorld(true);
    this.spinCache = null;
    e.pois = this.buildPois(e);
    this.snapPois(e);
    this.shadowDirty = Math.max(this.shadowDirty || 0, 2);
  }

  /** plan-view footprint of a hull in its own frame: sampled vertices [x, z, y], their convex hull, enclosing circle */
  planOf(root) {
    const pts = [], v = new THREE.Vector3();
    root.updateMatrixWorld(true);
    let total = 0;
    root.traverse((o) => { if (o.isMesh && o.geometry?.attributes.position) total += o.geometry.attributes.position.count; });
    const step = Math.max(1, Math.floor(total / 6000));
    root.traverse((o) => {
      if (!o.isMesh || !o.geometry?.attributes.position || o.material?.transparent && o.material.depthWrite === false) return;
      const pa = o.geometry.attributes.position;
      for (let i = 0; i < pa.count; i += step) { v.fromBufferAttribute(pa, i).applyMatrix4(o.matrixWorld); pts.push([v.x, v.z, v.y]); }
    });
    const hull = hull2(pts.map((q) => [q[0], q[1]]));
    return { pts, hull, c: minCircle(hull) };
  }

  /** world-space plan outline of a ready hull at extra yaw `dyaw` about its bay axis */
  worldHull(e, dyaw = 0) {
    const a = e.yaw + (e === this.ship ? e.spinYaw : 0) + dyaw, cs = Math.cos(a), sn = Math.sin(a), b = e.base;
    // three.js yaw: x' = x cos + z sin, z' = -x sin + z cos
    return e.plan.hull.map(([x, z]) => [b.x + x * cs + z * sn, b.z - x * sn + z * cs]);
  }

  /** Can this hull turn a full circle about its bay centre without touching a neighbour, a pillar, a wall or the
   *  turntable? (the swept disc of radius plan.r + margin against everything else's real outline) */
  spinClear(e, margin = 0.5) {
    if (!e?.plan) return false;
    this.spinCache ||= new Map();
    if (this.spinCache.has(e)) return this.spinCache.get(e);
    const R = e.plan.r + margin, x = e.base.x, z = e.base.z, info = this.room?.info || {};
    let ok = true;
    const fb = info.floor_bounds;
    if (!e.outdoor && fb) ok &&= x - R >= fb.x[0] && x + R <= fb.x[1] && z - R >= fb.z[0] && z + R <= fb.z[1];
    const bayAt = (c) => [...this.fleet.values()].some((f) => Math.hypot(f.base.x - c[0], f.base.z - c[1]) < 1.5);
    if (!e.outdoor) for (const o of info.obstacles || []) if (o.type === 'circle' && !bayAt(o.center) && Math.hypot(o.center[0] - x, o.center[1] - z) < R + o.radius) ok = false;
    const tt = info.turntable;
    if (tt && !e.outdoor && !e.bay.turntable && e.plan.y0 < tt.top + 0.05 && Math.hypot(tt.center[0] - x, tt.center[2] - z) < R + tt.radius) ok = false;
    for (const f of this.fleet.values()) {
      if (f === e || f.outdoor !== e.outdoor) continue;
      if (!f.plan) { if (f.state !== 'ready') { this.spinCache.delete(e); return false; } continue; }   // decide once neighbours are in
      if (f.plan.y1 < e.plan.y0 || f.plan.y0 > e.plan.y1) continue;
      const H = this.worldHull(f);
      if (inHull(x, z, H)) ok = false;
      for (let i = 0; i < H.length && ok; i++) if (segDist(x, z, H[i], H[(i + 1) % H.length]) < R) ok = false;
    }
    if ([...this.fleet.values()].every((f) => f.state === 'ready' || f.outdoor !== e.outdoor)) this.spinCache.set(e, ok);
    return ok;
  }

  /** Make `ship` the focused hull: load it (first), fly the camera to its bay, then stream in the rest. */
  async focus(ship, progress, instant) {
    const e = this.fleet?.get(ship.id);
    if (!e) throw new Error(`${ship.name} has no bay in this hall`);
    const prev = this.ship;
    if (prev && prev !== e) { prev.holder.rotation.y = prev.yaw; prev.spinYaw = 0; prev.rig?.setHighlight(0); }
    this.ship = e;
    if (e.state !== 'ready') await this.loadEntry(e, progress);
    if (this.ship !== e) return;
    // the focused hull never shows its 1024 px base: 2048 is in place before it is revealed, full res follows
    await this.setLod(e, 2048);
    if (this.ship !== e) return;
    this.setLod(e, 'full');
    this.frameShip(instant);
    this.shadowDirty = 4;
    // the rest of the line-up streams in once the browser is idle: the focused hull gets the bandwidth first
    const kick = () => this.streamRest();
    if ('requestIdleCallback' in window) requestIdleCallback(kick, { timeout: 1500 }); else setTimeout(kick, 300);
  }

  // ---------------------------------------------------------------- texture LOD streaming
  /** find, per LOD'd image, the texture GLTFLoader made for it and every material slot that uses it */
  indexLods(e, gl) {
    e.level = 1024; e.lodSlots = [];
    const lods = e.model.glb.lods || [];
    if (!lods.length) return;
    const json = gl.parser.json, byImage = new Map(lods.map((l) => [l.image, { lod: l, base: null, cur: null, refs: [] }]));
    gl.scene.traverse((o) => {
      if (!o.isMesh) return;
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
        for (const key of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap']) {
          const tex = m[key]; if (!tex) continue;
          const ti = gl.parser.associations.get(tex)?.textures; if (ti == null) continue;
          const td = json.textures[ti], img = td.source ?? td.extensions?.EXT_texture_webp?.source;
          const slot = byImage.get(img); if (!slot) continue;
          slot.base ||= tex; slot.cur ||= tex;
          if (!slot.refs.some((r) => r.m === m && r.key === key)) slot.refs.push({ m, key });
        }
      }
    });
    e.lodSlots = [...byImage.values()].filter((s) => s.base);
  }

  /** move a hull's textures to `level` (1024 | 2048 | 'full'), decoded and uploaded before the swap */
  async setLod(e, level) {
    if (!e.lodSlots?.length) return;
    e.lodTarget = level;
    if (e.lodBusy) return e.lodBusy;
    e.lodBusy = (async () => {
      const rank = (l) => (l === 1024 ? 0 : l === 2048 ? 1 : 2);
      while (e.lodSlots && rank(e.level) !== rank(e.lodTarget)) {
        // step through 2048 on the way up (sharper sooner); straight back down to the 1024 base
        const want = rank(e.lodTarget) > rank(e.level) ? (rank(e.level) === 0 ? 2048 : 'full') : 1024;
        if (want === 1024) {
          for (const s of e.lodSlots) this.lodAssign(s, s.base);
          e.level = 1024;
          continue;
        }
        const token = this.fleetToken;
        const loaded = await Promise.all(e.lodSlots.map(async (s) => {
          const url = s.lod.files[want === 'full' ? 'full' : '2048'] || s.lod.files['2048'];
          if (!url) return null;
          const blob = await (await fetch(url)).blob();
          const bmp = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
          const t = new THREE.Texture(bmp);
          const b = s.base;
          Object.assign(t, { flipY: false, colorSpace: b.colorSpace, wrapS: b.wrapS, wrapT: b.wrapT, magFilter: b.magFilter,
            minFilter: b.minFilter, generateMipmaps: b.generateMipmaps, anisotropy: b.anisotropy, channel: b.channel, name: b.name });
          t.needsUpdate = true;
          return [s, t];
        })).catch((err) => { console.warn('texture LOD failed', err); return []; });
        if (token !== this.fleetToken || !e.lodSlots) { for (const x of loaded) if (x) { x[1].dispose(); x[1].image.close?.(); } break; }
        for (const x of loaded) if (x) this.renderer.initTexture(x[1]);   // upload now: the swap itself never shows a gap
        for (const x of loaded) if (x) this.lodAssign(x[0], x[1]);
        e.level = want;
        this.redraw();
      }
      e.lodBusy = null;
    })();
    return e.lodBusy;
  }

  lodAssign(s, tex) {
    const old = s.cur;
    for (const r of s.refs) r.m[r.key] = tex;
    s.cur = tex;
    if (old && old !== s.base && old !== tex) { old.dispose(); old.image?.close?.(); }
    // the 1024 base leaves the GPU while a larger level is shown (its bitmap stays, so stepping back re-uploads it)
    if (old === s.base && tex !== s.base) s.base.dispose();
  }

  /** on-screen size picks the level: anything big on screen gets full res; the focused hull always does */
  updateLods(now) {
    if (!this.fleet || now - (this.lodAt || 0) < 400) return;
    this.lodAt = now;
    const H = this.canvas.clientHeight * this.dpr, k = 1 / Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2);
    const fr = this._lfr ||= new THREE.Frustum(), m = this._lfm ||= new THREE.Matrix4();
    fr.setFromProjectionMatrix(m.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse));
    for (const e of this.fleet.values()) {
      if (e.state !== 'ready' || !e.lodSlots?.length) continue;
      let want = 1024;
      if (e === this.ship || this.lodAll) want = 'full';
      else if (e.holder.visible) {
        const sph = e.rig.bounds().getBoundingSphere(new THREE.Sphere());
        if (fr.intersectsSphere(sph)) {
          const px = (sph.radius / Math.max(1, sph.center.distanceTo(this.camera.position))) * k * H;   // on-screen diameter
          want = px > 1800 ? 'full' : px > 900 ? 2048 : 1024;   // thresholds checked: SSIM >= 0.999 vs all-full renders
        }
      }
      // up at once; down only after a few seconds of not needing it (no thrash while orbiting)
      const rank = (l) => (l === 1024 ? 0 : l === 2048 ? 1 : 2);
      if (rank(want) >= rank(e.level)) { e.lodLow = 0; if (want !== e.level) this.setLod(e, want); }
      else if (!e.lodLow) e.lodLow = now;
      else if (now - e.lodLow > 4000) { e.lodLow = 0; this.setLod(e, want); }
    }
  }

  /** every hull is at the level its screen size asks for, nothing decoding */
  lodSettled() {
    return !!this.fleet && [...this.fleet.values()].every((e) => !e.lodBusy);
  }

  /** is a bay (its hull's bounding sphere, before the hull exists) inside the camera frustum? */
  bayInView(e) {
    const fr = this._fr ||= new THREE.Frustum(), m = this._fm ||= new THREE.Matrix4();
    this.camera.updateMatrixWorld();
    fr.setFromProjectionMatrix(m.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse));
    const r = (e.bay.length || e.model.length) * 0.6;
    return fr.intersectsSphere(new THREE.Sphere(e.base.clone().add(new THREE.Vector3(0, r * 0.3, 0)), r));
  }

  /** Can the camera see any part of an outdoor bay past the hall's walls (through glass / doors)? Rays from the
   *  camera to a few points of the hull's bounding sphere, tested against the room's opaque meshes. */
  bayVisible(e) {
    if (!this.bayInView(e)) return false;
    if (this.outside || !this.room) return true;
    const occ = this.room.occ ||= (() => { const a = []; this.room.group.traverse((o) => { if (o.isMesh && !/glass|floor/.test(o.name) && !o.material.transparent) a.push(o); }); return a; })();
    if (!occ.length) return true;
    let c, r;
    if (e.rig) { const s = e.rig.bounds().getBoundingSphere(new THREE.Sphere()); c = s.center; r = s.radius; }
    else { r = (e.bay.length || e.model.length) * 0.5; c = e.base.clone().add(new THREE.Vector3(0, r * 0.25, 0)); }
    const cam = this.camera.position, ray = this._visRay ||= mkRay();
    const pts = [c, ...[[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].map((d) => c.clone().addScaledVector(new THREE.Vector3(...d), r * 0.7))];
    for (const p of pts) {
      const d = p.clone().sub(cam), len = d.length();
      ray.set(cam, d.divideScalar(len)); ray.far = len;
      if (!ray.intersectObjects(occ, false).length) return true;
    }
    return false;
  }

  /** outdoor giants nobody can see: hidden, and their textures leave the GPU (images stay; showing re-uploads) */
  updateGiantVisibility(now) {
    if (!this.fleet || this.outside || now - (this.visAt || 0) < 1000 || now - (this.lastInput || 0) > 3000 && this.visAt) return;
    this.visAt = now;
    for (const e of this.fleet.values()) {
      if (!e.outdoor || e === this.ship || e.state !== 'ready') continue;
      const vis = this.bayVisible(e);
      if (vis) { e.hiddenSince = 0; if (!e.holder.visible) { e.holder.visible = true; this.redraw(); } }
      else if (!e.hiddenSince) e.hiddenSince = now;
      else if (e.holder.visible && now - e.hiddenSince > 2000) {
        e.holder.visible = false;
        e.rig.root.traverse((o) => { if (!o.isMesh) return; for (const m of Array.isArray(o.material) ? o.material : [o.material]) for (const k of Object.keys(m)) if (m[k]?.isTexture) m[k].dispose(); });
      }
    }
  }

  /** nothing is downloading or waiting to (giants out of view are fetched when they come into view) */
  settled() {
    return !!this.fleet && !this.streaming && ![...this.fleet.values()].some((e) => e.state === 'loading' || (e.state === 'pending' && (!e.outdoor || this.bayVisible(e))));
  }

  /** load the remaining hulls in the background: indoor first, then the giants outside that the camera can see
   *  (a giant out of view costs nothing until the visitor turns toward it or focuses it) */
  async streamRest() {
    if (this.streaming) return;
    this.streaming = true;
    const token = this.fleetToken;
    try {
      const rest = [...this.fleet.values()].filter((x) => x.state === 'pending' && (!x.outdoor || this.bayVisible(x)))
        .sort((a, b) => (a.outdoor - b.outdoor) || (a.model.length - b.model.length));
      for (const e of rest) {
        if (token !== this.fleetToken) break;
        try { await this.loadEntry(e); } catch (err) { console.warn(`could not load ${e.model.name}`, err); }
        this.onFleet?.();
      }
    } finally { this.streaming = false; }
  }

  /** opening shot for a bay: 3/4 front-above from the side of the hull with the most floor, away from the totem */
  heroAzimuth(e) {
    const info = this.room.info;
    const c = e.base;
    const nose = e.yaw + Math.PI;                       // hull nose is local -Z
    const rb = this.roomBox();
    const avail = (x) => {
      if (!rb) return 100;
      const dx = Math.sin(x), dz = Math.cos(x), hw = rb.x;
      const z0 = rb.z0, z1 = rb.z1;
      const tx = dx > 0 ? (hw - c.x) / dx : dx < 0 ? (-hw - c.x) / dx : Infinity;
      const tz = dz > 0 ? (z1 - c.z) / dz : dz < 0 ? (z0 - c.z) / dz : Infinity;
      return Math.max(0, Math.min(tx, tz));
    };
    const tot = e.bay.totem_position || (e.bay.turntable ? this.room.totem : null);
    const tAz = tot ? Math.atan2(tot[0] - c.x, tot[tot.length === 3 ? 2 : 1] - c.z) : null;
    const need = e.len * 0.9;
    let best = -Infinity, az = nose + 0.7;
    for (let d = 0; d < 360; d += 10) {
      const x = THREE.MathUtils.degToRad(d);
      const diff = Math.atan2(Math.sin(x - nose), Math.cos(x - nose));
      let score = 2 * Math.min(avail(x), need) / need + Math.cos(Math.abs(diff) - 0.7);
      if (tAz != null && Math.abs(Math.atan2(Math.sin(x - tAz), Math.cos(x - tAz))) < 0.6) score -= 1.5;
      // don't look at this hull through another one: penalise sight lines crossing other indoor bays
      const reach = Math.min(avail(x), need);
      const cam2 = new THREE.Vector2(c.x + Math.sin(x) * reach, c.z + Math.cos(x) * reach), foc = new THREE.Vector2(c.x, c.z);
      for (const o of this.fleet.values()) {
        if (o === e || o.outdoor) continue;
        const r = (o.bay.length || o.model.length) * 0.45, q = new THREE.Vector2(o.base.x, o.base.z);
        const ab = foc.clone().sub(cam2), tt2 = THREE.MathUtils.clamp(q.clone().sub(cam2).dot(ab) / ab.lengthSq(), 0, 1);
        if (cam2.clone().addScaledVector(ab, tt2).distanceTo(q) < r) score -= 2;
      }
      if (score > best) { best = score; az = x; }
    }
    return { az, avail: avail(az) };
  }

  frameShip(instant) {
    const e = this.ship, info = this.room.info, cam = info.camera, tt = info.turntable, hall = info.hall;
    e.holder.updateMatrixWorld(true);
    const sphere = e.rig.bounds().getBoundingSphere(new THREE.Sphere());
    if (e.outdoor) { this.camera.fov = 26; this.camera.updateProjectionMatrix(); }   // giants: a long lens, less distortion
    const vfov = THREE.MathUtils.degToRad(this.camera.fov);
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * this.camera.aspect);
    const fit = 0.8 * sphere.radius / Math.tan(Math.min(vfov, hfov) / 2);
    const target = sphere.center.clone();
    let pos;
    const box = this.roomBox();
    if (e.outdoor) {
      // giants outside: the hall fades away and the camera flies out to a clean 3/4 hero angle, on the hall's side
      // of the hull (the maker's world hangs behind it), nose turned ~40 degrees toward the lens
      // the view the bay was designed for (from the hall), without the glass: along the hall's line of sight,
      // swung 15 degrees toward the nose, a few degrees above the hull
      const toHall = Math.atan2(-target.x, -target.z);
      const nose = e.yaw + Math.PI;
      const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
      const hero = e.model.hero || {};                  // per-ship override (canon `hero`)
      const az = toHall + Math.sign(wrap(nose - toHall) || 1) * THREE.MathUtils.degToRad(hero.swing_deg ?? 15);
      const el = THREE.MathUtils.degToRad(hero.elevation_deg ?? 6);
      const dir = new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el));
      pos = target.clone().addScaledVector(dir, fit * 1.05);
    } else {
      const { az, avail } = this.heroAzimuth(e);
      const dist = Math.max(Math.min(fit, avail - 0.5), sphere.radius * 0.9);
      // 3/4 from above, but at a person's sense of scale: never more than ~a third of a hull length overhead
      const el = Math.min(THREE.MathUtils.degToRad(20), Math.atan2(THREE.MathUtils.clamp(sphere.radius * 0.25, 2.5, 7), dist));
      const dir = new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el));
      pos = target.clone().addScaledVector(dir, dist);
    }
    if (!e.outdoor) {
      pos.y = THREE.MathUtils.clamp(pos.y, tt.top + (cam.min_height ?? 1), cam.max_height ?? 50);
      if (box) { pos.x = THREE.MathUtils.clamp(pos.x, -box.x, box.x); pos.z = THREE.MathUtils.clamp(pos.z, box.z0, box.z1); }
    }
    // giants are far away: a longer lens (narrower fov) frames them; indoor bays use the room's authored lens
    const baseFov = (this.camera.aspect < 0.8 ? 1.25 : 1) * (cam.fov ?? 40);
    if (e.outdoor) {
      // fit the hull's own (oriented) box as seen from the hero spot
      const probe = this.camera.clone();
      probe.position.copy(pos); probe.lookAt(target); probe.updateMatrixWorld(true);
      const inv = probe.matrixWorldInverse, lb = e.localBox, m = e.rig.root.matrixWorld;
      let need = 0.05;
      for (let i = 0; i < 8; i++) {
        const v = new THREE.Vector3(i & 1 ? lb.max.x : lb.min.x, i & 2 ? lb.max.y : lb.min.y, i & 4 ? lb.max.z : lb.min.z).applyMatrix4(m).applyMatrix4(inv);
        const z = Math.max(1, -v.z);
        need = Math.max(need, Math.abs(v.x) / z / this.camera.aspect, Math.abs(v.y) / z);
      }
      this.camera.fov = THREE.MathUtils.clamp(THREE.MathUtils.radToDeg(2 * Math.atan(need * 1.2)), 14, 34);
    } else this.camera.fov = Math.min(62, baseFov);
    this.camera.updateProjectionMatrix();
    const c = this.controls;
    // looking out and up at a giant needs the camera below its target: lift the 'never under the floor' orbit limit
    const lim = e.model.hero?.pitch_limit_deg;
    c.minPolarAngle = lim != null ? THREE.MathUtils.degToRad(90 - lim) : 0;
    c.maxPolarAngle = lim != null ? THREE.MathUtils.degToRad(90 + lim) : e.outdoor ? Math.PI - 0.05 : THREE.MathUtils.degToRad(89);
    const d = pos.distanceTo(target);
    c.minDistance = e.outdoor ? sphere.radius * 0.1 : Math.max(0.4, sphere.radius * 0.12);
    c.maxDistance = e.outdoor ? d * 1.8 : Math.max(d * 1.3, cam.orbit_max_distance);
    this.home = { pos: pos.clone(), target: target.clone() };
    { const cur = this.camera.position.clone(); this.camera.position.copy(pos); this.setOutside(!!e.outdoor, target); this.camera.position.copy(cur); }
    this.lastClear = null;
    this.bounds = e.outdoor ? { r: Infinity, top: -1e5, minH: 0, maxH: 1e5, box: null, focus: e }
      : { r: Infinity, top: tt.top, minH: cam.min_height ?? 1, maxH: cam.max_height ?? 50, box, focus: e };
    if (instant || !this.running || matchMedia('(prefers-reduced-motion: reduce)').matches) {
      this.camera.position.copy(pos); c.target.copy(target); this.tween = null; c.update();
    } else {
      this.tween = { p0: this.camera.position.clone(), t0: c.target.clone(), p1: pos, t1: target, start: performance.now(), dur: 1500 };
    }
  }

  /** camera box: the walkable floor rectangle (or the hall) with a margin, in three.js x / z */
  roomBox() {
    const info = this.room.info, fb = info.floor_bounds, hall = info.hall;
    if (fb?.x && fb?.z) return { x: Math.min(-fb.x[0], fb.x[1]) - 1.5, z0: fb.z[0] + 1.5, z1: fb.z[1] - 1.5 };
    return hall ? { x: hall.half_width - 2, z0: -hall.glass_y + 1.5, z1: -hall.back_y - 1.5 } : null;
  }

  resetView() { if (this.home && this.ship?.rig) this.frameShip(false); }

  /** stop rendering and drop the hall (used when showing a poster instead) */
  idle() { this.disposeFleet(); this.stop(); }

  /** the hull under a screen point (any ship in the hall) */
  pick(clientX, clientY) {
    if (!this.fleet) return null;
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    const ray = mkRay(); ray.setFromCamera(ndc, this.camera);
    const holders = [...this.fleet.values()].filter((e) => e.state === 'ready').map((e) => e.holder);
    const hit = ray.intersectObjects(holders, true).find((x) => x.object.isMesh && !/plume|rcs_glow/.test(x.object.material?.name || '') && x.object.material?.opacity > 0.05 && x.object.visible);
    if (!hit) return null;
    let o = hit.object;
    while (o && !o.userData.entry) o = o.parent;
    return o?.userData.entry || null;
  }

  // ---------------------------------------------------------------- points of interest
  /** POIs in the ship's own frame (nose -Z): derived from the hull bounds and the exported light anchors */
  buildPois(s) {
    const b = s.localBox, size = b.getSize(new THREE.Vector3()), ctr = b.getCenter(new THREE.Vector3());
    const L = Math.max(size.x, size.z, size.y * 0.8);
    const P = this.maker?.poi || {};
    const at = (f) => new THREE.Vector3(b.min.x + f[0] * size.x, b.min.y + f[1] * size.y, b.min.z + f[2] * size.z);
    const centroid = (list) => list.reduce((a, x) => a.add(x.pos), new THREE.Vector3()).divideScalar(list.length);
    const anchors = s.rig.anchorsLocal || [];
    const out = [];
    const big = s.model.length > 150;
    out.push({ key: 'cockpit', title: big ? 'Bridge' : 'Cockpit', text: P.cockpit, local: at([0.5, 0.72, 0.14]), dir: [0.6, 0.5, -1], dist: L * 0.3 });
    if (P.signature) out.push({ key: 'signature', title: P.signature_title, text: P.signature_text, local: at(P.signature[0]), dir: P.signature[1], dist: L * 0.4 });
    const dock = anchors.filter((a) => a.kind === 'docking');
    if (dock.length) {
      const p = centroid(dock), d = p.clone().sub(ctr); d.y = Math.max(d.y, 0) + size.y * 0.4;
      out.push({ key: 'docking', title: 'Docking', text: P.docking, local: p, dir: d.toArray(), dist: L * 0.26 });
    }
    const weapons = anchors.filter((a) => /weapon|turret|gun|hardpoint|missile/.test(a.kind));
    if (weapons.length) out.push({ key: 'weapons', title: 'Hardpoints', text: P.weapons || 'Hardpoints and turret barbettes.', local: centroid(weapons), dir: [0.6, 0.8, -0.2], dist: L * 0.3 });
    if (s.rig.hasGear) out.push({ key: 'gear', title: 'Landing gear', text: P.gear, local: at([0.5, 0.08, 0.55]), dir: [1, 0.1, 0.45], dist: L * 0.42, action: 'gear' });
    const eng = anchors.filter((a) => a.kind === 'engine');
    let dl = at([0.5, 0.5, 1]), spread = size.x * 0.5;
    if (eng.length) {
      dl = centroid(eng);
      spread = Math.max(...eng.map((a) => a.pos.distanceTo(dl)), 1);
    }
    out.push({ key: 'drives', title: 'Drives', text: P.drives, local: dl, dir: [0.5, 0.3, 1], dist: Math.max(L * 0.28, spread * 2.2) });
    const fov = THREE.MathUtils.degToRad(this.camera.fov);
    const hf = 2 * Math.atan(Math.tan(fov / 2) * this.camera.aspect);
    const fit = (L * 0.55) / Math.tan(Math.min(fov, hf) / 2);
    out.push({ key: 'profile', title: 'Profile', text: P.profile, local: ctr.clone(), dir: [1, 0.06, 0], dist: fit, flat: true });
    out.push({ key: 'top', title: 'Plan view', text: P.top, local: ctr.clone(), dir: [0.05, 1, 0.12], dist: fit, flat: true });
    for (const p of out) {
      p.dir = new THREE.Vector3(...p.dir).normalize();
      p.text ||= ({ cockpit: 'Where the crew sits.', drives: 'Main drives on the thrust axis.', gear: 'Landing gear.', docking: 'Docking collar.' })[p.key] || '';
    }
    return out;
  }

  /** Put every hotspot on the hull: cast a ray from outside, through the POI, onto the solid meshes; the dot
   *  sits 0.3 m off the hit along the surface normal and the tour camera looks at the hit point. */
  snapPois(e) {
    const root = e.rig.root;
    root.updateMatrixWorld(true);
    const q = root.getWorldQuaternion(new THREE.Quaternion()), qi = q.clone().invert();
    e.meshes = [];
    root.traverse((o) => { if (o.isMesh && !/plume|rcs_glow/.test(o.material.name || '') && !o.material.transparent) e.meshes.push(o); });
    const PROBES = { cockpit: [[0, 1, -0.35], [0.4, 0.6, -1]], drives: [[0, 0.15, 1], [0.4, 0.3, 1]], gear: [[1, -0.1, 0.2], [0, -1, 0]],
      weapons: [[0, 1, 0]], signature: [], docking: [] };
    const ray = mkRay();
    const reach = e.len * 2 + 10;
    for (const p of e.pois) {
      if (p.flat) continue;
      const pw = root.localToWorld(p.local.clone());
      let hit = null, dw = null;
      // the side the tour camera looks from first, then the per-type probes; a hit far from the POI (a sail,
      // a mast, the far side of a ring) is not this POI's surface
      const near = e.len * 0.22 + 1;
      for (const pr of [p.dir.toArray(), ...(PROBES[p.key] || [])]) {
        dw = new THREE.Vector3(...pr).normalize().applyQuaternion(q);
        ray.set(pw.clone().addScaledVector(dw, reach), dw.clone().negate());
        ray.far = reach * 2;
        hit = ray.intersectObjects(e.meshes, false).find((h) => h.point.distanceTo(pw) < near) || null;
        if (hit) break;
      }
      if (!hit) { p.nodot = true; continue; }
      const n = hit.face ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld) : dw.clone();
      if (n.dot(dw) < 0) n.negate();
      p.local = root.worldToLocal(hit.point.clone());
      p.dotLocal = root.worldToLocal(hit.point.clone().addScaledVector(n, 0.12));
      p.normalLocal = n.applyQuaternion(qi).normalize();
      // look at the surface from between the authored angle and the surface normal
      p.dir = p.dir.clone().add(p.normalLocal.clone().multiplyScalar(0.3)).normalize();
    }
  }

  /** fly to POI i (camera eases ~1.2 s); returns the POI */
  flyTo(i) {
    const s = this.ship;
    if (!s?.pois?.[i]) return null;
    const p = s.pois[i], root = s.rig.root;
    root.updateMatrixWorld(true);
    const target = root.localToWorld(p.local.clone());
    const q = root.getWorldQuaternion(new THREE.Quaternion());
    const dir = p.dir.clone().applyQuaternion(q);
    let dist = p.dist * root.scale.x;
    const b = this.bounds;
    if (p.key === 'top' && b) dist = Math.min(dist, Math.max(2, (b.maxH - 0.5 - target.y) / Math.max(dir.y, 0.3)));
    // the camera never leaves the room: giants outside are toured from the glass by turning to look
    const pos = target.clone().addScaledVector(dir, dist);
    if (b && !s.outdoor) pos.y = THREE.MathUtils.clamp(pos.y, b.top + 0.35, b.maxH);
    if (b?.box) { pos.x = THREE.MathUtils.clamp(pos.x, -b.box.x, b.box.x); pos.z = THREE.MathUtils.clamp(pos.z, b.box.z0, b.box.z1); }
    if (b && !s.outdoor) { this.clampRoom(pos); for (let k = 0; k < 3 && this.hullAt(pos); k++) { this.pushOut(pos, target); this.clampRoom(pos); } }
    if (s.outdoor) this.controls.maxDistance = Math.max(this.controls.maxDistance, pos.distanceTo(target) * 1.05);
    this.controls.minDistance = 0.3;
    if (p.action === 'gear') { this.S.gearDir = 1; }
    const instant = matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (instant) { this.camera.position.copy(pos); this.controls.target.copy(target); this.tween = null; this.controls.update(); }
    else this.tween = { p0: this.camera.position.clone(), t0: this.controls.target.clone(), p1: pos, t1: target, start: performance.now(), dur: 1200 };
    return p;
  }

  /** screen positions of the hull hotspots (not the profile / plan views) */
  hotspots(w, h) {
    const s = this.ship;
    if (!s?.pois || !s.rig || s.state !== 'ready' || this.walk) return [];
    const root = s.rig.root, q = root.getWorldQuaternion(new THREE.Quaternion());
    const now = performance.now(), ray = this._occRay ||= mkRay();
    const cam = this.camera.position, out = [];
    s.pois.forEach((p, i) => {
      if (p.flat || p.nodot) return;
      const wp = root.localToWorld((p.dotLocal || p.local).clone());
      const nrm = (p.normalLocal || p.dir).clone().applyQuaternion(q);
      const toCam = cam.clone().sub(wp);
      const facing = toCam.clone().normalize().dot(nrm);
      const v = wp.clone().project(this.camera);
      if (v.z > 1 || Math.abs(v.x) > 1.05 || Math.abs(v.y) > 1.05) return;
      // hidden behind the hull? (re-tested a few times a second)
      if (!p.occAt || now - p.occAt > 160) {
        p.occAt = now;
        const d = toCam.length();
        ray.set(cam, wp.clone().sub(cam).normalize()); ray.far = d;
        const hit = s.meshes?.length ? ray.intersectObjects(s.meshes, false)[0] : null;
        p.occluded = !!hit && hit.distance < d - 0.45;
      }
      if (p.occluded) return;
      out.push({ i, x: (v.x * 0.5 + 0.5) * w, y: (-v.y * 0.5 + 0.5) * h, facing });
    });
    return out;
  }

  // ---------------------------------------------------------------- walk-around (first person, the whole hall)
  setWalk(on) {
    if (!!this.walk === on || !this.room) return;
    const c = this.controls;
    if (on) {
      if (this.ship?.outdoor) {                         // walking happens in the hall: bring it back, start at the glass
        this.setOutside(false);
        const g = this.room.glassBox, fb = this.roomBox();
        this.camera.position.set(0, 1.7, (g ? Math.max(g.min.z, fb.z0) : fb.z0) + 6);
      }
      this.walkSaved = { spin: this.spin, fov: this.camera.fov };
      this.spin = false; this.tween = null; c.enabled = false;
      const p = this.camera.position;
      p.y = this.floorAt(p.x, p.z) + 1.7;
      this.collide(p);
      const look = (this.ship?.rig ? this.ship.rig.bounds().getCenter(new THREE.Vector3()) : c.target.clone()).sub(p);
      this.walk = { yaw: Math.atan2(-look.x, -look.z), pitch: THREE.MathUtils.clamp(Math.atan2(look.y, Math.hypot(look.x, look.z)), -0.6, 0.6),
        vel: new THREE.Vector3(), keys: new Set(), stick: { x: 0, y: 0 }, floor: p.y - 1.7, n: 0 };
      this.camera.fov = Math.max(this.camera.fov, 60); this.camera.updateProjectionMatrix();
    } else {
      this.walk = null;
      this.spin = this.walkSaved?.spin ?? this.spin;
      this.camera.fov = this.walkSaved?.fov ?? this.camera.fov; this.camera.updateProjectionMatrix();
      if (this.ship?.rig) {
        c.target.copy(this.ship.rig.bounds().getCenter(new THREE.Vector3()));
        c.enabled = true; c.update();
        this.frameShip(false);
      } else c.enabled = true;
    }
  }

  /** walkable area: showroom.json floor bounds / obstacles when exported, else the hall box; indoor hulls block */
  walkSpace() {
    if (this._walkSpace?.room === this.room) return this._walkSpace;
    const info = this.room.info, hall = info.hall;
    const w = info.walk || info.walkable || info.floor || {};
    const b = w.bounds || info.floor_bounds;
    const bounds = b?.x && b?.z ? { x0: b.x[0] + 0.5, x1: b.x[1] - 0.5, z0: b.z[0] + 0.5, z1: b.z[1] - 0.5 }
      : b && b.length === 4 ? { x0: b[0], z0: b[1], x1: b[2], z1: b[3] }
      : { x0: -hall.half_width + 1, x1: hall.half_width - 1, z0: -hall.glass_y + 1, z1: -hall.back_y - 1 };
    const obstacles = (w.obstacles || info.obstacles || []).filter((o) => !o.type || o.type === 'circle' || o.type === 'box' || o.min).map((o) => (o.radius != null
      ? { c: new THREE.Vector2(o.center[0], o.center[o.center.length === 3 ? 2 : 1]), r: o.radius }
      : { min: new THREE.Vector2(o.min[0], o.min[o.min.length === 3 ? 2 : 1]), max: new THREE.Vector2(o.max[0], o.max[o.max.length === 3 ? 2 : 1]) }));
    this._walkSpace = { room: this.room, bounds, obstacles };
    return this._walkSpace;
  }

  /** push a walker (camera position) out of hull footprints and obstacles, back inside the floor bounds */
  collide(p) {
    const { bounds, obstacles } = this.walkSpace();
    const pad = 0.45;
    for (const e of this.fleet?.values() || []) {
      if (e.outdoor || e.state !== 'ready' || !e.localBox) continue;
      // hull footprint: the hull's own x/z box, in its bay's frame (gear-height ships are solid walls here)
      const local = e.rig.root.worldToLocal(p.clone());
      const b = e.localBox;
      if (local.x > b.min.x - pad && local.x < b.max.x + pad && local.z > b.min.z - pad && local.z < b.max.z + pad) {
        const dx0 = local.x - (b.min.x - pad), dx1 = b.max.x + pad - local.x, dz0 = local.z - (b.min.z - pad), dz1 = b.max.z + pad - local.z;
        const m = Math.min(dx0, dx1, dz0, dz1);
        if (m === dx0) local.x = b.min.x - pad; else if (m === dx1) local.x = b.max.x + pad;
        else if (m === dz0) local.z = b.min.z - pad; else local.z = b.max.z + pad;
        const wp = e.rig.root.localToWorld(local);
        p.x = wp.x; p.z = wp.z;
      }
    }
    for (const o of obstacles) {
      if (o.c) {
        const d = new THREE.Vector2(p.x - o.c.x, p.z - o.c.y);
        if (d.length() < o.r + pad) { d.setLength(o.r + pad); p.x = o.c.x + d.x; p.z = o.c.y + d.y; }
      } else if (p.x > o.min.x - pad && p.x < o.max.x + pad && p.z > o.min.y - pad && p.z < o.max.y + pad) {
        const opts = [[p.x - (o.min.x - pad), 'x', o.min.x - pad], [o.max.x + pad - p.x, 'x', o.max.x + pad],
          [p.z - (o.min.y - pad), 'z', o.min.y - pad], [o.max.y + pad - p.z, 'z', o.max.y + pad]].sort((a, b) => a[0] - b[0]);
        p[opts[0][1]] = opts[0][2];
      }
    }
    p.x = THREE.MathUtils.clamp(p.x, bounds.x0, bounds.x1);
    p.z = THREE.MathUtils.clamp(p.z, bounds.z0, bounds.z1);
  }

  /** a quick key tap still moves: one 0.4 m step in that direction (holding keeps the smooth glide) */
  walkNudge(k) {
    const w = this.walk; if (!w) return;
    const fwd = new THREE.Vector3(-Math.sin(w.yaw), 0, -Math.cos(w.yaw));
    const right = new THREE.Vector3(Math.cos(w.yaw), 0, -Math.sin(w.yaw));
    const step = { f: fwd, b: fwd.clone().negate(), l: right.clone().negate(), r: right }[k];
    if (step) { this.camera.position.addScaledVector(step, 0.4); this.collide(this.camera.position); }
    if (k === 'tl') w.yaw += 0.12;
    if (k === 'tr') w.yaw -= 0.12;
  }

  updateWalk(dt) {
    const w = this.walk, p = this.camera.position, k = w.keys;
    const f = (k.has('f') ? 1 : 0) - (k.has('b') ? 1 : 0) - w.stick.y;
    const r = (k.has('r') ? 1 : 0) - (k.has('l') ? 1 : 0) + w.stick.x;
    if (k.has('tl')) w.yaw += dt * 1.6;
    if (k.has('tr')) w.yaw -= dt * 1.6;
    const speed = k.has('run') ? 7 : 3.2;
    const fwd = new THREE.Vector3(-Math.sin(w.yaw), 0, -Math.cos(w.yaw));
    const right = new THREE.Vector3(Math.cos(w.yaw), 0, -Math.sin(w.yaw));
    const want = fwd.multiplyScalar(f).add(right.multiplyScalar(r));
    if (want.lengthSq() > 1) want.normalize();
    w.vel.lerp(want.multiplyScalar(speed), 1 - Math.exp(-dt * 8));
    p.addScaledVector(w.vel, dt);
    this.collide(p);
    if (w.vel.lengthSq() > 0.01 && ++w.n % 6 === 0) w.floor = this.floorAt(p.x, p.z);   // step up onto the turntable
    p.y += (w.floor + 1.7 - p.y) * Math.min(1, dt * 10);
    this.camera.rotation.set(w.pitch, w.yaw, 0, 'YXZ');
  }

  // ---------------------------------------------------------------- input helpers
  orbit(dAz, dPol) {
    const c = this.controls, off = this.camera.position.clone().sub(c.target);
    const sph = new THREE.Spherical().setFromVector3(off);
    sph.theta += dAz; sph.phi = THREE.MathUtils.clamp(sph.phi + dPol, 0.15, c.maxPolarAngle);
    this.camera.position.copy(c.target).add(off.setFromSpherical(sph));
  }
  zoom(f) {
    const c = this.controls, off = this.camera.position.clone().sub(c.target);
    off.setLength(THREE.MathUtils.clamp(off.length() * f, c.minDistance, c.maxDistance));
    this.camera.position.copy(c.target).add(off);
  }

  // ---------------------------------------------------------------- frame
  tick() {
    const dt = Math.min(this.clock.getDelta(), 0.05), t = this.clock.elapsedTime;
    const tick0 = this.perf ? performance.now() : 0;
    if (this.roomFade) this.stepFade(performance.now());
    this.updateLods(performance.now());
    this.updateGiantVisibility(performance.now());
    if (this.fleet && !this.streaming && (this._viewCheck = (this._viewCheck || 0) + 1) % 30 === 0 &&
      [...this.fleet.values()].some((e) => e.state === 'pending' && e.outdoor && this.bayVisible(e))) this.streamRest();
    // every hull in the hall lives (lights, gear); only the focused one takes the visitor's system toggles
    const f = this.ship;
    // turntable motion: only the focused hull on the turntable turns, and only if its swept circle is clear;
    // otherwise the camera orbits the hull at the same rate (same effect, nothing ever passes through anything)
    const turn = !!(f?.rig && this.spin && !f.outdoor && !this.walk);
    const shipTurns = turn && f.bay.turntable && this.spinClear(f);
    if (shipTurns) { f.spinYaw += dt * 0.1; f.holder.rotation.y = f.yaw + f.spinYaw; this.shadowDirty = 1; }
    this.controls.autoRotate = turn && !shipTurns && !this.tween;
    this.controls.autoRotateSpeed = 60 * 0.1 / (2 * Math.PI);   // 0.1 rad/s, the turntable's rate
    // only the turntable hull casts a real-time shadow: re-render the map when it (or its gear) actually moves
    for (const e of this.fleet?.values() || []) if (e.bay?.turntable && e.rig && e.S.gearT > 0 && e.S.gearT < 1) this.shadowDirty = 1;
    if (this.shadowDirty > 0) { this.renderer.shadowMap.needsUpdate = true; this.shadowDirty--; }
    const expo = 1 / (this.renderer.toneMappingExposure || 1);
    if (this.fleet) for (const e of this.fleet.values()) if (e.rig) { e.S.expo = expo; e.rig.update(dt, t, e.S); }
    const c = this.controls;
    if (this.walk) {
      this.updateWalk(dt);
      if (this.perf) this.perf.cpu.push(performance.now() - tick0);
      this.render();
      return;
    }
    if (this.tween) {
      const k = ease(Math.min(1, (performance.now() - this.tween.start) / this.tween.dur));
      this.camera.position.lerpVectors(this.tween.p0, this.tween.p1, k);
      c.target.lerpVectors(this.tween.t0, this.tween.t1, k);
      if (k >= 1) { this.tween = null; this.onArrive?.(); }
    }
    c.enabled = !this.tween;
    c.update(dt);
    this.constrainCamera();
    if (this.perf) this.perf.cpu.push(performance.now() - tick0);
    this.render();
    // adaptive resolution, only while over budget: ~1 s above 20 ms steps down; ~3 s of headroom steps back up
    if (dt > 0.022) { this.slow++; this.fast = 0; } else { this.slow = Math.max(0, this.slow - 1); if (dt < 0.0135) this.fast = (this.fast || 0) + 1; }
    if (this.slow > 60 && this.dpr > 1) { this.setDpr(this.dpr - 0.25); this.slow = 0; }
    else if (this.fast > 180 && this.dpr < this.dprMax) { this.setDpr(this.dpr + 0.25); this.fast = 0; }
    // at rest: no input for a while and nothing animating that the visitor asked for -> one full-res frame, then sleep
    const resting = !this.tween && !this.roomFade && !this.walk && !this.dragging;
    if (resting && performance.now() - this.lastInput > IDLE_MS) {
      if (this.dpr !== this.dprMax) { this.setDpr(this.dprMax); this.render(); }
      this.sleeping = true; this.stop();
    }
  }

  /** Orbit-mode camera rules, every frame: inside the hall (floor box, floor to ceiling, out of pillars) and never
   *  inside any hull's box (+ margin, far more than the 5 cm near plane): a camera that would end up inside one is
   *  pushed out along the target->camera ray; if no clear spot exists it stays where it last was clear. */
  constrainCamera() {
    const b = this.bounds, c = this.controls, p = this.camera.position;
    if (!b) return;
    this.clampRoom(p);
    if (!b.focus?.outdoor) c.target.y = THREE.MathUtils.clamp(c.target.y, b.top + 0.2, b.maxH - 0.5);
    if (b.focus?.outdoor) return;
    for (let k = 0; k < 3 && this.hullAt(p); k++) { this.pushOut(p, c.target); this.clampRoom(p); }
    if (this.hullAt(p) && this.lastClear) p.copy(this.lastClear);
    else (this.lastClear ||= new THREE.Vector3()).copy(p);
  }

  clampRoom(p) {
    const b = this.bounds;
    p.y = THREE.MathUtils.clamp(p.y, b.top + b.minH, b.maxH);
    if (b.box) { p.x = THREE.MathUtils.clamp(p.x, -b.box.x, b.box.x); p.z = THREE.MathUtils.clamp(p.z, b.box.z0, b.box.z1); }
    if (!b.focus?.outdoor) for (const o of this.pillars()) {
      const dx = p.x - o.center[0], dz = p.z - o.center[1], d = Math.hypot(dx, dz), r = o.radius + CAM_MARGIN;
      if (d < r) { const k = d > 1e-6 ? r / d : 1; p.x = o.center[0] + (d > 1e-6 ? dx : r) * k; p.z = o.center[1] + dz * k; }
    }
  }

  /** room obstacles that are not ship bays (pillars, totems) */
  pillars() {
    if (this._pillars?.room === this.room) return this._pillars.list;
    const ents = [...(this.fleet?.values() || [])];
    const list = (this.room?.info.obstacles || []).filter((o) => o.type === 'circle' && !ents.some((f) => Math.hypot(f.base.x - o.center[0], f.base.z - o.center[1]) < 1.5));
    this._pillars = { room: this.room, list };
    return list;
  }

  /** the ready indoor hull whose box (grown by the camera margin) contains p, if any */
  hullAt(p, margin = CAM_MARGIN) {
    for (const e of this.fleet?.values() || []) {
      if (e.outdoor || !e.localBox || !e.rig) continue;
      const l = e.rig.root.worldToLocal(_v.copy(p)), bx = e.localBox;
      if (l.x > bx.min.x - margin && l.x < bx.max.x + margin && l.y > bx.min.y - margin && l.y < bx.max.y + margin &&
        l.z > bx.min.z - margin && l.z < bx.max.z + margin) return e;
    }
    return null;
  }

  /** move p out of the hull box it is in: along target->p to where that ray leaves the box (target inside the box,
   *  e.g. the focused hull), or back to where it enters it (another hull between target and camera) */
  pushOut(p, target) {
    const e = this.hullAt(p);
    if (!e) return;
    const root = e.rig.root, bx = e.localBox.clone().expandByScalar(CAM_MARGIN + 0.02);
    const lp = root.worldToLocal(p.clone()), lt = root.worldToLocal(target.clone());
    const dir = lp.clone().sub(lt);
    if (dir.lengthSq() < 1e-8) dir.set(0, 1, 0);
    dir.normalize();
    const ray = new THREE.Ray(lt, dir), hit = new THREE.Vector3();
    if (bx.containsPoint(lt)) {
      ray.origin.addScaledVector(dir, 1e4); ray.direction.negate();          // exit point = entry from the far side
      if (ray.intersectBox(bx, hit)) lp.copy(hit);
    } else if (ray.intersectBox(bx, hit)) lp.copy(hit).addScaledVector(dir, -0.02);
    p.copy(root.localToWorld(lp));
  }

  /** a single frame while the loop sleeps (a hull streamed in, the window resized) */
  redraw() {
    if (!this.sleeping || !this.room) return;
    this.renderer.shadowMap.needsUpdate = true;
    this.render();
  }

  setDpr(v) {
    this.dpr = THREE.MathUtils.clamp(v, 1, this.dprMax);
    this.renderer.setPixelRatio(this.dpr); this.resize();
  }

  /** one frame through the composer; with ?perf=1 it is timed (gl.finish, so GPU work counts) and reported */
  render() {
    this.frameCount = (this.frameCount || 0) + 1;
    if (!this.perf) { this.composer.render(); return; }
    const info0 = this.renderer.info;
    info0.autoReset = false; info0.reset();               // count every pass of the frame (reflection, bloom, output)
    const t0 = performance.now();
    this.composer.render();
    const t1 = performance.now();
    this.renderer.getContext().finish();
    const t2 = performance.now();
    this.perf.ms.push(t2 - t0); this.perf.submit.push(t1 - t0); this.perf.gpu.push(t2 - t1);
    for (const k of ['ms', 'submit', 'gpu', 'cpu']) if (this.perf[k].length > 300) this.perf[k].shift();
    const info = this.renderer.info;
    this.perf.calls = info.render.calls; this.perf.tris = info.render.triangles;
    if (performance.now() - this.perf.shown > 500) this.showPerf();
  }

  /** ?perf=1: every GPU texture / render target with its owner, size, format and estimated bytes (largest first) */
  perfTextures() {
    const items = [], seen = new Set();
    const BPP = { [THREE.FloatType]: 4, [THREE.HalfFloatType]: 2, [THREE.UnsignedByteType]: 1, [THREE.UnsignedIntType]: 4, [THREE.UnsignedInt248Type]: 4 };
    const CH = { [THREE.RGBAFormat]: 4, [THREE.RGBFormat]: 3, [THREE.RedFormat]: 1, [THREE.RGFormat]: 2, [THREE.DepthFormat]: 1, [THREE.DepthStencilFormat]: 1 };
    const fmt = (tex) => `${{ [THREE.FloatType]: 'f32', [THREE.HalfFloatType]: 'f16', [THREE.UnsignedByteType]: 'u8' }[tex.type] || tex.type}x${CH[tex.format] || '?'}`;
    const props = this.renderer.properties;
    // only what the GPU actually holds: three allocates textures / targets on first use
    const addTex = (tex, owner, name) => {
      if (!tex?.isTexture || seen.has(tex)) return; seen.add(tex);
      if (!props.get(tex).__webglTexture) return;
      if (tex.isCompressedTexture) { items.push({ owner, name: name || tex.name, size: '-', fmt: 'compressed', mip: true, bytes: (tex.mipmaps || []).reduce((a, m) => a + (m.data?.byteLength || 0), 0) }); return; }
      const img = tex.image || {}; const w = img.width || 0, h = img.height || 0;
      const mip = tex.generateMipmaps !== false && tex.minFilter !== THREE.LinearFilter && tex.minFilter !== THREE.NearestFilter;
      const bytes = w * h * (BPP[tex.type] || 1) * (CH[tex.format] || 4) * (mip ? 4 / 3 : 1) * (tex.isCubeTexture ? 6 : 1);
      items.push({ owner, name: name || tex.name || '', size: `${w}x${h}`, fmt: fmt(tex), mip, bytes });
    };
    const addRT = (rt, owner, name) => {
      if (!rt || seen.has(rt)) return; seen.add(rt);
      if (!props.get(rt).__webglFramebuffer) return;
      const tex = rt.texture; seen.add(tex);
      const px = rt.width * rt.height * (rt.isWebGLCubeRenderTarget ? 6 : 1);
      const color = px * (BPP[tex.type] || 1) * (CH[tex.format] || 4) * (tex.generateMipmaps ? 4 / 3 : 1);
      const msaa = rt.samples ? px * (BPP[tex.type] || 1) * 4 * rt.samples : 0;
      const depth = rt.depthBuffer ? px * 4 * (rt.samples || 1) : 0;
      items.push({ owner, name, size: `${rt.width}x${rt.height}${rt.samples ? ' msaa' + rt.samples : ''}`, fmt: fmt(tex), mip: !!tex.generateMipmaps, bytes: color + msaa + depth });
    };
    // scene textures, attributed to the hull / room / exterior that owns them
    const ownerOf = (o) => { for (let p = o; p; p = p.parent) { if (p.userData?.entry) return 'ship:' + p.userData.entry.model.model; if (p === this.room?.group) return 'room'; if (p === this.extGroup) return 'exterior'; } return 'scene'; };
    this.scene.traverse((o) => {
      const ms = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
      for (const m of ms) for (const k of Object.keys(m)) if (m[k]?.isTexture) addTex(m[k], ownerOf(o), `${m.name || m.type}.${k}`);
      if (o.isLight && o.shadow?.map) addRT(o.shadow.map, 'shadow', o.type + '.shadow');
    });
    for (const e of this.fleet?.values() || []) for (const s of e.lodSlots || []) if (s.base !== s.cur) addTex(s.base, 'ship:' + e.model.model, 'lod base');
    if (this.room?.envRT) addRT(this.room.envRT, 'env', 'PMREM');
    if (this.scene.background?.isTexture) addTex(this.scene.background, 'env', 'background');
    if (this.room?.floor?.refl) { addRT(this.room.floor.refl.getRenderTarget(), 'reflection', 'reflector'); addRT(this.room.floor.tmp, 'reflection', 'blur tmp'); }
    const c = this.composer; addRT(c.renderTarget1, 'postfx', 'composer 1'); addRT(c.renderTarget2, 'postfx', 'composer 2');
    const b = this.bloom; if (b) { addRT(b.renderTargetBright, 'postfx', 'bloom bright'); (b.renderTargetsHorizontal || []).forEach((r, i) => addRT(r, 'postfx', 'bloom h' + i)); (b.renderTargetsVertical || []).forEach((r, i) => addRT(r, 'postfx', 'bloom v' + i)); }
    return items.sort((a, b2) => b2.bytes - a.bytes).map((x) => ({ ...x, MB: +(x.bytes / 1e6).toFixed(1) }));
  }

  /** ?perf=1 HUD: frame time, draw calls, triangles, GPU resources, estimated texture memory, load cost */
  perfStats() {
    const p = this.perf, info = this.renderer.info;
    const seen = new Set(); let bytes = 0;
    const add = (tex) => {
      if (!tex || seen.has(tex)) return; seen.add(tex);
      if (tex.isCompressedTexture) { for (const mm of tex.mipmaps || []) bytes += mm.data?.byteLength || 0; return; }
      const img = tex.image; if (!img) return;
      const w = img.width || img.data?.width || 0, h = img.height || img.data?.height || 0;
      const bpp = tex.type === THREE.HalfFloatType ? 8 : tex.type === THREE.FloatType ? 16 : 4;
      bytes += w * h * bpp * (tex.generateMipmaps !== false ? 1.333 : 1) * (tex.isCubeTexture ? 6 : 1);
    };
    this.scene.traverse((o) => {
      const ms = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
      for (const m of ms) for (const k of Object.keys(m)) if (m[k]?.isTexture) add(m[k]);
    });
    if (this.scene.background?.isTexture) add(this.scene.background);

    const ms = p.ms.slice().sort((a, b) => a - b);
    const res = performance.getEntriesByType('resource');
    const loadMB = res.reduce((a, r) => a + (r.transferSize || r.encodedBodySize || 0), 0) / 1e6;
    return {
      frame_ms_p50: +(ms[Math.floor(ms.length / 2)] || 0).toFixed(1), frame_ms_p90: +(ms[Math.floor(ms.length * 0.9)] || 0).toFixed(1),
      calls: p.calls, tris: p.tris, geometries: info.memory.geometries, textures: info.memory.textures,
      tex_MB: +(bytes / 1e6).toFixed(0), dpr: this.dpr, frames: this.frameCount || 0,
      load_MB: +loadMB.toFixed(1), ready_s: this.readyAt ? +(this.readyAt / 1000).toFixed(1) : null,
    };
  }
  showPerf() {
    this.perf.shown = performance.now();
    if (!this.perf.el) {
      this.perf.el = document.createElement('pre');
      this.perf.el.style.cssText = 'position:absolute;right:8px;bottom:8px;z-index:50;margin:0;padding:8px 10px;background:rgba(0,0,0,.72);color:#9f9;font:11px/1.4 monospace;pointer-events:none;border-radius:4px';
      this.canvas.parentElement.append(this.perf.el);
    }
    const s = this.perfStats();
    this.perf.el.textContent = Object.entries(s).map(([k, v]) => `${k.padEnd(13)} ${v}`).join('\n');
  }

  dispose() {
    this.stop(); this.disposeRoom();
    this.ro.disconnect(); this.controls.dispose(); this.pmrem.dispose(); this.composer.dispose?.(); this.renderer.dispose();
  }
}
