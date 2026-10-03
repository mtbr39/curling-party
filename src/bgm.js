// BGM: 2曲をランダムな方から交互にくり返し流す（効果音とは別に音量を変えられる）
const TRACKS = ['assets/bgm/music_guruguru.mp3', 'assets/bgm/music_song1213.mp3'];

let el = null;
let idx = 0;
let playing = false;   // 流している途中か（フェードアウト中は false）
let volume = 0.5;      // BGM の音量（0〜1）
let muted = false;
let fadeTimer = null;
let listener = null;   // 鳴っている/止まっているが変わったら呼ぶ

// スライダーいっぱい（1）でも曲の元の大きさの半分にとどめ、効果音を邪魔しない
const MAX = 0.5;

function level() { return muted ? 0 : volume * MAX; }

// 実際に音が聞こえているか（再生中で、消音でも音量0でもない）
function notify() { listener?.(!!el && !el.paused && level() > 0); }
export function onBgmState(fn) { listener = fn; notify(); }

function clearFade() {
  if (fadeTimer) { clearInterval(fadeTimer); fadeTimer = null; }
}

// ブラウザに自動再生を止められたら、次に画面を触ったときに鳴らす
function retryOnGesture() {
  const go = () => {
    removeEventListener('pointerdown', go); removeEventListener('keydown', go);
    if (playing && el?.paused) el.play().catch(() => {});
  };
  addEventListener('pointerdown', go); addEventListener('keydown', go);
}

function playTrack() {
  if (!el) {
    el = new Audio();
    el.preload = 'auto';
    // 1曲おわったら、もう一方の曲へ
    el.addEventListener('ended', () => { if (playing) { idx = 1 - idx; playTrack(); } });
    el.addEventListener('playing', notify);
    el.addEventListener('pause', notify);
  }
  el.src = TRACKS[idx];
  el.volume = level();
  el.play().catch(retryOnGesture);
}

export function startBgm() {
  if (playing) return;
  clearFade();
  playing = true;
  idx = Math.floor(Math.random() * TRACKS.length);
  playTrack();
}

// 結果発表: 短めのフェードアウトで止める
export function fadeOutBgm(sec = 1.2) {
  if (!playing || !el) return;
  playing = false;
  clearFade();
  const from = el.volume, t0 = performance.now();
  fadeTimer = setInterval(() => {
    const k = (performance.now() - t0) / (sec * 1000);
    if (k >= 1) { clearFade(); el.pause(); return; }
    el.volume = from * (1 - k);
  }, 30);
}

export function stopBgm() {
  playing = false;
  clearFade();
  el?.pause();
}

export function setBgmVolume(v) {
  volume = Math.max(0, Math.min(1, v));
  if (el && !fadeTimer) el.volume = level();
  notify();
}
export function getBgmVolume() { return volume; }
export function setBgmMuted(m) {
  muted = m;
  if (el && !fadeTimer) el.volume = level();
  notify();
}
