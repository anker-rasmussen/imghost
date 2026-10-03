import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

const $ = (id) => document.getElementById(id);
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---------------------------------------------------------------- renderer + scene
const canvas = $('gl');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.toneMapping = THREE.AgXToneMapping;          // same view transform family as the film (Blender AgX)
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(32, 1, 0.5, 4000);
camera.position.set(34, 12, 48);                       // 3/4 rear chase, like the film
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.minDistance = 22; controls.maxDistance = 160;
controls.autoRotate = !reduceMotion; controls.autoRotateSpeed = 0.35;
controls.target.set(0, 0, 0);

// Sun: same travel direction as the film (Blender (0.8,0.3,-0.52) -> glTF (x, z, -y))
const sunDir = new THREE.Vector3(0.8, -0.52, -0.3).normalize();
const sun = new THREE.DirectionalLight(0xfff8ec, 4.2);
sun.position.copy(sunDir.clone().multiplyScalar(-120));
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
Object.assign(sun.shadow.camera, { left: -30, right: 30, top: 30, bottom: -30, near: 40, far: 220 });
sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.03;
scene.add(sun, sun.target);

// post: bloom on the light sources only (high threshold), then AgX output
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.5, 0.55, 0.92);
composer.addPass(bloom);
composer.addPass(new OutputPass());

function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false); composer.setSize(w, h);
  camera.aspect = w / h;
  camera.fov = w / h < 0.8 ? 46 : 32;                   // phones: wider lens
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize); resize();

// ---------------------------------------------------------------- environment: the film's Earth plate
const pmrem = new THREE.PMREMGenerator(renderer);
new RGBELoader().load('earth_env.hdr', (env) => {
  env.mapping = THREE.EquirectangularReflectionMapping;
  scene.background = env;
  scene.environment = pmrem.fromEquirectangular(env).texture;
  // Blender's equirect u = atan2(y,-x); three's = atan2(z,x) after the Z-up -> Y-up swap: a half turn apart
  scene.backgroundRotation.set(0, Math.PI, 0);
  scene.environmentRotation.set(0, Math.PI, 0);
  scene.environmentIntensity = 1.0;
});

// ---------------------------------------------------------------- ship
const M = {};               // materials by name
const lights = { nav: [], strobe: [], beacon: [], landing: [], logo: [], engine: [], retro: [] };
let mixer, gearAction, gearDur = 2.5;

const loader = new GLTFLoader();
loader.setMeshoptDecoder(MeshoptDecoder);
function showError(msg) {
  $('loader').classList.remove('done');
  $('loadtxt').innerHTML = '';
  const e = document.createElement('span'); e.className = 'err';
  e.textContent = `The viewer hit an error: ${msg}`; $('loadtxt').append(e);
}
addEventListener('error', (e) => showError(e.message || 'script error'));
addEventListener('unhandledrejection', (e) => showError(String(e.reason?.message || e.reason)));

loader.load('atlantia.glb', onShip, (e) => {
  if (!e.total) return;
  $('loadbar').style.width = `${(100 * e.loaded / e.total).toFixed(0)}%`;
  $('loadtxt').textContent = `Loading ship · ${(e.loaded / 1e6).toFixed(1)} / ${(e.total / 1e6).toFixed(1)} MB`;
}, (err) => showError(String(err?.message || err)));

function onShip(gltf) {
  const ship = gltf.scene;
  scene.add(ship);
  const toC = (c) => new THREE.Color(c[0], c[1], c[2]);
  ship.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = true; o.receiveShadow = true;
      const m = o.material; M[m.name] = m;
      if (['plume', 'retro_plume', 'rcs_glow'].includes(m.name)) {
        m.transparent = true; m.depthWrite = false; m.blending = THREE.AdditiveBlending;
        m.userData.baseOpacity = m.opacity; o.castShadow = false; o.renderOrder = 2;
      }
      if (m.name === 'decals') { m.depthWrite = false; m.polygonOffset = true; m.polygonOffsetFactor = -2; }
      if (m.name === 'canopy_glass') { o.castShadow = false; }
    }
    // light anchors exported from Blender (extras -> userData)
    const ex = o.userData || {};
    if (!o.name || !o.name.startsWith('L_')) return;
    const col = ex.color ? toC(ex.color) : new THREE.Color(1, 1, 1);
    let L = null;
    const kind = ex.kind || (o.name === 'L_tail' ? 'tail' : '');
    if (kind === 'nav') { L = new THREE.PointLight(col, 25, 18, 2); lights.nav.push(L); }
    else if (kind === 'strobe') { L = new THREE.PointLight(col, 0, 26, 2); L.userData.phase = ex.phase || 0; lights.strobe.push(L); }
    else if (kind === 'beacon') { L = new THREE.PointLight(col, 0, 16, 2); lights.beacon.push(L); }
    else if (kind === 'engine') { L = new THREE.PointLight(new THREE.Color(0.6, 0.78, 1), 0, 22, 2); lights.engine.push(L); }
    else if (kind === 'retro') { L = new THREE.PointLight(new THREE.Color(1, 0.62, 0.28), 0, 18, 2); lights.retro.push(L); }
    else if (kind === 'landing' || kind === 'docking') {
      L = new THREE.SpotLight(col, 0, 60, THREE.MathUtils.degToRad((ex.cone_deg || 50) / 2), 0.5, 2);
      L.target.position.set(0, -1, kind === 'docking' ? -0.6 : 0.15); lights.landing.push(L);
    } else if (kind === 'logo_spill') {
      L = new THREE.SpotLight(col, 160, 24, THREE.MathUtils.degToRad((ex.cone_deg || 45) / 2), 0.6, 2);
      const side = Math.sign(o.position.x) || 0;
      L.target.position.set(-side * 0.4, 1, o.name.includes('fin') ? 0.4 : 0.2); lights.logo.push(L);
    } else if (kind === 'tail') { L = new THREE.PointLight(col, 6, 10, 2); lights.nav.push(L); }
    if (L) { o.add(L); if (L.target) o.add(L.target); }
  });

  // gear: driven manually so it can reverse from any point (0 = stowed, 1 = deployed)
  mixer = new THREE.AnimationMixer(ship);
  const clip = gltf.animations.find((a) => a.name === 'gear_deploy');
  if (clip) {
    gearDur = clip.duration;
    gearAction = mixer.clipAction(clip);
    gearAction.play(); gearAction.paused = true; gearAction.time = 0;
    mixer.update(0);
  }
  $('loader').classList.add('done');
}

// ---------------------------------------------------------------- controls & state
const S = { gearT: 0, gearDir: -1, nav: true, strobe: true, retro: 0, retroTarget: 0, thrust: 0.35, rcs: 0 };
const press = (btn, on) => btn.setAttribute('aria-pressed', on ? 'true' : 'false');

$('gear').addEventListener('click', () => { S.gearDir = S.gearDir > 0 ? -1 : 1; press($('gear'), S.gearDir > 0); });
$('nav').addEventListener('click', () => { S.nav = !S.nav; press($('nav'), S.nav); });
$('strobe').addEventListener('click', () => { S.strobe = !S.strobe; press($('strobe'), S.strobe); });
$('spin').addEventListener('click', () => { controls.autoRotate = !controls.autoRotate; press($('spin'), controls.autoRotate); });
press($('spin'), controls.autoRotate);
const thr = $('thr');
function thrustLabel(v) { return v === 0 ? 'idle' : v < 25 ? 'low' : v < 50 ? 'cruise' : v < 85 ? 'climb' : 'full burn'; }
thr.addEventListener('input', () => { S.thrust = thr.value / 100; $('throut').textContent = `${thr.value}% ${thrustLabel(+thr.value)}`; });
const retro = $('retro');
const hold = (on) => { S.retroTarget = on ? 1 : 0; retro.classList.toggle('held', on); press(retro, on); };
retro.addEventListener('pointerdown', (e) => { e.preventDefault(); hold(true); });
['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => retro.addEventListener(ev, () => hold(false)));
retro.addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); hold(true); } });
retro.addEventListener('keyup', () => hold(false));

// ---------------------------------------------------------------- hail the pilot (RTS-style)
const LINES = [
  { src: 'hail_L1.mp3', text: 'Aurelia Control. Atlantia Lightweight, Kilo Romeo Tango four four seven one… requesting docking.' },
  { src: 'hail_L4.mp3', text: 'Copy, Aurelia. Dock four one. Good to be home.' },
];
let hailIdx = 0, audio = null, captionTimer = 0;
function hail() {
  const line = LINES[hailIdx++ % LINES.length];
  try { audio?.pause(); audio = new Audio(line.src); audio.play().catch(() => {}); } catch (e) { /* audio optional */ }
  const cap = $('caption');
  cap.innerHTML = '<span class="who">KRT-4471</span>';
  cap.append(document.createTextNode(line.text));
  clearTimeout(captionTimer); captionTimer = setTimeout(() => { cap.textContent = ''; }, 9000);
  S.rcs = 1;                                             // a little RCS twitch as he answers
}
$('hail').addEventListener('click', hail);
const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
let downAt = null;
canvas.addEventListener('pointerdown', (e) => { downAt = [e.clientX, e.clientY]; });
canvas.addEventListener('pointerup', (e) => {
  if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 6) return;
  ndc.set(e.clientX / innerWidth * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  if (ray.intersectObjects(scene.children, true).some((h) => h.object.isMesh)) hail();
});

// ---------------------------------------------------------------- per-frame light & material logic
const clock = new THREE.Clock();
const setE = (name, v) => { const m = M[name]; if (m) m.emissiveIntensity = v; };
const setO = (name, v) => { const m = M[name]; if (m) m.opacity = (m.userData.baseOpacity ?? 1) * v; };
function frame() {
  const dt = Math.min(clock.getDelta(), 0.05), t = clock.elapsedTime;
  // gear
  S.gearT = THREE.MathUtils.clamp(S.gearT + S.gearDir * dt / gearDur, 0, 1);
  if (gearAction) { gearAction.time = S.gearT * gearDur; mixer.update(0); }
  $('s-gear').textContent = S.gearT <= 0 ? 'STOWED' : S.gearT >= 1 ? 'DOWN · LOCKED' : S.gearDir > 0 ? 'DEPLOYING' : 'RETRACTING';
  // retro burn smoothing; main engines throttle back while braking
  S.retro += (S.retroTarget - S.retro) * Math.min(1, dt * 6);
  $('s-retro').textContent = S.retro > 0.05 ? 'BURNING' : 'SAFE';
  const th = S.thrust * (1 - 0.85 * S.retro);
  setE('engine_glow', 0.25 + th * 6.0);
  setE('nozzle_liner', 0.05 + th * th * 4.0);
  setO('plume', th);
  setE('retro_glow', S.retro * 6.0);
  setO('retro_plume', S.retro);
  lights.engine.forEach((L) => (L.intensity = th * 60));
  lights.retro.forEach((L) => (L.intensity = S.retro * 80));
  // RCS: short pulses while braking or when hailed
  S.rcs = Math.max(0, S.rcs - dt * 2.5);
  const rcsPulse = (S.retro > 0.2 && Math.sin(t * 23) > 0.6) || S.rcs > 0.5 ? 1 : 0;
  setO('rcs_glow', rcsPulse);
  // nav lights: 0.5 Hz, 75% duty with a 0.15 floor (aviation-style)
  const navOn = S.nav ? ((t * 0.5) % 1 < 0.75 ? 1 : 0.15) : 0;
  setE('nav_red', 3 * navOn); setE('nav_green', 3 * navOn); setE('formation_strip', S.nav ? 2 : 0);
  lights.nav.forEach((L) => (L.visible = navOn > 0));
  lights.nav.forEach((L) => (L.intensity = (L.color.r > 0.9 && L.color.g > 0.9 ? 6 : 25) * navOn));
  // strobes: 0.75 Hz, 5% duty, belly half a period out of phase
  const strobeAt = (ph) => (S.strobe && ((t * 0.75 + ph) % 1) < 0.05 ? 1 : 0);
  setE('strobe', 20 * Math.max(strobeAt(0), strobeAt(0.5)));
  lights.strobe.forEach((L) => (L.intensity = 900 * strobeAt(L.userData.phase)));
  // beacons: rotating-style pulse
  const b = Math.pow(0.5 + 0.5 * Math.sin(2 * Math.PI * t / 2), 3);
  setE('beacon', S.nav ? 6 * (b + 0.05) : 0);
  lights.beacon.forEach((L) => (L.intensity = S.nav ? 40 * b : 0));
  // landing lights come on as the gear locks down
  const land = THREE.MathUtils.smoothstep(S.gearT, 0.85, 1);
  setE('landing_light', 8 * land);
  lights.landing.forEach((L) => (L.intensity = 1600 * land));
  lights.logo.forEach((L) => (L.visible = S.nav));

  controls.update();
  composer.render();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
