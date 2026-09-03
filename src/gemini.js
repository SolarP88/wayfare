/**
 * Gemini 呼叫層 —— 對應設計規格 §5（模型策略）。
 *
 * 這一支同時給瀏覽器（App）和 Node（測試跑批）用，
 * 所以只依賴 fetch，不 import 任何 node 專屬模組。
 *
 * model ID 已於 2026-09-02 用 ListModels 實測確認存在且可呼叫。
 */

const API = 'https://generativelanguage.googleapis.com/v1beta/models';

export const MODELS = {
  // 主力：只在主力讀不好時才升級到 fallback
  primary: 'gemini-3.5-flash-lite',
  fallback: 'gemini-3.5-flash',
};

// 額度數字的出處：規格 §5 那張表是 Llama 2026-09-02 從 AI Studio 讀的
//   Gemini 3.5 Flash Lite（主力）15 RPM / 500 RPD
//   Gemini 3.5 Flash（疑難）    5 RPM /  20 RPD
// ⚠️ Google 官方文件**已經不再公布**各模型的免費額度（2026-09-03 查證），
//    只叫人去看自己的：https://aistudio.google.com/rate-limit
//    所以上面那組數字是「她的帳號那天的值」，不是保證不變的常數。
// → 這支程式因此**不依賴**任何寫死的額度數字，只靠下面的節流 + 429 退避。
// 官方文件目前還確認得到的是：
//   · 限制有三個維度：RPM（每分鐘請求）、TPM（每分鐘 token）、RPD（每天請求）
//   · 任何一個超過就報錯 —— RPM 爆了，就算 RPD 還很空一樣會被擋
//   · RPD 在**太平洋時間午夜**重置（不是當地午夜；11–12 月的 PST 相當於日本下午 5 點）
//   · 限制是**綁專案不是綁 API key**
//   · 超過一律回 429 RESOURCE_EXHAUSTED

// ---------------------------------------------------------------------------
// 發送節流（2026-09-03 加）
//
// 為什麼：2026-09-02 連續丟 21 張進去，撞到 RPM 限制、5 張直接失敗。
// 炸的是 RPM（每分鐘），不是每日額度 —— 所以「一天才拍 20 張」並不安全，
// 關鍵是**一次匯入幾張**。晚上回飯店把當天的收據一起丟進去就是一分鐘 20 次。
//
// 做法：所有呼叫共用一個閘，每次發送至少間隔 60000/RPM 毫秒。
// 預設 RPM=15（比常見的 20 保守一點，因為查不到確切數字）。
// ---------------------------------------------------------------------------

let minIntervalMs = 60000 / 15;
let nextSlot = 0;

/** 調整節流速率。rpm=0 或負數代表完全不節流（測試用）。 */
export function configureRateLimit({ rpm } = {}) {
  if (typeof rpm === 'number') minIntervalMs = rpm > 0 ? 60000 / rpm : 0;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 排隊拿一個發送時段。同時呼叫也會被排成一列，不會擠在同一秒。 */
async function takeSlot() {
  if (minIntervalMs <= 0) return;
  const now = Date.now();
  const at = Math.max(now, nextSlot);
  nextSlot = at + minIntervalMs;
  if (at > now) await sleep(at - now);
}

/**
 * 從 429 回應裡找出該等多久（毫秒）。
 * Gemini 可能放在 Retry-After 標頭，也可能放在錯誤內容的 RetryInfo 裡。
 * 兩個都沒有就回 null，交給呼叫端決定預設值。
 */
function parseRetryDelay(res, body) {
  const hdr = res?.headers?.get?.('retry-after');
  if (hdr) {
    const secs = Number(hdr);
    if (Number.isFinite(secs)) return secs * 1000;
    const when = Date.parse(hdr);
    if (Number.isFinite(when)) return Math.max(0, when - Date.now());
  }
  const info = (body?.error?.details || []).find((d) =>
    String(d['@type'] || '').includes('RetryInfo')
  );
  const m = String(info?.retryDelay || '').match(/^([\d.]+)s$/);
  if (m) return Number(m[1]) * 1000;
  return null;
}

/** 從 ```json ... ``` 圍欄或裸文字裡挖出 JSON。 */
function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('回傳裡找不到 JSON');
  return JSON.parse(raw.slice(start, end + 1));
}

async function callOnce({ apiKey, model, prompt, imageBase64, mimeType, coords }) {
  const parts = [{ text: prompt }];
  if (coords) {
    parts.push({
      text: `\n\n拍照當下的 GPS 座標：緯度 ${coords.lat}, 經度 ${coords.lng}。用這個判斷城市。`,
    });
  }
  parts.push({ inlineData: { mimeType: mimeType || 'image/jpeg', data: imageBase64 } });

  const send = async () => {
    await takeSlot();
    const res = await fetch(`${API}/${model}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: {
          temperature: 0,          // 記帳不需要創意
          maxOutputTokens: 8192,
          responseMimeType: 'application/json',
        },
      }),
    });
    return { res, body: await res.json() };
  };

  let { res, body } = await send();

  // 撞到限流就退避重試**一次**。
  // 這跟 §5 的「不重試燒額度」不衝突：那條講的是模型讀不好時不要一直重讀，
  // 這裡是請求根本沒被服務，等一下再送本來就是對的做法。
  if (res.status === 429) {
    const waitMs = Math.min(parseRetryDelay(res, body) ?? minIntervalMs * 2, 60000);
    await sleep(waitMs);
    ({ res, body } = await send());
  }

  if (!res.ok) {
    const msg = body?.error?.message || `HTTP ${res.status}`;
    const err = new Error(
      res.status === 429
        ? `限流（429）退避後重試仍失敗：${msg}——` +
          `RPM／TPM／RPD 任一超過都會這樣，去 https://aistudio.google.com/rate-limit 看目前額度`
        : msg
    );
    err.status = res.status;
    err.retryable = res.status === 429 || res.status >= 500;
    throw err;
  }

  const cand = body.candidates?.[0];
  const text = (cand?.content?.parts || []).map((p) => p.text || '').join('');
  if (!text) throw new Error(`回傳是空的（finishReason=${cand?.finishReason}）`);

  return {
    data: extractJson(text),
    usage: body.usageMetadata,
    finishReason: cand?.finishReason,
  };
}

/**
 * 辨識一張收據。
 *
 * §5 的升級規則：
 *   主力跑 → needsReview 或 JSON 壞掉 → 升級疑難模型重跑一次
 *   → 還是不行就標成「待手動輸入」，**不重試燒額度**
 *
 * @returns {{ok, data, model, escalated, error}}
 */
export async function recognizeReceipt({
  apiKey, prompt, imageBase64, mimeType, coords, allowEscalate = true,
}) {
  const attempts = [];
  let first;

  try {
    first = await callOnce({ apiKey, model: MODELS.primary, prompt, imageBase64, mimeType, coords });
    attempts.push({ model: MODELS.primary, ok: true, usage: first.usage });
  } catch (e) {
    attempts.push({ model: MODELS.primary, ok: false, error: e.message });
  }

  const needsEscalation = !first || first.data?.needsReview === true;

  if (!needsEscalation) {
    return { ok: true, data: first.data, model: MODELS.primary, escalated: false, attempts };
  }

  if (!allowEscalate) {
    return first
      ? { ok: true, data: first.data, model: MODELS.primary, escalated: false, attempts }
      : { ok: false, error: '主力模型失敗且不允許升級', attempts };
  }

  // 升級一次，就一次。（§5 第 3 條：兩者都失敗 → 待手動輸入，不重試燒額度）
  try {
    const second = await callOnce({
      apiKey, model: MODELS.fallback, prompt, imageBase64, mimeType, coords,
    });
    attempts.push({ model: MODELS.fallback, ok: true, usage: second.usage });
    return { ok: true, data: second.data, model: MODELS.fallback, escalated: true, attempts };
  } catch (e) {
    attempts.push({ model: MODELS.fallback, ok: false, error: e.message });
  }

  // 主力有讀出東西、只是自己標了 needsReview → 那份還是留著給人改，
  // 總比整張丟掉好。
  if (first) {
    return {
      ok: true, data: first.data, model: MODELS.primary,
      escalated: true, escalationFailed: true, attempts,
    };
  }

  return { ok: false, error: '兩個模型都失敗，標成待手動輸入', attempts };
}

export default { MODELS, recognizeReceipt, configureRateLimit };
