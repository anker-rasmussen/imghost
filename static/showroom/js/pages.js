// Landing (fleet) and maker pages. Each page is { title, theme, nodes, mount(), unmount() }.
import {
  h, fleet, makers, ships, shipsOf, maker, logo, picture, themeVars, fmtLen, pad2, cssUrl, reveal, reduceMotion,
  showroomShip, FLEET_THEME,
} from './util.js?v=bd3c649e66744f91';

const range = (list) => `${fmtLen(list[0].length)} – ${fmtLen(list[list.length - 1].length)}`;
const words = ['Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight'];

// ================================================================== landing
export function landing() {
  const all = [...ships].sort((a, b) => a.length - b.length);
  const reduce = reduceMotion();

  const orbit = h('div.orbit', { 'aria-hidden': 'true', html: `
    <svg viewBox="0 0 1500 760" preserveAspectRatio="xMidYMid meet">
      <ellipse cx="750" cy="370" rx="690" ry="250"/>
      <ellipse cx="750" cy="370" rx="520" ry="160"/>
      <ellipse cx="750" cy="370" rx="300" ry="84"/>
      <circle class="sat" r="3">${reduce ? '' : '<animateMotion dur="90s" repeatCount="indefinite" path="M 60 370 A 690 250 0 1 1 1440 370 A 690 250 0 1 1 60 370"/>'}</circle>
      <circle class="sat" r="2" cx="${reduce ? 1270 : 0}" cy="${reduce ? 370 : 0}">${reduce ? '' : '<animateMotion dur="140s" repeatCount="indefinite" path="M 1270 370 A 520 160 0 1 0 230 370 A 520 160 0 1 0 1270 370"/>'}</circle>
    </svg>` });

  const hero = h('section.hero', { 'aria-labelledby': 'title' },
    orbit,
    h('div.wrap',
      h('p.micro.eyebrow', 'Fleet register · Sol · late twenty-second century'),
      h('h1.display#title', { tabindex: '-1' }, 'The Aurelia', h('br'), h('em', 'Fleet')),
      h('div.hero-grid',
        h('p.lede', fleet.lede),
        h('dl.hero-figures',
          h('div', h('dt.micro', 'Shipyards'), h('dd', pad2(makers.length))),
          h('div', h('dt.micro', 'Hulls'), h('dd', pad2(ships.length))),
          h('div', h('dt.micro', 'Smallest → largest'), h('dd', range(all))))),
      h('div.hero-marks',
        makers.map((m) => h('a', { href: `#/${m.id}`, title: m.full }, logo(m, '', 'mark'))),
        h('a.micro.scroll-cue', { href: '#makers', style: { width: 'auto', 'margin-left': 'auto' }, onclick: (e) => {
          e.preventDefault(); document.getElementById('makers').scrollIntoView({ behavior: reduce ? 'auto' : 'smooth' });
        } }, 'Five yards below'))));

  const studios = h('section.sec#makers', { 'aria-labelledby': 'makers-h' },
    h('div.wrap',
      h('div.sec-head.reveal',
        h('div', h('p.micro.eyebrow', 'The yards'), h('h2.display#makers-h', 'Five studios, five ideas of a spaceship')),
        h('p', 'Each maker has its own silhouette rules, palette and home yard. You should be able to tell who built a ship from its shadow alone.'))),
    h('div.studios', makers.map((m, i) => {
      const list = shipsOf(m.id);
      return h('article.studio.reveal', { style: themeVars(m.theme, '--sb-') },
        h('a', { href: `#/${m.id}`, 'aria-label': `${m.full}: ${m.tagline}` },
          h('div.studio-media', picture(m.hero, `${m.full} showroom`, { sizes: '(max-width: 860px) 100vw, 60vw' })),
          h('div.studio-body',
            h('div.studio-index', h('span', `${pad2(i + 1)} / ${pad2(makers.length)}`), h('span', m.yard.where)),
            h('div', logo(m, 'studio-logo'), h('p.studio-tag', { style: { 'margin-top': '28px' } }, m.tagline), h('p.studio-arch', m.archetype)),
            h('div', { style: { display: 'grid', gap: '28px' } },
              h('dl.studio-facts',
                h('div', h('dt', 'Home yard'), h('dd', m.yard.name)),
                h('div', h('dt', 'Line-up'), h('dd', `${words[list.length] || list.length} hulls`)),
                h('div', h('dt', 'Span'), h('dd', range(list)))),
              h('span.link-arrow', `Enter ${m.name}`)))));
    })));

  const rules = h('section.sec', { 'aria-labelledby': 'rules-h' },
    h('div.wrap',
      h('div.sec-head.reveal',
        h('div', h('p.micro.eyebrow', 'Design canon'), h('h2.display#rules-h', fleet.rules_title)),
        h('p', 'Shared by every yard and checked against every hull: a ship must read as a spacecraft at thumbnail size before it is allowed to read as a brand.')),
      h('ol.rules.reveal', fleet.rules.map(([t, p], i) => h('li', h('span.micro', pad2(i + 1)), h('h3', t), h('p', p))))));

  const strip = scaleStrip(all);

  const colophon = h('section.sec', { 'aria-labelledby': 'how-h' },
    h('div.wrap.colophon.reveal',
      h('div', h('p.micro.eyebrow', 'Colophon'), h('h2.display#how-h', { style: { 'font-size': 'var(--fs-h2)' } }, 'Generated, baked, lit in real time')),
      h('div', { style: { display: 'grid', gap: '22px', 'align-content': 'end' } },
        h('p', fleet.colophon), h('p.micro', fleet.registry))));

  const foot = h('footer.foot', h('div.wrap',
    h('span.micro', 'The Aurelia Fleet · a real-time portfolio piece'),
    h('a.micro', { href: '/' }, '← aigf.dev')));

  return {
    title: 'The Aurelia Fleet — Showroom', theme: FLEET_THEME,
    nodes: [hero, studios, rules, strip.el, colophon, foot],
    mount(root) { reveal(root); strip.mount(); },
    unmount() { strip.unmount(); },
  };
}

// ------------------------------------------------------------------ the scale strip: 1 px = 1 m, scroll-linked
function scaleStrip(all) {
  const GAP = 64;
  let x = 0, maxH = 0;
  const items = all.map((s) => {
    const w = s.length;
    const hh = s.silhouette ? Math.max(2, w * s.silhouette.aspect) : Math.max(2, w * 0.1);
    const it = { s, x, w, hh };
    x += w + GAP; maxH = Math.max(maxH, hh);
    return it;
  });
  const railW = x - GAP;
  const axis = Math.round(maxH / 2 + 8);
  const railH = axis + Math.round(maxH / 2) + 190;

  const rail = h('div.scale-rail', { style: { width: `${railW}px`, '--rail-h': `${railH}px`, '--axis': `${axis}px` } },
    h('div.scale-axis'),
    items.map(({ s, x: left, w, hh }) => {
      const m = maker(s.maker);
      const vertical = w < 150;
      return h('a.scale-ship', {
        href: `#/${s.maker}/${s.id}`, style: { left: `${left}px`, width: `${w}px`, '--hl': m.theme.accent,
          '--lbl-top': `${Math.round(hh / 2 + 26)}px`, '--tick-top': `${Math.round(hh / 2 + 6)}px` },
        'aria-label': `${s.name}, ${m.name}, ${fmtLen(s.length)}`,
      },
      h('span.sil', { class: s.silhouette ? null : 'ghost', style: { width: `${w}px`, height: `${Math.round(hh)}px`, ...(s.silhouette ? { '--sil': cssUrl(s.silhouette.src) } : {}) } }),
      h('span.lbl', { class: vertical ? 'v' : null, 'aria-hidden': 'true' },
        h('b', s.name), h('span', h('i', m.name), ` · ${fmtLen(s.length)}`)));
    }));

  const now = h('span.micro.scale-now', '');
  const prog = h('div.scale-progress', h('i'));
  const viewport = h('div.scale-viewport', rail);
  const el = h('section.scale', { 'aria-labelledby': 'scale-h' },
    h('div.scale-pin',
      h('div.wrap.scale-head',
        h('div', h('p.micro.eyebrow', `All ${ships.length} hulls`), h('h2.display#scale-h', fleet.scale_title)),
        h('div.scale-legend', h('span.bar'), h('span.micro', '100 m'), h('p.micro', { style: { margin: 0, 'max-width': '26em' } }, fleet.scale_note))),
      viewport,
      h('div.wrap.scale-foot', prog, now)));

  let raf = 0, pad = 0, travel = 0;
  const layout = () => {
    pad = parseFloat(getComputedStyle(el.querySelector('.wrap')).paddingLeft) || 16;
    travel = Math.max(0, railW + 2 * pad - viewport.clientWidth);
    el.style.height = `calc(100vh + ${travel}px)`;
    update();
  };
  const update = () => {
    raf = 0;
    const r = el.getBoundingClientRect();
    const total = el.offsetHeight - innerHeight;
    const p = total > 0 ? Math.min(1, Math.max(0, -r.top / total)) : 0;
    rail.style.transform = `translate3d(${(pad - p * travel).toFixed(1)}px,0,0)`;
    prog.style.setProperty('--p', p.toFixed(4));
    const cx = p * travel + viewport.clientWidth / 2 - pad;
    let cur = items[0];
    for (const it of items) if (it.x <= cx) cur = it;
    const label = `${cur.s.name} · ${fmtLen(cur.s.length)}`;
    if (now.textContent !== label) now.textContent = label;
  };
  const onScroll = () => { if (!raf) raf = requestAnimationFrame(update); };
  // keyboard: bring a focused ship into the pinned viewport by scrolling the page to it
  const onFocus = (e) => {
    const a = e.target.closest('.scale-ship');
    if (!a) return;
    const it = items[[...rail.querySelectorAll('.scale-ship')].indexOf(a)];
    const total = el.offsetHeight - innerHeight;
    const p = travel ? Math.min(1, Math.max(0, (it.x + it.w / 2 + pad - viewport.clientWidth / 2) / travel)) : 0;
    scrollTo({ top: el.offsetTop + p * total, behavior: 'auto' });
  };
  return {
    el,
    mount() {
      layout();
      addEventListener('scroll', onScroll, { passive: true });
      addEventListener('resize', layout);
      el.addEventListener('focusin', onFocus);
    },
    unmount() {
      removeEventListener('scroll', onScroll);
      removeEventListener('resize', layout);
      cancelAnimationFrame(raf);
    },
  };
}

// ================================================================== maker page
export function makerPage(id) {
  const m = maker(id);
  const list = shipsOf(id);
  const max = list[list.length - 1].length;
  const enter = showroomShip(id);
  const idx = makers.indexOf(m);
  const next = makers[(idx + 1) % makers.length];

  const hero = h('section.m-hero', { 'aria-labelledby': 'title' },
    picture(m.hero, '', { eager: true }),
    h('div.wrap',
      h('p.micro', { style: { color: 'rgba(255,255,255,.72)' } }, `${pad2(idx + 1)} / ${pad2(makers.length)} · ${m.since} · Registry ${m.registry}`),
      h('h1.sr#title', { tabindex: '-1' }, m.full),
      logo(m),
      h('div.m-hero-row',
        h('p.m-tagline', m.tagline),
        h('a.btn', { href: `#/${id}/${enter.id}` }, 'Enter the showroom', h('span.arr', '→')))));

  const intro = h('section.sec', { 'aria-label': 'Philosophy' }, h('div.wrap.m-intro.reveal',
    h('div', h('p.micro.eyebrow', 'Philosophy'), h('p.big', m.philosophy)),
    h('dl.facts',
      h('div', h('dt', 'Archetype'), h('dd', m.archetype)),
      h('div', h('dt', 'Home yard'), h('dd', m.yard.name, h('br'), h('span', { style: { color: 'var(--muted)' } }, m.yard.where))),
      h('div', h('dt', 'Registry'), h('dd', m.registry)),
      h('div', h('dt', 'Materials'), h('dd', m.materials)),
      h('div', h('dt', 'Line-up'), h('dd', `${list.length} hulls · ${range(list)}`)))));

  const palette = h('section.sec', { 'aria-labelledby': 'pal-h', style: { 'padding-top': 0 } }, h('div.wrap',
    h('div.sec-head.reveal', h('div', h('p.micro.eyebrow', 'Livery'), h('h2.display#pal-h', 'Palette')),
      h('p', 'Every hull is painted from these and nothing else. Decals are white on alpha, tinted per role in the shader.')),
    h('div.palette.reveal', m.palette.map((c) => h('div.swatch', { style: { '--c': c.hex } },
      h('div.chip'), h('div.meta', h('b', c.name), h('span.micro', `${c.hex} · ${c.role}`)))))));

  const ladder = h('section.sec', { 'aria-labelledby': 'lad-h', style: { 'padding-top': 0 } }, h('div.wrap',
    h('div.sec-head.reveal', h('div', h('p.micro.eyebrow', 'The line-up'), h('h2.display.m-display#lad-h', 'To scale')),
      h('p', `One scale for the whole line: the ${list[list.length - 1].name} sets the width, and everything else is drawn against it.`)),
    h('div.ladder.reveal', list.map((s, i) => h('a.rung', { href: `#/${id}/${s.id}`, 'aria-label': `${s.name}, ${s.role}, ${fmtLen(s.length)}` },
      h('span.micro', pad2(i + 1)),
      h('span.rung-name', h('b', s.name), h('span.micro', s.role)),
      h('span.rung-track', h('span.sil', {
        class: s.silhouette ? null : 'ghost',
        style: s.silhouette
          ? { width: `${(100 * s.length / max).toFixed(3)}%`, 'aspect-ratio': `${(1 / s.silhouette.aspect).toFixed(3)}`, '--sil': cssUrl(s.silhouette.src), 'min-width': '2px', 'min-height': '2px' }
          : { width: `${(100 * s.length / max).toFixed(3)}%`, height: '8px', 'min-width': '4px' },
      })),
      h('span.rung-len', fmtLen(s.length)))))));

  const cards = h('section.sec', { 'aria-labelledby': 'spec-h', style: { 'padding-top': 0 } }, h('div.wrap',
    h('div.sec-head.reveal', h('div', h('p.micro.eyebrow', 'Specifications'), h('h2.display#spec-h', 'Choose a hull')),
      h('p', 'Hulls marked real-time open in the showroom as live 3D models. The rest show their studio stills while their exports finish.')),
    h('div.cards', list.map((s) => h('a.card.reveal', { href: `#/${id}/${s.id}` },
      h('div.card-media', picture(s.poster, `${m.name} ${s.name}`, { sizes: '(max-width: 700px) 100vw, 33vw' }),
        h('span.card-badge', { class: s.glb ? 'live' : null }, s.glb ? `Real-time · ${Math.round(s.glb.tris / 1000)}k tris` : 'Studio still')),
      h('div.card-body',
        h('div', h('span.micro', s.role), h('h3', { style: { 'margin-top': '8px' } }, s.name)),
        h('p', s.copy),
        h('dl', h('div', h('dt', 'Length'), h('dd', fmtLen(s.length))), h('div', h('dt', 'Class'), h('dd', s.class.split(' /')[0])),
          h('div', h('dt', 'Crew'), h('dd', s.crew)))))))));

  const wide = m.wide ? h('section.m-wide', { 'aria-hidden': 'true' }, picture(m.wide, '', { sizes: '100vw' })) : null;

  const yard = h('section.sec', { 'aria-labelledby': 'yard-h' }, h('div.wrap.yard.reveal',
    h('div', h('p.micro.eyebrow', 'Home yard'), h('h2.display#yard-h', m.yard.name)),
    h('div', { style: { display: 'grid', gap: '16px' } }, h('p.micro', m.yard.where), h('p', m.yard.copy))));

  const nextLink = h('a.next-maker', { href: `#/${next.id}`, style: themeVars(next.theme), 'aria-label': `Next yard: ${next.full}` },
    h('div.wrap', { style: { color: next.theme.ink } },
      h('div', { style: { display: 'grid', gap: '18px' } }, h('span.micro', { style: { color: next.theme.muted } }, 'Next yard'), logo(next)),
      h('span.link-arrow', next.tagline)));
  nextLink.style.background = next.theme.bg;

  return {
    title: `${m.full} — The Aurelia Fleet`, theme: m.theme,
    nodes: [hero, intro, palette, ladder, cards, wide, yard, nextLink].filter(Boolean),
    mount(root) { reveal(root); },
    unmount() {},
  };
}
