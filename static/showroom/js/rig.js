// Ship rig: turns an exported fleet glb into a living ship — materials, L_* light anchors (kind/color/phase extras
// from Blender), aviation-style nav/strobe/beacon timing, engine + retro glow, RCS puffs and the gear animation.
// Ported from the original Atlantia viewer; lights stay small, sparse and dim (fleet canon).
import * as THREE from 'three';

// ------------------------------------------------------------------ shared glare texture (built once)
let glareTex = null;
function starburst() {
  if (glareTex) return glareTex;
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d');
  const r = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  r.addColorStop(0, 'rgba(255,255,255,1)'); r.addColorStop(0.1, 'rgba(255,255,255,.85)');
  r.addColorStop(0.3, 'rgba(255,255,255,.18)'); r.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = r; g.fillRect(0, 0, 128, 128);
  g.globalCompositeOperation = 'lighter';
  for (const [w, a] of [[1.6, 0], [1.6, Math.PI / 2], [0.8, Math.PI / 4], [0.8, -Math.PI / 4]]) {   // diffraction spikes
    g.save(); g.translate(64, 64); g.rotate(a);
    const l = g.createLinearGradient(-64, 0, 64, 0);
    l.addColorStop(0, 'rgba(255,255,255,0)'); l.addColorStop(0.5, 'rgba(255,255,255,.8)'); l.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = l; g.fillRect(-64, -w, 128, 2 * w); g.restore();
  }
  glareTex = new THREE.CanvasTexture(c); glareTex.colorSpace = THREE.SRGBColorSpace;
  return glareTex;
}

const FX = /plume|rcs_glow/;

/** nudge a material's log-depth fragment depth toward the camera (relative ~10x eps of the distance) */
function biasDepth(m, eps) {
  const prev = m.onBeforeCompile;
  m.onBeforeCompile = (sh, r) => {
    prev?.call(m, sh, r);
    sh.fragmentShader = sh.fragmentShader.replace('#include <logdepthbuf_fragment>',
      `#include <logdepthbuf_fragment>\n#if defined( USE_LOGDEPTHBUF )\n  gl_FragDepth = max(0.0, gl_FragDepth - ${eps.toExponential()});\n#endif`);
  };
  const key = m.customProgramCacheKey?.bind(m);
  m.customProgramCacheKey = () => `${key ? key() : ''}|bias${eps}`;
}
const isFx = (m) => FX.test(m.name || '');

/**
 * @param gltf    loaded glTF
 * @param opts    { realLights: bool (false for scale models), length: ship length in metres }
 */
export function rigShip(gltf, { realLights = true, length = 40 } = {}) {
  const root = gltf.scene;
  const mats = new Map();                       // name -> [materials]
  const glares = [];                            // { sprite, kind, phase, base, color }
  const L = { nav: [], strobe: [], beacon: [], landing: [], logo: [], engine: [], retro: [], tail: [] };
  const fxMeshes = [];
  const k = THREE.MathUtils.clamp(length / 43, 0.6, 4);       // glare size grows (gently) with the hull

  // hover affordance: a soft fresnel rim on every solid hull material, driven by one shared uniform (no recompiles)
  const rim = { value: 0 }, rimTarget = { v: 0 };
  const rimColor = { value: new THREE.Color(1, 0.98, 0.94) };
  const addRim = (m) => {
    if (!m.isMeshStandardMaterial || m.userData.rim) return;
    m.userData.rim = true;
    const prev = m.onBeforeCompile;
    m.onBeforeCompile = (sh, r) => {
      prev?.call(m, sh, r);
      sh.uniforms.uRim = rim; sh.uniforms.uRimColor = rimColor;
      sh.fragmentShader = 'uniform float uRim;\nuniform vec3 uRimColor;\n' + sh.fragmentShader.replace('#include <dithering_fragment>',
        '#include <dithering_fragment>\n  gl_FragColor.rgb += uRimColor * uRim * 0.55 * pow(1.0 - clamp(abs(dot(normalize(vViewPosition), normal)), 0.0, 1.0), 3.0);');
    };
    m.customProgramCacheKey = () => 'rim';
  };
  root.traverse((o) => {
    if (!o.isMesh) return;
    const m = o.material;
    if (!isFx(m) && !m.transparent) addRim(m);
    if (!mats.has(m.name)) mats.set(m.name, []);
    if (!mats.get(m.name).includes(m)) {
      mats.get(m.name).push(m);
      if (m.userData.emissive_scale && !m.userData.rigged) m.emissiveIntensity = m.userData.emissive_scale;
      m.userData.rigged = true;
      m.userData.baseEmissive = m.emissiveIntensity ?? 1;
      if (isFx(m)) { m.transparent = true; m.depthWrite = false; m.blending = THREE.AdditiveBlending; m.opacity = 0; }
      // surface layers (decals, window cards) sit on the hull: with a logarithmic depth buffer polygonOffset is
      // ignored (depth is written per fragment), so pull their fragment depth forward a hair instead
      if (m.name === 'decals' || /^c_/.test(m.name)) {
        if (m.name === 'decals') m.depthWrite = false;
        m.polygonOffset = true; m.polygonOffsetFactor = -2;
        biasDepth(m, m.name === 'decals' ? 3e-5 : 1.5e-5);
      }
    }
    if (isFx(m)) { o.castShadow = false; o.renderOrder = 2; fxMeshes.push(o); }
    else { o.castShadow = !m.transparent; o.receiveShadow = true; }
  });

  // light anchors (glTF node extras -> userData)
  const anchors = [];
  root.traverse((o) => { if (o.name && o.name.startsWith('L_')) anchors.push(o); });
  root.updateMatrixWorld(true);
  // anchor positions in the ship's own frame (root is still at identity here): POIs are derived from these
  const anchorsLocal = anchors.map((o) => ({ kind: o.userData?.kind || '', name: o.name, pos: o.getWorldPosition(new THREE.Vector3()) }));
  const glare = (parent, kind, color, phase, base) => {
    const sm = new THREE.SpriteMaterial({ map: starburst(), color, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0 });
    const sp = new THREE.Sprite(sm); sp.scale.setScalar(base * k); sp.renderOrder = 5;
    parent.add(sp); glares.push({ sprite: sp, kind, phase, base, color: sm.color });
    return sp;
  };
  const centroid = (list) => list.reduce((a, o) => a.add(o.getWorldPosition(new THREE.Vector3())), new THREE.Vector3()).divideScalar(list.length);
  const engines = [], retros = [];
  let landingN = 0, logoN = 0;
  root.updateMatrixWorld(true);
  for (const o of anchors) {
    const ex = o.userData || {};
    const kind = ex.kind || (o.name === 'L_tail' ? 'tail' : '');
    const col = ex.color ? new THREE.Color(ex.color[0], ex.color[1], ex.color[2]) : new THREE.Color(1, 1, 1);
    let light = null;
    if (kind === 'nav') {
      glare(o, 'nav', col, 0, 0.9);
      if (realLights) { light = new THREE.PointLight(col, 0, 16, 2); L.nav.push(light); }
    } else if (kind === 'strobe') {
      glare(o, 'strobe', new THREE.Color(1, 1, 1), ex.phase || 0, 1);
      if (realLights && L.strobe.length < 4) { light = new THREE.PointLight(0xffffff, 0, 10, 2); light.userData.phase = ex.phase || 0; L.strobe.push(light); }
    } else if (kind === 'beacon') {
      glare(o, 'beacon', col, 0, 0.8);
      if (realLights && L.beacon.length < 2) { light = new THREE.PointLight(col, 0, 14, 2); L.beacon.push(light); }
    } else if (kind === 'tail') {
      if (realLights) { light = new THREE.PointLight(col, 0, 8, 2); L.tail.push(light); }
    } else if (kind === 'engine') engines.push(o);
    else if (kind === 'retro') retros.push(o);
    else if (kind === 'landing' && realLights && landingN++ < 3) {
      light = new THREE.SpotLight(col, 0, 50, THREE.MathUtils.degToRad((ex.cone_deg || 50) / 2), 0.5, 2);
      light.target.position.set(0, -1, 0.15); L.landing.push(light);
    } else if (kind === 'logo_spill' && realLights && logoN++ < 4) {
      light = new THREE.SpotLight(col, 0, 20, THREE.MathUtils.degToRad((ex.cone_deg || 45) / 2), 0.6, 2);
      const side = Math.sign(o.position.x) || 0;
      light.target.position.set(-side * 0.4, 1, o.name.includes('fin') ? 0.4 : 0.2); L.logo.push(light);
    }
    if (light) { o.add(light); if (light.target) o.add(light.target); }
  }
  // drives: one merged light per group keeps the shader light count sane
  if (realLights && engines.length) {
    const l = new THREE.PointLight(new THREE.Color(0.6, 0.78, 1), 0, 22 * k, 2);
    l.position.copy(root.worldToLocal(centroid(engines))); root.add(l); L.engine.push(l);
  }
  if (realLights && retros.length) {
    const l = new THREE.PointLight(new THREE.Color(1, 0.62, 0.28), 0, 18 * k, 2);
    l.position.copy(root.worldToLocal(centroid(retros))); root.add(l); L.retro.push(l);
  }

  // gear: driven by hand so it reverses from any point (0 = stowed, 1 = deployed)
  const mixer = new THREE.AnimationMixer(root);
  const clip = gltf.animations.find((a) => a.name === 'gear_deploy');
  let gear = null;
  if (clip) {
    const action = mixer.clipAction(clip);
    action.play(); action.paused = true;
    gear = { action, dur: clip.duration };
  }
  const setGear = (t) => { if (gear) { gear.action.time = t * gear.dur * 0.9999; mixer.update(0); } };
  setGear(1);

  const each = (name, fn) => { for (const m of mats.get(name) || []) fn(m); };
  const setE = (name, v) => each(name, (m) => { m.emissiveIntensity = v; });
  const setO = (name, v) => each(name, (m) => { m.opacity = v; });
  const navMats = [...mats.keys()].filter((n) => /nav/i.test(n));
  const hasRetro = mats.has('retro_glow') || mats.has('retro_plume') || retros.length > 0;

  let lastG = -1;
  function update(dt, t, S) {
    rim.value += (rimTarget.v - rim.value) * Math.min(1, dt * 10);
    // gear
    if (gear) {
      S.gearT = THREE.MathUtils.clamp(S.gearT + S.gearDir * dt / gear.dur, 0, 1);
      setGear(S.gearT);
    }
    // engines; mains throttle back while the retros burn
    S.retro += (S.retroTarget - S.retro) * Math.min(1, dt * 6);
    const th = S.thrust * (1 - 0.85 * S.retro);
    // drives: a faint inner glow at idle, growing with the square of thrust; normalised by the hall's exposure
    // (S.expo = 1 / exposure) so no hall blooms them into halos — lights stay tasteful
    const g = S.expo ?? 1;
    setE('engine_glow', (0.025 + th * th * 2.2) * g);
    // baked emissive (windows, running-light cards) is authored for exposure ~1: keep it there in brighter halls
    if (g !== lastG) {
      lastG = g;
      for (const [name, list] of mats) if (!/engine|retro|plume|nav/i.test(name)) for (const m of list) if (m.userData.emissive_scale) m.emissiveIntensity = Math.min(m.userData.baseEmissive, 10) * Math.min(1, g);   // capped: baked nozzle glows must not bloom into halos
    }
    setO('plume', th * 0.35);
    setE('retro_glow', S.retro * S.retro * 2.2 * g);
    setO('retro_plume', S.retro * 0.35);
    for (const l of L.engine) l.intensity = th * th * 40 * k * g;
    for (const l of L.retro) l.intensity = S.retro * 50 * k * g;
    // RCS: short pulses while braking or when hailed
    S.rcs = Math.max(0, S.rcs - dt * 2.5);
    const rcs = (S.retro > 0.2 && Math.sin(t * 23) > 0.6) || S.rcs > 0.5 ? 1 : 0;
    setO('rcs_plume', rcs * 0.35); setO('rcs_glow', rcs * 0.35);
    // nav: 0.5 Hz, 75 % duty with a 0.15 floor (aviation style)
    const navOn = S.nav ? ((t * 0.5) % 1 < 0.75 ? 1 : 0.15) : 0;
    for (const n of navMats) each(n, (m) => { m.emissiveIntensity = m.userData.baseEmissive * (S.nav ? 0.25 + 0.75 * navOn : 0.1); });
    for (const l of L.nav) l.intensity = 5 * navOn;
    for (const l of L.tail) l.intensity = 3 * navOn;
    // anti-collision strobes: double flash (two ~50 ms bursts 0.1 s apart every 1.2 s), instant attack, fast decay
    const flash = (ph) => {
      if (!S.strobe) return 0;
      const p = (((t / 1.2) + ph) % 1) * 1.2;
      const burst = (d) => (p >= d ? Math.exp(-(p - d) / 0.035) : 0);
      return Math.min(1, burst(0) + burst(0.1));
    };
    for (const l of L.strobe) l.intensity = 160 * flash(l.userData.phase);
    // beacons: rotating-style pulse
    const b = Math.pow(0.5 + 0.5 * Math.sin(2 * Math.PI * t / 2), 3);
    for (const l of L.beacon) l.intensity = S.nav ? 8 * b : 0;
    for (const g of glares) {
      let o = 0, s = g.base;
      if (g.kind === 'strobe') { const f = flash(g.phase); o = 0.32 * f; s = g.base * (0.6 + 1.2 * f); }
      else if (g.kind === 'nav') { o = 0.22 * navOn; s = g.base * 0.6; }
      else if (g.kind === 'beacon') { o = S.nav ? 0.3 * b : 0; s = g.base * (0.5 + 0.5 * b); }
      g.sprite.material.opacity = o;
      g.sprite.visible = o > 0.002;
      g.sprite.scale.setScalar(s * k);
    }
    // landing lights come on as the gear locks down; logo spill follows the nav switch
    const land = THREE.MathUtils.smoothstep(S.gearT, 0.85, 1) * (S.nav ? 1 : 0);
    for (const l of L.landing) l.intensity = 900 * land;
    for (const l of L.logo) l.intensity = S.nav ? 90 : 0;
  }

  function dispose() {
    mixer.stopAllAction(); mixer.uncacheRoot(root);
    root.traverse((o) => {
      if (o.isSkinnedMesh) o.skeleton?.dispose();
      o.geometry?.dispose();
      const ms = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
      for (const m of ms) {
        for (const key of Object.keys(m)) { const v = m[key]; if (v && v.isTexture && v !== glareTex) v.dispose(); }
        m.dispose();
      }
      if (o.isLight) o.dispose?.();
    });
  }

  /** world-space bounds of the solid ship (no exhaust, no glare sprites) */
  function bounds() {
    root.updateMatrixWorld(true);
    const box = new THREE.Box3(), b = new THREE.Box3();
    root.traverse((o) => {
      if (!o.isMesh || isFx(o.material)) return;
      // skinned parts (gear) use their rest-pose geometry box: SkinnedMesh.computeBoundingBox() goes through the bones'
      // world matrices, so once the hull sits in its bay that box already carries the bay offset (counted twice below)
      if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
      b.copy(o.geometry.boundingBox);
      box.union(b.applyMatrix4(o.matrixWorld));
    });
    return box;
  }

  return {
    root, update, dispose, bounds, anchorsLocal,
    setHighlight(v) { rimTarget.v = v; },
    pulse() { rim.value = 1.6; },                     // instant 'heard you' flash on hail
    hasGear: !!gear, hasRetro,
    lightCount: Object.values(L).reduce((a, l) => a + l.length, 0),
  };
}
