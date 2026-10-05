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
import { rigShip } from './rig.js?v=153dec7100e24b34';

const v3 = (a) => new THREE.Vector3(a[0], a[1], a[2]);
const SCALES = [5, 10, 20, 25, 50, 100, 200, 250, 500, 1000];
const ease = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);

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
    const r = this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    r.toneMapping = THREE.AgXToneMapping;
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    this.dprMax = Math.min(devicePixelRatio || 1, matchMedia('(max-width: 760px)').matches ? 1.5 : 1.75);
    this.dpr = this.dprMax;
    r.setPixelRatio(this.dpr);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.05, 8000);
    const c = this.controls = new OrbitControls(this.camera, canvas);
    c.enableDamping = true; c.dampingFactor = 0.06; c.rotateSpeed = 0.7;
    c.enablePan = true; c.screenSpacePanning = true; c.panSpeed = 0.7;
    c.maxPolarAngle = THREE.MathUtils.degToRad(89);
    this.stage = new THREE.Group();           // the turntable: spins the ship (and its pedestal)
    this.scene.add(this.stage);

    this.composer = new EffectComposer(r);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.22, 0.5, 0.95);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    this.pmrem = new THREE.PMREMGenerator(r);
    this.gltf = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
    this.rgbe = new RGBELoader();
    this.clock = new THREE.Clock();
    this.room = null; this.ship = null; this.tween = null;
    this.spin = !matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.S = { gearT: 1, gearDir: 1, nav: true, strobe: true, thrust: 0, retro: 0, retroTarget: 0, rcs: 0 };
    this.shipToken = 0; this.roomToken = 0;
    this.running = false;
    this.slow = 0;

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(canvas);
    canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.stop(); onLost?.(); });
    // tap (not drag) on the ship
    let down = null;
    canvas.addEventListener('pointerdown', (e) => { down = [e.clientX, e.clientY]; });
    canvas.addEventListener('pointerup', (e) => {
      if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 6 || !this.ship) return;
      const rect = canvas.getBoundingClientRect();
      const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
      const ray = new THREE.Raycaster(); ray.setFromCamera(ndc, this.camera);
      if (ray.intersectObject(this.ship.holder, true).some((h) => h.object.isMesh)) onTap?.();
    });
    // affordances: grab / grabbing cursor, pointer + rim highlight + "click to hail" over the hull
    c.addEventListener('start', () => { this.dragging = true; canvas.style.cursor = 'grabbing'; onDrag?.(); });
    c.addEventListener('end', () => { this.dragging = false; canvas.style.cursor = ''; });
    let hoverAt = 0, hoverEv = null;
    canvas.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'touch') return;
      hoverEv = e;
      const now = performance.now();
      if (now - hoverAt < 90 || this.dragging || this.walk || !this.ship) return;
      hoverAt = now;
      const rect = canvas.getBoundingClientRect();
      const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
      const ray = new THREE.Raycaster(); ray.setFromCamera(ndc, this.camera);
      const hit = ray.intersectObject(this.ship.holder, true).some((x) => x.object.isMesh && !x.object.material?.transparent);
      this.ship.rig.setHighlight(hit ? 1 : 0);
      canvas.style.cursor = hit ? 'pointer' : '';
      onHover?.(hit, e.clientX - rect.left, e.clientY - rect.top);
    });
    canvas.addEventListener('pointerleave', () => { this.ship?.rig.setHighlight(0); canvas.style.cursor = ''; onHover?.(false); void hoverEv; });

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

  // ---------------------------------------------------------------- lifecycle
  start() {
    if (this.running) return;
    this.running = true; this.clock.getDelta();
    this.renderer.setAnimationLoop(() => this.tick());
  }
  stop() { this.running = false; this.renderer.setAnimationLoop(null); }

  resize() {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    this.camera.aspect = w / h;
    const fov = this.room?.info.camera.fov ?? 40;
    this.camera.fov = w / h < 0.8 ? Math.min(62, fov * 1.25) : fov;
    this.camera.updateProjectionMatrix();
  }

  /** Load (if needed) room + ship; progress(fraction, label). Resolves when the ship is on the turntable. */
  async show(maker, ship, progress = () => {}) {
    this.maker = maker;
    if (this.walk) this.setWalk(false);
    const needRoom = this.room?.id !== maker.id;
    const total = (needRoom && maker.room ? maker.room.bytes : 0) + ship.glb.bytes;
    const got = {};
    const tick = (key, label) => (e) => {
      if (!e.lengthComputable && !e.total) return;
      got[key] = e.loaded;
      const sum = Object.values(got).reduce((a, b) => a + b, 0);
      progress(Math.min(1, sum / total), `${label} · ${(sum / 1e6).toFixed(1)} / ${(total / 1e6).toFixed(1)} MB`);
    };
    progress(0, 'Preparing');
    const roomP = needRoom ? this.loadRoom(maker, tick) : Promise.resolve();
    roomP.catch(() => {});
    await this.loadShip(ship, tick('ship', `Loading ${ship.name}`), roomP);
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
      built = this.buildBakedRoom(info, gl, env, bg);
    } else {
      built = this.buildStudio(maker.theme, info);
    }
    this.disposeShip();
    this.disposeRoom();
    this.room = { id: maker.id, info, totem: maker.totem || null, ...built };
    this.scene.add(this.room.group);
    this.renderer.toneMappingExposure = info.tone_mapping?.exposure ?? 1;
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
    this.scene.fog = null;
    const rot = THREE.MathUtils.degToRad(info.env?.rotation_y || 0);
    this.scene.environmentRotation.set(0, rot, 0);
    this.scene.backgroundRotation.set(0, rot, 0);
    const hall = info.hall;
    const floor = this.addFloorReflection(group, info, 2 * hall.half_width, hall.glass_y - hall.back_y, -(hall.back_y + hall.glass_y) / 2, info.turntable.top);
    this.addLights(group, info);
    return { group, envRT, bgTex, floor };
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
    return { dispose() { refl.dispose(); tmp.dispose(); mat.dispose(); quad.dispose(); } };
  }

  addLights(group, info) {
    const tt = info.turntable, top = tt.top;
    const key = new THREE.DirectionalLight(new THREE.Color(...info.key_light.color), info.key_light.intensity);
    const kd = v3(info.key_light.direction).normalize();
    key.position.copy(kd.clone().multiplyScalar(-80)).add(new THREE.Vector3(0, top, 0));
    key.target.position.set(0, top, 0);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    const R = tt.radius + 6;
    Object.assign(key.shadow.camera, { left: -R, right: R, top: R, bottom: -R, near: 20, far: 160 });
    key.shadow.bias = -0.0005; key.shadow.normalBias = 0.04; key.shadow.radius = 6;
    group.add(key, key.target);
    if (info.fill_light) {
      const fill = new THREE.DirectionalLight(new THREE.Color(...info.fill_light.color), info.fill_light.intensity);
      fill.position.copy(v3(info.fill_light.direction).normalize().multiplyScalar(-80));
      group.add(fill, fill.target);
    }
    // the ship's own contact shadow (the floor itself is baked)
    const catcher = new THREE.Mesh(new THREE.CircleGeometry(tt.radius + 12, 96), new THREE.ShadowMaterial({ opacity: 0.55, depthWrite: false }));
    catcher.rotation.x = -Math.PI / 2; catcher.position.y = top + 0.01;
    catcher.receiveShadow = true; catcher.renderOrder = 2;
    group.add(catcher);
  }

  disposeRoom() {
    if (!this.room) return;
    const r = this.room;
    this.scene.remove(r.group);
    r.floor.dispose();
    disposeTree(r.group);
    r.envRT.dispose();
    r.bgTex?.dispose();
    this.scene.environment = null; this.scene.background = null; this.scene.fog = null;
    this.room = null;
  }

  // ---------------------------------------------------------------- ship
  async loadShip(ship, onProgress, roomReady) {
    const token = ++this.shipToken;
    const gl = await this.gltf.loadAsync(ship.glb.src, onProgress);
    try { await roomReady; } catch (e) { disposeTree(gl.scene); throw e; }   // turntable + hall decide placement
    if (token !== this.shipToken || !this.room) { disposeTree(gl.scene); return; }
    const max = this.room.info.turntable.max_ship_length;
    // decide full size vs scale model from the real extent of the exported hull
    gl.scene.updateMatrixWorld(true);
    const probe = new THREE.Box3();
    gl.scene.traverse((o) => { if (o.isMesh && !/plume|rcs_glow/.test(o.material.name || '')) probe.expandByObject(o); });
    const len = Math.max(probe.max.z - probe.min.z, probe.max.x - probe.min.x);
    const fits = len <= max * 1.08;
    const rig = rigShip(gl, { realLights: fits, length: ship.length });
    this.disposeShip();
    this.S.gearT = 1; this.S.gearDir = 1;
    this.ship = { id: ship.id, model: ship, rig, holder: new THREE.Group(), extras: [], fits, len, N: 1 };
    this.placeShip(this.ship, false);
  }

  placeShip(s, keepCamera) {
    const info = this.room.info, tt = info.turntable, top = tt.top;
    const { rig, holder } = s;
    for (const e of s.extras) { holder.remove(e); disposeTree(e); }
    s.extras = [];
    this.stage.remove(holder);
    const root = rig.root;
    root.position.set(0, 0, 0); root.scale.setScalar(1);
    holder.add(root);
    const box = rig.bounds();                          // root is at identity here: this is the ship's own frame
    const size = box.getSize(new THREE.Vector3());
    s.localBox = box.clone();
    s.plinthR = 0;
    let scale = 1, base = top;
    s.N = 1;
    if (!s.fits) {
      const target = Math.min(tt.max_ship_length * 0.42, 14);
      s.N = SCALES.find((n) => s.len / n <= target) || Math.ceil(s.len / target);
      scale = 1 / s.N;
      // dealer pedestal: satin plinth + slim stand, accent hairline on the top edge
      const mh = size.y * scale, ml = s.len * scale;
      const R = THREE.MathUtils.clamp(ml * 0.2, 0.9, 3.2), P = 0.9;
      s.plinthR = R;
      const plinth = new THREE.Mesh(new THREE.CylinderGeometry(R, R * 1.03, P, 96),
        new THREE.MeshStandardMaterial({ color: 0x17181b, roughness: 0.3, metalness: 0.15 }));
      plinth.position.y = top + P / 2; plinth.castShadow = true; plinth.receiveShadow = true;
      const rodH = 0.45 + 0.25 * mh;
      const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.05, rodH, 16),
        new THREE.MeshStandardMaterial({ color: 0x9a9ea3, roughness: 0.25, metalness: 1 }));
      rod.position.y = top + P + rodH / 2; rod.castShadow = true;
      const lip = new THREE.Mesh(new THREE.TorusGeometry(R * 0.995, 0.01, 6, 128),
        new THREE.MeshBasicMaterial({ color: 0xcccccc }));
      lip.rotation.x = Math.PI / 2; lip.position.y = top + P + 0.001;
      s.extras.push(plinth, rod, lip);
      holder.add(plinth, rod, lip);
      base = top + P + rodH;
    }
    root.scale.setScalar(scale);
    const cx = (box.min.x + box.max.x) / 2, cz = (box.min.z + box.max.z) / 2;
    root.position.set(-cx * scale, base - box.min.y * scale + (s.fits && !rig.hasGear ? Math.max(0.6, size.y * 0.12) : 0), -cz * scale);
    const c = v3(tt.center || [0, top, 0]);
    this.stage.position.set(c.x, 0, c.z);
    if (!keepCamera) {
      // hero opening: camera at a 3/4 angle, ship turned so its nose (-Z) points 35 degrees off the camera line
      this.heroAz = this.heroAzimuth();
      this.stage.rotation.y = this.heroAz + this.heroSide * THREE.MathUtils.degToRad(35) - Math.PI;
    }
    this.stage.add(holder);
    s.pois = this.buildPois(s);
    this.frameShip(keepCamera);
  }

  /** horizontal camera azimuth for the opening shot: the room's authored camera, swung 45 degrees off the spec
   *  totem (a baked prop at the turntable's edge) so it never stands between the lens and the hull */
  heroAzimuth() {
    const info = this.room.info, cam = info.camera, c = v3(info.turntable.center || [0, 0, 0]);
    const a = v3(cam.position).sub(v3(cam.target));
    let az = Math.atan2(a.x, a.z);
    this.heroSide = 1;
    const tot = this.room.totem;
    if (tot) {
      // try 40..80 degrees either side of the totem; keep the direction with the most floor behind the camera
      const tAz = Math.atan2(tot[0] - c.x, tot[1] - c.z);
      const hall = info.hall;
      const avail = (x) => {                               // horizontal distance from the turntable to the hall wall
        if (!hall) return 100;
        const dx = Math.sin(x), dz = Math.cos(x), hw = hall.half_width - 2;
        const z0 = -hall.glass_y + 1.5, z1 = -hall.back_y - 1.5;
        const tx = dx > 0 ? (hw - c.x) / dx : dx < 0 ? (-hw - c.x) / dx : Infinity;
        const tz = dz > 0 ? (z1 - c.z) / dz : dz < 0 ? (z0 - c.z) / dz : Infinity;
        return Math.min(tx, tz);
      };
      let best = -Infinity;
      for (let deg = 40; deg <= 80; deg += 5) {
        for (const side of [1, -1]) {
          const x = tAz + side * THREE.MathUtils.degToRad(deg);
          const score = Math.min(avail(x), 60) - 0.04 * deg;
          if (score > best) { best = score; az = x; this.heroSide = side; }
        }
      }
    }
    return az;
  }

  frameShip(instant) {
    const info = this.room.info, cam = info.camera, tt = info.turntable;
    this.ship.holder.updateMatrixWorld(true);
    // frame the hull itself (a pedestal may sit under it; nudge the pivot down a little to keep it in shot)
    const sphere = this.ship.rig.bounds().getBoundingSphere(new THREE.Sphere());
    if (!this.ship.fits) sphere.center.y -= sphere.radius * 0.3;
    const vfov = THREE.MathUtils.degToRad(this.camera.fov);
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * this.camera.aspect);
    // bounding spheres of long hulls are generous: frame at ~3/4 of the sphere, never further than the room's
    // authored hero camera for a full-size ship (it is placed to stay inside the hall)
    const fit = 0.78 * sphere.radius / Math.tan(Math.min(vfov, hfov) / 2);
    const authored = v3(cam.position).distanceTo(v3(cam.target));
    const el = THREE.MathUtils.degToRad(this.ship.fits ? 18 : 24);
    const az = this.heroAz ?? 0;
    const dir = new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el));
    const target = sphere.center.clone();
    const far = this.ship.fits ? Math.min(authored * 1.05, cam.orbit_max_distance) : cam.orbit_max_distance;
    const dist = THREE.MathUtils.clamp(fit, Math.min(sphere.radius * 1.3, far), far);
    const pos = target.clone().addScaledVector(dir, dist);
    pos.y = THREE.MathUtils.clamp(pos.y, tt.top + (cam.min_height ?? 1), cam.max_height ?? 50);
    const c = this.controls;
    c.minDistance = Math.max(0.4, sphere.radius * 0.12);   // close enough to read the stencils
    c.maxDistance = Math.max(dist * 1.2, Math.min(cam.orbit_max_distance, authored * 1.6));
    this.home = { pos: pos.clone(), target: target.clone() };
    // hall box in three.js coords (showroom.json "hall" is in Blender Y: z = -y), with a margin off the walls
    const hall = info.hall;
    const box = hall ? { x: hall.half_width - 2, z0: -hall.glass_y + 1.5, z1: -hall.back_y - 1.5 } : null;
    this.bounds = { r: tt.radius, top: tt.top, minH: cam.min_height ?? 1, maxH: cam.max_height ?? 50, box };
    if (box) {
      pos.x = THREE.MathUtils.clamp(pos.x, -box.x, box.x);
      pos.z = THREE.MathUtils.clamp(pos.z, box.z0, box.z1);
    }
    if (instant || !this.running || matchMedia('(prefers-reduced-motion: reduce)').matches) {
      this.camera.position.copy(pos); c.target.copy(target); this.tween = null; c.update();
    } else {
      this.tween = { p0: this.camera.position.clone(), t0: c.target.clone(), p1: pos, t1: target, start: performance.now(), dur: 1400 };
      this.onArrive = null;
    }
  }

  resetView() { if (this.home && this.ship) this.frameShip(false); }

  disposeShip() {
    if (!this.ship) return;
    const s = this.ship;
    this.stage.remove(s.holder);
    for (const e of s.extras) disposeTree(e);
    s.rig.dispose();
    this.ship = null;
  }

  /** drop the ship (e.g. when the next one has no real-time model) and stop rendering */
  idle() { ++this.shipToken; this.disposeShip(); this.stop(); }

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
    const pos = target.clone().addScaledVector(dir, dist);
    if (b) pos.y = Math.max(pos.y, b.top + 0.35);
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
    if (!s?.pois || this.walk) return [];
    const root = s.rig.root, q = root.getWorldQuaternion(new THREE.Quaternion());
    const cam = this.camera.position, out = [];
    s.pois.forEach((p, i) => {
      if (p.flat) return;
      const wp = root.localToWorld(p.local.clone());
      const facing = cam.clone().sub(wp).normalize().dot(p.dir.clone().applyQuaternion(q));
      const v = wp.clone().project(this.camera);
      if (v.z > 1 || Math.abs(v.x) > 1.05 || Math.abs(v.y) > 1.05) return;
      out.push({ i, x: (v.x * 0.5 + 0.5) * w, y: (-v.y * 0.5 + 0.5) * h, facing });
    });
    return out;
  }

  // ---------------------------------------------------------------- walk-around (first person)
  setWalk(on) {
    if (!!this.walk === on || !this.room) return;
    const c = this.controls;
    if (on) {
      this.walkSaved = { spin: this.spin, fov: this.camera.fov };
      this.spin = false; this.tween = null; c.enabled = false;
      const p = this.camera.position, ctr = this.stage.position;
      const flat = new THREE.Vector2(p.x - ctr.x, p.z - ctr.z);
      const R = this.walkBlock() + 4;
      if (flat.length() < R) flat.setLength(R);
      p.set(ctr.x + flat.x, 1.7, ctr.z + flat.y);
      const look = (this.ship ? this.ship.rig.bounds().getCenter(new THREE.Vector3()) : ctr.clone()).sub(p);
      this.walk = { yaw: Math.atan2(-look.x, -look.z), pitch: Math.atan2(look.y, Math.hypot(look.x, look.z)) * 0.6,
        vel: new THREE.Vector3(), keys: new Set(), stick: { x: 0, y: 0 } };
      this.camera.fov = Math.max(this.camera.fov, 60); this.camera.updateProjectionMatrix();
    } else {
      this.walk = null;
      this.spin = this.walkSaved?.spin ?? this.spin;
      this.camera.fov = this.walkSaved?.fov ?? this.camera.fov; this.camera.updateProjectionMatrix();
      if (this.ship) {
        c.target.copy(this.ship.rig.bounds().getCenter(new THREE.Vector3()));
        c.enabled = true; c.update();
        this.frameShip(false);
      } else c.enabled = true;
    }
  }
  /** radius around the turntable centre a walker cannot enter: the turntable edge, or the pedestal for scale models */
  walkBlock() {
    const tt = this.room.info.turntable;
    return this.ship && !this.ship.fits ? this.ship.plinthR + 0.6 : tt.radius + 0.6;
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
    // collide: keep off the turntable / pedestal, inside the hall
    const ctr = this.stage.position, tt = this.room.info.turntable;
    const flat = new THREE.Vector2(p.x - ctr.x, p.z - ctr.z), R = this.walkBlock();
    if (flat.length() < R) { flat.setLength(R); p.x = ctr.x + flat.x; p.z = ctr.z + flat.y; }
    const box = this.bounds?.box;
    if (box) { p.x = THREE.MathUtils.clamp(p.x, -box.x + 0.5, box.x - 0.5); p.z = THREE.MathUtils.clamp(p.z, box.z0 + 0.5, box.z1 - 0.5); }
    const floor = flat.length() < tt.radius ? tt.top : 0;
    p.y += (floor + 1.7 - p.y) * Math.min(1, dt * 10);
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
    if (this.spin) this.stage.rotation.y += dt * 0.1;
    this.ship?.rig.update(dt, t, this.S);
    const c = this.controls;
    if (this.walk) {
      this.updateWalk(dt);
      this.composer.render();
      return;
    }
    if (this.tween) {
      const k = ease(Math.min(1, (performance.now() - this.tween.start) / this.tween.dur));
      this.camera.position.lerpVectors(this.tween.p0, this.tween.p1, k);
      c.target.lerpVectors(this.tween.t0, this.tween.t1, k);
      if (k >= 1) { this.tween = null; this.onArrive?.(); }
    }
    c.enabled = !this.tween;
    c.update();
    if (this.bounds) {                                   // keep the camera inside the hall, the pivot on the turntable
      const b = this.bounds, p = this.camera.position;
      p.y = THREE.MathUtils.clamp(p.y, b.top + b.minH, b.maxH);
      if (b.box) { p.x = THREE.MathUtils.clamp(p.x, -b.box.x, b.box.x); p.z = THREE.MathUtils.clamp(p.z, b.box.z0, b.box.z1); }
      const flat = new THREE.Vector2(c.target.x - this.stage.position.x, c.target.z - this.stage.position.z);
      if (flat.length() > b.r) { flat.setLength(b.r); c.target.x = this.stage.position.x + flat.x; c.target.z = this.stage.position.z + flat.y; }
      c.target.y = THREE.MathUtils.clamp(c.target.y, b.top + 0.2, b.maxH - 0.5);
    }
    this.composer.render();
    // adaptive resolution: step the pixel ratio down if frames stay slow
    if (dt > 0.034) this.slow++; else this.slow = Math.max(0, this.slow - 1);
    if (this.slow > 90 && this.dpr > 1) {
      this.dpr = Math.max(1, this.dpr - 0.25); this.slow = 0;
      this.renderer.setPixelRatio(this.dpr); this.resize();
    }
  }

  dispose() {
    this.stop(); this.disposeShip(); this.disposeRoom();
    this.ro.disconnect(); this.controls.dispose(); this.pmrem.dispose(); this.composer.dispose?.(); this.renderer.dispose();
  }
}
