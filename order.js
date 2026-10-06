// 顧客點餐頁。網址 ?t=桌號代碼(QR Code 裡的那串),同一桌的手機共用 carts/{代碼}/shared 這個購物車;
// 外帶 QR 每支手機各自一個購物車 carts/{代碼}/{uid}。
import {
  $, esc, money, payMethodsOf, dateKey, timeLabel, tableLabel, firstChar, orderLines, orderTotal,
  groupMenu, imageLoader, fillImages, syncList, pref, friendlyError, loadStore,
  modal, alertBox, toast
} from './common.js';

const tableKey = (new URLSearchParams(location.search).get('t') || '').trim();
const KNOWN_HOURS = 12;          // 「已點的餐點」顯示幾小時內的訂單
const DEFAULT_PAY_NOTE = '請先至櫃台付款,付款完成後開始為您製作。';

const state = {
  config: {}, table: null, menu: {}, menuLoaded: false, cart: {}, orders: {}, uid: '',
  view: 'cart', pay: pref('pay'), busy: false
};
let store = null;
let cartPath = '';
let loadImage = null;
let menuShown = false;
let cartLoaded = false;
const orderWatchers = {};        // 訂單 id → 取消監聽
const mySubmitted = new Set();
const noteTimers = {};

/*
 * 這支手機的訂單 { 訂單id: 時間 },存在 localStorage,關掉網頁再打開還在。包括:
 *  - 自己送出的、自己開著網頁時同桌送出的
 *  - 剛打開網頁時這桌已經有、而且還沒付款的(同桌朋友先點的)
 * 剛打開時已經付過款的不算:那通常是上一組客人的訂單(這家店先付款再製作)。
 */
const KNOWN_KEY = 'orders:' + tableKey;
const known = loadKnown();
const candidates = new Set();    // 剛打開時就有的訂單,讀到內容後才決定算不算
const ignored = new Set();

function loadKnown() {
  const since = Date.now() - KNOWN_HOURS * 3600e3;
  const out = {};
  try {
    const saved = JSON.parse(localStorage.getItem(KNOWN_KEY) || '{}');
    Object.keys(saved).forEach(id => { if (saved[id] > since) out[id] = saved[id]; });
  } catch (e) { /* 讀不到就從空的開始 */ }
  return out;
}

function remember(id, ts) {
  if (known[id]) return;
  known[id] = ts || Date.now();
  try { localStorage.setItem(KNOWN_KEY, JSON.stringify(known)); } catch (e) { /* 存不了就只記在這次 */ }
}

// ---------- 啟動 ----------

function fatal(message) {
  $('loading').hidden = true;
  $('menu').hidden = true;
  $('orders').hidden = true;
  $('cats').hidden = true;
  $('cartbar').hidden = true;
  $('fatalMsg').textContent = message;
  $('fatal').hidden = false;
}

$('fatalRetry').onclick = () => location.reload();

async function start() {
  if (!tableKey) return fatal('請用手機掃描桌上的 QR Code 開始點餐。');
  let table;
  try {
    store = await loadStore();
    const user = await store.ready(true);
    state.uid = user.uid;
    loadImage = imageLoader(store);
    table = await store.get('tables/' + tableKey);
  } catch (e) {
    return fatal(friendlyError(e));
  }
  if (!table) return fatal('這個 QR Code 已經失效,請洽店員。');
  state.table = table;
  cartPath = 'carts/' + tableKey + '/' + (table.takeout ? state.uid : 'shared');

  const onError = e => fatal('資料讀取失敗,請重新整理。\n(' + (e.code || e.message) + ')');
  store.watch('config', v => {
    state.config = v || {};
    renderHeader();
    renderPayMethods();
    renderMenu();
  }, null, onError);
  store.watch('menu', v => {
    state.menu = v || {};
    state.menuLoaded = true;
    renderMenu();
    renderCart();
  }, null, onError);
  store.watch(cartPath, v => onCart(v || {}), null, onError);
  if (!table.takeout) store.presence(cartPath + '/presence/' + state.uid);
  store.onConnection(onConnection);
  renderHeader();
}

let offlineTimer = null;
function onConnection(ok) {
  clearTimeout(offlineTimer);
  if (ok) $('offline').hidden = true;
  else offlineTimer = setTimeout(() => { $('offline').hidden = false; }, 3000);
}

// ---------- 頁首 ----------

function renderHeader() {
  const c = state.config;
  $('shopName').textContent = c.shopName || '線上點餐';
  $('tagline').textContent = c.tagline || '';
  document.title = (c.shopName || '線上點餐') + (state.table ? ' · ' + tableLabel(state.table) : '');
  if (state.table) {
    $('tableBadge').textContent = tableLabel(state.table);
    $('tableBadge').hidden = false;
  }
  $('closedBanner').hidden = c.open !== false;
  $('closedBanner').textContent = '目前暫停線上點餐' + (c.closedNote ? ':' + c.closedNote : ',請洽店員');
}

function renderOnline() {
  const n = Object.keys(state.cart.presence || {}).length;
  $('online').hidden = n < 2;
  $('online').textContent = '👥 同桌 ' + n + ' 人正在點餐,購物車即時同步';
}

// ---------- 菜單 ----------

function renderMenu() {
  if (!state.table || !state.menuLoaded) return;
  if (!menuShown) {
    menuShown = true;
    $('loading').hidden = true;
    $('cartbar').hidden = false;
  }
  const groups = groupMenu(state.menu, state.config.categories);
  if (!groups.length) {
    $('cats').hidden = true;
    $('menu').innerHTML = '<p class="empty">店家還沒有上架餐點</p>';
    return;
  }
  $('cats').hidden = groups.length < 2;
  $('cats').innerHTML = groups.map((g, i) =>
    '<button type="button" data-cat="' + i + '">' + esc(g.name) + '</button>').join('');
  $('menu').innerHTML = groups.map((g, i) =>
    '<section class="cat" id="cat-' + i + '"><h2 class="cat-title">' + esc(g.name) + '</h2>' +
    g.items.map(itemHtml).join('') + '</section>').join('');
  fillImages($('menu'), state.menu, loadImage);
  renderSteppers();
  highlightCat();
}

function itemHtml(it) {
  const sold = it.available === false;
  return '<div class="item' + (sold ? ' soldout' : '') + '">' +
    '<button type="button" class="thumb" data-img="' + esc(it.id) + '" data-detail="' + esc(it.id) + '">' +
    '<span>' + esc(firstChar(it.name)) + '</span></button>' +
    '<div class="info" data-detail="' + esc(it.id) + '"><div class="name">' + esc(it.name) + '</div>' +
    (it.desc ? '<div class="desc">' + esc(it.desc) + '</div>' : '') +
    '<div class="price">' + money(it.price) + '</div></div>' +
    '<div class="stepper" data-step="' + esc(it.id) + '"></div></div>';
}

function stepperHtml(id, qty, soldout) {
  const add = '<button type="button" class="step-btn add" data-add="' + esc(id) + '" aria-label="加一份">+</button>';
  if (!qty) return soldout ? '<span class="sold-tag">售完</span>' : add;
  return '<button type="button" class="step-btn" data-dec="' + esc(id) + '" aria-label="減一份">−</button>' +
    '<span class="qty">' + qty + '</span>' + (soldout ? '' : add);
}

function renderSteppers() {
  const items = state.cart.items || {};
  document.querySelectorAll('#menu [data-step]').forEach(el => {
    const id = el.dataset.step;
    const it = state.menu[id];
    el.innerHTML = stepperHtml(id, items[id] ? items[id].qty : 0, !it || it.available === false);
  });
}

$('cats').addEventListener('click', e => {
  const b = e.target.closest('button[data-cat]');
  if (!b) return;
  const sec = $('cat-' + b.dataset.cat);
  const offset = $('cats').getBoundingClientRect().height + 8;
  window.scrollTo({ top: sec.getBoundingClientRect().top + window.scrollY - offset, behavior: 'smooth' });
});

/** 分類列標出目前捲到的分類 */
function highlightCat() {
  const secs = document.querySelectorAll('#menu .cat');
  if (!secs.length || $('cats').hidden) return;
  const line = $('cats').getBoundingClientRect().bottom + 20;
  let cur = 0;
  secs.forEach((s, i) => { if (s.getBoundingClientRect().top <= line) cur = i; });
  $('cats').querySelectorAll('button').forEach((b, i) => {
    const on = i === cur;
    if (on && !b.classList.contains('active')) b.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    b.classList.toggle('active', on);
  });
}

let scrollTick = false;
window.addEventListener('scroll', () => {
  if (scrollTick) return;
  scrollTick = true;
  requestAnimationFrame(() => { scrollTick = false; highlightCat(); });
}, { passive: true });

async function showDetail(id) {
  const it = state.menu[id];
  if (!it) return;
  const sold = it.available === false;
  const p = modal(
    '<div class="detail-img thumb" data-img="' + esc(id) + '"><span>' + esc(firstChar(it.name)) + '</span></div>' +
    '<h3>' + esc(it.name) + '</h3>' + (it.desc ? '<p>' + esc(it.desc) + '</p>' : '') +
    '<p class="big">' + money(it.price) + '</p>',
    sold ? [{ label: '已售完', value: false }]
      : [{ label: '關閉', value: false }, { label: '加入購物車', value: true, className: 'primary' }]);
  fillImages($('modalBody'), state.menu, loadImage);
  if (await p) changeQty(id, 1);
}

// ---------- 購物車 ----------

function onCart(c) {
  state.cart = c;
  const since = Date.now() - KNOWN_HOURS * 3600e3;
  Object.keys(c.orders || {}).forEach(id => {
    const ts = c.orders[id];
    if (!(ts > since) || known[id] || ignored.has(id) || candidates.has(id)) return;
    if (state.table.takeout || mySubmitted.has(id)) {
      remember(id, ts);
    } else if (cartLoaded) {
      remember(id, ts);       // 開著網頁時同桌送出的
      teammateSubmitted();
    } else {
      candidates.add(id);
    }
  });
  cartLoaded = true;
  syncOrderWatchers();
  renderSteppers();
  renderCart();
  renderOnline();
  renderOrders();
}

function syncOrderWatchers() {
  const want = new Set(Object.keys(known).concat([...candidates]));
  want.forEach(id => {
    if (!orderWatchers[id]) orderWatchers[id] = store.watch('orders/' + id, o => onOrder(id, o));
  });
  Object.keys(orderWatchers).forEach(id => {
    if (want.has(id)) return;
    orderWatchers[id]();
    delete orderWatchers[id];
    delete state.orders[id];
  });
}

function onOrder(id, o) {
  if (candidates.has(id)) {
    candidates.delete(id);
    if (o && o.status === 'unpaid') {
      remember(id, o.createdAt);
    } else {
      ignored.add(id);
      syncOrderWatchers();
      return;
    }
  }
  if (o) state.orders[id] = o;
  else delete state.orders[id];
  renderOrders();
}

function teammateSubmitted() {
  if (!$('sheet').hidden && !state.busy) closeSheet();
  toast('同桌已經送出訂單了,請至櫃台付款');
}

function cartLines() {
  const items = state.cart.items || {};
  return Object.keys(items)
    .map(id => ({
      id,
      qty: Number(items[id].qty) || 0,
      note: items[id].note || '',
      by: items[id].by || '',
      at: items[id].at || 0,
      item: state.menu[id] || null
    }))
    .filter(l => l.qty > 0)
    .sort((a, b) => a.at - b.at);
}

function lineOk(l) {
  return !!l.item && l.item.available !== false;
}

function changeQty(id, delta) {
  if (!store || !cartPath) return;
  const it = state.menu[id];
  if (delta > 0 && (!it || it.available === false)) return toast('這項餐點已售完');
  store.transaction(cartPath + '/items/' + id, cur => {
    const qty = ((cur && cur.qty) || 0) + delta;
    if (qty <= 0) return null;
    if (qty > 99) return undefined;
    return cur ? Object.assign({}, cur, { qty })
      : { itemId: id, qty, note: '', by: state.uid, at: Date.now() };
  }).catch(e => toast('更新失敗:' + friendlyError(e)));
}

document.addEventListener('click', e => {
  if (e.target.closest('#modal')) return;
  const add = e.target.closest('[data-add]');
  if (add) return changeQty(add.dataset.add, 1);
  const dec = e.target.closest('[data-dec]');
  if (dec) return changeQty(dec.dataset.dec, -1);
  const rm = e.target.closest('[data-remove]');
  if (rm) return store.remove(cartPath + '/items/' + rm.dataset.remove).catch(err => toast(friendlyError(err)));
  const detail = e.target.closest('[data-detail]');
  if (detail) return showDetail(detail.dataset.detail);
});

function renderCart() {
  if (!state.table || !state.menuLoaded) return;
  const lines = cartLines();
  let count = 0;
  let total = 0;
  lines.forEach(l => {
    if (!lineOk(l)) return;
    count += l.qty;
    total += l.qty * l.item.price;
  });

  $('cartCount').textContent = count;
  $('cartCount').hidden = !count;
  $('cartTotal').textContent = count ? money(total) : '尚未點餐';
  $('cartbar').classList.toggle('empty', !count);

  $('cartHint').textContent = state.table.takeout ? '' : '同桌掃同一個 QR Code 的人都看得到、也都能修改這個購物車。';
  $('cartEmpty').hidden = lines.length > 0;
  syncList($('cartList'), lines, l => l.id, createLine, updateLine);
  fillImages($('cartList'), state.menu, loadImage);

  $('sheetTotal').textContent = money(total);
  const bad = lines.some(l => !lineOk(l));
  const next = $('sheetNext');
  next.disabled = !count || bad || state.busy;
  if (state.view === 'checkout') {
    next.textContent = state.busy ? '送出中…' : '送出訂單';
    renderCheckout(lines, total);
  } else {
    next.textContent = bad ? '請先移除無法供應的餐點' : '確認餐點';
  }
  if (state.view === 'checkout' && !lines.length && !state.busy) setView('cart');
}

function createLine(l) {
  const el = document.createElement('div');
  el.className = 'line';
  el.innerHTML = '<div class="thumb sm" data-img="' + esc(l.id) + '"><span></span></div>' +
    '<div class="grow"><div class="line-main"></div>' +
    '<input class="note" type="text" maxlength="100" placeholder="備註,例:不要辣、去冰" data-note="' + esc(l.id) + '"></div>' +
    '<div class="stepper"></div>';
  return el;
}

function updateLine(el, l) {
  const ok = lineOk(l);
  el.classList.toggle('bad', !ok);
  const name = l.item ? l.item.name : '(已下架的餐點)';
  el.querySelector('.thumb span').textContent = firstChar(name);
  const who = !state.table.takeout && l.by && l.by !== state.uid ? ' <span class="tag">同桌</span>' : '';
  el.querySelector('.line-main').innerHTML = '<div class="name">' + esc(name) + who + '</div>' +
    (ok ? '<div class="sub">' + money(l.item.price) + ' × ' + l.qty + ' = <b>' + money(l.item.price * l.qty) + '</b></div>'
      : '<div class="sub warn">' + (l.item ? '已售完' : '已下架') + ',請移除</div>');
  el.querySelector('.stepper').innerHTML = ok ? stepperHtml(l.id, l.qty, false)
    : '<button type="button" class="ghost small" data-remove="' + esc(l.id) + '">移除</button>';
  const input = el.querySelector('.note');
  input.hidden = !ok;
  if (document.activeElement !== input && !noteTimers[l.id]) input.value = l.note;
}

// 備註:停止輸入 0.5 秒後存檔
$('cartList').addEventListener('input', e => {
  const id = e.target.dataset.note;
  if (!id) return;
  clearTimeout(noteTimers[id] && noteTimers[id].timer);
  const value = e.target.value;
  noteTimers[id] = { value, timer: setTimeout(() => saveNote(id), 500) };
});

function saveNote(id) {
  const t = noteTimers[id];
  if (!t) return Promise.resolve();
  clearTimeout(t.timer);
  delete noteTimers[id];
  const note = t.value.trim().slice(0, 100);
  return store.transaction(cartPath + '/items/' + id, cur => (cur ? Object.assign({}, cur, { note }) : undefined))
    .catch(e => toast('備註儲存失敗:' + friendlyError(e)));
}

function flushNotes() {
  return Promise.all(Object.keys(noteTimers).map(saveNote));
}

// ---------- 購物車視窗 ----------

// 全螢幕視窗:購物車(sheet)、已點的餐點(ordersSheet)。開啟時加一筆瀏覽紀錄,手機的「上一頁」就是關閉。
const SHEETS = ['sheet', 'ordersSheet'];

function anySheetOpen() {
  return SHEETS.some(id => !$(id).hidden);
}

function showOnly(id) {
  SHEETS.forEach(s => { $(s).hidden = s !== id; });
  document.body.classList.toggle('noscroll', !!id);
}

function openOverlay(id) {
  if (!$(id).hidden) return;
  if (!anySheetOpen()) history.pushState({ sheet: 1 }, '');
  showOnly(id);
}

function closeSheet() {
  if (!anySheetOpen()) return;
  if (history.state && history.state.sheet) history.back();   // popstate 會關掉視窗
  else showOnly(null);
}

window.addEventListener('popstate', () => showOnly(null));

function openSheet() {
  openOverlay('sheet');
  setView('cart');
}

function openOrders() {
  openOverlay('ordersSheet');
  $('ordersBody').scrollTop = 0;
}

function setView(view) {
  state.view = view;
  $('cartView').hidden = view !== 'cart';
  $('checkoutView').hidden = view !== 'checkout';
  $('sheetTitle').textContent = view === 'checkout' ? '確認餐點' : '購物車';
  $('sheetBody').scrollTop = 0;
  renderCart();
}

$('cartOpen').onclick = openSheet;
$('sheetBack').onclick = () => (state.view === 'checkout' ? setView('cart') : closeSheet());
$('ordersOpen').onclick = openOrders;
$('ordersBack').onclick = closeSheet;
$('orders').addEventListener('click', e => { if (e.target.closest('[data-open-orders]')) openOrders(); });

$('sheetNext').onclick = async () => {
  if (state.busy) return;
  if (state.view === 'cart') {
    await flushNotes();
    setView('checkout');
    return;
  }
  submitOrder();
};

function renderCheckout(lines, total) {
  $('checkoutList').innerHTML = lines.filter(lineOk).map(l =>
    '<div class="co-line"><span>' + esc(l.item.name) + ' × ' + l.qty +
    (l.note ? '<small>' + esc(l.note) + '</small>' : '') + '</span><span>' + money(l.item.price * l.qty) + '</span></div>'
  ).join('') + '<div class="co-line total"><span>合計</span><span>' + money(total) + '</span></div>';
}

function renderPayMethods() {
  const methods = payMethodsOf(state.config);
  if (methods.indexOf(state.pay) < 0) state.pay = methods.length === 1 ? methods[0] : '';
  $('payBlock').hidden = !methods.length;
  $('payMethods').innerHTML = methods.map(m =>
    '<label class="pay' + (m === state.pay ? ' on' : '') + '"><input type="radio" name="pay" value="' + esc(m) + '"' +
    (m === state.pay ? ' checked' : '') + '>' + esc(m) + '</label>').join('');
  $('payNotice').textContent = state.config.payNote || DEFAULT_PAY_NOTE;
}

$('payMethods').addEventListener('change', e => {
  state.pay = e.target.value;
  $('payMethods').querySelectorAll('.pay').forEach(el => {
    el.classList.toggle('on', el.querySelector('input').checked);
  });
});

// ---------- 送出訂單 ----------

async function submitOrder() {
  const c = state.config;
  if (c.open === false) return alertBox('目前暫停線上點餐', c.closedNote || '請洽店員');
  const methods = payMethodsOf(c);
  if (methods.length && !state.pay) return alertBox('請選擇付款方式', '');

  state.busy = true;
  renderCart();
  try {
    await flushNotes();
    const lines = cartLines();
    const bad = lines.filter(l => !lineOk(l));
    if (bad.length) throw new Error('有餐點剛剛售完了,請先從購物車移除');
    if (!lines.length) throw new Error('購物車是空的');

    const date = dateKey();
    const counter = await store.transaction('counters/' + date, n => (n || 0) + 1);
    if (!counter.committed) throw new Error('取號失敗,請再試一次');
    const no = counter.value;

    const id = store.newKey('orders');
    mySubmitted.add(id);
    const items = {};
    let total = 0;
    lines.forEach((l, i) => {
      items['i' + i] = { itemId: l.id, name: l.item.name, price: l.item.price, qty: l.qty, note: l.note };
      total += l.item.price * l.qty;
    });
    const updates = {};
    updates['orders/' + id] = {
      no, date, table: state.table.name, tableKey, takeout: !!state.table.takeout,
      items, total, payMethod: state.pay, note: $('orderNote').value.trim().slice(0, 100),
      status: 'unpaid', createdAt: store.now(), by: state.uid
    };
    updates[cartPath + '/orders/' + id] = store.now();
    lines.forEach(l => { updates[cartPath + '/items/' + l.id] = null; });
    const old = Date.now() - 24 * 3600e3;
    Object.keys(state.cart.orders || {}).forEach(oid => {
      if (state.cart.orders[oid] < old) updates[cartPath + '/orders/' + oid] = null;
    });
    await store.update(updates);
    remember(id, Date.now());
    syncOrderWatchers();

    if (state.pay) pref('pay', state.pay);
    $('orderNote').value = '';
    state.busy = false;
    closeSheet();
    const next = await modal(
      '<div class="ok-mark">✓</div><h3>訂單已送出</h3>' +
      '<p class="order-no">' + (state.table.takeout ? '取餐號碼' : '單號') + ' <b>#' + no + '</b></p>' +
      '<p class="big">' + money(total) + (state.pay ? '<small> · ' + esc(state.pay) + '</small>' : '') + '</p>' +
      '<div class="notice">' + esc(c.payNote || DEFAULT_PAY_NOTE) + '</div>',
      [{ label: '查看已點的餐點', value: 'orders' }, { label: '好', value: true, className: 'primary' }]);
    if (next === 'orders') openOrders();
  } catch (e) {
    const permission = /permission/i.test(String(e.code || '') + e.message);
    await alertBox('送出失敗', permission
      ? '店家可能剛更新了菜單價格或暫停接單,請重新確認購物車後再送出。'
      : friendlyError(e));
  } finally {
    state.busy = false;
    renderCart();
  }
}

// ---------- 已送出的訂單 ----------

// 訂單狀態:unpaid 未付款 → paid 已付款(製作中)→ served 已出餐;cancelled 已取消
const STATUS = {
  unpaid: ['未付款', '請至櫃台付款'],
  paid: ['製作中', '已付款,餐點準備中'],
  served: ['已出餐', ''],
  cancelled: ['已取消', '']
};

function myOrders() {
  return Object.keys(known)
    .filter(id => state.orders[id])
    .map(id => Object.assign({ id }, state.orders[id]))
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

function renderOrders() {
  if (!state.table) return;
  const list = myOrders();
  const live = list.filter(o => o.status !== 'cancelled');
  const unpaid = list.filter(o => o.status === 'unpaid');
  const cooking = list.filter(o => o.status === 'paid');
  const total = live.reduce((n, o) => n + orderTotal(o), 0);
  const unpaidTotal = unpaid.reduce((n, o) => n + orderTotal(o), 0);
  const title = state.table.takeout ? '我的訂單' : '本桌已點的餐點';

  // 底部列的「已點」按鈕
  $('ordersOpen').hidden = !list.length;
  $('ordersCount').textContent = list.length;
  $('ordersCount').classList.toggle('warn', unpaid.length > 0);

  // 菜單上方的狀態列
  $('orders').hidden = !list.length || !$('fatal').hidden;
  $('orders').innerHTML = !list.length ? '' :
    '<button type="button" class="orders-strip' + (unpaid.length ? ' has-unpaid' : '') + '" data-open-orders>' +
    '<span class="os-main"><b>' + esc(title) + '</b>' + live.length + ' 筆 · ' + money(total) + '</span>' +
    '<span class="os-state">' +
    (unpaid.length ? '<span class="pill unpaid">' + unpaid.length + ' 筆未付款</span>' : '') +
    (cooking.length ? '<span class="pill paid">' + cooking.length + ' 筆製作中</span>' : '') +
    '</span><span class="chev">›</span></button>';

  // 已點的餐點視窗
  $('ordersTitle').textContent = title;
  if (!list.length) {
    $('ordersBody').innerHTML = '<p class="empty">還沒有送出的訂單</p>';
    return;
  }
  $('ordersBody').innerHTML =
    '<div class="card orders-sum">' +
    '<div class="co-line total"><span>共 ' + live.length + ' 筆訂單</span><span>' + money(total) + '</span></div>' +
    (unpaid.length ? '<div class="notice">還有 ' + money(unpaidTotal) + ' 未付款,請至櫃台付款</div>' : '') +
    '</div>' +
    list.map(o => {
      const st = STATUS[o.status] || [o.status, ''];
      return '<div class="my-order st-' + esc(o.status) + '">' +
        '<div class="mo-head"><span class="mo-no">' + (state.table.takeout ? '取餐號碼 ' : '') + '#' + esc(o.no) + '</span>' +
        '<span class="muted">' + timeLabel(o.createdAt) + (o.payMethod ? ' · ' + esc(o.payMethod) : '') + '</span>' +
        '<span class="pill ' + esc(o.status) + '">' + st[0] + '</span></div>' +
        orderLines(o).map(l =>
          '<div class="co-line"><span>' + esc(l.name) + ' × ' + l.qty + (l.note ? '<small>' + esc(l.note) + '</small>' : '') +
          '</span><span>' + money(l.price * l.qty) + '</span></div>').join('') +
        (o.note ? '<div class="mo-note">備註:' + esc(o.note) + '</div>' : '') +
        '<div class="mo-foot"><span>' + st[1] + '</span><b>' + money(orderTotal(o)) + '</b></div>' +
        '</div>';
    }).join('');
}

start();
