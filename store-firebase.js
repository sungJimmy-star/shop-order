// Firebase Realtime Database 實作。介面跟 store-demo.js 一樣,頁面只透過這些函式存取資料。
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import {
  getAuth, onAuthStateChanged, signInAnonymously, signInWithEmailAndPassword, signOut
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import {
  getDatabase, ref, onValue, get, set, update, remove, push, runTransaction, serverTimestamp,
  onDisconnect, query, orderByChild, equalTo, startAt
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-database.js';

const AUTH_MESSAGES = {
  'auth/invalid-credential': 'Email 或密碼錯誤',
  'auth/wrong-password': 'Email 或密碼錯誤',
  'auth/user-not-found': 'Email 或密碼錯誤',
  'auth/invalid-email': 'Email 格式不正確',
  'auth/too-many-requests': '嘗試太多次,請稍後再試',
  'auth/network-request-failed': '網路連線失敗,請確認網路後再試一次',
  'auth/operation-not-allowed': 'Firebase 還沒啟用這種登入方式(見 README 第一步的 Authentication)',
  'auth/admin-restricted-operation': 'Firebase 還沒啟用「匿名」登入(見 README 第一步的 Authentication)',
  'auth/configuration-not-found': 'Firebase 還沒啟用 Authentication(見 README 第一步)'
};

function authError(e) {
  return Object.assign(new Error(AUTH_MESSAGES[e.code] || e.message), { code: e.code });
}

export function createStore(firebaseConfig) {
  const app = initializeApp(firebaseConfig);
  const auth = getAuth(app);
  const db = getDatabase(app);

  function firstAuthState() {
    return new Promise(resolve => {
      const off = onAuthStateChanged(auth, user => { off(); resolve(user); });
    });
  }

  return {
    demo: false,

    /** 等登入狀態確定。anonymous = true(顧客頁)時,沒登入就用匿名身分登入。 */
    async ready(anonymous) {
      let user = await firstAuthState();
      if (!anonymous) return user && !user.isAnonymous ? user : null;
      if (user && user.isAnonymous) {
        // 主控台開了「自動清理」,30 天前的匿名帳號會被刪掉;手機上還留著舊身分的話先換成新的
        try {
          await user.getIdToken(true);
        } catch (e) {
          if (e.code === 'auth/network-request-failed') throw authError(e);
          await signOut(auth).catch(() => {});
          user = null;
        }
      }
      if (user) return user;
      try {
        return (await signInAnonymously(auth)).user;
      } catch (e) {
        throw authError(e);
      }
    },

    /** 店家登入狀態變化(匿名身分視為未登入) */
    onAuth(cb) {
      return onAuthStateChanged(auth, user => cb(user && !user.isAnonymous ? user : null));
    },

    async login(email, password) {
      try {
        await signInWithEmailAndPassword(auth, email, password);
      } catch (e) {
        throw authError(e);
      }
    },

    logout() { return signOut(auth); },

    /**
     * 監聽 path 的值,每次變動呼叫 cb(value)。回傳取消監聽的函式。
     * opts = { orderBy, equalTo } 或 { orderBy, startAt }:只取符合條件的子項目。
     */
    watch(path, cb, opts, onError) {
      let target = ref(db, path);
      if (opts) {
        const c = [orderByChild(opts.orderBy)];
        if ('equalTo' in opts) c.push(equalTo(opts.equalTo));
        if ('startAt' in opts) c.push(startAt(opts.startAt));
        target = query(target, ...c);
      }
      return onValue(target, snap => cb(snap.val()), err => {
        console.error('讀取失敗', path, err);
        if (onError) onError(err);
      });
    },

    async get(path) { return (await get(ref(db, path))).val(); },
    set(path, value) { return set(ref(db, path), value); },
    /** 多個路徑一次寫入,全部成功或全部失敗。{ 'a/b': 1, 'c': null } */
    update(values) { return update(ref(db), values); },
    remove(path) { return remove(ref(db, path)); },
    newKey(path) { return push(ref(db, path)).key; },

    /** fn(目前值) 回傳新值;回傳 undefined 放棄,回傳 null 刪除 */
    async transaction(path, fn) {
      const r = await runTransaction(ref(db, path), fn);
      return { committed: r.committed, value: r.snapshot.val() };
    },

    /** 寫入時代表「伺服器時間」 */
    now() { return serverTimestamp(); },

    /** 在線上時寫入 path,斷線(關掉網頁)時伺服器自動刪除。回傳停止的函式。 */
    presence(path) {
      const r = ref(db, path);
      const off = onValue(ref(db, '.info/connected'), snap => {
        if (snap.val() !== true) return;
        onDisconnect(r).remove()
          .then(() => set(r, serverTimestamp()))
          .catch(e => console.warn('presence', e));
      });
      return () => {
        off();
        onDisconnect(r).cancel().catch(() => {});
        remove(r).catch(() => {});
      };
    },

    /** 連線狀態變化 cb(true/false) */
    onConnection(cb) {
      return onValue(ref(db, '.info/connected'), snap => cb(snap.val() === true));
    }
  };
}
