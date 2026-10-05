// Showroom HUD: title, spec plate, ship switcher, flight console (gear / nav / strobes / thrust / retro / hail),
// loader with the ship's poster, and the poster fallback when there is no real-time model or no WebGL.
// three.js is imported on demand the first time a real-time model is opened.
import { h, shipsOf, logo, cssUrl, fmtLen, fmtMB, fmtK, reduceMotion } from './util.js?v=8d89c49146d332b8';

const webgl2 = (() => {
  try { return !!document.createElement('canvas').getContext('webgl2'); } catch { return false; }
})();

export class Showroom {
  constructor(root) {
    this.root = root;
    this.viewer = null;
    this.maker = null;
    this.ship = null;
    this.token = 0;
    this.audio = null;
    this.hailIdx = 0;
    this.onExit = null;
    this.build();
    this.keys = (e) => this.onKey(e);
    this.keyUp = (e) => { if (e.key === 'r' || e.key === 'R') this.retro(false); };
  }

  // ---------------------------------------------------------------- DOM
  build() {
    const btn = (id, label, key, pressed) => h('button.vbtn', { type: 'button', 'data-k': id, 'aria-pressed': pressed == null ? null : String(pressed) },
      h('span.pip'), label, key ? h('kbd', { 'aria-hidden': 'true' }, key) : null);
    this.canvas = h('canvas', { tabindex: '0', 'aria-label': '' });
    this.still = h('img.still', { alt: '' });
    this.loadImg = h('img', { alt: '' });
    this.loadLogo = h('span');
    this.loadName = h('div.name');
    this.bar = h('div.v-bar', h('i'));
    this.loadTxt = h('div.v-load-txt', { 'aria-live': 'polite' });
    this.loader = h('div.v-loader.done', this.loadImg, h('div.v-load-box', this.loadLogo, this.loadName, this.bar, this.loadTxt));

    this.back = h('a.v-back', { href: '#/' });
    this.title = h('h1#title', { tabindex: '-1' });
    this.sub = h('div.v-sub');
    this.specDl = h('dl');
    this.specCopy = h('p');
    this.spec = h('details.v-spec', h('summary', 'Specification'), this.specDl, this.specCopy);
    if (!matchMedia('(max-width: 760px)').matches) this.spec.open = true;
    this.tag = h('div.v-tag', { hidden: true });
    this.note = h('div.v-note', { hidden: true });
    this.switcher = h('nav.v-switch', { 'aria-label': 'Line-up' });

    this.b = {
      spin: btn('spin', 'Turntable', 'Space', true), gear: btn('gear', 'Gear', 'G', true), nav: btn('nav', 'Nav lights', 'N', true),
      strobe: btn('strobe', 'Strobes', 'S', true), retro: btn('retro', 'Retro burn (hold)', 'R', false), hail: btn('hail', 'Hail pilot', 'H'),
      reset: btn('reset', 'Reset view', '0'),
    };
    this.thr = h('input', { type: 'range', id: 'v-thr', min: '0', max: '100', value: '0', step: '1' });
    this.thrOut = h('output', { for: 'v-thr' }, '0% idle');
    this.sGear = h('b', 'DOWN · LOCKED');
    this.sRetro = h('b', 'SAFE');
    this.caption = h('div.v-caption', { 'aria-live': 'polite' });
    this.console = h('section.v-console', { 'aria-label': 'Flight console' },
      h('div.v-row', Object.values(this.b)),
      h('div.v-row',
        h('div.v-thrust', h('label', { for: 'v-thr' }, 'Thrust'), this.thr, this.thrOut),
        h('div.v-status', h('span', 'GEAR ', this.sGear), h('span', 'RETRO ', this.sRetro))));
    this.ctlToggle = h('button.vbtn.v-ctl-toggle', { type: 'button', 'aria-expanded': 'false', onclick: () => {
      const open = this.console.classList.toggle('collapsed') === false;
      this.ctlToggle.setAttribute('aria-expanded', String(open));
    } }, h('span.pip'), 'Controls');
    if (matchMedia('(max-width: 760px)').matches) this.console.classList.add('collapsed');

    const hud = h('div.v-hud',
      h('header.v-top', h('div.v-title', this.back, this.title, this.sub), this.spec),
      h('div.mid', this.tag, this.note),
      h('footer.v-bottom', this.caption, this.switcher, this.ctlToggle, this.console,
        h('p.v-hint', 'Drag to orbit · right-drag or two fingers to pan · scroll or pinch to zoom · ← → ↑ ↓ orbit · [ ] previous / next hull · Esc back')));
    this.root.append(this.canvas, this.still, hud, this.loader);

    // console wiring
    const B = this.b;
    B.spin.onclick = () => this.set('spin', !this.viewer?.spin);
    B.gear.onclick = () => this.gear();
    B.nav.onclick = () => this.set('nav', !this.S().nav);
    B.strobe.onclick = () => this.set('strobe', !this.S().strobe);
    B.hail.onclick = () => this.hail();
    B.reset.onclick = () => this.viewer?.resetView();
    B.retro.addEventListener('pointerdown', (e) => { e.preventDefault(); this.retro(true); });
    for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) B.retro.addEventListener(ev, () => this.retro(false));
    B.retro.addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); this.retro(true); } });
    B.retro.addEventListener('keyup', () => this.retro(false));
    this.thr.addEventListener('input', () => {
      const v = +this.thr.value;
      this.S().thrust = v / 100;
      this.thrOut.textContent = `${v}% ${v === 0 ? 'idle' : v < 25 ? 'low' : v < 50 ? 'cruise' : v < 85 ? 'climb' : 'full burn'}`;
    });
  }

  S() { return this.viewer?.S || (this._S ??= { nav: true, strobe: true }); }
  press(b, on) { b.setAttribute('aria-pressed', on ? 'true' : 'false'); }
  set(k, on) {
    if (k === 'spin') { if (this.viewer) this.viewer.spin = on; this.press(this.b.spin, on); return; }
    this.S()[k] = on; this.press(this.b[k], on);
  }
  gear() {
    const S = this.S(); if (!this.viewer) return;
    S.gearDir = S.gearDir > 0 ? -1 : 1; this.press(this.b.gear, S.gearDir > 0);
  }
  retro(on) {
    const S = this.S(); S.retroTarget = on ? 1 : 0;
    this.press(this.b.retro, on);
  }
  hail() {
    const lines = this.ship?.hail;
    if (!lines?.length) return;
    const line = lines[this.hailIdx++ % lines.length];
    try { this.audio?.pause(); this.audio = new Audio(line.src); this.audio.play().catch(() => {}); } catch { /* audio is optional */ }
    this.caption.replaceChildren(h('span.who', line.who), line.text);
    clearTimeout(this.capT); this.capT = setTimeout(() => this.caption.replaceChildren(), 9000);
    this.S().rcs = 1;
  }

  // ---------------------------------------------------------------- open / close
  async open(m, s) {
    const token = ++this.token;
    const makerChanged = this.maker?.id !== m.id;
    this.maker = m; this.ship = s;
    this.root.hidden = false;
    this.root.style.setProperty('--v-acc', m.theme.accent);
    addEventListener('keydown', this.keys);
    addEventListener('keyup', this.keyUp);

    // header + spec
    this.back.replaceChildren(h('span', { 'aria-hidden': 'true' }, '←'), logo(m));
    this.back.href = `#/${m.id}`;
    this.back.setAttribute('aria-label', `Back to ${m.full}`);
    this.title.textContent = s.name;
    this.sub.replaceChildren(h('b', s.role), ` · ${s.class} · ${fmtLen(s.length)}`);
    const rows = [['Maker', m.full], ['Length', fmtLen(s.length)], ['Class', s.class], ['Crew', s.crew], ['Role', s.role]];
    if (s.registration) rows.push(['Registration', s.registration]);
    rows.push(['Home yard', m.yard.name]);
    if (s.glb) rows.push(['Real-time mesh', `${fmtK(s.glb.tris)} tris · ${s.glb.draw_calls} calls`], ['Download', fmtMB(s.glb.bytes)]);
    this.specDl.replaceChildren(...rows.flatMap(([k, v]) => [h('dt', k), h('dd', v)]));
    this.specCopy.textContent = s.copy;
    this.canvas.setAttribute('aria-label', `Interactive 3D model of the ${m.name} ${s.name}`);

    // switcher
    if (makerChanged || !this.switcher.childElementCount) {
      this.switcher.replaceChildren(...shipsOf(m.id).map((x) => h('a', { href: `#/${m.id}/${x.id}`, 'data-id': x.id, title: x.glb ? `${x.name} · real-time` : `${x.name} · studio still` },
        x.silhouette ? h('span.sil', { style: { '--sil': cssUrl(x.silhouette.src) }, 'aria-hidden': 'true' }) : null,
        x.name, x.glb ? null : h('span.still-dot', { 'aria-hidden': 'true' }))));
    }
    for (const a of this.switcher.children) a.setAttribute('aria-current', a.dataset.id === s.id ? 'true' : 'false');
    this.switcher.querySelector('[aria-current="true"]')?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'auto' });
    this.caption.replaceChildren();
    this.tag.hidden = true;
    this.note.hidden = true;
    this.title.focus({ preventScroll: true });

    // poster-only path: no model yet, or no WebGL
    if (!s.glb || !webgl2) {
      this.viewer?.idle();
      this.showStill(s, !s.glb
        ? ['Real-time model in production', `The ${s.name} is still being exported from Blender. Showing the studio still.`]
        : ['WebGL unavailable', 'This browser cannot run the real-time viewer, so here is the studio still.']);
      return;
    }

    // real-time path
    this.console.hidden = false;
    this.ctlToggle.hidden = false;
    this.still.classList.remove('on');
    this.canvas.hidden = false;
    this.loading(s, m);
    try {
      if (!this.viewer) {
        const { Viewer } = await import('./viewer.js?v=7fc82e619f2d628e');
        if (token !== this.token) return;
        this.viewer = new Viewer(this.canvas, { onTap: () => this.hail(), onLost: () => this.showStill(this.ship, ['Graphics context lost', 'The GPU dropped the 3D view. Reload to try again.']) });
        this.viewer.spin = !reduceMotion();
      }
      await this.viewer.show(m, s, (p, label) => {
        if (token !== this.token) return;
        this.bar.style.setProperty('--p', p.toFixed(3));
        this.loadTxt.textContent = label;
      });
      if (token !== this.token) return;
      this.ready(s);
    } catch (err) {
      if (token !== this.token) return;
      console.error(err);
      this.viewer?.idle();
      this.showStill(s, ['The viewer hit an error', String(err?.message || err)]);
    }
  }

  loading(s, m) {
    this.loadImg.src = s.poster ? s.poster.src : '';
    this.loadImg.hidden = !s.poster;
    this.loadLogo.replaceChildren(logo(m));
    this.loadName.textContent = s.name;
    this.bar.style.setProperty('--p', '0');
    this.loadTxt.textContent = 'Preparing';
    this.loader.classList.remove('done');
  }

  ready(s) {
    const v = this.viewer, rig = v.ship?.rig;
    this.loader.classList.add('done');
    this.b.gear.hidden = !rig?.hasGear;
    this.b.retro.hidden = !rig?.hasRetro;
    this.b.hail.hidden = !s.hail?.length;
    this.press(this.b.gear, v.S.gearDir > 0);
    this.press(this.b.nav, v.S.nav);
    this.press(this.b.strobe, v.S.strobe);
    this.press(this.b.spin, v.spin);
    this.thr.value = String(Math.round(v.S.thrust * 100));
    this.thr.dispatchEvent(new Event('input'));
    if (v.ship && !v.ship.fits) {
      this.tag.textContent = `1:${v.ship.N} scale model · ${fmtLen(s.length)} in service`;
      this.tag.hidden = false;
    }
    cancelAnimationFrame(this.statusRaf);
    const status = () => {
      if (this.root.hidden || !this.viewer?.ship) return;
      const S = this.viewer.S;
      const g = !this.viewer.ship.rig.hasGear ? 'NONE' : S.gearT <= 0 ? 'STOWED' : S.gearT >= 1 ? 'DOWN · LOCKED' : S.gearDir > 0 ? 'DEPLOYING' : 'RETRACTING';
      if (this.sGear.textContent !== g) this.sGear.textContent = g;
      const r = S.retro > 0.05 ? 'BURNING' : 'SAFE';
      if (this.sRetro.textContent !== r) this.sRetro.textContent = r;
      this.statusRaf = requestAnimationFrame(status);
    };
    status();
  }

  showStill(s, [head, body]) {
    this.loader.classList.add('done');
    this.canvas.hidden = true;
    this.console.hidden = true;
    this.ctlToggle.hidden = true;
    if (s.poster) {
      this.still.src = s.poster.src;
      this.still.alt = `${this.maker.name} ${s.name}, studio render`;
      this.still.classList.add('on');
    }
    this.note.replaceChildren(h('span.micro', head), h('p', body));
    this.note.hidden = false;
  }

  close() {
    ++this.token;
    this.root.hidden = true;
    this.viewer?.stop();
    this.audio?.pause();
    cancelAnimationFrame(this.statusRaf);
    removeEventListener('keydown', this.keys);
    removeEventListener('keyup', this.keyUp);
  }

  // ---------------------------------------------------------------- keyboard
  onKey(e) {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    const tag = e.target?.tagName;
    const inField = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
    const v = this.viewer;
    const live = v && !this.canvas.hidden;
    const step = (dir) => {
      const list = shipsOf(this.maker.id);
      const i = list.findIndex((x) => x.id === this.ship.id);
      const n = list[(i + dir + list.length) % list.length];
      location.hash = `#/${this.maker.id}/${n.id}`;
    };
    switch (e.key) {
      case 'Escape': this.onExit?.(this.maker); break;
      case '[': case 'PageUp': step(-1); break;
      case ']': case 'PageDown': step(1); break;
      case 'ArrowLeft': if (inField || !live) return; v.orbit(-0.12, 0); break;
      case 'ArrowRight': if (inField || !live) return; v.orbit(0.12, 0); break;
      case 'ArrowUp': if (inField || !live) return; v.orbit(0, -0.08); break;
      case 'ArrowDown': if (inField || !live) return; v.orbit(0, 0.08); break;
      case '+': case '=': if (!live) return; v.zoom(0.88); break;
      case '-': case '_': if (!live) return; v.zoom(1.14); break;
      case '0': case 'Home': if (!live) return; v.resetView(); break;
      case ' ': if (inField || !live || tag === 'BUTTON' || tag === 'A') return; this.set('spin', !v.spin); break;
      case 'g': case 'G': if (live && !this.b.gear.hidden) this.gear(); else return; break;
      case 'n': case 'N': if (live) this.set('nav', !v.S.nav); else return; break;
      case 's': case 'S': if (live) this.set('strobe', !v.S.strobe); else return; break;
      case 'r': case 'R': if (live && !this.b.retro.hidden && !e.repeat) this.retro(true); else return; break;
      case 'h': case 'H': this.hail(); break;
      default: return;
    }
    e.preventDefault();
  }
}
