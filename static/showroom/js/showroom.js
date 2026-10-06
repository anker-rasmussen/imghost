// Showroom HUD. One primary thing on screen: the ship (drag to look, click to hail). Around it, quietly:
//   top     breadcrumb (Fleet › Maker › Ship) + mode chip + Specs drawer + "?" keys overlay
//   bottom  subtitles, ship switcher, a dock of four primary actions (Tour, Walk around, Lights, Sound) and a
//           collapsible Systems panel for the engineering toggles (turntable, gear, strobes, retro, thrust, hail, reset)
// Same layout and icons for every maker; brands theme colour and type only. First visit gets three coach marks.
// three.js is imported on demand the first time a real-time model is opened.
import { Voice } from './voice.js?v=cb60e8a719275616';
import { h, shipsOf, logo, cssUrl, fmtLen, fmtMB, fmtK, reduceMotion } from './util.js?v=e9eedb6af1d93c2e';

const webgl2 = (() => {
  try { return !!document.createElement('canvas').getContext('webgl2'); } catch { return false; }
})();
const touch = () => matchMedia('(pointer: coarse)').matches;
const ls = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};
const ss = {
  get(k) { try { return sessionStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { sessionStorage.setItem(k, v); } catch { /* private mode */ } },
};
const WALK_KEYS = { KeyW: 'f', ArrowUp: 'f', KeyS: 'b', ArrowDown: 'b', KeyA: 'l', KeyD: 'r', ArrowLeft: 'tl', ArrowRight: 'tr', ShiftLeft: 'run', ShiftRight: 'run' };

// 24-px line icons (stroke = currentColor)
const P = {
  tour: '<circle cx="6" cy="18" r="2.2"/><circle cx="18" cy="6" r="2.2"/><path d="M8.2 18H14a3.5 3.5 0 0 0 0-7h-4a3.5 3.5 0 0 1 0-7h5.8"/>',
  walk: '<circle cx="13" cy="4.2" r="1.9"/><path d="M12.5 7.5 10 13l3 2.5 1 5.5M10 13l-2.5 7M11.5 8.5l4 3 3-1M11.5 8.5 7 11"/>',
  lights: '<path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.6 10.8c.5.4.6 1 .6 1.6V16h6v-.6c0-.6.2-1.2.6-1.6A6 6 0 0 0 12 3z"/>',
  sound: '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/>',
  mute: '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="m16 9.5 5 5M21 9.5l-5 5"/>',
  systems: '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
  specs: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 8h6M9 12h6M9 16h3.5"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.6 9.3a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1.1.9-1.1 1.6v.6"/><circle cx="12" cy="17" r=".6" fill="currentColor"/>',
  back: '<path d="M15 5 8 12l7 7"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  prev: '<path d="m14.5 6-6 6 6 6"/>',
  next: '<path d="m9.5 6 6 6-6 6"/>',
  spin: '<path d="M20 12a8 8 0 1 1-2.3-5.6"/><path d="M20 4v4h-4"/>',
  gear: '<path d="M12 4v10M8 10l4 4 4-4M6 19h12"/>',
  strobe: '<path d="M13 3 6 13h5l-1 8 7-10h-5z"/>',
  retro: '<path d="m11 6-6 6 6 6M19 6l-6 6 6 6"/>',
  hail: '<path d="M5 5h14v10H10l-4 4v-4H5z"/><path d="M9 9.5h6M9 12h4"/>',
  reset: '<circle cx="12" cy="12" r="7.5"/><circle cx="12" cy="12" r="2"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>',
};
const icon = (n) => h('span.ic', { 'aria-hidden': 'true', html: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${P[n]}</svg>` });
const btn = (name, label, { pressed = null, title = '', cls = '' } = {}) =>
  h(`button.vbtn${cls ? '.' + cls : ''}`, { type: 'button', 'data-k': name, 'aria-pressed': pressed == null ? null : String(pressed), title: title || null }, icon(name), h('span.lbl', label));

const COACH_KEY = 'aurelia.coach.v1';

export class Showroom {
  constructor(root) {
    this.root = root;
    this.viewer = null;
    this.maker = null;
    this.ship = null;
    this.token = 0;
    this.onExit = null;
    this.tourIdx = -1;
    this.build();
    this.keys = (e) => this.onKey(e);
    this.keyUp = (e) => {
      if (e.key === 'r' || e.key === 'R') this.retro(false);
      const k = WALK_KEYS[e.code];
      if (k) this.viewer?.walk?.keys.delete(k);
    };
    this.firstGesture = () => this.soundPrompt();
  }

  // ================================================================ DOM
  build() {
    this.canvas = h('canvas', { tabindex: '0', 'aria-label': '' });
    this.still = h('img.still', { alt: '' });

    // loader: the ship's poster, its name, real byte progress
    this.loadImg = h('img', { alt: '' });
    this.loadLogo = h('span');
    this.loadName = h('div.name');
    this.bar = h('div.v-bar', h('i'));
    this.loadTxt = h('div.v-load-txt', { 'aria-live': 'polite' });
    this.loader = h('div.v-loader.done', this.loadImg, h('div.v-load-box', this.loadLogo, this.loadName, this.bar, this.loadTxt));

    // top: breadcrumb + title / mode chip / Specs + keys
    this.crumbs = h('nav.v-crumbs', { 'aria-label': 'Breadcrumb' });
    this.backBtn = h('a.vbtn.v-backbtn', { href: '#/' }, icon('back'), h('span.lbl', 'Back'));
    this.title = h('h1#title', { tabindex: '-1' });
    this.sub = h('div.v-sub');
    this.chip = h('div.v-chip', { hidden: true, role: 'status' });
    this.specBtn = btn('specs', 'Specs', { pressed: false });
    this.helpBtn = btn('help', 'Keys', { pressed: false, cls: 'quiet' });

    // spec drawer (slide-out)
    this.specDl = h('dl');
    this.specCopy = h('p');
    this.specHead = h('h2');
    this.drawer = h('aside.v-drawer', { 'aria-label': 'Specifications', hidden: true },
      h('div.v-drawer-head', h('div', h('span.micro', 'Specifications'), this.specHead),
        h('button.vbtn.icon-only', { type: 'button', 'aria-label': 'Close specifications', onclick: () => this.specs(false) }, icon('close'))),
      this.specDl, this.specCopy);

    // keys overlay
    const keyRows = [
      ['Drag', 'Look around (orbit)'], ['Scroll / pinch', 'Zoom'], ['Right-drag / two fingers', 'Pan'],
      ['Click the ship', 'Talk to the pilot'], [', and .', 'Previous / next tour stop'], ['W', 'Walk around (W A S D, Shift to hurry)'],
      ['N', 'Lights'], ['M', 'Sound on / off'], ['G', 'Landing gear'], ['S', 'Strobes'], ['R (hold)', 'Retro burn'],
      ['Space', 'Turntable'], ['0', 'Reset view'], ['[ and ]', 'Previous / next hull'], ['Esc', 'Leave the current mode, then go back'],
    ];
    this.help = h('div.v-help', { hidden: true, role: 'dialog', 'aria-label': 'Keyboard and gestures' },
      h('div.v-help-card',
        h('div.v-drawer-head', h('h2', 'Controls'),
          h('button.vbtn.icon-only', { type: 'button', 'aria-label': 'Close', onclick: () => this.showHelp(false) }, icon('close'))),
        h('dl', keyRows.flatMap(([k, v]) => [h('dt', h('kbd', k)), h('dd', v)]))));

    // middle: scale tag, notes, tour card, walk hint
    this.tag = h('div.v-tag', { hidden: true });
    this.note = h('div.v-note', { hidden: true });
    this.tourNum = h('span.micro');
    this.tourTitle = h('h2.v-tour-title');
    this.tourText = h('p');
    this.tourPanel = h('section.v-tour', { hidden: true, 'aria-label': 'Guided tour', 'aria-live': 'polite' },
      h('div.v-tour-head', this.tourNum,
        h('div.v-tour-nav',
          h('button.vbtn.icon-only', { type: 'button', 'aria-label': 'Previous stop', title: 'Previous (,)', onclick: () => this.tourStep(-1) }, icon('prev')),
          h('button.vbtn.icon-only', { type: 'button', 'aria-label': 'Next stop', title: 'Next (.)', onclick: () => this.tourStep(1) }, icon('next')),
          h('button.vbtn.icon-only', { type: 'button', 'aria-label': 'End tour', title: 'End tour (Esc)', onclick: () => this.endTour() }, icon('close')))),
      this.tourTitle, this.tourText);

    // bottom: subtitles, switcher, dock, systems
    this.caption = h('div.v-caption', { 'aria-live': 'polite', role: 'status' });
    this.switcher = h('nav.v-switch', { 'aria-label': 'Line-up' });
    this.b = {
      tour: btn('tour', 'Tour', { pressed: false, title: 'Guided tour (. ,)' }),
      walk: btn('walk', 'Walk around', { pressed: false, title: 'Walk around (W)' }),
      lights: btn('lights', 'Lights', { pressed: true, title: 'Nav lights (N)' }),
      sound: btn('sound', 'Sound', { pressed: true, title: 'Sound (M)' }),
      systems: btn('systems', 'Systems', { pressed: false, cls: 'quiet', title: 'Engineering controls' }),
      spin: btn('spin', 'Turntable', { pressed: true, title: 'Space' }),
      gear: btn('gear', 'Gear', { pressed: true, title: 'G' }),
      strobe: btn('strobe', 'Strobes', { pressed: true, title: 'S' }),
      retro: btn('retro', 'Retro burn', { pressed: false, title: 'Hold R' }),
      hail: btn('hail', 'Hail pilot', { title: 'H, or click the ship' }),
      reset: btn('reset', 'Reset view', { title: '0' }),
    };
    this.b.systems.setAttribute('aria-expanded', 'false');
    this.thr = h('input', { type: 'range', id: 'v-thr', min: '0', max: '100', value: '0', step: '1' });
    this.thrOut = h('output', { for: 'v-thr' }, '0% idle');
    this.sGear = h('b', 'DOWN · LOCKED');
    this.sRetro = h('b', 'SAFE');
    this.systems = h('section.v-systems#v-systems', { hidden: true, 'aria-label': 'Systems' },
      h('div.v-row', this.b.spin, this.b.gear, this.b.strobe, this.b.retro, this.b.hail, this.b.reset),
      h('div.v-row',
        h('div.v-thrust', h('label', { for: 'v-thr' }, 'Thrust'), this.thr, this.thrOut),
        h('div.v-status', h('span', 'GEAR ', this.sGear), h('span', 'RETRO ', this.sRetro))));
    this.b.systems.setAttribute('aria-controls', 'v-systems');
    this.dock = h('div.v-dock', this.b.tour, this.b.walk, this.b.lights, this.b.sound, h('span.v-sep', { 'aria-hidden': 'true' }), this.b.systems);

    // hotspots, touch stick, coach marks, toast, ship tooltip
    this.dots = h('div.v-dots');
    this.knob = h('span.v-knob');
    this.stick = h('div.v-stick', { hidden: true, 'aria-hidden': 'true' }, this.knob);
    this.coach = h('div.v-coach', { hidden: true, role: 'dialog', 'aria-live': 'polite' });
    this.toast = h('div.v-toast', { hidden: true, role: 'status' });
    this.tip = h('div.v-tip', { hidden: true, 'aria-hidden': 'true' }, 'Click to hail');

    const hud = h('div.v-hud',
      h('header.v-top',
        h('div.v-title', h('div.v-nav', this.backBtn, this.crumbs), this.title, this.sub),
        h('div.v-topmid', this.chip),
        h('div.v-topright', this.specBtn, this.helpBtn)),
      h('div.mid', this.tag, this.note, this.tourPanel, this.coach),
      h('footer.v-bottom', this.caption, this.switcher, this.systems, this.dock));
    this.root.append(this.canvas, this.still, this.dots, this.tip, hud, this.drawer, this.help, this.stick, this.toast, this.loader);

    this.voice = new Voice({
      onLine: (who, text) => { this.caption.replaceChildren(h('span.who', h('span', { 'aria-hidden': 'true' }, '📻 '), who), h('span', text)); this.caption.classList.add('on'); this.S().rcs = 1; },
      onEnd: () => { this.caption.classList.remove('on'); },
    });
    this.press(this.b.sound, !this.voice.muted);
    this.setSoundIcon();
    this.wire();
    this.wireStick();
  }

  wire() {
    const B = this.b;
    B.tour.onclick = () => (this.tourIdx >= 0 ? this.endTour() : this.tourGo(0));
    B.walk.onclick = () => this.walkMode(!this.viewer?.walk);
    B.lights.onclick = () => this.set('nav', !this.S().nav);
    B.sound.onclick = () => this.mute(!this.voice.muted);
    B.systems.onclick = () => this.showSystems(this.systems.hidden);
    B.spin.onclick = () => this.set('spin', !this.viewer?.spin);
    B.gear.onclick = () => this.gear();
    B.strobe.onclick = () => this.set('strobe', !this.S().strobe);
    B.hail.onclick = () => this.hail();
    B.reset.onclick = () => { this.endTour(false); this.viewer?.resetView(); };
    B.retro.addEventListener('pointerdown', (e) => { e.preventDefault(); this.retro(true); });
    for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) B.retro.addEventListener(ev, () => this.retro(false));
    B.retro.addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); this.retro(true); } });
    B.retro.addEventListener('keyup', () => this.retro(false));
    this.specBtn.onclick = () => this.specs(this.drawer.hidden);
    this.helpBtn.onclick = () => this.showHelp(this.help.hidden);
    this.help.addEventListener('click', (e) => { if (e.target === this.help) this.showHelp(false); });
    this.thr.addEventListener('input', () => {
      const v = +this.thr.value;
      this.S().thrust = v / 100;
      this.thrOut.textContent = `${v}% ${v === 0 ? 'idle' : v < 25 ? 'low' : v < 50 ? 'cruise' : v < 85 ? 'climb' : 'full burn'}`;
    });
    this.thr.addEventListener('change', () => this.voice.ack());
  }

  // ================================================================ small state helpers
  S() { return this.viewer?.S || (this._S ??= { nav: true, strobe: true }); }
  press(b, on) { b.setAttribute('aria-pressed', on ? 'true' : 'false'); }
  set(k, on) {
    if (k === 'spin') { if (this.viewer) this.viewer.spin = on; this.press(this.b.spin, on); return; }
    this.S()[k] = on;
    this.press(k === 'nav' ? this.b.lights : this.b[k], on);
    this.voice.ack();
  }
  gear() {
    const S = this.S(); if (!this.viewer) return;
    S.gearDir = S.gearDir > 0 ? -1 : 1; this.press(this.b.gear, S.gearDir > 0);
    this.voice.ack();
  }
  retro(on) { this.S().retroTarget = on ? 1 : 0; this.press(this.b.retro, on); }
  mute(m) { this.voice.setMuted(m); this.press(this.b.sound, !m); this.setSoundIcon(); }
  setSoundIcon() {
    this.b.sound.querySelector('.ic').replaceWith(icon(this.voice.muted ? 'mute' : 'sound'));
    this.b.sound.querySelector('.lbl').textContent = this.voice.muted ? 'Sound off' : 'Sound';
  }
  hail() {
    this.viewer?.ship?.rig?.pulse?.();                  // instant feedback, before any audio
    this.voice.select();
    this.coachDone('ship');
  }
  showSystems(on) {
    this.systems.hidden = !on;
    this.press(this.b.systems, on);
    this.b.systems.setAttribute('aria-expanded', String(on));
  }
  specs(on) {
    this.drawer.hidden = !on;
    this.press(this.specBtn, on);
    if (on) this.drawer.querySelector('button')?.focus({ preventScroll: true });
  }
  showHelp(on) {
    this.help.hidden = !on;
    this.press(this.helpBtn, on);
    if (on) this.help.querySelector('button')?.focus({ preventScroll: true });
  }
  mode() {
    const n = this.viewer?.ship?.pois?.length || 0;
    let text = '';
    if (this.viewer?.walk) text = 'Walking · Esc to exit';
    else if (this.tourIdx >= 0) text = `Touring ${this.tourIdx + 1} / ${n} · Esc to exit`;
    this.chip.textContent = text;
    this.chip.hidden = !text;
  }

  // ================================================================ guided tour
  tourGo(i) {
    const v = this.viewer, pois = v?.ship?.pois;
    if (!pois?.length) return;
    if (v.walk) this.walkMode(false);
    if (this.tourIdx < 0) { this.tourSpin = v.spin; this.set('spin', false); }
    this.tourIdx = ((i % pois.length) + pois.length) % pois.length;
    const p = v.flyTo(this.tourIdx);
    if (p.action === 'gear') this.press(this.b.gear, true);
    this.tourNum.textContent = `${String(this.tourIdx + 1).padStart(2, '0')} / ${String(pois.length).padStart(2, '0')}`;
    this.tourTitle.textContent = p.title;
    this.tourText.textContent = p.text;
    this.tourPanel.hidden = false;
    this.press(this.b.tour, true);
    this.mode();
    this.coachDone('tour');
  }
  tourStep(d) { this.tourGo(this.tourIdx < 0 ? (d > 0 ? 0 : -1) : this.tourIdx + d); }
  endTour(home = true) {
    if (this.tourIdx < 0) return;
    this.tourIdx = -1;
    this.tourPanel.hidden = true;
    this.press(this.b.tour, false);
    if (this.viewer) { if (home) this.viewer.resetView(); this.set('spin', this.tourSpin ?? this.viewer.spin); }
    this.mode();
  }
  drawDots() {
    const v = this.viewer;
    const spots = v && !this.canvas.hidden ? v.hotspots(this.canvas.clientWidth, this.canvas.clientHeight) : [];
    const pois = v?.ship?.pois || [];
    if (this.dots.dataset.ship !== (v?.ship?.id || '')) {
      this.dots.dataset.ship = v?.ship?.id || '';
      this.dots.replaceChildren(...pois.map((p, i) => h('button.v-dot', { type: 'button', hidden: true, 'aria-label': `Tour stop ${i + 1}: ${p.title}`, onclick: () => this.tourGo(i) },
        h('b', String(i + 1)), h('span', p.title))));
      // pulse for the first few seconds with a new ship, then settle
      this.dots.classList.add('fresh');
      clearTimeout(this.dotsT); this.dotsT = setTimeout(() => this.dots.classList.remove('fresh'), 7000);
    }
    const kids = this.dots.children;
    const on = new Set();
    for (const s of spots) {
      const el = kids[s.i]; if (!el) continue;
      on.add(s.i); el.hidden = false;
      el.style.transform = `translate3d(${s.x.toFixed(1)}px, ${s.y.toFixed(1)}px, 0)`;
      el.style.opacity = String(Math.max(0.15, Math.min(1, 0.4 + s.facing)));
      el.classList.toggle('cur', s.i === this.tourIdx);
    }
    [...kids].forEach((el, i) => { if (!on.has(i)) el.hidden = true; });
    this.firstDot = spots.find((s) => s.i === 0) || null;
  }

  // ================================================================ walk-around
  walkMode(on) {
    const v = this.viewer;
    if (!v || !!v.walk === on) return;
    if (on) this.endTour(false);
    v.setWalk(on);
    this.press(this.b.walk, on);
    this.root.classList.toggle('walking', on);
    this.stick.hidden = !(on && touch());
    this.mode();
    if (on) this.canvas.focus({ preventScroll: true });
  }
  wireStick() {
    let id = null, active = false;
    const set = (e) => {
      const r = this.stick.getBoundingClientRect(), R = r.width / 2;
      let x = (e.clientX - (r.left + R)) / R, y = (e.clientY - (r.top + R)) / R;
      const l = Math.hypot(x, y); if (l > 1) { x /= l; y /= l; }
      this.knob.style.transform = `translate(${(x * R * 0.6).toFixed(1)}px, ${(y * R * 0.6).toFixed(1)}px)`;
      if (this.viewer?.walk) this.viewer.walk.stick = { x, y };
    };
    this.stick.addEventListener('pointerdown', (e) => { id = e.pointerId; active = true; this.stick.setPointerCapture(id); set(e); e.preventDefault(); });
    this.stick.addEventListener('pointermove', (e) => { if (active && e.pointerId === id) set(e); });
    const end = () => { active = false; this.knob.style.transform = ''; if (this.viewer?.walk) this.viewer.walk.stick = { x: 0, y: 0 }; };
    for (const ev of ['pointerup', 'pointercancel']) this.stick.addEventListener(ev, end);
  }

  // ================================================================ first-visit help
  coachStart() {
    if (ls.get(COACH_KEY) === 'done' || this.coachStep) return;
    this.coachStep = 'drag';
    this.coachShow();
  }
  coachShow() {
    const t = touch();
    const steps = {
      drag: [t ? 'Drag with one finger to look around' : 'Drag to look around', t ? 'Pinch to zoom, two fingers to pan.' : 'Scroll to zoom, right-drag to pan.', 'drag'],
      ship: [t ? 'Tap the ship to talk to the pilot' : 'Click the ship to talk to the pilot', 'Every maker has its own voice. Sound can be muted any time.', 'tap'],
      tour: [t ? 'Tap ① to tour the ship' : 'Click ① to tour the ship', 'Numbered stops fly you to the cockpit, the drives and more. Esc comes back.', 'dot'],
    };
    const [title, body, glyph] = steps[this.coachStep];
    const n = ['drag', 'ship', 'tour'].indexOf(this.coachStep) + 1;
    this.coach.replaceChildren(
      h('div.v-coach-glyph', { class: `g-${glyph}${t ? ' touch' : ''}`, 'aria-hidden': 'true' }, h('i'), h('b')),
      h('div', h('span.micro', `Tip ${n} of 3`), h('p.v-coach-title', title), h('p', body),
        h('div.v-coach-act',
          h('button.vbtn', { type: 'button', onclick: () => this.coachNext() }, h('span.lbl', n < 3 ? 'Next' : 'Got it')),
          h('button.vbtn.quiet', { type: 'button', onclick: () => this.coachEnd() }, h('span.lbl', 'Skip tips')))));
    this.coach.hidden = false;
  }
  coachNext() {
    const order = ['drag', 'ship', 'tour'];
    const i = order.indexOf(this.coachStep);
    if (i < 0 || i >= 2) return this.coachEnd();
    this.coachStep = order[i + 1];
    this.coachShow();
  }
  /** the user did the thing the current tip asks for: move on */
  coachDone(what) {
    const order = ['drag', 'ship', 'tour'];
    const cur = order.indexOf(this.coachStep), did = order.indexOf(what);
    if (cur < 0 || did < cur) return;
    if (did >= 2) return this.coachEnd();
    this.coachStep = order[did];
    this.coachNext();
  }
  coachEnd() { this.coachStep = null; this.coach.hidden = true; ls.set(COACH_KEY, 'done'); }

  /** browsers only allow audio after a gesture: on the first one, say whether sound is on */
  soundPrompt() {
    removeEventListener('pointerdown', this.firstGesture, true);
    removeEventListener('keydown', this.firstGesture, true);
    if (ss.get('aurelia.soundprompt')) return;
    ss.set('aurelia.soundprompt', '1');
    const muted = this.voice.muted;
    this.toast.replaceChildren(icon(muted ? 'mute' : 'sound'),
      h('span', muted ? 'Sound is off.' : 'Sound on: the pilots answer when you click their ship.'),
      h('button.vbtn.quiet', { type: 'button', onclick: () => { this.mute(!muted); this.toast.hidden = true; } }, h('span.lbl', muted ? 'Turn on' : 'Mute')));
    this.toast.hidden = false;
    clearTimeout(this.toastT); this.toastT = setTimeout(() => { this.toast.hidden = true; }, 6000);
  }

  // ================================================================ open / close
  async open(m, s) {
    const token = ++this.token;
    const makerChanged = this.maker?.id !== m.id;
    // switching hulls keeps the visitor's mode (tour stop / walking)
    const keep = this.viewer?.ship ? { tour: this.tourIdx, walk: !!this.viewer?.walk } : { tour: -1, walk: false };
    this.endTour(false);
    if (this.viewer?.walk) this.walkMode(false);
    this.voice.stop();
    this.maker = m; this.ship = s;
    this.voice.setShip(m, s);
    this.root.hidden = false;
    this.root.style.setProperty('--v-acc', m.theme.accent);
    addEventListener('keydown', this.keys);
    addEventListener('keyup', this.keyUp);
    addEventListener('pointerdown', this.firstGesture, true);
    addEventListener('keydown', this.firstGesture, true);

    // where am I: Fleet › Maker › Ship
    this.crumbs.replaceChildren(
      h('a', { href: '#/' }, 'Fleet'), h('span', { 'aria-hidden': 'true' }, '›'),
      h('a', { href: `#/${m.id}` }, m.name), h('span', { 'aria-hidden': 'true' }, '›'),
      h('span', { 'aria-current': 'page' }, s.name));
    this.backBtn.href = `#/${m.id}`;
    this.backBtn.setAttribute('aria-label', `Back to ${m.full}`);
    this.title.textContent = s.name;
    this.title.classList.toggle('long', s.name.length > 11);
    this.sub.replaceChildren(h('b', s.role), ` · ${s.class} · ${fmtLen(s.length)}`);
    this.specHead.textContent = `${m.name} ${s.name}`;
    const rows = [['Maker', m.full], ['Length', fmtLen(s.length)], ['Class', s.class], ['Crew', s.crew], ['Role', s.role]];
    if (s.registration) rows.push(['Registration', s.registration]);
    rows.push(['Home yard', m.yard.name]);
    if (s.glb) rows.push(['Real-time mesh', `${fmtK(s.glb.tris)} tris · ${s.glb.draw_calls} calls`], ['Download', fmtMB(s.glb.bytes)]);
    this.specDl.replaceChildren(...rows.flatMap(([k, v]) => [h('dt', k), h('dd', v)]));
    this.specCopy.textContent = s.copy;
    this.canvas.setAttribute('aria-label', `Interactive 3D model of the ${m.name} ${s.name}. Drag to look around; press question mark for controls.`);

    if (makerChanged || !this.switcher.childElementCount) {
      this.switcher.replaceChildren(...shipsOf(m.id).map((x) => h('a', { href: `#/${m.id}/${x.id}`, 'data-id': x.id, title: `${x.name} · ${fmtLen(x.length)}` },
        x.silhouette ? h('span.sil', { style: { '--sil': cssUrl(x.silhouette.src) }, 'aria-hidden': 'true' }) : null,
        h('span', x.name))));
    }
    for (const a of this.switcher.children) a.setAttribute('aria-current', a.dataset.id === s.id ? 'true' : 'false');
    this.switcher.querySelector('[aria-current="true"]')?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'auto' });
    this.caption.classList.remove('on');
    this.tag.hidden = true;
    this.note.hidden = true;
    this.mode();
    this.title.focus({ preventScroll: true });

    // poster-only path: no model, or no WebGL — never a blank canvas
    if (!s.glb || !webgl2) {
      this.viewer?.idle();
      this.showStill(s, !s.glb
        ? ['Real-time model in production', `The ${s.name} is still being exported. Showing the studio still.`]
        : ['3D needs WebGL 2', 'This browser cannot run the real-time viewer, so here is the studio still.']);
      return;
    }

    this.dock.hidden = false;
    this.still.classList.remove('on');
    this.canvas.hidden = false;
    // same hall: no full-screen loader, the camera flies bay to bay (a small pill shows any download)
    this.fullLoader = !(this.viewer?.room?.id === m.id && this.viewer.fleet);
    if (this.fullLoader) this.loading(s, m);
    try {
      if (!this.viewer) {
        const { Viewer } = await import('./viewer.js?v=9d6b8683b2180e2a');
        if (token !== this.token) return;
        this.viewer = new Viewer(this.canvas, {
          onTap: (model) => this.tapShip(model),
          onLost: () => this.showStill(this.ship, ['Graphics context lost', 'The GPU dropped the 3D view. Reload to try again.']),
          onDrag: () => this.coachDone('drag'),
          onHover: (hit, x, y) => this.hover(hit, x, y),
        });
        this.viewer.spin = !reduceMotion();
        if (/[?&](debug|perf=1)\b/.test(location.search)) window.__viewer = this.viewer;   // console poking, opt-in only
      }
      await this.viewer.show(m, s, (p, label) => {
        if (token !== this.token) return;
        this.bar.style.setProperty('--p', p.toFixed(3));
        this.loadTxt.textContent = label;
        if (!this.fullLoader) { this.tag.textContent = `${label.split(' · ')[0]} · ${Math.round(p * 100)}%`; this.tag.hidden = false; }
      }, shipsOf(m.id));
      if (token !== this.token) return;
      this.ready(s);
      if (this.pendingHail === s.id) { this.pendingHail = null; this.hail(); }
      if (keep.walk) this.walkMode(true);
      else if (keep.tour >= 0) this.tourGo(Math.min(keep.tour, (this.viewer.ship?.pois?.length || 1) - 1));
      this.coachStart();
    } catch (err) {
      if (token !== this.token) return;
      console.error(err);
      this.viewer?.idle();
      this.showStill(s, ['The viewer hit an error', String(err?.message || err)]);
    }
  }

  /** a hull in the hall was clicked: the focused one answers, any other one is flown to (and then answers) */
  tapShip(model) {
    if (!model || model.id === this.ship?.id) return this.hail();
    this.pendingHail = model.id;
    location.hash = `#/${this.maker.id}/${model.id}`;
  }

  hover(model, x, y, focused) {
    const show = model && !this.viewer?.walk;
    this.tip.hidden = !show;
    if (show) {
      const verb = touch() ? 'Tap' : 'Click';
      this.tip.textContent = focused ? `${verb} to hail` : `${verb} to view the ${model.name}`;
      this.tip.style.transform = `translate3d(${x + 16}px, ${y + 18}px, 0)`;
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
    this.b.hail.hidden = !this.maker?.voice?.lines?.length && !s.extra_lines?.length;
    this.press(this.b.gear, v.S.gearDir > 0);
    this.press(this.b.lights, v.S.nav);
    this.press(this.b.strobe, v.S.strobe);
    this.press(this.b.spin, v.spin);
    this.thr.value = String(Math.round(v.S.thrust * 100));
    this.thr.dispatchEvent(new Event('input'));
    this.tag.hidden = true;
    this.b.spin.hidden = !!v.ship?.outdoor;
    if (v.ship?.outdoor) {
      this.tag.textContent = `Outside the glass · true scale · ${fmtLen(s.length)}`;
      this.tag.hidden = false;
    }
    cancelAnimationFrame(this.statusRaf);
    const status = () => {
      if (this.root.hidden || !this.viewer) return;
      this.statusRaf = requestAnimationFrame(status);
      if (!this.viewer.ship?.rig) return;                // a hull is streaming in
      const S = this.viewer.S;
      const g = !this.viewer.ship.rig.hasGear ? 'NONE' : S.gearT <= 0 ? 'STOWED' : S.gearT >= 1 ? 'DOWN · LOCKED' : S.gearDir > 0 ? 'DEPLOYING' : 'RETRACTING';
      if (this.sGear.textContent !== g) this.sGear.textContent = g;
      const r = S.retro > 0.05 ? 'BURNING' : 'SAFE';
      if (this.sRetro.textContent !== r) this.sRetro.textContent = r;
      const h0 = performance.now();
      this.drawDots();
      if (window.__hudMs) { window.__hudMs.push(performance.now() - h0); if (window.__hudMs.length > 300) window.__hudMs.shift(); }
    };
    status();
  }

  showStill(s, [head, body]) {
    this.loader.classList.add('done');
    this.canvas.hidden = true;
    this.dock.hidden = true;
    this.systems.hidden = true;
    this.dots.replaceChildren(); this.dots.dataset.ship = '';
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
    this.endTour(false);
    if (this.viewer?.walk) this.walkMode(false);
    this.voice.stop();
    this.specs(false); this.showHelp(false);
    this.coach.hidden = true; this.coachStep = null;
    this.root.hidden = true;
    this.viewer?.stop();
    cancelAnimationFrame(this.statusRaf);
    removeEventListener('keydown', this.keys);
    removeEventListener('keyup', this.keyUp);
    removeEventListener('pointerdown', this.firstGesture, true);
    removeEventListener('keydown', this.firstGesture, true);
  }

  // ================================================================ keyboard
  onKey(e) {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    const tag = e.target?.tagName;
    const inField = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
    const v = this.viewer;
    const live = v && !this.canvas.hidden;
    if (live && v.walk && !inField) {                  // walk mode owns W A S D / arrows / Shift
      const k = WALK_KEYS[e.code];
      if (k) { if (!e.repeat) v.walkNudge(k); v.walk.keys.add(k); e.preventDefault(); return; }
    }
    const step = (dir) => {
      const list = shipsOf(this.maker.id);
      const i = list.findIndex((x) => x.id === this.ship.id);
      location.hash = `#/${this.maker.id}/${list[(i + dir + list.length) % list.length].id}`;
    };
    switch (e.key) {
      case 'Escape':                                    // always one level out
        if (!this.help.hidden) this.showHelp(false);
        else if (!this.drawer.hidden) this.specs(false);
        else if (this.coachStep) this.coachEnd();
        else if (v?.walk) this.walkMode(false);
        else if (this.tourIdx >= 0) this.endTour();
        else this.onExit?.(this.maker);
        break;
      case '?': this.showHelp(this.help.hidden); break;
      case '[': case 'PageUp': step(-1); break;
      case ']': case 'PageDown': step(1); break;
      case ',': case '<': if (!live) return; this.tourStep(-1); break;
      case '.': case '>': if (!live) return; this.tourStep(1); break;
      case 'w': case 'W': if (!live || inField) return; this.walkMode(true); break;
      case 'm': case 'M': this.mute(!this.voice.muted); break;
      case 'ArrowLeft': if (inField || !live) return; v.orbit(-0.12, 0); break;
      case 'ArrowRight': if (inField || !live) return; v.orbit(0.12, 0); break;
      case 'ArrowUp': if (inField || !live) return; v.orbit(0, -0.08); break;
      case 'ArrowDown': if (inField || !live) return; v.orbit(0, 0.08); break;
      case '+': case '=': if (!live) return; v.zoom(0.88); break;
      case '-': case '_': if (!live) return; v.zoom(1.14); break;
      case '0': case 'Home': if (!live) return; this.endTour(false); v.resetView(); break;
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
