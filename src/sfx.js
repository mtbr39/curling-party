// WebAudio で合成する効果音（外部ファイル不要）
let ctx = null;
let master = null;
let noiseBuf = null;
let muted = false;

function ac() {
  if (!ctx) {
    const C = window.AudioContext || window.webkitAudioContext;
    if (!C) return null;
    ctx = new C();
    master = ctx.createGain();
    master.gain.value = 0.5;
    master.connect(ctx.destination);
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 1.5, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

export function unlockAudio() { ac(); }
export function setMuted(m) { muted = m; if (master) master.gain.value = m ? 0 : 0.5; }
export function isMuted() { return muted; }

function noise(dur, freq, q, gain, type = 'bandpass') {
  const c = ac(); if (!c || muted) return;
  const src = c.createBufferSource(); src.buffer = noiseBuf;
  const f = c.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
  const g = c.createGain();
  const t = c.currentTime;
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(f); f.connect(g); g.connect(master);
  src.start(t, Math.random()); src.stop(t + dur + 0.05);
  return f;
}

function tone(freq, dur, gain, type = 'sine', when = 0, slide = 0) {
  const c = ac(); if (!c || muted) return;
  const o = c.createOscillator(); o.type = type;
  const g = c.createGain();
  const t = c.currentTime + when;
  o.frequency.setValueAtTime(freq, t);
  if (slide) o.frequency.exponentialRampToValueAtTime(freq * slide, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g); g.connect(master);
  o.start(t); o.stop(t + dur + 0.05);
}

export const sfx = {
  hit(power) {
    const p = Math.min(1, power / 600);
    noise(0.08 + p * 0.1, 1800 + p * 1500, 1.2, 0.25 + p * 0.6);
    tone(140 + p * 60, 0.12 + p * 0.1, 0.2 + p * 0.4, 'triangle', 0, 0.5);
  },
  // 投げた瞬間: 「ポン」。短い音程の下がる正弦波＋軽いアタック
  throw() {
    tone(660, 0.16, 0.3, 'sine', 0, 0.55);
    tone(1320, 0.05, 0.08, 'triangle');
  },
  sweep() { noise(0.09, 3200, 0.7, 0.08, 'highpass'); },
  out() { tone(320, 0.25, 0.12, 'sine', 0, 0.4); },
  tech(level) {
    const base = 523.25;
    const steps = [0, 4, 7, 12, 16, 19, 24];
    const n = Math.min(steps.length, 3 + level);
    for (let i = 0; i < n; i++) tone(base * Math.pow(2, steps[i] / 12), 0.35, 0.18, 'triangle', i * 0.06);
    noise(0.4, 6000, 0.5, 0.15, 'highpass');
  },
  guard() {
    tone(392, 0.3, 0.2, 'square', 0);
    tone(587.33, 0.45, 0.18, 'square', 0.1);
  },
  tick() { tone(1200, 0.05, 0.12, 'square'); },
  lost() { tone(180, 0.4, 0.25, 'sawtooth', 0, 0.5); },
  go() { tone(880, 0.25, 0.2, 'triangle'); tone(1318.5, 0.35, 0.2, 'triangle', 0.08); },
  count() { tone(660, 0.12, 0.15, 'triangle'); },
  score() { [0, 4, 7, 12].forEach((s, i) => tone(392 * Math.pow(2, s / 12), 0.4, 0.15, 'triangle', i * 0.09)); },
};
