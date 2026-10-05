// Small DOM + data helpers shared by every page module (no framework).
import data from './data.js?v=b70480ee10db3adf';

export const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const wait = (ms) => new Promise((r) => setTimeout(r, ms));
export const frame = () => new Promise((r) => requestAnimationFrame(() => r()));

/** h('a.btn', {href}, 'text', child) — tiny hyperscript. Attributes: class/style/dataset/on* handled. */
export function h(tag, attrs, ...kids) {
  const name = tag.match(/^[a-z0-9]*/i)[0];
  const el = document.createElement(name || 'div');
  const cls = [];
  for (const [, sigil, v] of tag.slice(name.length).matchAll(/([.#])([\w-]+)/g)) if (sigil === '#') el.id = v; else cls.push(v);
  if (cls.length) el.className = cls.join(' ');
  if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) { kids.unshift(attrs); attrs = null; }
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'style' && typeof v === 'object') for (const [p, x] of Object.entries(v)) el.style.setProperty(p, x);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = [el.className, v].filter(Boolean).join(' ');
    else if (k === 'html') el.innerHTML = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, kids);
  return el;
}
function append(el, kids) {
  for (const k of kids.flat(Infinity)) {
    if (k == null || k === false) continue;
    el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
}
// absolute: a relative url() inside a custom property would resolve against the stylesheet, not the page
export const cssUrl = (u) => `url("${new URL(u, document.baseURI).href}")`;

// ------------------------------------------------------------------ data access
export const makers = data.makers;
export const ships = data.ships;
export const fleet = data.fleet;
export const maker = (id) => makers.find((m) => m.id === id);
export const shipsOf = (id) => ships.filter((s) => s.maker === id).sort((a, b) => a.length - b.length);
export const ship = (makerId, id) => ships.find((s) => s.maker === makerId && s.id === id);

export const fmtLen = (m) => (m >= 1000 ? `${(m / 1000).toFixed(m % 1000 ? 1 : 0)} km` : `${Math.round(m)} m`);
export const fmtMB = (b) => `${(b / 1e6).toFixed(1)} MB`;
export const fmtK = (n) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
export const pad2 = (n) => String(n).padStart(2, '0');

// ------------------------------------------------------------------ theming
export const FLEET_THEME = {
  mode: 'dark', bg: '#0b0c0d', bg2: '#141618', ink: '#ecebe6', muted: '#8f928f', accent: '#c9c2b2',
  line: 'rgba(236,235,230,.13)', display: 'Cormorant Garamond', display_weight: '300', body: 'Jost',
  display_case: 'none', display_track: '-0.01em',
};
const FALLBACK = {
  'Cormorant Garamond': 'Georgia, serif', Michroma: '"Eurostile", "Arial Black", sans-serif', Cinzel: '"Trajan Pro", Georgia, serif',
  'Saira Stencil One': 'Impact, sans-serif', 'Barlow Condensed': '"Arial Narrow", sans-serif', 'Playfair Display': 'Georgia, serif',
  Jost: '"Futura", "Avenir Next", "Segoe UI", sans-serif',
};
export const face = (name) => `"${name}", ${FALLBACK[name] || 'sans-serif'}`;

/** CSS custom properties for a theme (used on <html> and inline on brand-coloured blocks). */
export function themeVars(t, prefix = '--') {
  return {
    [`${prefix}bg`]: t.bg, [`${prefix}bg2`]: t.bg2, [`${prefix}ink`]: t.ink, [`${prefix}muted`]: t.muted,
    [`${prefix}accent`]: t.accent, [`${prefix}line`]: t.line,
    [`${prefix}display`]: face(t.display), [`${prefix}body`]: face(t.body),
    [`${prefix}display-weight`]: t.display_weight || '400', [`${prefix}display-case`]: t.display_case || 'none',
    [`${prefix}display-track`]: t.display_track || '0',
  };
}
export function applyTheme(t) {
  const root = document.documentElement;
  for (const [k, v] of Object.entries(themeVars(t))) root.style.setProperty(k, v);
  root.dataset.mode = t.mode;
  const meta = $('meta[name="theme-color"]');
  if (meta) meta.content = t.bg;
}

/** <span class="logo-mask"> tinted with currentColor; aspect from the mask image once it loads. */
export function logo(m, cls = '', which = 'logo') {
  const el = h(`span.logo-mask${cls ? '.' + cls : ''}`, { role: 'img', 'aria-label': m.full, style: { '--logo': cssUrl(m[which]) } });
  aspectOf(m[which]).then((ar) => el.style.setProperty('--ar', ar));
  return el;
}
const aspects = new Map();
export function aspectOf(src) {
  if (!aspects.has(src)) {
    aspects.set(src, new Promise((res) => {
      const i = new Image();
      i.onload = () => res(i.naturalWidth / i.naturalHeight);
      i.onerror = () => res(4);
      i.src = src;
    }));
  }
  return aspects.get(src);
}

/** Responsive still: 640 / full sources, lazy by default. */
export function picture(p, alt, { eager = false, sizes = '100vw', cls = '' } = {}) {
  if (!p) return h('div.noimg');
  const img = h('img', {
    src: p.small, srcset: `${p.small} 640w, ${p.src} ${p.w || 1600}w`, sizes, alt,
    loading: eager ? 'eager' : 'lazy', decoding: 'async', class: cls || null, width: p.w || null, height: p.h || null,
  });
  if (eager) img.fetchPriority = 'high';
  return img;
}

/** Fade-up on first view (no-op with reduced motion). */
let io = null;
export function reveal(root) {
  const els = $$('.reveal', root);
  if (reduceMotion() || !('IntersectionObserver' in window)) { els.forEach((e) => e.classList.add('in')); return; }
  io ??= new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
  }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
  els.forEach((e) => io.observe(e));
}

/** First ship of a maker that has a real-time model (else the first ship). */
export function showroomShip(makerId) {
  const list = shipsOf(makerId);
  return list.find((s) => s.glb && s.length <= (maker(makerId).room?.info?.turntable?.max_ship_length ?? 40)) ||
    list.find((s) => s.glb) || list[0];
}
