/**
 * App 控制層 —— 把 model / wallet / stats / db / queue / export 接到畫面上。
 *
 * 這一支刻意**不做計算**：所有跟錢有關的算式都在 model.js / wallet.js / stats.js，
 * 那些在 Node 測得到。這裡只負責「讀出來、畫上去、寫回去」。
 * 一旦開始在這裡算錢，就等於把最容易錯的東西搬到最難測的地方。
 */

import {
  defaultSettings, derive, symbolOf, localDay, tripDays, dayOfTrip,
  CATEGORIES, PAYMENT_METHODS,
} from './model.js';
import { cashBalance, makeCorrection, cashBurn, pendingRefund } from './wallet.js';
import {
  todayTotal, tripTotal, preTripTotal, byCategory, byPayment, byCity, byPayer,
  dailySeries, budgetProgress, topSpends, healthCheck, onTripSpending,
} from './stats.js';
import * as db from './db.js';
import { createQueue, STATUS } from './queue.js';
import { configureRateLimit } from './gemini.js';
import { compress, toBase64, getCoords, cityFromSchedule, parseSchedule } from './camera.js';
import { fetchReferenceRate, compareToSettings } from './fx.js';
import { buildWorkbook, toCSV, buildBackup, parseBackup } from './export.js';

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, kids = []) => {
  const n = Object.assign(document.createElement(tag), props);
  for (const k of [].concat(kids)) n.append(k);
  return n;
};

const state = {
  settings: defaultSettings(),
  records: [],
  wallet: [],
  tab: 'home',
  filter: { category: null, payer: null, payment: null, city: null },
  search: '',
  currentPayer: 'p1',
};

let queue;

// ---------------------------------------------------------------------------
// 顯示格式。金額一律「原幣大字 + 本位幣小字」（§9）
// ---------------------------------------------------------------------------
const nf = (n, dp = 0) =>
  n == null || Number.isNaN(n) ? '—' : n.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });

const local = (n) => `${symbolOf(state.settings.localCurrency)}${nf(n)}`;
const homeM = (n) => (n == null ? '—' : `${symbolOf(state.settings.homeCurrency)}${nf(n, 2)}`);

/** 今天（用當地時區判斷，§16 第 10 條：晚上 11:30 吃拉麵不可以歸錯天）。 */
function todayLocal() {
  const tz = state.settings.localTimezone || 'Asia/Tokyo';
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

// ---------------------------------------------------------------------------
// 啟動
// ---------------------------------------------------------------------------
async function boot() {
  try {
    state.settings = await db.loadSettings(defaultSettings());
  } catch (e) {
    banner('bad', `讀不到設定：${e.message}`);
  }
  configureRateLimit({ rpm: state.settings.rpm ?? 15 });
  state.currentPayer = state.settings.payers?.[0]?.id || 'p1';

  await reload();

  queue = createQueue({
    getApiKey: () => state.settings.apiKey,
    getSettings: () => state.settings,
    onUpdate: () => renderScan(),
    save: onRecognized,
  });

  wireTabs();
  wireScan();
  wireHome();
  wireSettings();
  render();
}

async function reload() {
  state.records = (await db.allRecords()).map((r) => derive(r, state.settings));
  state.wallet = await db.all(db.STORES.wallet);
}

function banner(kind, text) {
  $('banners').append(el('div', { className: `banner ${kind}`, textContent: text }));
}

function clearBanners() { $('banners').textContent = ''; }

// ---------------------------------------------------------------------------
// Tab
// ---------------------------------------------------------------------------
function wireTabs() {
  for (const b of $('tabs').querySelectorAll('button')) {
    b.onclick = () => {
      state.tab = b.dataset.tab;
      for (const x of $('tabs').querySelectorAll('button')) {
        x.setAttribute('aria-current', String(x === b));
      }
      render();
    };
  }
}

function render() {
  for (const name of ['home', 'records', 'scan', 'manual', 'stats', 'settings']) {
    $(`tab-${name}`).hidden = name !== state.tab;
  }
  renderHeader();
  clearBanners();
  renderWarnings();
  ({ home: renderHome, records: renderRecords, scan: renderScan,
     manual: renderManual, stats: renderStats, settings: renderSettings }[state.tab])();
}

function renderHeader() {
  const s = state.settings;
  const total = tripDays(s);
  const n = dayOfTrip(todayLocal(), s);
  $('title').textContent = '旅行記帳';
  $('subtitle').textContent = total
    ? (n ? `Day ${n} of ${total}　${todayLocal()}` : `行程 ${s.tripStart} ~ ${s.tripEnd}（尚未開始或已結束）`)
    : '還沒設定行程 —— 去設定頁填行程起訖日';
}

/** 首頁紅字提醒（§17.4）。只講**現在就該處理**的，不要變成雜訊。 */
function renderWarnings() {
  const s = state.settings;
  if (!s.apiKey) banner('bad', '還沒填 API key，拍照無法辨識。去設定頁貼上。');
  if (!s.cashRate || !s.cardRate) banner('warn', '匯率還沒設，本位幣金額會顯示「—」。');
  if (!s.tripStart || !s.tripEnd) banner('warn', '還沒設行程起訖日，Day N、每日曲線、行前判斷都不會動。');
  const red = state.records.filter((r) => r.needsReview && !r.reviewed).length;
  if (red) banner('info', `有 ${red} 筆待確認（辨識驗算對不上），有空的時候點紅點進去修。`);
}

// ---------------------------------------------------------------------------
// 首頁
// ---------------------------------------------------------------------------
function wireHome() {
  const sel = $('cashPayer');
  sel.onchange = () => { state.currentPayer = sel.value; renderHome(); };
  $('btnTopup').onclick = () => askAmount('補充現金', '在 ATM 領了多少？', async (amount) => {
    await db.put(db.STORES.wallet, {
      type: 'topup', payerId: state.currentPayer, amount, at: new Date().toISOString(),
    });
    await reload(); render();
  });
  $('btnCorrect').onclick = () => askAmount(
    '校正餘額', '實際數一次錢包，現在總共有多少？', async (actual) => {
      const op = makeCorrection({
        payerId: state.currentPayer, actualBalance: actual,
        records: state.records, walletOps: state.wallet,
      });
      await db.put(db.STORES.wallet, op);
      await reload(); render();
      banner(op.delta === 0 ? 'info' : 'warn', `校正完成：${op.note}`);
    });
}

function renderHome() {
  const s = state.settings;
  const sel = $('cashPayer');
  sel.textContent = '';
  for (const p of s.payers || []) {
    if (!p.name) continue;
    sel.append(el('option', { value: p.id, textContent: p.name, selected: p.id === state.currentPayer }));
  }

  const bal = cashBalance(state.currentPayer, state.records, state.wallet);
  $('cash').textContent = local(bal);

  const burn = cashBurn(state.currentPayer, state.records, state.wallet, s, todayLocal());
  if (!burn) {
    $('cashHint').textContent = '還沒有現金支出可以估算速度';
  } else if (burn.daysLeft == null) {
    $('cashHint').textContent = `每天約 ${local(Math.round(burn.perDay))}`;
  } else {
    const left = burn.daysLeft;
    const remain = (tripDays(s) || 0) - (dayOfTrip(todayLocal(), s) || 0);
    const tight = remain > 0 && left < remain;
    $('cashHint').innerHTML =
      `照目前速度還能撐 <strong class="${tight ? 'bad' : ''}">${left.toFixed(1)} 天</strong>` +
      `（每天約 ${local(Math.round(burn.perDay))}）` +
      (tight ? ' —— 行程還有 ' + remain + ' 天，該去領錢了' : '');
  }

  $('today').textContent = homeM(todayTotal(state.records, todayLocal()));
  $('total').textContent = homeM(tripTotal(state.records));

  const bp = budgetProgress(state.records, s);
  if (!bp) {
    $('budgetPct').textContent = '未設預算';
    $('budgetBar').firstElementChild.style.width = '0';
    $('budgetHint').textContent = '';
  } else {
    $('budgetPct').textContent = `${(bp.percent * 100).toFixed(0)}%`;
    $('budgetBar').classList.toggle('over', bp.percent > 1);
    $('budgetBar').firstElementChild.style.width = `${Math.min(100, bp.percent * 100)}%`;
    $('budgetHint').textContent =
      `${homeM(bp.used)} / ${homeM(bp.budget)}　每日預算 ${homeM(bp.perDay)}`;
  }

  const pre = preTripTotal(state.records);
  $('preTrip').textContent = pre ? `行前已付 ${homeM(pre)}（機票／住宿等，不計入每日曲線）` : '';

  const today = onTripSpending(state.records)
    .filter((r) => localDay(r.date) === todayLocal())
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));
  $('todayCount').textContent = `${today.length} 筆`;
  fillList($('todayList'), today, '今天還沒有紀錄');
}

// ---------------------------------------------------------------------------
// 紀錄
// ---------------------------------------------------------------------------
function fillList(ul, rows, emptyText) {
  ul.textContent = '';
  if (!rows.length) { ul.append(el('li', { className: 'sub', textContent: emptyText })); return; }
  for (const r of rows) {
    const left = el('div', {}, [
      el('div', { innerHTML: `<strong>${escape(r.storeName || r.storeNameLocal || '(未命名)')}</strong>` }),
      el('div', { className: 'sub', textContent:
        [String(r.date || '').slice(0, 16).replace('T', ' '), r.category, r.paymentMethod, r.city]
          .filter(Boolean).join('　') }),
    ]);
    const right = el('div', { style: 'text-align:right' }, [
      el('div', { className: 'num', textContent: r.isTopUp ? `${local(r.amount)}（儲值）` : local(r.amount) }),
      el('div', { className: 'sub num', textContent: r.amountHome == null ? '—' : `≈ ${homeM(r.amountHome)}` }),
    ]);
    const li = el('li', { className: 'item' }, [
      el('div', { style: 'display:flex;gap:10px;align-items:center;min-width:0' },
        (r.needsReview && !r.reviewed) ? [el('span', { className: 'dot' }), left] : [left]),
      right,
    ]);
    li.onclick = () => openRecord(r);
    ul.append(li);
  }
}

const escape = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function renderRecords() {
  const chips = $('filters');
  chips.textContent = '';
  const add = (key, value, label) => {
    const b = el('button', { className: 'chip', textContent: label });
    b.setAttribute('aria-pressed', String(state.filter[key] === value));
    b.onclick = () => { state.filter[key] = state.filter[key] === value ? null : value; renderRecords(); };
    chips.append(b);
  };
  for (const c of CATEGORIES) add('category', c, c);
  for (const p of PAYMENT_METHODS) add('payment', p, p);
  for (const p of state.settings.payers || []) if (p.name) add('payer', p.id, p.name);

  $('search').oninput = (e) => { state.search = e.target.value.trim(); renderRecords(); };

  const q = state.search.toLowerCase();
  const rows = state.records
    .filter((r) => !state.filter.category || r.category === state.filter.category)
    .filter((r) => !state.filter.payment || r.paymentMethod === state.filter.payment)
    .filter((r) => !state.filter.payer || r.payer === state.filter.payer)
    .filter((r) => !q || JSON.stringify([r.storeName, r.storeNameLocal, r.note, r.items]).toLowerCase().includes(q))
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));

  $('recCount').textContent = `全部紀錄（${rows.length}）`;
  fillList($('recList'), rows, '還沒有紀錄');

  $('btnTrash').onclick = async () => {
    const rows2 = await db.recentlyDeleted();
    dialog('最近刪除', rows2.length
      ? el('ul', { className: 'list' }, rows2.map((r) => {
          const li = el('li', { className: 'item' }, [
            el('div', { textContent: `${r.storeName || '(未命名)'}　${local(r.amount)}` }),
            el('button', { className: 'btn', textContent: '復原', style: 'min-height:44px' }),
          ]);
          li.lastChild.onclick = async () => { await db.undelete(r.id); await reload(); $('dlg').close(); render(); };
          return li;
        }))
      : el('div', { className: 'sub', textContent: '沒有已刪除的紀錄' }),
      [['關閉', () => $('dlg').close()]]);
  };
}

// ---------------------------------------------------------------------------
// 單筆詳情 / 編輯
// ---------------------------------------------------------------------------
function openRecord(r) {
  const body = el('div');
  if (r.storeNameLocal) body.append(el('div', { className: 'sub', textContent: r.storeNameLocal }));

  if (r.needsReview && r.reviewReason) {
    body.append(el('div', { className: 'banner warn', textContent: `要看一下：${r.reviewReason}` }));
  }
  if (r.issues?.length) {
    body.append(el('div', { className: 'banner bad', innerHTML: r.issues.map(escape).join('<br>') }));
  }

  const f = (label, key, type = 'text', opts) => {
    const wrap = el('div', { className: 'field' }, [el('label', { textContent: label })]);
    let input;
    if (opts) {
      input = el('select');
      for (const o of opts) input.append(el('option', { value: o, textContent: o, selected: r[key] === o }));
    } else {
      input = el('input', { type, value: r[key] ?? '' });
      if (type === 'number') input.inputMode = 'numeric';
    }
    input.dataset.key = key;
    wrap.append(input);
    body.append(wrap);
    return input;
  };

  f('日期時間', 'date', 'datetime-local');
  f('金額（當地）', 'amount', 'number');
  f('類別', 'category', 'text', CATEGORIES);
  f('支付方式', 'paymentMethod', 'text', PAYMENT_METHODS);
  f('付款人', 'payer', 'text', (state.settings.payers || []).filter((p) => p.name).map((p) => p.id));
  f('城市', 'city');
  f('備註', 'note');

  body.append(el('div', { className: 'sub', textContent:
    `城市來源：${r.citySource || '未知'}　輸入方式：${r.entryMode}　` +
    `${r.isPreTrip ? '行前　' : ''}${r.isTopUp ? '儲值（不計花費）　' : ''}` +
    `${r.taxType ? '稅制：' + r.taxType : ''}` }));

  if (r.taxRefundPending > 0) {
    body.append(el('div', { className: 'banner info', textContent:
      `待退稅 ${local(r.taxRefundPending)} —— 這是應收，不是已省。實際退到多少回來再補記。` }));
  }

  db.photosOf(r.id).then((photos) => {
    for (const p of photos) {
      body.append(el('img', { className: 'shot', src: URL.createObjectURL(p.blob) }));
    }
  }).catch(() => {});

  dialog(r.storeName || '(未命名)', body, [
    ['儲存', async () => {
      const patch = {};
      for (const input of body.querySelectorAll('[data-key]')) {
        const k = input.dataset.key;
        patch[k] = input.type === 'number' ? Number(input.value) : input.value;
      }
      const merged = { ...r, ...patch, reviewed: true };
      delete merged.day; delete merged.amountHome; delete merged.isPreTrip;
      await db.put(db.STORES.records, merged);
      await reload(); $('dlg').close(); render();
    }],
    ['刪除', async () => {
      // §17.2：刪除二次確認，且進「最近刪除」可復原，不是直接消失
      if (!confirm(`刪除「${r.storeName || '這筆'}」？可以到「最近刪除」復原。`)) return;
      await db.softDelete(r.id);
      await reload(); $('dlg').close(); render();
    }, 'danger'],
    ['關閉', () => $('dlg').close()],
  ]);
}

// ---------------------------------------------------------------------------
// 掃描
// ---------------------------------------------------------------------------
function wireScan() {
  $('btnShoot').onclick = () => $('shot').click();
  $('shot').onchange = async (e) => {
    const files = [...e.target.files];
    e.target.value = '';           // 讓同一張可以再拍一次
    for (const file of files) await intake(file);
  };
  $('btnRetryAll').onclick = () => queue.retryAllFailed();

  $('btnQuickSave').onclick = quickSave;
}

/** 拍完立刻回到相機（§3）——所以這裡只做「存起來 + 丟進佇列」，不等辨識。 */
async function intake(file) {
  const id = crypto.randomUUID();
  let shot;
  try {
    shot = await compress(file);
  } catch (err) {
    banner('bad', `照片處理失敗：${err.message}`);
    return;
  }
  // 座標抓不到也照樣往下走（§8 三層 fallback）
  const coords = await getCoords();
  await db.putPhoto(id, shot.blob);

  queue.add({
    id,
    imageBase64: await toBase64(shot.blob),
    mimeType: 'image/jpeg',
    coords,
    capturedAt: new Date().toISOString(),
  });
  renderScan();
}

/** 佇列辨識完成 → 落地成一筆紀錄。 */
async function onRecognized(item) {
  const d = item.data || {};
  const date = d.date
    ? `${d.date}T${d.time || '12:00'}`
    : item.capturedAt;

  const city = d.city
    || (item.coords ? null : cityFromSchedule(date, state.settings.schedule));

  const rec = {
    id: item.id,
    date,
    storeName: d.storeName, storeNameLocal: d.storeNameLocal,
    items: d.items, amount: d.total,
    currency: state.settings.localCurrency,
    payer: state.currentPayer,
    paymentMethod: d.paymentMethod,
    category: d.category,
    city,
    citySource: d.city ? 'gps' : (city ? 'schedule' : null),
    coords: item.coords,
    isTopUp: !!d.isTopUp,
    taxType: d.taxType, taxDetail: d.taxDetail,
    taxRefundPending: d.taxRefundPending,
    refundStatus: d.taxRefundPending > 0 ? 'pending' : 'none',
    discounts: d.discounts,
    entryMode: 'scan',
    // 程式端驗算優先於 AI 自評（§7.5：不看 AI 的 checks，自己重算）
    needsReview: (item.issues?.length || 0) > 0 || d.needsReview === true,
    reviewReason: item.issues?.join('；') || d.reviewReason || null,
    issues: item.issues,
    model: item.model, escalated: item.escalated,
  };
  await db.put(db.STORES.records, rec);
  await reload();
  if (state.tab === 'home' || state.tab === 'records') render();
}

function renderScan() {
  const q = queue?.summary() || { total: 0, items: [] };
  $('qStat').textContent = q.total
    ? `${q.done}/${q.total} 完成　${q.pending} 排隊　${q.failed} 失敗`
    : '閒置';
  $('btnRetryAll').hidden = !q.failed;

  const ul = $('qList');
  ul.textContent = '';
  if (!q.items.length) {
    ul.append(el('li', { className: 'sub', textContent: '沒有排隊中的照片' }));
  }
  for (const it of q.items.slice(-12).reverse()) {
    const label = { [STATUS.pending]: '排隊中', [STATUS.running]: '辨識中…',
                    [STATUS.done]: '完成', [STATUS.failed]: '失敗' }[it.status];
    const li = el('li', { className: 'item' }, [
      el('div', {}, [
        el('div', { textContent: label }),
        el('div', { className: 'sub', textContent: it.error || (it.data?.storeName ?? '') }),
      ]),
    ]);
    if (it.status === STATUS.failed) {
      const b = el('button', { className: 'btn', textContent: '重試', style: 'min-height:44px' });
      b.onclick = (ev) => { ev.stopPropagation(); queue.retry(it.id); };
      li.append(b);
    }
    ul.append(li);
  }

  // 快速記帳的金額鍵
  const qa = $('quickAmounts');
  qa.textContent = '';
  for (const amt of state.settings.quickAmounts || []) {
    const b = el('button', { className: 'btn', textContent: local(amt) });
    b.onclick = () => { $('quickCustom').value = amt; };
    qa.append(b);
  }
  const cats = $('quickCats');
  if (!cats.dataset.built) {
    for (const c of CATEGORIES) {
      const b = el('button', { className: 'chip', textContent: c });
      b.setAttribute('aria-pressed', String(c === '餐飲'));
      b.onclick = () => {
        for (const x of cats.children) x.setAttribute('aria-pressed', String(x === b));
      };
      cats.append(b);
    }
    cats.dataset.built = '1';
  }
}

/** 三秒快速記帳（§9）：金額 + 類別，兩下完成。沒有照片，不套 needsReview。 */
async function quickSave() {
  const amount = Number($('quickCustom').value);
  if (!amount) { banner('warn', '先填金額'); return; }
  const cat = [...$('quickCats').children].find((c) => c.getAttribute('aria-pressed') === 'true')?.textContent || '其他';
  const now = new Date();
  await db.put(db.STORES.records, {
    id: crypto.randomUUID(),
    date: now.toISOString().slice(0, 16),
    amount,
    currency: state.settings.localCurrency,
    category: cat,
    paymentMethod: '現金',
    payer: state.currentPayer,
    city: cityFromSchedule(now.toISOString(), state.settings.schedule),
    citySource: 'schedule',
    entryMode: 'quick',
    needsReview: false,
  });
  $('quickCustom').value = '';
  await reload();
  banner('info', `已記一筆 ${local(amount)}（${cat}）`);
  renderScan();
}

// ---------------------------------------------------------------------------
// 手動輸入
// ---------------------------------------------------------------------------
function renderManual() {
  const box = $('manualForm');
  if (box.dataset.built) return;
  box.dataset.built = '1';

  const fields = [
    ['date', '日期時間', 'datetime-local'],
    ['storeName', '項目 / 店名', 'text'],
    ['amount', '金額', 'number'],
    ['currency', '幣別', 'select', [state.settings.localCurrency, state.settings.homeCurrency]],
    ['category', '類別', 'select', CATEGORIES],
    ['paymentMethod', '支付方式', 'select', PAYMENT_METHODS],
    ['payer', '付款人', 'select', (state.settings.payers || []).filter((p) => p.name).map((p) => p.id)],
    ['city', '城市', 'text'],
    ['note', '備註', 'text'],
  ];
  for (const [key, label, type, opts] of fields) {
    const wrap = el('div', { className: 'field' }, [el('label', { textContent: label })]);
    let input;
    if (type === 'select') {
      input = el('select');
      for (const o of opts) input.append(el('option', { value: o, textContent: o }));
    } else {
      input = el('input', { type });
      if (type === 'number') input.inputMode = 'numeric';
    }
    input.dataset.key = key;
    wrap.append(input);
    box.append(wrap);
  }
  box.append(el('div', { className: 'sub', textContent:
    '日期早於行程首日會自動歸成「行前」，只計總數、不進每日曲線。' }));

  $('btnManualSave').onclick = async () => {
    const rec = { id: crypto.randomUUID(), entryMode: 'manual', needsReview: false };
    for (const input of box.querySelectorAll('[data-key]')) {
      rec[input.dataset.key] = input.type === 'number' ? Number(input.value) : input.value;
    }
    if (!rec.amount) { banner('warn', '金額沒填'); return; }
    if (!rec.date) rec.date = new Date().toISOString().slice(0, 16);
    await db.put(db.STORES.records, rec);
    await reload();
    for (const input of box.querySelectorAll('[data-key]')) {
      if (input.type !== 'select-one') input.value = '';
    }
    banner('info', `已儲存 ${rec.storeName || ''} ${nf(rec.amount)}`);
  };
}

// ---------------------------------------------------------------------------
// 統計
// ---------------------------------------------------------------------------
function bars(rows, fmt = homeM) {
  const max = Math.max(1, ...rows.map((r) => Math.abs(r.value)));
  const box = el('div');
  if (!rows.length) return el('div', { className: 'sub', textContent: '還沒有資料' });
  for (const r of rows) {
    box.append(el('div', { style: 'margin:10px 0' }, [
      el('div', { className: 'row' }, [
        el('span', { textContent: r.key || '未分類' }),
        el('span', { className: 'sub num', textContent: fmt(r.value) }),
      ]),
      el('div', { className: 'bar' }, [el('i', { style: `width:${(Math.abs(r.value) / max) * 100}%` })]),
    ]));
  }
  return box;
}

function renderStats() {
  const R = state.records;
  const daily = dailySeries(R, state.settings)
    .map((d) => ({ key: `Day ${d.day ?? '-'}　${String(d.date).slice(5)}`, value: d.value }));
  $('chartDaily').replaceChildren(bars(daily));
  $('chartCat').replaceChildren(bars(byCategory(R)));
  $('chartPay').replaceChildren(bars(byPayment(R)));
  $('chartCity').replaceChildren(bars(byCity(R)));

  const names = new Map((state.settings.payers || []).map((p) => [p.id, p.name || p.id]));
  $('chartPayer').replaceChildren(bars(byPayer(R).map((x) => ({ ...x, key: names.get(x.key) || x.key }))));

  $('refundTotal').textContent = local(pendingRefund(R));

  const top = topSpends(R);
  const t = el('table');
  t.append(el('tr', {}, [el('th', { textContent: '店名' }), el('th', { className: 'n', textContent: '金額' })]));
  for (const s of top) {
    t.append(el('tr', {}, [
      el('td', {}, [el('div', { textContent: s.storeName || '(未命名)' }),
                    el('div', { className: 'sub', textContent: String(s.date).slice(0, 10) })]),
      el('td', { className: 'n' }, [el('div', { textContent: local(s.amount) }),
                                    el('div', { className: 'sub', textContent: homeM(s.amountHome) })]),
    ]));
  }
  $('topList').replaceChildren(top.length ? t : el('div', { className: 'sub', textContent: '還沒有資料' }));
}

// ---------------------------------------------------------------------------
// 設定
// ---------------------------------------------------------------------------
function settingField(parent, key, label, type = 'text', opts) {
  const wrap = el('div', { className: 'field' }, [el('label', { textContent: label })]);
  let input;
  if (opts) {
    input = el('select');
    for (const o of opts) input.append(el('option', { value: o, textContent: o, selected: state.settings[key] === o }));
  } else {
    input = el('input', { type, value: state.settings[key] ?? '' });
    if (type === 'number') input.inputMode = 'decimal';
  }
  input.onchange = async () => {
    state.settings[key] = type === 'number' ? Number(input.value) : input.value;
    await db.saveSettings(state.settings);
    renderHeader();
  };
  wrap.append(input);
  parent.append(wrap);
}

function wireSettings() {
  $('btnRefRate').onclick = async () => {
    $('refRateOut').textContent = '查詢中…';
    try {
      const r = await fetchReferenceRate(state.settings.homeCurrency, state.settings.localCurrency);
      state.settings.referenceRate = r.rate;
      state.settings.referenceRateAt = r.at;
      await db.saveSettings(state.settings);
      const cmp = compareToSettings(r.rate, state.settings);
      $('refRateOut').innerHTML =
        `市場參考：1 ${escape(state.settings.homeCurrency)} = ${r.rate.toFixed(3)} ` +
        `${escape(state.settings.localCurrency)}（${escape(r.source)}）<br>` +
        cmp.map((c) => `${c.label} ${c.mine}：${escape(c.hint)}`).join('<br>') +
        '<br><span class="sub">參考值而已，沒有動你的設定。</span>';
    } catch (e) {
      $('refRateOut').textContent = `查不到：${e.message}（離線也沒關係，設定的匯率照樣能用）`;
    }
  };

  $('btnHealth').onclick = () => {
    const h = healthCheck(state.records, state.settings);
    const lines = [
      [`待確認（紅點）`, h.needsReview.length],
      [`城市是用行程推的（可能歸錯）`, h.cityFromSchedule.length],
      [`掃描但沒照片`, h.noPhoto.length],
      [`算不出本位幣金額`, h.noHomeAmount.length],
      [`疑似重複`, h.duplicates.length],
    ];
    const box = el('div');
    for (const [label, n] of lines) {
      box.append(el('div', { className: 'row' }, [
        el('span', { textContent: label }),
        el('strong', { className: n ? 'warn' : 'good', textContent: String(n) }),
      ]));
    }
    if (h.missingRates) box.append(el('div', { className: 'banner warn', textContent: '匯率沒設完' }));
    $('healthOut').replaceChildren(box);
  };

  $('btnXlsx').onclick = exportExcel;
  $('btnBackup').onclick = exportBackup;
  $('btnRestore').onclick = () => $('restoreFile').click();
  $('restoreFile').onchange = importBackup;
}

function renderSettings() {
  const basic = $('settingsBasic'); basic.textContent = '';
  settingField(basic, 'homeCurrency', '本位幣', 'text', ['SGD', 'MYR', 'TWD', 'USD', 'EUR']);
  settingField(basic, 'localCurrency', '當地幣別', 'text', ['JPY', 'KRW', 'TWD', 'THB']);
  settingField(basic, 'tripStart', '行程首日', 'date');
  settingField(basic, 'tripEnd', '行程末日', 'date');
  settingField(basic, 'totalBudget', `總預算（${state.settings.homeCurrency}）`, 'number');
  settingField(basic, 'budgetSourceNote', '預算來源備註', 'text');

  const fx = $('settingsFx'); fx.textContent = '';
  fx.append(el('div', { className: 'sub', style: 'margin-bottom:10px', textContent:
    `填「1 ${state.settings.homeCurrency} 換到多少 ${state.settings.localCurrency}」。` +
    '換現金和刷卡的成本不一樣，所以分兩個。' }));
  settingField(fx, 'cashRate', '現金匯率', 'number');
  settingField(fx, 'cardRate', '刷卡匯率', 'number');

  const payers = $('settingsPayers'); payers.textContent = '';
  (state.settings.payers || []).forEach((p, i) => {
    const nameW = el('div', { className: 'field' }, [el('label', { textContent: `付款人 ${i + 1}` })]);
    const name = el('input', { value: p.name || '', placeholder: i ? '（沒有第二人就留白）' : '' });
    name.onchange = async () => {
      state.settings.payers[i].name = name.value;
      await db.saveSettings(state.settings); render();
    };
    nameW.append(name);

    const cashW = el('div', { className: 'field' }, [el('label', { textContent: '初始現金' })]);
    const cash = el('input', { type: 'number', inputMode: 'numeric', value: p.initialCash || 0 });
    cash.onchange = async () => {
      const amount = Number(cash.value);
      state.settings.payers[i].initialCash = amount;
      await db.saveSettings(state.settings);
      // 初始現金是一筆錢包操作，不是純設定——否則餘額算不出來
      const existing = state.wallet.find((w) => w.type === 'init' && w.payerId === p.id);
      await db.put(db.STORES.wallet, existing
        ? { ...existing, amount }
        : { type: 'init', payerId: p.id, amount, at: new Date().toISOString() });
      await reload(); render();
    };
    cashW.append(cash);
    payers.append(nameW, cashW);
  });

  const sch = $('settingsSchedule'); sch.textContent = '';
  sch.append(el('div', { className: 'sub', style: 'margin-bottom:8px', textContent:
    'GPS 失效時的備援。一行一個：城市 起日 迄日（例：旭川 2026-11-29 2026-11-30）' }));
  const ta = el('textarea', { value: (state.settings.schedule || [])
    .map((r) => `${r.city} ${r.from} ${r.to}`).join('\n') });
  ta.onchange = async () => {
    const { rows, bad } = parseSchedule(ta.value);
    state.settings.schedule = rows;
    await db.saveSettings(state.settings);
    // 格式壞掉的行要講出來，不要靜靜吞掉
    sch.querySelector('.banner')?.remove();
    if (bad.length) sch.append(el('div', { className: 'banner warn',
      textContent: `這幾行看不懂，沒有存進去：${bad.join(' / ')}` }));
  };
  sch.append(el('div', { className: 'field' }, [ta]));

  const api = $('settingsApi'); api.textContent = '';
  settingField(api, 'apiKey', 'Gemini API key', 'password');
  settingField(api, 'rpm', '發送速率（每分鐘幾張）', 'number');
  api.append(el('div', { className: 'sub', textContent:
    '⚠️ 每個人要用自己的 key。共用一把會互相吃掉額度，用量也會混在一起。' }));

  const pf = $('preflight'); pf.textContent = '';
  const s = state.settings;
  const checks = [
    ['行程起訖日', !!(s.tripStart && s.tripEnd)],
    ['總預算', s.totalBudget > 0],
    ['現金匯率', s.cashRate > 0],
    ['刷卡匯率', s.cardRate > 0],
    ['初始現金', (s.payers || []).some((p) => p.initialCash > 0)],
    ['行程表（GPS 備援）', (s.schedule || []).length > 0],
    ['API key', !!s.apiKey],
    ['備份試過一次', !!s.lastBackupAt],
    ['拿真收據試拍過', state.records.some((r) => r.entryMode === 'scan')],
  ];
  for (const [label, done] of checks) {
    pf.append(el('li', { className: 'item' }, [
      el('span', { textContent: label }),
      el('strong', { className: done ? 'good' : 'warn', textContent: done ? '✓' : '未完成' }),
    ]));
  }
}

// ---------------------------------------------------------------------------
// 匯出
// ---------------------------------------------------------------------------
function download(blob, filename) {
  const a = el('a', { href: URL.createObjectURL(blob), download: filename });
  document.body.append(a); a.click(); a.remove();
}

function stamp() { return new Date().toISOString().slice(0, 10); }

function exportExcel() {
  try {
    const wb = buildWorkbook(state.records, state.settings);
    globalThis.XLSX.writeFile(wb, `旅行記帳_${stamp()}.xlsx`);
    $('exportOut').textContent = `已匯出 ${state.records.length} 筆（Excel）`;
  } catch (e) {
    // SheetJS 沒載到（多半是沒網路）→ 退回 CSV，而不是靜靜地什麼都沒發生
    download(new Blob([toCSV(state.records, state.settings)], { type: 'text/csv' }),
             `旅行記帳_${stamp()}.csv`);
    $('exportOut').textContent = `${e.message}　已改用 CSV 匯出 ${state.records.length} 筆`;
  }
}

async function exportBackup() {
  const photosByRecord = new Map();
  for (const r of state.records) {
    const ps = await db.photosOf(r.id);
    if (ps.length) photosByRecord.set(r.id, await Promise.all(ps.map((p) => toBase64(p.blob))));
  }
  const backup = buildBackup({
    records: state.records, walletOps: state.wallet, settings: state.settings, photosByRecord,
  });
  download(new Blob([JSON.stringify(backup)], { type: 'application/json' }),
           `旅行記帳_備份_${stamp()}.json`);
  state.settings.lastBackupAt = new Date().toISOString();
  await db.saveSettings(state.settings);
  $('exportOut').textContent =
    `已備份 ${backup.counts.records} 筆、${backup.counts.photos} 張照片`;
}

async function importBackup(e) {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  let b;
  try {
    b = parseBackup(await file.text());
  } catch (err) {
    banner('bad', `備份檔有問題，整份沒有匯入：${err.message}`);
    return;
  }
  if (!confirm(`要匯入 ${b.records.length} 筆紀錄嗎？現有資料會被合併（同 id 覆蓋）。`)) return;
  for (const r of b.records) await db.put(db.STORES.records, r);
  for (const w of b.walletOps) await db.put(db.STORES.wallet, w);
  await reload(); render();
  banner('info', `已匯入 ${b.records.length} 筆`);
}

// ---------------------------------------------------------------------------
// 對話框
// ---------------------------------------------------------------------------
function dialog(title, body, buttons) {
  $('dlgBody').replaceChildren(el('h3', { textContent: title, style: 'margin:0 0 12px' }), body);
  const foot = $('dlgFoot'); foot.textContent = '';
  for (const [label, fn, kind] of buttons) {
    const b = el('button', { className: `btn ${kind || ''}`, textContent: label });
    b.onclick = fn;
    foot.append(b);
  }
  $('dlg').showModal();
}

function askAmount(title, hint, onOk) {
  const input = el('input', { type: 'number', inputMode: 'numeric', style: 'width:100%' });
  dialog(title, el('div', { className: 'field' }, [el('label', { textContent: hint }), input]), [
    ['確定', async () => {
      const v = Number(input.value);
      if (!Number.isFinite(v)) return;
      $('dlg').close();
      await onOk(v);
    }],
    ['取消', () => $('dlg').close()],
  ]);
}

boot().catch((e) => {
  document.body.prepend(el('div', { className: 'banner bad', textContent: `啟動失敗：${e.message}` }));
});
