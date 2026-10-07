// Ambience: procedural WebAudio sound design for the showroom (no assets, no network).
// Graph: [room tone per hall] -> roomBus -> master;  space bed, turntable hum, engine -> master.
// Noise comes from two long (8 s) buffers generated once (brown + white), made seamless by
// equal-power crossfading the tail into the head, so looping never clicks. Everything is
// continuous sources + gains/filters driven with setTargetAtTime (no scripts/worklets/blobs).
// Halls are built lazily the first time they are visited and then kept running at gain 0.
// State is remembered before unlock(), so setters may be called at any time (no-ops sans audio).

const MASTER = 0.5;            // master level; sources are already tiny (~-24 dBFS peak overall)
const HALLS = {
  // noise: brown|white, ft: filter type, f: cutoff, q, n: noise level, p: [freq, level] sine partials
  atlantia: { noise: 'white', ft: 'highpass', f: 3500, q: 0.4, n: 0.010, p: [[60, 0.012], [120, 0.003]] },
  helios:   { noise: 'white', ft: 'bandpass', f: 2200, q: 0.5, n: 0.016, p: [[95, 0.008], [190, 0.003]] },
  daedalus: { noise: 'brown', ft: 'lowpass',  f: 260,  q: 0.7, n: 0.16,  p: [[38, 0.02], [55, 0.012]], swell: 0.05 },
  cydonia:  { noise: 'brown', ft: 'lowpass',  f: 420,  q: 0.7, n: 0.08,  p: [[50, 0.012], [100, 0.006], [150, 0.003], [250, 0.0015]] },
  kingsley: { noise: 'brown', ft: 'lowpass',  f: 180,  q: 0.5, n: 0.06,  p: [[70, 0.006]] },
};

export class Ambience {
  constructor() {
    this.ctx = null; this.muted = false; this.hall = null; this.spin = false;
    this.thrust = 0; this.outside = false;
    this.halls = {}; this._disposed = false; this._suspendTimer = 0;
  }

  unlock() {
    if (this._disposed) return;
    try {
      if (!this.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        this.ctx = new AC({ latencyHint: 'playback' });
        this._build();
      }
      if (this.ctx.state === 'suspended' && !this.muted) this.ctx.resume().catch(() => {});
      this._apply();
    } catch (e) { this.ctx = null; }
  }

  setMuted(b) {
    this.muted = !!b;
    const c = this.ctx; if (!c) return;
    clearTimeout(this._suspendTimer);
    if (this.muted) {
      this._ramp(this.master.gain, 0, 0.12);
      this._suspendTimer = setTimeout(() => { if (this.muted && this.ctx) this.ctx.suspend().catch(() => {}); }, 900);
    } else {
      if (c.state === 'suspended') c.resume().catch(() => {});
      this._ramp(this.master.gain, MASTER, 0.12);
    }
  }

  setHall(id) { this.hall = HALLS[id] ? id : null; this._apply(); }
  setSpin(b) { this.spin = !!b; this._apply(); }
  setThrust(t) { this.thrust = Math.max(0, Math.min(1, +t || 0)); this._apply(); }
  setOutside(b) { this.outside = !!b; this._apply(); }

  dispose() {
    this._disposed = true; clearTimeout(this._suspendTimer);
    const c = this.ctx; this.ctx = null; this.halls = {};
    if (c) { try { c.close(); } catch (e) { /* ignore */ } }
  }

  // ---- internals ----
  _ramp(param, v, tc) { param.setTargetAtTime(v, this.ctx.currentTime, tc); }

  _noiseBuf(kind) {
    const c = this.ctx, sr = kind === 'brown' ? 22050 : c.sampleRate;
    const L = sr * 8, F = Math.floor(sr * 0.5), raw = new Float32Array(L + F);
    let last = 0;
    for (let i = 0; i < raw.length; i++) {
      const w = Math.random() * 2 - 1;
      if (kind === 'brown') { last = (last + 0.02 * w) / 1.02; raw[i] = last * 3.5; } else raw[i] = w * 0.5;
    }
    const buf = c.createBuffer(1, L, sr), out = buf.getChannelData(0);
    for (let i = 0; i < L; i++) out[i] = raw[i];
    for (let i = 0; i < F; i++) {          // blend tail extension into the head: seamless loop
      const a = (i / F) * Math.PI / 2;
      out[i] = raw[i] * Math.sin(a) + raw[L + i] * Math.cos(a);
    }
    return buf;
  }

  _noise(kind) {
    const s = this.ctx.createBufferSource();
    s.buffer = this.bufs[kind]; s.loop = true;
    s.loopStart = 0; s.start(0, Math.random() * 7);   // random phase per source
    return s;
  }

  _osc(type, f, g, dest) {
    const c = this.ctx, o = c.createOscillator(), v = c.createGain();
    o.type = type; o.frequency.value = f; v.gain.value = g;
    o.connect(v); v.connect(dest); o.start();
    return { o, v };
  }

  _filter(type, f, q) {
    const n = this.ctx.createBiquadFilter(); n.type = type; n.frequency.value = f; n.Q.value = q; return n;
  }

  _build() {
    const c = this.ctx;
    this.bufs = { brown: this._noiseBuf('brown'), white: this._noiseBuf('white') };
    this.master = c.createGain(); this.master.gain.value = this.muted ? 0 : MASTER;
    this.master.connect(c.destination);
    this.roomBus = c.createGain(); this.roomBus.connect(this.master);

    // deep space bed
    this.space = c.createGain(); this.space.gain.value = 0; this.space.connect(this.master);
    const sn = this._noise('brown'), sf = this._filter('lowpass', 90, 0.7), sg = c.createGain();
    sg.gain.value = 0.10; sn.connect(sf); sf.connect(sg); sg.connect(this.space);
    this._osc('sine', 34, 0.012, this.space);
    this._osc('sine', 51.3, 0.005, this.space);

    // turntable motor hum: saw ~110 Hz through lowpass + 2nd harmonic, slight wobble
    this.spinG = c.createGain(); this.spinG.gain.value = 0; this.spinG.connect(this.master);
    const lp = this._filter('lowpass', 300, 0.8); lp.connect(this.spinG);
    const saw = this._osc('sawtooth', 110, 0.010, lp);
    const h2 = this._osc('sine', 220, 0.004, this.spinG);
    const wob = c.createOscillator(), wg = c.createGain();
    wob.frequency.value = 0.7; wg.gain.value = 1.5;
    wob.connect(wg); wg.connect(saw.o.frequency); wg.connect(h2.o.frequency); wob.start();

    // engine idle / rumble
    this.engG = c.createGain(); this.engG.gain.value = 0; this.engG.connect(this.master);
    this.engF = this._filter('lowpass', 140, 0.8);
    const en = this._noise('brown'), eg = c.createGain(); eg.gain.value = 0.35;
    en.connect(this.engF); this.engF.connect(eg); eg.connect(this.engG);
    this.engOsc = this._osc('sine', 46, 0.05, this.engG).o;
    this.engOsc2 = this._osc('triangle', 92, 0.012, this.engG).o;
  }

  _buildHall(id) {
    const c = this.ctx, h = HALLS[id], g = c.createGain();
    g.gain.value = 0; g.connect(this.roomBus);
    const n = this._noise(h.noise), f = this._filter(h.ft, h.f, h.q), ng = c.createGain();
    ng.gain.value = h.n; n.connect(f); f.connect(ng); ng.connect(g);
    if (h.swell) {   // slow 0.05 Hz rumble swell on the noise level
      const l = c.createOscillator(), lg = c.createGain();
      l.frequency.value = h.swell; lg.gain.value = h.n * 0.4; l.connect(lg); lg.connect(ng.gain); l.start();
    }
    for (const [fr, lv] of h.p) this._osc('sine', fr, lv, g);
    this.halls[id] = g;
  }

  _apply() {
    const c = this.ctx; if (!c) return;
    if (this.hall && !this.halls[this.hall]) this._buildHall(this.hall);
    for (const id in this.halls) this._ramp(this.halls[id].gain, id === this.hall ? 1 : 0, 0.7); // ~2 s
    this._ramp(this.roomBus.gain, this.outside ? 0.25 : 1, 0.5);
    this._ramp(this.space.gain, this.outside ? 1 : 0, 0.7);
    this._ramp(this.spinG.gain, this.spin ? 1 : 0, 0.3);
    const t = this.thrust;
    this._ramp(this.engG.gain, this.hall ? 0.12 + 0.88 * t : 0, 0.15);   // idle is barely there; silent outside a hall
    this._ramp(this.engF.frequency, 140 + 900 * t, 0.2);
    this._ramp(this.engOsc.frequency, 46 + 22 * t, 0.2);
    this._ramp(this.engOsc2.frequency, 92 + 44 * t, 0.2);
  }
}
