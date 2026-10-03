// 結果発表: エンド1から順に、最終盤面と得点を効果音つきで1つずつ出し、最後に勝者を出す
import { SHEET, STONE_R, RULES, teamColor } from './config.js';
import { tk } from './rules.js';
import { sfx } from './sfx.js';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// 盤面の切り取り: ハウスの少し手前（ガードの石が見える所）からバックラインの少し先まで（ティーが上）
const TOP = SHEET.BACK_X + 20;
const BOTTOM = SHEET.TEE_X - SHEET.HOUSE_R - 140;

// エンドの最終盤面（得点した石は黒い縁と番号つき）
function boardSvg(board) {
  const { W, CY, TEE_X, RINGS, BUTTON_R } = SHEET;
  const Y = x => TOP - x;
  const rings = [[RINGS[0], '#ECEBE7'], [RINGS[1], '#FBFBF9'], [RINGS[2], '#ECEBE7']]
    .map(([r, c]) => `<circle cx="${CY}" cy="${Y(TEE_X)}" r="${r}" fill="${c}" stroke="rgba(20,20,20,.5)" stroke-width="4"/>`).join('');
  let n = 0;
  const stones = (board || []).filter(([x]) => x <= TOP + STONE_R && x >= BOTTOM - STONE_R)
    .sort((a, b) => a[3] - b[3])   // 得点した石を上に重ねる
    .map(([x, y, team, scored]) => {
      const c = `<circle cx="${y}" cy="${Y(x)}" r="${STONE_R}" fill="${teamColor(team)}" stroke="#141414" stroke-width="${scored ? 9 : 3}"/>`;
      return scored ? c + `<text x="${y}" y="${Y(x) + 13}" class="sn">${++n}</text>` : c;
    }).join('');
  return `<svg viewBox="0 0 ${W} ${TOP - BOTTOM}" class="fn-board" style="aspect-ratio: ${W} / ${TOP - BOTTOM}" aria-hidden="true">
    <rect width="${W}" height="${TOP - BOTTOM}" fill="#FBFBF9"/>${rings}
    <circle cx="${CY}" cy="${Y(TEE_X)}" r="${BUTTON_R}" fill="#FBFBF9" stroke="rgba(20,20,20,.5)" stroke-width="4"/>
    <line x1="0" x2="${W}" y1="${Y(SHEET.BACK_X)}" y2="${Y(SHEET.BACK_X)}" stroke="rgba(20,20,20,.5)" stroke-width="4"/>
    <line x1="0" x2="${W}" y1="${Y(TEE_X)}" y2="${Y(TEE_X)}" stroke="rgba(20,20,20,.3)" stroke-width="3"/>
    <line x1="${CY}" x2="${CY}" y1="0" y2="${TOP - BOTTOM}" stroke="rgba(20,20,20,.3)" stroke-width="3"/>
    ${stones}</svg>`;
}

// エンドの種類: スティール（ハンマーのないチームの得点）／ビッグエンド／ブランク（0点）
function endKind(h) {
  const tags = [];
  if (h.team < 0 || !h.points) tags.push(['blank', 'ブランク']);
  if (h.team >= 0 && h.points > 0 && h.team !== h.hammer) tags.push(['steal', 'スティール！！']);
  if (h.team >= 0 && h.points >= RULES.BIG_END) tags.push(['big', 'ビッグエンド！！！']);
  return tags;
}

// el に結果発表を描いて演出を始める。止める関数を返す
export function playFinale(el, { game, teamLabel, actions }) {
  const g = game;
  const hist = g.history || [];
  const teams = g.teams || [];
  const timers = [];
  const later = (ms, fn) => timers.push(setTimeout(fn, ms));
  const totals = Object.fromEntries(teams.map(t => [t, 0]));
  const finalOf = t => g.scores?.[tk(t)] || 0;
  const top = Math.max(0, ...teams.map(finalOf));
  const winners = teams.filter(t => finalOf(t) === top);

  el.innerHTML = `
    <div class="fn-head"><div class="final-title" id="fn-title">RESULT</div><button id="fn-skip" class="mini ghost">スキップ</button></div>
    <ol class="standings">${teams.map(t => `
      <li style="--c:${teamColor(t)}" data-team="${t}">
        <span class="sw"></span><span class="nm">${esc(teamLabel(t))}</span>
        <span class="ends">${hist.map((_, i) => `<em data-end="${i}"></em>`).join('')}</span>
        <b class="tot">0</b></li>`).join('')}
    </ol>
    <div class="fn-ends">${hist.map((h, i) => `
      <div class="fn-end${h.team >= 0 && h.points ? '' : ' zero'}" data-end="${i}" style="--c:${h.team >= 0 ? teamColor(h.team) : 'var(--line)'}">
        <div class="fn-no">END ${i + 1}</div>
        ${boardSvg(h.board)}
        <div class="fn-pts">${h.team >= 0 && h.points ? `<span class="sw"></span>${esc(teamLabel(h.team))} <b>+${h.points}</b>` : '0点'}</div>
        <div class="fn-tags">${endKind(h).map(([k, txt]) => `<span class="fn-tag ${k}">${txt}</span>`).join('')}</div>
      </div>`).join('')}
    </div>
    <div class="row fn-actions">${actions}</div>`;

  const card = el.closest('.final-card') || el;
  const reveal = (i, quiet) => {
    const h = hist[i];
    const box = el.querySelector(`.fn-end[data-end="${i}"]`);
    box?.classList.add('in');
    if (!quiet) box?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    for (const t of teams) {
      const cell = el.querySelector(`li[data-team="${t}"] em[data-end="${i}"]`);
      if (cell) cell.textContent = h.team === t ? h.points : '·';
      if (h.team === t && h.points) {
        totals[t] += h.points;
        cell?.classList.add('got');
        const tot = el.querySelector(`li[data-team="${t}"] .tot`);
        tot.textContent = totals[t];
        if (!quiet) { tot.classList.remove('bump'); void tot.offsetWidth; tot.classList.add('bump'); }
      }
    }
    if (quiet) return;
    const kinds = endKind(h).map(k => k[0]);
    if (kinds.includes('big')) { sfx.tech(5); card.classList.remove('shake'); void card.offsetWidth; card.classList.add('shake'); }
    else if (kinds.includes('steal')) sfx.tech(3);
    else if (kinds.includes('blank')) sfx.count();
    else sfx.tech(Math.min(2, h.points - 1));
  };
  const finish = quiet => {
    el.querySelector('#fn-skip')?.remove();
    const title = el.querySelector('#fn-title');
    title.textContent = winners.length > 1 ? 'DRAW' : 'WINNER';
    title.classList.add('slam');
    for (const t of winners) el.querySelector(`li[data-team="${t}"]`)?.classList.add('win');
    el.querySelector('.fn-actions').classList.add('in');
    if (!quiet) { sfx.score(); later(350, () => sfx.tech(6)); }
  };

  // 1エンドずつ。スティールやビッグエンドのエンドは少し長めに見せる
  let at = 700;
  hist.forEach((h, i) => {
    later(at, () => reveal(i));
    at += endKind(h).some(k => k[0] !== 'blank') ? 1700 : 1100;
  });
  later(at + 200, () => finish(false));

  const stop = () => { timers.forEach(clearTimeout); timers.length = 0; };
  el.querySelector('#fn-skip').onclick = () => {
    stop();
    hist.forEach((_, i) => { if (!el.querySelector(`.fn-end[data-end="${i}"]`)?.classList.contains('in')) reveal(i, true); });
    finish(true);
  };
  return stop;
}
