// Procedural audio (no files): room tone, server fans that rise with load, UI clicks, alerts.
export class Sound {
  constructor() { this.ctx = null; this.volume = 0.6; this.stress = 0; }

  ensure() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return this.ctx; }
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      const ctx = (this.ctx = new AC());
      this.master = ctx.createGain();
      this.master.gain.value = this.volume;
      this.master.connect(ctx.destination);
      // brown-noise room tone + fan bed
      const len = ctx.sampleRate * 4;
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const data = buf.getChannelData(0);
      let last = 0;
      for (let i = 0; i < len; i++) { const w = Math.random() * 2 - 1; last = (last + 0.02 * w) / 1.02; data[i] = last * 3.2; }
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 420;
      this.fanGain = ctx.createGain();
      this.fanGain.gain.value = 0.09;
      src.connect(lp).connect(this.fanGain).connect(this.master);
      src.start();
      this.fanFilter = lp;
      // mains hum
      for (const [f, g] of [[50, 0.012], [100, 0.006]]) {
        const o = ctx.createOscillator();
        o.frequency.value = f;
        const gg = ctx.createGain();
        gg.gain.value = g;
        o.connect(gg).connect(this.master);
        o.start();
      }
      return ctx;
    } catch { return null; }
  }

  setVolume(v) { this.volume = v; if (this.master) this.master.gain.value = v; }

  /** 0..1: fans spin up during storms / outages. */
  setStress(s) {
    this.stress = s;
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.fanGain.gain.setTargetAtTime(0.09 + s * 0.22, t, 0.6);
    this.fanFilter.frequency.setTargetAtTime(420 + s * 1600, t, 0.6);
  }

  tone(freq, dur = 0.08, type = 'sine', vol = 0.06, when = 0) {
    const ctx = this.ensure();
    if (!ctx) return;
    const t = ctx.currentTime + when;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  key() {
    const ctx = this.ensure();
    if (!ctx) return;
    const t = ctx.currentTime;
    const b = ctx.createBuffer(1, 600, ctx.sampleRate);
    const d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 6);
    const s = ctx.createBufferSource();
    s.buffer = b;
    const g = ctx.createGain();
    g.gain.value = 0.12;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 1800;
    s.connect(hp).connect(g).connect(this.master);
    s.start(t);
  }

  use() { this.tone(660, 0.07, 'triangle', 0.05); }
  deny() { this.tone(180, 0.12, 'square', 0.03); }
  ok() { this.tone(523, 0.12, 'sine', 0.05); this.tone(784, 0.18, 'sine', 0.045, 0.09); }
  win() { [523, 659, 784, 1046].forEach((f, i) => this.tone(f, 0.35, 'triangle', 0.05, i * 0.09)); }
  alarm() { this.tone(880, 0.15, 'square', 0.025); this.tone(660, 0.15, 'square', 0.025, 0.18); }
  radio() { this.tone(1400, 0.05, 'square', 0.02); this.tone(1100, 0.05, 'square', 0.02, 0.06); }
}
