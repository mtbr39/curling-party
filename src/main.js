// 画面遷移・ルーム管理・ホスト選出
import { DEFAULT_SETTINGS, teamColor, teamName } from './config.js';
import { LocalStore, FirebaseStore, firebaseConfigured } from './store.js';
import { GameHost } from './host.js';
import { GameClient } from './client.js';
import { staggerSec, tk } from './rules.js';
import { unlockAudio, setMuted, isMuted } from './sfx.js';

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const pid = (() => {
  let p = sessionStorage.getItem('cp_pid');
  if (!p) { p = 'p' + Math.random().toString(36).slice(2, 10); sessionStorage.setItem('cp_pid', p); }
  return p;
})();

const S = {
  store: null, code: null, online: false,
  meta: null, players: {}, host: null, client: null, unsubs: [],
};

function show(id) {
  for (const el of document.querySelectorAll('.screen')) el.hidden = el.id !== id;
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('on');
  clearTimeout(toast.tm);
  toast.tm = setTimeout(() => t.classList.remove('on'), 2600);
}

function myName() {
  const n = $('#name').value.trim().slice(0, 12) || 'PLAYER';
  localStorage.setItem('cp_name', n);
  return n;
}

function genCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 4 }, () => A[Math.floor(Math.random() * A.length)]).join('');
}

// ------------------------------------------------------------ タイトル
function initTitle() {
  $('#name').value = localStorage.getItem('cp_name') || '';
  const q = new URLSearchParams(location.search).get('room');
  if (q) $('#code').value = q.toUpperCase();
  const ok = firebaseConfigured();
  if (!ok) {
    $('#online-note').hidden = false;
    $('#btn-create').disabled = true;
    $('#btn-join').disabled = true;
  }
  $('#btn-create').onclick = () => createRoom(true);
  $('#btn-join').onclick = () => joinRoom($('#code').value.trim().toUpperCase());
  $('#btn-local').onclick = () => createRoom(false);
  $('#code').addEventListener('keydown', e => { if (e.key === 'Enter') $('#btn-join').click(); });
}

async function createRoom(online) {
  unlockAudio();
  const name = myName();
  try {
    let code = online ? genCode() : 'LOCAL';
    let store;
    if (online) {
      for (let i = 0; i < 5; i++) {
        store = new FirebaseStore(`rooms/${code}`);
        await store.init();
        if (!(await store.get('meta'))) break;
        code = genCode();
      }
    } else {
      store = new LocalStore();
      await store.init();
    }
    await store.set('meta', { hostId: pid, createdAt: store.serverNow(), status: 'lobby', settings: { ...DEFAULT_SETTINGS } });
    await enterRoom(store, code, online, name);
    if (!online) {
      // 練習モードは CPU を1体入れておく
      setTimeout(() => S.host?.addBot(), 50);
    }
  } catch (e) {
    console.error(e);
    toast('ルームを作れませんでした: ' + e.message);
  }
}

async function joinRoom(code) {
  unlockAudio();
  if (!/^[A-Z0-9]{4}$/.test(code)) { toast('4文字のルームコードを入力してください'); return; }
  const name = myName();
  try {
    const store = new FirebaseStore(`rooms/${code}`);
    await store.init();
    const meta = await store.get('meta');
    if (!meta) { toast('ルームが見つかりません'); store.dispose(); return; }
    await enterRoom(store, code, true, name);
  } catch (e) {
    console.error(e);
    toast('参加できませんでした: ' + e.message);
  }
}

async function enterRoom(store, code, online, name) {
  S.store = store; S.code = code; S.online = online;
  await store.set(`players/${pid}`, { name, team: null, joinedAt: store.serverNow(), bot: false });
  store.onDisconnectRemove(`players/${pid}`);
  store.onDisconnectRemove(`aims/${pid}`);
  store.onDisconnectRemove(`sweeps/${pid}`);
  if (online) history.replaceState(null, '', `?room=${code}`);
  S.unsubs.push(
    store.onValue('meta', v => { S.meta = v; onRoomChange(); }),
    store.onValue('players', v => { S.players = v || {}; onRoomChange(); }),
  );
  $('#room-code').textContent = code;
  $('#g-room').textContent = online ? `ROOM ${code}` : 'OFFLINE';
  show('lobby');
}

async function leaveRoom() {
  const st = S.store;
  if (!st) return;
  try { await st.remove(`players/${pid}`); } catch {}
  stopGame();
  S.host?.stop(); S.host = null;
  for (const u of S.unsubs) try { u(); } catch {}
  S.unsubs = [];
  st.dispose();
  S.store = null; S.meta = null; S.players = {};
  history.replaceState(null, '', location.pathname);
  show('title');
}

// ------------------------------------------------------------ ルーム状態
function onRoomChange() {
  const meta = S.meta;
  if (!meta || !S.store) return;
  if (!S.players[pid] && S.players && Object.keys(S.players).length && S.joinedOnce) {
    toast('ルームから外れました');
    leaveRoom();
    return;
  }
  if (S.players[pid]) S.joinedOnce = true;
  electHost();
  const amHost = meta.hostId === pid;
  if (amHost && !S.host) {
    S.host = new GameHost(S.store, pid);
    S.host.start();
    S.client?.setHost(S.host);
  } else if (!amHost && S.host) {
    S.host.stop();
    S.host = null;
    S.client?.setHost(null);
  }

  if (meta.status === 'lobby') {
    stopGame();
    show('lobby');
    renderLobby();
  } else {
    startGameView();
  }
}

function electHost() {
  const meta = S.meta;
  if (meta.hostId && S.players[meta.hostId]) return;
  const humans = Object.entries(S.players).filter(([, p]) => !p.bot)
    .sort((a, b) => (a[1].joinedAt || 0) - (b[1].joinedAt || 0));
  if (!humans.length || humans[0][0] !== pid) return;
  const players = S.players;
  S.store.transaction('meta/hostId', cur => (cur && players[cur] ? undefined : pid));
}

// ------------------------------------------------------------ ロビー
function renderLobby() {
  const meta = S.meta;
  const set = { ...DEFAULT_SETTINGS, ...(meta.settings || {}) };
  const amHost = meta.hostId === pid;
  const players = Object.entries(S.players).sort((a, b) => (a[1].joinedAt || 0) - (b[1].joinedAt || 0));

  // プレイヤー一覧（チームごと）
  const groups = new Map();
  if (set.mode === 'team') for (let t = 0; t < set.teamCount; t++) groups.set(t, []);
  for (const [id, p] of players) {
    const t = p.team ?? -1;
    if (!groups.has(t)) groups.set(t, []);
    groups.get(t).push([id, p]);
  }
  const keys = [...groups.keys()].sort((a, b) => a - b);
  $('#teams').innerHTML = keys.map(t => {
    const list = groups.get(t);
    const label = set.mode === 'team' ? teamName(t) : (list[0]?.[1].name || teamName(t));
    const canJoin = set.mode === 'team' && S.players[pid]?.team !== t;
    return `<div class="team" style="--c:${teamColor(t)}">
      <div class="team-h"><span class="sw"></span><b>${esc(set.mode === 'team' ? label : teamName(t))}</b>
        ${canJoin ? `<button class="mini" data-join="${t}">ここに入る</button>` : ''}</div>
      ${list.map(([id, p]) => `<div class="pl">
        <svg class="fig" viewBox="0 0 24 24"><circle cx="12" cy="6" r="3.5"/><path d="M12 10v6m0 0l-4 6m4-6l4 6M6 12h12"/></svg>
        <span>${esc(p.name)}</span>
        ${p.bot ? '<i>CPU</i>' : ''}${id === meta.hostId ? '<i>HOST</i>' : ''}${id === pid ? '<i>YOU</i>' : ''}
        ${amHost && id !== pid ? `<button class="mini ghost" data-kick="${id}">×</button>` : ''}
      </div>`).join('') || '<div class="pl empty">—</div>'}
    </div>`;
  }).join('');
  for (const b of document.querySelectorAll('[data-join]')) b.onclick = () => S.store.set(`players/${pid}/team`, +b.dataset.join);
  for (const b of document.querySelectorAll('[data-kick]')) b.onclick = () => S.host?.kick(b.dataset.kick);

  // 設定
  const nTeams = set.mode === 'team' ? set.teamCount : Math.max(1, players.length);
  const f = $('#settings');
  f.querySelectorAll('input,select,button').forEach(el => { el.disabled = !amHost; });
  setVal('#s-mode', set.mode);
  setVal('#s-teams', set.teamCount);
  setVal('#s-stones', set.stones);
  setVal('#s-ends', set.ends);
  setVal('#s-interval', set.interval);
  setVal('#s-stagger', set.stagger === 'auto' ? 'auto' : String(set.stagger));
  $('#row-teams').hidden = set.mode !== 'team';
  $('#stagger-note').textContent = `→ ${staggerSec(set, nTeams)}秒ずつずれてスタート`;
  $('#lobby-actions').hidden = !amHost;
  $('#lobby-wait').hidden = amHost;
  $('#btn-addbot').disabled = !amHost;
  $('#btn-rmbot').disabled = !amHost || !players.some(([, p]) => p.bot);
}

function setVal(sel, v) {
  const el = $(sel);
  if (document.activeElement !== el) el.value = String(v);
}

function initLobby() {
  const upd = (k, conv = Number) => e => {
    if (S.meta?.hostId !== pid) return;
    S.store.update('meta/settings', { [k]: conv(e.target.value) });
  };
  $('#s-mode').onchange = upd('mode', String);
  $('#s-teams').onchange = upd('teamCount');
  $('#s-stones').onchange = upd('stones');
  $('#s-ends').onchange = upd('ends');
  $('#s-interval').onchange = upd('interval');
  $('#s-stagger').onchange = upd('stagger', v => (v === 'auto' ? 'auto' : Number(v)));
  $('#btn-addbot').onclick = () => S.host?.addBot();
  $('#btn-rmbot').onclick = () => S.host?.removeBot();
  $('#btn-start').onclick = () => { unlockAudio(); S.host?.startGame(); };
  $('#btn-leave').onclick = () => leaveRoom();
  $('#btn-copy').onclick = async () => {
    const url = `${location.origin}${location.pathname}?room=${S.code}`;
    try { await navigator.clipboard.writeText(url); toast('招待リンクをコピーしました'); } catch { toast(url); }
  };
}

// ------------------------------------------------------------ ゲーム画面
function startGameView() {
  show('game');
  if (!S.client) {
    S.client = new GameClient({ store: S.store, pid, canvas: $('#cv'), onFinal: () => renderFinal() });
    S.client.setHost(S.host);
    S.client.start();
  }
  if (S.meta.status === 'finished') renderFinal();
  else $('#final').hidden = true;
}

function stopGame() {
  if (S.client) { S.client.destroy(); S.client = null; }
  $('#final').hidden = true;
}

function renderFinal() {
  const g = S.client?.game;
  if (!g || S.meta?.status !== 'finished') return;
  const rows = (g.teams || []).map(t => ({ t, sc: g.scores?.[tk(t)] || 0 })).sort((a, b) => b.sc - a.sc);
  const top = rows[0]?.sc;
  const amHost = S.meta.hostId === pid;
  $('#final').hidden = false;
  $('#final-body').innerHTML = `
    <div class="final-title">${rows.filter(r => r.sc === top).length > 1 ? 'DRAW' : 'WINNER'}</div>
    <ol class="standings">${rows.map((r, i) => `
      <li style="--c:${teamColor(r.t)}" class="${r.sc === top ? 'win' : ''}">
        <span class="rk">${i + 1}</span><span class="sw"></span>
        <span class="nm">${esc(S.client.teamLabel(r.t))}</span>
        <span class="ends">${(g.history || []).map(h => `<em>${h.team === r.t ? h.points : '·'}</em>`).join('')}</span>
        <b>${r.sc}</b></li>`).join('')}
    </ol>
    <div class="row">
      ${amHost ? '<button id="btn-again" class="primary">もう一度</button><button id="btn-tolobby">ロビーへ</button>' : '<span class="muted">ホストの操作を待っています…</span>'}
    </div>`;
  if (amHost) {
    $('#btn-again').onclick = () => S.host?.startGame();
    $('#btn-tolobby').onclick = () => S.host?.backToLobby();
  }
}

function initGame() {
  $('#g-leave').onclick = () => { if (confirm('ルームから退出しますか？')) leaveRoom(); };
  $('#g-mute').onclick = () => {
    setMuted(!isMuted());
    $('#g-mute').textContent = isMuted() ? 'SOUND OFF' : 'SOUND ON';
  };
}

initTitle();
initLobby();
initGame();
show('title');

// キャンバスで使う日本語フォントを先に読み込んでおく（技の演出の文字用）
document.fonts?.load('italic 900 40px "M PLUS 1p"', 'テイクアウトガードストーン！').catch(() => {});
