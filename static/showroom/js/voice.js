// Pilot voice, StarCraft-style: select lines when the ship is clicked (or H), short acks when a system is toggled,
// and an escalating run of "pissed" lines if someone keeps poking the hull. One line at a time, mutable (M).
const KEY = 'aurelia.voice.muted';
const store = {
  get() { try { return localStorage.getItem(KEY) === '1'; } catch { return false; } },
  set(v) { try { localStorage.setItem(KEY, v ? '1' : '0'); } catch { /* private mode: session only */ } },
};

export class Voice {
  /** onLine(who, text) shows the subtitle; onEnd() clears it */
  constructor({ onLine, onEnd } = {}) {
    this.muted = store.get();
    this.onLine = onLine; this.onEnd = onEnd;
    this.audio = null;
    this.clicks = [];
    this.pissedIdx = 0;
    this.lastAck = 0;
    this.last = null;
    this.maker = null; this.ship = null;
  }

  setShip(maker, ship) {
    if (this.ship?.id !== ship.id) { this.clicks = []; this.pissedIdx = 0; }
    this.maker = maker; this.ship = ship;
  }
  setMuted(m) { this.muted = m; store.set(m); if (m) this.stop(); }
  get playing() { return !!this.audio && !this.audio.paused && !this.audio.ended; }
  speaker() { return this.ship?.speaker || this.maker?.speaker || this.maker?.name || ''; }

  lines(kind) {
    const all = this.maker?.voice?.lines || [];
    const model = this.ship?.model;
    const generic = all.filter((l) => l.kind === kind && !l.ships);
    const own = all.filter((l) => l.kind === kind && l.ships?.includes(model));
    const extra = kind === 'select' ? (this.ship?.extra_lines || []) : [];
    return { generic, own: [...own, ...extra] };
  }
  pick(kind) {
    const { generic, own } = this.lines(kind);
    // ship-specific lines are preferred (two in three picks) when the ship has any
    const pool = own.length && (Math.random() < 0.67 || !generic.length) ? own : generic;
    const choices = pool.length > 1 ? pool.filter((l) => l !== this.last) : pool;
    return choices[Math.floor(Math.random() * choices.length)] || null;
  }

  play(line, { interrupt = true } = {}) {
    if (!line) return false;
    if (this.playing && !interrupt) return false;
    this.stop(false);
    this.last = line;
    this.onLine?.(this.speaker(), line.text);
    if (this.muted) { clearTimeout(this.t); this.t = setTimeout(() => this.onEnd?.(), 2800 + line.text.length * 40); return true; }
    try {
      const a = new Audio(line.src);
      this.audio = a;
      a.addEventListener('ended', () => { if (this.audio === a) { this.audio = null; clearTimeout(this.t); this.t = setTimeout(() => this.onEnd?.(), 900); } });
      a.play().catch(() => { /* autoplay refused: the subtitle still shows */ });
    } catch { /* audio is optional */ }
    clearTimeout(this.t); this.t = setTimeout(() => this.onEnd?.(), 12000);
    return true;
  }
  stop(clear = true) {
    if (this.audio) { this.audio.pause(); this.audio = null; }
    if (clear) { clearTimeout(this.t); this.onEnd?.(); }
  }

  /** the ship was clicked / hailed; four or more pokes inside ~6 s escalate through the pissed lines in order */
  select() {
    const now = performance.now();
    this.clicks = this.clicks.filter((t) => now - t < 6000);
    this.clicks.push(now);
    if (this.clicks.length >= 4) {
      const { generic, own } = this.lines('pissed');
      const seq = [...own, ...generic];
      if (seq.length) {
        const line = seq[Math.min(this.pissedIdx, seq.length - 1)];
        this.pissedIdx = (this.pissedIdx + 1) % seq.length;
        return this.play(line);
      }
    } else if (now - (this.clicks[this.clicks.length - 2] ?? -1e9) > 10000) this.pissedIdx = 0;
    return this.play(this.pick('select'));
  }

  /** a system was toggled: sometimes say so (never over another line, at most every few seconds) */
  ack() {
    const now = performance.now();
    if (this.playing || now - this.lastAck < 4000 || Math.random() > 0.3) return false;
    this.lastAck = now;
    return this.play(this.pick('ack'), { interrupt: false });
  }
}
