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

/** Replace every texture image in a loaded glTF with a 1/f-resolution copy before it is ever uploaded. */
async function downscaleTextures(root, f) {
  const seen = new Set();
  const jobs = [];
  root.traverse((o) => {
    const ms = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
    for (const m of ms) for (const k of Object.keys(m)) {
      const tex = m[k];
      if (!tex?.isTexture || seen.has(tex) || !tex.image || tex.image.width <= 256) continue;
      seen.add(tex);
      const img = tex.image;
      jobs.push(createImageBitmap(img, { resizeWidth: Math.max(64, Math.round(img.width / f)), resizeHeight: Math.max(64, Math.round(img.height / f)), resizeQuality: 'medium' })
        .then((bmp) => { tex.image = bmp; tex.needsUpdate = true; img.close?.(); })
        .catch(() => {}));
    }
  });
  await Promise.all(jobs);
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
    this._S0 = { gearT: 1, gearDir: 1, nav: true, strobe: true, thrust: 0, retro: 0, retroTarget: 0, rcs: 0 };
    this.roomToken = 0; this.fleetToken = 0; this.fleet = null;
    this.running = false;
    this.slow = 0;

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
    this.disposeRoom();
    this.room = { id: maker.id, info, totem: maker.totem || null, ...built };
    this.room.floorMeshes = [];
    this.room.group.traverse((o) => { if (o.isMesh && /floor/.test(o.name)) this.room.floorMeshes.push(o); });
    this.room.group.updateMatrixWorld(true);
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
    const tt = info.turntable, top = tt.top, hall = info.hall;
    const key = new THREE.DirectionalLight(new THREE.Color(...info.key_light.color), info.key_light.intensity);
    const kd = v3(info.key_light.direction).normalize();
    // the shadow camera covers the whole hall floor: every indoor bay gets a real-time contact shadow
    const cz = hall ? -(hall.glass_y + hall.back_y) / 2 : 0;
    const R = hall ? Math.max(hall.half_width, (hall.glass_y - hall.back_y) / 2) + 4 : tt.radius + 6;
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
    this.hallCatcher = hall ? mk(new THREE.PlaneGeometry(2 * hall.half_width, hall.glass_y - hall.back_y), top + 0.01) : null;
    if (this.hallCatcher) this.hallCatcher.position.z = cz;
  }

  /** floor height under (x, z): ray down onto the baked floor mesh (turntable top included) */
  floorAt(x, z) {
    const r = this.room;
    if (!r?.floorMeshes?.length) return r?.info.turntable.top ?? 0;
    const ray = new THREE.Raycaster(new THREE.Vector3(x, 60, z), new THREE.Vector3(0, -1, 0), 0, 200);
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
      this.addGhost(e);
      this.fleet.set(s.id, e);
    }
  }

  /** silhouette card standing in the bay until the hull streams in */
  addGhost(e) {
    const sil = e.model.silhouette;
    if (!sil) return;
    const L = e.model.length, H = L * sil.aspect;
    const tex = new THREE.TextureLoader().load(sil.src);
    const m = new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0.18, depthWrite: false, side: THREE.DoubleSide, color: 0xffffff });
    const g = new THREE.Mesh(new THREE.PlaneGeometry(L, H), m);
    g.rotation.y = Math.PI / 2;                       // side view along the hull's z axis
    g.position.y = e.outdoor ? 0 : H / 2;
    e.ghost = g;
    e.holder.add(g);
  }

  disposeFleet() {
    if (!this.fleet) return;
    ++this.fleetToken;
    for (const e of this.fleet.values()) {
      this.scene.remove(e.holder);
      if (e.ghost) disposeTree(e.ghost);
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
      // giants seen through the glass from hundreds of metres: quarter-resolution textures keep GPU memory sane
      if (e.outdoor) await downscaleTextures(gl.scene, 4);
      if (token !== this.fleetToken) { disposeTree(gl.scene); return null; }
      const rig = rigShip(gl, { realLights: false, length: e.model.length });
      e.rig = rig;
      this.placeEntry(e);
      if (e.ghost) { e.holder.remove(e.ghost); disposeTree(e.ghost); e.ghost = null; }
      e.state = 'ready';
      return e;
    })();
    return e.promise;
  }

  placeEntry(e) {
    const root = e.rig.root;
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
    const cx = (box.min.x + box.max.x) / 2, cz = (box.min.z + box.max.z) / 2, cy = (box.min.y + box.max.y) / 2;
    // indoor: stand on the bay floor (hover a little if the hull has no gear); outdoor: bay position is the hull centre
    const y = e.outdoor ? -cy : -box.min.y + (e.rig.hasGear ? 0 : Math.max(0.6, size.y * 0.12));
    root.position.set(-cx, y, -cz);
    e.pois = this.buildPois(e);
    e.holder.updateMatrixWorld(true);
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
    this.frameShip(instant);
    this.streamRest();
  }

  /** load the remaining hulls in the background: indoor first, then the giants outside */
  async streamRest() {
    if (this.streaming) return;
    this.streaming = true;
    const token = this.fleetToken;
    try {
      const rest = [...this.fleet.values()].filter((x) => x.state === 'pending')
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
    const info = this.room.info, hall = info.hall;
    const c = e.base;
    const nose = e.yaw + Math.PI;                       // hull nose is local -Z
    const avail = (x) => {
      if (!hall) return 100;
      const dx = Math.sin(x), dz = Math.cos(x), hw = hall.half_width - 2;
      const z0 = -hall.glass_y + 1.5, z1 = -hall.back_y - 1.5;
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
      if (score > best) { best = score; az = x; }
    }
    return { az, avail: avail(az) };
  }

  frameShip(instant) {
    const e = this.ship, info = this.room.info, cam = info.camera, tt = info.turntable, hall = info.hall;
    e.holder.updateMatrixWorld(true);
    const sphere = e.rig.bounds().getBoundingSphere(new THREE.Sphere());
    const vfov = THREE.MathUtils.degToRad(this.camera.fov);
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * this.camera.aspect);
    const fit = 0.8 * sphere.radius / Math.tan(Math.min(vfov, hfov) / 2);
    const target = sphere.center.clone();
    let pos;
    const box = hall ? { x: hall.half_width - 2, z0: -hall.glass_y + 1.5, z1: -hall.back_y - 1.5 } : null;
    if (e.outdoor && hall) {
      // giants outside: stand at the glass and look out at them
      pos = new THREE.Vector3(THREE.MathUtils.clamp(target.x * 0.08, -box.x + 2, box.x - 2), tt.top + (cam.min_height ?? 1.2) + 2.5, box.z0 + 3);
      target.y = Math.min(target.y, pos.y + 0.5);       // look level/out; orbit polar limit forbids looking up
    } else {
      const { az, avail } = this.heroAzimuth(e);
      const el = THREE.MathUtils.degToRad(20);
      const dir = new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el));
      const dist = Math.max(Math.min(fit, avail / Math.cos(el) - 0.5), sphere.radius * 0.9);
      pos = target.clone().addScaledVector(dir, dist);
    }
    pos.y = THREE.MathUtils.clamp(pos.y, tt.top + (cam.min_height ?? 1), cam.max_height ?? 50);
    if (box) { pos.x = THREE.MathUtils.clamp(pos.x, -box.x, box.x); pos.z = THREE.MathUtils.clamp(pos.z, box.z0, box.z1); }
    const c = this.controls;
    const d = pos.distanceTo(target);
    c.minDistance = e.outdoor ? d * 0.4 : Math.max(0.4, sphere.radius * 0.12);
    c.maxDistance = e.outdoor ? d * 1.05 : Math.max(d * 1.3, cam.orbit_max_distance);
    this.home = { pos: pos.clone(), target: target.clone() };
    this.bounds = { r: Infinity, top: tt.top, minH: cam.min_height ?? 1, maxH: cam.max_height ?? 50, box, focus: e };
    if (instant || !this.running || matchMedia('(prefers-reduced-motion: reduce)').matches) {
      this.camera.position.copy(pos); c.target.copy(target); this.tween = null; c.update();
    } else {
      this.tween = { p0: this.camera.position.clone(), t0: c.target.clone(), p1: pos, t1: target, start: performance.now(), dur: 1500 };
    }
  }

  resetView() { if (this.home && this.ship?.rig) this.frameShip(false); }

  /** stop rendering and drop the hall (used when showing a poster instead) */
  idle() { this.disposeFleet(); this.stop(); }

  /** the hull under a screen point (any ship in the hall) */
  pick(clientX, clientY) {
    if (!this.fleet) return null;
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    const ray = new THREE.Raycaster(); ray.setFromCamera(ndc, this.camera);
    const holders = [...this.fleet.values()].filter((e) => e.state === 'ready').map((e) => e.holder);
    const hit = ray.intersectObjects(holders, true).find((x) => x.object.isMesh && !x.object.material?.transparent);
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
    if (s.outdoor && this.bounds) {                     // a giant outside: the tour camera may leave the hall
      this.bounds = { ...this.bounds, box: null, maxH: 1e5, minH: -1e5 };
      this.controls.maxDistance = 1e5;
    }
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
    if (!s?.pois || !s.rig || this.walk) return [];
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

  // ---------------------------------------------------------------- walk-around (first person, the whole hall)
  setWalk(on) {
    if (!!this.walk === on || !this.room) return;
    const c = this.controls;
    if (on) {
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
    const bounds = b && b.length === 4 ? { x0: b[0], z0: b[1], x1: b[2], z1: b[3] }
      : { x0: -hall.half_width + 1, x1: hall.half_width - 1, z0: -hall.glass_y + 1, z1: -hall.back_y - 1 };
    const obstacles = (w.obstacles || info.obstacles || []).map((o) => (o.radius != null
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
    // every hull in the hall lives (lights, gear); only the focused one takes the visitor's system toggles
    const f = this.ship;
    if (f?.rig && this.spin && !f.outdoor) { f.spinYaw += dt * 0.1; f.holder.rotation.y = f.yaw + f.spinYaw; }
    if (this.fleet) for (const e of this.fleet.values()) if (e.rig) e.rig.update(dt, t, e.S);
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
      if (!b.focus?.outdoor) c.target.y = THREE.MathUtils.clamp(c.target.y, b.top + 0.2, b.maxH - 0.5);
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
    this.stop(); this.disposeRoom();
    this.ro.disconnect(); this.controls.dispose(); this.pmrem.dispose(); this.composer.dispose?.(); this.renderer.dispose();
  }
}
