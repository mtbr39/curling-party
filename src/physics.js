// 石の物理シミュレーション（ホストもクライアントも同じものを使う）
import { SHEET, STONE_R, PHYS, SPEED } from './config.js';

const R = STONE_R;
const OUT_FADE = 0.9; // 秒: 場外になった石を消すまで

export function makeStone(o) {
  return {
    id: o.id, team: o.team, owner: o.owner ?? null,
    x: o.x, y: o.y, vx: o.vx || 0, vy: o.vy || 0,
    spin: o.spin || 0, angle: o.angle || 0,
    moving: !!(o.vx || o.vy),
    out: o.out || 0,     // 0 = 場内, それ以外 = 場外になってからの経過秒(+極小値)
    hit: !!o.hit,        // 一度でも衝突したか（ホッグライン判定用）
    sweep: !!o.sweep,
    cause: o.cause ?? (o.vx || o.vy ? o.id : null), // 現在の動きの原因となった投石ID
    rested: !!o.rested,  // 一度止まったか
    ox: 0, oy: 0,        // 描画用の補正オフセット
    born: o.born || 0,
  };
}

export class World {
  constructor() {
    this.stones = [];
    this.time = 0;
    this.acc = 0;
    this.listeners = {};
  }
  on(type, fn) { (this.listeners[type] ||= []).push(fn); }
  emit(type, data) { for (const fn of this.listeners[type] || []) fn(data); }

  add(s) { this.stones.push(s); return s; }
  get(id) { return this.stones.find(s => s.id === id); }
  clear() { this.stones = []; }
  inPlay() { return this.stones.filter(s => !s.out); }
  isSettled() { return this.stones.every(s => s.out || !s.moving); }

  // 経過時間を固定刻みで進める
  advance(dt) {
    this.acc += Math.min(dt, 2);
    let n = 0;
    // 刻み幅も速さの倍率に合わせる（どの倍率でも同じ回数の計算で同じ軌道になる）
    const h = PHYS.DT / SPEED.k;
    while (this.acc >= h && n < 4000) {
      this.step(h);
      this.acc -= h;
      n++;
    }
  }

  step(dt) {
    this.time += dt;
    for (const s of this.stones) integrate(s, dt);

    // 衝突
    const list = this.stones;
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      if (a.out) continue;
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j];
        if (b.out) continue;
        if (!a.moving && !b.moving) continue;
        collide(a, b, this);
      }
    }

    // 場外・停止判定
    for (const s of this.stones) {
      if (s.out) { s.out += dt; continue; }
      let reason = null;
      if (s.y - R < 0 || s.y + R > SHEET.W) reason = 'side';
      else if (s.x - R > SHEET.BACK_X) reason = 'back';
      else if (s.x + R < 0) reason = 'back';
      else if (!s.moving && !s.hit && s.x - R < SHEET.FAR_HOG) reason = 'hog';
      if (reason) {
        s.out = 1e-6;
        this.emit('out', { stone: s, reason });
      } else if (s._justRested) {
        const first = !s.rested;
        s.rested = true;
        this.emit('rest', { stone: s, first });
      }
      if (!s.moving) s.cause = null;
      s._justRested = false;
    }
    this.stones = this.stones.filter(s => !s.out || s.out < OUT_FADE);
  }
}

function integrate(s, dt) {
  if (!s.moving) return;
  const sp = Math.hypot(s.vx, s.vy);
  if (sp < 1e-3) { stop(s); return; }
  if (!s.out) {
    // カール: 進行方向に垂直な加速度（遅いほど大きい）→ 速度ベクトルの回転として適用
    // 速さ k 倍のときは「1倍換算の速さ」で計算し、加速度を k² 倍にする（軌道が同じになる）
    const k = SPEED.k, sb = sp / k;
    const aPerp = k * k * s.spin * PHYS.CURL_K * (1 + PHYS.CURL_V0 / (sb + 40)) * (s.sweep ? PHYS.SWEEP_CURL : 1);
    let w = aPerp / Math.max(sp, 1);
    w = Math.max(-2.5 * k, Math.min(2.5 * k, w));
    const c = Math.cos(w * dt), si = Math.sin(w * dt);
    const vx = s.vx * c - s.vy * si;
    s.vy = s.vx * si + s.vy * c;
    s.vx = vx;
  }
  const mu = PHYS.MU * SPEED.k * SPEED.k * (s.sweep ? PHYS.SWEEP_MU : 1) * (s.out ? 2.5 : 1);
  const ns = sp - mu * dt;
  if (ns <= 0) { stop(s); return; }
  s.vx *= ns / sp; s.vy *= ns / sp;
  s.x += s.vx * dt;
  s.y += s.vy * dt;
  s.angle += s.spin * 6 * SPEED.k * Math.min(1, ns / (250 * SPEED.k)) * dt;
}

function stop(s) {
  s.vx = 0; s.vy = 0;
  if (s.moving) {
    s.moving = false;
    s.sweep = false;
    s._justRested = true;
  }
}

function collide(a, b, world) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const d2 = dx * dx + dy * dy;
  if (d2 >= 4 * R * R || d2 === 0) return;
  const d = Math.sqrt(d2);
  const nx = dx / d, ny = dy / d;
  const rel = (a.vx - b.vx) * nx + (a.vy - b.vy) * ny;
  // めり込み解消
  const push = (2 * R - d) / 2;
  a.x -= nx * push; a.y -= ny * push;
  b.x += nx * push; b.y += ny * push;
  if (rel <= 0) return;
  const j = rel * (1 + PHYS.RESTITUTION) / 2;
  const spA = Math.hypot(a.vx, a.vy), spB = Math.hypot(b.vx, b.vy);
  a.vx -= j * nx; a.vy -= j * ny;
  b.vx += j * nx; b.vy += j * ny;
  a.moving = b.moving = true;
  a.hit = b.hit = true;
  a.spin *= 0.4; b.spin *= 0.4;
  // 速いほうの原因を伝播させる
  const cause = spA >= spB ? a.cause : b.cause;
  if (cause) { a.cause = cause; b.cause = cause; }
  world.emit('hit', { a, b, impulse: j, x: a.x + nx * R, y: a.y + ny * R });
}

// 衝突なしで単体の石を走らせる（ボットの狙い計算・遅延補正用）
export function runSolo(st, opts = {}) {
  const s = makeStone({ ...st, id: '_solo' });
  const dt = opts.dt || 1 / 120 / SPEED.k;
  const maxT = opts.maxT ?? 20 / SPEED.k;
  let t = 0;
  let crossY = null;
  const path = opts.path ? [{ x: s.x, y: s.y }] : null;   // 通り道の点（予測線用）
  while (s.moving && t < maxT) {
    const px = s.x, py = s.y;
    integrate(s, dt);
    t += dt;
    if (path) {
      const l = path[path.length - 1];
      if (Math.hypot(s.x - l.x, s.y - l.y) > 8 || !s.moving) path.push({ x: s.x, y: s.y });
    }
    if (opts.crossX != null && crossY == null && px < opts.crossX && s.x >= opts.crossX) {
      crossY = py + (s.y - py) * (opts.crossX - px) / (s.x - px);
    }
  }
  return { x: s.x, y: s.y, t, crossY, stone: s, path };
}

export function advanceSolo(stone, dt) {
  const step = PHYS.DT / SPEED.k;
  for (let t = 0; t < dt; t += step) integrate(stone, step);
}
