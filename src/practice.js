// ロビーの練習シート: ルームのみんなで共有する、点数なし・無限に投げられるシート
// データはルームの practice/ の下に置く（本番の game や stones とは別）。動かすのはルームのホスト
import { DEFAULT_SETTINGS } from './config.js';
import { GameHost } from './host.js';
import { GameClient } from './client.js';

// 石の数・期限は実質なし（点数計算もしない）
const SETTINGS = { ...DEFAULT_SETTINGS, mode: 'solo', stones: 100000, ends: 1, interval: 1e6, stagger: 0 };

export async function startPractice({ canvas, pid, amHost, store }) {
  await store.init();
  store.onDisconnectRemove(`aims/${pid}`);
  store.onDisconnectRemove(`sweeps/${pid}`);
  let host = null;
  if (amHost) {
    await store.update('meta', { hostId: pid, status: 'playing', settings: SETTINGS });
    host = new GameHost(store, pid, { practice: true });
    await host.start();
  }
  const client = new GameClient({ store, pid, canvas, practice: true });
  client.setHost(host);
  client.start();
  return {
    amHost,
    // ホストだけ: ルームのプレイヤー（チームの色つき）を練習シートへ写す。CPU は練習しない
    setPlayers(players) {
      const ps = {};
      for (const [id, p] of Object.entries(players || {})) {
        if (!p.bot) ps[id] = { name: p.name || '', team: p.team ?? null, joinedAt: p.joinedAt || 0, bot: false };
      }
      store.set('players', ps);
    },
    stop() {
      client.destroy();
      host?.stop();
      store.remove(`aims/${pid}`);
      store.remove(`sweeps/${pid}`);
      store.dispose();
    },
  };
}
