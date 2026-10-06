// 示範模式(網址加 ?demo=1):不用 Firebase,資料存在這個瀏覽器的 localStorage。
// 同一個瀏覽器開好幾個分頁,就能模擬「同桌好幾支手機」和「老闆平板」之間的即時同步。
// 介面跟 store-firebase.js 一樣。不檢查權限規則(database.rules.json)。

const DB_KEY = 'order-demo-db';
const ADMIN_KEY = 'order-demo-admin';

export function createStore() {
  let tree = read() || seed();
  write();

  const listeners = new Set();
  const authCallbacks = new Set();
  const uid = tabUid();
  let timer = null;

  window.addEventListener('storage', e => {
    if (e.key === DB_KEY) {
      tree = read() || {};
      schedule();
    }
    if (e.key === ADMIN_KEY) fireAuth();
  });

  function read() {
    try { return JSON.parse(localStorage.getItem(DB_KEY)); } catch (e) { return null; }
  }

  function write() {
    try { localStorage.setItem(DB_KEY, JSON.stringify(tree)); } catch (e) { console.warn('示範資料存不進 localStorage', e); }
  }

  /** 寫入前先讀最新的,其他分頁剛寫的資料才不會被蓋掉 */
  function fresh() { tree = read() || tree; }

  function keys(path) { return String(path).split('/').filter(Boolean); }

  function getAt(path) {
    let node = tree;
    for (const k of keys(path)) {
      if (node == null || typeof node !== 'object') return null;
      node = node[k];
    }
    return node === undefined ? null : node;
  }

  function setAt(path, value) {
    const ks = keys(path);
    if (!ks.length) { tree = value || {}; return; }
    const parents = [];
    let node = tree;
    for (let i = 0; i < ks.length - 1; i++) {
      if (node[ks[i]] == null || typeof node[ks[i]] !== 'object') node[ks[i]] = {};
      parents.push([node, ks[i]]);
      node = node[ks[i]];
    }
    const last = ks[ks.length - 1];
    if (value == null) delete node[last];
    else node[last] = value;
    // 跟 Firebase 一樣:變空的上層節點自動消失
    for (let i = parents.length - 1; i >= 0; i--) {
      const [p, k] = parents[i];
      if (p[k] && typeof p[k] === 'object' && !Object.keys(p[k]).length) delete p[k];
      else break;
    }
  }

  /** 把「伺服器時間」換成現在時間、去掉 null 子項目 */
  function resolve(v) {
    if (v && typeof v === 'object') {
      if (v['.sv'] === 'timestamp') return Date.now();
      const out = Array.isArray(v) ? [] : {};
      for (const k of Object.keys(v)) {
        const r = resolve(v[k]);
        if (r != null) out[k] = r;
      }
      return Array.isArray(v) || Object.keys(out).length ? out : null;
    }
    return v === undefined ? null : v;
  }

  function clone(v) { return v == null ? null : JSON.parse(JSON.stringify(v)); }

  function schedule() {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      listeners.forEach(fire);
    }, 0);
  }

  function commit() {
    write();
    schedule();
  }

  function fire(l) {
    let v = getAt(l.path);
    if (l.opts && v && typeof v === 'object') {
      const out = {};
      Object.keys(v).forEach(k => {
        const x = v[k] && v[k][l.opts.orderBy];
        if ('equalTo' in l.opts && x !== l.opts.equalTo) return;
        if ('startAt' in l.opts && !(x >= l.opts.startAt)) return;
        out[k] = v[k];
      });
      v = Object.keys(out).length ? out : null;
    }
    const s = JSON.stringify(v);
    if (s === l.last) return;
    l.last = s;
    l.cb(clone(v));
  }

  function adminUser() {
    let email = null;
    try { email = localStorage.getItem(ADMIN_KEY); } catch (e) { /* 讀不到就當沒登入 */ }
    return email ? { uid: 'demo-admin', email, isAnonymous: false } : null;
  }

  function fireAuth() {
    const u = adminUser();
    authCallbacks.forEach(cb => cb(u));
  }

  const store = {
    demo: true,

    // 顧客頁每個分頁各自一個身分(模擬不同手機);店家頁看有沒有登入
    async ready(anonymous) {
      return anonymous ? { uid, isAnonymous: true } : adminUser();
    },

    onAuth(cb) {
      authCallbacks.add(cb);
      setTimeout(() => cb(adminUser()), 0);
      return () => authCallbacks.delete(cb);
    },

    async login(email) {
      if (!email) throw new Error('請輸入 Email');
      localStorage.setItem(ADMIN_KEY, email);
      fireAuth();
    },

    async logout() {
      localStorage.removeItem(ADMIN_KEY);
      fireAuth();
    },

    watch(path, cb, opts) {
      const l = { path, cb, opts, last: undefined };
      listeners.add(l);
      setTimeout(() => fire(l), 0);
      return () => listeners.delete(l);
    },

    async get(path) { fresh(); return clone(getAt(path)); },

    async set(path, value) {
      fresh();
      setAt(path, resolve(value));
      commit();
    },

    async update(values) {
      fresh();
      Object.keys(values).forEach(p => setAt(p, resolve(values[p])));
      commit();
    },

    async remove(path) {
      fresh();
      setAt(path, null);
      commit();
    },

    newKey() {
      const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
      let k = Date.now().toString(36);
      for (let i = 0; i < 8; i++) k += chars[Math.floor(Math.random() * chars.length)];
      return k;
    },

    async transaction(path, fn) {
      fresh();
      const next = fn(clone(getAt(path)));
      if (next === undefined) return { committed: false, value: clone(getAt(path)) };
      setAt(path, resolve(next));
      commit();
      return { committed: true, value: clone(getAt(path)) };
    },

    now() { return { '.sv': 'timestamp' }; },

    presence(path) {
      const leave = () => {
        clearInterval(beat);
        fresh();
        setAt(path, null);
        write();
      };
      store.set(path, Date.now());
      // 示範模式整份資料存在同一個 localStorage 項目,兩個分頁同時寫入時後寫的會蓋掉先寫的,
      // 所以定時補寫回來。(Firebase 是逐一路徑寫入,沒有這個問題)
      const beat = setInterval(() => {
        fresh();
        if (getAt(path) == null) store.set(path, Date.now());
      }, 2000);
      window.addEventListener('pagehide', leave);
      return () => {
        window.removeEventListener('pagehide', leave);
        leave();
        schedule();
      };
    },

    onConnection(cb) {
      setTimeout(() => cb(true), 0);
      return () => {};
    }
  };
  return store;
}

function tabUid() {
  try {
    let id = sessionStorage.getItem('order-demo-uid');
    if (!id) {
      id = 'demo-' + Math.random().toString(36).slice(2, 8);
      sessionStorage.setItem('order-demo-uid', id);
    }
    return id;
  } catch (e) {
    return 'demo-' + Math.random().toString(36).slice(2, 8);
  }
}

function seed() {
  const menu = {};
  [
    ['麵食', '招牌牛肉麵', 180, '清燉湯頭、半筋半肉'],
    ['麵食', '紅燒牛肉麵', 170, ''],
    ['麵食', '餛飩麵', 90, '鮮肉餛飩 6 顆'],
    ['麵食', '麻醬麵', 60, ''],
    ['飯類', '滷肉飯', 40, ''],
    ['飯類', '雞肉飯', 45, ''],
    ['小菜', '燙青菜', 40, '依季節供應'],
    ['小菜', '滷蛋', 15, ''],
    ['小菜', '豆干海帶', 35, ''],
    ['湯品', '貢丸湯', 35, ''],
    ['飲料', '古早味紅茶', 30, '微糖'],
    ['飲料', '冬瓜檸檬', 40, '']
  ].forEach((m, i) => {
    menu['m' + String(i + 1).padStart(2, '0')] = {
      category: m[0], name: m[1], price: m[2], desc: m[3], available: true, sort: (i + 1) * 10, imgUrl: '', imgVer: 0
    };
  });
  menu.m09.available = false;   // 示範「售完」

  const tables = {};
  for (let i = 1; i <= 6; i++) tables['demo-' + i] = { name: String(i), sort: i };
  tables['demo-to'] = { name: '外帶', takeout: true, sort: 1000 };

  return {
    config: {
      shopName: '示範小吃店',
      tagline: '掃碼點餐 · 同桌共用購物車',
      payMethods: '現金,LINE Pay,街口支付',
      payNote: '請先至櫃台付款,付款完成後開始為您製作。',
      categories: '麵食,飯類,小菜,湯品,飲料',
      open: true
    },
    admins: { 'demo-admin': true },
    tables,
    menu
  };
}
