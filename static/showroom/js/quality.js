// Quality tiers. High is the reference look; Medium and Low trade the most expensive effects for frame rate on
// weaker GPUs. The layout, features and controls are identical on every tier.
export const TIERS = {
  high:   { name: 'High',   dpr: 2,   msaa: 4, fxaa: false, refl: 'full', reflScale: 0.5,  bloom: 1,   shadow: 4096, texFocus: 'full', texOther: 'full', giants: 'auto', bays: 'all' },
  medium: { name: 'Medium', dpr: 1.5, msaa: 4, fxaa: false, refl: 'move', reflScale: 0.25, bloom: 0.5, shadow: 2048, texFocus: 2048,   texOther: 1024, giants: 'far',  bays: 'all' },
  low:    { name: 'Low',    dpr: 1,   msaa: 0, fxaa: true,  refl: 'off',  reflScale: 0.25, bloom: 0,   shadow: 0,    texFocus: 1024,   texOther: 1024, giants: 'focus', bays: 'near' },
};
export const ORDER = ['low', 'medium', 'high'];
export const KEY = 'aurelia.quality';

/** the visitor's choice: ?quality= (tests), then the saved one; 'auto' by default */
export function preference() {
  const q = new URLSearchParams(location.search).get('quality');
  if (q && (q === 'auto' || TIERS[q])) return q;
  try { const v = localStorage.getItem(KEY); if (v === 'auto' || TIERS[v]) return v; } catch { /* storage blocked */ }
  return 'auto';
}
export function savePreference(v) { try { localStorage.setItem(KEY, v); } catch { /* storage blocked */ } }

/** A first guess from what the device says about itself; the live frame-time monitor corrects it either way. */
export function detectTier(renderer) {
  const gl = renderer.getContext();
  let gpu = '';
  try { const x = gl.getExtension('WEBGL_debug_renderer_info'); gpu = String(x ? gl.getParameter(x.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)); } catch { /* hidden */ }
  const mem = navigator.deviceMemory || 8, cores = navigator.hardwareConcurrency || 8;
  const mobile = /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent) || (matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) < 820);
  const saveData = navigator.connection?.saveData || matchMedia('(prefers-reduced-data: reduce)').matches;
  const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE) || 4096;
  const weakGpu = /Mali|Adreno|PowerVR|Apple GPU|SwiftShader|llvmpipe|Software/i.test(gpu);
  const iGpu = /Intel|UHD|Iris|Radeon\(TM\) Graphics|Vega \d+ Graphics/i.test(gpu);
  const pixels = screen.width * screen.height * (devicePixelRatio || 1) ** 2;
  if (saveData || weakGpu || mem <= 2 || maxTex < 4096 || (mobile && (mem <= 4 || cores <= 4))) return 'low';
  if (mobile || iGpu || mem <= 4 || cores <= 4 || pixels > 12e6) return 'medium';
  return 'high';
}
