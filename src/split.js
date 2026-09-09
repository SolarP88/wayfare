/**
 * 一張收據拆成多筆品項 —— 規格 §6（2026-09-08 擴充）。
 *
 * 這一支**不碰 IndexedDB、不碰 DOM、不呼叫 API**，純函式，在 Node 測得到。
 * 理由跟 model.js 一樣：拆帳是「錢會不會漂掉」的地方，
 * 一旦搬進 app.js 就變成最容易錯的東西放在最難測的地方。
 *
 * ⛔ 唯一的鐵律：**Σ 品項金額 === 合計**，一個單位都不准差。
 *    因為 wallet.js:53 的現金餘額是把每筆 amount 加總扣掉的——
 *    拆帳漂 ¥1，現金錢包就跟著漂 ¥1，九天下來沒人信那個數字。
 *    對不上就整張退回「一筆」，不要硬拆（見 splitReceipt 的 ok:false）。
 *
 * 參考 App 的洞（2026-09-03 從她的截圖驗出來）：FRESCO 那張小計 1585 + 稅 126 = 合計 1711，
 * 它逐項 ×1.08 各自進位後加總 1712，**比收據多 ¥1**——因為它拆完不回頭對合計。
 */

/** 日圓、韓元沒有小數；其他預設兩位。 */
const ZERO_DECIMAL = ['JPY', 'KRW'];

export function decimalsOf(currency) {
  return ZERO_DECIMAL.includes(currency) ? 0 : 2;
}

/** 換成「最小單位」的整數來算，避免浮點數在加總時漂掉。 */
export function toMinor(x, decimals) {
  return Math.round((x || 0) * 10 ** decimals);
}

export function fromMinor(m, decimals) {
  return decimals ? m / 10 ** decimals : m;
}

/** 日本消費稅：食品等輕減稅率 8%，其餘 10%（§7）。 */
export function taxRateOf(item) {
  return item?.reducedTax ? 0.08 : 0.10;
}

/**
 * 把 AI 回的 items[] 收斂成固定形狀。
 *
 * Gemini 現在只回 { nameLocal, name, price, reducedTax }（japan.js:256），沒有數量，
 * 所以 qty 預設 1、price 當成**該行印出來的金額**。
 * 確認頁讓她補 qty / 單價時，amount = 單價 × 數量 才會被採用。
 */
export function normalizeItems(items) {
  return (items || [])
    .filter((it) => it && (it.price != null || it.amount != null || it.unitPrice != null))
    .map((it, i) => {
      const qty = Number(it.qty) > 0 ? Number(it.qty) : 1;
      const unitPrice = Number(it.unitPrice ?? it.price ?? it.amount) || 0;
      return {
        seq: i + 1,
        name: it.name || it.nameLocal || '',
        nameLocal: it.nameLocal || '',
        qty,
        unitPrice,
        reducedTax: !!it.reducedTax,
        taxRate: taxRateOf(it),
        base: it.amount != null && it.qty == null ? Number(it.amount) : unitPrice * qty,
      };
    });
}

/**
 * 拆帳主函式。
 *
 * @param {object} receipt
 *   items      AI 或使用者給的品項
 *   total      收據上的「合計」（含稅實付，§7.1 照抄不自己加減）
 *   taxType    内税 / 外税 / 免税 / 不明
 *   priceDiscount  **只有價格折扣**（割引／値引），點數折抵不算——
 *                  那類不改變合計，只改變掏出去的錢（japan.js:376 的區分）
 *   currency
 * @returns {{ok:boolean, reason:string|null, lines:object[], residual:number, adjustedSeq:number|null}}
 */
export function splitReceipt(receipt = {}) {
  const currency = receipt.currency || 'JPY';
  const d = decimalsOf(currency);
  const total = receipt.total;

  if (total == null || !Number.isFinite(Number(total))) {
    return { ok: false, reason: '沒有合計金額，無法確認拆出來的加總對不對', lines: [], residual: 0, adjustedSeq: null };
  }

  const items = normalizeItems(receipt.items);
  if (!items.length) {
    return { ok: false, reason: '這張收據沒有讀到品項', lines: [], residual: 0, adjustedSeq: null };
  }

  const totalM = toMinor(total, d);
  const gaizei = receipt.taxType === '外税';

  // ① 每一項照自己的稅率算含稅金額。内税／免税／不明 → 印出來的就是含稅價。
  let lines = items.map((it) => {
    const baseM = toMinor(it.base, d);
    const grossM = gaizei ? Math.round(baseM * (1 + it.taxRate)) : baseM;
    return { ...it, baseM, grossM, amountM: grossM };
  });

  const grossSum = lines.reduce((s, l) => s + l.grossM, 0);
  if (grossSum === 0) {
    return { ok: false, reason: '品項金額全是 0，拆不出東西', lines: [], residual: 0, adjustedSeq: null };
  }

  // ② 價格折扣按金額比例攤下去（負數）。
  const discM = toMinor(Math.abs(receipt.priceDiscount || 0), d);
  if (discM > 0) {
    lines = lines.map((l) => ({
      ...l,
      discountM: Math.round((discM * l.grossM) / grossSum),
    }));
    lines = lines.map((l) => ({ ...l, amountM: l.grossM - l.discountM }));
  }

  // ③ 湊整差塞回金額最大的那筆（她 2026-09-03 的決定）。
  //    為什麼是最大那筆：±1 塞在 ¥3,000 那項看不出來，塞在 ¥98 那項會很醒目。
  const sum = lines.reduce((s, l) => s + l.amountM, 0);
  const residualM = totalM - sum;
  let adjustedSeq = null;
  if (residualM !== 0) {
    let idx = 0;
    for (let i = 1; i < lines.length; i++) {
      if (Math.abs(lines[i].amountM) > Math.abs(lines[idx].amountM)) idx = i;
    }
    lines[idx] = { ...lines[idx], amountM: lines[idx].amountM + residualM, adjusted: true };
    adjustedSeq = lines[idx].seq;
  }

  // ④ 差太多就不是進位誤差，是真的讀錯了——退回整張一筆，別硬拆。
  //    容差：每一項最多容許 1 個最小單位的進位差，至少 2。
  const tol = Math.max(2, lines.length);
  if (Math.abs(residualM) > tol) {
    return {
      ok: false,
      reason: `品項加總 ${fromMinor(sum, d)} 跟合計 ${total} 差 ${fromMinor(residualM, d)}，超過進位誤差`,
      lines: [],
      residual: fromMinor(residualM, d),
      adjustedSeq: null,
    };
  }

  const out = lines.map((l) => ({
    seq: l.seq,
    name: l.name,
    nameLocal: l.nameLocal,
    qty: l.qty,
    unitPrice: l.unitPrice,
    taxRate: l.taxRate,
    reducedTax: l.reducedTax,
    amount: fromMinor(l.amountM, d),
    adjusted: !!l.adjusted,
  }));

  // ⑤ 鐵律自我檢查。走到這裡還對不上就是程式寫錯了，寧可炸掉也不要靜靜存進去。
  assertBalanced(out, total, currency);

  return { ok: true, reason: null, lines: out, residual: fromMinor(residualM, d), adjustedSeq };
}

/** 整張當一筆——AI 沒讀到品項、或拆出來對不上合計時的退路。 */
export function fallbackSingleLine(receipt = {}) {
  return [{
    seq: 1,
    name: receipt.storeName || receipt.storeNameLocal || '整張收據',
    nameLocal: receipt.storeNameLocal || '',
    qty: 1,
    unitPrice: receipt.total ?? 0,
    taxRate: null,
    reducedTax: false,
    amount: receipt.total ?? 0,
    adjusted: false,
  }];
}

/** Σ 品項 === 合計。不成立就丟例外——這條不允許「大概對」。 */
export function assertBalanced(lines, total, currency = 'JPY') {
  const d = decimalsOf(currency);
  const sum = lines.reduce((s, l) => s + toMinor(l.amount, d), 0);
  const want = toMinor(total, d);
  if (sum !== want) {
    throw new Error(`拆帳失衡：Σ 品項 ${fromMinor(sum, d)} ≠ 合計 ${total}`);
  }
  return true;
}

/** Σ 品項 === 合計嗎（要布林值的地方用這個，不要 try/catch）。 */
export function isBalanced(lines, total, currency = 'JPY') {
  try { return assertBalanced(lines, total, currency); } catch { return false; }
}

// ---------------------------------------------------------------------------
// 收據 → 品項紀錄
//
// 這兩支也放在這裡（不是 app.js）的理由跟上面一樣：**它們決定每一筆的金額**。
// app.js 只負責把結果寫進 IndexedDB 跟畫上去。
// ---------------------------------------------------------------------------

/** 拆得成就拆，拆不成整張一筆——**永遠會回一個 Σ === 合計 的結果**。 */
export function buildLines(receipt) {
  const res = splitReceipt(receipt);
  if (res.ok) return { lines: res.lines, split: true, reason: null, adjustedSeq: res.adjustedSeq };
  return { lines: fallbackSingleLine(receipt), split: false, reason: res.reason, adjustedSeq: null };
}

/**
 * 一張收據 + 它的品項 → 要寫進 records store 的那幾筆。
 *
 * 類別預設**整張同一個**（2026-09-08 她的決定）：藥妝店整張算「藥品」，
 * 想把那包洋芋片改成「餐飲」就在確認頁單獨點那一行改。
 *
 * ⚠️ `taxRefundPending` 只掛在第一筆。它是**整張收據的應退稅額**，
 *    每一筆都放一份會讓 wallet.pendingRefund() 的加總變成好幾倍。
 */
export function toRecords(receipt, lines) {
  return lines.map((l, i) => ({
    id: `${receipt.id}:${l.seq}`,
    receiptId: receipt.id,
    seq: l.seq,
    status: receipt.status,

    // 品項自己的
    name: l.name,
    nameLocal: l.nameLocal,
    qty: l.qty,
    unitPrice: l.unitPrice,
    taxRate: l.taxRate,
    adjusted: !!l.adjusted,
    amount: l.amount,
    category: l.category || receipt.category,
    note: l.note || '',
    // 這一筆是分給誰的（2026-09-09）。沒指定就跟著整張收據；
    // 整張也沒指定就是 null = 全部算付款人自己的（舊資料的行為，不可以改）。
    shares: l.shares || receipt.shares || null,

    // 從收據繼承的（列表、統計、錢包都靠這些）
    date: receipt.date,
    storeName: receipt.storeName,
    storeNameLocal: receipt.storeNameLocal,
    currency: receipt.currency,
    payer: receipt.payer,
    paymentMethod: receipt.paymentMethod,
    city: receipt.city,
    citySource: receipt.citySource,
    coords: receipt.coords,
    isTopUp: !!receipt.isTopUp,
    taxType: receipt.taxType,
    entryMode: receipt.entryMode,
    needsReview: !!receipt.needsReview,
    // ⚠️ `reviewed` 一定要跟著下來。首頁那條「有 N 筆待確認」數的是**品項**
    //    （needsReview && !reviewed），只在收據上蓋 reviewed 的話，
    //    她確認幾次橫幅都不會消失（2026-09-08 她回報「一直顯示待確認」）。
    reviewed: !!receipt.reviewed,
    reviewReason: receipt.reviewReason || null,

    taxRefundPending: i === 0 ? (receipt.taxRefundPending ?? null) : null,
    refundStatus: i === 0 ? (receipt.refundStatus ?? 'none') : 'none',
  }));
}
