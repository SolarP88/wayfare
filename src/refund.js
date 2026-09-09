/**
 * 退税清單 —— 哪幾張要退、機場一次核、實際退到多少。
 *
 * 為什麼要有這一支（2026-09-09，她挑的 P1 之一）：
 * 統計頁本來只有一個「待退稅累計 ¥12,340」。站在機場退税櫃檯，
 * 那個數字幫不上任何忙——櫃檯要的是**一張一張的收據**，
 * 而她需要知道「該交哪幾張」、「交完了沒」、「最後真的退了多少」。
 *
 * ⚠️ 日本 2026-11-01 起改行「リファンド方式」：店裡照付含稅價、離境才退。
 *    所以這趟（11/29 出發）**每一張免税收據都會走這個流程**，
 *    不是舊制那種「店裡當場就免掉」。見 country-rules/japan.js 的說明。
 *
 * 跟 settle.js 一樣是純函式：不碰 IndexedDB、不碰 DOM，在 Node 測得到。
 *
 * ⛔ 兩條鐵律：
 *   1. **實退總額分回每一張時，Σ 必須完全等於實退總額**（跟 split.js 同一條）。
 *      不然匯出的報表加起來跟她真正拿到的錢對不上。
 *   2. **「應退」跟「實退」永遠分開存**。手續費、匯率、櫃檯少給——
 *      差額本身就是她要看到的資訊，不可以拿實退去覆蓋應退把證據抹掉。
 */

import { decimalsOf, toMinor, fromMinor } from './split.js';

/** 退税狀態。none = 這張不用退。 */
export const REFUND_STATUS = {
  none: 'none',
  pending: 'pending',     // 還沒去退
  received: 'received',   // 已經退到款
};

/**
 * 要退税的清單，一張收據一列。
 *
 * ⚠️ `taxRefundPending` 只掛在**每張收據的第一筆品項**上（split.js:255），
 *    所以這裡直接濾 records 就是「一張一列」，不需要再去收據表撈。
 *    若哪天改成每筆都掛，這裡會變成重複計算——split.js 那段註解不可以拿掉。
 */
export function refundRows(records = []) {
  return records
    .filter((r) => Number(r.taxRefundPending) > 0)
    .map((r) => ({
      receiptId: r.receiptId || r.id,
      recordId: r.id,
      date: r.date,
      storeName: r.storeName || r.storeNameLocal || '（沒有店名）',
      currency: r.currency || 'JPY',
      expected: Number(r.taxRefundPending),
      actual: r.refundActual == null ? null : Number(r.refundActual),
      status: r.refundStatus === REFUND_STATUS.received
        ? REFUND_STATUS.received : REFUND_STATUS.pending,
      refundedAt: r.refundedAt || null,
    }))
    // 日期新的排前面：機場那一疊通常是最近幾天買的
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));
}

/**
 * 總結。
 *
 * 幣別分開算——她有日圓也有新幣的收據，「待退 12,340」不說是哪種錢會出事
 * （跟 settle.js 鐵律 2 同一個理由）。
 *
 * @returns { [currency]: { pendingTotal, pendingCount, expectedOfReceived,
 *                          actualReceived, fee, receivedCount } }
 *   fee = 應退 − 實退。正數表示被扣掉了（手續費／櫃檯少給），負數表示退得比預期多。
 */
export function refundSummary(records = []) {
  const out = {};
  for (const row of refundRows(records)) {
    const g = (out[row.currency] ||= {
      pendingTotal: 0, pendingCount: 0,
      expectedOfReceived: 0, actualReceived: 0, receivedCount: 0, fee: 0,
    });
    if (row.status === REFUND_STATUS.received) {
      g.expectedOfReceived += row.expected;
      // 已退但沒填實收金額 → 當成「照應退金額退到」，不要把它算成 0 讓手續費暴增
      g.actualReceived += row.actual == null ? row.expected : row.actual;
      g.receivedCount += 1;
    } else {
      g.pendingTotal += row.expected;
      g.pendingCount += 1;
    }
  }
  for (const g of Object.values(out)) g.fee = g.expectedOfReceived - g.actualReceived;
  return out;
}

/**
 * 把「實際退到的總額」按應退金額比例分回每一張。
 *
 * 為什麼要分回去：機場是**一次退一包錢**，但匯出的報表是一張一列。
 * 不分回去的話，報表上每張的「實退」都是空的，加起來對不上她銀行收到的數字。
 *
 * 用最大餘數法，並且**保證 Σ 完全等於實退總額**（鐵律 1）：
 * 先各自取地板值，剩下的餘數發給「被砍掉最多」的那幾張。
 *
 * @param rows 要分配的列（通常是她在機場勾選的那幾張，必須同一幣別）
 * @param actualTotal 實際退到的總額
 * @returns [{ receiptId, recordId, expected, actual }]
 */
export function allocateActual(rows = [], actualTotal = 0, currency = 'JPY') {
  const d = decimalsOf(currency);
  const totalM = toMinor(actualTotal, d);
  const expectedM = rows.map((r) => toMinor(r.expected, d));
  const sumExpected = expectedM.reduce((s, x) => s + x, 0);

  if (!rows.length) return [];
  // 應退全是 0（理論上不會，但不要在這裡除以 0）→ 平均分
  if (sumExpected <= 0) {
    const base = Math.floor(totalM / rows.length);
    let rest = totalM - base * rows.length;
    return rows.map((r, i) => ({
      ...r, actual: fromMinor(base + (i < rest ? 1 : 0), d),
    }));
  }

  const exact = expectedM.map((e) => (totalM * e) / sumExpected);
  const floors = exact.map((x) => Math.floor(x));
  let rest = totalM - floors.reduce((s, x) => s + x, 0);

  // 小數部分最大的先拿。同分時給金額大的那張——分配誤差落在大張上比較不刺眼。
  const order = exact
    .map((x, i) => ({ i, frac: x - Math.floor(x), size: expectedM[i] }))
    .sort((a, b) => (b.frac - a.frac) || (b.size - a.size));

  const add = new Array(rows.length).fill(0);
  for (let k = 0; k < order.length && rest > 0; k++, rest--) add[order[k].i] = 1;

  return rows.map((r, i) => ({ ...r, actual: fromMinor(floors[i] + add[i], d) }));
}

/**
 * 這一批的差額說明 —— 給畫面用的一句話。
 *
 * 她會想知道「為什麼少了」，但 App 沒辦法知道原因（手續費？匯率？櫃檯算錯？），
 * 所以**只陳述事實、不猜原因**。
 */
export function feeNote(expected, actual, currency = 'JPY') {
  const d = decimalsOf(currency);
  const diff = toMinor(expected, d) - toMinor(actual, d);
  if (diff === 0) return null;
  const v = fromMinor(Math.abs(diff), d);
  const pct = expected > 0 ? Math.abs(diff) / toMinor(expected, d) * 100 : 0;
  return diff > 0
    ? { kind: 'short', amount: v, percent: pct }   // 退得比應退少
    : { kind: 'extra', amount: v, percent: pct };  // 退得比應退多
}
