// Canvas 描画。色数を抑えたミニマルなスタイル。
// シートは縦向き：ワールドの x（投げる方向）が画面の下→上、y が画面の左→右。
import { SHEET, STONE_R, PHYS, teamColor, teamName } from './config.js';
import { tk, doneCount, deadlineFor, distToTee, slotSec } from './rules.js';

const R = STONE_R;
export const INK = '#141414';
const SHEET_C = '#FBFBF9';
const BG = '#E7E6E1';
const SOFT = '#ECEBE7';
const LINE = 'rgba(20,20,20,.5)';
const WARN = '#E4572E';
const FONT = '"Inter", "M PLUS 1p", "Helvetica Neue", Arial, sans-serif';
const MONO = '"JetBrains Mono", ui-monospace, Menlo, Consolas, monospace';
const VIEW = { x0: -14, x1: SHEET.L + 12 };   // 表示するワールド x の範囲（下端〜上端）
// シートの下のレーン（各プレイヤーのタイマー・名前・残りの石）。単位は画面ピクセル
export const LANE = {
  ring: 18,       // タイマーの円の半径
  ringW: 3.5,     // タイマーの円の線の太さ
  time: 13,       // 秒数の文字サイズ
  name: 14,       // 名前の文字サイズ
  dot: 4.5,       // 残りの石（丸）の半径
  dotGap: 12,     // 残りの石の間隔
  perRow: 6,      // 残りの石を1行に並べる数
  slot: 80,       // プレイヤー同士の横の間隔（これより近いとずらす）
};
// 上から順に: シートの端 → タイマーの円 → 名前 → 残りの石
const LANE_RING_Y = 10 + LANE.ring;
const LANE_NAME_Y = LANE_RING_Y + LANE.ring + 6 + LANE.name / 2;
const LANE_DOT_Y = LANE_NAME_Y + LANE.name / 2 + 6 + LANE.dot;
const LANE_PX = LANE_DOT_Y + LANE.dot + LANE.dotGap + 6;   // シートの下に確保する高さ（石2行ぶん）
const SIDE = 58;                               // シート左右の余白（ワールド単位）
const GAUGE_LEN = 330;                         // 狙いゲージの長さ（ワールド単位）
const TOP = 84, BOTTOM = 118;                  // 縦長画面のときの HUD 高さ

// 回転したワールド座標系の中で、文字だけは画面に対してまっすぐ描く
function utext(ctx, text, x, y) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(Math.PI / 2);
  ctx.fillText(text, 0, 0);
  ctx.restore();
}

export class Renderer {
  constructor(canvas) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d');
    this.resize();
    this._onResize = () => this.resize();
    addEventListener('resize', this._onResize);
  }
  dispose() { removeEventListener('resize', this._onResize); }

  resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.dpr = dpr;
    const w = this.w = this.cv.clientWidth || innerWidth;
    const h = this.h = this.cv.clientHeight || innerHeight;
    this.cv.width = Math.round(w * dpr);
    this.cv.height = Math.round(h * dpr);
    // 横長画面: 左右にパネル / 縦長画面: 上下にバー
    this.land = w >= h * 0.9 && w >= 720;
    if (this.land) {
      this.panelL = Math.max(240, Math.min(320, w * 0.24));
      this.panelR = Math.max(220, Math.min(320, w * 0.24));
      this.area = { x: this.panelL, y: 0, w: w - this.panelL - this.panelR, h };
    } else {
      const top = Math.max(TOP, this.topPx || 0);
      this.area = { x: 0, y: top, w, h: h - top - BOTTOM };
    }
    const a = this.area;
    const vw = SHEET.W + SIDE * 2;
    const vh = VIEW.x1 - VIEW.x0;
    const s = this.scale = Math.max(0.15, Math.min((a.w - 16) / vw, (a.h - 16 - LANE_PX) / vh));
    this.u = 1 / s;                              // 画面1pxあたりのワールド単位
    this.ox = a.x + a.w / 2 - (SHEET.W / 2) * s;
    this.oy = a.y + (a.h - vh * s - LANE_PX) / 2 + VIEW.x1 * s;
  }
  toWorld(cx, cy) { return { x: (this.oy - cy) / this.scale, y: (cx - this.ox) / this.scale }; }
  toScreen(x, y) { return { x: this.ox + y * this.scale, y: this.oy - x * this.scale }; }

  draw(c) {
    const ctx = this.ctx;
    // 縦長画面では点数表の行数に合わせて上のバーの高さを変える
    const want = 22 + 12 + 18 + (c.game?.teams?.length || 0) * 19 + 12;
    if (want !== this.topPx) { this.topPx = want; if (!this.land) this.resize(); }
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, this.w, this.h);

    const sh = c.shake;
    const sx = (Math.random() - 0.5) * sh * 2, sy = (Math.random() - 0.5) * sh * 2;
    ctx.save();
    ctx.translate(this.ox + sx, this.oy + sy);
    ctx.rotate(-Math.PI / 2);
    ctx.scale(this.scale, this.scale);
    this.drawSheet(ctx);
    if (c.game?.phase === 'result' || c.game?.phase === 'final') this.drawMeasure(ctx, c);
    this.drawTrails(ctx, c);
    this.drawMyShots(ctx, c);
    this.drawPredictions(ctx, c);
    this.drawShotPreviews(ctx, c);
    this.drawStones(ctx, c);
    this.drawShields(ctx, c);
    this.drawLane(ctx, c);
    this.drawFigures(ctx, c);
    this.drawOtherAims(ctx, c);
    this.drawAim(ctx, c);
    this.drawParticles(ctx, c);
    ctx.restore();

    if (this.land) {
      this.drawScores(ctx, c, 28, 34, this.panelL - 48, false);
      this.drawStatus(ctx, c, 28, this.h - 250, this.panelL - 48);
      this.drawHelp(ctx, this.w - this.panelR + 24, this.h - 150);
    } else {
      this.drawScores(ctx, c, 16, 22, this.w - 32, true);
      this.drawStatus(ctx, c, 16, this.h - BOTTOM + 14, this.w - 32);
    }
    this.drawSling(ctx, c);
    this.drawBanners(ctx, c);
    this.drawCenter(ctx, c);
  }

  // クリックした場所に出す表示（押した位置の丸と、引いている点線だけ）
  drawSling(ctx, c) {
    const a = c.aim;
    if (!a.dragging || a.pressX == null || c.game?.roster?.[c.pid] == null) return;
    const px = a.pressX, py = a.pressY;
    const ex = px + a.dx, ey = py + a.dy;
    ctx.save();
    ctx.strokeStyle = INK; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(px, py, 8, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(ex, ey); ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }

  // ------------------------------------------------------------ シート
  drawSheet(ctx) {
    const { L, W, TEE_X, CY } = SHEET;
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,.08)';
    ctx.shadowBlur = 24;
    ctx.fillStyle = SHEET_C;
    ctx.fillRect(0, 0, L, W);
    ctx.restore();

    // ペブル風のかすかな模様
    ctx.fillStyle = 'rgba(0,0,0,.025)';
    for (let i = 0; i < 220; i++) {
      const x = (i * 197.3) % L, y = (i * 71.9) % W;
      ctx.fillRect(x, y, 2, 2);
    }

    // ハウス
    const rings = [[SHEET.RINGS[0], SOFT], [SHEET.RINGS[1], SHEET_C], [SHEET.RINGS[2], SOFT]];
    for (const [r, col] of rings) {
      ctx.beginPath(); ctx.arc(TEE_X, CY, r, 0, Math.PI * 2);
      ctx.fillStyle = col; ctx.fill();
      ctx.strokeStyle = LINE; ctx.lineWidth = 1.4; ctx.stroke();
    }
    ctx.beginPath(); ctx.arc(TEE_X, CY, SHEET.BUTTON_R, 0, Math.PI * 2);
    ctx.fillStyle = SHEET_C; ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.arc(TEE_X, CY, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = INK; ctx.fill();

    ctx.strokeStyle = LINE;
    const line = (x1, y1, x2, y2, w) => { ctx.lineWidth = w; ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); };
    line(SHEET.HACK_X, CY, SHEET.BACK_X + 30, CY, 1);
    line(TEE_X, 0, TEE_X, W, 1);
    line(SHEET.BACK_X, 0, SHEET.BACK_X, W, 1.4);
    ctx.strokeStyle = 'rgba(20,20,20,.8)';
    line(SHEET.NEAR_HOG, 0, SHEET.NEAR_HOG, W, 3.5);
    line(SHEET.FAR_HOG, 0, SHEET.FAR_HOG, W, 3.5);

    // ハック
    ctx.fillStyle = 'rgba(20,20,20,.12)';
    ctx.fillRect(SHEET.HACK_X - 6, 0, 12, W);

    ctx.strokeStyle = INK; ctx.lineWidth = 2;
    ctx.strokeRect(0, 0, L, W);

    ctx.fillStyle = 'rgba(20,20,20,.4)';
    ctx.font = `600 ${10 * this.u}px ${MONO}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const lx = W + 6 * this.u;
    utext(ctx, 'HOG', SHEET.FAR_HOG, lx);
    utext(ctx, 'HOG', SHEET.NEAR_HOG, lx);
    utext(ctx, 'TEE', TEE_X, lx);
    utext(ctx, 'BACK', SHEET.BACK_X, lx);
    ctx.textBaseline = 'alphabetic';
  }

  drawMeasure(ctx, c) {
    const res = c.game.result;
    if (!res || res.team < 0) return;
    const ids = res.ids || [];
    const col = teamColor(res.team);
    if (res.edge) {
      const e = c.world.get(res.edge);
      if (e) {
        ctx.setLineDash([6, 6]);
        ctx.strokeStyle = 'rgba(20,20,20,.5)'; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(SHEET.TEE_X, SHEET.CY, distToTee(e), 0, Math.PI * 2); ctx.stroke();
        ctx.setLineDash([]);
      }
    }
    ids.forEach((id, i) => {
      const s = c.world.get(id);
      if (!s) return;
      ctx.strokeStyle = col; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(SHEET.TEE_X, SHEET.CY); ctx.lineTo(s.x, s.y); ctx.stroke();
      ctx.beginPath(); ctx.arc(s.x, s.y, R + 7, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = INK; ctx.font = `800 ${14 * this.u}px ${FONT}`; ctx.textAlign = 'center';
      utext(ctx, String(i + 1), s.x + R + 10 * this.u, s.y + R + 6 * this.u);
    });
  }

  // 自分の投球の記録（エンドごとにリセット）: 点線の軌跡・スイープした区間・止まった位置、
  // 強さ(%)は投げ始めた位置に表示
  drawMyShots(ctx, c) {
    if (!c.showShots || !c.myShots.length) return;
    const team = c.game?.roster?.[c.pid] ?? c.players?.[c.pid]?.team;
    const col = teamColor(team);
    const u = this.u;
    const list = c.myShots;
    const labels = [];
    list.forEach((r, i) => {
      const latest = i === list.length - 1;
      const alpha = latest ? 0.6 : 0.35;
      const P = r.pts;
      ctx.save();
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      if (P.length >= 2) {
        // スイープした区間（うすい帯）
        ctx.strokeStyle = col; ctx.lineWidth = 7 * u;
        ctx.globalAlpha = alpha * 0.25;
        for (let j = 1; j < P.length; j++) {
          if (!P[j].sw) continue;
          ctx.beginPath(); ctx.moveTo(P[j - 1].x, P[j - 1].y); ctx.lineTo(P[j].x, P[j].y); ctx.stroke();
        }
        // 軌跡（点線）
        ctx.globalAlpha = alpha;
        ctx.lineWidth = 1.6 * u;
        ctx.setLineDash([1.5 * u, 4.5 * u]);
        ctx.beginPath(); ctx.moveTo(P[0].x, P[0].y);
        for (let j = 1; j < P.length; j++) ctx.lineTo(P[j].x, P[j].y);
        ctx.stroke();
        ctx.setLineDash([]);
        // 止まった位置（場外なら ×）
        const e = P[P.length - 1];
        if (r.done) {
          ctx.strokeStyle = r.out ? WARN : col; ctx.lineWidth = 1.5 * u;
          if (r.out) {
            const q = 6 * u;
            ctx.beginPath(); ctx.moveTo(e.x - q, e.y - q); ctx.lineTo(e.x + q, e.y + q); ctx.moveTo(e.x + q, e.y - q); ctx.lineTo(e.x - q, e.y + q); ctx.stroke();
          } else {
            ctx.setLineDash([3 * u, 3 * u]);
            ctx.beginPath(); ctx.arc(e.x, e.y, R + 3 * u, 0, Math.PI * 2); ctx.stroke();
            ctx.setLineDash([]);
          }
        }
      }
      // 投げた位置
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = INK; ctx.lineWidth = 1.2 * u;
      ctx.beginPath(); ctx.arc(r.x0, r.y0, 3.5 * u, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
      labels.push({ r, latest, alpha });
    });

    // 強さのラベル: 投げ始めた位置の横（近い位置で投げたものは奥へずらして重ならないように）
    ctx.font = `600 ${9.5 * u}px ${MONO}`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    const placed = [];
    for (const { r, latest, alpha } of labels) {
      const text = `${(r.power * 100).toFixed(1)}%`;
      const tw = ctx.measureText(text).width;
      let lx = r.x0 + 2 * u;                 // 少し奥（画面では上）
      const ly = r.y0 + 7 * u;               // 右隣
      while (placed.some(p => Math.abs(p.lx - lx) < 12 * u && ly < p.ly + p.tw + 4 * u && ly + tw + 4 * u > p.ly)) lx += 13 * u;
      placed.push({ lx, ly, tw });
      ctx.save();
      ctx.translate(lx, ly); ctx.rotate(Math.PI / 2);
      ctx.globalAlpha = latest ? 0.95 : 0.6;
      ctx.fillStyle = SHEET_C;
      ctx.fillRect(-2 * u, -6.5 * u, tw + 4 * u, 13 * u);
      ctx.fillStyle = INK;
      ctx.fillText(text, 0, 0);
      ctx.restore();
    }
    ctx.textBaseline = 'alphabetic';
  }

  // 冴えわたり（最後の一投の結果予測。狙っている間だけ、全員に見える）
  drawShotPreviews(ctx, c) {
    for (const hp of c.previews || []) this.drawShotPreview(ctx, c, hp);
  }

  // 冴えわたり: 1人ぶんの結果予測
  drawShotPreview(ctx, c, hp) {
    const u = this.u;
    ctx.save();
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    // 通り道: 自分の石は太い実線、弾かれる石は点線
    for (const p of hp.paths) {
      const P = p.pts;
      if (P.length < 2) continue;
      ctx.strokeStyle = teamColor(p.team);
      ctx.globalAlpha = p.mine ? 0.85 : 0.75;
      ctx.lineWidth = (p.mine ? 2.5 : 2) * u;
      ctx.setLineDash(p.mine ? [] : [4 * u, 4 * u]);
      ctx.beginPath(); ctx.moveTo(P[0].x, P[0].y);
      for (let j = 1; j < P.length; j++) ctx.lineTo(P[j].x, P[j].y);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    // 最終的に置かれる場所: 石の輪郭（うすく塗る）。場外は ×
    for (const f of hp.finals) {
      const col = teamColor(f.team);
      if (f.out) {
        const q = 8 * u;
        ctx.globalAlpha = 0.9; ctx.strokeStyle = WARN; ctx.lineWidth = 2.5 * u;
        ctx.beginPath(); ctx.moveTo(f.x - q, f.y - q); ctx.lineTo(f.x + q, f.y + q); ctx.moveTo(f.x + q, f.y - q); ctx.lineTo(f.x - q, f.y + q); ctx.stroke();
        continue;
      }
      ctx.globalAlpha = 0.25; ctx.fillStyle = col;
      ctx.beginPath(); ctx.arc(f.x, f.y, R, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 0.95; ctx.strokeStyle = col; ctx.lineWidth = (f.mine ? 2.5 : 2) * u;
      ctx.setLineDash([5 * u, 3 * u]);
      ctx.beginPath(); ctx.arc(f.x, f.y, R, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]);
      // 誰の予測かがわかるよう、投げる石の予測位置に名前
      if (f.mine) {
        const name = hp.pid === c.pid ? 'あなた' : (c.players?.[hp.pid]?.name || '?');
        ctx.save();
        ctx.translate(f.x, f.y + R + 5 * u); ctx.rotate(Math.PI / 2);
        ctx.font = `700 ${11 * u}px ${MONO}`; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        const tw = ctx.measureText(name).width;
        ctx.globalAlpha = 0.9; ctx.fillStyle = SHEET_C; ctx.fillRect(-2 * u, -7 * u, tw + 4 * u, 14 * u);
        ctx.globalAlpha = 1; ctx.fillStyle = INK; ctx.fillText(name, 0, 0);
        ctx.restore();
      }
    }
    ctx.restore();
  }

  // 自分の動いている石の予測線（今スイープをやめたら、どこを通ってどこに止まるか）
  drawPredictions(ctx, c) {
    const u = this.u;
    for (const pr of c.predictions || []) {
      const P = pr.path;
      if (!P || P.length < 2) continue;
      const col = teamColor(pr.team);
      ctx.save();
      ctx.strokeStyle = col; ctx.globalAlpha = 0.7;
      ctx.lineWidth = 2 * u; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.beginPath(); ctx.moveTo(P[0].x, P[0].y);
      for (let j = 1; j < P.length; j++) ctx.lineTo(P[j].x, P[j].y);
      ctx.stroke();
      // 止まる予定の位置（石の輪郭）
      ctx.globalAlpha = 0.85;
      ctx.setLineDash([5 * u, 4 * u]);
      ctx.lineWidth = 2 * u;
      ctx.beginPath(); ctx.arc(pr.x, pr.y, R, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }
  }

  drawTrails(ctx, c) {
    for (const [id, tr] of c.trails) {
      if (tr.length < 2) continue;
      const s = c.world.get(id);
      ctx.strokeStyle = s ? teamColor(s.team) : INK;
      ctx.lineCap = 'round';
      for (let i = 1; i < tr.length; i++) {
        const a = i / tr.length;
        ctx.globalAlpha = a * 0.28;
        ctx.lineWidth = R * 0.9 * a;
        ctx.beginPath(); ctx.moveTo(tr[i - 1].x, tr[i - 1].y); ctx.lineTo(tr[i].x, tr[i].y); ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
    ctx.lineCap = 'butt';
  }

  drawStones(ctx, c) {
    for (const s of c.world.stones) {
      const x = s.x + s.ox, y = s.y + s.oy;
      const fade = s.out ? Math.max(0, 1 - s.out / 0.9) : 1;
      const k = s.out ? 1 - s.out * 0.35 : 1;
      ctx.globalAlpha = fade * (s.pending ? 0.75 : 1);
      drawStone(ctx, x, y, R * k, s.team, s.angle);
      if (s.sweep && s.moving) {
        // スイープの跡
        const sp = Math.hypot(s.vx, s.vy) || 1;
        const dx = s.vx / sp, dy = s.vy / sp;
        ctx.strokeStyle = 'rgba(20,20,20,.35)'; ctx.lineWidth = 1.2;
        for (let i = 0; i < 4; i++) {
          const d = R + 8 + i * 6 + (performance.now() / 40 % 6);
          const ox = -dy * (Math.random() - 0.5) * 22, oy = dx * (Math.random() - 0.5) * 22;
          ctx.beginPath();
          ctx.moveTo(x + dx * d + ox - dy * 6, y + dy * d + oy + dx * 6);
          ctx.lineTo(x + dx * d + ox + dy * 6, y + dy * d + oy - dx * 6);
          ctx.stroke();
        }
      }
    }
    ctx.globalAlpha = 1;
  }

  drawShields(ctx, c) {
    // ガードが成り立っている間ずっと表示（石の今の位置に追従）
    for (const f of c.fx.shields) {
      const g = c.world.get(f.gid), s = c.world.get(f.sid);
      if (!g || !s) continue;
      const gx = g.x + g.ox, gy = g.y + g.oy, sx = s.x + s.ox, sy = s.y + s.oy;
      const pop = f.t < 0.4 ? 1 + (1 - f.t / 0.4) * 0.6 : 1;     // 出現時に少し大きく
      ctx.globalAlpha = Math.min(1, f.t / 0.15) * 0.85;
      ctx.strokeStyle = teamColor(f.team);
      // 守っている円弧（来る方向＝ガードの手前側）
      const ang = Math.atan2(sy - gy, sx - gx);
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(gx, gy, (R + 10 + Math.sin(f.t * 3) * 1.2) * pop, ang + Math.PI - 1.1, ang + Math.PI + 1.1);
      ctx.stroke();
      // 結んだ線と、守られている石の円
      ctx.setLineDash([5, 6]); ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(gx, gy); ctx.lineTo(sx, sy); ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath(); ctx.arc(sx, sy, R + 6, 0, Math.PI * 2); ctx.stroke();
      // 「ガード」の札（石の横。中央寄りの側に出す）
      const u = this.u;
      const side = gy > SHEET.CY ? -1 : 1;
      ctx.globalAlpha = Math.min(1, f.t / 0.15);
      ctx.save();
      ctx.translate(gx, gy + side * (R + 6 * u));
      ctx.rotate(Math.PI / 2);
      ctx.font = `800 ${11 * u}px ${FONT}`;
      const lw = ctx.measureText('ガード').width + 10 * u, lh = 17 * u;
      const lx = side > 0 ? 0 : -lw;
      ctx.fillStyle = SHEET_C;
      ctx.fillRect(lx, -lh / 2, lw, lh);
      ctx.strokeStyle = teamColor(f.team); ctx.lineWidth = 1.5 * u;
      ctx.strokeRect(lx, -lh / 2, lw, lh);
      ctx.fillStyle = INK; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('ガード', lx + lw / 2, u);
      ctx.restore();
    }
    ctx.textBaseline = 'alphabetic';
    ctx.globalAlpha = 1;
  }

  // シートの下（ハックの手前）: タイマー・名前・残り石。サイズは画面ピクセル基準
  drawLane(ctx, c) {
    const g = c.game;
    const play = g && g.status === 'playing' && g.phase === 'play';
    const now = c.now;
    const u = this.u;
    const ringX = -LANE_RING_Y * u, nameX = -LANE_NAME_Y * u, dotX = -LANE_DOT_Y * u, ringR = LANE.ring * u;
    for (const [pid, f] of Object.entries(c.figs)) {
      const team = g?.roster?.[pid] ?? c.players?.[pid]?.team;
      const y = f.labelY ?? f.homeY;
      const me = pid === c.pid;
      ctx.strokeStyle = 'rgba(20,20,20,.25)'; ctx.lineWidth = u;
      ctx.beginPath(); ctx.moveTo(ringX + ringR, y); ctx.lineTo(0, f.homeY); ctx.stroke();

      // 名前
      ctx.fillStyle = INK;
      ctx.font = `${me ? 800 : 600} ${LANE.name * u}px ${MONO}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const name = (c.players?.[pid]?.name || '?').slice(0, 7);
      utext(ctx, name, nameX, y);
      ctx.fillStyle = teamColor(team);
      const nw = ctx.measureText(name).width;
      ctx.fillRect(nameX - (LANE.name / 2 + 2) * u, y - nw / 2, 2.5 * u, nw);

      if (play && g.roster?.[pid] != null) {
        const done = doneCount(g, pid) + (me ? c.pendingCount : 0);
        const N = g.stones;
        const per = LANE.perRow, gap = LANE.dotGap * u;
        for (let i = 0; i < N; i++) {
          const dy = y + ((i % per) - (Math.min(N, per) - 1) / 2) * gap, dx = dotX - Math.floor(i / per) * gap;
          ctx.beginPath(); ctx.arc(dx, dy, LANE.dot * u, 0, Math.PI * 2);
          if (i < done) { ctx.strokeStyle = 'rgba(20,20,20,.3)'; ctx.lineWidth = 1.3 * u; ctx.stroke(); }
          else { ctx.fillStyle = teamColor(team); ctx.fill(); }
          if (pid === g.hammerPid && i === N - 1) {
            ctx.strokeStyle = INK; ctx.lineWidth = 1.2 * u;
            ctx.beginPath(); ctx.arc(dx, dy, (LANE.dot + 2.5) * u, 0, Math.PI * 2); ctx.stroke();
          }
        }
        if (done < N) {
          const dl = deadlineFor(g, pid, done + 1);
          let frac = 1, label;
          if (dl === Infinity) label = 'H';
          else {
            const rem = (dl - now) / 1000;
            frac = Math.max(0, Math.min(1, rem / slotSec(g, pid, done + 1)));
            label = rem > 0 ? rem.toFixed(rem < 10 ? 1 : 0) : '0';
          }
          ctx.lineWidth = LANE.ringW * u;
          ctx.strokeStyle = 'rgba(20,20,20,.12)';
          ctx.beginPath(); ctx.arc(ringX, y, ringR, 0, Math.PI * 2); ctx.stroke();
          ctx.strokeStyle = frac < 0.3 ? WARN : INK;
          ctx.beginPath(); ctx.arc(ringX, y, ringR, 0, Math.PI * 2 * frac); ctx.stroke();
          ctx.fillStyle = frac < 0.3 ? WARN : INK; ctx.font = `800 ${LANE.time * u}px ${MONO}`;
          utext(ctx, label, ringX, y);
        }
      }
      ctx.textBaseline = 'alphabetic';
    }
  }

  drawFigures(ctx, c) {
    for (const [pid, f] of Object.entries(c.figs)) drawPerson(ctx, f, pid === c.pid);
  }

  // 他のプレイヤーが狙っている様子（うすく）
  drawOtherAims(ctx, c) {
    const g = c.game;
    if (!g || g.phase !== 'play') return;
    for (const [pid, a] of Object.entries(c.aims || {})) {
      if (pid === c.pid || !a?.d || g.roster?.[pid] == null) continue;
      const dx = Math.cos(a.a || 0), dy = Math.sin(a.a || 0);
      const x = SHEET.SPAWN_X, y = a.y;
      ctx.globalAlpha = 0.45;
      ctx.strokeStyle = teamColor(g.roster[pid]); ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(x + dx * R, y + dy * R);
      ctx.lineTo(x + dx * (R + GAUGE_LEN * (a.p || 0)), y + dy * (R + GAUGE_LEN * (a.p || 0))); ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }

  drawAim(ctx, c) {
    const g = c.game;
    if (!g || g.roster?.[c.pid] == null || g.phase !== 'play') return;
    const a = c.aim;
    const col = teamColor(g.roster[c.pid]);
    const x = SHEET.SPAWN_X, y = a.y;
    const can = c.myState?.ok;

    // ゴースト石
    ctx.globalAlpha = can ? 0.45 : 0.15;
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = col; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(x, y, R, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;

    // 回転表示（画面上方向から回転方向へ伸びる矢印）
    if (Math.abs(a.spin) > 0.001) {
      const sweep = a.spin * Math.PI * 1.4;
      const st = Math.PI;               // ワールドの -x 側＝画面下から
      ctx.strokeStyle = INK; ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y, R + 7, Math.min(st, st + sweep), Math.max(st, st + sweep));
      ctx.stroke();
      const ea = st + sweep;
      const ex = x + Math.cos(ea) * (R + 7), ey = y + Math.sin(ea) * (R + 7);
      const dir = Math.sign(a.spin);
      const tx = -Math.sin(ea) * dir, ty = Math.cos(ea) * dir;
      ctx.beginPath();
      ctx.moveTo(ex + tx * 5, ey + ty * 5);
      ctx.lineTo(ex - tx * 2 + Math.cos(ea) * 4, ey - ty * 2 + Math.sin(ea) * 4);
      ctx.lineTo(ex - tx * 2 - Math.cos(ea) * 4, ey - ty * 2 - Math.sin(ea) * 4);
      ctx.closePath(); ctx.fillStyle = INK; ctx.fill();
    }

    if (!a.dragging) return;
    ctx.textBaseline = 'middle';
    if (!a.valid) {
      ctx.fillStyle = 'rgba(20,20,20,.55)'; ctx.font = `600 ${12 * this.u}px ${MONO}`; ctx.textAlign = 'center';
      utext(ctx, '↓ 下に引いて狙う', x + R + 16 * this.u, y);
      ctx.textBaseline = 'alphabetic';
      return;
    }
    const dx = Math.cos(a.angle), dy = Math.sin(a.angle);
    const nx = -dy, ny = dx;                 // ゲージに垂直（画面では右側）
    const at = d => [x + dx * d, y + dy * d];

    // ゴム（引いている側）
    const back = 18 + a.power * 50;
    ctx.strokeStyle = INK; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(...at(-R)); ctx.lineTo(...at(-R - back)); ctx.stroke();
    ctx.beginPath(); ctx.arc(...at(-R - back), 4, 0, Math.PI * 2); ctx.fillStyle = INK; ctx.fill();

    // 向き＋強さのゲージ（直線のみ。カールは自分で読む）
    const s0 = R + 8, L = GAUGE_LEN, gu = this.u;
    ctx.setLineDash([5 * gu, 5 * gu]);
    ctx.strokeStyle = 'rgba(20,20,20,.4)'; ctx.lineWidth = 1.5 * gu;
    ctx.beginPath(); ctx.moveTo(...at(s0)); ctx.lineTo(...at(s0 + L)); ctx.stroke();
    ctx.setLineDash([]);
    ctx.strokeStyle = col; ctx.lineWidth = 6 * gu;
    ctx.beginPath(); ctx.moveTo(...at(s0)); ctx.lineTo(...at(s0 + L * a.power)); ctx.stroke();
    // 目盛り（10%ごと。20% と 90% は長め）
    for (let i = 0; i <= 10; i++) {
      const [px, py] = at(s0 + L * i / 10);
      const major = i === 2 || i === 9;
      const hl = (major ? 8 : (i % 5 === 0 ? 6 : 4)) * gu;
      ctx.strokeStyle = major ? INK : 'rgba(20,20,20,.5)';
      ctx.lineWidth = (major ? 1.8 : 1.1) * gu;
      ctx.beginPath(); ctx.moveTo(px - nx * hl, py - ny * hl); ctx.lineTo(px + nx * hl, py + ny * hl); ctx.stroke();
    }
    // 先端の矢じり
    const [hx, hy] = at(s0 + L + 2);
    ctx.fillStyle = 'rgba(20,20,20,.45)';
    ctx.beginPath(); ctx.moveTo(hx + dx * 9 * gu, hy + dy * 9 * gu); ctx.lineTo(hx + nx * 5 * gu, hy + ny * 5 * gu); ctx.lineTo(hx - nx * 5 * gu, hy - ny * 5 * gu); ctx.closePath(); ctx.fill();
    // 現在値のマーカーと数値
    const [mx, my] = at(s0 + L * a.power);
    ctx.beginPath(); ctx.arc(mx, my, 5 * gu, 0, Math.PI * 2);
    ctx.fillStyle = SHEET_C; ctx.fill(); ctx.strokeStyle = INK; ctx.lineWidth = 2 * gu; ctx.stroke();
    ctx.fillStyle = INK; ctx.textAlign = 'left';
    const u = this.u;
    ctx.font = `800 ${15 * u}px ${MONO}`;
    utext(ctx, `${(a.power * 100).toFixed(1)}%`, mx + nx * 12 * u, my + ny * 12 * u);
    ctx.font = `500 ${10 * u}px ${MONO}`;
    utext(ctx, `${(a.angle * 180 / Math.PI).toFixed(2)}°${a.fine ? ' FINE' : ''}`, mx + nx * 12 * u - 14 * u, my + ny * 12 * u);
    ctx.textBaseline = 'alphabetic';
  }

  drawParticles(ctx, c) {
    for (const p of c.fx.particles) {
      ctx.globalAlpha = Math.max(0, 1 - p.t / p.max);
      if (p.kind === 'spark') {
        ctx.strokeStyle = p.color; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x - p.vx * 0.04, p.y - p.vy * 0.04); ctx.stroke();
      } else {
        ctx.fillStyle = p.color;
        ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
      }
    }
    for (const r of c.fx.rings) {
      const k = r.t / r.max;
      ctx.globalAlpha = Math.max(0, 1 - k);
      ctx.strokeStyle = r.color; ctx.lineWidth = 3 * (1 - k) + 0.5;
      ctx.beginPath(); ctx.arc(r.x, r.y, R + k * r.size, 0, Math.PI * 2); ctx.stroke();
    }
    for (const f of c.fx.floats) {
      const k = f.t / f.max;
      ctx.globalAlpha = Math.max(0, 1 - k);
      ctx.fillStyle = f.color; ctx.font = `800 ${(f.size || 14) * this.u}px ${FONT}`; ctx.textAlign = 'center';
      utext(ctx, f.text, f.x + k * 30 * this.u, f.y);
    }
    ctx.globalAlpha = 1;
  }

  // ------------------------------------------------------------ HUD（画面座標）
  drawScores(ctx, c, x0, y0, w, horizontal) {
    const g = c.game;
    if (!g) return;
    ctx.textAlign = 'left';
    ctx.fillStyle = INK;
    ctx.font = `800 13px ${MONO}`;
    ctx.fillText(g.status === 'finished' ? 'FINAL' : `END ${g.end} / ${g.totalEnds}`, x0, y0);
    ctx.font = `500 11px ${MONO}`;
    ctx.fillStyle = 'rgba(20,20,20,.55)';
    if (!horizontal) ctx.fillText(`${g.stones} STONES · ${g.interval}s`, x0, y0 + 18);

    const teams = g.teams || [];
    const row = (t, x, y, cw) => {
      ctx.fillStyle = teamColor(t);
      ctx.fillRect(x, y - 26, 4, 36);
      ctx.fillStyle = INK;
      ctx.font = `900 ${horizontal ? 24 : 30}px ${FONT}`;
      ctx.textAlign = 'left';
      const sc = String(g.scores?.[tk(t)] ?? 0);
      ctx.fillText(sc, x + 12, y);
      const scW = ctx.measureText(sc).width;
      if (g.hammer === t) {
        ctx.fillRect(x + 18 + scW, y - 18, 16, 16);
        ctx.fillStyle = SHEET_C; ctx.font = `800 10px ${MONO}`; ctx.textAlign = 'center';
        ctx.fillText('H', x + 26 + scW, y - 6);
        ctx.textAlign = 'left';
      }
      ctx.font = `600 10px ${MONO}`;
      ctx.fillStyle = 'rgba(20,20,20,.65)';
      const label = c.teamLabel(t);
      ctx.fillText(label.slice(0, Math.max(4, Math.floor(cw / 7))), x + 12, y + 13);
    };
    if (horizontal) {
      // 縦長画面: 合計つきの点数表だけ出す
      this.drawEndTable(ctx, c, x0, y0 + 12, w);
    } else {
      // 横長画面: 大きな合計 + その下にエンドごとの点数表
      const tableH = 22 + teams.length * 19;
      const avail = this.h - 270 - (y0 + 70) - tableH - 16;
      const rowH = Math.max(40, Math.min(52, avail / Math.max(1, teams.length)));
      teams.forEach((t, i) => row(t, x0, y0 + 70 + i * rowH, w));
      this.drawEndTable(ctx, c, x0, y0 + 70 + teams.length * rowH - 10, w);
    }
  }

  // エンドごとの点数表（行=チーム、列=エンド、最後に合計）。描いた高さを返す
  drawEndTable(ctx, c, x0, y0, w) {
    const g = c.game;
    const teams = g?.teams || [];
    if (!teams.length) return 0;
    const n = g.totalEnds || 1;
    const hist = g.history || [];
    const labelW = Math.min(72, w * 0.28), totW = 30;
    const cw = Math.max(12, Math.min(26, (w - labelW - totW) / n));
    const rh = 19, hh = 18;
    const tableW = labelW + cw * n + totW;
    const cur = g.status === 'playing' ? g.end - 1 : -1;   // 進行中のエンドの列
    ctx.save();
    ctx.textBaseline = 'middle';
    // 進行中のエンドの列を薄く塗る
    if (cur >= 0 && cur < n) {
      ctx.fillStyle = 'rgba(20,20,20,.07)';
      ctx.fillRect(x0 + labelW + cur * cw, y0, cw, hh + rh * teams.length);
    }
    // 見出し
    ctx.fillStyle = 'rgba(20,20,20,.55)';
    ctx.font = `600 10px ${MONO}`;
    ctx.textAlign = 'center';
    for (let i = 0; i < n; i++) ctx.fillText(String(i + 1), x0 + labelW + cw * (i + 0.5), y0 + hh / 2);
    ctx.fillText('計', x0 + labelW + cw * n + totW / 2, y0 + hh / 2);
    ctx.strokeStyle = INK; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x0, y0 + hh); ctx.lineTo(x0 + tableW, y0 + hh); ctx.stroke();

    teams.forEach((t, r) => {
      const y = y0 + hh + rh * r;
      const cy = y + rh / 2;
      ctx.fillStyle = teamColor(t);
      ctx.fillRect(x0, y + 4, 3, rh - 8);
      ctx.fillStyle = INK; ctx.textAlign = 'left';
      ctx.font = `600 10px ${MONO}`;
      ctx.fillText(c.teamLabel(t).slice(0, Math.max(3, Math.floor((labelW - 8) / 6.2))), x0 + 7, cy);
      for (let i = 0; i < n; i++) {
        const cx = x0 + labelW + cw * (i + 0.5);
        const h = hist[i];
        // ハンマーを持っていたチームに小さな印
        const hammer = h ? h.hammer : (i === cur ? g.hammer : null);
        if (hammer === t) {
          ctx.fillStyle = INK;
          ctx.beginPath(); ctx.arc(x0 + labelW + cw * i + 3.5, y + 4.5, 2.2, 0, Math.PI * 2); ctx.fill();
        }
        if (!h) continue;
        ctx.textAlign = 'center';
        if (h.team === t && h.points > 0) {
          ctx.fillStyle = INK; ctx.font = `800 12px ${MONO}`;
          ctx.fillText(String(h.points), cx, cy);
        } else {
          ctx.fillStyle = 'rgba(20,20,20,.3)'; ctx.font = `500 11px ${MONO}`;
          ctx.fillText('0', cx, cy);
        }
      }
      ctx.textAlign = 'center';
      ctx.fillStyle = INK; ctx.font = `900 13px ${FONT}`;
      ctx.fillText(String(g.scores?.[tk(t)] ?? 0), x0 + labelW + cw * n + totW / 2, cy);
      ctx.strokeStyle = 'rgba(20,20,20,.12)';
      ctx.beginPath(); ctx.moveTo(x0, y + rh); ctx.lineTo(x0 + tableW, y + rh); ctx.stroke();
    });
    // 合計の区切り
    ctx.strokeStyle = 'rgba(20,20,20,.35)';
    const sx = x0 + labelW + cw * n + 0.5;
    ctx.beginPath(); ctx.moveTo(sx, y0); ctx.lineTo(sx, y0 + hh + rh * teams.length); ctx.stroke();
    ctx.restore();
    return hh + rh * teams.length;
  }

  drawStatus(ctx, c, x0, y0, w) {
    const g = c.game;
    ctx.textAlign = 'left';
    if (!g || g.roster?.[c.pid] == null) {
      if (g && g.status === 'playing') {
        ctx.fillStyle = INK; ctx.font = `700 13px ${MONO}`;
        ctx.fillText('観戦中 — 次のエンドから参加', x0, y0 + 20);
      }
      return;
    }
    const col = teamColor(g.roster[c.pid]);
    const N = g.stones;
    const st = g.stats?.[c.pid] || { t: 0, l: 0 };
    const thrown = st.t + c.pendingCount;
    const done = thrown + st.l;
    const compact = !this.land;

    // 石
    ctx.fillStyle = INK; ctx.font = `700 11px ${MONO}`;
    ctx.fillText('STONES', x0, y0);
    const sr = compact ? 6 : 8, sg = compact ? 17 : 22;
    for (let i = 0; i < N; i++) {
      const cx = x0 + sr + i * sg, cy = y0 + 18;
      ctx.beginPath(); ctx.arc(cx, cy, sr, 0, Math.PI * 2);
      if (i < thrown) { ctx.strokeStyle = 'rgba(20,20,20,.3)'; ctx.lineWidth = 1.5; ctx.stroke(); }
      else if (i < done) {
        ctx.strokeStyle = WARN; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(cx - sr * 0.7, cy - sr * 0.7); ctx.lineTo(cx + sr * 0.7, cy + sr * 0.7);
        ctx.moveTo(cx + sr * 0.7, cy - sr * 0.7); ctx.lineTo(cx - sr * 0.7, cy + sr * 0.7); ctx.stroke();
      } else { ctx.fillStyle = col; ctx.fill(); ctx.strokeStyle = INK; ctx.lineWidth = 1.2; ctx.stroke(); }
      if (c.pid === g.hammerPid && i === N - 1) {
        ctx.fillStyle = INK; ctx.font = `800 9px ${MONO}`; ctx.textAlign = 'center';
        ctx.fillText('H', cx, cy + sr + 11); ctx.textAlign = 'left';
      }
    }

    // タイマー
    let text, frac = 0, warn = false;
    const ms = c.myState;
    if (g.phase !== 'play') text = '—';
    else if (ms?.why === 'countdown') text = 'READY';
    else if (done >= N) text = 'DONE';
    else if (ms?.why === 'hammer') text = 'HAMMER 待機';
    else {
      const rem = (deadlineFor(g, c.pid, done + 1) - c.now) / 1000;
      frac = Math.max(0, Math.min(1, rem / slotSec(g, c.pid, done + 1)));
      warn = rem < 3;
      text = `${Math.max(0, rem).toFixed(1)}s`;
    }
    const tx = compact ? x0 + Math.max(N * sg, 70) + 18 : x0;
    const ty = compact ? y0 : y0 + 62;
    ctx.fillStyle = INK; ctx.font = `700 11px ${MONO}`;
    ctx.fillText('NEXT', tx, ty);
    ctx.font = `900 ${compact ? 22 : 30}px ${FONT}`;
    ctx.fillStyle = warn ? WARN : INK;
    ctx.fillText(text, tx, ty + (compact ? 26 : 32));
    const bw = compact ? 110 : w;
    ctx.fillStyle = 'rgba(20,20,20,.1)';
    ctx.fillRect(tx, ty + (compact ? 34 : 42), bw, 4);
    ctx.fillStyle = warn ? WARN : INK;
    ctx.fillRect(tx, ty + (compact ? 34 : 42), bw * frac, 4);

    // パワー
    const px = compact ? tx + bw + 20 : x0;
    const py = compact ? y0 : y0 + 124;
    const gw = compact ? Math.max(80, x0 + w - px) : w;
    ctx.fillStyle = INK; ctx.font = `700 11px ${MONO}`;
    ctx.fillText('POWER', px, py);
    ctx.fillStyle = 'rgba(20,20,20,.08)';
    ctx.fillRect(px, py + 10, gw, 12);
    const dragging = c.aim.dragging && c.aim.valid;
    if (dragging) { ctx.fillStyle = col; ctx.fillRect(px, py + 10, gw * c.aim.power, 12); }
    if (c.lastPower != null) { ctx.fillStyle = INK; ctx.fillRect(px + gw * c.lastPower - 1, py + 6, 2, 20); }
    for (let i = 1; i < 10; i++) {
      ctx.fillStyle = i === 2 || i === 9 ? INK : 'rgba(20,20,20,.35)';
      ctx.fillRect(px + gw * i / 10, py + 16, 1, i === 2 || i === 9 ? 10 : 6);
    }
    ctx.fillStyle = INK; ctx.font = `700 12px ${MONO}`;
    const pw = dragging ? c.aim.power : (c.lastPower ?? 0);
    const sp = c.aim.spin;
    const spinTxt = `SPIN ${sp === 0 ? '0' : (sp > 0 ? '↻' : '↺') + Math.round(Math.abs(sp) * 100) + '%'}`;
    const posTxt = `POS ${(c.aim.y - SHEET.CY >= 0 ? '+' : '') + (c.aim.y - SHEET.CY).toFixed(0)}`;
    ctx.fillText(`${(pw * 100).toFixed(1)}%`, px, py + 40);
    if (compact) {
      ctx.fillText(spinTxt, px + 66, py + 40);
      ctx.fillText(posTxt, px, py + 58);
    } else {
      ctx.fillText(spinTxt, px + 80, py + 40);
      ctx.fillText(posTxt, px + 170, py + 40);
    }
  }

  drawHelp(ctx, x, y) {
    ctx.textAlign = 'left';
    ctx.fillStyle = 'rgba(20,20,20,.55)';
    ctx.font = `500 11px ${MONO}`;
    [
      '位置     マウス左右 ／ A D で微調整',
      '投げる   押して下へ引き、離す',
      '         （Shift: 精密）',
      '回転     ホイール ／ Q E（R リセット）',
      'スイープ Space 長押し',
      'キャンセル 右クリック ／ Esc（引いている途中）',
      '軌跡     T で表示／非表示',
    ].forEach((t, i) => ctx.fillText(t, x, y + i * 18));
  }

  // 技の演出: シートの少し横に出し、対象の石と線で結ぶ
  drawBanners(ctx, c) {
    const s = this.scale;
    const sheetL = this.ox, sheetR = this.ox + SHEET.W * s, sheetW = SHEET.W * s;
    const top = this.area.y + 50, bottom = this.area.y + this.area.h - 60;
    const maxW = this.land ? this.area.w * 0.5 + this.panelR - 24 : this.w - 24;
    const placed = [];
    for (const b of c.fx.banners) {
      const t = b.t;
      const k = t < 0.25 ? easeOutBack(t / 0.25) : 1;
      const alpha = Math.max(0, Math.min(1, (b.max - t) / 0.4));
      const size = b.size;
      ctx.font = `italic 900 ${size}px ${FONT}`;
      const tw = ctx.measureText(b.text).width;
      const pad = size * 0.35, sk = size * 0.25;
      const fit = Math.min(1, maxW / (tw + pad * 2 + sk * 2));
      const bw = (tw + pad * 2 + sk * 2) * fit;
      const above = size * 0.78 * fit, below = (b.note ? size * 1.05 : b.sub ? size * 0.75 : size * 0.22) * fit;

      // 対象の石（動いていれば追従、消えたら最後の位置）
      let A = null;
      if (b.anchor) {
        const st = b.anchor.id && c.world.get(b.anchor.id);
        if (st && !st.out) { b.anchor.x = st.x + st.ox; b.anchor.y = st.y + st.oy; }
        A = this.toScreen(b.anchor.x, b.anchor.y);
      }
      // 横長画面: 右側（左は得点パネルがあるので）。縦長画面: 石と反対側（石を隠さないように）
      const toLeft = !this.land && A && A.x > sheetL + sheetW / 2;
      let cx = toLeft ? sheetL + sheetW * 0.2 - bw / 2 : sheetR - sheetW * 0.2 + bw / 2;
      cx = Math.max(bw / 2 + 8, Math.min(this.w - bw / 2 - 8, cx));
      let cy = A ? A.y - 50 : this.toScreen((SHEET.NEAR_HOG + SHEET.FAR_HOG) / 2, 0).y;
      cy = Math.max(top + above, Math.min(bottom - below, cy));
      // 先に出ている演出と重ならないように下へずらす
      for (let i = 0; i < 4; i++) {
        const hit = placed.find(r => Math.abs(r.cx - cx) < (r.bw + bw) / 2 && cy - above < r.y1 && cy + below > r.y0);
        if (!hit) break;
        cy = hit.y1 + above + 6;
      }
      placed.push({ cx, bw, y0: cy - above, y1: cy + below });

      ctx.save();
      ctx.globalAlpha = alpha;
      // 引き出し線
      if (A && t > 0.08) {
        const fromTop = A.y < cy - above;
        const sx = Math.max(cx - bw / 2 + 12, Math.min(cx + bw / 2 - 12, A.x));
        const sy = fromTop ? cy - above : cy + size * 0.22 * fit;
        const dx = A.x - sx, dy = A.y - sy, d = Math.hypot(dx, dy) || 1;
        const rr = (R + 6) * s;
        ctx.strokeStyle = INK; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(A.x - dx / d * rr, A.y - dy / d * rr); ctx.stroke();
        ctx.beginPath(); ctx.arc(sx, sy, 3.5, 0, Math.PI * 2); ctx.fillStyle = INK; ctx.fill();
        ctx.strokeStyle = b.color; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(A.x, A.y, rr, 0, Math.PI * 2); ctx.stroke();
      }
      ctx.translate(cx, cy);
      const sc = (0.4 + 0.6 * k + (t < 0.25 ? (1 - t / 0.25) * 0.8 : 0)) * fit;
      ctx.scale(sc, sc);
      // 色の帯
      ctx.fillStyle = b.color;
      ctx.beginPath();
      ctx.moveTo(-tw / 2 - pad + sk, -size * 0.78);
      ctx.lineTo(tw / 2 + pad + sk, -size * 0.78);
      ctx.lineTo(tw / 2 + pad - sk, size * 0.22);
      ctx.lineTo(-tw / 2 - pad - sk, size * 0.22);
      ctx.closePath(); ctx.fill();
      ctx.textAlign = 'center';
      ctx.lineWidth = Math.max(3, size / 10);
      ctx.strokeStyle = INK;
      ctx.strokeText(b.text, 4, 4);
      ctx.fillStyle = INK;
      ctx.fillText(b.text, 4, 4);
      ctx.fillStyle = '#fff';
      ctx.fillText(b.text, 0, 0);
      if (b.sub) {
        ctx.font = `700 ${Math.round(size * 0.3)}px ${MONO}`;
        ctx.fillStyle = INK;
        ctx.fillText(b.sub, 0, size * 0.62);
      }
      if (b.note) {
        // 小さな説明（例: スティールの意味）
        ctx.font = `600 ${Math.round(size * 0.22)}px ${FONT}`;
        ctx.fillStyle = 'rgba(20,20,20,.7)';
        ctx.fillText(`（${b.note}）`, 0, size * (b.sub ? 0.95 : 0.62));
      }
      ctx.restore();
    }
  }

  drawCenter(ctx, c) {
    const g = c.game;
    if (!g) return;
    const mid = this.toScreen((SHEET.NEAR_HOG + SHEET.FAR_HOG) / 2, SHEET.CY);
    const cx = mid.x, cy = mid.y;
    const maxW = this.area.w - 8;
    ctx.textAlign = 'center';
    // 冴えわたりの説明（ドラッグ前から常に表示）
    //   ・ハンマータイムの間 → 全員の画面に、ハンマーの人の一投として
    //   ・自分が最後の一投を投げる番 → 自分の画面に
    const hammerTime = g.phase === 'play' && g.hammerUnlockAt && g.hammerPid && doneCount(g, g.hammerPid) === g.stones - 1;
    const myLast = c.myState?.ok && c.myState.done === g.stones - 1;
    const subject = hammerTime ? g.hammerPid : (myLast ? c.pid : null);
    if (subject) {
      const hp = { pid: subject, team: g.roster?.[subject] };
      const name = subject === c.pid ? 'あなた' : (c.players?.[subject]?.name || '?');
      const aimingNow = (c.previews || []).some(p => p.pid === subject);
      const what = hammerTime ? '最後の一投（ハンマー）' : '最後の一投';
      const l1 = '冴えわたり';
      const who = subject === c.pid ? name : name + ' ';
      const l2 = aimingNow ? `${who}の${what}を予測中` : `${who}の${what}`;
      const l3 = '狙っている間、投げた結果が予測で見える';
      ctx.font = `italic 900 24px ${FONT}`; const w1 = ctx.measureText(l1).width;
      ctx.font = `700 12px ${MONO}`; const w2 = ctx.measureText(l2).width;
      ctx.font = `600 11px ${FONT}`; const w3 = ctx.measureText(l3).width;
      // 横長画面: 右パネルの上（シート上の狙いゲージや予測を隠さない）。縦長画面: シートの中ほどの少し下
      const bw = this.land ? this.panelR - 40 : Math.min(maxW, Math.max(w1, w2, w3) + 36), bh = 78;
      const bx = this.land ? this.w - this.panelR + 16 : cx - bw / 2;
      const by = this.land ? 64 : cy + 40;
      const pcx = bx + bw / 2;
      ctx.save();
      ctx.globalAlpha = 0.92;
      ctx.fillStyle = SHEET_C; ctx.fillRect(bx, by, bw, bh);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = INK; ctx.lineWidth = 2; ctx.strokeRect(bx, by, bw, bh);
      ctx.fillStyle = teamColor(hp.team); ctx.fillRect(bx, by, 6, bh);
      ctx.fillStyle = INK;
      ctx.font = `italic 900 24px ${FONT}`; ctx.fillText(l1, pcx + 3, by + 30);
      ctx.font = `700 12px ${MONO}`; ctx.fillText(l2, pcx + 3, by + 50);
      ctx.fillStyle = 'rgba(20,20,20,.65)';
      ctx.font = `600 11px ${FONT}`; ctx.fillText(l3, pcx + 3, by + 67);
      ctx.restore();
      ctx.textAlign = 'center';
    }
    if (g.phase === 'play' && c.now < g.endStartAt) {
      const rem = (g.endStartAt - c.now) / 1000;
      ctx.fillStyle = 'rgba(20,20,20,.85)';
      ctx.font = `900 22px ${MONO}`;
      ctx.fillText(`END ${g.end}`, cx, cy - 70);
      ctx.font = `italic 900 110px ${FONT}`;
      ctx.fillText(rem > 0.5 ? String(Math.ceil(rem - 0.5)) : 'GO', cx, cy + 30);
      ctx.font = `600 12px ${MONO}`;
      const hn = c.teamLabel(g.hammer), pn = c.hammerName();
      ctx.fillText(`HAMMER（最後の一投）`, cx, cy + 66);
      ctx.font = `800 14px ${MONO}`;
      ctx.fillText(`${hn}${pn !== hn ? ' · ' + pn : ''}`, cx, cy + 86);
    }
    if (g.phase === 'result' && g.result) {
      const r = g.result;
      const text = r.team < 0 ? 'BLANK END' : `${c.teamLabel(r.team)}  +${r.points}`;
      let size = 48;
      ctx.font = `italic 900 ${size}px ${FONT}`;
      let tw = ctx.measureText(text).width;
      if (tw + 40 > maxW) { size = Math.max(20, size * (maxW - 40) / tw); ctx.font = `italic 900 ${size}px ${FONT}`; tw = ctx.measureText(text).width; }
      ctx.fillStyle = r.team < 0 ? SHEET_C : teamColor(r.team);
      ctx.fillRect(cx - tw / 2 - 20, cy - size, tw + 40, size * 1.4);
      ctx.strokeStyle = INK; ctx.lineWidth = 3;
      ctx.strokeRect(cx - tw / 2 - 20, cy - size, tw + 40, size * 1.4);
      ctx.fillStyle = INK;
      ctx.fillText(text, cx, cy + size * 0.12);
      ctx.font = `600 12px ${MONO}`;
      const nx = g.end >= g.totalEnds ? '最終結果へ…' : `次のハンマー: ${c.teamLabel(g.hammer)}`;
      ctx.fillText(nx, cx, cy + size * 0.4 + 24);
    }
    if (c.toast && c.toast.t < c.toast.max) {
      ctx.globalAlpha = Math.min(1, (c.toast.max - c.toast.t) / 0.3);
      ctx.font = `700 13px ${MONO}`;
      const tw = ctx.measureText(c.toast.text).width;
      const tx = this.ox + SHEET.W / 2 * this.scale;
      const ty = this.toScreen(SHEET.NEAR_HOG - 10, 0).y;
      ctx.fillStyle = INK;
      ctx.fillRect(tx - tw / 2 - 12, ty - 19, tw + 24, 28);
      ctx.fillStyle = SHEET_C;
      ctx.fillText(c.toast.text, tx, ty);
      ctx.globalAlpha = 1;
    }
  }
}

function easeOutBack(t) {
  const c1 = 1.70158, c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

export function drawStone(ctx, x, y, r, team, angle) {
  ctx.beginPath(); ctx.ellipse(x + 2, y + 3, r, r, 0, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0,0,0,.1)'; ctx.fill();
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = teamColor(team); ctx.fill();
  ctx.strokeStyle = INK; ctx.lineWidth = 1.5; ctx.stroke();
  ctx.beginPath(); ctx.arc(x, y, r * 0.64, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(255,255,255,.75)'; ctx.lineWidth = 1.5; ctx.stroke();
  ctx.save();
  ctx.translate(x, y); ctx.rotate(angle || 0);
  ctx.strokeStyle = INK; ctx.lineWidth = 3.2; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(-r * 0.42, 0); ctx.lineTo(r * 0.3, 0); ctx.stroke();
  ctx.restore();
  ctx.lineCap = 'butt';
}

// ------------------------------------------------------------ 人物（線だけ・中は透明）
function capsule(ctx, x1, y1, x2, y2, r) {
  const a = Math.atan2(y2 - y1, x2 - x1);
  ctx.moveTo(x2 + Math.cos(a - Math.PI / 2) * r, y2 + Math.sin(a - Math.PI / 2) * r);
  ctx.arc(x2, y2, r, a - Math.PI / 2, a + Math.PI / 2);
  ctx.arc(x1, y1, r, a + Math.PI / 2, a + Math.PI * 1.5);
  ctx.closePath();
}

// 人物は「線だけ・中は透明」。パーツの和集合の輪郭だけを描くため、
// オフスクリーンで塗りつぶし → 内側に縮めた形で抜く。
const figCanvas = document.createElement('canvas');
const figCtx = figCanvas.getContext('2d');
const FIG_SCALE = 1.45;
const FB = { x0: -52, y0: -46, w: 112, h: 92 }; // ローカル座標の描画範囲

function personParts(f) {
  const t = performance.now() / 1000;
  const P = [];
  const cap = (x1, y1, x2, y2, r) => P.push([x1, y1, x2, y2, r]);
  const dot = (x, y, r) => P.push([x, y, x, y, r]);
  if (f.pose === 'sweep') {
    const st = Math.sin(t * 13);
    const sd = -(f.side || 1); // 石のある側
    cap(-6, -4, -22 + st * 7, -6, 3.6);          // 脚
    cap(-6, 4, -22 - st * 7, 6, 3.6);
    cap(-3, -11, -3, 11, 6.5);                    // 肩
    dot(3, 0, 7);                                 // 頭
    const bx = 46 + st * 3, by = sd * (29 + st * 2);
    cap(-1, sd * 9, 14, sd * 13, 2.6);           // 腕
    cap(-1, -sd * 9, 12, sd * 4, 2.6);
    cap(6, sd * 4, bx, by, 1.3);                  // 柄
    cap(bx, by - 8, bx + 1, by + 8, 3.4);         // ブラシ
  } else {
    const L = f.lunge || 0, fx = L * 8;
    cap(-9 + fx, 5, -42 + fx * 0.3, 9, 3.8);      // 後ろ脚（伸ばす）
    cap(-9 + fx, -5, 7 + fx, -14, 4.2);           // 前脚（曲げる）
    cap(-4 + fx, -12, -4 + fx, 12, 7);            // 肩
    cap(-2 + fx, 9, 21 + fx, 2, 2.7);             // 腕（石へ）
    cap(-2 + fx, -10, 9 + fx, -22, 2.7);          // 腕（ブラシ）
    cap(9 + fx, -22, -24 + fx, -28, 1.3);         // 柄
    cap(-27 + fx, -35, -25 + fx, -21, 3.2);       // ブラシ
    dot(5 + fx, 0, 7.5);                          // 頭
  }
  return P;
}

function drawPerson(ctx, f, me) {
  const m = ctx.getTransform();
  const px = Math.hypot(m.a, m.b) * FIG_SCALE;    // ローカル1単位あたりのピクセル（回転していても）
  const W = Math.ceil(FB.w * px), H = Math.ceil(FB.h * px);
  if (figCanvas.width < W || figCanvas.height < H) { figCanvas.width = W; figCanvas.height = H; }
  const c = figCtx;
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.clearRect(0, 0, W, H);
  c.setTransform(px, 0, 0, px, -FB.x0 * px, -FB.y0 * px);
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const lw = (me ? 2.1 : 1.6) * dpr / px;
  const parts = personParts(f);
  const fillParts = shrink => {
    c.beginPath();
    for (const [x1, y1, x2, y2, r] of parts) {
      const rr = r - shrink;
      if (rr <= 0) continue;
      if (x1 === x2 && y1 === y2) { c.moveTo(x1 + rr, y1); c.arc(x1, y1, rr, 0, Math.PI * 2); }
      else capsule(c, x1, y1, x2, y2, rr);
    }
    c.fill('nonzero');
  };
  c.globalCompositeOperation = 'source-over';
  c.fillStyle = INK;
  fillParts(0);
  c.globalCompositeOperation = 'destination-out';
  fillParts(lw);
  c.globalCompositeOperation = 'source-over';

  ctx.save();
  ctx.translate(f.x, f.y);
  ctx.drawImage(figCanvas, 0, 0, W, H, FB.x0 * FIG_SCALE, FB.y0 * FIG_SCALE, FB.w * FIG_SCALE, FB.h * FIG_SCALE);
  ctx.restore();
}

export { teamName, PHYS };
