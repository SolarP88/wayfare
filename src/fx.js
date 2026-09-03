/**
 * 匯率 —— 規格 §10。
 *
 * ⚠️ **這裡抓到的匯率只是參考值，不拿來自動換算。**
 *
 * 理由（§10 原文）：市場匯率不是實際成本。換現金的成本是換錢當下那個匯率，
 * 刷卡是銀行當日匯率 + 手續費，都不等於市場價。用市場價算出來的本位幣金額，
 * 是一個從來沒付過的價格。
 *
 * 所以這支的唯一用途是：設定頁那顆「更新參考匯率」按鈕，讓她自己看了再決定
 * 要不要調整 cashRate / cardRate。**不自動、不即時、離線也能用（用舊的設定值）。**
 */

// 主要：免金鑰、CORS 全開、一次回傳所有幣別（2026-09-02 實測通過）
const PRIMARY = 'https://open.er-api.com/v6/latest/';
// 備援：同樣 CORS 全開。⚠️ 舊網址 api.frankfurter.app 已 301 搬家，不要寫舊的
const FALLBACK = 'https://api.frankfurter.dev/v1/latest?base=';

/**
 * 抓「1 本位幣 = ? 當地幣」。方向跟 model.js 的 cashRate/cardRate 一致。
 *
 * @returns {{rate:number, source:string, at:string}} 或 throw
 */
export async function fetchReferenceRate(homeCurrency, localCurrency) {
  if (homeCurrency === localCurrency) {
    return { rate: 1, source: '同幣別', at: new Date().toISOString() };
  }

  try {
    const res = await fetch(PRIMARY + encodeURIComponent(homeCurrency));
    if (res.ok) {
      const j = await res.json();
      const rate = j?.rates?.[localCurrency];
      if (j?.result === 'success' && typeof rate === 'number') {
        return { rate, source: 'open.er-api.com', at: new Date().toISOString() };
      }
    }
  } catch (e) {
    void e;   // 掉到備援，不吵
  }

  const res = await fetch(`${FALLBACK}${encodeURIComponent(homeCurrency)}&symbols=${encodeURIComponent(localCurrency)}`);
  if (!res.ok) throw new Error(`匯率 API 兩個都失敗（HTTP ${res.status}）`);
  const j = await res.json();
  const rate = j?.rates?.[localCurrency];
  if (typeof rate !== 'number') throw new Error('匯率回傳裡找不到目標幣別');
  return { rate, source: 'frankfurter.dev', at: new Date().toISOString() };
}

/**
 * 拿參考匯率跟她設定的匯率比，給一句白話。
 * **不會自動改她的設定**——那是她換錢時真的拿到的價格，只有她知道。
 */
export function compareToSettings(reference, settings) {
  const out = [];
  for (const [key, label] of [['cashRate', '現金匯率'], ['cardRate', '刷卡匯率']]) {
    const mine = settings[key];
    if (!mine || !reference) continue;
    const diff = (mine - reference) / reference;
    out.push({
      key,
      label,
      mine,
      reference,
      diffPercent: diff * 100,
      // 拿到的當地幣比市場少 = 換得比較差
      hint: Math.abs(diff) < 0.01
        ? '跟市場價差不多'
        : diff < 0
          ? `比市場價差 ${Math.abs(diff * 100).toFixed(1)}%（正常，換匯有價差）`
          : `比市場價好 ${(diff * 100).toFixed(1)}%`,
    });
  }
  return out;
}
