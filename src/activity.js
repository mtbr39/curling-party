// アクティビティログ。Firebase の匿名認証でユーザーを決め、users/{uid}/ に「なにをしたか」を残す
//   users/{uid}/log/{pushKey}  … 1件ずつの記録 { type, t, ...詳細 }
//   users/{uid}/stats          … 回数の合計（type ごと。ゲームは games / cpuGames / onlineGames / wins も数える）
// Firebase が未設定・匿名認証が無効なら何もしない（ゲームはそのまま遊べる）。オフラインの CPU 戦も記録する
import { firebaseConfigured, loadFirebase, FB_VER } from './store.js';

let ready = null;

// 匿名ログイン。前回のユーザーがブラウザに残っていればそれを使う（同じブラウザなら同じ uid）
export function initActivity() {
  if (!firebaseConfigured()) return Promise.resolve(null);
  ready ||= (async () => {
    const { app, db, m } = await loadFirebase();
    const a = await import(`https://www.gstatic.com/firebasejs/${FB_VER}/firebase-auth.js`);
    const auth = a.getAuth(app);
    await auth.authStateReady();
    if (!auth.currentUser) await a.signInAnonymously(auth);
    return { uid: auth.currentUser.uid, db, m };
  })().catch(e => { console.warn('アクティビティログは使えません:', e); return null; });
  return ready;
}

// 同じできごとを二重に記録しない（再読み込み・ホスト交代のときなど）。タブを閉じるまで覚えておく
function seen(key) {
  try {
    const list = JSON.parse(sessionStorage.getItem('cp_logged') || '[]');
    if (list.includes(key)) return true;
    list.push(key);
    sessionStorage.setItem('cp_logged', JSON.stringify(list.slice(-200)));
  } catch {}
  return false;
}

// 1件記録する。once を渡すと、そのキーでは1回しか記録しない
// replace に前回の戻り値を渡すと、新しく足さずにその記録を書きかえる（ダブルテイクアウトなど、あとから大きくなるもの）
export async function logActivity(type, data = {}, { once, replace, stats } = {}) {
  if (once && seen(once)) return null;
  const r = await initActivity();
  if (!r) return null;
  const { uid, db, m } = r;
  const base = `users/${uid}`;
  try {
    const prev = replace && await replace;
    const ref = prev ? m.ref(db, `${base}/log/${prev}`) : m.push(m.ref(db, `${base}/log`));
    const inc = {};
    for (const k of stats ?? [type]) inc[k] = m.increment(1);
    await Promise.all([
      m.set(ref, { type, t: m.serverTimestamp(), ...data }),
      m.update(m.ref(db, `${base}/stats`), inc),
    ]);
    return ref.key;
  } catch (e) {
    console.warn('アクティビティログを書けませんでした:', e);
    return null;
  }
}

// 新しい順に読む
export async function readActivity(limit = 60) {
  const r = await initActivity();
  if (!r) return null;
  const { uid, db, m } = r;
  const [log, stats] = await Promise.all([
    m.get(m.query(m.ref(db, `users/${uid}/log`), m.orderByKey(), m.limitToLast(limit))),
    m.get(m.ref(db, `users/${uid}/stats`)),
  ]);
  const list = [];
  log.forEach(s => { list.push({ key: s.key, ...s.val() }); });
  return { uid, log: list.reverse(), stats: stats.val() || {} };
}

const TAKEOUT = ['', 'テイクアウト', 'ダブルテイクアウト', 'トリプルテイクアウト', 'クアドラプルテイクアウト'];

// 記録1件を「なにをしたか」の一文にする
export function describe(e) {
  const where = e.cpus && e.humans <= 1 ? 'CPU戦' : e.online ? 'オンライン対戦' : '対戦';
  switch (e.type) {
    case 'game':
      return `${where}をはじめた（${[e.humans > 1 ? `${e.humans}人` : '', e.cpus ? `CPU ${e.cpus}体` : ''].filter(Boolean).join('・') || '1人'}・${e.ends}エンド）`;
    case 'result': {
      const res = e.rank === 1 && !e.tie ? '勝った！' : e.rank === 1 ? '引き分け' : `${e.rank}位`;
      return `${where}で${res}　${e.score} − ${e.best}`;
    }
    case 'takeout': return `${TAKEOUT[e.n] || `${e.n}連テイクアウト`}をきめた`;
    case 'guard': return 'ガードストーンを置いた';
    case 'button': return 'ボタン（ティーのまん中）に止めた';
    case 'steal': return `スティールした（+${e.points}点）`;
    case 'bigend': return `ビッグエンドをきめた（+${e.points}点）`;
    default: return e.type;
  }
}
