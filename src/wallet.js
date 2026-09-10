/**
 * 現金錢包 —— 規格 §11。
 *
 * 為什麼這支要獨立且測到死：預算是「該不該花」，現金餘額是「**還付不付得出來**」。
 * 算錯的後果是人在旭川郊區發現錢不夠又找不到收外國卡的 ATM。
 *
 * **每位付款人各一個錢包**——別人用自己的現金付，不可以扣到你的餘額。
 */

import { localDay, localToday } from './model.js';

/** 錢包操作的種類。消費不在這裡，消費是從 records 推的。 */
export const WALLET_OPS = {
  init: '設定初始現金',
  topup: '補充現金',        // ATM 領錢、再換錢
  correct: '校正餘額',      // 實際數過錢包，直接設成真實數字
  refund: '收到退税',       // 離境退到款（§11 最後一列）
};

/**
 * 錢包有兩個罐子（§11，2026-09-08 加了 Wise）：
 *   · cash —— 手上的實體日圓現鈔
 *   · wise —— Wise 卡裡**出發前就換好的**日圓
 * 兩個都是「先換好的一包當地幣，花完就沒了」，但**互不影響**：
 * 刷 Wise 不會讓手上的現鈔變少，反過來也是。
 */
export const POTS = { cash: '現金', wise: 'Wise' };

/**
 * 這一筆會不會動到某個罐子。
 *
 * ⚠️ 三個容易搞錯的地方：
 *   · **儲值會扣現金**。用現金儲 Suica，現金確實變少了——
 *     它不算「花費」（model.isSpending 排除它），但一定算「現金流出」。
 *   · **免税消費扣全額（含稅）**。新制在店裡是真的付了含稅價（§7.3）。
 *   · **罐子裝的是當地幣**。在新加坡用 SGD 現金付的機票，動到的是新幣現金，
 *     不是日圓錢包（2026-09-08 實跑撞到）。
 *
 * @param settings 有給就比幣別；沒給就只看支付方式（舊呼叫端的行為）
 */
export function affectsPot(r, pot, settings) {
  const wallet = settings?.localCurrency;
  if (wallet && (r.currency || wallet) !== wallet) return false;
  return r.paymentMethod === (pot === 'wise' ? 'Wise' : '現金');
}

/** 舊名字，留著給既有呼叫端與測試用。 */
export function affectsCash(r, settings) {
  return affectsPot(r, 'cash', settings);
}

/**
 * 這一筆真正**離開錢包**的錢。
 *
 * ⚠️ 跟 `r.amount` 不一樣，兩個都要有（2026-09-10 補的洞）：
 *   · `amount`  = 東西值多少 → 統計、預算、分帳
 *   · 這一支    = 錢包少掉多少 → 現金／Wise 餘額、燒錢速度
 *
 * 差在**付款端折抵**：點數折抵、商品券、無現金回饋。
 * 例：合計 ¥1,161、キャッシュレス還元 −22、nanaco支払 ¥1,139
 *     → 東西值 1,161，但錢包只少了 1,139。
 *
 * 在這之前 App 讀到了 cashPaid 卻沒有任何地方用它，錢包每次都多扣。
 * `tenderDiscount` 只掛在收據的第一筆品項（split.js:toRecords），
 * 所以整張加起來剛好扣一次。
 */
export function cashOut(r) {
  return (r?.amount || 0) - (r?.tenderDiscount || 0);
}

/**
 * 算某位付款人某個罐子的餘額。
 *
 * 餘額 = Σ(這個罐子的錢包操作) − Σ(該付款人、走這個罐子的消費)
 *   · init / topup / refund：直接加
 *   · correct：加上「校正差額」（delta），差額本身在建立這筆操作時就算好並存起來，
 *     不是每次重算——因為校正的意義是「那個當下實際數到多少」，
 *     事後補記了漏掉的消費，不應該讓歷史校正跟著變。
 *
 * ⚠️ 沒有 `pot` 的錢包操作一律當成現金（2026-09-08 之前存的都沒有這個欄位）。
 *
 * 金額允許負數（退貨／退款），所以退款自然會加回來，不用另外處理。
 */
export function potBalance(payerId, pot, records, walletOps, settings) {
  let bal = 0;
  for (const op of walletOps) {
    if (op.payerId !== payerId) continue;
    if ((op.pot || 'cash') !== pot) continue;
    bal += op.type === 'correct' ? (op.delta || 0) : (op.amount || 0);
  }
  for (const r of records) {
    if (r.payer !== payerId || !affectsPot(r, pot, settings)) continue;
    bal -= cashOut(r);
  }
  return bal;
}

/** 現金罐子。介面保持原樣，既有呼叫端不用改。 */
export function cashBalance(payerId, records, walletOps, settings) {
  return potBalance(payerId, 'cash', records, walletOps, settings);
}

/**
 * 建立一筆「校正餘額」操作。
 *
 * 差額**記成「未記錄支出」而不是假裝沒發生**（§16 第 1 條）——
 * 9 天一定會有漏記，沒有校正機制餘額會越走越偏，到後面就沒人信它了。
 */
export function makeCorrection({ payerId, pot = 'cash', actualBalance, records, walletOps, settings, at, note }) {
  const current = potBalance(payerId, pot, records, walletOps, settings);
  const delta = actualBalance - current;
  return {
    type: 'correct',
    payerId,
    pot,
    at: at || new Date().toISOString(),
    actualBalance,
    previousBalance: current,
    delta,
    // 白話說明，給人看的：正數是「錢比帳上多」，負數是「有花掉但沒記到」
    note: note || (delta < 0
      ? `未記錄支出 ${Math.abs(delta)}`
      : delta > 0
        ? `帳上少記了收入 ${delta}`
        : '對得上，無差額'),
  };
}

/**
 * 現金燒得多快、還能撐幾天。首頁那句「還能撐 2.5 天」（§11）。
 *
 * 只看**行程期間、該付款人、現金**的流出，而且用「已經過了幾天」當分母，
 * 不是用行程總天數——第 2 天就拿 9 天去除，會算出一個好看但沒意義的數字。
 *
 * 資料不夠（還沒有任何現金支出、或還沒開始）就回 null，不要硬給一個數字。
 */
export function cashBurn(payerId, records, walletOps, settings, today) {
  const start = localDay(settings.tripStart);
  const now = localDay(today) || localToday();
  if (!start || !now) return null;

  const elapsedDays = Math.floor((Date.parse(now) - Date.parse(start)) / 86400000) + 1;
  if (elapsedDays < 1) return null;   // 還沒出發

  let spent = 0;
  for (const r of records) {
    if (r.payer !== payerId || !affectsCash(r, settings) || r.isPreTrip) continue;
    const d = localDay(r.date);
    if (!d || Date.parse(d) < Date.parse(start) || Date.parse(d) > Date.parse(now)) continue;
    spent += cashOut(r);
  }
  if (spent <= 0) return null;

  const perDay = spent / elapsedDays;
  const balance = cashBalance(payerId, records, walletOps, settings);
  return {
    perDay,
    balance,
    daysLeft: perDay > 0 ? balance / perDay : null,
    elapsedDays,
    spent,
  };
}

/**
 * 待退税累計（§7.9：是**應收**不是已省）。
 * 只算還沒退到的，已經退到的那些會另外記成一筆收入。
 */
export function pendingRefund(records) {
  return records
    .filter((r) => r.refundStatus !== 'received' && r.taxRefundPending > 0)
    .reduce((s, r) => s + r.taxRefundPending, 0);
}
