// 顧客點餐頁(order.js)和店家後台(admin.js)共用的工具

export const $ = id => document.getElementById(id);
export const params = new URLSearchParams(location.search);
// ?demo=1:示範模式,不連 Firebase,資料只存在這個瀏覽器
export const isDemo = params.get('demo') === '1';

const TZ = 'Asia/Taipei';

export async function loadStore() {
  if (isDemo) return (await import('./store-demo.js')).createStore();
  const fb = (window.APP_CONFIG || {}).firebase || {};
  if (!fb.apiKey || !fb.databaseURL) {
    throw new Error('尚未設定 config.js 的 Firebase 資料。\n想先試用的話,在網址後面加上 ?demo=1');
  }
  let mod;
  try {
    mod = await import('./store-firebase.js');
  } catch (e) {
    console.error(e);
    throw new Error('Firebase 元件載入失敗,請確認網路後重新整理');
  }
  return mod.createStore(fb);
}

// ---------- 文字與格式 ----------

export function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function money(n) {
  return 'NT$' + Math.round(Number(n) || 0).toLocaleString('en-US');
}

/** '現金,LINE Pay' 或 ['現金','LINE Pay'] → ['現金','LINE Pay'] */
export function splitList(v) {
  const arr = Array.isArray(v) ? v : String(v || '').split(/[,，、\n]+/);
  return arr.map(s => String(s).trim()).filter(Boolean);
}

export const DEFAULT_PAY_METHODS = '現金,LINE Pay,街口支付';

/** 付款方式清單。店家還沒存過設定時用預設值;存成空白就是不用選付款方式。 */
export function payMethodsOf(config) {
  return splitList(config && config.payMethods != null ? config.payMethods : DEFAULT_PAY_METHODS);
}

/** 台灣時間的日期 '2026-10-05' */
export function dateKey(ts) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(ts == null ? Date.now() : ts);
}

/** 台灣時間 '14:05' */
export function timeLabel(ts) {
  if (!ts) return '';
  return new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(ts);
}

/** 第 2 桌 / 外帶 / 包廂A */
export function tableLabel(t) {
  if (!t) return '';
  if (t.takeout) return t.name || '外帶';
  return /^\d+$/.test(t.name) ? '第 ' + t.name + ' 桌' : t.name;
}

/** 2 桌 / 外帶(後台空間小的地方用) */
export function shortTable(o) {
  if (o.takeout) return '外帶';
  return /^\d+$/.test(o.table || o.name) ? (o.table || o.name) + ' 桌' : (o.table || o.name);
}

export function firstChar(s) {
  return Array.from(String(s || '').trim())[0] || '?';
}

/** 訂單金額一律用品項重新加總,不信任送進來的 total */
export function orderTotal(o) {
  return Object.values(o.items || {}).reduce((n, l) => n + (Number(l.price) || 0) * (Number(l.qty) || 0), 0);
}

export function orderLines(o) {
  return Object.values(o.items || {});
}

// ---------- 菜單 ----------

/** 依「分類順序」設定分組;沒列在設定裡的分類排在後面,維持第一次出現的順序 */
export function groupMenu(menu, categoryOrder) {
  const items = Object.keys(menu || {})
    .map(id => Object.assign({ id }, menu[id]))
    .sort((a, b) => (a.sort || 0) - (b.sort || 0) || String(a.name).localeCompare(String(b.name)));
  const order = splitList(categoryOrder);
  const groups = new Map();
  items.forEach(it => {
    const c = String(it.category || '').trim() || '其他';
    if (!groups.has(c)) groups.set(c, []);
    groups.get(c).push(it);
  });
  const rank = name => {
    const i = order.indexOf(name);
    return i < 0 ? order.length : i;
  };
  return [...groups.entries()].map(([name, list]) => ({ name, items: list }))
    .sort((a, b) => rank(a.name) - rank(b.name));
}

/** Google 雲端硬碟的分享連結轉成可以直接顯示的圖片網址 */
export function driveUrl(url) {
  const m = String(url || '').match(/drive\.google\.com\/(?:file\/d\/|open\?id=|uc\?(?:export=\w+&)?id=)([\w-]+)/);
  return m ? 'https://drive.google.com/thumbnail?id=' + m[1] + '&sz=w800' : url;
}

/**
 * 菜單圖片:上傳的照片存在 menuImages/{id}(Firebase 免費方案沒有 Storage),
 * 用 imgVer 判斷版本,下載過的存在 localStorage,下次開網頁不用重新下載。
 */
export function imageLoader(store) {
  const mem = {};
  const pending = {};
  return function load(id, item, done) {
    if (item.imgUrl) return done(driveUrl(item.imgUrl));
    if (!item.imgVer) return done(null);
    const v = item.imgVer;
    if (mem[id] && mem[id].v === v) return done(mem[id].d);
    try {
      const c = JSON.parse(localStorage.getItem('img:' + id) || 'null');
      if (c && c.v === v) {
        mem[id] = c;
        return done(c.d);
      }
    } catch (e) { /* 快取讀不到就重新下載 */ }
    if (!pending[id] || pending[id].v !== v) {
      pending[id] = {
        v,
        p: store.get('menuImages/' + id).then(d => {
          const c = { v, d };
          mem[id] = c;
          try { localStorage.setItem('img:' + id, JSON.stringify(c)); } catch (e) { /* 空間不夠就不快取 */ }
          return d;
        })
      };
    }
    pending[id].p.then(done, () => done(null));
  };
}

/** 把 root 裡所有 [data-img="品項id"] 的方塊填上圖片(沒有圖片就保留文字) */
export function fillImages(root, menu, load) {
  root.querySelectorAll('[data-img]').forEach(el => {
    const id = el.dataset.img;
    const item = menu[id];
    if (!item) return;
    load(id, item, src => {
      if (!el.isConnected) return;
      let img = el.querySelector('img');
      if (!src) {
        if (img) img.remove();
        el.classList.remove('has-img');
        return;
      }
      if (!img) {
        img = document.createElement('img');
        img.alt = '';
        img.onerror = () => { img.remove(); el.classList.remove('has-img'); };
        el.appendChild(img);
      }
      if (img.getAttribute('src') !== src) img.src = src;
      el.classList.add('has-img');
    });
  });
}

/**
 * 依資料更新清單,同一個 key 的元素會重複使用,所以正在輸入的欄位不會因為別人更新而被清掉。
 * create(item) 建立元素;update(el, item) 更新內容。
 */
export function syncList(container, items, key, create, update) {
  const want = new Set(items.map(key));
  [...container.children].forEach(el => {
    if (!want.has(el.dataset.key)) el.remove();
  });
  const byKey = {};
  [...container.children].forEach(el => { byKey[el.dataset.key] = el; });
  items.forEach((it, i) => {
    const k = key(it);
    let el = byKey[k];
    if (!el) {
      el = create(it);
      el.dataset.key = k;
    }
    if (container.children[i] !== el) container.insertBefore(el, container.children[i] || null);
    update(el, it);
  });
}

/** 存在這台裝置的小設定 */
export function pref(key, value) {
  try {
    if (value === undefined) return localStorage.getItem('pref:' + key) || '';
    localStorage.setItem('pref:' + key, value);
  } catch (e) { /* 無痕模式等情況存不了,不影響使用 */ }
  return '';
}

export function friendlyError(e) {
  const text = String((e && e.code) || '') + ' ' + String((e && e.message) || e || '');
  if (/permission[_ -]?denied/i.test(text)) return '沒有權限,或資料剛被更新了。請重新整理後再試一次。';
  if (/network|offline|disconnect/i.test(text)) return '網路連線失敗,請確認網路後再試一次';
  return (e && e.message) || String(e) || '發生錯誤,請再試一次';
}

// ---------- 對話框與提示 ----------

export function modal(html, buttons) {
  return new Promise(resolve => {
    $('modalBody').innerHTML = html;
    const actions = $('modalActions');
    actions.innerHTML = '';
    buttons.forEach(b => {
      const el = document.createElement('button');
      el.type = 'button';
      el.textContent = b.label;
      el.className = b.className || 'ghost';
      el.onclick = () => {
        $('modal').hidden = true;
        resolve(b.value);
      };
      actions.appendChild(el);
    });
    $('modal').hidden = false;
    const input = $('modalBody').querySelector('input, textarea');
    if (input) {
      input.focus();
      if (input.select) input.select();
    }
  });
}

export function alertBox(title, message) {
  return modal('<h3>' + esc(title) + '</h3><p>' + esc(message || '') + '</p>',
    [{ label: '好', value: true, className: 'primary' }]);
}

export function confirmBox(title, message, okLabel, className) {
  return modal('<h3>' + esc(title) + '</h3><p>' + esc(message || '') + '</p>', [
    { label: '返回', value: false },
    { label: okLabel, value: true, className: className || 'danger' }
  ]);
}

/** 輸入框對話框,取消時回傳 null */
export async function promptBox(title, value, opts) {
  opts = opts || {};
  const field = opts.multiline
    ? '<textarea id="promptInput" rows="3" maxlength="' + (opts.maxLength || 200) + '">' + esc(value || '') + '</textarea>'
    : '<input id="promptInput" type="text" maxlength="' + (opts.maxLength || 40) + '" value="' + esc(value || '') + '">';
  const p = modal('<h3>' + esc(title) + '</h3>' + (opts.hint ? '<p class="muted">' + esc(opts.hint) + '</p>' : '') + field, [
    { label: '取消', value: false },
    { label: opts.okLabel || '確定', value: true, className: 'primary' }
  ]);
  const input = $('promptInput');
  if (!opts.multiline) {
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') $('modalActions').lastChild.click();
    });
  }
  return (await p) ? input.value.trim() : null;
}

let toastTimer = null;

/** 畫面下方的短暫提示;action = { label, run } 會多一個按鈕(例如「復原」) */
export function toast(message, action) {
  const el = $('toast');
  el.innerHTML = '<span>' + esc(message) + '</span>' + (action ? '<button type="button">' + esc(action.label) + '</button>' : '');
  if (action) {
    el.querySelector('button').onclick = () => {
      el.hidden = true;
      action.run();
    };
  }
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, action ? 6000 : 3000);
}
