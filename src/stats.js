/**
 * 統計 —— 規格 §9 的「統計」Tab 與首頁數字。
 *
 * 兩條貫穿全檔的規則，錯了整個統計就沒意義：
 *   1. **儲值不計花費**（§7.6）。Suica 儲值 + 用 Suica 買東西 = 同一筆錢算兩次。
 *   2. **行前不進每日曲線**（§9）。機票住宿的大額會把「今日支出」灌爆。
 */

import { isSpending, localDay, tripDays } from './model.js';
import { toMyShare } from './settle.js';

/** 現場花費（排除儲值、排除行前）。首頁與每日曲線都用這個。 */
export function onTripSpending(records) {
  return records.filter((r) => isSpending(r) && !r.isPreTrip);
}

/** 行前已付（§9 首頁另列一個總數）。 */
export function preTripTotal(records) {
  return records
    .filter((r) => isSpending(r) && r.isPreTrip)
    .reduce((s, r) => s + (r.amountHome ?? 0), 0);
}

function sumBy(records, keyFn, valueFn) {
  const out = new Map();
  for (const r of records) {
    // ⚠️ 用 || 不是 ??：城市有可能是**空字串**（手動輸入沒填），
    //    用 ?? 的話 '' 跟 null 會變成兩個不同的組，畫面上出現兩行「未分類」。
    const k = keyFn(r) || '未分類';
    out.set(k, (out.get(k) || 0) + (valueFn(r) || 0));
  }
  return [...out.entries()]
    .map(([key, value]) => ({ key, value }))
    .sort((a, b) => b.value - a.value);
}

const home = (r) => r.amountHome ?? 0;
const local = (r) => r.amount ?? 0;

/**
 * 只留當地幣的現場花費。
 *
 * 統計頁的金額改成日圓之後（§9 原幣大字），**不可以把 S$30 加進 ¥ 的總和**。
 * 非當地幣的部分用 otherCurrencyTotal() 另外講一句，不要混進圖表。
 */
function localOnly(records, localCurrency) {
  return onTripSpending(records).filter((r) => (r.currency || localCurrency) === localCurrency);
}

export function byCategoryLocal(records, cur) { return sumBy(localOnly(records, cur), (r) => r.category, local); }
export function byPaymentLocal(records, cur) { return sumBy(localOnly(records, cur), (r) => r.paymentMethod, local); }
export function byPayerLocal(records, cur) { return sumBy(localOnly(records, cur), (r) => r.payer, local); }
export function byCityLocal(records, cur) { return sumBy(localOnly(records, cur), (r) => r.city, local); }

export function byCategory(records) { return sumBy(onTripSpending(records), (r) => r.category, home); }
export function byPayment(records) { return sumBy(onTripSpending(records), (r) => r.paymentMethod, home); }
export function byPayer(records) { return sumBy(onTripSpending(records), (r) => r.payer, home); }
export function byCity(records) { return sumBy(onTripSpending(records), (r) => r.city, home); }

/**
 * 每日趨勢。**行程裡沒花錢的那天要出現一個 0**，不能整天消失——
 * 曲線缺一天會讓人以為那天沒記到帳。
 */
export function dailySeries(records, settings, opts = {}) {
  const total = tripDays(settings);
  const start = localDay(settings.tripStart);
  // opts.currency 有給 → 出**當地幣**（只算那個幣別的筆數）；沒給 → 維持本位幣
  const cur = opts.currency;
  const value = cur ? local : home;
  const rows = cur ? localOnly(records, cur) : onTripSpending(records);
  const sums = new Map();
  for (const r of rows) {
    const d = localDay(r.date);
    if (d) sums.set(d, (sums.get(d) || 0) + value(r));
  }
  if (!total || !start) {
    return [...sums.entries()].sort().map(([date, value]) => ({ date, value }));
  }
  const out = [];
  for (let i = 0; i < total; i++) {
    const date = new Date(Date.parse(start) + i * 86400000).toISOString().slice(0, 10);
    out.push({ date, day: i + 1, value: sums.get(date) || 0 });
  }
  return out;
}

export function todayTotal(records, today) {
  const d = localDay(today);
  return onTripSpending(records)
    .filter((r) => localDay(r.date) === d)
    .reduce((s, r) => s + home(r), 0);
}

export function tripTotal(records) {
  return onTripSpending(records).reduce((s, r) => s + home(r), 0);
}

/**
 * 當地幣的總額（§9：原幣大字、本位幣小字）。
 *
 * ⚠️ **只加當地幣的那幾筆**。不同幣別的原幣金額不可以相加——
 * S$200 + ¥550 是一個沒有意義的數字。其他幣別的部分請用本位幣那條線去看。
 */
export function tripTotalLocal(records, localCurrency) {
  return onTripSpending(records)
    .filter((r) => (r.currency || localCurrency) === localCurrency)
    .reduce((s, r) => s + local(r), 0);
}

export function todayTotalLocal(records, today, localCurrency) {
  const d = localDay(today);
  return onTripSpending(records)
    .filter((r) => localDay(r.date) === d)
    .filter((r) => (r.currency || localCurrency) === localCurrency)
    .reduce((s, r) => s + local(r), 0);
}

/** 這批裡有沒有「不是當地幣」的花費（有的話畫面要講一聲，不然大小字對不起來）。 */
export function otherCurrencyTotal(records, localCurrency) {
  return onTripSpending(records)
    .filter((r) => (r.currency || localCurrency) !== localCurrency)
    .reduce((s, r) => s + home(r), 0);
}

/** TOP 10 花費（原幣大字、本位幣小字，所以兩個都留）。 */
export function topSpends(records, n = 10) {
  return onTripSpending(records)
    .slice()
    .sort((a, b) => home(b) - home(a))
    .slice(0, n)
    .map((r) => ({ id: r.id, storeName: r.storeName, name: r.name, date: r.date, amount: local(r), amountHome: home(r) }));
}

/**
 * 預算進度。
 * 預算是**現場花費**的預算——行前的機票住宿不該吃掉當地的每日額度。
 *
 * ⚠️ 2026-09-09 改成用「**她的份**」（toMyShare），不是掏出去的錢。她 15:38 拍板。
 * 為什麼：預算問的是「我這趟花多少」。九人晚餐 ¥45,000 記在她名下但只有 ¥5,000
 * 是她的，那 ¥40,000 會收回來。算進預算的話她第三天就見底然後開始不敢花錢。
 *
 * 改之前首頁會出現兩個不一樣的「剩餘」（這張磚 155%、今天還能花那張 S$2,882），
 * 因為 dailyAllowance 已經是用她的份算的。兩張現在同一個基準。
 *
 * ⚠️ 沒有 shares 的紀錄照樣全額算，所以**還沒用分帳之前，數字跟以前完全一樣**。
 *
 * `paidOut` 另外給掏出去的錢——現金錢包、匯出報表要對帳時看的是那個。
 */
export function budgetProgress(records, settings, opts = {}) {
  const budget = settings.totalBudget || 0;
  if (budget <= 0) return null;
  const mine = toMyShare(records, { meId: opts.meId || 'p1', validIds: opts.validIds || null });
  const used = tripTotal(mine);
  const paidOut = tripTotal(records);
  const days = tripDays(settings);
  return {
    budget,
    used,
    paidOut,
    advanced: paidOut - used,      // 代墊出去、之後會收回來的
    left: budget - used,
    percent: used / budget,
    perDay: days ? budget / days : null,
  };
}

/**
 * 把同一張收據的品項先收成一筆。
 *
 * ⚠️ 拆多筆之後**一定要先收**再比重複（2026-09-08）：
 * 一張超市收據裡兩瓶 ¥198 的茶，時間金額都一樣，逐筆比會判成「重複」——
 * 那不是拍兩次，那是真的買了兩瓶。要抓的是「同一張拍了兩次」。
 */
function collapseReceipts(records) {
  const out = new Map();
  for (const r of records) {
    const k = r.receiptId || r.id;
    const cur = out.get(k);
    if (!cur) { out.set(k, { ...r, id: k }); continue; }
    cur.amount = (cur.amount || 0) + (r.amount || 0);
  }
  return [...out.values()];
}

/**
 * 疑似重複（§16 第 11 條、§17.2）：金額相同且時間很近。
 * 連拍時同一張拍兩次很常見，尤其戴手套。
 */
export function findDuplicates(records, withinMinutes = 10) {
  const dups = [];
  const sorted = collapseReceipts(records)
    .filter((r) => r.amount && Number.isFinite(Date.parse(r.date)))
    .sort((a, b) => Date.parse(a.date) - Date.parse(b.date));

  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const a = sorted[i], b = sorted[j];
      const gap = Date.parse(b.date) - Date.parse(a.date);
      // 已排序，超出時間窗就不用再往後看了
      if (gap > withinMinutes * 60000) break;
      if (a.amount === b.amount) dups.push([a.id, b.id]);
    }
  }
  return dups;
}

/**
 * 一鍵健檢（§17.3）：一頁列出所有可疑的。**回收據 id**，畫面才點得進去。
 *
 * 2026-09-08 修好三個假警報：
 *   · 「待確認」沒看 `reviewed` —— 確認過了還一直算進去
 *   · 「掃描但沒照片」看的是 `r.photos`，**紀錄上根本沒有這個欄位**
 *     （照片存在另一個 store），等於每一筆掃描都被誣賴成沒照片
 *   · 「匯率沒設完」硬要刷卡匯率 —— 這趟不刷信用卡的人永遠消不掉
 *
 * @param opts.photoReceiptIds Set<收據id>；**沒給就不檢查照片**（不知道就別亂報）
 * @param opts.missingRates    由呼叫端算好「用得到的匯率有沒有缺」
 */
export function healthCheck(records, settings, opts = {}) {
  const rid = (r) => r.receiptId || r.id;
  const byReceipt = (rows) => [...new Set(rows.map(rid))];
  const photoIds = opts.photoReceiptIds || null;

  return {
    needsReview: byReceipt(records.filter((r) => r.needsReview && !r.reviewed)),
    cityFromSchedule: byReceipt(records.filter((r) => r.citySource === 'schedule')),
    noPhoto: photoIds
      ? byReceipt(records.filter((r) => r.entryMode === 'scan' && !photoIds.has(rid(r))))
      : [],
    noHomeAmount: byReceipt(records.filter((r) => r.amountHome == null)),
    duplicates: findDuplicates(records),
    missingRates: opts.missingRates ?? !(settings.cashRate > 0),
  };
}

/**
 * 今天還能花多少（2026-09-09，她挑的 P1 之一）。
 *
 * 為什麼要有：首頁本來只有一條「用了 62%」的總進度。
 * 站在藥妝店裡看到那個數字，還是不知道今天這件外套能不能買。
 * 旅行中真正會一直看的是**今天的額度**。
 *
 * 算法刻意選了「**剩餘預算 ÷ 剩餘天數**」而不是「總預算 ÷ 總天數」：
 * 前三天省下來的錢，第四天就可以花；前三天超支，後面每天自動收緊。
 * 固定額度那種算法，超支一次之後整趟都在跟一個永遠追不上的數字賭氣。
 *
 * ⚠️ 用的是「**我的份**」不是掏出去的錢（toMyShare）。
 *    九人晚餐 ¥45,000 記在她名下但只有 ¥5,000 是她的，
 *    直接拿掏出去的錢扣預算，第三天就見底然後她開始不敢花錢。
 *
 * @returns null 表示不該顯示（沒設預算或沒設行程）
 */
export function dailyAllowance(records, settings, opts = {}) {
  const budget = settings.totalBudget || 0;
  const total = tripDays(settings);
  if (budget <= 0 || !total) return null;

  const today = localDay(opts.today) || localDay(new Date().toISOString());
  const start = localDay(settings.tripStart);
  const end = localDay(settings.tripEnd);
  if (!today || !start || !end) return null;

  const mine = toMyShare(records, { meId: opts.meId || 'p1', validIds: opts.validIds || null });
  const used = tripTotal(mine);
  const left = budget - used;

  const DAY = 86400000;
  let phase = 'during';
  if (Date.parse(today) < Date.parse(start)) phase = 'before';
  else if (Date.parse(today) > Date.parse(end)) phase = 'after';

  // 剩餘天數**含今天**。不含的話最後一天會變成「÷ 0」或「今天不能花」。
  const daysLeft = phase === 'before' ? total
    : phase === 'after' ? 0
    : Math.round((Date.parse(end) - Date.parse(today)) / DAY) + 1;

  // 已經超支就沒有「每天還能花」可言，給 0 而不是負數——
  // 負的每日額度沒有任何操作意義，只會讓人看不懂。
  const perDay = daysLeft > 0 ? Math.max(0, left / daysLeft) : null;
  const spentToday = phase === 'during' ? todayTotal(mine, today) : 0;
  const leftToday = perDay == null ? null : perDay - spentToday;

  // 換成當地幣。她人在日本，看日圓才有用。
  // 現金匯率優先（多數當地消費是現金 / Suica），沒設才退回刷卡匯率。
  const rate = settings.cashRate > 0 ? settings.cashRate
             : settings.cardRate > 0 ? settings.cardRate : null;
  const toLocal = (v) => (rate == null || v == null ? null : v * rate);

  return {
    phase,
    budget, used, left,
    daysTotal: total, daysLeft,
    perDay, spentToday, leftToday,
    perDayLocal: toLocal(perDay),
    spentTodayLocal: toLocal(spentToday),
    leftTodayLocal: toLocal(leftToday),
    over: leftToday != null && leftToday < 0,
    overBudget: left < 0,
    rate,
  };
}
