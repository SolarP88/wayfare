/**
 * 現金錢包 —— 規格 §11。
 *
 * 為什麼這支要獨立且測到死：預算是「該不該花」，現金餘額是「**還付不付得出來**」。
 * 算錯的後果是人在旭川郊區發現錢不夠又找不到收外國卡的 ATM。
 *
 * **每位付款人各一個錢包**——別人用自己的現金付，不可以扣到你的餘額。
 */

import { localDay } from './model.js';

/** 錢包操作的種類。消費不在這裡，消費是從 records 推的。 */
export const WALLET_OPS = {
  init: '設定初始現金',
  topup: '補充現金',        // ATM 領錢、再換錢
  correct: '校正餘額',      // 實際數過錢包，直接設成真實數字
  refund: '收到退税',       // 離境退到款（§11 最後一列）
};

/**
 * 一筆紀錄會不會動到現金錢包。
 *
 * ⚠️ 兩個容易搞錯的地方：
 *   · **儲值會扣錢包**。用現金儲 Suica，現金確實變少了——
 *     它不算「花費」（model.isSpending 排除它），但一定算「現金流出」。
 *     這兩件事分開判斷，不可以共用一個旗標。
 *   · **免税消費扣全額（含稅）**。新制在店裡是真的付了含稅價（§7.3），
 *     退税是之後的獨立收入。當下扣未稅價 = 餘額憑空多出一截。
 */
export function affectsCash(r) {
  return r.paymentMethod === '現金';
}

/**
 * 算某位付款人的現金餘額。
 *
 * 餘額 = Σ(錢包操作) − Σ(該付款人的現金支出)
 *   · init / topup / refund：直接加
 *   · correct：加上「校正差額」（delta），差額本身在建立這筆操作時就算好並存起來，
 *     不是每次重算——因為校正的意義是「那個當下實際數到多少」，
 *     事後補記了漏掉的消費，不應該讓歷史校正跟著變。
 *
 * 金額允許負數（退貨／退款），所以退款自然會加回來，不用另外處理。
 */
export function cashBalance(payerId, records, walletOps) {
  let bal = 0;
  for (const op of walletOps) {
    if (op.payerId !== payerId) continue;
    bal += op.type === 'correct' ? (op.delta || 0) : (op.amount || 0);
  }
  for (const r of records) {
    if (r.payer !== payerId || !affectsCash(r)) continue;
    bal -= r.amount || 0;
  }
  return bal;
}

/**
 * 建立一筆「校正餘額」操作。
 *
 * 差額**記成「未記錄支出」而不是假裝沒發生**（§16 第 1 條）——
 * 9 天一定會有漏記，沒有校正機制餘額會越走越偏，到後面就沒人信它了。
 */
export function makeCorrection({ payerId, actualBalance, records, walletOps, at, note }) {
  const current = cashBalance(payerId, records, walletOps);
  const delta = actualBalance - current;
  return {
    type: 'correct',
    payerId,
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
  const now = localDay(today) || localDay(new Date().toISOString());
  if (!start || !now) return null;

  const elapsedDays = Math.floor((Date.parse(now) - Date.parse(start)) / 86400000) + 1;
  if (elapsedDays < 1) return null;   // 還沒出發

  let spent = 0;
  for (const r of records) {
    if (r.payer !== payerId || !affectsCash(r) || r.isPreTrip) continue;
    const d = localDay(r.date);
    if (!d || Date.parse(d) < Date.parse(start) || Date.parse(d) > Date.parse(now)) continue;
    spent += r.amount || 0;
  }
  if (spent <= 0) return null;

  const perDay = spent / elapsedDays;
  const balance = cashBalance(payerId, records, walletOps);
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
