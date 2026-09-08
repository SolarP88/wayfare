/**
 * 統計 —— 規格 §9 的「統計」Tab 與首頁數字。
 *
 * 兩條貫穿全檔的規則，錯了整個統計就沒意義：
 *   1. **儲值不計花費**（§7.6）。Suica 儲值 + 用 Suica 買東西 = 同一筆錢算兩次。
 *   2. **行前不進每日曲線**（§9）。機票住宿的大額會把「今日支出」灌爆。
 */

import { isSpending, localDay, tripDays } from './model.js';

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
    const k = keyFn(r) ?? '未分類';
    out.set(k, (out.get(k) || 0) + (valueFn(r) || 0));
  }
  return [...out.entries()]
    .map(([key, value]) => ({ key, value }))
    .sort((a, b) => b.value - a.value);
}

const home = (r) => r.amountHome ?? 0;
const local = (r) => r.amount ?? 0;

export function byCategory(records) { return sumBy(onTripSpending(records), (r) => r.category, home); }
export function byPayment(records) { return sumBy(onTripSpending(records), (r) => r.paymentMethod, home); }
export function byPayer(records) { return sumBy(onTripSpending(records), (r) => r.payer, home); }
export function byCity(records) { return sumBy(onTripSpending(records), (r) => r.city, home); }

/**
 * 每日趨勢。**行程裡沒花錢的那天要出現一個 0**，不能整天消失——
 * 曲線缺一天會讓人以為那天沒記到帳。
 */
export function dailySeries(records, settings) {
  const total = tripDays(settings);
  const start = localDay(settings.tripStart);
  const sums = new Map();
  for (const r of onTripSpending(records)) {
    const d = localDay(r.date);
    if (d) sums.set(d, (sums.get(d) || 0) + home(r));
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
 */
export function budgetProgress(records, settings) {
  const budget = settings.totalBudget || 0;
  if (budget <= 0) return null;
  const used = tripTotal(records);
  const days = tripDays(settings);
  return {
    budget,
    used,
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

/** 一鍵健檢（§17.3）：一頁列出所有可疑的。 */
export function healthCheck(records, settings) {
  return {
    needsReview: records.filter((r) => r.needsReview).map((r) => r.id),
    cityFromSchedule: records.filter((r) => r.citySource === 'schedule').map((r) => r.id),
    noPhoto: records.filter((r) => r.entryMode === 'scan' && !(r.photos || []).length).map((r) => r.id),
    noHomeAmount: records.filter((r) => r.amountHome == null).map((r) => r.id),
    duplicates: findDuplicates(records),
    missingRates: !settings.cashRate || !settings.cardRate,
  };
}
