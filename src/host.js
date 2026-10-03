// ホスト（部屋の代表クライアント）が実行する権威側ロジック。
// 物理・タイマー・得点・技判定・CPU をここで処理し、結果をストアへ書き込む。
import { SHEET, STONE_R, PHYS, RULES, DEFAULT_SETTINGS, vmax } from './config.js';
import { World, makeStone, advanceSolo } from './physics.js';
import {
  tk, staggerSec, doneCount, deadlineFor, throwState, scoreEnd, nextTeam, distToTee, isGuarding,
} from './rules.js';
import { planShot } from './bot.js';

const R = STONE_R;

export class GameHost {
  constructor(store, myPid) {
    this.store = store;
    this.pid = myPid;
    this.world = new World();
    this.meta = null;
    this.players = {};
    this.sweeps = {};
    this.game = null;
    this.throwInfo = {};
    this.takeouts = {};
    this.botPlan = {};
    this.lastSnap = 0;
    this.wasMoving = false;
    this.dirty = false;
    this.unsubs = [];
    this.world.on('out', e => this.onOut(e));
    this.world.on('rest', e => this.onRest(e));
  }

  get settings() { return { ...DEFAULT_SETTINGS, ...(this.meta?.settings || {}) }; }
  now() { return this.store.serverNow(); }

  async start() {
    const s = this.store;
    // 引き継ぎ: 既存の状態を読み込む
    const g = await s.get('game');
    if (g) {
      this.game = normalizeGame(g);
      const snap = await s.get('stones');
      this.loadSnapshot(snap);
    }
    this.unsubs.push(
      s.onValue('meta', v => { this.meta = v; this.assignTeams(); }),
      s.onValue('players', v => { this.players = v || {}; this.assignTeams(); }),
      s.onValue('sweeps', v => { this.sweeps = v || {}; }),
      s.onChildAdded('throws', (k, v) => this.onThrow(k, v)),
    );
    this.last = performance.now();
    this.timer = setInterval(() => this.tick(), 1000 / 60);
  }

  stop() {
    clearInterval(this.timer);
    for (const u of this.unsubs) try { u(); } catch {}
    this.unsubs = [];
  }

  loadSnapshot(snap) {
    this.world.clear();
    for (const a of snap?.s || []) {
      const st = decodeStone(a);
      this.world.add(st);
      this.throwInfo[st.id] = { team: st.team, owner: st.owner };
    }
  }

  // ------------------------------------------------------------ チーム割り当て
  assignTeams() {
    if (!this.meta) return;
    const set = this.settings;
    const key = set.mode + ':' + set.teamCount;
    const force = this.lastModeKey != null && this.lastModeKey !== key && this.meta.status === 'lobby';
    this.lastModeKey = key;
    const list = Object.entries(this.players).sort((a, b) => (a[1].joinedAt || 0) - (b[1].joinedAt || 0));
    const upd = {};
    if (set.mode === 'solo') {
      const used = new Set();
      if (this.game && this.meta.status === 'playing') for (const k of Object.keys(this.game.scores || {})) used.add(+k.slice(1));
      const need = [];
      const seen = new Set();
      for (const [pid, p] of list) {
        if (!force && p.team != null && !seen.has(p.team)) { seen.add(p.team); used.add(p.team); } else need.push(pid);
      }
      for (const pid of need) {
        let i = 0;
        while (used.has(i)) i++;
        used.add(i);
        upd[`${pid}/team`] = i;
      }
    } else {
      const n = Math.max(2, set.teamCount | 0);
      const counts = Array(n).fill(0);
      const need = [];
      for (const [pid, p] of list) {
        if (!force && p.team != null && p.team < n) counts[p.team]++; else need.push(pid);
      }
      for (const pid of need) {
        const t = counts.indexOf(Math.min(...counts));
        counts[t]++;
        upd[`${pid}/team`] = t;
      }
    }
    if (Object.keys(upd).length) this.store.update('players', upd);
  }

  // ------------------------------------------------------------ ロビー操作
  addBot() {
    const id = 'cpu' + Math.random().toString(36).slice(2, 7);
    this.botN = Math.max(this.botN || 0, Object.values(this.players).filter(p => p.bot).length) + 1;
    const n = this.botN;
    this.store.set(`players/${id}`, { name: `CPU ${n}`, bot: true, team: null, joinedAt: Date.now() });
  }
  removeBot() {
    const bots = Object.entries(this.players).filter(([, p]) => p.bot)
      .sort((a, b) => b[1].joinedAt - a[1].joinedAt);
    if (bots.length) this.store.remove(`players/${bots[0][0]}`);
  }
  kick(pid) { this.store.remove(`players/${pid}`); }

  startGame() {
    const set = this.settings;
    const teams = [...new Set(Object.values(this.players).map(p => p.team).filter(t => t != null))].sort((a, b) => a - b);
    if (!teams.length) return;
    const scores = {};
    for (const t of teams) scores[tk(t)] = 0;
    this.game = {
      status: 'playing', end: 0, totalEnds: set.ends, stones: set.stones, interval: set.interval,
      scores, history: [], hammer: teams[Math.floor(Math.random() * teams.length)],
    };
    this.store.update('meta', { status: 'playing' });
    this.startEnd();
  }

  backToLobby() {
    this.game = null;
    this.world.clear();
    this.store.remove('game');
    this.store.remove('stones');
    this.store.remove('events');
    this.store.remove('throws');
    this.store.update('meta', { status: 'lobby' });
  }

  startEnd() {
    const g = this.game;
    const set = this.settings;
    g.end++;
    const roster = {};
    for (const [pid, p] of Object.entries(this.players)) if (p.team != null) roster[pid] = p.team;
    const teams = [...new Set(Object.values(roster))].sort((a, b) => a - b);
    if (!teams.includes(g.hammer)) g.hammer = nextTeam(teams, g.hammer);
    const hi = teams.indexOf(g.hammer);
    const order = [...teams.slice(hi + 1), ...teams.slice(0, hi + 1)];
    const stagger = staggerSec(set, teams.length);
    const offsets = {};
    order.forEach((t, i) => { offsets[tk(t)] = i * stagger; });
    const members = Object.keys(roster).filter(pid => roster[pid] === g.hammer)
      .sort((a, b) => (this.players[a].joinedAt || 0) - (this.players[b].joinedAt || 0));
    const stats = {};
    for (const pid of Object.keys(roster)) stats[pid] = { t: 0, l: 0 };
    for (const t of teams) if (g.scores[tk(t)] == null) g.scores[tk(t)] = 0;
    Object.assign(g, {
      roster, teams, order, offsets, stats,
      hammerPid: members.length ? members[(g.end - 1) % members.length] : null,
      endStartAt: this.now() + RULES.COUNTDOWN,
      hammerUnlockAt: 0, phase: 'play', result: null, nextAt: 0,
    });
    this.world.clear();
    this.throwInfo = {};
    this.takeouts = {};
    this.botPlan = {};
    this.store.remove('events');
    this.store.remove('throws');
    this.store.remove('sweeps');
    this.writeGame();
    this.writeSnapshot();
  }

  writeGame() { this.store.set('game', this.game); }

  event(e) { this.store.push('events', { ...e, t: this.now() }); }

  // ------------------------------------------------------------ 投球受付
  onThrow(key, v) {
    this.store.remove(`throws/${key}`);
    const g = this.game;
    if (!g || g.status !== 'playing' || !v) return;
    const now = this.now();
    const reject = why => this.event({ type: 'reject', pid: v.pid, id: v.id, why });
    if (now - (v.t || 0) > 3000) { reject('stale'); return; }
    const st = throwState(g, v.pid, Math.max(now, g.endStartAt));
    if (!st.ok || this.world.get(v.id)) { reject(st.why || 'dup'); return; }
    // 間に合ったかは「投げた時刻」で判定（届くのが遅れても OK。時計のずれ分だけ少し許す）
    if ((v.t || now) > st.deadline + RULES.CLOCK_TOLERANCE) { reject('late'); return; }
    this.spawn(v.pid, v.id, v, Math.min(0.3, Math.max(0, (now - v.t) / 1000)));
  }

  spawn(pid, id, v, lag) {
    const g = this.game;
    const team = g.roster[pid];
    let vx = +v.vx || 0, vy = +v.vy || 0;
    const sp = Math.hypot(vx, vy);
    const vm = vmax();
    if (sp > vm) { vx *= vm / sp; vy *= vm / sp; }
    const y = Math.max(R + 2, Math.min(SHEET.W - R - 2, +v.y || SHEET.CY));
    const spin = Math.max(-1, Math.min(1, +v.spin || 0));
    const s = makeStone({ id, team, owner: pid, x: SHEET.SPAWN_X, y, vx, vy, spin, born: this.now() });
    if (lag > 0) advanceSolo(s, lag);
    this.world.add(s);
    this.throwInfo[id] = { team, owner: pid };
    g.stats[pid] ||= { t: 0, l: 0 };
    g.stats[pid].t++;
    this.calmSince = 0; // 新しい石が動き出したので「止まってからの時間」はやり直し
    this.writeGame();
    this.dirty = true;
  }

  // ------------------------------------------------------------ 技判定
  onOut({ stone }) {
    const g = this.game;
    if (!g || g.phase !== 'play') return;
    const cause = stone.cause;
    const info = cause && this.throwInfo[cause];
    if (info && info.team !== stone.team) {
      const n = (this.takeouts[cause] = (this.takeouts[cause] || 0) + 1);
      this.event({ type: 'takeout', n, cause, team: info.team, owner: info.owner, x: stone.x, y: stone.y, victim: stone.team });
    }
    this.dirty = true;
  }

  onRest({ stone, first }) {
    const g = this.game;
    this.dirty = true;
    if (!g || g.phase !== 'play' || !first || !this.throwInfo[stone.id]) return;
    if (stone.owner == null) return;
    const dG = distToTee(stone);
    if (dG <= SHEET.BUTTON_R + 6) {
      this.event({ type: 'button', id: stone.id, team: stone.team, owner: stone.owner, x: stone.x, y: stone.y });
    }
    // ガードストーン: 自分のハウス内の石の手前の進路上に止まった
    for (const s of this.world.inPlay()) {
      if (s.moving || !isGuarding(stone, s)) continue;
      this.event({ type: 'guard', team: stone.team, owner: stone.owner, x: stone.x, y: stone.y, gid: stone.id, sid: s.id });
      break;
    }
  }

  // ------------------------------------------------------------ メインループ
  tick() {
    const t = performance.now();
    const dt = (t - this.last) / 1000;
    this.last = t;
    const g = this.game;
    const now = this.now();

    const sweeping = new Set(Object.values(this.sweeps || {}).filter(Boolean));
    for (const s of this.world.stones) s.sweep = s.moving && !s.out && sweeping.has(s.id);

    this.world.advance(dt);

    if (g && g.status === 'playing') {
      if (g.phase === 'play') this.tickPlay(now);
      else if (g.phase === 'result' && now >= g.nextAt) {
        if (g.end >= g.totalEnds) {
          g.status = 'finished';
          g.phase = 'final';
          this.writeGame();
          this.store.update('meta', { status: 'finished' });
        } else this.startEnd();
      }
    }

    const moving = !this.world.isSettled() || this.world.stones.some(s => s.out);
    if ((moving || this.dirty || this.wasMoving) && t - this.lastSnap > 90) {
      this.writeSnapshot();
      this.lastSnap = t;
      this.dirty = false;
      this.wasMoving = moving;
    }
  }

  tickPlay(now) {
    const g = this.game;
    let changed = false;
    const N = g.stones;

    // 期限切れ → 石が1つ消える
    for (const pid of Object.keys(g.roster)) {
      const st = (g.stats[pid] ||= { t: 0, l: 0 });
      for (;;) {
        const done = st.t + st.l;
        if (done >= N) break;
        const dl = deadlineFor(g, pid, done + 1);
        if (now > dl + RULES.DEADLINE_GRACE) {
          st.l++;
          changed = true;
          this.event({ type: 'lost', pid, team: g.roster[pid] });
        } else break;
      }
    }

    const settled = this.world.isSettled();
    // ハンマー解禁: 他の全員が投げ終わり、石が全部止まった
    if (g.hammerPid && !g.hammerUnlockAt && settled) {
      const others = Object.keys(g.roster).every(pid => pid === g.hammerPid || doneCount(g, pid) >= N);
      if (others && doneCount(g, g.hammerPid) >= N - 1) {
        g.hammerUnlockAt = now;
        changed = true;
        this.event({ type: 'hammer', pid: g.hammerPid, team: g.roster[g.hammerPid] });
      }
    }

    // CPU
    for (const pid of Object.keys(g.roster)) {
      if (!this.players[pid]?.bot) continue;
      this.tickBot(pid, now);
    }

    // エンド終了: 全員投げ終わり、石が全部止まった状態が少し続いたら（遅れて届く投球を待つ）
    // ※ 上の CPU がこのフレームで投げているかもしれないので、止まっているかは調べ直す
    const calm = this.world.isSettled() && !this.world.stones.some(s => s.out);
    if (!calm) this.calmSince = 0;
    else if (!this.calmSince) this.calmSince = now;
    const allDone = Object.keys(g.roster).every(pid => doneCount(g, pid) >= N);
    if (allDone && calm && now - this.calmSince >= RULES.SETTLE_WAIT) {
      const res = scoreEnd(this.world.stones);
      g.history = [...(g.history || []), { team: res.team, points: res.points, hammer: g.hammer }];
      if (res.team >= 0) g.scores[tk(res.team)] = (g.scores[tk(res.team)] || 0) + res.points;
      // ハンマーのチームが得点したら次のチームへ。0点なら同じチームが持ち続ける
      if (res.team === g.hammer && res.points > 0) g.hammer = nextTeam(g.teams, g.hammer);
      g.phase = 'result';
      g.result = res;
      g.nextAt = now + RULES.RESULT_TIME;
      changed = true;
    }
    if (changed) this.writeGame();
  }

  tickBot(pid, now) {
    const g = this.game;
    const st = throwState(g, pid, now);
    if (!st.ok) { delete this.botPlan[pid]; return; }
    let bp = this.botPlan[pid];
    if (!bp || bp.k !== st.done) {
      const earliest = Math.max(now, g.endStartAt) + 700;
      const latest = Math.min(st.deadline - 1200, earliest + 7000);
      const at = latest > earliest ? earliest + Math.random() * (latest - earliest) : now + 100;
      const y = SHEET.CY + (Math.random() - 0.5) * SHEET.W * 0.65;
      bp = this.botPlan[pid] = { at, k: st.done, y };
      this.store.set(`aims/${pid}`, { y, a: 0, p: 0, s: 0, d: 0 });
    }
    if (now < bp.at) return;
    if (this.world.stones.some(s => !s.out && Math.hypot(s.x - SHEET.SPAWN_X, s.y - bp.y) < R * 3)) return;
    const shot = planShot(this.world, g.roster[pid], 1, bp.y);
    this.store.set(`aims/${pid}`, { y: shot.y, a: shot.aimAngle, p: shot.power, s: shot.spin, d: 0 });
    this.spawn(pid, `${pid}_${g.end}_${st.done + 1}`, shot, 0);
    delete this.botPlan[pid];
  }

  writeSnapshot() {
    const s = this.world.stones.map(encodeStone);
    this.store.set('stones', { ts: this.now(), s });
  }
}

const r1 = v => Math.round(v * 10) / 10;
const r3 = v => Math.round(v * 1000) / 1000;

export function encodeStone(s) {
  const flags = (s.hit ? 1 : 0) | (s.sweep ? 2 : 0) | (s.rested ? 4 : 0) | (s.moving ? 8 : 0);
  return [s.id, s.team, s.owner || '', r1(s.x), r1(s.y), r1(s.vx), r1(s.vy), r3(s.spin), r3(s.angle), flags, r3(s.out || 0), s.cause || ''];
}

export function decodeStone(a) {
  const [id, team, owner, x, y, vx, vy, spin, angle, flags, out, cause] = a;
  const s = makeStone({ id, team, owner: owner || null, x, y, vx, vy, spin, angle, out, hit: flags & 1, sweep: flags & 2, rested: flags & 4, cause: cause || null });
  s.moving = !!(flags & 8) && (vx !== 0 || vy !== 0);
  return s;
}

export function normalizeGame(g) {
  if (!g) return g;
  g.history = Array.isArray(g.history) ? g.history : Object.values(g.history || {});
  g.teams = Array.isArray(g.teams) ? g.teams : Object.values(g.teams || {});
  g.order = Array.isArray(g.order) ? g.order : Object.values(g.order || {});
  g.scores ||= {};
  g.stats ||= {};
  g.roster ||= {};
  g.offsets ||= {};
  if (g.result) g.result.ids = Array.isArray(g.result.ids) ? g.result.ids : Object.values(g.result.ids || {});
  return g;
}
