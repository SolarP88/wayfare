/**
 * 匯出與備份 —— 規格 §12。
 *
 * 資料只在這支手機裡，所以備份要做得顯眼，而且**不可以有「看起來成功但其實空的」**這種情況。
 *
 * 兩種輸出：
 *   · Excel（.xlsx）：一頁明細、一頁統計。給人看、給報帳用。
 *   · 備份（.json）：含照片（base64），是真正的還原用檔案。
 */

import { CATEGORIES } from './model.js';
import {
  byCategory, byPayment, byCity, byPayer, dailySeries,
  tripTotal, preTripTotal, budgetProgress,
} from './stats.js';
import { pendingRefund } from './wallet.js';

/** 明細頁的欄位。順序就是 Excel 上的順序。 */
export const DETAIL_COLUMNS = [
  ['date', '日期時間'],
  ['day', '第幾天'],
  ['storeName', '店名'],
  ['storeNameLocal', '店名（原文）'],
  ['category', '類別'],
  ['amount', '金額（當地）'],
  ['currency', '幣別'],
  ['amountHome', '金額（本位幣）'],
  ['paymentMethod', '支付方式'],
  ['payerName', '付款人'],
  ['city', '城市'],
  ['citySource', '城市來源'],
  ['taxType', '稅制'],
  ['taxRefundPending', '待退稅額'],
  ['refundStatus', '退稅狀態'],
  ['isPreTrip', '行前'],
  ['isTopUp', '儲值'],
  ['entryMode', '輸入方式'],
  ['needsReview', '待確認'],
  ['reviewReason', '待確認原因'],
  ['note', '備註'],
];

function payerName(r, settings) {
  return (settings.payers || []).find((p) => p.id === r.payer)?.name || r.payer || '';
}

export function detailRows(records, settings) {
  return records.map((r) => {
    const row = { ...r, payerName: payerName(r, settings) };
    return DETAIL_COLUMNS.map(([key]) => {
      const v = row[key];
      if (typeof v === 'boolean') return v ? '是' : '';
      return v ?? '';
    });
  });
}

export function summaryRows(records, settings) {
  const rows = [];
  const push = (...cells) => rows.push(cells);

  push('統計', '');
  push('本位幣', settings.homeCurrency);
  push('當地幣', settings.localCurrency);
  push('行程', `${settings.tripStart || '?'} ~ ${settings.tripEnd || '?'}`);
  push('現金匯率（1 本位幣 = ? 當地幣）', settings.cashRate ?? '未設定');
  push('刷卡匯率（1 本位幣 = ? 當地幣）', settings.cardRate ?? '未設定');
  push('');

  push('現場總花費（本位幣）', round2(tripTotal(records)));
  push('行前已付（本位幣）', round2(preTripTotal(records)));
  push('待退稅累計（當地幣）', pendingRefund(records));

  const bp = budgetProgress(records, settings);
  if (bp) {
    push('');
    push('預算', round2(bp.budget));
    push('已用', round2(bp.used));
    push('剩餘', round2(bp.left));
    push('使用率', `${(bp.percent * 100).toFixed(1)}%`);
  }

  const section = (title, data, unit = '本位幣') => {
    push('');
    push(`${title}（${unit}）`, '');
    for (const { key, value } of data) push(key, round2(value));
  };
  section('分類佔比', byCategory(records));
  section('支付方式佔比', byPayment(records));
  section('付款人佔比', byPayer(records));
  section('城市佔比', byCity(records));

  push('');
  push('每日趨勢', '');
  for (const d of dailySeries(records, settings)) {
    push(`Day ${d.day ?? '-'} ${d.date}`, round2(d.value));
  }

  return rows;
}

function round2(n) {
  return n == null ? '' : Math.round(n * 100) / 100;
}

/**
 * 產生 .xlsx。需要 SheetJS（index.html 以 script 標籤載入，掛在 window.XLSX）。
 *
 * ⚠️ SheetJS 沒載到就**丟出例外**，不要靜靜地少一個檔案 ——
 * 「按了匯出但什麼都沒發生」是最糟的失敗方式，尤其這是備份。
 * UI 那層接住之後改走 CSV。
 */
export function buildWorkbook(records, settings) {
  const XLSX = globalThis.XLSX;
  if (!XLSX) throw new Error('SheetJS 沒載入（可能沒網路），改用 CSV 匯出');

  const wb = XLSX.utils.book_new();
  const detail = [DETAIL_COLUMNS.map(([, label]) => label), ...detailRows(records, settings)];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(detail), '明細');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(summaryRows(records, settings)), '統計');
  return wb;
}

/** CSV 備援：沒網路載不到 SheetJS 時至少還有東西可以匯出。 */
export function toCSV(records, settings) {
  const esc = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [DETAIL_COLUMNS.map(([, l]) => esc(l)).join(',')];
  for (const row of detailRows(records, settings)) lines.push(row.map(esc).join(','));
  // Excel 開 UTF-8 CSV 沒有 BOM 會變亂碼
  return '﻿' + lines.join('\n');
}

/**
 * 完整備份（含照片）。這才是能還原的那一份。
 * @param photosByRecord Map<recordId, string[]>  已轉成 base64 的照片
 */
export function buildBackup({ records, walletOps, settings, photosByRecord }) {
  return {
    format: 'travel-receipt-app-backup',
    version: 1,
    exportedAt: new Date().toISOString(),
    counts: {
      records: records.length,
      photos: [...(photosByRecord?.values() || [])].reduce((s, a) => s + a.length, 0),
      walletOps: walletOps.length,
    },
    settings: { ...settings, apiKey: undefined },   // key 不進備份檔
    records,
    walletOps,
    photos: photosByRecord ? Object.fromEntries(photosByRecord) : {},
  };
}

/**
 * 讀回備份。**寧可整份拒絕，也不要匯入一半** ——
 * 匯入一半的帳本比沒有帳本更糟，因為你會以為它是完整的。
 */
export function parseBackup(json) {
  const b = typeof json === 'string' ? JSON.parse(json) : json;
  if (b?.format !== 'travel-receipt-app-backup') throw new Error('不是這個 App 的備份檔');
  if (!Array.isArray(b.records)) throw new Error('備份檔壞了：找不到 records');
  if (!Array.isArray(b.walletOps)) throw new Error('備份檔壞了：找不到 walletOps');
  if (b.counts?.records != null && b.counts.records !== b.records.length) {
    throw new Error(`備份檔對不上：宣稱 ${b.counts.records} 筆，實際 ${b.records.length} 筆`);
  }
  return b;
}

/** 統計頁那幾個沒出現過的類別也要列出來（0），否則看起來像漏掉了。 */
export function categoriesWithZero(records) {
  const map = new Map(byCategory(records).map((x) => [x.key, x.value]));
  return CATEGORIES.map((c) => ({ key: c, value: map.get(c) || 0 }));
}
