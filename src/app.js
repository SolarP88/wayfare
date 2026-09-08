/**
 * App 控制層 —— 把 model / wallet / stats / db / queue / export 接到畫面上。
 *
 * 這一支刻意**不做計算**：所有跟錢有關的算式都在 model.js / wallet.js / stats.js，
 * 那些在 Node 測得到。這裡只負責「讀出來、畫上去、寫回去」。
 * 一旦開始在這裡算錢，就等於把最容易錯的東西搬到最難測的地方。
 */

import {
  defaultSettings, derive, symbolOf, localDay, tripDays, dayOfTrip, isSpending,
  localStamp, localToday, CATEGORIES, PAYMENT_METHODS,
} from './model.js';
import { cashBalance, potBalance, makeCorrection, cashBurn, pendingRefund } from './wallet.js';
import {
  todayTotal, tripTotal, preTripTotal, byCategory, byPayment, byCity, byPayer,
  dailySeries, budgetProgress, topSpends, healthCheck, onTripSpending,
  tripTotalLocal, todayTotalLocal, otherCurrencyTotal,
  byCategoryLocal, byPaymentLocal, byPayerLocal, byCityLocal,
} from './stats.js';
import { buildLines, toRecords, isBalanced, decimalsOf } from './split.js';
import { priceDiscountTotal } from './country-rules/japan.js';
import * as db from './db.js';
import { createQueue, STATUS } from './queue.js';
import { configureRateLimit } from './gemini.js';
import {
  compress, toBase64, fromBase64, getCoords, cityFromSchedule, parseSchedule,
} from './camera.js';
import { fetchReferenceRate, compareToSettings } from './fx.js';
import {
  buildWorkbook, toCSV, buildBackup, parseBackup, receiptsFromLegacyRecords,
} from './export.js';

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, kids = []) => {
  const n = Object.assign(document.createElement(tag), props);
  for (const k of [].concat(kids)) n.append(k);
  return n;
};

const state = {
  settings: defaultSettings(),
  records: [],          // 一個品項一筆，**只含已確認的**（草稿不進統計）
  receipts: [],
  drafts: [],           // 辨識完還沒確認的收據
  confirmDraft: null,   // 確認頁正在編的那一張（記憶體副本，按存才寫回）
  returnTab: 'records',
  wallet: [],
  tab: 'home',
  filter: { category: null, payer: null, payment: null, city: null },
  search: '',
  recMode: 'date',              // 紀錄頁：'date' 按日期 / 'cat' 按類別
  currentPayer: 'p1',
};

let queue;

// ---------------------------------------------------------------------------
// 顯示格式。金額一律「原幣大字 + 本位幣小字」（§9）
// ---------------------------------------------------------------------------
const nf = (n, dp = 0) =>
  n == null || Number.isNaN(n) ? '—' : n.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });

const local = (n) => `${symbolOf(state.settings.localCurrency)}${nf(n)}`;

/**
 * 照**那一筆自己的幣別**印。
 *
 * ⚠️ 2026-09-08 修：列表原本一律用 local()，等於不管那筆是什麼幣別都印 ¥。
 * 她手動記了一筆 S$1,000 的東西，列表印成「¥1,000」，看起來就像記成日圓、
 * 還以為現金錢包被扣了（實際上沒有）。**幣別印錯比金額印錯更難發現。**
 */
const amt = (n, currency) => {
  const cur = currency || state.settings.localCurrency;
  return `${symbolOf(cur)}${nf(n, decimalsOf(cur))}`;
};
const homeM = (n) => (n == null ? '—' : `${symbolOf(state.settings.homeCurrency)}${nf(n, 2)}`);

/** 今天（用當地時區判斷，§16 第 10 條：晚上 11:30 吃拉麵不可以歸錯天）。 */
function todayLocal() {
  // 跟每一筆紀錄的時間戳走**同一個鐘**（手機時區）。
  // 原本這裡用寫死的 Asia/Tokyo、紀錄卻用 UTC，兩邊不同源，午夜前後一定對不上。
  return localToday();
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
  // 記住上次選的付款人。原本每次開 App 都重設回第一位——
  // 同伴付的那幾筆會默默記到她頭上（2026-09-08 她問「怎麼知道是誰付的」）。
  const savedPayer = (() => {
    try { return localStorage.getItem('wayfare-payer'); } catch { return null; }
  })();
  const ids = (state.settings.payers || []).filter((p) => p.name).map((p) => p.id);
  state.currentPayer = ids.includes(savedPayer) ? savedPayer : (ids[0] || 'p1');

  await reload();

  queue = createQueue({
    getApiKey: () => state.settings.apiKey,
    getSettings: () => state.settings,
    onUpdate: () => renderScan(),
    save: onRecognized,
  });

  applyTheme(currentTheme());
  wireTabs();
  wireScan();
  wireHome();
  wireSettings();
  render();
}

async function reload() {
  const lines = await db.allRecords();
  state.receipts = await db.allReceipts();
  state.drafts = state.receipts.filter((r) => r.status === db.RECEIPT_STATUS.draft);
  const draftIds = new Set(state.drafts.map((r) => r.id));

  // 草稿不進統計、不動錢包（2026-09-08 她的決定：數字永遠是她確認過的）。
  // 沒有 receiptId 的是 v1 舊資料，migration 會補上，這裡照樣放行。
  state.records = lines
    .filter((r) => !draftIds.has(r.receiptId))
    .map((r) => derive(r, state.settings));
  state.wallet = await db.all(db.STORES.wallet);
}

/** 這張收據底下、已經在記憶體裡的那幾筆品項。 */
const linesOf = (receiptId) => state.records.filter((r) => r.receiptId === receiptId);

/**
 * 首頁紅字。第三個參數給「點了會帶你去處理」的橫幅用——
 * 只說「有 1 筆待確認」卻不告訴人在哪，等於沒說（她 2026-09-08 找紅點找不到）。
 */
function banner(kind, text, onClick) {
  const b = el('div', { className: `banner ${kind}`, textContent: text });
  if (onClick) {
    b.style.cursor = 'pointer';
    b.setAttribute('role', 'button');
    b.setAttribute('tabindex', '0');
    b.append(el('span', { textContent: '　→ 點這裡處理', style: 'font-weight:700' }));
    b.onclick = onClick;
    b.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } };
  }
  $('banners').append(b);
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
  for (const name of ['home', 'records', 'scan', 'manual', 'stats', 'settings', 'confirm']) {
    $(`tab-${name}`).hidden = name !== state.tab;
  }
  renderHeader();
  clearBanners();
  renderWarnings();
  ({ home: renderHome, records: renderRecords, scan: renderScan,
     manual: renderManual, stats: renderStats, settings: renderSettings,
     confirm: renderConfirm }[state.tab])();
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

/**
 * 這趟用得到哪些匯率 → [[名稱, 有沒有填好], ...]
 *
 * 「用得到」的定義是**已經有那種付款方式的紀錄**，不是「理論上可能會用」。
 * 現金匯率永遠算用得到——現鈔一定會花到，而且 Suica／PayPay 儲值也是走它。
 */
function ratesNeeded() {
  const s = state.settings;
  const usedMethod = (m) => state.records.some((r) => r.paymentMethod === m);
  const out = [['現金匯率', s.cashRate > 0]];
  if (usedMethod('信用卡')) out.push(['刷卡匯率', s.cardRate > 0]);
  if (usedMethod('Wise') || state.wallet.some((w) => w.pot === 'wise' && (w.amount || 0) > 0)) {
    // Wise 匯率沒填會退回現金匯率，所以只有「現金匯率也沒填」才算真的缺
    out.push(['Wise 匯率', (s.wiseRate > 0) || (s.cashRate > 0)]);
  }
  return out;
}

/** 首頁紅字提醒（§17.4）。只講**現在就該處理**的，不要變成雜訊。 */
function renderWarnings() {
  const s = state.settings;
  if (!s.apiKey) banner('bad', '還沒填 API key，拍照無法辨識。去設定頁貼上。');
  // 只唸**用得到**的匯率。這趟不刷信用卡的人，不該被一條永遠消不掉的黃字追著跑。
  const missingRates = ratesNeeded().filter(([, ok]) => !ok).map(([label]) => label);
  if (missingRates.length) {
    banner('warn', `${missingRates.join('、')}還沒設，這幾種付款方式的本位幣金額會顯示「—」。`);
  }
  if (!s.tripStart || !s.tripEnd) banner('warn', '還沒設行程起訖日，Day N、每日曲線、行前判斷都不會動。');
  // 沒確認的收據**不算進任何數字**，所以這條要顯眼——忘了確認，首頁會少一截。
  if (state.drafts.length) {
    banner('warn', `有 ${state.drafts.length} 張收據還沒確認，先不計入統計與現金錢包。`,
      () => { state.tab = 'scan'; render(); });
  }
  const red = state.records.filter((r) => r.needsReview && !r.reviewed).length;
  if (red) {
    banner('info', `有 ${red} 筆辨識驗算對不上，需要你看一眼。`, () => {
      state.tab = 'records';
      state.filter = { ...state.filter, review: true };   // 直接篩出那幾筆，不用自己找紅點
      state.search = '';
      render();
    });
  }
}

// ---------------------------------------------------------------------------
// 首頁
// ---------------------------------------------------------------------------
function wireHome() {
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
        records: state.records, walletOps: state.wallet, settings: state.settings,
      });
      await db.put(db.STORES.wallet, op);
      await reload(); render();
      banner(op.delta === 0 ? 'info' : 'warn', `校正完成：${op.note}`);
    });

  $('btnWiseTopup').onclick = () => askAmount(
    '儲值 Wise', '這次換了多少日圓進 Wise？', async (amount) => {
      await db.put(db.STORES.wallet, {
        type: 'topup', pot: 'wise', payerId: state.currentPayer,
        amount, at: new Date().toISOString(),
      });
      await reload(); render();
    });
  $('btnWiseCorrect').onclick = () => askAmount(
    '校正 Wise', '打開 Wise App 看一下，日圓餘額現在是多少？', async (actual) => {
      const op = makeCorrection({
        payerId: state.currentPayer, pot: 'wise', actualBalance: actual,
        records: state.records, walletOps: state.wallet, settings: state.settings,
      });
      await db.put(db.STORES.wallet, op);
      await reload(); render();
      banner(op.delta === 0 ? 'info' : 'warn', `Wise 校正完成：${op.note}`);
    });
}

function renderHome() {
  const s = state.settings;
  // 兩位並排，各自的餘額直接寫在 chip 上——不用切換就看得到對方剩多少
  const tabs = $('payerTabs');
  tabs.textContent = '';
  tabs.hidden = !multiPayer();
  if (multiPayer()) {
    for (const [id, name] of payerOptions()) {
      const b = el('button', { className: 'chip' }, [
        el('i', { className: `pdot ${payerClass(id)}` }),
        document.createTextNode(`${name}　${local(cashBalance(id, state.records, state.wallet, s))}`),
      ]);
      b.setAttribute('aria-pressed', String(id === state.currentPayer));
      b.onclick = () => setPayer(id);
      tabs.append(b);
    }
  }

  const bal = cashBalance(state.currentPayer, state.records, state.wallet, s);
  $('cash').textContent = local(bal);

  // Wise：沒在用的人不要看到這一段（首頁越少東西越好）
  const wiseUsed = state.wallet.some((w) => w.pot === 'wise')
    || state.records.some((r) => r.paymentMethod === 'Wise');
  $('wiseRow').hidden = !wiseUsed;
  if (wiseUsed) {
    const wiseBal = potBalance(state.currentPayer, 'wise', state.records, state.wallet, s);
    $('wise').textContent = local(wiseBal);
    const rate = s.wiseRate || s.cashRate;
    $('wiseHint').textContent = rate
      ? `約 ${homeM(wiseBal / rate)}${s.wiseRate ? '' : '（用現金匯率估，Wise 匯率還沒填）'}`
      : '匯率還沒設';
  }

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

  // §9：**原幣大字、本位幣小字**。日圓才是現場花錢時腦子裡的單位，
  // 本位幣是回家算帳用的。首頁這兩塊原本反過來（2026-09-08 她對照參考 App 發現）。
  const cur = s.localCurrency;
  $('today').textContent = amt(todayTotalLocal(state.records, todayLocal(), cur), cur);
  $('total').textContent = amt(tripTotalLocal(state.records, cur), cur);
  const other = otherCurrencyTotal(state.records, cur);
  $('totalSub').textContent = `≈ ${homeM(tripTotal(state.records))}`
    + (other ? `（含其他幣別 ${homeM(other)}）` : '');

  // 旅程天數磚。行程外（還沒出發／已回國）不硬湊一個 Day N 出來。
  const dn = dayOfTrip(todayLocal(), s);
  const td = tripDays(s);
  $('dayN').textContent = dn ? `Day ${dn}` : '—';
  $('dayNSub').textContent = !td ? '行程日期還沒設'
    : dn ? `共 ${td} 天 · 還有 ${td - dn} 天`
    : '不在行程期間內';

  const bp = budgetProgress(state.records, s);
  if (!bp) {
    $('budgetPct').textContent = '未設預算';
    $('budgetBar').firstElementChild.style.width = '0';
    $('budgetHint').textContent = '';
  } else {
    $('budgetPct').textContent = `${(bp.percent * 100).toFixed(0)}%`;
    $('budgetBar').classList.toggle('over', bp.percent > 1);
    $('budgetBar').firstElementChild.style.width = `${Math.min(100, bp.percent * 100)}%`;
    // 磚寬只有半個螢幕，長句會擠掉。完整的 used/budget 在統計頁還看得到。
    $('budgetHint').textContent = `還剩 ${homeM(bp.budget - bp.used)}`;
  }

  const pre = preTripTotal(state.records);
  $('preTrip').textContent = pre ? `另有行前 ${homeM(pre)}` : '';

  const today = onTripSpending(state.records)
    .filter((r) => localDay(r.date) === todayLocal())
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));
  $('todayCount').textContent = `${today.length} 筆`;
  // ⚠️ 不可以把不同幣別的原幣金額加在一起（S$200 + ¥550 是沒有意義的數字）。
  //    要加總就加**換算後的本位幣**，那是唯一共通的單位。
  const todaySum = today.reduce((acc, r) => acc + (r.amountHome ?? 0), 0);
  $('todaySub').textContent = today.length ? `≈ ${homeM(todaySum)} · ${today.length} 筆` : '';
  fillList($('todayList'), today, '今天還沒有紀錄');
}

// ---------------------------------------------------------------------------
// 紀錄
// ---------------------------------------------------------------------------
/**
 * 一筆紀錄的那一行。左圓是類別圖示，中間店名＋標籤，右邊原幣大字／本位幣小字。
 * `showDate` 給不分組的地方用（今日花費已經在同一天，不用再印日期）。
 */
function recRow(r, showDate = false) {
  const [icon, cls] = catMeta(r.category);
  const meta = el('div', { className: 'meta' }, [
    el('span', { className: 'tag', textContent: r.isTopUp ? '儲值' : (r.category || '其他') }),
  ]);
  // 一列 = 一個品項時，主標印**品項名**，店名退到副標。
  // 不這樣做的話，按類別看那一頁會出現五次「松本清」，等於什麼都沒說。
  const asLine = !r.lineCount && r.name && r.name !== r.storeName;
  const dim = [
    showDate ? String(r.date || '').slice(5, 16).replace('T', ' ') : String(r.date || '').slice(11, 16),
    asLine ? r.storeName : null,
    r.paymentMethod,
    // 有第二位付款人時才印——一個人用的話這欄只是噪音
    multiPayer() ? payerName(r.payer) : null,
    r.storeName && r.city ? r.city : null,
  ].filter(Boolean).join(' · ');
  if (dim) meta.append(el('span', { className: 'dim', textContent: dim }));

  const title = el('div', { className: 't' });
  if (r.needsReview && !r.reviewed) title.append(el('span', { className: 'dot', style: 'margin-right:7px' }));
  title.append(document.createTextNode(
    asLine ? r.name : (r.storeName || r.storeNameLocal || '(未命名)')));

  const avatar = el('span', { className: 'av', textContent: icon, style: 'position:relative' });
  if (multiPayer()) {
    avatar.append(el('i', { className: `who ${payerClass(r.payer)}`, title: payerName(r.payer) }));
  }

  const row = el('div', { className: `rec ${cls}` }, [
    avatar,
    el('div', { className: 'mid2' }, [title, meta]),
    el('div', { className: 'amt' }, [
      el('div', { className: 'a num', textContent: amt(r.amount, r.currency) }),
      el('div', { className: 'b num', textContent:
        r.isTopUp ? '不計花費' : (r.amountHome == null ? '—' : homeM(r.amountHome)) }),
    ]),
  ]);
  if (r.lineCount > 1) {
    meta.append(el('span', { className: 'dim', textContent: `${r.lineCount} 項` }));
  }
  row.onclick = () => (r.receiptId ? openReceipt(r.receiptId) : openRecord(r));
  return row;
}

function fillList(ul, rows, emptyText, showDate = false, collapse = false) {
  ul.textContent = '';
  const list = collapse ? collapseByReceipt(rows) : rows;
  if (!list.length) { ul.append(el('li', { className: 'sub', style: 'padding:12px 0', textContent: emptyText })); return; }
  for (const r of list) ul.append(el('li', { style: 'list-style:none' }, [recRow(r, showDate)]));
}

/**
 * 同一張收據的品項收成一列。
 *
 * ⚠️ 只有**按日期**分組時才收——按類別分組時，同一張收據的品項可能落在不同組
 * （她把那包洋芋片改成餐飲），收成一列就會讓組的小計對不上組內幾列的和。
 * 這跟 2026-09-03 那個「拿含行前的數字排序、印不含行前的小計」是同一種錯。
 */
function collapseByReceipt(rows) {
  const out = [];
  const seen = new Map();
  for (const r of rows) {
    const k = r.receiptId || r.id;
    if (!seen.has(k)) {
      const rc = state.receipts.find((x) => x.id === k);
      const row = { ...r, id: k, lineCount: 1, amount: r.amount || 0, amountHome: r.amountHome ?? 0 };
      if (rc) { row.storeName = rc.storeName; row.storeNameLocal = rc.storeNameLocal; row.category = rc.category || r.category; }
      seen.set(k, row);
      out.push(row);
      continue;
    }
    const row = seen.get(k);
    row.lineCount += 1;
    row.amount += r.amount || 0;
    row.amountHome = (row.amountHome ?? 0) + (r.amountHome ?? 0);
  }
  return out;
}

/**
 * 分類 → 左圓的圖示與色票 class。
 * 參考截圖左圓是付款人頭像，**我們刻意放類別**（2026-09-03 決定不做頭像）：
 * 付款人在詳情與統計裡看得到，類別才是列表上一眼要分辨的東西。
 * 色票定義在 index.html 的 .c-food / .c-tran …，跟主色分開，換主色不影響辨識。
 */
const CAT_META = {
  餐飲: ['🍜', 'c-food'], 交通: ['🚇', 'c-tran'], 購物: ['🛍️', 'c-shop'],
  門票: ['🎫', 'c-tick'], 住宿: ['🏨', 'c-stay'], 藥品: ['💊', 'c-med'],
  其他: ['📦', 'c-etc'],
};
const catMeta = (c) => CAT_META[c] || CAT_META['其他'];

/**
 * 付款人下拉的選項。`p1` / `p2` 是**內部代號，不給人看**——
 * 存進紀錄的 payer 一定是 id，但選單上要印她在設定頁填的名字。
 * 回 [value, label] 兩欄；下面兩個 select 產生器都吃得到這個形狀。
 */
const payerOptions = () =>
  (state.settings.payers || []).filter((p) => p.name).map((p) => [p.id, p.name]);

/** 付款人的名字（`p1` 是內部代號，不給人看）。 */
const payerName = (id) =>
  (state.settings.payers || []).find((p) => p.id === id)?.name || id || '';

/** 付款人的色票 class（`p-1` / `p-2`）。順序照設定頁那兩格。 */
const payerClass = (id) => {
  const i = (state.settings.payers || []).findIndex((p) => p.id === id);
  return `p-${(i < 0 ? 0 : i) + 1}`;
};

/** 有沒有第二個人。只有一個人時，所有跟付款人有關的東西都不顯示。 */
const multiPayer = () => payerOptions().length > 1;

function setPayer(id) {
  state.currentPayer = id;
  try { localStorage.setItem('wayfare-payer', id); } catch { /* 私密視窗 */ }
  render();
}

const escape = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/**
 * 把紀錄切成一組一組。日期組印「日期 · Day N」與當組小計；類別組印類別與小計。
 * 小計只算現場花費（排除儲值與行前），跟首頁的累計用同一條規則，不然兩邊對不起來。
 */
function renderGroups(rows) {
  const box = $('recGroups');
  box.textContent = '';
  if (!rows.length) {
    box.append(el('div', { className: 'card', style: 'padding:16px' },
      [el('div', { className: 'sub', textContent: '還沒有紀錄' })]));
    return;
  }

  const byDate = state.recMode !== 'cat';
  const groups = new Map();
  for (const r of rows) {
    // 行前在兩種模式都自成一組。混進類別組的話，那組的小計（只算現場）
    // 就不等於組內幾列的和——拿一個數字排序、印另一個數字，看的人一定困惑。
    const k = r.isPreTrip ? '__pre'
      : byDate ? (localDay(r.date) || '未知日期')
      : (r.isTopUp ? '__topup' : (r.category || '其他'));
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }

  // 每組印什麼數字，就用那個數字排序。
  const shown = (k) => groups.get(k).reduce(
    (a, r) => a + ((k === '__pre' || isSpending(r)) ? (r.amountHome ?? 0) : 0), 0);
  const keys = [...groups.keys()];
  if (byDate) {
    keys.sort((a, b) => (a === '__pre' ? 1 : b === '__pre' ? -1 : b.localeCompare(a)));
  } else {
    keys.sort((a, b) => (a === '__pre' ? 1 : b === '__pre' ? -1
      : a === '__topup' ? 1 : b === '__topup' ? -1 : shown(b) - shown(a)));
  }

  for (const k of keys) {
    const list = groups.get(k);

    let label, right;
    if (k === '__pre') {
      label = '行前已付';
      right = homeM(shown(k));
    } else if (k === '__topup') {
      // 儲值組印 S$0.00 會讓人以為壞了。印原幣總額，並講清楚它為什麼不算花費。
      label = '儲值';
      right = `${local(list.reduce((a, r) => a + (r.amount || 0), 0))}　不計花費`;
    } else if (!byDate) {
      label = k;
      right = homeM(shown(k));
    } else {
      const d = dayOfTrip(k, state.settings);
      label = k.slice(5).replace('-', '/') + (d ? `　Day ${d}` : '');
      right = homeM(shown(k));
    }

    box.append(el('div', { className: 'dayhd' }, [
      el('span', { className: 'd', textContent: label }),
      el('span', { className: 's num', textContent: right }),
    ]));
    const ul = el('ul', { className: 'list' });
    // 按日期看：一列 = 一張收據。按類別看：一列 = 一個品項（不然改過類別的行會不見）
    fillList(ul, list, '', !byDate, byDate);
    box.append(el('div', { className: 'card', style: 'padding:4px 15px' }, [ul]));
  }
}

function renderRecords() {
  const chips = $('filters');
  chips.textContent = '';
  const add = (key, value, label) => {
    const b = el('button', { className: 'chip', textContent: label });
    b.setAttribute('aria-pressed', String(state.filter[key] === value));
    b.onclick = () => { state.filter[key] = state.filter[key] === value ? null : value; renderRecords(); };
    chips.append(b);
  };
  // 待確認擺第一個：那是唯一「需要動手」的篩選，其他都是看看而已
  const rv = el('button', { className: 'chip', textContent: '⚠ 待確認' });
  rv.setAttribute('aria-pressed', String(!!state.filter.review));
  rv.onclick = () => { state.filter.review = !state.filter.review; renderRecords(); };
  chips.append(rv);

  for (const c of CATEGORIES) add('category', c, c);
  for (const p of PAYMENT_METHODS) add('payment', p, p);
  for (const p of state.settings.payers || []) if (p.name) add('payer', p.id, p.name);

  $('search').oninput = (e) => { state.search = e.target.value.trim(); renderRecords(); };

  const q = state.search.toLowerCase();
  const rows = state.records
    .filter((r) => !state.filter.review || (r.needsReview && !r.reviewed))
    .filter((r) => !state.filter.category || r.category === state.filter.category)
    .filter((r) => !state.filter.payment || r.paymentMethod === state.filter.payment)
    .filter((r) => !state.filter.payer || r.payer === state.filter.payer)
    .filter((r) => !q || JSON.stringify([r.storeName, r.storeNameLocal, r.note, r.items]).toLowerCase().includes(q))
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));

  $('recCount').textContent = `全部紀錄（${rows.length}）`;
  $('recTotal').textContent = homeM(
    rows.filter((r) => isSpending(r) && !r.isPreTrip).reduce((a, r) => a + (r.amountHome ?? 0), 0));

  // 分段切換。狀態放 state.recMode，切換不重讀資料庫。
  for (const b of $('recMode').querySelectorAll('button')) {
    b.setAttribute('aria-pressed', String(state.recMode === b.dataset.mode));
    b.onclick = () => { state.recMode = b.dataset.mode; renderRecords(); };
  }
  renderGroups(rows);

  $('btnTrash').onclick = async () => {
    const rows2 = await db.recentlyDeleted();
    dialog('最近刪除', rows2.length
      ? el('ul', { className: 'list' }, rows2.map((r) => {
          const li = el('li', { className: 'item' }, [
            el('div', { textContent: `${r.storeName || '(未命名)'}　${amt(r.total ?? r.amount, r.currency)}` }),
            el('button', { className: 'btn', textContent: '復原', style: 'min-height:44px' }),
          ]);
          li.lastChild.onclick = async () => { await db.undeleteReceipt(r.id); await reload(); $('dlg').close(); render(); };
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
      for (const o of opts) {
        const [val, text] = Array.isArray(o) ? o : [o, o];
        input.append(el('option', { value: val, textContent: text, selected: r[key] === val }));
      }
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
  f('付款人', 'payer', 'text', payerOptions());
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
      await db.softDeleteReceipt(r.receiptId || r.id);
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
    capturedAt: localStamp(),          // 手機時區。AI 讀不到收據日期時會拿它當日期
  });
  renderScan();
}

/**
 * 佇列辨識完成 → **落地成一張「草稿收據」**（2026-09-08 起不再直接進帳）。
 *
 * 這裡刻意不算任何錢：拆帳與攤稅在 split.js（Node 測得到），
 * 這一支只負責把 AI 的回傳整理成收據欄位、寫進去、叫畫面重畫。
 */
async function onRecognized(item) {
  const d = item.data || {};
  const date = d.date
    ? `${d.date}T${d.time || '12:00'}`
    : item.capturedAt;

  const city = d.city
    || (item.coords ? null : cityFromSchedule(date, state.settings.schedule));

  // 收據上沒印日期時，用拍照時間頂上——但要**講出來頂了什麼**，
  // 只說「收據上未顯示日期」的話，她不知道現在填的是什麼、要不要動它。
  const dateNote = d.date ? null
    : `收據上沒有日期，已用拍照時間 ${String(date).slice(5, 16).replace('T', ' ')} 代替（不對就改上面的日期欄位）`;

  const receipt = {
    id: item.id,
    date,
    storeName: d.storeName, storeNameLocal: d.storeNameLocal,
    total: d.total,
    subtotal: d.subtotal,
    currency: state.settings.localCurrency,
    payer: state.currentPayer,
    paymentMethod: d.paymentMethod,
    category: d.category,
    city,
    citySource: d.city ? 'gps' : (city ? 'schedule' : null),
    coords: item.coords,
    isTopUp: !!d.isTopUp,
    taxType: d.taxType, taxDetail: d.taxDetail, taxTotal: d.taxTotal,
    taxRefundPending: d.taxRefundPending,
    refundStatus: d.taxRefundPending > 0 ? 'pending' : 'none',
    discounts: d.discounts,
    // 只有價格折扣要攤到品項上；點數折抵不改變合計（japan.js 的區分）
    priceDiscount: priceDiscountTotal(d.discounts),
    cashPaid: d.cashPaid, cashReceived: d.cashReceived, change: d.change,
    items: d.items,
    entryMode: 'scan',
    // 程式端驗算優先於 AI 自評（§7.5：不看 AI 的 checks，自己重算）
    needsReview: (item.issues?.length || 0) > 0 || d.needsReview === true || !!dateNote,
    reviewReason: [dateNote, item.issues?.join('；') || d.reviewReason].filter(Boolean).join('；') || null,
    issues: item.issues,
    model: item.model, escalated: item.escalated,
    status: db.RECEIPT_STATUS.draft,
    recognizedAt: new Date().toISOString(),
  };

  const built = buildLines(receipt);
  receipt.split = built.split;
  receipt.splitReason = built.reason;

  await db.saveReceipt(receipt, toRecords(receipt, built.lines));
  await reload();
  if (state.tab !== 'confirm') render();
}

function renderScan() {
  renderDrafts();

  // 拍照與快速記帳都會算在這個人頭上，所以放在拍照按鈕旁邊看得到
  $('scanPayerBox').hidden = !multiPayer();
  if (multiPayer()) {
    const box = $('scanPayer');
    box.textContent = '';
    for (const [id, name] of payerOptions()) {
      const b = el('button', { className: 'chip' }, [
        el('i', { className: `pdot ${payerClass(id)}` }),
        document.createTextNode(name),
      ]);
      b.setAttribute('aria-pressed', String(id === state.currentPayer));
      b.onclick = () => setPayer(id);
      box.append(b);
    }
  }
  const q = queue?.summary() || { total: 0, items: [], completed: 0 };
  // 辨識完的會自己離開佇列，所以這裡只講「還在跑的」，外加一個累計數字
  const bits = [];
  if (q.pending) bits.push(`${q.pending} 排隊`);
  if (q.running) bits.push(`${q.running} 辨識中`);
  if (q.failed) bits.push(`${q.failed} 失敗`);
  if (q.completed) bits.push(`已完成 ${q.completed} 張`);
  $('qStat').textContent = bits.length ? bits.join('　') : '閒置';
  $('btnRetryAll').hidden = !q.failed;

  const ul = $('qList');
  ul.textContent = '';
  if (!q.items.length) {
    ul.append(el('li', { className: 'sub', textContent:
      q.completed ? '都辨識完了，去上面「待確認」確認內容' : '沒有排隊中的照片' }));
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
      // 兩個模型都試過還是不行的那種（模糊、拍歪），總得有辦法請它走
      const d = el('button', { className: 'btn danger', textContent: '刪掉', style: 'min-height:44px' });
      d.onclick = (ev) => {
        ev.stopPropagation();
        if (confirm('刪掉這張沒辨識出來的照片？照片本身還留著，可以去手動輸入自己補。')) queue.remove(it.id);
      };
      li.append(b, d);
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
  // 付款方式。**記住上次選的**——坐公車連記三筆不用每次重選，
  // 這樣還是「兩下完成」，不會把三秒記帳變成五秒。
  const pays = $('quickPay');
  pays.textContent = '';
  for (const m of QUICK_METHODS) {
    const b = el('button', { className: 'chip', textContent: m });
    b.setAttribute('aria-pressed', String(m === quickMethod()));
    b.onclick = () => {
      try { localStorage.setItem('wayfare-quick-pay', m); } catch { /* 私密視窗 */ }
      renderScan();
    };
    pays.append(b);
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

/**
 * 待確認的收據。放在掃描頁最上面，因為那是她拍完之後會待著的那一頁。
 * 一張一列，點進去就是確認頁。
 */
function renderDrafts() {
  const box = $('draftCard');
  box.textContent = '';
  if (!state.drafts.length) return;

  const card = el('div', { className: 'card' });
  card.append(el('div', { className: 'row' }, [
    el('strong', { textContent: `待確認 ${state.drafts.length} 張` }),
    el('span', { className: 'sub', textContent: '確認前不計入統計' }),
  ]));
  const ul = el('ul', { className: 'list' });
  for (const rc of [...state.drafts].sort((a, b) => String(b.date).localeCompare(String(a.date)))) {
    const li = el('li', { className: 'item' }, [
      el('div', {}, [
        el('div', { textContent: rc.storeName || rc.storeNameLocal || '(未命名)' }),
        el('div', { className: 'sub', textContent:
          `${String(rc.date || '').slice(5, 16).replace('T', ' ')}　${amt(rc.total, rc.currency)}` +
          (rc.needsReview ? '　⚠ 驗算對不上' : '') }),
      ]),
      el('button', { className: 'btn', textContent: '確認', style: 'min-height:44px' }),
    ]);
    li.lastChild.onclick = () => openReceipt(rc.id, 'scan');
    ul.append(li);
  }
  card.append(ul);
  box.append(card);
}

/**
 * 快速記帳的付款方式選項。
 *
 * 刻意不放信用卡：快速記帳是給「沒收據的小額」用的（販賣機、置物櫃、公車、賽錢），
 * 那些場合不會刷卡。放太多選項反而拖慢。
 */
const QUICK_METHODS = ['現金', 'Suica', 'PayPay', 'Wise'];

function quickMethod() {
  try {
    const m = localStorage.getItem('wayfare-quick-pay');
    return QUICK_METHODS.includes(m) ? m : '現金';
  } catch { return '現金'; }
}

/** 三秒快速記帳（§9）：金額 + 類別 + 付款方式，兩下完成。沒有照片，不套 needsReview。 */
async function quickSave() {
  const amount = Number($('quickCustom').value);
  if (!amount) { banner('warn', '先填金額'); return; }
  const cat = [...$('quickCats').children].find((c) => c.getAttribute('aria-pressed') === 'true')?.textContent || '其他';
  const now = new Date();
  // 手打的也是一張收據（只有一行）。全系統只有一種形狀，統計與匯出才不用分兩套。
  const receipt = {
    id: crypto.randomUUID(),
    date: localStamp(now),
    storeName: cat,
    total: amount,
    currency: state.settings.localCurrency,
    category: cat,
    paymentMethod: quickMethod(),
    payer: state.currentPayer,
    city: cityFromSchedule(localStamp(now), state.settings.schedule),
    citySource: 'schedule',
    entryMode: 'quick',
    needsReview: false,
    status: db.RECEIPT_STATUS.confirmed,   // 自己打的不用再確認一次
  };
  await db.saveReceipt(receipt, toRecords(receipt, buildLines(receipt).lines));
  $('quickCustom').value = '';
  await reload();
  banner('info', `已記一筆 ${local(amount)}（${cat} · ${quickMethod()}）`);
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
    ['payer', '付款人', 'select', payerOptions()],
    ['city', '城市', 'text'],
    ['note', '備註', 'text'],
  ];
  for (const [key, label, type, opts] of fields) {
    const wrap = el('div', { className: 'field' }, [el('label', { textContent: label })]);
    let input;
    if (type === 'select') {
      input = el('select');
      for (const o of opts) {
        const [val, text] = Array.isArray(o) ? o : [o, o];
        input.append(el('option', { value: val, textContent: text }));
      }
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
  // 幣別 + 現金 這個組合最容易被誤會，直接寫在表單下面（§11 錢包只裝當地幣）
  box.append(el('div', { className: 'sub', style: 'margin-top:-8px', textContent:
    `用${state.settings.homeCurrency}現金付的（例如在新加坡買的機票）不會扣${state.settings.localCurrency}現金錢包——` +
    '錢包裝的是當地現金。' }));

  $('btnManualSave').onclick = async () => {
    const rec = { id: crypto.randomUUID(), entryMode: 'manual', needsReview: false };
    for (const input of box.querySelectorAll('[data-key]')) {
      rec[input.dataset.key] = input.type === 'number' ? Number(input.value) : input.value;
    }
    if (!rec.amount) { banner('warn', '金額沒填'); return; }
    if (!rec.date) rec.date = localStamp();
    const receipt = { ...rec, total: rec.amount, status: db.RECEIPT_STATUS.confirmed };
    await db.saveReceipt(receipt, toRecords(receipt, buildLines(receipt).lines));
    await reload();
    for (const input of box.querySelectorAll('[data-key]')) {
      if (input.type !== 'select-one') input.value = '';
    }
    // ⚠️ 幣別**一定要歸位**。她記完一筆 SGD 的機票，下一筆 Donki 就沿用了 SGD，
    // 變成 S$1,000（2026-09-08）。其他選單沿用沒關係，幣別不行——差 125 倍。
    const curSel = box.querySelector('[data-key="currency"]');
    if (curSel) curSel.value = state.settings.localCurrency;

    banner('info', `已儲存 ${rec.storeName || ''} ${amt(rec.amount, rec.currency)}`);
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

/** 分類色票，跟 index.html 的 .c-* 同一組值。甜甜圈要真的顏色不能吃 CSS 變數。 */
const CAT_COLOR = {
  餐飲: '#C97F5E', 交通: '#6F93B5', 購物: '#B98098', 門票: '#9887BC',
  住宿: '#6FA394', 藥品: '#C08181', 其他: '#8C95A3',
};
const PAY_COLOR = ['#6F93B5', '#5B8464', '#C97F5E', '#B98098', '#9887BC', '#8C95A3'];

/**
 * 甜甜圈。純 SVG，不載任何函式庫（§4：離線也要能看）。
 * 顏色給不到就退回一組固定序列，不會變成看不見的黑圈。
 */
function donut(rows, colorOf, fmt = homeM) {
  if (!rows.length) return el('div', { className: 'sub', textContent: '還沒有資料' });
  const total = rows.reduce((a, r) => a + Math.abs(r.value), 0);
  if (!total) return el('div', { className: 'sub', textContent: '還沒有資料' });

  const R = 46, C = 2 * Math.PI * R;
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('width', '104'); svg.setAttribute('height', '104');
  svg.setAttribute('viewBox', '0 0 118 118');
  const ring = (stroke, dash, offset) => {
    const c = document.createElementNS(ns, 'circle');
    c.setAttribute('cx', '59'); c.setAttribute('cy', '59'); c.setAttribute('r', String(R));
    c.setAttribute('fill', 'none'); c.setAttribute('stroke', stroke); c.setAttribute('stroke-width', '15');
    if (dash) { c.setAttribute('stroke-dasharray', dash); c.setAttribute('stroke-dashoffset', String(offset)); }
    c.setAttribute('transform', 'rotate(-90 59 59)');
    return c;
  };
  svg.append(ring('var(--sunk)'));

  const legend = el('div', { className: 'lg' });
  let off = 0;
  rows.forEach((r, i) => {
    const pct = Math.abs(r.value) / total;
    const len = C * pct;
    const color = colorOf(r.key, i);
    // 段與段之間留 2.5 的縫，才看得出是幾段；最後一段不留，免得繞回起點缺一角
    const gap = rows.length > 1 ? 2.5 : 0;
    svg.append(ring(color, `${Math.max(0, len - gap)} ${C - len + gap}`, -off));
    off += len;
    legend.append(el('div', { className: 'lgr' }, [
      el('i', { className: 'k', style: `background:${color}` }),
      el('span', { className: 'n', textContent: r.key || '未分類' }),
      el('span', { className: 'p num', textContent: `${(pct * 100).toFixed(1)}%` }),
      el('span', { className: 'v num', textContent: fmt(r.value) }),
    ]));
  });
  return el('div', { className: 'donut' }, [svg, legend]);
}

function renderStats() {
  const R = state.records;
  const cur = state.settings.localCurrency;
  const f = (v) => amt(v, cur);          // §9：統計頁的數字也是原幣（日圓）

  const daily = dailySeries(R, state.settings, { currency: cur })
    .map((d) => ({ key: `Day ${d.day ?? '-'}　${String(d.date).slice(5)}`, value: d.value }));
  $('chartDaily').replaceChildren(bars(daily, f));

  // 非當地幣的現場花費不進這些圖（幣別不同不能相加），但一定要講出來，
  // 不然她會納悶「為什麼統計加起來跟首頁差一截」。
  const other = otherCurrencyTotal(R, cur);
  const note = () => (other
    ? el('div', { className: 'sub', style: 'margin-bottom:8px', textContent:
        `另有非${cur}的現場花費 ${homeM(other)} 未列入下面各圖` })
    : el('span'));

  $('chartCat').replaceChildren(note(),
    donut(byCategoryLocal(R, cur), (k) => CAT_COLOR[k] || CAT_COLOR['其他'], f));
  $('chartPay').replaceChildren(
    donut(byPaymentLocal(R, cur), (k, i) => PAY_COLOR[i % PAY_COLOR.length], f));
  $('chartCity').replaceChildren(bars(byCityLocal(R, cur), f));

  const names = new Map((state.settings.payers || []).map((p) => [p.id, p.name || p.id]));
  $('chartPayer').replaceChildren(
    bars(byPayerLocal(R, cur).map((x) => ({ ...x, key: names.get(x.key) || x.key })), f));

  $('refundTotal').textContent = local(pendingRefund(R));

  // 排行。topSpends 只回摘要，類別／支付方式回原始紀錄撈（不改 stats.js 的介面）
  const byId = new Map(R.map((r) => [r.id, r]));
  const top = topSpends(R);
  const box = el('div');
  top.forEach((t, i) => {
    const full = byId.get(t.id) || {};
    const [icon, cls] = catMeta(full.category);
    box.append(el('div', { className: `rank ${cls}` }, [
      el('span', { className: 'rk', textContent: String(i + 1) }),
      el('span', { className: 'av', style: 'width:32px;height:32px;font-size:14px', textContent: icon }),
      el('div', { className: 'mid2' }, [
        // 拆多筆之後這裡是**品項**排行，主標印品項名，店名進副標
        el('div', { className: 't', textContent:
          (t.name && t.name !== t.storeName ? t.name : (t.storeName || '(未命名)')) }),
        el('div', { className: 'dim', textContent:
          [t.name && t.name !== t.storeName ? t.storeName : null,
           full.category, full.paymentMethod, String(t.date).slice(5, 10)].filter(Boolean).join(' · ') }),
      ]),
      el('div', { className: 'amt' }, [
        el('div', { className: 'a num', textContent: amt(t.amount, full.currency) }),
        el('div', { className: 'b num', textContent: homeM(t.amountHome) }),
      ]),
    ]));
  });
  $('topList').replaceChildren(top.length ? box : el('div', { className: 'sub', textContent: '還沒有資料' }));
}

// ---------------------------------------------------------------------------
// 外觀（深淺色）
//
// 存在 localStorage **不是** settings —— settings 會進備份檔，
// 主題是「這台手機這個人」的偏好，不該跟著備份跑到別人的手機上。
// ---------------------------------------------------------------------------
const THEME_MODES = [['auto', '跟隨系統'], ['light', '淺色'], ['dark', '深色']];
const THEME_BAR = { light: '#F6F4F1', dark: '#131519' };   // 狀態列顏色，跟 --bg 一樣

function currentTheme() {
  try {
    const m = localStorage.getItem('wayfare-theme');
    return THEME_MODES.some(([v]) => v === m) ? m : 'auto';
  } catch { return 'auto'; }
}

function applyTheme(mode) {
  const root = document.documentElement;
  if (mode === 'auto') { root.removeAttribute('data-theme'); root.style.colorScheme = ''; }
  else { root.setAttribute('data-theme', mode); root.style.colorScheme = mode; }

  // 手機狀態列 / 網址列的底色。不換的話全螢幕模式下會出現一條顏色不對的邊。
  for (const m of document.querySelectorAll('meta[name="theme-color"]')) m.remove();
  if (mode === 'auto') {
    document.head.append(el('meta', { name: 'theme-color', content: THEME_BAR.light, media: '(prefers-color-scheme: light)' }));
    document.head.append(el('meta', { name: 'theme-color', content: THEME_BAR.dark, media: '(prefers-color-scheme: dark)' }));
  } else {
    document.head.append(el('meta', { name: 'theme-color', content: THEME_BAR[mode] }));
  }
}

function renderThemeChips() {
  const box = $('themeChips');
  box.textContent = '';
  const now = currentTheme();
  for (const [value, label] of THEME_MODES) {
    const b = el('button', { className: 'chip', textContent: label });
    b.setAttribute('aria-pressed', String(value === now));
    b.onclick = () => {
      try { localStorage.setItem('wayfare-theme', value); } catch { /* 存不到就這次有效 */ }
      applyTheme(value);
      renderThemeChips();
    };
    box.append(b);
  }
}

// ---------------------------------------------------------------------------
// 設定
// ---------------------------------------------------------------------------
/**
 * 設定頁的一個欄位。
 *
 * ⚠️ 2026-09-08 修：原本只在 `change`（離開欄位）時存，而且存完**只重畫標題列**。
 * 結果是貼上 API key 之後，紅字「還沒填 API key」跟出發前檢查清單都沒動——
 * 東西明明存進去了，畫面卻說沒有。她第一次真機實測就卡在這裡。
 *
 * 現在：邊打邊存（防抖），存完把**紅字橫條與檢查清單一起重畫**，並顯示「已儲存」。
 * 重畫刻意不用 render()——那會把整張設定表重建，游標會被踢出正在打字的欄位。
 */
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

  const hint = el('div', { className: 'sub', style: 'min-height:18px' });
  let timer = null;

  const save = async () => {
    state.settings[key] = type === 'number' ? Number(input.value) : input.value;
    await db.saveSettings(state.settings);
    hint.textContent = '已儲存';
    setTimeout(() => { hint.textContent = ''; }, 2000);
    renderHeader();
    clearBanners();
    renderWarnings();
    renderPreflight();
  };

  input.oninput = () => { clearTimeout(timer); timer = setTimeout(save, 600); };
  input.onchange = () => { clearTimeout(timer); save(); };     // 收鍵盤 / 選單改完立刻存

  wrap.append(input, hint);
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

  $('btnHealth').onclick = async () => {
    // 照片存在另一個 store，健檢要自己去撈——不撈的話每一筆掃描都會被誣賴成沒照片
    const photoReceiptIds = new Set(
      (await db.all(db.STORES.photos)).map((p) => p.receiptId || p.recordId));
    const missing = ratesNeeded().filter(([, ok]) => !ok).map(([label]) => label);

    const h = healthCheck(state.records, state.settings, {
      photoReceiptIds,
      missingRates: missing.length > 0,
    });

    const rows = [
      ['待確認（紅點）', h.needsReview, '確認過就會消失'],
      ['城市是用行程推的（可能歸錯）', h.cityFromSchedule, 'GPS 沒抓到時的備援'],
      ['掃描但沒照片', h.noPhoto, '照片是回來報帳的憑據'],
      ['算不出本位幣金額', h.noHomeAmount, '多半是匯率還沒設'],
    ];

    const box = el('div');
    for (const [label, ids, why] of rows) {
      const n = ids.length;
      const head = el('div', { className: 'row', style: n ? 'cursor:pointer' : '' }, [
        el('span', { textContent: n ? `${label} ▾` : label }),
        el('strong', { className: n ? 'warn' : 'good', textContent: String(n) }),
      ]);
      box.append(head);
      if (!n) continue;

      // ⚠️ 只給數字等於沒說（她 2026-09-08：「沒告訴我是什麼」）。
      //    列出是哪幾張，而且點得進去改。
      const list = el('div', { style: 'margin:2px 0 10px 2px' });
      list.append(el('div', { className: 'sub', textContent: why }));
      for (const id of ids) {
        const rc = state.receipts.find((x) => x.id === id);
        const line = el('div', { className: 'sub', style: 'padding:6px 0;cursor:pointer;color:var(--accent)' });
        line.textContent = rc
          ? `${String(rc.date || '').slice(5, 16).replace('T', ' ')}　${rc.storeName || '(未命名)'}　${amt(rc.total, rc.currency)}`
          : id;
        line.onclick = () => { $('dlg')?.close?.(); openReceipt(id, 'settings'); };
        list.append(line);
      }
      box.append(list);
    }

    if (h.duplicates.length) {
      box.append(el('div', { className: 'row' }, [
        el('span', { textContent: '疑似重複（同金額、時間很近）' }),
        el('strong', { className: 'warn', textContent: String(h.duplicates.length) }),
      ]));
    }

    if (missing.length) {
      box.append(el('div', { className: 'banner warn', textContent:
        `${missing.join('、')}還沒設 —— 這趟用得到的匯率才會列在這裡` }));
    }
    if (!rows.some(([, ids]) => ids.length) && !h.duplicates.length && !missing.length) {
      box.append(el('div', { className: 'banner info', textContent: '都沒問題 ✓' }));
    }
    $('healthOut').replaceChildren(box);
  };

  $('btnXlsx').onclick = exportExcel;
  $('btnBackup').onclick = exportBackup;
  $('btnRestore').onclick = () => $('restoreFile').click();
  $('restoreFile').onchange = importBackup;
}

function renderSettings() {
  renderThemeChips();
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
  settingField(fx, 'wiseRate', 'Wise 匯率（換進 Wise 時拿到的）', 'number');
  fx.append(el('div', { className: 'sub', textContent:
    'Wise 匯率沒填就套現金匯率——兩者都是「先換好的錢」，比刷卡匯率接近。' }));

  const payers = $('settingsPayers'); payers.textContent = '';
  (state.settings.payers || []).forEach((p, i) => {
    const nameW = el('div', { className: 'field' }, [el('label', { textContent: `付款人 ${i + 1}` })]);
    const name = el('input', { value: p.name || '', placeholder: i ? '（沒有第二人就留白）' : '' });
    name.onchange = async () => {
      state.settings.payers[i].name = name.value;
      await db.saveSettings(state.settings);
      // 手動輸入那張表只建一次（dataset.built），不清掉的話改完名字還印舊的
      delete $('manualForm').dataset.built;
      $('manualForm').textContent = '';
      render();
    };
    nameW.append(name);

    const cashW = el('div', { className: 'field' }, [el('label', { textContent: '初始現金' })]);
    const cash = el('input', { type: 'number', inputMode: 'numeric', value: p.initialCash || 0 });
    cash.onchange = async () => {
      const amount = Number(cash.value);
      state.settings.payers[i].initialCash = amount;
      await db.saveSettings(state.settings);
      // 初始現金是一筆錢包操作，不是純設定——否則餘額算不出來
      const existing = state.wallet.find(
        (w) => w.type === 'init' && w.payerId === p.id && (w.pot || 'cash') === 'cash');
      await db.put(db.STORES.wallet, existing
        ? { ...existing, amount }
        : { type: 'init', pot: 'cash', payerId: p.id, amount, at: new Date().toISOString() });
      await reload(); render();
    };
    cashW.append(cash);

    const wiseW = el('div', { className: 'field' }, [el('label', { textContent: 'Wise 初始日圓（沒用留 0）' })]);
    const wise = el('input', { type: 'number', inputMode: 'numeric', value: p.initialWise || 0 });
    wise.onchange = async () => {
      const amount = Number(wise.value);
      state.settings.payers[i].initialWise = amount;
      await db.saveSettings(state.settings);
      const existing = state.wallet.find(
        (w) => w.type === 'init' && w.payerId === p.id && (w.pot || 'cash') === 'wise');
      await db.put(db.STORES.wallet, existing
        ? { ...existing, amount }
        : { type: 'init', pot: 'wise', payerId: p.id, amount, at: new Date().toISOString() });
      await reload(); render();
    };
    wiseW.append(wise);

    payers.append(nameW, cashW, wiseW);
  });

  const sch = $('settingsSchedule'); sch.textContent = '';
  sch.append(el('div', { className: 'sub', style: 'margin-bottom:8px', textContent:
    'GPS 失效時的備援。一行一個：城市 起日 迄日。日期可以寫 2026-11-29 或 11/29。' }));

  const ta = el('textarea', { value: (state.settings.schedule || [])
    .map((r) => (r.from === r.to ? `${r.city} ${r.from}` : `${r.city} ${r.from} ${r.to}`)).join('\n') });
  const schOut = el('div', { style: 'margin-top:8px' });

  /**
   * 邊打邊存邊驗。
   *
   * ⚠️ 2026-09-08 修：原本只在離開輸入框時存，錯誤訊息也只說「這幾行看不懂」。
   * 她把 2026-09-11 打成 2026-0911，整行被丟掉、清單那格一直沒打勾，
   * 而她根本沒看到那句黃字。現在：即時驗、講清楚第幾行錯在哪、成功也說一聲。
   */
  const applySchedule = async (persist = true) => {
    const { rows, bad } = parseSchedule(ta.value, { tripStart: state.settings.tripStart });
    // ⚠️ 開場那一次**只畫不存**。存的話等於「一打開設定頁就把記憶體狀態寫回 DB」，
    //    剛還原完備份、記憶體還是舊的，一重畫就把還原的設定蓋掉了（2026-09-08 實測撞到）。
    if (persist) {
      state.settings.schedule = rows;
      await db.saveSettings(state.settings);
    }
    renderPreflight();

    schOut.textContent = '';
    if (bad.length) {
      schOut.append(el('div', { className: 'banner warn' }, [
        el('div', { textContent: `這 ${bad.length} 行沒有存進去：` }),
        ...bad.map((b) => el('div', { style: 'margin-top:4px',
          textContent: `第 ${b.no} 行「${b.line}」—— ${b.why}` })),
      ]));
    }
    if (rows.length) {
      schOut.append(el('div', { className: 'sub', textContent:
        `已存 ${rows.length} 段：` + rows.map((r) =>
          `${r.city} ${r.from.slice(5)}${r.from === r.to ? '' : `–${r.to.slice(5)}`}`).join('、') }));
    } else if (!bad.length) {
      schOut.append(el('div', { className: 'sub', textContent: '還沒填。GPS 抓得到城市時不填也能用。' }));
    }
  };

  let schTimer = null;
  ta.oninput = () => { clearTimeout(schTimer); schTimer = setTimeout(applySchedule, 500); };
  ta.onchange = () => { clearTimeout(schTimer); applySchedule(); };

  sch.append(el('div', { className: 'field' }, [ta]), schOut);
  applySchedule(false);      // 只是把現況畫出來，不要寫回資料庫

  const api = $('settingsApi'); api.textContent = '';
  settingField(api, 'apiKey', 'Gemini API key', 'password');
  settingField(api, 'rpm', '發送速率（每分鐘幾張）', 'number');
  api.append(el('div', { className: 'sub', textContent:
    '⚠️ 每個人要用自己的 key。共用一把會互相吃掉額度，用量也會混在一起。' }));

  renderPreflight();
}

/**
 * 出發前檢查清單（§17）。抽成獨立一支，設定改完可以單獨重畫。
 *
 * ⚠️ 2026-09-08：改成**只檢查這趟用得到的**。她這趟只用現鈔 / Wise / Suica，
 * 原本那條「刷卡匯率 未完成」會永遠綠不了，逼人去填一個不會用到的數字——
 * 一張永遠不會全綠的清單，看久了就整張都不看了。
 */
function renderPreflight() {
  const pf = $('preflight'); pf.textContent = '';
  const s = state.settings;
  const usedMethod = (m) => state.records.some((r) => r.paymentMethod === m);
  const wiseUsed = usedMethod('Wise')
    || state.wallet.some((w) => w.pot === 'wise' && (w.amount || 0) > 0);

  // [標籤, 好了沒, 這趟用不用得到]
  const checks = [
    ['行程起訖日', !!(s.tripStart && s.tripEnd), true],
    ['總預算', s.totalBudget > 0, true],
    ['現金匯率', s.cashRate > 0, true],
    ['刷卡匯率', s.cardRate > 0, usedMethod('信用卡')],
    ['Wise 匯率', s.wiseRate > 0, wiseUsed],
    ['初始現金', (s.payers || []).some((p) => p.initialCash > 0), true],
    ['行程表（GPS 備援）', (s.schedule || []).length > 0, true],
    ['API key', !!s.apiKey, true],
    ['備份試過一次', !!s.lastBackupAt, true],
    ['拿真收據試拍過', state.records.some((r) => r.entryMode === 'scan'), true],
  ];

  // 註：Wise 匯率沒填時金額仍算得出來（退回現金匯率），所以**首頁不會跳黃字**；
  //     但那是估的，出發前該把真的數字填進去 —— 清單這裡照樣要求。
  for (const [label, done, needed] of checks) {
    // 用不到又沒填 → 「用不到」（灰的，不算未完成）。填了就照樣打勾，不要把她填的東西講成廢的。
    const state3 = done ? 'done' : (needed ? 'todo' : 'skip');
    const look = {
      done: ['good', '✓'],
      todo: ['warn', '未完成'],
      skip: ['muted', '用不到'],
    }[state3];
    pf.append(el('li', { className: 'item' }, [
      el('span', { textContent: label }),
      el('strong', { className: look[0], textContent: look[1] }),
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

function stamp() { return localToday(); }

function exportExcel() {
  try {
    const wb = buildWorkbook(state.records, state.settings, state.receipts);
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
  // 照片綁的是收據不是品項（2026-09-08），所以這裡跑的是 receipts 不是 records
  const photosByRecord = new Map();
  for (const rc of state.receipts) {
    const ps = await db.photosOf(rc.id);
    if (ps.length) photosByRecord.set(rc.id, await Promise.all(ps.map((p) => toBase64(p.blob))));
  }
  const backup = buildBackup({
    records: state.records, receipts: state.receipts,
    walletOps: state.wallet, settings: state.settings, photosByRecord,
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
  const photoTotal = Object.values(b.photos || {}).reduce((n, a) => n + (a?.length || 0), 0);
  if (!confirm(`要匯入 ${b.records.length} 筆紀錄`
    + `${photoTotal ? `、${photoTotal} 張照片` : '（這份備份沒有照片）'}嗎？`
    + '現有資料會被合併（同 id 覆蓋），設定會被備份檔裡的取代。')) return;

  // v1 備份沒有 receipts（那時候一筆就是一張收據）→ 現場補出來，不要讓它變孤兒
  const receipts = b.receipts?.length ? b.receipts : receiptsFromLegacyRecords(b.records);
  for (const rc of receipts) await db.put(db.STORES.receipts, rc);
  for (const r of b.records) {
    await db.put(db.STORES.records, r.receiptId ? r : { ...r, receiptId: r.id, seq: 1, status: 'confirmed' });
  }
  for (const w of b.walletOps) await db.put(db.STORES.wallet, w);

  // 照片。**這段 2026-09-08 之前是漏的**——備份鈕寫著「含照片」，
  // 匯出時照片確實有進去，還原卻整批不見，而且靜靜地不報錯。
  // 換手機／從 Safari 搬到主畫面 App 的人會以為照片沒了。
  let photoCount = 0;
  for (const [receiptId, list] of Object.entries(b.photos || {})) {
    for (const [i, b64] of (list || []).entries()) {
      try {
        await db.put(db.STORES.photos, {
          id: `${receiptId}:restored:${i}`,
          receiptId,
          recordId: receiptId,          // v1 的索引還在用這個欄位
          blob: fromBase64(b64),
          at: b.exportedAt || new Date().toISOString(),
        });
        photoCount += 1;
      } catch (err) {
        // 一張壞掉不該讓整份匯入失敗，但一定要講出來
        banner('warn', `有一張照片還原失敗（${receiptId}）：${err.message}`);
      }
    }
  }

  // 設定也要跟著搬（匯率、行程、付款人、Wise 初始…）。
  // ⚠️ **API key 不在備份檔裡**（刻意的，key 不進備份），所以保留這台自己的，
  //    不要用備份裡的 undefined 把它蓋掉——那會讓辨識突然停擺。
  if (b.settings) {
    const here = await db.get(db.STORES.settings, 'main');
    await db.saveSettings({ ...b.settings, apiKey: here?.apiKey || '' });
    // 記憶體也要跟上，否則接下來任何一次「存設定」都會拿舊的蓋掉剛還原的
    state.settings = await db.loadSettings(defaultSettings());
    configureRateLimit({ rpm: state.settings.rpm ?? 15 });
  }

  await reload(); render();
  banner('info',
    `已匯入 ${receipts.length} 張收據、${b.records.length} 筆明細、${photoCount} 張照片`
    + (b.settings ? '，設定也一起還原了（API key 保留這台原本的）' : ''));
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

// ---------------------------------------------------------------------------
// 確認收據內容（§9 新頁，2026-09-08）
//
// 動線：拍 → 辨識完**先落地成 draft**（不進統計、不動錢包）→ 她在這頁確認 → confirmed。
//
// 為什麼草稿要寫進 IndexedDB 而不是留在記憶體裡：
// queue.js 的佇列是一個 Map，關掉 App 就沒了。辨識完的東西只放在那裡，
// 等於「拍完不馬上確認就會掉」——而她的用法就是白天拍、晚上回旅館一次確認。
//
// ⛔ 這頁唯一不准妥協的：**Σ 品項 === 合計**才給存。
//    對不上時不自己湊，而是把兩個數字攤開來讓她決定要改哪一個。
// ---------------------------------------------------------------------------

async function openReceipt(receiptId, returnTab) {
  const rc = state.receipts.find((r) => r.id === receiptId)
    || await db.get(db.STORES.receipts, receiptId);
  if (!rc) { banner('bad', '找不到這張收據'); return; }
  const lines = await db.recordsOf(receiptId, true);
  state.confirmDraft = {
    receipt: { ...rc },
    lines: lines.map((l) => ({
      seq: l.seq, name: l.name, nameLocal: l.nameLocal, qty: l.qty,
      unitPrice: l.unitPrice, taxRate: l.taxRate, amount: l.amount,
      category: l.category, adjusted: l.adjusted, note: l.note,
    })),
  };
  state.returnTab = returnTab || state.tab;
  state.tab = 'confirm';
  render();
}

function closeConfirm() {
  state.confirmDraft = null;
  state.tab = state.returnTab || 'records';
  render();
}

const lineSum = (lines) => lines.reduce((s, l) => s + (Number(l.amount) || 0), 0);

function renderConfirm() {
  const box = $('confirmBody');
  box.textContent = '';
  const d = state.confirmDraft;
  if (!d) { closeConfirm(); return; }
  const rc = d.receipt;
  const isDraft = rc.status === db.RECEIPT_STATUS.draft;
  const cur = rc.currency || state.settings.localCurrency;

  const redraw = () => renderConfirm();

  // ── 收據本身 ──────────────────────────────────────────────
  const head = el('div', { className: 'card' });
  const field = (label, value, type, onInput, opts) => {
    const wrap = el('div', { className: 'field' }, [el('label', { textContent: label })]);
    let input;
    if (opts) {
      input = el('select');
      for (const o of opts) {
        const [val, text] = Array.isArray(o) ? o : [o, o];
        input.append(el('option', { value: val, textContent: text, selected: value === val }));
      }
      input.onchange = () => onInput(input.value);
    } else {
      input = el('input', { type, value: value ?? '' });
      if (type === 'number') input.inputMode = 'numeric';
      input.onchange = () => onInput(type === 'number' ? Number(input.value) : input.value);
    }
    wrap.append(input);
    head.append(wrap);
    return input;
  };

  field('店名', rc.storeName, 'text', (v) => { rc.storeName = v; });
  if (rc.storeNameLocal) {
    head.append(el('div', { className: 'sub', style: 'margin:-8px 0 12px', textContent: rc.storeNameLocal }));
  }
  field('日期時間', String(rc.date || '').slice(0, 16), 'datetime-local', (v) => { rc.date = v; });
  field('合計（收據上印的那個數字）', rc.total, 'number', (v) => { rc.total = v; redraw(); });
  field('類別', rc.category, 'text', (v) => {
    // 整張改類別時，沒有被個別改過的那幾行跟著走（2026-09-08 她的決定）
    const before = rc.category;
    for (const l of d.lines) if (!l.category || l.category === before) l.category = v;
    rc.category = v; redraw();
  }, CATEGORIES);
  field('支付方式', rc.paymentMethod, 'text', (v) => { rc.paymentMethod = v; }, PAYMENT_METHODS);
  field('付款人', rc.payer, 'text', (v) => { rc.payer = v; }, payerOptions());
  field('城市', rc.city, 'text', (v) => { rc.city = v; rc.citySource = 'manual'; });
  box.append(head);

  // ── 辨識時就已經知道的問題 ───────────────────────────────
  if (rc.needsReview && rc.reviewReason) {
    box.append(el('div', { className: 'banner warn', textContent: `要看一下：${rc.reviewReason}` }));
  }
  if (rc.split === false && rc.splitReason) {
    box.append(el('div', { className: 'banner info', textContent:
      `這張沒有拆開，整張算一筆 —— ${rc.splitReason}。要拆的話在下面自己加行。` }));
  }

  // ── 品項 ────────────────────────────────────────────────
  const items = el('div', { className: 'card' });
  const hd = el('div', { style: 'display:flex;justify-content:space-between;align-items:center;margin-bottom:6px' }, [
    el('strong', { textContent: '購買明細' }),
  ]);
  const addBtn = el('button', { className: 'btn', textContent: '＋ 新增', style: 'padding:0 14px' });
  addBtn.onclick = () => {
    d.lines.push({
      seq: (d.lines.at(-1)?.seq || 0) + 1, name: '', nameLocal: '', qty: 1,
      unitPrice: 0, taxRate: null, amount: 0, category: rc.category,
    });
    redraw();
  };
  hd.append(addBtn);
  items.append(hd);

  for (const l of d.lines) {
    const row = el('div', { className: 'ln' });
    row.append(el('span', { className: 'no', textContent: String(l.seq) }));

    const nm = el('div', { className: 'nm' });
    const nameIn = el('input', { value: l.name || '', placeholder: '品項名稱' });
    nameIn.onchange = () => { l.name = nameIn.value; };
    nm.append(nameIn);

    const sub = el('div', { className: 'lsub' });
    const bits = [
      l.nameLocal || null,
      l.qty > 1 ? `${l.qty} × ${symbolOf(cur)}${nf(l.unitPrice)}` : null,
      l.taxRate ? `${Math.round(l.taxRate * 100)}%` : null,
      l.adjusted ? '含湊整差' : null,
    ].filter(Boolean);
    sub.append(document.createTextNode(bits.join(' · ')));
    nm.append(sub);

    const catSel = el('select');   // 樣式在 index.html 的 .ln .nm select
    for (const c of CATEGORIES) {
      catSel.append(el('option', { value: c, textContent: c, selected: (l.category || rc.category) === c }));
    }
    catSel.onchange = () => { l.category = catSel.value; };
    nm.append(catSel);
    row.append(nm);

    const pr = el('div', { className: 'pr' });
    const amtIn = el('input', { type: 'number', inputMode: 'numeric', value: l.amount ?? 0 });
    amtIn.onchange = () => { l.amount = Number(amtIn.value); l.adjusted = false; redraw(); };
    pr.append(amtIn);
    row.append(pr);

    const rm = el('button', { className: 'rm', textContent: '✕', title: '刪掉這一行' });
    rm.onclick = () => {
      d.lines = d.lines.filter((x) => x !== l);
      d.lines.forEach((x, i) => { x.seq = i + 1; });
      redraw();
    };
    row.append(rm);
    items.append(row);
  }

  // ── 加總對不對 ───────────────────────────────────────────
  const sum = lineSum(d.lines);
  const balanced = isBalanced(d.lines, rc.total, cur);
  const totals = el('div', { style: 'margin-top:12px' });
  if (rc.subtotal != null) {
    totals.append(el('div', { className: 'sumline' }, [
      el('span', { textContent: '小計' }), el('span', { className: 'num', textContent: amt(rc.subtotal, cur) })]));
  }
  const taxSum = (rc.taxDetail?.tax8 || 0) + (rc.taxDetail?.tax10 || 0);
  const taxTotal = rc.taxTotal ?? (taxSum || null);
  if (taxTotal) {
    totals.append(el('div', { className: 'sumline' }, [
      el('span', { textContent: '消費稅' }), el('span', { className: 'num', textContent: amt(taxTotal, cur) })]));
  }
  totals.append(el('div', { className: 'sumline' }, [
    el('span', { textContent: `品項加總（${d.lines.length} 筆）` }),
    el('span', { className: 'num', textContent: amt(sum, cur) })]));
  totals.append(el('div', { className: 'sumline tot' }, [
    el('span', { textContent: '合計' }), el('span', { className: 'num', textContent: amt(rc.total, cur) })]));
  const home = rc.total == null ? null : toHomeAmount(rc);
  if (home != null) {
    totals.append(el('div', { className: 'sumline', style: 'justify-content:flex-end' }, [
      el('span', { className: 'num', textContent: `≈ ${homeM(home)}` })]));
  }
  items.append(totals);
  box.append(items);

  if (balanced) {
    box.append(el('div', { className: 'banner info', textContent: '✓ 品項加總 = 合計，可以存了。' }));
  } else {
    // 「差 ¥-880」很難讀，直接講多還是少
    const diff = sum - (Number(rc.total) || 0);
    const b = el('div', { className: 'banner bad' }, [
      el('div', { textContent:
        `品項加總 ${amt(sum, cur)} 比合計 ${amt(rc.total, cur)} ${diff > 0 ? '多' : '少'} ` +
        `${amt(Math.abs(diff), cur)} —— 兩個要一樣才能存。` }),
    ]);
    const useSum = el('button', { className: 'btn', style: 'margin-top:9px',
      textContent: `把合計改成 ${amt(sum, cur)}` });
    useSum.onclick = () => { rc.total = sum; redraw(); };
    b.append(useSum);
    box.append(b);
  }

  // ── 照片 ────────────────────────────────────────────────
  const shots = el('div');
  box.append(shots);
  db.photosOf(rc.id).then((photos) => {
    for (const p of photos) shots.append(el('img', { className: 'shot', src: URL.createObjectURL(p.blob) }));
  }).catch(() => {});

  // ── 按鈕 ────────────────────────────────────────────────
  const cta = el('div', { style: 'margin-top:14px;display:flex;flex-direction:column;gap:10px' });
  const save = el('button', { className: 'btn primary wide',
    textContent: isDraft
      ? `確認儲存（${d.lines.length} 筆明細 · ${amt(rc.total, cur)}）`
      : `儲存變更（${d.lines.length} 筆明細）` });
  save.disabled = !balanced;
  if (!balanced) save.style.opacity = '.5';
  save.onclick = () => saveConfirm();
  cta.append(save);

  const back = el('button', { className: 'btn wide', textContent: isDraft ? '稍後再確認' : '返回' });
  back.onclick = closeConfirm;
  cta.append(back);

  const del = el('button', { className: 'btn wide danger', textContent: '刪除這張收據' });
  del.onclick = async () => {
    if (!confirm(`刪除「${rc.storeName || '這張'}」？連同 ${d.lines.length} 筆明細一起，可以到「最近刪除」復原。`)) return;
    await db.softDeleteReceipt(rc.id);
    await reload();
    closeConfirm();
  };
  cta.append(del);
  box.append(cta);
}

/** 存回去。走 db.saveReceipt（一個 transaction），不會留半套資料。 */
async function saveConfirm() {
  const d = state.confirmDraft;
  if (!d) return;
  const rc = d.receipt;
  if (!isBalanced(d.lines, rc.total, rc.currency || state.settings.localCurrency)) {
    banner('bad', '品項加總跟合計對不上，先處理那個再存。');
    return;
  }
  const receipt = {
    ...rc,
    status: db.RECEIPT_STATUS.confirmed,
    confirmedAt: new Date().toISOString(),
    reviewed: true,
  };
  await db.saveReceipt(receipt, toRecords(receipt, d.lines));
  await reload();
  closeConfirm();
  banner('info', `已存 ${receipt.storeName || '這張收據'}　${amt(receipt.total, receipt.currency)}（${d.lines.length} 筆明細）`);
}

/** 確認頁右下角那個「≈ S$xx」。算式在 model.js，這裡只是借過來用。 */
function toHomeAmount(rc) {
  const s = state.settings;
  if ((rc.currency || s.localCurrency) === s.homeCurrency) return rc.total;
  const rate = rc.paymentMethod === '信用卡' ? s.cardRate : s.cashRate;
  return rate ? rc.total / rate : null;
}
