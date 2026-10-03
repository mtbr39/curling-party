// CPU プレイヤーのショット計画。単体シミュレーションで速さと角度を逆算し、ノイズを乗せる。
import { SHEET, STONE_R, PHYS, SPEED, vmax, speedToPower } from './config.js';
import { runSolo } from './physics.js';
import { distToTee, inHouse } from './rules.js';

const gauss = () => {
  let u = 0, v = 0;
  while (!u) u = Math.random();
  while (!v) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};

function launch(y, speed, angle, spin) {
  return { x: SHEET.SPAWN_X, y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, spin };
}

// 目標地点 (tx, ty) に止める
function solveDraw(y0, tx, ty, spin) {
  let angle = Math.atan2(ty - y0, tx - SHEET.SPAWN_X);
  let speed = 480 * SPEED.k;
  for (let it = 0; it < 4; it++) {
    let lo = 150 * SPEED.k, hi = vmax();
    for (let i = 0; i < 16; i++) {
      const v = (lo + hi) / 2;
      const r = runSolo(launch(y0, v, angle, spin));
      const along = (r.x - SHEET.SPAWN_X) * Math.cos(angle) + (r.y - y0) * Math.sin(angle);
      const want = (tx - SHEET.SPAWN_X) * Math.cos(angle) + (ty - y0) * Math.sin(angle);
      if (along < want) lo = v; else hi = v;
    }
    speed = (lo + hi) / 2;
    const r = runSolo(launch(y0, speed, angle, spin));
    angle -= (r.y - ty) / (tx - SHEET.SPAWN_X);
  }
  return { speed, angle };
}

// 指定 x を通過するときに y=ty を通る（テイクアウト用）
function solveHit(y0, tx, ty, speed, spin) {
  let angle = Math.atan2(ty - y0, tx - SHEET.SPAWN_X);
  for (let it = 0; it < 5; it++) {
    const r = runSolo(launch(y0, speed, angle, spin), { crossX: tx });
    if (r.crossY == null) break;
    angle -= (r.crossY - ty) / (tx - SHEET.SPAWN_X);
  }
  return { speed, angle };
}

export function planShot(world, team, skill = 1, y = null) {
  const stones = world.stones.filter(s => !s.out && !s.moving);
  const house = stones.filter(inHouse).sort((a, b) => distToTee(a) - distToTee(b));
  const enemyFirst = house.length && house[0].team !== team ? house[0] : null;
  const myBest = house.find(s => s.team === team);

  const spin = (Math.random() < 0.5 ? -1 : 1) * (0.25 + Math.random() * 0.6);
  const y0 = y ?? SHEET.CY + (Math.random() - 0.5) * SHEET.W * 0.35;
  let plan;
  const r = Math.random();

  if (enemyFirst && r < 0.65) {
    // テイクアウト
    const t = enemyFirst;
    const speed = vmax() * (0.72 + Math.random() * 0.2);
    plan = solveHit(y0, t.x, t.y + (Math.random() - 0.5) * 8, speed, spin * 0.4);
    plan.spin = spin * 0.4;
  } else if (myBest && r < 0.85) {
    // ガード: 自分の石の手前に置く
    // ハウスの手前〜ガードゾーンの中ほど
    const front = SHEET.TEE_X - SHEET.HOUSE_R;
    const gx = front - STONE_R * 2 - Math.random() * (front - SHEET.FAR_HOG) * 0.5;
    plan = solveDraw(y0, Math.max(SHEET.FAR_HOG + STONE_R * 3, gx), myBest.y + (Math.random() - 0.5) * STONE_R * 0.7, spin);
    plan.spin = spin;
  } else {
    // ドロー: ボタン付近へ
    const tx = SHEET.TEE_X + (Math.random() - 0.5) * SHEET.HOUSE_R * 0.35;
    const ty = SHEET.CY + (Math.random() - 0.5) * SHEET.HOUSE_R * 0.4;
    plan = solveDraw(y0, tx, ty, spin);
    plan.spin = spin;
  }
  const noise = 1 / skill;
  const speed = plan.speed * (1 + gauss() * 0.014 * noise);
  const angle = plan.angle + gauss() * 0.0035 * noise;
  return { ...launch(y0, Math.min(speed, vmax()), angle, plan.spin), aimAngle: angle, power: speedToPower(speed) };
}

export { STONE_R };
