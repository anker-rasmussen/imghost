// Router + page transitions for the fleet showroom.
// Routes (hash, so the static server and the edge cache never see them):
//   #/                 fleet landing
//   #/<maker>          maker page            e.g. #/helios
//   #/<maker>/<ship>   showroom viewer       e.g. #/helios/zenith
import { $, h, makers, maker, ship, applyTheme, reduceMotion, wait, frame, logo, FLEET_THEME } from './util.js?v=55cda4b6c9a221bb';
import { landing, makerPage } from './pages.js?v=82c7cc3ae3bc3550';
import { Showroom } from './showroom.js?v=0c7815b163fdfbc8';

const main = $('#main');
const curtain = $('.curtain');
const masthead = $('.masthead');
const showroom = new Showroom($('#viewer'));
let current = null;          // { key, page }
let navToken = 0;
const scrollMemory = new Map();

function parse() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map((p) => decodeURIComponent(p).toLowerCase());
  const m = parts[0] && maker(parts[0]);
  if (!m) return { kind: 'fleet', key: 'fleet' };
  const s = parts[1] && ship(m.id, parts[1]);
  if (s) return { kind: 'ship', key: `${m.id}/${s.id}`, maker: m, ship: s };
  return { kind: 'maker', key: m.id, maker: m };
}

// ------------------------------------------------------------------ masthead
const nav = $('.mastnav');
nav.append(...makers.map((m) => h('a', { href: `#/${m.id}`, 'data-id': m.id }, m.name)));
function markNav(route) {
  for (const a of nav.querySelectorAll('a')) {
    const on = route.maker?.id === a.dataset.id;
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
}
let lastY = 0;
addEventListener('scroll', () => {
  const y = scrollY;
  masthead.classList.toggle('scrolled', y > 40);
  masthead.classList.toggle('hide', y > 400 && y > lastY + 4);
  if (y < lastY - 4 || y < 400) masthead.classList.remove('hide');
  lastY = y;
}, { passive: true });

// ------------------------------------------------------------------ transitions
async function curtainIn(theme, m) {
  curtain.style.setProperty('--c-bg', theme.bg);
  curtain.style.setProperty('--c-ink', theme.ink);
  curtain.replaceChildren(m ? logo(m) : h('span.brandmark', { style: { 'font-size': '14px' } }, 'Aurelia', h('i', 'fleet')));
  curtain.classList.remove('out');
  await frame();
  curtain.classList.add('in');
  await wait(540);
}
async function curtainOut() {
  curtain.classList.add('out');
  await wait(640);
  curtain.classList.remove('in', 'out');
}

async function route() {
  const r = parse();
  const token = ++navToken;
  const prev = current;
  if (prev?.key === r.key) return;
  if (prev) scrollMemory.set(prev.key, scrollY);

  // ship -> ship inside the same maker: the viewer swaps models itself, no curtain
  if (r.kind === 'ship' && prev?.kind === 'ship' && prev.maker === r.maker.id) {
    current = { key: r.key, kind: 'ship', maker: r.maker.id };
    document.title = `${r.ship.name} · ${r.maker.full} — Showroom`;
    showroom.open(r.maker, r.ship);
    return;
  }

  const animate = !!prev && !reduceMotion();
  const theme = r.maker ? r.maker.theme : FLEET_THEME;
  if (animate) await curtainIn(r.kind === 'ship' ? { bg: '#050506', ink: '#f1efe9' } : theme, r.maker);
  if (token !== navToken) return;

  markNav(r);
  if (r.kind === 'ship') {
    applyTheme(r.maker.theme);
    document.body.classList.add('in-viewer');
    current?.page?.unmount?.();
    current = { key: r.key, kind: 'ship', maker: r.maker.id, page: null };
    document.title = `${r.ship.name} · ${r.maker.full} — Showroom`;
    showroom.open(r.maker, r.ship);
  } else {
    if (prev?.kind === 'ship') showroom.close();
    document.body.classList.remove('in-viewer');
    const page = r.kind === 'maker' ? makerPage(r.maker.id) : landing();
    prev?.page?.unmount?.();
    applyTheme(page.theme);
    document.title = page.title;
    main.replaceChildren(...page.nodes);
    current = { key: r.key, kind: r.kind, page };
    page.mount(main);
    const y = scrollMemory.get(r.key) ?? 0;
    scrollTo(0, y);
    if (!animate && prev) { main.classList.remove('enter'); void main.offsetWidth; }
    if (!reduceMotion()) { main.classList.add('enter'); setTimeout(() => main.classList.remove('enter'), 1400); }
    if (prev) $('#title', main)?.focus({ preventScroll: true });
  }
  if (animate) await curtainOut();
}

addEventListener('hashchange', route);
showroom.onExit = (m) => { location.hash = `#/${m.id}`; };
if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
route();
document.documentElement.classList.add('ready');
