// データ同期層。Firebase Realtime Database と、オフライン用のメモリ実装を同じインターフェースで扱う。
import { firebaseConfig } from './firebase-config.js';

const FB_VER = '10.12.2';

export function firebaseConfigured() {
  return !!firebaseConfig && !!firebaseConfig.apiKey && !String(firebaseConfig.apiKey).startsWith('YOUR_')
    && !!firebaseConfig.databaseURL;
}

const clone = v => (v === undefined ? null : JSON.parse(JSON.stringify(v)));
const split = p => p.split('/').filter(Boolean);

// ---------------------------------------------------------------- Local
export class LocalStore {
  constructor() {
    this.data = {};
    this.valueL = [];
    this.childL = [];
    this.keyN = 0;
  }
  async init() {}
  serverNow() { return Date.now(); }

  _get(path) {
    let cur = this.data;
    for (const k of split(path)) {
      if (cur == null || typeof cur !== 'object') return null;
      cur = cur[k];
    }
    return cur ?? null;
  }
  _set(path, val) {
    const ks = split(path);
    let cur = this.data;
    for (let i = 0; i < ks.length - 1; i++) {
      if (cur[ks[i]] == null || typeof cur[ks[i]] !== 'object') cur[ks[i]] = {};
      cur = cur[ks[i]];
    }
    const last = ks[ks.length - 1];
    if (val == null) delete cur[last];
    else cur[last] = clone(val);
  }
  _notify(path) {
    const p = split(path).join('/');
    for (const l of this.valueL) {
      if (p === l.path || p.startsWith(l.path + '/') || l.path.startsWith(p + '/') || l.path === '' ) {
        queueMicrotask(() => l.active && l.cb(clone(this._get(l.path))));
      }
    }
  }
  onValue(path, cb) {
    const l = { path: split(path).join('/'), cb, active: true };
    this.valueL.push(l);
    queueMicrotask(() => l.active && cb(clone(this._get(l.path))));
    return () => { l.active = false; this.valueL = this.valueL.filter(x => x !== l); };
  }
  onChildAdded(path, cb) {
    const l = { path: split(path).join('/'), cb, active: true };
    this.childL.push(l);
    const cur = this._get(path);
    if (cur && typeof cur === 'object') {
      for (const [k, v] of Object.entries(cur)) queueMicrotask(() => l.active && cb(k, clone(v)));
    }
    return () => { l.active = false; this.childL = this.childL.filter(x => x !== l); };
  }
  async get(path) { return clone(this._get(path)); }
  async set(path, val) { this._set(path, val); this._notify(path); }
  async update(path, obj) {
    for (const [k, v] of Object.entries(obj)) this._set(path + '/' + k, v);
    this._notify(path);
  }
  async remove(path) { this._set(path, null); this._notify(path); }
  push(path, val) {
    const key = 'k' + Date.now().toString(36) + (this.keyN++).toString(36).padStart(4, '0');
    this._set(path + '/' + key, val);
    const p = split(path).join('/');
    for (const l of this.childL) if (l.path === p) queueMicrotask(() => l.active && l.cb(key, clone(val)));
    this._notify(path + '/' + key);
    return key;
  }
  async transaction(path, fn) {
    const v = fn(clone(this._get(path)));
    if (v !== undefined) await this.set(path, v);
  }
  onDisconnectRemove() {}
  dispose() { this.valueL = []; this.childL = []; }
}

// ---------------------------------------------------------------- Firebase
let fbModsPromise = null;
function loadFirebase() {
  fbModsPromise ||= Promise.all([
    import(`https://www.gstatic.com/firebasejs/${FB_VER}/firebase-app.js`),
    import(`https://www.gstatic.com/firebasejs/${FB_VER}/firebase-database.js`),
  ]).then(([app, db]) => {
    const fapp = app.initializeApp(firebaseConfig);
    return { db: db.getDatabase(fapp), m: db };
  });
  return fbModsPromise;
}

export class FirebaseStore {
  constructor(base) {
    this.base = base.replace(/\/$/, '');
    this.offset = 0;
    this.unsubs = [];
    this.disconnects = [];
  }
  async init() {
    const { db, m } = await loadFirebase();
    this.db = db; this.m = m;
    this.unsubs.push(m.onValue(m.ref(db, '.info/serverTimeOffset'), s => { this.offset = s.val() || 0; }));
  }
  r(path) { return this.m.ref(this.db, path ? `${this.base}/${path}` : this.base); }
  serverNow() { return Date.now() + this.offset; }
  onValue(path, cb) {
    const u = this.m.onValue(this.r(path), s => cb(s.val()));
    this.unsubs.push(u);
    return u;
  }
  onChildAdded(path, cb) {
    const u = this.m.onChildAdded(this.r(path), s => cb(s.key, s.val()));
    this.unsubs.push(u);
    return u;
  }
  async get(path) { return (await this.m.get(this.r(path))).val(); }
  set(path, val) { return this.m.set(this.r(path), val ?? null); }
  update(path, obj) { return this.m.update(this.r(path), obj); }
  remove(path) { return this.m.remove(this.r(path)); }
  push(path, val) {
    const ref = this.m.push(this.r(path));
    this.m.set(ref, val);
    return ref.key;
  }
  transaction(path, fn) { return this.m.runTransaction(this.r(path), fn); }
  onDisconnectRemove(path) {
    const od = this.m.onDisconnect(this.r(path));
    od.remove();
    this.disconnects.push(od);
  }
  dispose() {
    for (const u of this.unsubs) try { u(); } catch {}
    this.unsubs = [];
  }
}
