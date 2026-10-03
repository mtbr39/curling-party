// ホストとクライアントで共有するルール計算
import { SHEET, STONE_R, RULES } from './config.js';

export const tk = t => 't' + t; // Firebase が配列化しないようにチームキーは文字列にする

export function staggerSec(settings, nTeams) {
  if (settings.stagger === 'auto' || settings.stagger == null) {
    return Math.round((settings.interval / Math.max(1, nTeams)) * 10) / 10;
  }
  return Number(settings.stagger) || 0;
}

export function doneCount(game, pid) {
  const st = game?.stats?.[pid];
  return st ? (st.t || 0) + (st.l || 0) : 0;
}

// k 番目(1始まり)の石の投球期限 (サーバ時刻 ms)
export function deadlineFor(game, pid, k) {
  const team = game.roster?.[pid];
  if (team == null) return Infinity;
  const N = game.stones;
  if (pid === game.hammerPid && k === N) {
    return game.hammerUnlockAt ? game.hammerUnlockAt + game.interval * 1000 : Infinity;
  }
  const off = game.offsets?.[tk(team)] || 0;
  return game.endStartAt + (off + k * game.interval) * 1000;
}

export function isHammerLocked(game, pid, done) {
  return pid === game.hammerPid && done === game.stones - 1 && !game.hammerUnlockAt;
}

// 投げられるか。理由も返す
export function throwState(game, pid, now, extraDone = 0) {
  if (!game || game.status !== 'playing' || game.phase !== 'play') return { ok: false, why: 'wait' };
  if (game.roster?.[pid] == null) return { ok: false, why: 'spectator' };
  if (now < game.endStartAt) return { ok: false, why: 'countdown' };
  const done = doneCount(game, pid) + extraDone;
  if (done >= game.stones) return { ok: false, why: 'done' };
  if (isHammerLocked(game, pid, done)) return { ok: false, why: 'hammer' };
  return { ok: true, done, deadline: deadlineFor(game, pid, done + 1) };
}

export function distToTee(s) {
  return Math.hypot(s.x - SHEET.TEE_X, s.y - SHEET.CY);
}

export function inHouse(s) {
  return distToTee(s) <= SHEET.HOUSE_R + STONE_R;
}

// ガードストーン: g がハウスの外・手前にあり、ハウス内の同じチームの石 s への進路をふさいでいる
export function isGuarding(g, s) {
  if (!g || !s || g === s || g.out || s.out || g.team !== s.team) return false;
  if (!inHouse(s) || inHouse(g)) return false;
  if (g.x > SHEET.TEE_X) return false;
  if (s.x - g.x < STONE_R * 1.5) return false;
  return Math.abs(s.y - g.y) <= STONE_R * 1.7;
}

// 得点計算: 最もティーに近い石のチームが、他チームの最も近い石より内側にある自チームの石の数だけ得点
export function scoreEnd(stones) {
  const list = stones.filter(s => !s.out && inHouse(s)).sort((a, b) => distToTee(a) - distToTee(b));
  if (!list.length) return { team: -1, points: 0, ids: [] };
  const team = list[0].team;
  const ids = [];
  for (const s of list) {
    if (s.team !== team) break;
    ids.push(s.id);
  }
  return { team, points: ids.length, ids, edge: list.find(s => s.team !== team)?.id || null };
}

export function nextTeam(teams, cur) {
  if (!teams.length) return null;
  const i = teams.indexOf(cur);
  return teams[(i + 1) % teams.length];
}

export { RULES };
