// 各プレイヤーのブラウザで動く表示・入力側。
// 非ホストは自前で物理を回して予測し、ホストのスナップショットで補正する。
import { SHEET, STONE_R, PHYS, RULES, SPEED, teamColor, teamName, powerToSpeed } from './config.js';
import { World, makeStone, runSolo } from './physics.js';
import { throwState, doneCount, deadlineFor, slotSec, isGuarding, isLastShot, judgeTime } from './rules.js';
import { decodeStone, normalizeGame } from './host.js';
import { Renderer, LANE } from './render.js';
import { sfx, unlockAudio } from './sfx.js';
import { startBgm, setBgmSlow, setBgmHush } from './bgm.js';

const R = STONE_R;
const MAX_DRAG = 280; // px
const FIG_X = SHEET.SPAWN_X - 50;
const WALK_SPEED = 240;   // 投げ終わった人がカーソルへ歩く速さ（ワールド単位/秒）

export class GameClient {
  constructor({ store, pid, canvas, onFinal, practice = false }) {
    this.practice = practice;   // ロビーの練習シート（BGM は触らない）
    this.store = store;
    this.pid = pid;
    this.canvas = canvas;
    this.snapScale = 1;   // ホストから届いたスローの倍率
    this.timeScale = 1;   // 今の時間の進む速さ
    this.slowAmt = 0;     // スロー演出の濃さ（0〜1、描画用）
    this.inSlow = false;
    this.onFinal = onFinal;
    this.renderer = new Renderer(canvas, { topBar: practice ? 0 : 40 });
    this.ownWorld = new World();
    this.world = this.ownWorld;
    this.host = null;
    this.meta = null; this.players = {}; this.game = null; this.aims = {}; this.sweeps = {};
    this.aim = { y: SHEET.CY, dragging: false, dx: 0, dy: 0, spin: 0, power: 0, angle: 0, valid: false, fine: false };
    this.figs = {};
    this.fx = { banners: [], particles: [], rings: [], shields: [], floats: [] };
    this.trails = new Map();
    this.myShots = [];          // 自分の投球の記録（軌跡＋投げた条件）。自分の画面だけに残す
    this.showShots = true;
    this.predictions = [];
    this.seenStones = new Set();
    this.previews = [];         // 冴えわたり（最後の一投の結果予測）。狙っている人ごと
    this.shake = 0;
    this.now = store.serverNow();
    this.pending = [];
    this.lastThrowAt = 0;
    this.lastPower = null;
    this.toast = null;
    this.sweepId = null;
    this.spaceDown = false;
    this.joinedAt = store.serverNow();
    this.hitSeen = new Map();
    this.unsubs = [];
    this.lastAimSent = 0;
    this.lastTick = 0;
    this.prevPhase = null;
    this.ownWorld.on('hit', e => this.onHit(e));
  }

  get pendingCount() { return this.pending.length; }

  setHost(host) {
    if (this.host) this.host.world.listeners.hit = (this.host.world.listeners.hit || []).filter(f => f !== this._hostHit);
    this.host = host;
    if (host) {
      this._hostHit = e => this.onHit(e);
      host.world.on('hit', this._hostHit);
      this.world = host.world;
    } else {
      this.ownWorld.stones = this.world.stones.map(s => ({ ...s }));
      this.world = this.ownWorld;
    }
  }

  start() {
    const s = this.store;
    this.unsubs.push(
      s.onValue('meta', v => { this.meta = v; }),
      s.onValue('players', v => { this.players = v || {}; }),
      s.onValue('game', v => this.onGame(v)),
      s.onValue('stones', v => this.onSnapshot(v)),
      s.onValue('aims', v => { this.aims = v || {}; }),
      s.onValue('sweeps', v => { this.sweeps = v || {}; }),
      s.onChildAdded('events', (k, v) => this.onEvent(v)),
    );
    this.bindInput();
    this.last = performance.now();
    const loop = () => {
      if (this.dead) return;
      this.frame();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  destroy() {
    this.dead = true;
    if (!this.practice) { if (this.inSlow) setBgmSlow(false); setBgmHush(false); }
    cancelAnimationFrame(this.raf);
    for (const u of this.unsubs) try { u(); } catch {}
    this.unbindInput();
    this.renderer.dispose();
    if (this.sweepId) this.store.set(`sweeps/${this.pid}`, null);
  }

  teamLabel(t) {
    if (t == null || t < 0) return '-';
    if ((this.meta?.settings?.mode || 'solo') === 'solo') {
      const pid = Object.keys(this.game?.roster || {}).find(p => this.game.roster[p] === t)
        || Object.keys(this.players).find(p => this.players[p].team === t);
      const n = pid && this.players[pid]?.name;
      if (n) return n;
    }
    return teamName(t);
  }
  hammerName() {
    const p = this.game?.hammerPid;
    return p ? (this.players[p]?.name || '?') : '-';
  }

  // ------------------------------------------------------------ 受信
  onGame(v) {
    const g = normalizeGame(v);
    const prev = this.game;
    this.game = g;
    if (!g) return;
    // 新しいエンド
    if (!prev || prev.end !== g.end) {
      this.pending = [];
      this.myShots = [];   // 自分の軌跡はエンドごとにリセット
      this.seenStones = new Set();
      this.trails.clear();
      this.fx.shields = [];
      if (!this.host) this.ownWorld.clear();
    }
    // ホストに届いた投球を pending から外す
    const done = doneCount(g, this.pid);
    this.pending = this.pending.filter(p => p.k > done && performance.now() - p.at < 3000);
    if (prev?.phase !== g.phase) {
      if (g.phase === 'result') sfx.score();
      if (g.phase === 'final' && this.onFinal) this.onFinal();
    }
  }

  onSnapshot(v) {
    if (this.host || !v) return;
    const lag = Math.max(0, Math.min(0.5, (this.store.serverNow() - (v.ts || 0)) / 1000));
    const temp = new World();
    temp.on('hit', e => this.onHit(e));
    const ids = new Set();
    for (const a of v.s || []) {
      const s = decodeStone(a);
      ids.add(s.id);
      temp.add(s);
    }
    const nowP = performance.now();
    for (const s of this.ownWorld.stones) {
      if (s.pending && !ids.has(s.id) && nowP - s.pendingAt < 2000) temp.add(s);
    }
    this.snapScale = v.sl || 1;
    temp.advance(lag * this.snapScale);
    for (const s of temp.stones) {
      const old = this.ownWorld.get(s.id);
      if (old && old !== s) {
        const ex = old.x + old.ox - s.x, ey = old.y + old.oy - s.y;
        if (Math.hypot(ex, ey) < 80) { s.ox = ex; s.oy = ey; }
      }
    }
    this.ownWorld.stones = temp.stones;
    this.ownWorld.acc = 0;
  }

  onEvent(e) {
    if (!e || e.t < this.joinedAt - 1500) return;
    const owner = this.players[e.owner]?.name || '';
    const col = teamColor(e.team);
    switch (e.type) {
      case 'takeout': {
        const names = ['', 'テイクアウト！', 'ダブルテイクアウト！！', 'トリプルテイクアウト！！！', 'クアドラプルテイクアウト！！！！'];
        const text = names[e.n] || `${e.n}連テイクアウト！！！！！`;
        this.banner({ key: 'to' + e.cause, text, sub: owner, color: col, size: 40 + Math.min(4, e.n) * 8, max: 2.2 + e.n * 0.3, anchor: { id: e.cause, x: e.x, y: e.y } });
        this.burst(e.x, e.y, teamColor(e.victim), 18 + e.n * 10, 900);
        this.fx.rings.push({ x: e.x, y: e.y, t: 0, max: 0.7, color: col, size: 90 + e.n * 30 });
        this.shake = Math.min(16, 5 + e.n * 3);
        sfx.tech(e.n);
        break;
      }
      case 'guard':
        this.banner({ key: 'g' + e.owner + e.t, text: 'ガードストーン！', sub: owner, color: col, size: 42, max: 2.4, anchor: { id: e.gid, x: e.x, y: e.y } });
        // 守りのマークは、ガードが成り立っている間ずっと表示する
        if (e.gid && e.sid && !this.fx.shields.some(s => s.gid === e.gid && s.sid === e.sid)) {
          this.fx.shields.push({ gid: e.gid, sid: e.sid, team: e.team, t: 0 });
        }
        this.fx.rings.push({ x: e.x, y: e.y, t: 0, max: 0.6, color: col, size: 50 });
        sfx.guard();
        break;
      case 'button':
        this.banner({ key: 'b' + e.t, text: 'ボタン！', sub: owner, color: col, size: 38, max: 1.8, anchor: { id: e.id, x: e.x, y: e.y } });
        this.fx.rings.push({ x: e.x, y: e.y, t: 0, max: 0.8, color: col, size: 70 });
        sfx.tech(0);
        break;
      case 'lost': {
        const f = this.figs[e.pid];
        if (f) this.fx.floats.push({ x: FIG_X + 60, y: f.homeY, text: '−1 STONE', color: '#E4572E', t: 0, max: 1.4, size: 13 });
        if (e.pid === this.pid) { this.showToast('時間切れ！ 石が1つ消えた'); sfx.lost(); }
        break;
      }
      case 'hammer':
        this.banner({
          key: 'h' + e.t, text: 'ハンマータイム', sub: this.players[e.pid]?.name || '',
          note: '冴えわたり：狙っている間、投げた結果が予測で見える', color: col, size: 44, max: 4,
        });
        if (e.pid === this.pid) {
          this.showToast(`最後の一投！ 引いて狙うと結果の予測が見える（${(this.game?.interval || 10) * RULES.HAMMER_TIME}秒以内）`);
          this.toast.max = 5;
        }
        sfx.go();
        break;
      case 'steal':
        this.banner({
          key: 'st' + e.t, text: 'スティール！！', sub: `${this.teamLabel(e.team)}  +${e.points}`,
          note: 'ハンマーを持たないチームが得点', color: col, size: 50, max: 3.4,
        });
        this.shake = Math.max(this.shake, 8);
        sfx.tech(3);
        break;
      case 'bigend':
        this.banner({
          key: 'be' + e.t, text: 'ビッグエンド！！！', sub: `${this.teamLabel(e.team)}  +${e.points}`,
          note: `1エンドで${RULES.BIG_END}点以上の大量得点`, color: col, size: 54, max: 3.6,
        });
        this.shake = Math.max(this.shake, 12);
        this.bigBurst(col);
        sfx.tech(5);
        break;
      case 'skip':
        // 全員投げ終えて待ち時間をつめた: 各自のタイマーの横に「−◯s」を出す
        if (e.sec >= 2) this.fx.skip = { sec: e.sec, t: 0, max: 2.4 };
        break;
      case 'reject':
        if (e.pid === this.pid) {
          this.pending = this.pending.filter(p => p.id !== e.id);
          this.ownWorld.stones = this.ownWorld.stones.filter(s => s.id !== e.id);
          this.showToast(e.why === 'late' || e.why === 'done' ? '時間切れ — この投球は無効' : '投球が受け付けられませんでした');
        }
        break;
    }
  }

  banner(b) {
    const i = this.fx.banners.findIndex(x => x.key === b.key);
    const item = { ...b, t: 0 };
    if (i >= 0) this.fx.banners[i] = item; else this.fx.banners.push(item);
    if (this.fx.banners.length > 3) this.fx.banners.shift();
  }
  showToast(text) { this.toast = { text, t: 0, max: 2.2 }; }

  // 投げる音の和音: 参加順に割り当てる（重なってもきれいに響くよう sfx 側で選んである）
  voiceFor(pid) {
    const ids = Object.keys(this.players).sort((a, b) => (this.players[a].joinedAt || 0) - (this.players[b].joinedAt || 0));
    return Math.max(0, ids.indexOf(pid));
  }

  // 他の人の石が投げられたら控えめに鳴らす（自分の石は投げた瞬間に鳴らしている）
  soundNewStones() {
    for (const s of this.world.stones) {
      if (this.seenStones.has(s.id)) continue;
      this.seenStones.add(s.id);
      if (s.owner && s.owner !== this.pid && s.moving && !s.out) sfx.throw(0.6, this.voiceFor(s.owner));
    }
  }

  // ビッグエンド用: ハウス全体に何度も弾ける
  bigBurst(color) {
    for (let i = 0; i < 6; i++) {
      setTimeout(() => {
        const a = Math.random() * Math.PI * 2, r = Math.random() * SHEET.HOUSE_R;
        const x = SHEET.TEE_X + Math.cos(a) * r, y = SHEET.CY + Math.sin(a) * r;
        this.burst(x, y, color, 30, 1100);
        this.fx.rings.push({ x, y, t: 0, max: 0.8, color, size: 160 });
      }, i * 140);
    }
  }

  burst(x, y, color, n, speed) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, v = speed * (0.3 + Math.random() * 0.7);
      this.fx.particles.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, t: 0, max: 0.4 + Math.random() * 0.5, color: Math.random() < 0.5 ? color : '#141414', kind: Math.random() < 0.6 ? 'spark' : 'dot', size: 3 + Math.random() * 4 });
    }
  }

  onHit(e) {
    const key = [e.a.id, e.b.id].sort().join('|');
    const t = performance.now();
    if (t - (this.hitSeen.get(key) || 0) < 250) return;
    this.hitSeen.set(key, t);
    const imp = e.impulse / SPEED.k; // 速さの倍率に関係なく同じ強さの演出に
    if (imp < 15) return;
    const p = Math.min(1, imp / 700);
    this.burst(e.x, e.y, '#141414', Math.round(4 + p * 14), 200 + p * 500);
    this.fx.rings.push({ x: e.x, y: e.y, t: 0, max: 0.35, color: '#141414', size: 20 + p * 40 });
    this.shake = Math.max(this.shake, p * 7);
    sfx.hit(imp, this.inSlow);
  }

  // ------------------------------------------------------------ 入力
  bindInput() {
    const cv = this.canvas;
    this.h = {
      move: e => this.onPointerMove(e),
      down: e => this.onPointerDown(e),
      up: e => this.onPointerUp(e),
      wheel: e => { e.preventDefault(); this.adjustSpin(e.deltaY > 0 ? -0.05 : 0.05, e.shiftKey); },
      ctx: e => { e.preventDefault(); this.cancelDrag(); },
      key: e => this.onKey(e, true),
      keyup: e => this.onKey(e, false),
      blur: () => { this.setSweep(false); this.cancelDrag(); },
    };
    cv.addEventListener('pointermove', this.h.move);
    cv.addEventListener('pointerdown', this.h.down);
    cv.addEventListener('pointerup', this.h.up);
    cv.addEventListener('pointercancel', this.h.ctx);
    cv.addEventListener('wheel', this.h.wheel, { passive: false });
    cv.addEventListener('contextmenu', this.h.ctx);
    addEventListener('keydown', this.h.key);
    addEventListener('keyup', this.h.keyup);
    addEventListener('blur', this.h.blur);
    this.setupTouch();
  }
  unbindInput() {
    const cv = this.canvas;
    if (!this.h) return;
    cv.removeEventListener('pointermove', this.h.move);
    cv.removeEventListener('pointerdown', this.h.down);
    cv.removeEventListener('pointerup', this.h.up);
    cv.removeEventListener('pointercancel', this.h.ctx);
    cv.removeEventListener('wheel', this.h.wheel);
    cv.removeEventListener('contextmenu', this.h.ctx);
    removeEventListener('keydown', this.h.key);
    removeEventListener('keyup', this.h.keyup);
    removeEventListener('blur', this.h.blur);
    clearInterval(this.touchRepeat);
    this.touchEl?.remove();
    this.touchEl = null;
  }

  // ------------------------------------------------------------ スマホ（タッチ）用の操作
  // 回転（↺ ↻、長押しで連続。まん中を押すと 0 に戻す）・スイープ（押している間）・軌跡の表示をボタンで。
  // 位置は、投げる位置のあたりを押して横になぞると動く
  setupTouch() {
    const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
    if (!coarse && !(navigator.maxTouchPoints > 0)) return;
    this.touch = true;
    const el = document.createElement('div');
    el.className = 'touch-ctl';
    el.innerHTML = `
      <div class="tc-spin">
        <button data-k="spinL" aria-label="左に曲がる回転">↺</button>
        <button data-k="spin0" class="tc-val" aria-label="回転を0に">0</button>
        <button data-k="spinR" aria-label="右に曲がる回転">↻</button>
        <button data-k="trail" class="tc-small">軌跡</button>
      </div>
      <button data-k="sweep" class="tc-sweep">SWEEP</button>`;
    this.canvas.parentElement.appendChild(el);
    this.touchEl = el;
    this.renderer.padBottom = 64;
    this.renderer.resize();
    const stop = () => { clearInterval(this.touchRepeat); clearTimeout(this.touchRepeat); this.touchRepeat = null; };
    const act = k => {
      if (k === 'spinL') this.adjustSpin(-0.1);
      else if (k === 'spinR') this.adjustSpin(0.1);
      else if (k === 'spin0') this.aim.spin = 0;
      else if (k === 'trail') { this.showShots = !this.showShots; this.showToast(this.showShots ? '自分の軌跡: 表示' : '自分の軌跡: 非表示'); }
    };
    for (const b of el.querySelectorAll('button')) {
      const k = b.dataset.k;
      b.addEventListener('contextmenu', e => e.preventDefault());
      b.addEventListener('pointerdown', e => {
        e.preventDefault();
        unlockAudio();
        try { b.setPointerCapture?.(e.pointerId); } catch {}
        if (k === 'sweep') { this.setSweep(true); b.classList.add('on'); return; }
        act(k);
        // 回転は長押しで続けて変わる
        if (k === 'spinL' || k === 'spinR') {
          stop();
          this.touchRepeat = setTimeout(() => { this.touchRepeat = setInterval(() => act(k), 90); }, 350);
        }
      });
      const up = () => { if (k === 'sweep') { this.setSweep(false); b.classList.remove('on'); } else stop(); };
      b.addEventListener('pointerup', up);
      b.addEventListener('pointercancel', up);
    }
  }

  // タッチ用ボタンの表示を今の状態に合わせる（回転の値・縦長画面では下の HUD の上に置く）
  updateTouch() {
    const el = this.touchEl;
    if (!el) return;
    const sp = Math.round(this.aim.spin * 100);
    const txt = sp === 0 ? '0' : (sp > 0 ? '↻' : '↺') + Math.abs(sp);
    const v = el.querySelector('.tc-val');
    if (v.textContent !== txt) v.textContent = txt;
    // 縦長画面: 下の HUD のすぐ上（空けてある場所）。横長画面: 右下にまとめる
    el.classList.toggle('land', this.renderer.land);
    el.classList.toggle('mobile', !!this.renderer.mobile);
    el.hidden = this.game?.roster?.[this.pid] == null;
  }

  clampY(y) { return Math.max(R + 3, Math.min(SHEET.W - R - 3, y)); }

  onPointerMove(e) {
    const a = this.aim;
    this.cursor = this.renderer.toWorld(e.clientX, e.clientY);   // 投げ終わった後、自分の人間が歩いていく先
    if (e.pointerType !== 'mouse') {
      if (this.placing) { a.y = this.clampY(this.cursor.y); return; }
      // 投げる位置のあたりで押して、最初に横へ動いたら「位置を動かす」に切りかえる
      if (a.dragging && a.touchZone && !a.decided) {
        const mx = e.clientX - a.pressX, my = e.clientY - a.pressY;
        if (Math.hypot(mx, my) > 10) {
          a.decided = true;
          if (Math.abs(mx) > Math.abs(my) * 1.2) { a.dragging = false; this.placing = true; a.y = this.clampY(this.cursor.y); return; }
        }
      }
      if (!a.dragging) return;   // タッチはホバーがないので、押していないときは位置を動かさない
    }
    if (a.dragging) {
      const k = e.shiftKey ? 0.25 : 1;
      a.fine = e.shiftKey;
      a.dx += (e.clientX - this.px) * k;
      a.dy += (e.clientY - this.py) * k;
      this.px = e.clientX; this.py = e.clientY;
      this.updateDrag();
      return;
    }
    this.px = e.clientX; this.py = e.clientY;
    if (this.keyLock) {
      this.keyLockMove += Math.abs(e.movementY || 0) + Math.abs(e.movementX || 0);
      if (this.keyLockMove < 40) return;
      this.keyLock = false;
    }
    const w = this.renderer.toWorld(e.clientX, e.clientY);
    a.y = this.clampY(w.y);
  }

  onPointerDown(e) {
    unlockAudio();
    if (e.button !== 0) { this.cancelDrag(); return; }
    const g = this.game;
    if (!g || g.roster?.[this.pid] == null) return;
    try { this.canvas.setPointerCapture?.(e.pointerId); } catch {}
    this.setSweep(false);
    // タッチで投げる位置のあたり（シートの手前の端より下）を押したら、横になぞって位置を動かせる
    const touchZone = e.pointerType !== 'mouse' && this.renderer.toWorld(e.clientX, e.clientY).x < SHEET.SPAWN_X + R * 2.5;
    Object.assign(this.aim, { touchZone, decided: false, dragging: true, dx: 0, dy: 0, valid: false, power: 0, pressX: e.clientX, pressY: e.clientY, pressAt: this.store.serverNow(),
      pressT: performance.now(), seed: [0, 1, 2, 3].map(() => Math.random() * Math.PI * 2) });
    this.px = e.clientX; this.py = e.clientY;
  }

  onPointerUp(e) {
    const a = this.aim;
    if (this.placing) { this.placing = false; return; }
    if (!a.dragging) return;
    a.dragging = false;
    if (a.valid) this.tryThrow();
  }

  cancelDrag() { this.aim.dragging = false; this.placing = false; }

  updateDrag() {
    const a = this.aim;
    // 画面は縦向き（ワールド +x = 画面の上、+y = 画面の右）。
    // 下に引くと上へ、左に引くと右へ飛ぶ（引いた向きの反対）
    const px = a.dy, py = -a.dx;
    a.valid = px > 6;
    let ang = Math.atan2(py, px);
    ang = Math.max(-PHYS.MAX_ANGLE, Math.min(PHYS.MAX_ANGLE, ang));
    a.baseAngle = a.angle = ang;
    a.basePower = a.power = Math.min(1, Math.hypot(px, py) / MAX_DRAG);
    this.applyShake();
  }

  // 自分の最後の一投（冴えわたりが出る一投）を狙っているところか
  isMyLastShot() {
    const g = this.game, ms = this.myState;
    return !this.practice && !!g && !!ms?.ok && isLastShot(g, this.pid, ms.done);
  }

  // 最後の一投の手ブレ: 狙い（base）のまわりで向きと強さが揺れる。離した瞬間の値で投げる
  // 心臓は AIM_BEAT_MS ごとに鳴り（押してから半分たったところが最初）、その前後 AIM_SHAKE_WINDOW の間だけ揺れる
  applyShake() {
    const a = this.aim;
    if (!a.dragging || !a.valid || a.baseAngle == null || !this.isMyLastShot()) { a.shake = null; return; }
    const t = performance.now();
    const hold = (t - (a.pressT || t)) / 1000;
    const P = RULES.AIM_BEAT_MS, W = RULES.AIM_SHAKE_WINDOW;
    const ph = (((t - (a.pressT || t) - P / 2) % P) + P) % P;   // 鼓動からの経過 ms（0 = 鼓動の瞬間）
    const near = Math.min(ph, P - ph);                         // いちばん近い鼓動までの ms
    const amp = near < W ? Math.cos(near / W * Math.PI / 2) : 0;   // 鼓動の瞬間が最大、窓の外は 0
    a.beatPhase = ph / P;
    const [s1, s2, s3, s4] = a.seed || [0, 1, 2, 3];
    const na = Math.sin(hold * 7.3 + s1) * 0.6 + Math.sin(hold * 12.9 + s2) * 0.4;
    const np = Math.sin(hold * 5.1 + s3) * 0.6 + Math.sin(hold * 10.7 + s4) * 0.4;
    a.shake = amp;
    a.angle = Math.max(-PHYS.MAX_ANGLE, Math.min(PHYS.MAX_ANGLE, a.baseAngle + na * amp * RULES.AIM_SHAKE_ANGLE));
    a.power = Math.max(0, Math.min(1, a.basePower + np * amp * RULES.AIM_SHAKE_POWER));
  }

  adjustSpin(d, fine) {
    const s = this.aim.spin + (fine ? d / 5 : d);
    this.aim.spin = Math.max(-1, Math.min(1, Math.round(s * 100) / 100));
  }

  onKey(e, down) {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT')) return;
    if (document.getElementById('manual')?.open) return;   // 説明書を読んでいる間は操作しない
    const k = e.key.toLowerCase();
    if (k === ' ') { e.preventDefault(); unlockAudio(); this.setSweep(down); return; }
    if (!down) return;
    if (k === 'q') this.adjustSpin(-0.05, e.shiftKey);
    else if (k === 'e') this.adjustSpin(0.05, e.shiftKey);
    else if (k === 'r') this.aim.spin = 0;
    else if (k === 't') { this.showShots = !this.showShots; this.showToast(this.showShots ? '自分の軌跡: 表示' : '自分の軌跡: 非表示'); }
    else if (k === 'a' || k === 'arrowleft' || k === 'd' || k === 'arrowright') {
      e.preventDefault();
      const d = (k === 'a' || k === 'arrowleft') ? -1 : 1;
      this.aim.y = this.clampY(this.aim.y + d * (e.shiftKey ? 5 : 1));
      this.keyLock = true; this.keyLockMove = 0;
    } else if (k === 'escape') this.cancelDrag();
  }

  setSweep(on) {
    this.spaceDown = on;
    let id = null;
    if (on) {
      // 自分の最新の動いている石
      const mine = this.world.stones.filter(s => s.owner === this.pid && s.moving && !s.out);
      mine.sort((a, b) => (b.born || 0) - (a.born || 0));
      id = mine[0]?.id || null;
    }
    if (id !== this.sweepId) {
      this.sweepId = id;
      this.store.set(`sweeps/${this.pid}`, id);
    }
  }

  tryThrow() {
    const g = this.game;
    const now = this.store.serverNow();
    const st = throwState(g, this.pid, now, this.pending.length);
    if (!st.ok) {
      const msg = { countdown: 'まだカウントダウン中', done: 'このエンドの石は投げ終わった', hammer: 'ハンマーの最後の一投は全員が投げ終わってから', spectator: '観戦中' }[st.why];
      if (msg) this.showToast(msg);
      return;
    }
    if (judgeTime(st.deadline, now, this.aim.pressAt) > st.deadline) { this.showToast('時間切れ — 次の石の期限を待って'); return; }
    if (performance.now() - this.lastThrowAt < RULES.THROW_COOLDOWN) { this.showToast('連投は少し間をあけて'); return; }
    const y = this.aim.y;
    if (this.world.stones.some(s => !s.out && Math.hypot(s.x - SHEET.SPAWN_X, s.y - y) < R * 2.2)) {
      this.showToast('リリース位置がふさがっている'); return;
    }
    const a = this.aim;
    const speed = powerToSpeed(a.power);
    const vx = Math.cos(a.angle) * speed, vy = Math.sin(a.angle) * speed;
    const k = st.done + 1;
    const id = `${this.pid}_${g.end}_${k}`;
    this.store.push('throws', { id, pid: this.pid, y, vx, vy, spin: a.spin, t: now, p: Math.round(a.pressAt || now) });
    this.pending.push({ id, k, at: performance.now() });
    this.lastThrowAt = performance.now();
    this.lastPower = a.power;
    this.recordShot(id, g.end, k, y, a);
    if (!this.host) {
      const s = makeStone({ id, team: g.roster[this.pid], owner: this.pid, x: SHEET.SPAWN_X, y, vx, vy, spin: a.spin, born: now });
      s.pending = true; s.pendingAt = performance.now();
      this.ownWorld.add(s);
    }
    const f = this.figs[this.pid];
    if (f) f.lungeT = 0;
    sfx.throw(1, this.voiceFor(this.pid));
  }

  // ------------------------------------------------------------ フレーム
  frame() {
    const t = performance.now();
    const dt = Math.min(0.1, (t - this.last) / 1000);
    this.last = t;
    this.now = this.store.serverNow();
    const g = this.game;

    this.updateSlow(dt);
    if (!this.host) {
      // スイープ状態をローカルにも反映
      const sw = new Set(Object.values(this.sweeps || {}).filter(Boolean));
      if (this.sweepId) sw.add(this.sweepId);
      for (const s of this.ownWorld.stones) s.sweep = s.moving && !s.out && sw.has(s.id);
      this.ownWorld.advance(dt * this.timeScale);
    }
    // スイープ対象が止まったら解除、Space 押しっぱなしで次の石に切り替え
    if (this.sweepId) {
      const s = this.world.get(this.sweepId);
      if (!s || !s.moving || s.out) this.setSweep(this.spaceDown);
    } else if (this.spaceDown) this.setSweep(true);
    if (this.sweepId && Math.random() < dt * 9) sfx.sweep();

    // 描画オフセットの減衰
    const k = Math.exp(-dt * 8);
    for (const s of this.world.stones) { s.ox *= k; s.oy *= k; }

    // 軌跡
    for (const s of this.world.stones) {
      let tr = this.trails.get(s.id);
      if (s.moving && !s.out) {
        if (!tr) this.trails.set(s.id, tr = []);
        tr.push({ x: s.x + s.ox, y: s.y + s.oy });
        if (tr.length > 28) tr.shift();
      } else if (tr) {
        tr.shift();
        if (!tr.length) this.trails.delete(s.id);
      }
    }
    for (const id of this.trails.keys()) if (!this.world.get(id)) this.trails.delete(id);

    this.myState = g ? throwState(g, this.pid, this.now, this.pending.length) : null;
    this.applyShake();
    this.updateShots();
    this.updatePredictions();
    this.updateLastShotPreviews();
    this.soundNewStones();
    this.updateFigures(dt);
    this.updateFx(dt);
    this.sendAim(t);
    this.tickSounds();
    this.updateTouch();
    this.renderer.draw(this);
  }

  tickSounds() {
    const g = this.game;
    if (!g || g.phase !== 'play') return;
    if (this.now < g.endStartAt) {
      const sec = Math.ceil((g.endStartAt - this.now) / 1000 - 0.5);
      if (sec !== this.lastCount) { this.lastCount = sec; if (sec > 0 && sec <= 3) sfx.count(); else if (sec === 0) sfx.go(); }
      if (sec > 0) return;
    }
    // BGM は「3, 2, 1, GO」の GO から（途中から入った人もここで流れ始める。流れていれば何もしない）
    if (!this.practice) startBgm();
    if (this.now < g.endStartAt) return;
    const ms = this.myState;
    if (ms?.ok && ms.deadline !== Infinity) {
      const rem = Math.ceil((ms.deadline - this.now) / 1000);
      if (rem !== this.lastWarn && rem <= 3 && rem >= 1) sfx.tick();
      this.lastWarn = rem;
    }
  }

  sendAim(t) {
    if (t - this.lastAimSent < 110) return;
    if (this.game?.roster?.[this.pid] == null) return;
    const a = this.aim;
    const v = { y: Math.round(a.y * 10) / 10, a: Math.round(a.angle * 1000) / 1000, p: Math.round(a.power * 1000) / 1000, s: a.spin, d: a.dragging ? 1 : 0, v: a.dragging && a.valid ? 1 : 0 };
    if (a.dragging && a.pressAt) v.h = Math.round(a.pressAt);
    const w = this.walkTarget(this.pid);
    if (w) v.w = [Math.round(w.x), Math.round(w.y)];
    const key = JSON.stringify(v);
    if (key === this.lastAimKey) return;
    this.lastAimKey = key;
    this.lastAimSent = t;
    this.store.set(`aims/${this.pid}`, v);
  }

  // ------------------------------------------------------------ 自分の投球の記録
  recordShot(id, end, n, y, a) {
    this.myShots.push({
      id, end, n,                            // n = そのエンドで何投目か
      x0: SHEET.SPAWN_X, y0: y, angle: a.angle, power: a.power, spin: a.spin,
      pts: [{ x: SHEET.SPAWN_X, y, sw: false }],
      swept: false, done: false, out: false, at: performance.now(),
    });
  }

  // 自分の動いている石の予測線: 「今スイープをやめたら」どこを通ってどこに止まるか（他の石との衝突は考えない）
  updatePredictions() {
    this.predictions = [];
    if (this.game?.phase !== 'play') return;
    for (const s of this.world.stones) {
      // 何かに当たった後は他の石の影響で当たらないので出さない
      if (s.owner !== this.pid || !s.moving || s.out || s.hit) continue;
      const r = runSolo({ x: s.x + s.ox, y: s.y + s.oy, vx: s.vx, vy: s.vy, spin: s.spin, angle: s.angle, sweep: false }, { path: true });
      this.predictions.push({ id: s.id, team: s.team, path: r.path, x: r.x, y: r.y });
    }
  }

  // ハンマーの最後の一投: 狙っている間、他の石との衝突も含めて「投げたらどうなるか」を丸ごと計算する
  // 冴えわたり: 最後の一投（各プレイヤーの最後の石）を狙っている人の結果予測。
  // 自分の分も他の人の分も、届いた狙いから各自の画面で同じ計算をして全員に見せる
  updateLastShotPreviews() {
    const g = this.game;
    const aiming = {};
    if (g && g.phase === 'play' && this.now >= g.endStartAt) {
      for (const pid of Object.keys(g.roster || {})) {
        if (pid === this.pid) {
          const me = this.aim, ms = this.myState;
          if (ms?.ok && ms.done === g.stones - 1 && me.dragging && me.valid) {
            aiming[pid] = { y: me.y, angle: me.angle, power: me.power, spin: me.spin };
          }
        } else {
          const r = this.aims[pid];
          if (r?.d && r?.v && isLastShot(g, pid, doneCount(g, pid))) {
            aiming[pid] = { y: r.y, angle: r.a || 0, power: r.p || 0, spin: r.s || 0 };
          }
        }
      }
    }
    const cache = (this.previewCache ||= {});
    const t = performance.now();
    const moving = !this.world.isSettled();
    const out = [];
    for (const [pid, a] of Object.entries(aiming)) {
      const key = [a.y.toFixed(1), a.angle.toFixed(4), a.power.toFixed(4), a.spin].join('|');
      const cur = cache[pid];
      // 狙いが変わったとき、または盤面が動いている間は定期的に計算し直す
      const stale = !cur || cur.key !== key || (moving && t - cur.at > 150);
      if (stale && (!cur || t - cur.at >= 60)) cache[pid] = { key, at: t, data: this.simulateShot(pid, a) };
      if (cache[pid]) out.push(cache[pid].data);
    }
    for (const pid of Object.keys(cache)) if (!aiming[pid]) delete cache[pid];
    this.previews = out;
  }

  // pid が狙い a で投げたら、他の石との衝突も含めてどうなるかを本物と同じ物理で最後まで計算する
  simulateShot(pid, a) {
    const g = this.game;
    // いまの盤面を複製し、自分の石を足して、全部止まるまで本物と同じ物理で進める
    const w = new World();
    const before = new Map();
    for (const s of this.world.stones) {
      if (s.out) continue;
      const cp = makeStone({ ...s, ox: 0, oy: 0 });
      cp.x = s.x; cp.y = s.y; cp.moving = s.moving; cp.hit = s.hit; cp.rested = s.rested;
      w.add(cp);
      before.set(s.id, { x: s.x, y: s.y });
    }
    const speed = powerToSpeed(a.power);
    const mine = w.add(makeStone({
      id: '_shot', team: g.roster[pid], owner: pid, x: SHEET.SPAWN_X, y: a.y,
      vx: Math.cos(a.angle) * speed, vy: Math.sin(a.angle) * speed, spin: a.spin,
    }));
    const paths = new Map([[mine.id, { team: mine.team, mine: true, pts: [{ x: mine.x, y: mine.y }] }]]);
    const outs = new Map();
    w.on('out', e => outs.set(e.stone.id, { x: e.stone.x, y: e.stone.y }));
    const h = PHYS.DT / SPEED.k;
    const maxSteps = Math.ceil(25 / SPEED.k / h);
    for (let i = 0; i < maxSteps; i++) {
      w.step(h);
      for (const s of w.stones) {
        if (!s.moving || s.out) continue;
        let p = paths.get(s.id);
        if (!p) {
          const b0 = before.get(s.id);
          paths.set(s.id, p = { team: s.team, mine: false, pts: [b0 ? { ...b0 } : { x: s.x, y: s.y }] });
        }
        const l = p.pts[p.pts.length - 1];
        if (Math.hypot(s.x - l.x, s.y - l.y) > 6) p.pts.push({ x: s.x, y: s.y });
      }
      if (w.isSettled() && i > 10) break;
    }
    // 最終位置（場外に出た石は × の位置）
    const finals = [];
    for (const [id, p] of paths) {
      const s = w.get(id);
      const o = outs.get(id);
      const end = o || (s ? { x: s.x, y: s.y } : p.pts[p.pts.length - 1]);
      p.pts.push(end);
      finals.push({ id, team: p.team, mine: p.mine, x: end.x, y: end.y, out: !!o });
    }
    return { pid, team: g.roster[pid], paths: [...paths.values()], finals };
  }

  updateShots() {
    for (const r of this.myShots) {
      if (r.done) continue;
      const s = this.world.get(r.id);
      const last = r.pts[r.pts.length - 1];
      if (!s) {
        // 少し待っても現れない（無効になった）か、場外で消えた
        if (r.pts.length > 1 || performance.now() - r.at > 2500) { r.done = true; r.out = r.out || r.pts.length > 1; }
        continue;
      }
      const x = s.x + s.ox, y = s.y + s.oy;
      if (s.sweep) r.swept = true;
      if (Math.hypot(x - last.x, y - last.y) > 6 || (!s.moving && (x !== last.x || y !== last.y))) {
        if (r.pts.length < 800) r.pts.push({ x, y, sw: !!s.sweep });
      }
      if (s.out) { r.out = true; r.done = true; }
      else if (!s.moving && r.pts.length > 1) r.done = true;
    }
  }

  // 自分の石を全部投げ終えた人の歩く先（自分はカーソル、他の人は送られてきた位置）。なければ null
  walkTarget(pid) {
    const g = this.game;
    if (!g || g.phase !== 'play' || g.roster?.[pid] == null) return null;
    const w = this.aims[pid]?.w;
    // 練習シートでは、いつでもカーソルについて歩く
    if (this.practice) return pid === this.pid ? (this.cursor || null) : (w ? { x: w[0], y: w[1] } : null);
    if (pid === this.pid) return this.myState?.why === 'done' && this.cursor ? this.cursor : null;
    // 前のエンドの行き先が残っていても、そのエンドを投げ終えるまでは歩かない
    return w && doneCount(g, pid) >= g.stones ? { x: w[0], y: w[1] } : null;
  }

  // 一定の速さで (tx, ty) へ歩く。向きは進む方向へなめらかに回し、止まったら足をそろえる
  walkFig(f, tx, ty, dt) {
    const dx = tx - f.x, dy = ty - f.y, d = Math.hypot(dx, dy);
    const moving = d > 12;
    if (moving) {
      const st = Math.min(d, WALK_SPEED * dt);
      f.x += dx / d * st; f.y += dy / d * st;
      f.step = (f.step || 0) + st;
      const want = Math.atan2(dy, dx);
      let diff = want - (f.dir || 0);
      diff = Math.atan2(Math.sin(diff), Math.cos(diff));
      f.dir = (f.dir || 0) + diff * (1 - Math.exp(-dt * 10));
    }
    f.walkAmp = (f.walkAmp || 0) + ((moving ? 1 : 0) - (f.walkAmp || 0)) * (1 - Math.exp(-dt * 8));
    f.pose = 'walk';
  }

  updateFigures(dt) {
    const g = this.game;
    const ids = g?.roster ? Object.keys(g.roster) : Object.keys(this.players);
    const live = new Set(ids);
    for (const id of Object.keys(this.figs)) if (!live.has(id)) delete this.figs[id];
    for (const pid of ids) {
      const homeY = pid === this.pid ? this.aim.y : (this.aims[pid]?.y ?? SHEET.CY);
      const f = (this.figs[pid] ||= { x: FIG_X, y: homeY, homeY, pose: 'aim', lunge: 0, lungeT: 9 });
      f.homeY = homeY;
      const sid = pid === this.pid ? this.sweepId : this.sweeps[pid];
      const s = sid && this.world.get(sid);
      let tx = FIG_X, ty = homeY;
      const wt = this.walkTarget(pid);
      if (s && s.moving && !s.out) {
        f.pose = 'sweep';
        f.away = true;
        f.dir = 0;
        f.side = s.y > SHEET.CY ? 1 : -1;
        tx = s.x + s.ox - 28;
        ty = s.y + s.oy + f.side * 42;
      } else if (wt) {
        // 投げ終わったら、カーソルへ一定の速さで歩いていく（着いたら立ち止まる）
        f.away = true;
        this.walkFig(f, wt.x, wt.y, dt);
        continue;
      } else if (f.away) {
        // 持ち場（投げる位置の横）へ歩いて戻る
        if (Math.hypot(f.x - FIG_X, f.y - homeY) > 24) { this.walkFig(f, FIG_X, homeY, dt); continue; }
        f.away = false;
      }
      if (!(s && s.moving && !s.out)) { f.pose = 'aim'; f.dir = 0; }
      const follow = f.pose === 'sweep' ? 1 - Math.exp(-dt * 14) : 1 - Math.exp(-dt * 10);
      f.x += (tx - f.x) * follow;
      f.y += (ty - f.y) * follow;
      f.lungeT = (f.lungeT ?? 9) + dt;
      f.lunge = f.lungeT < 0.15 ? f.lungeT / 0.15 : Math.max(0, 1 - (f.lungeT - 0.15) / 0.5);
    }
    // 左レーンのラベルが重ならないように並べる
    const list = Object.values(this.figs).sort((a, b) => a.homeY - b.homeY);
    const gap = Math.min(LANE.slot / this.renderer.scale, SHEET.W / Math.max(1, list.length));
    let prev = -Infinity;
    for (const f of list) { f.slotY = Math.max(f.homeY, prev + gap); prev = f.slotY; }
    let next = Infinity;
    for (let i = list.length - 1; i >= 0; i--) {
      const f = list[i];
      f.slotY = Math.min(f.slotY, SHEET.W - 14, next - gap);
      next = f.slotY;
    }
    for (const f of list) f.labelY = f.labelY == null ? f.slotY : f.labelY + (f.slotY - f.labelY) * (1 - Math.exp(-dt * 12));
  }

  // ハンマーのスロー演出: 倍率はホストが決める。入る・出るときに音と BGM を変える
  updateSlow(dt) {
    // ハンマータイム（最後の一投を考えている間）から BGM を消し、投げた石が全部止まったら戻す
    const g = this.game;
    const hp = g?.hammerPid;
    let hush = false;
    let beatLeft = null;   // 心臓の音を鳴らすときの残り時間の割合
    if (g?.phase === 'play' && hp && g.hammerUnlockAt) {
      const thrown = doneCount(g, hp) + (hp === this.pid ? this.pending.length : 0) >= g.stones;
      const stone = this.world.get(`${hp}_${g.end}_${g.stones}`);
      hush = !(thrown && stone && this.world.isSettled());   // 石がまだ届いていないうちは戻さない
      // 投げるまでは心臓の音「ドックン」。残り時間が減るほど速くなる
      if (!thrown) beatLeft = Math.max(0, Math.min(1, (deadlineFor(g, hp, g.stones) - this.now) / (slotSec(g, hp, g.stones) * 1000)));
    }
    const t = performance.now();
    const a = this.aim;
    if (a.dragging && this.isMyLastShot()) {
      // 自分の最後の一投を引いている間は、手ブレと同じリズム（AIM_BEAT_MS ごと）で鳴らす
      if (a.beatAt == null || a.beatFor !== a.pressT) { a.beatFor = a.pressT; a.beatAt = a.pressT + RULES.AIM_BEAT_MS / 2; }
      if (t >= a.beatAt) { sfx.heart(); a.beatAt += RULES.AIM_BEAT_MS; }
      this.nextBeat = t + 400;   // 離したあと、ハンマーの鼓動がすぐ重ならないように
    } else if (beatLeft != null && t >= (this.nextBeat || 0)) {
      sfx.heart();
      this.nextBeat = t + 520 + 480 * beatLeft;   // 約60 → 115 拍/分
    }
    if (!this.practice) setBgmHush(hush);
    const ts = this.host ? this.host.timeScale : (this.world.isSettled() ? 1 : this.snapScale);
    this.timeScale = ts;
    const want = Math.max(0, Math.min(1, (1 - ts) / 0.7));
    this.slowAmt += (want - this.slowAmt) * (1 - Math.exp(-dt * 8));
    if (ts < 0.6 && !this.inSlow) { this.inSlow = true; sfx.slowIn(); if (!this.practice) setBgmSlow(true); }
    else if (ts > 0.9 && this.inSlow) { this.inSlow = false; sfx.slowOut(); if (!this.practice) setBgmSlow(false); }
  }

  updateFx(dt) {
    const fx = this.fx;
    const sdt = dt * this.timeScale;   // 火花や波紋はスローに合わせてゆっくり
    for (const b of fx.banners) b.t += dt;
    fx.banners = fx.banners.filter(b => b.t < b.max);
    for (const p of fx.particles) {
      const k = Math.pow(0.9, this.timeScale);
      p.t += sdt; p.x += p.vx * sdt; p.y += p.vy * sdt; p.vx *= k; p.vy *= k;
    }
    fx.particles = fx.particles.filter(p => p.t < p.max);
    for (const r of fx.rings) r.t += sdt;
    fx.rings = fx.rings.filter(r => r.t < r.max);
    // ガードのマーク: どちらかの石が場外に出るか、止まった状態でガードが崩れたら消す
    for (const s of fx.shields) s.t += dt;
    fx.shields = fx.shields.filter(f => {
      const g = this.world.get(f.gid), s = this.world.get(f.sid);
      if (!g || !s || g.out || s.out) return false;
      if (g.moving || s.moving) return true;
      return isGuarding(g, s);
    });
    for (const f of fx.floats) f.t += dt;
    if (fx.skip && (fx.skip.t += dt) >= fx.skip.max) fx.skip = null;
    fx.floats = fx.floats.filter(f => f.t < f.max);
    if (this.toast) this.toast.t += dt;
    this.shake *= Math.exp(-dt * 9);
    if (this.shake < 0.2) this.shake = 0;
  }
}
