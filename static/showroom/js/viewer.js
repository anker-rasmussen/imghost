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
import { rigShip } from './rig.js?v=9fb807cba83085d0';

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
  constructor(canvas, { onTap, onLost } = {}) {
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
    this.room = { id: maker.id, info, ...built };
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
      uniforms: { tex: { value: null }, dir: { value: new THREE.Vector2() } },
      vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: `uniform sampler2D tex; uniform vec2 dir; varying vec2 vUv;
        void main() {
          vec4 c = texture2D(tex, vUv) * 0.2270270270;
          c += (texture2D(tex, vUv + dir * 1.3846153846) + texture2D(tex, vUv - dir * 1.3846153846)) * 0.3162162162;
          c += (texture2D(tex, vUv + dir * 3.2307692308) + texture2D(tex, vUv - dir * 3.2307692308)) * 0.0702702703;
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
    const box = rig.bounds();
    const size = box.getSize(new THREE.Vector3());
    let scale = 1, base = top;
    s.N = 1;
    if (!s.fits) {
      const target = Math.min(tt.max_ship_length * 0.42, 14);
      s.N = SCALES.find((n) => s.len / n <= target) || Math.ceil(s.len / target);
      scale = 1 / s.N;
      // dealer pedestal: satin plinth + slim stand, accent hairline on the top edge
      const mh = size.y * scale, ml = s.len * scale;
      const R = THREE.MathUtils.clamp(ml * 0.2, 0.9, 3.2), P = 0.9;
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
    if (!keepCamera) this.stage.rotation.y = THREE.MathUtils.degToRad(info.ship?.yaw_deg ?? 160);
    this.stage.add(holder);
    this.frameShip(keepCamera);
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
    const dir = v3(cam.position).sub(v3(cam.target)).normalize();
    const target = sphere.center.clone();
    const far = this.ship.fits ? Math.min(authored * 1.05, cam.orbit_max_distance) : cam.orbit_max_distance;
    const dist = THREE.MathUtils.clamp(fit, Math.min(sphere.radius * 1.3, far), far);
    const pos = target.clone().addScaledVector(dir, dist);
    pos.y = THREE.MathUtils.clamp(pos.y, tt.top + (cam.min_height ?? 1), cam.max_height ?? 50);
    const c = this.controls;
    c.minDistance = Math.max(sphere.radius * 0.75, this.ship.fits ? cam.orbit_min_distance * 0.5 : 1.2);
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
    if (this.tween) {
      const k = ease(Math.min(1, (performance.now() - this.tween.start) / this.tween.dur));
      this.camera.position.lerpVectors(this.tween.p0, this.tween.p1, k);
      c.target.lerpVectors(this.tween.t0, this.tween.t1, k);
      if (k >= 1) this.tween = null;
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
