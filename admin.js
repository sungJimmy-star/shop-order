// 店家後台(老闆的平板)。登入後即時收到訂單,按「已付款」分類;也在這裡改菜單、桌號 QR Code 和設定。
import {
  $, esc, money, splitList, payMethodsOf, dateKey, timeLabel, tableLabel, shortTable, firstChar, orderLines, orderTotal,
  groupMenu, driveUrl, imageLoader, fillImages, syncList, pref, friendlyError, loadStore, isDemo,
  modal, alertBox, confirmBox, promptBox, toast
} from './common.js';

const state = {
  user: null, config: {}, tables: {}, menu: {},
  unpaid: null,              // 所有未付款訂單(不限日期)
  kitchen: null,             // 已付款、還沒出餐的訂單
  day: null,                 // 「訂單紀錄」選的那一天的全部訂單
  dayKey: dateKey(), dayFilter: 'all',
  filter: '',                // 未付款的桌號篩選
  seen: new Set(),           // 這次開啟後看過的未付款訂單 id(判斷新訂單用)
  fresh: new Set(),          // 還沒點過的新訂單(卡片會閃)
  sound: pref('sound') !== 'off',
  booted: false
};
let store = null;
let loadImage = null;
let dayOff = null;
const noteTimers = {};

// ---------- 啟動與登入 ----------

function show(id) {
  ['loading', 'fatal', 'login', 'notAdmin'].forEach(x => { $(x).hidden = x !== id; });
}

function fatal(message) {
  $('fatalMsg').textContent = message;
  show('fatal');
}

$('fatalRetry').onclick = () => location.reload();

async function start() {
  try {
    store = await loadStore();
  } catch (e) {
    return fatal(e.message);
  }
  loadImage = imageLoader(store);
  if (isDemo) {
    $('demoHint').hidden = false;
    $('loginEmail').value = 'demo@example.com';
    $('loginPw').value = 'demo';
  }
  store.onAuth(onAuth);
  store.onConnection(onConnection);
}

async function onAuth(user) {
  if (state.booted) {
    if (!user) location.reload();
    return;
  }
  if (!user) {
    show('login');
    return;
  }
  let isAdmin = false;
  try {
    isAdmin = (await store.get('admins/' + user.uid)) === true;
  } catch (e) {
    console.warn('讀取 admins 失敗', e);
  }
  if (!isAdmin) {
    $('myUid').textContent = user.uid;
    $('myEmail').textContent = user.email ? '目前登入:' + user.email : '';
    show('notAdmin');
    return;
  }
  state.user = user;
  boot();
}

$('loginForm').addEventListener('submit', async e => {
  e.preventDefault();
  $('loginError').textContent = '';
  $('loginBtn').disabled = true;
  unlockAudio();
  try {
    await store.login($('loginEmail').value.trim(), $('loginPw').value);
  } catch (err) {
    $('loginError').textContent = err.message;
  } finally {
    $('loginBtn').disabled = false;
  }
});

$('notAdminLogout').onclick = () => store.logout();
$('logout').onclick = async () => {
  if (await confirmBox('要登出嗎?', '登出後這台平板就收不到新訂單了。', '登出')) store.logout();
};

let offlineTimer = null;
function onConnection(ok) {
  clearTimeout(offlineTimer);
  if (ok) $('offline').hidden = true;
  else offlineTimer = setTimeout(() => { $('offline').hidden = false; }, 3000);
}

function boot() {
  state.booted = true;
  show(null);
  $('tabs').hidden = false;
  $('topActions').hidden = false;
  const onError = e => toast('資料讀取失敗:' + friendlyError(e));

  store.watch('config', v => {
    state.config = v || {};
    renderTop();
    renderSettings();
    renderUnpaid();
  }, null, onError);
  store.watch('tables', v => {
    state.tables = v || {};
    renderTables();
  }, null, onError);
  store.watch('menu', v => {
    state.menu = v || {};
    renderMenuAdmin();
  }, null, onError);
  store.watch('orders', onUnpaid, { orderBy: 'status', equalTo: 'unpaid' }, onError);
  store.watch('orders', v => {
    state.kitchen = v || {};
    renderKitchen();
  }, { orderBy: 'status', equalTo: 'paid' }, onError);
  watchDay(state.dayKey);

  showTab(pref('tab') || 'unpaid');
  renderTop();
  $('accountEmail').textContent = state.user.email || '';
  $('accountUid').textContent = 'UID:' + state.user.uid;

  // 每 30 秒更新「幾分鐘前」;過了午夜自動換到新的一天
  setInterval(() => {
    renderUnpaid();
    renderKitchen();
    const today = dateKey();
    if (state.dayKey !== today && state.lastToday && state.dayKey === state.lastToday) watchDay(today);
    state.lastToday = today;
  }, 30000);
  state.lastToday = dateKey();
  keepScreenOn();
}

// ---------- 頁首:接單開關、提示音 ----------

function renderTop() {
  const c = state.config;
  $('shopName').textContent = (c.shopName || '店家') + ' 後台';
  const open = c.open !== false;
  $('openToggle').textContent = open ? '● 接單中' : '■ 暫停接單';
  $('openToggle').classList.toggle('off', !open);
  $('soundToggle').textContent = state.sound ? '🔔' : '🔕';
  updateAudioHint();
}

$('openToggle').onclick = async () => {
  const open = state.config.open !== false;
  if (open && !await confirmBox('暫停線上點餐?', '客人仍然看得到菜單,但不能送出訂單。', '暫停接單')) return;
  try {
    await store.set('config/open', !open);
    toast(open ? '已暫停接單' : '已恢復接單');
  } catch (e) {
    alertBox('更新失敗', friendlyError(e));
  }
};

$('soundToggle').onclick = () => {
  state.sound = !state.sound;
  pref('sound', state.sound ? 'on' : 'off');
  renderTop();
  if (state.sound) beep();
};

// 瀏覽器規定要先點過畫面才能發出聲音
let audioCtx = null;
function unlockAudio() {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!audioCtx && AC) audioCtx = new AC();
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().then(updateAudioHint);
  updateAudioHint();
}
document.addEventListener('pointerdown', unlockAudio);

function updateAudioHint() {
  $('audioHint').hidden = !state.booted || !state.sound || (!!audioCtx && audioCtx.state === 'running');
}

function beep() {
  if (!state.sound || !audioCtx || audioCtx.state !== 'running') return;
  const t0 = audioCtx.currentTime;
  [[0, 880], [0.18, 880], [0.36, 1320]].forEach(([d, f]) => {
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.frequency.value = f;
    o.connect(g);
    g.connect(audioCtx.destination);
    g.gain.setValueAtTime(0.0001, t0 + d);
    g.gain.exponentialRampToValueAtTime(0.5, t0 + d + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + d + 0.16);
    o.start(t0 + d);
    o.stop(t0 + d + 0.17);
  });
}

// 平板不要自動關螢幕(支援的瀏覽器才有效)
let wakeLock = null;
async function keepScreenOn() {
  try {
    if ('wakeLock' in navigator && document.visibilityState === 'visible') wakeLock = await navigator.wakeLock.request('screen');
  } catch (e) { /* 不支援或被拒絕,不影響使用 */ }
}
document.addEventListener('visibilitychange', () => {
  if (state.booted && document.visibilityState === 'visible' && !(wakeLock && !wakeLock.released)) keepScreenOn();
});

// ---------- 分頁 ----------

function showTab(tab) {
  if (!$('tab-' + tab)) tab = 'unpaid';
  pref('tab', tab);
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tab').forEach(el => { el.hidden = el.id !== 'tab-' + tab; });
  window.scrollTo(0, 0);
}

$('tabs').addEventListener('click', e => {
  const b = e.target.closest('button[data-tab]');
  if (b) showTab(b.dataset.tab);
});

// ---------- 未付款 ----------

function onUnpaid(v) {
  const orders = v || {};
  const first = state.unpaid === null;
  const recent = Date.now() - 10 * 60e3;
  const fresh = Object.keys(orders).filter(id => !first && !state.seen.has(id) && (orders[id].createdAt || 0) > recent);
  Object.keys(orders).forEach(id => state.seen.add(id));
  state.unpaid = orders;
  if (fresh.length) {
    fresh.forEach(id => state.fresh.add(id));
    beep();
    toast('新訂單:' + fresh.map(id => shortTable(orders[id]) + ' #' + orders[id].no).join('、'));
  }
  renderUnpaid();
}

function ago(ts) {
  const m = Math.floor((Date.now() - ts) / 60000);
  if (m < 1) return '剛剛';
  if (m < 60) return m + ' 分鐘前';
  const h = Math.floor(m / 60);
  if (h < 24) return h + ' 小時前';
  return Math.floor(h / 24) + ' 天前';
}

function tableSort(key) {
  const t = state.tables[key];
  return t ? (t.sort || 0) : 9999;
}

function renderUnpaid() {
  if (!state.unpaid) return;
  const all = Object.keys(state.unpaid)
    .map(id => Object.assign({ id }, state.unpaid[id]))
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  const sum = all.reduce((n, o) => n + orderTotal(o), 0);

  $('unpaidBadge').textContent = all.length;
  $('unpaidBadge').hidden = !all.length;
  document.title = (all.length ? '(' + all.length + ') ' : '') + (state.config.shopName || '店家') + ' 後台';
  $('unpaidSummary').innerHTML = all.length
    ? '未付款 <b>' + all.length + '</b> 筆,共 <b>' + money(sum) + '</b>' : '';
  $('unpaidEmpty').hidden = all.length > 0;

  // 依桌號篩選
  const byTable = new Map();
  all.forEach(o => {
    if (!byTable.has(o.tableKey)) byTable.set(o.tableKey, { label: shortTable(o), n: 0 });
    byTable.get(o.tableKey).n++;
  });
  if (state.filter && !byTable.has(state.filter)) state.filter = '';
  $('tableFilter').hidden = byTable.size < 2;
  $('tableFilter').innerHTML = chip('', '全部', all.length, state.filter) +
    [...byTable.entries()].sort((a, b) => tableSort(a[0]) - tableSort(b[0]))
      .map(([k, t]) => chip(k, t.label, t.n, state.filter)).join('');

  const shown = state.filter ? all.filter(o => o.tableKey === state.filter) : all;
  syncList($('unpaidList'), shown, o => o.id, createCard, updateCard);
}

function chip(value, label, n, current) {
  return '<button type="button" class="chip' + (value === current ? ' on' : '') + '" data-value="' + esc(value) + '">' +
    esc(label) + (n != null ? ' <span>' + n + '</span>' : '') + '</button>';
}

$('tableFilter').addEventListener('click', e => {
  const b = e.target.closest('.chip');
  if (!b) return;
  state.filter = b.dataset.value;
  renderUnpaid();
});

function itemsHtml(o) {
  return '<ul class="oc-items">' + orderLines(o).map(l =>
    '<li><span class="q">' + l.qty + '</span><span class="n">' + esc(l.name) +
    (l.note ? '<small>' + esc(l.note) + '</small>' : '') + '</span><span class="p">' + money(l.price * l.qty) + '</span></li>'
  ).join('') + '</ul>';
}

function payOptions(current) {
  const methods = payMethodsOf(state.config);
  if (current && methods.indexOf(current) < 0) methods.unshift(current);
  if (!current) methods.unshift('');
  return methods.map(m => '<option value="' + esc(m) + '"' + (m === current ? ' selected' : '') + '>' +
    (m ? esc(m) : '(未選)') + '</option>').join('');
}

function createCard() {
  const el = document.createElement('article');
  el.className = 'ocard';
  el.innerHTML = '<div class="oc-head"></div><div class="oc-body"></div>' +
    '<div class="oc-pay"><select class="pay-select" aria-label="付款方式"></select><strong class="oc-total"></strong></div>' +
    '<textarea class="admin-note" rows="1" maxlength="200" placeholder="店家備註(例:等等付、熟客)"></textarea>' +
    '<div class="oc-actions"><button type="button" class="ghost small" data-act="cancel">取消訂單</button>' +
    '<button type="button" class="primary" data-act="paid">已付款</button></div>';
  return el;
}

function updateCard(el, o) {
  el.classList.toggle('fresh', state.fresh.has(o.id));
  el.querySelector('.oc-head').innerHTML =
    '<span class="tbl' + (o.takeout ? ' to' : '') + '">' + esc(shortTable(o)) + '</span>' +
    '<strong class="no">#' + esc(o.no) + '</strong>' +
    '<span class="when">' + (o.date && o.date !== dateKey() ? esc(o.date.slice(5).replace('-', '/')) + ' ' : '') +
    timeLabel(o.createdAt) + ' · ' + ago(o.createdAt) + '</span>';
  el.querySelector('.oc-body').innerHTML = itemsHtml(o) +
    (o.note ? '<div class="cnote">客人備註:' + esc(o.note) + '</div>' : '');
  el.querySelector('.oc-total').textContent = money(orderTotal(o));
  const sel = el.querySelector('.pay-select');
  if (document.activeElement !== sel) sel.innerHTML = payOptions(o.payMethod || '');
  const ta = el.querySelector('.admin-note');
  if (document.activeElement !== ta && !noteTimers[o.id]) ta.value = o.adminNote || '';
  autoGrow(ta);
}

function autoGrow(ta) {
  ta.style.height = 'auto';
  ta.style.height = ta.scrollHeight + 2 + 'px';
}

$('unpaidList').addEventListener('click', async e => {
  const card = e.target.closest('.ocard');
  if (!card) return;
  const id = card.dataset.key;
  if (state.fresh.delete(id)) card.classList.remove('fresh');
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const o = state.unpaid[id];
  if (!o) return;
  if (btn.dataset.act === 'paid') markPaid(id, o);
  if (btn.dataset.act === 'cancel') cancelOrder(id, o);
});

$('unpaidList').addEventListener('change', e => {
  if (!e.target.classList.contains('pay-select')) return;
  const id = e.target.closest('.ocard').dataset.key;
  store.set('orders/' + id + '/payMethod', e.target.value).catch(err => toast('更新失敗:' + friendlyError(err)));
  e.target.blur();
});

// 店家備註:停止輸入 0.8 秒後存檔
$('unpaidList').addEventListener('input', e => {
  if (!e.target.classList.contains('admin-note')) return;
  autoGrow(e.target);
  const id = e.target.closest('.ocard').dataset.key;
  clearTimeout(noteTimers[id] && noteTimers[id].timer);
  noteTimers[id] = { value: e.target.value, timer: setTimeout(() => saveAdminNote(id), 800) };
});

function saveAdminNote(id) {
  const t = noteTimers[id];
  if (!t) return Promise.resolve();
  clearTimeout(t.timer);
  delete noteTimers[id];
  return store.set('orders/' + id + '/adminNote', t.value.trim().slice(0, 200))
    .catch(err => toast('備註儲存失敗:' + friendlyError(err)));
}

async function markPaid(id, o) {
  await saveAdminNote(id);
  const label = shortTable(o) + ' #' + o.no;
  try {
    await store.update({ ['orders/' + id + '/status']: 'paid', ['orders/' + id + '/paidAt']: store.now() });
    state.fresh.delete(id);
    toast('已付款:' + label + ' ' + money(orderTotal(o)) + ',移到待出餐', {
      label: '復原',
      run: () => setStatus(id, 'unpaid')
    });
  } catch (e) {
    alertBox('更新失敗', friendlyError(e));
  }
}

async function markServed(id, o) {
  try {
    await store.update({ ['orders/' + id + '/status']: 'served', ['orders/' + id + '/servedAt']: store.now() });
    toast('已出餐:' + shortTable(o) + ' #' + o.no, {
      label: '復原',
      run: () => setStatus(id, 'paid')
    });
  } catch (e) {
    alertBox('更新失敗', friendlyError(e));
  }
}

async function cancelOrder(id, o) {
  const ok = await confirmBox('取消這筆訂單?', shortTable(o) + ' #' + o.no + ' ' + money(orderTotal(o)) +
    '\n取消後會移到「訂單紀錄」,需要的話可以再恢復。', '取消訂單');
  if (!ok) return;
  await saveAdminNote(id);
  setStatus(id, 'cancelled');
}

function setStatus(id, status) {
  const p = 'orders/' + id + '/';
  const upd = { [p + 'status']: status };
  if (status === 'unpaid') {
    upd[p + 'paidAt'] = null;
    upd[p + 'servedAt'] = null;
  }
  if (status === 'paid') upd[p + 'servedAt'] = null;
  if (status === 'cancelled') upd[p + 'cancelledAt'] = store.now();
  return store.update(upd).catch(e => alertBox('更新失敗', friendlyError(e)));
}

// ---------- 待出餐 ----------

function renderKitchen() {
  if (!state.kitchen) return;
  const list = Object.keys(state.kitchen)
    .map(id => Object.assign({ id }, state.kitchen[id]))
    .sort((a, b) => (a.paidAt || a.createdAt || 0) - (b.paidAt || b.createdAt || 0));
  $('kitchenBadge').textContent = list.length;
  $('kitchenBadge').hidden = !list.length;
  $('kitchenSummary').innerHTML = list.length ? '已付款、待出餐 <b>' + list.length + '</b> 筆(先付款的排前面)' : '';
  $('kitchenEmpty').hidden = list.length > 0;
  $('serveAll').hidden = list.length < 2;
  syncList($('kitchenList'), list, o => o.id, createKitchenCard, updateKitchenCard);
}

function createKitchenCard() {
  const el = document.createElement('article');
  el.className = 'ocard kitchen';
  el.innerHTML = '<div class="oc-head"></div><div class="oc-body"></div>' +
    '<div class="oc-actions"><button type="button" class="primary" data-act="served">已出餐</button></div>';
  return el;
}

function updateKitchenCard(el, o) {
  const paidAt = o.paidAt || o.createdAt;
  el.querySelector('.oc-head').innerHTML =
    '<span class="tbl' + (o.takeout ? ' to' : '') + '">' + esc(shortTable(o)) + '</span>' +
    '<strong class="no">#' + esc(o.no) + '</strong>' +
    '<span class="when">付款 ' + timeLabel(paidAt) + ' · ' + ago(paidAt) + '</span>';
  el.querySelector('.oc-body').innerHTML = itemsHtml(o) +
    (o.note ? '<div class="cnote">客人備註:' + esc(o.note) + '</div>' : '') +
    (o.adminNote ? '<div class="cnote mine">📝 ' + esc(o.adminNote) + '</div>' : '');
}

$('kitchenList').addEventListener('click', e => {
  const btn = e.target.closest('button[data-act=served]');
  if (!btn) return;
  const id = btn.closest('.ocard').dataset.key;
  const o = state.kitchen[id];
  if (o) markServed(id, o);
});

$('serveAll').onclick = async () => {
  const ids = Object.keys(state.kitchen || {});
  if (!ids.length) return;
  if (!await confirmBox('全部標為已出餐?', '共 ' + ids.length + ' 筆訂單。', '全部已出餐', 'primary')) return;
  const upd = {};
  ids.forEach(id => {
    upd['orders/' + id + '/status'] = 'served';
    upd['orders/' + id + '/servedAt'] = store.now();
  });
  store.update(upd).catch(e => alertBox('更新失敗', friendlyError(e)));
};

// ---------- 訂單紀錄 ----------

function watchDay(key) {
  if (dayOff) dayOff();
  state.dayKey = key;
  state.day = null;
  $('dayPick').value = key;
  $('dayList').innerHTML = '<p class="empty">載入中…</p>';
  $('dayStats').innerHTML = '';
  dayOff = store.watch('orders', v => {
    state.day = v || {};
    renderDay();
  }, { orderBy: 'date', equalTo: key }, e => toast('讀取失敗:' + friendlyError(e)));
}

$('dayPick').addEventListener('change', () => {
  if ($('dayPick').value) watchDay($('dayPick').value);
});

function shiftDay(delta) {
  const d = new Date(state.dayKey + 'T12:00:00+08:00');
  d.setDate(d.getDate() + delta);
  watchDay(dateKey(d.getTime()));
}
$('dayPrev').onclick = () => shiftDay(-1);
$('dayNext').onclick = () => shiftDay(1);

const STATUS_LABEL = { unpaid: '未付款', paid: '待出餐', served: '已出餐', cancelled: '已取消' };
const isPaid = o => o.status === 'paid' || o.status === 'served';

function dayOrders() {
  return Object.keys(state.day || {})
    .map(id => Object.assign({ id }, state.day[id]))
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

function renderDay() {
  if (!state.day) return;
  const list = dayOrders();
  const paid = list.filter(isPaid);
  const unpaid = list.filter(o => o.status === 'unpaid');
  const cancelled = list.filter(o => o.status === 'cancelled');
  const sum = arr => arr.reduce((n, o) => n + orderTotal(o), 0);

  const byMethod = {};
  paid.forEach(o => {
    const m = o.payMethod || '(未選)';
    byMethod[m] = (byMethod[m] || 0) + orderTotal(o);
  });
  $('dayStats').innerHTML =
    '<div class="stat main"><span>已收款(' + paid.length + ' 筆)</span><b>' + money(sum(paid)) + '</b></div>' +
    Object.keys(byMethod).map(m => '<div class="stat"><span>' + esc(m) + '</span><b>' + money(byMethod[m]) + '</b></div>').join('') +
    (unpaid.length ? '<div class="stat warn"><span>未付款(' + unpaid.length + ' 筆)</span><b>' + money(sum(unpaid)) + '</b></div>' : '') +
    (cancelled.length ? '<div class="stat muted"><span>已取消</span><b>' + cancelled.length + ' 筆</b></div>' : '');

  const counts = { all: list.length, paid: paid.length, unpaid: unpaid.length, cancelled: cancelled.length };
  $('dayFilter').innerHTML = [['all', '全部'], ['paid', '已付款'], ['unpaid', '未付款'], ['cancelled', '已取消']]
    .map(([k, label]) => chip(k, label, counts[k], state.dayFilter)).join('');

  const filters = { all: () => true, paid: isPaid, unpaid: o => o.status === 'unpaid', cancelled: o => o.status === 'cancelled' };
  const shown = list.filter(filters[state.dayFilter] || filters.all);
  if (!shown.length) {
    const label = { all: '', paid: '已付款的', unpaid: '未付款的', cancelled: '取消的' }[state.dayFilter] || '';
    $('dayList').innerHTML = '<p class="empty">這天沒有' + label + '訂單</p>';
    return;
  }
  const BUTTONS = {
    unpaid: '<button type="button" class="primary small" data-hact="paid">已付款</button>',
    paid: '<button type="button" class="ghost small" data-hact="unpaid">改回未付款</button>' +
      '<button type="button" class="primary small" data-hact="served">已出餐</button>',
    served: '<button type="button" class="ghost small" data-hact="paid">改回待出餐</button>',
    cancelled: '<button type="button" class="ghost small" data-hact="unpaid">恢復訂單</button>'
  };
  $('dayList').innerHTML = shown.map(o => {
    const btn = BUTTONS[o.status] || '';
    return '<div class="hrow st-' + esc(o.status) + '" data-id="' + esc(o.id) + '">' +
      '<div class="h-main">' +
      '<div class="h-head"><span class="tbl' + (o.takeout ? ' to' : '') + '">' + esc(shortTable(o)) + '</span>' +
      '<b>#' + esc(o.no) + '</b><span class="muted">' + timeLabel(o.createdAt) + '</span>' +
      '<span class="pill ' + esc(o.status) + '">' + (STATUS_LABEL[o.status] || esc(o.status)) + '</span></div>' +
      '<div class="h-items">' + orderLines(o).map(l => esc(l.name) + '×' + l.qty).join('、') + '</div>' +
      (o.note ? '<div class="h-note">客人:' + esc(o.note) + '</div>' : '') +
      (o.adminNote ? '<div class="h-note mine">📝 ' + esc(o.adminNote) + '</div>' : '') +
      '</div>' +
      '<div class="h-side"><b>' + money(orderTotal(o)) + '</b><span class="muted">' + esc(o.payMethod || '') + '</span>' +
      '<div class="h-btns"><button type="button" class="ghost small" data-hact="note">備註</button>' + btn + '</div></div>' +
      '</div>';
  }).join('');
}

$('dayFilter').addEventListener('click', e => {
  const b = e.target.closest('.chip');
  if (!b) return;
  state.dayFilter = b.dataset.value;
  renderDay();
});

$('dayList').addEventListener('click', async e => {
  const btn = e.target.closest('button[data-hact]');
  if (!btn) return;
  const id = btn.closest('.hrow').dataset.id;
  const o = state.day[id];
  if (!o) return;
  const act = btn.dataset.hact;
  if (act === 'note') {
    const note = await promptBox('店家備註:' + shortTable(o) + ' #' + o.no, o.adminNote || '', { multiline: true, maxLength: 200 });
    if (note !== null) store.set('orders/' + id + '/adminNote', note).catch(err => alertBox('更新失敗', friendlyError(err)));
  } else if (act === 'paid') {
    if (o.status === 'unpaid') markPaid(id, o);
    else setStatus(id, 'paid');
  } else if (act === 'served') {
    markServed(id, o);
  } else if (act === 'unpaid') {
    setStatus(id, 'unpaid');
  }
});

$('exportCsv').onclick = () => {
  const list = dayOrders().reverse();
  if (!list.length) return alertBox('這天沒有訂單', '');
  const rows = [['日期', '時間', '單號', '桌號', '品項', '金額', '付款方式', '狀態', '付款時間', '出餐時間', '客人備註', '店家備註']];
  list.forEach(o => rows.push([
    o.date, timeLabel(o.createdAt), o.no, shortTable(o),
    orderLines(o).map(l => l.name + '×' + l.qty + (l.note ? '(' + l.note + ')' : '')).join('、'),
    orderTotal(o), o.payMethod || '', STATUS_LABEL[o.status] || o.status, timeLabel(o.paidAt), timeLabel(o.servedAt),
    o.note || '', o.adminNote || ''
  ]));
  const csv = rows.map(r => r.map(v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"').join(',')).join('\r\n');
  // 開頭加 BOM,Excel 才會用 UTF-8 開啟,中文不會變亂碼
  const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = '訂單_' + state.dayKey + '.csv';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};

// ---------- 菜單 ----------

function renderMenuAdmin() {
  const groups = groupMenu(state.menu, state.config.categories);
  const n = Object.keys(state.menu).length;
  const sold = Object.values(state.menu).filter(m => m.available === false).length;
  $('menuSummary').textContent = n ? '共 ' + n + ' 項' + (sold ? ',' + sold + ' 項售完' : '') : '';
  $('catHint').textContent = groups.length ? '目前的分類:' + groups.map(g => g.name).join('、') : '';
  if (!n) {
    $('menuList').innerHTML = '<p class="empty">還沒有品項,按右上角「新增品項」開始建立菜單</p>';
    return;
  }
  $('menuList').innerHTML = groups.map(g =>
    '<h3 class="group">' + esc(g.name) + '<span>' + g.items.length + ' 項</span></h3>' +
    g.items.map((it, i) =>
      '<div class="mrow' + (it.available === false ? ' soldout' : '') + '" data-id="' + esc(it.id) + '">' +
      '<div class="thumb" data-img="' + esc(it.id) + '"><span>' + esc(firstChar(it.name)) + '</span></div>' +
      '<div class="grow"><div class="name">' + esc(it.name) + '</div>' +
      '<div class="sub">' + money(it.price) + (it.desc ? ' · ' + esc(it.desc) : '') + '</div></div>' +
      '<button type="button" class="avail' + (it.available === false ? ' off' : '') + '" data-mact="avail">' +
      (it.available === false ? '售完' : '供應中') + '</button>' +
      '<div class="move"><button type="button" class="icon-btn" data-mact="up"' + (i === 0 ? ' disabled' : '') + ' aria-label="上移">▲</button>' +
      '<button type="button" class="icon-btn" data-mact="down"' + (i === g.items.length - 1 ? ' disabled' : '') + ' aria-label="下移">▼</button></div>' +
      '<button type="button" class="ghost small" data-mact="edit">編輯</button>' +
      '</div>').join('')
  ).join('');
  fillImages($('menuList'), state.menu, loadImage);
}

$('menuList').addEventListener('click', e => {
  const btn = e.target.closest('button[data-mact]');
  if (!btn) return;
  const id = btn.closest('.mrow').dataset.id;
  const it = state.menu[id];
  if (!it) return;
  const act = btn.dataset.mact;
  if (act === 'edit') openEditor(id);
  if (act === 'avail') {
    const next = it.available === false;
    store.set('menu/' + id + '/available', next)
      .then(() => toast(it.name + (next ? ' 恢復供應' : ' 設為售完')))
      .catch(err => alertBox('更新失敗', friendlyError(err)));
  }
  if (act === 'up' || act === 'down') moveItem(id, act === 'up' ? -1 : 1);
});

/** 同分類內上下移動:依目前顯示順序重新編號,再交換兩個品項 */
function moveItem(id, delta) {
  const flat = [];
  groupMenu(state.menu, state.config.categories).forEach(g => g.items.forEach(it => flat.push(it)));
  const i = flat.findIndex(it => it.id === id);
  const j = i + delta;
  if (j < 0 || j >= flat.length || (flat[j].category || '') !== (flat[i].category || '')) return;
  [flat[i], flat[j]] = [flat[j], flat[i]];
  const upd = {};
  flat.forEach((it, k) => {
    const sort = (k + 1) * 10;
    if (it.sort !== sort) upd['menu/' + it.id + '/sort'] = sort;
  });
  store.update(upd).catch(err => alertBox('更新失敗', friendlyError(err)));
}

// ---------- 品項編輯 ----------

let editing = null;     // { id, image: null | { data } | { remove: true } }

function openEditor(id) {
  const it = id ? state.menu[id] : null;
  editing = { id: id || null, image: null };
  $('edTitle').textContent = it ? '編輯品項' : '新增品項';
  $('edName').value = it ? it.name : '';
  $('edPrice').value = it ? it.price : '';
  $('edCategory').value = it ? it.category || '' : pref('lastCategory');
  $('edDesc').value = it ? it.desc || '' : '';
  $('edAvailable').checked = !it || it.available !== false;
  $('edImgUrl').value = it ? it.imgUrl || '' : '';
  $('edFile').value = '';
  $('edDelete').hidden = !it;
  $('catList').innerHTML = groupMenu(state.menu, state.config.categories)
    .map(g => '<option value="' + esc(g.name) + '">').join('');
  renderPreview();
  $('editor').hidden = false;
  document.body.classList.add('noscroll');
  $('editor').querySelector('.sheet-body').scrollTop = 0;
  if (!it) $('edName').focus();
}

function closeEditor() {
  $('editor').hidden = true;
  document.body.classList.remove('noscroll');
  editing = null;
}

function renderPreview() {
  const box = $('edPreview');
  box.querySelector('span').textContent = firstChar($('edName').value || '?');
  const old = box.querySelector('img');
  if (old) old.remove();
  box.classList.remove('has-img');
  const setSrc = src => {
    if (!src) return;
    const img = document.createElement('img');
    img.alt = '';
    img.onerror = () => { img.remove(); box.classList.remove('has-img'); };
    img.src = src;
    box.appendChild(img);
    box.classList.add('has-img');
  };
  const url = $('edImgUrl').value.trim();
  if (editing.image && editing.image.data) return setSrc(editing.image.data);
  if (url) return setSrc(driveUrl(url));
  if (editing.image && editing.image.remove) return;
  const it = editing.id && state.menu[editing.id];
  if (it && it.imgVer) loadImage(editing.id, it, src => { if (editing && !box.querySelector('img')) setSrc(src); });
}

$('edName').addEventListener('input', () => {
  $('edPreview').querySelector('span').textContent = firstChar($('edName').value || '?');
});
$('edImgUrl').addEventListener('input', () => {
  if ($('edImgUrl').value.trim()) editing.image = null;
  renderPreview();
});
$('edRemoveImg').onclick = () => {
  editing.image = { remove: true };
  $('edImgUrl').value = '';
  $('edFile').value = '';
  renderPreview();
};
$('edFile').addEventListener('change', async () => {
  const file = $('edFile').files[0];
  if (!file) return;
  try {
    editing.image = { data: await resizeImage(file) };
    $('edImgUrl').value = '';
    renderPreview();
  } catch (e) {
    alertBox('圖片讀取失敗', e.message);
  }
});

/**
 * 縮小成最長邊 480px 的 JPEG,控制在約 80KB 以內。
 * Firebase 免費方案每月下載量 10GB,菜單圖片越小,能服務的客人越多。
 */
async function resizeImage(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('無法讀取這張圖片,請換一張(建議 JPG 或 PNG)'));
      i.src = url;
    });
    const max = 480;
    const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';            // PNG 透明背景變白色
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    let q = 0.8;
    let data = canvas.toDataURL('image/jpeg', q);
    while (data.length > 110000 && q > 0.35) {
      q -= 0.1;
      data = canvas.toDataURL('image/jpeg', q);
    }
    return data;
  } finally {
    URL.revokeObjectURL(url);
  }
}

$('edClose').onclick = closeEditor;
$('edForm').addEventListener('submit', e => {
  e.preventDefault();
  saveItem();
});
$('edSave').onclick = saveItem;

async function saveItem() {
  if (!editing) return;
  const name = $('edName').value.trim();
  const priceText = $('edPrice').value.trim();
  if (!name) return alertBox('請填寫品名', '');
  if (!/^\d+$/.test(priceText)) return alertBox('價格請填整數', '例:120');

  const id = editing.id || store.newKey('menu');
  const old = state.menu[id] || {};
  const maxSort = Math.max(0, ...Object.values(state.menu).map(m => m.sort || 0));
  const url = $('edImgUrl').value.trim();
  const item = {
    name,
    price: Number(priceText),
    category: $('edCategory').value.trim(),
    desc: $('edDesc').value.trim(),
    available: $('edAvailable').checked,
    sort: old.sort != null ? old.sort : maxSort + 10,
    imgUrl: url,
    imgVer: old.imgVer || 0
  };
  const upd = {};
  if (editing.image && editing.image.data) {
    item.imgVer = Date.now();
    item.imgUrl = '';
    upd['menuImages/' + id] = editing.image.data;
  } else if (url || (editing.image && editing.image.remove)) {
    item.imgVer = 0;
    if (old.imgVer) upd['menuImages/' + id] = null;
  }
  upd['menu/' + id] = item;

  $('edSave').disabled = true;
  $('edSave').textContent = '儲存中…';
  try {
    await store.update(upd);
    if (item.category) pref('lastCategory', item.category);
    closeEditor();
    toast('已儲存:' + name);
  } catch (e) {
    alertBox('儲存失敗', friendlyError(e));
  } finally {
    $('edSave').disabled = false;
    $('edSave').textContent = '儲存';
  }
}

$('edDelete').onclick = async () => {
  if (!editing || !editing.id) return;
  const it = state.menu[editing.id];
  if (!await confirmBox('刪除「' + it.name + '」?', '只是暫時不賣的話,改成「售完」就好,不用刪除。', '刪除')) return;
  try {
    await store.update({ ['menu/' + editing.id]: null, ['menuImages/' + editing.id]: null });
    closeEditor();
    toast('已刪除:' + it.name);
  } catch (e) {
    alertBox('刪除失敗', friendlyError(e));
  }
};

$('addItem').onclick = () => openEditor(null);

// ---------- 設定 ----------

let settingsDirty = false;
$('settingsForm').addEventListener('input', () => { settingsDirty = true; });

function renderSettings() {
  if (settingsDirty) return;    // 正在修改時不要被蓋掉
  const c = state.config;
  $('setShopName').value = c.shopName || '';
  $('setTagline').value = c.tagline || '';
  $('setPayMethods').value = payMethodsOf(c).join(',');
  $('setPayNote').value = c.payNote || '';
  $('setCategories').value = splitList(c.categories).join(',');
  $('setClosedNote').value = c.closedNote || '';
}

$('settingsForm').addEventListener('submit', async e => {
  e.preventDefault();
  const shopName = $('setShopName').value.trim();
  if (!shopName) return alertBox('請填寫店名', '');
  try {
    await store.update({
      'config/shopName': shopName,
      'config/tagline': $('setTagline').value.trim(),
      'config/payMethods': splitList($('setPayMethods').value).join(','),   // 存成文字:空白才存得住(空陣列會被 Firebase 刪掉)
      'config/payNote': $('setPayNote').value.trim(),
      'config/categories': splitList($('setCategories').value).join(','),
      'config/closedNote': $('setClosedNote').value.trim()
    });
    settingsDirty = false;
    toast('設定已儲存');
  } catch (err) {
    alertBox('儲存失敗', friendlyError(err));
  }
});

// ---------- 桌號與 QR Code ----------

function sortedTables() {
  return Object.keys(state.tables)
    .map(key => Object.assign({ key }, state.tables[key]))
    .sort((a, b) => (a.sort || 0) - (b.sort || 0) || String(a.name).localeCompare(String(b.name), 'zh-Hant', { numeric: true }));
}

/** 顧客點餐頁網址(跟後台放在同一個資料夾) */
function customerUrl(key) {
  return new URL('./?t=' + encodeURIComponent(key) + (isDemo ? '&demo=1' : ''), location.href).href;
}

function makeQr(el, text, size) {
  el.innerHTML = '';
  if (!window.QRCode) {
    el.textContent = 'QR Code 元件載入失敗';
    return;
  }
  new window.QRCode(el, { text, width: size, height: size, correctLevel: window.QRCode.CorrectLevel.M });
  el.title = '';
}

function renderTables() {
  const list = sortedTables();
  if (!list.length) {
    $('tableList').innerHTML = '<p class="empty">還沒有桌號,按「新增桌號」開始</p>';
    return;
  }
  $('tableList').innerHTML = list.map(t =>
    '<div class="qcard" data-key="' + esc(t.key) + '">' +
    '<div class="qr" data-qr="' + esc(customerUrl(t.key)) + '"></div>' +
    '<div class="qname">' + esc(tableLabel(t)) + '</div>' +
    '<div class="qbtns">' +
    '<a class="ghost small" href="' + esc(customerUrl(t.key)) + '" target="_blank" rel="noopener">開啟</a>' +
    '<button type="button" class="ghost small" data-tact="rename">改名</button>' +
    '<button type="button" class="ghost small danger-text" data-tact="delete">刪除</button>' +
    '</div></div>').join('');
  $('tableList').querySelectorAll('[data-qr]').forEach(el => makeQr(el, el.dataset.qr, 132));
}

function newTableKey() {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  let k = '';
  for (let i = 0; i < 10; i++) k += chars[Math.floor(Math.random() * chars.length)];
  return k;
}

$('addTable').onclick = async () => {
  const nums = Object.values(state.tables).map(t => Number(t.name)).filter(n => Number.isInteger(n));
  const next = nums.length ? Math.max(...nums) + 1 : 1;
  const name = await promptBox('新增桌號', String(next), { hint: '填數字會顯示成「第 N 桌」,也可以填「包廂A」之類的名稱', maxLength: 20 });
  if (!name) return;
  if (Object.values(state.tables).some(t => !t.takeout && t.name === name)) return alertBox('已經有這個桌號了', name);
  const sort = Number.isInteger(Number(name)) ? Number(name) : 500 + Object.keys(state.tables).length;
  store.set('tables/' + newTableKey(), { name, sort, takeout: false })
    .catch(e => alertBox('新增失敗', friendlyError(e)));
};

$('addTakeout').onclick = async () => {
  const has = Object.values(state.tables).filter(t => t.takeout).length;
  const name = await promptBox('新增外帶 QR', has ? '外帶' + (has + 1) : '外帶', { hint: '外帶 QR 每支手機各自點餐,不共用購物車', maxLength: 20 });
  if (!name) return;
  store.set('tables/' + newTableKey(), { name, sort: 1000 + has, takeout: true })
    .catch(e => alertBox('新增失敗', friendlyError(e)));
};

$('tableList').addEventListener('click', async e => {
  const btn = e.target.closest('button[data-tact]');
  if (!btn) return;
  const key = btn.closest('.qcard').dataset.key;
  const t = state.tables[key];
  if (!t) return;
  if (btn.dataset.tact === 'rename') {
    const name = await promptBox('桌號改名', t.name, { hint: 'QR Code 不會變,不用重印', maxLength: 20 });
    if (!name || name === t.name) return;
    const upd = { ['tables/' + key + '/name']: name };
    if (!t.takeout && Number.isInteger(Number(name))) upd['tables/' + key + '/sort'] = Number(name);
    store.update(upd).catch(err => alertBox('更新失敗', friendlyError(err)));
  }
  if (btn.dataset.tact === 'delete') {
    const ok = await confirmBox('刪除「' + tableLabel(t) + '」?', '這張 QR Code 會立刻失效,客人掃了會顯示「QR Code 已失效」。已經送出的訂單不受影響。', '刪除');
    if (!ok) return;
    store.update({ ['tables/' + key]: null, ['carts/' + key]: null })
      .catch(err => alertBox('刪除失敗', friendlyError(err)));
  }
});

$('printQr').onclick = () => {
  const list = sortedTables();
  if (!list.length) return alertBox('還沒有桌號', '請先新增桌號');
  const shop = state.config.shopName || '';
  $('printArea').innerHTML = list.map(t =>
    '<div class="pcard"><div class="pshop">' + esc(shop) + '</div>' +
    '<div class="ptable">' + esc(tableLabel(t)) + '</div>' +
    '<div class="pqr" data-qr="' + esc(customerUrl(t.key)) + '"></div>' +
    '<div class="phint">手機掃描 QR Code 點餐</div></div>').join('');
  $('printArea').querySelectorAll('[data-qr]').forEach(el => makeQr(el, el.dataset.qr, 360));
  setTimeout(() => window.print(), 400);
};

start();
