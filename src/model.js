/**
 * 資料模型與衍生欄位 —— 規格 §6。
 *
 * 這一支**不碰 IndexedDB、不碰 DOM**，純函式。
 * 目的是讓「錢有沒有算錯」這件事可以在 Node 裡測到，不用開瀏覽器。
 */

// ---------------------------------------------------------------------------
// 匯率的方向（很容易搞反，所以寫死在這裡）
//
// rate = **1 本位幣可以換到多少當地幣**，例如 SGD→JPY 是 125.75。
// 這個方向是刻意選的，因為：
//   · open.er-api.com 以本位幣為 base 回傳的就是這個數字（§10 已驗證）
//   · 她換錢時腦子裡想的也是「1 塊換到 125 円」
// 所以：本位幣金額 = 當地金額 ÷ rate
// ---------------------------------------------------------------------------

export const CATEGORIES = ['餐飲', '交通', '購物', '門票', '住宿', '藥品', '其他'];
export const PAYMENT_METHODS = ['現金', 'Wise', '信用卡', 'Suica', 'PayPay', '其他'];
export const ENTRY_MODES = ['scan', 'quick', 'manual'];

export const CURRENCY_SYMBOLS = {
  SGD: 'S$', MYR: 'RM', TWD: 'NT$', JPY: '¥', USD: 'US$', EUR: '€', KRW: '₩', THB: '฿',
};

export function symbolOf(code) {
  return CURRENCY_SYMBOLS[code] || `${code} `;
}

export function defaultSettings() {
  return {
    homeCurrency: 'SGD',
    localCurrency: 'JPY',
    tripStart: null,
    tripEnd: null,
    totalBudget: 0,             // 本位幣
    budgetSourceNote: '',
    cashRate: null,             // 1 本位幣 = ? 當地幣（換現金時實際拿到的）
    cardRate: null,             // 1 本位幣 = ? 當地幣（銀行約略）
    wiseRate: null,             // 1 本位幣 = ? 當地幣（換進 Wise 時拿到的）。沒填就套現金匯率
    referenceRate: null,        // 按「更新參考匯率」抓到的市場價，僅供參考
    referenceRateAt: null,
    payers: [
      { id: 'p1', name: '我', initialCash: 0, initialWise: 0 },
      { id: 'p2', name: '', initialCash: 0, initialWise: 0 },
    ],
    schedule: [],               // [{ city, from, to }]
    quickAmounts: [100, 150, 500],
    apiKey: '',
    rpm: 15,
  };
}

/**
 * 現在幾點幾分，**用手機自己的時區**，格式 `YYYY-MM-DDTHH:MM`。
 *
 * ⛔ 不可以用 `new Date().toISOString()` —— 那是 UTC。
 * 2026-09-08 她在新加坡 15:58 記一筆，列表印成 07:58（差 8 小時）。
 * 在日本更糟：JST 是 UTC+9，**早上 00:00–09:00 記的帳會被算成前一天**，
 * 每日曲線、今日支出、Day N 全部歪掉（正是 §16 第 10 條要防的那件事）。
 *
 * 為什麼用手機時區而不是設定裡的當地時區：人在日本時手機本來就是日本時間，
 * 兩者相同；而「現在幾點」跟手機螢幕上的鐘不一致才是最讓人困惑的。
 */
export function localStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
    + `T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 今天（手機時區）。 */
export function localToday(d = new Date()) {
  return localStamp(d).slice(0, 10);
}

/** 只取日期部分，避免時區把「今天」推掉一天（§16 第 10 條）。 */
export function localDay(dateish) {
  if (!dateish) return null;
  const s = String(dateish);
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

/** 行程總天數（含頭尾）。沒設行程回 null，不要假裝知道。 */
export function tripDays(settings) {
  const a = localDay(settings.tripStart);
  const b = localDay(settings.tripEnd);
  if (!a || !b) return null;
  const days = Math.round((Date.parse(b) - Date.parse(a)) / 86400000) + 1;
  return days > 0 ? days : null;
}

/** 這筆是第幾天。行程外回 null。 */
export function dayOfTrip(dateish, settings) {
  const d = localDay(dateish);
  const a = localDay(settings.tripStart);
  const total = tripDays(settings);
  if (!d || !a || !total) return null;
  const n = Math.round((Date.parse(d) - Date.parse(a)) / 86400000) + 1;
  return n >= 1 && n <= total ? n : null;
}

/**
 * 換算本位幣。依支付方式套現金／刷卡匯率（§10：兩種匯率不一樣，
 * 因為換現金的成本和刷卡的成本本來就是兩回事）。
 *
 * 匯率沒設 → 回 null，**不要拿市場價頂替**。UI 顯示「—」比顯示一個假數字好。
 */
export function toHome(amountLocal, paymentMethod, settings) {
  if (amountLocal == null) return null;
  // Wise 裡是**出發前就換好的日圓**，成本是換匯當下那個匯率，不是刷卡當下的銀行匯率。
  // 沒填 Wise 匯率就退回現金匯率——那也比刷卡匯率接近（都是「先換好的錢」）。
  const rate = paymentMethod === '信用卡' ? settings.cardRate
    : paymentMethod === 'Wise' ? (settings.wiseRate || settings.cashRate)
    : settings.cashRate;
  if (!rate || rate <= 0) return null;
  return amountLocal / rate;
}

/**
 * 補齊一筆紀錄的衍生欄位。原始欄位一律不動——
 * 改了就會蓋掉辨識結果，之後查不出來是 AI 讀的還是我們算的。
 */
export function derive(record, settings) {
  const r = { ...record };
  r.currency = r.currency || settings.localCurrency;
  r.paymentMethod = PAYMENT_METHODS.includes(r.paymentMethod) ? r.paymentMethod : '其他';
  r.category = CATEGORIES.includes(r.category) ? r.category : '其他';
  r.entryMode = ENTRY_MODES.includes(r.entryMode) ? r.entryMode : 'manual';
  r.isTopUp = !!r.isTopUp;

  // 行前：日期早於行程首日。機票住宿的大額不能灌進「今日支出」（§9）
  const d = localDay(r.date);
  const start = localDay(settings.tripStart);
  r.isPreTrip = !!(d && start && Date.parse(d) < Date.parse(start));

  r.day = dayOfTrip(r.date, settings);

  // 本位幣的那一筆，換算就是自己
  r.amountHome = r.currency === settings.homeCurrency
    ? r.amount
    : toHome(r.amount, r.paymentMethod, settings);

  return r;
}

/**
 * 這筆算不算「花費」。
 *
 * ⚠️ 儲值不是花費（§7.6）——Suica 儲 ¥5,000 之後再用它買東西，
 * 兩邊都計就重複算了一次。儲值是**錢從口袋換到卡裡**，不是花掉。
 * 但它**確實會扣現金錢包**（見 wallet.js），兩件事不要混。
 */
export function isSpending(r) {
  return !r.isTopUp;
}
