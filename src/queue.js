/**
 * 背景辨識佇列 —— 規格 §3。
 *
 * 動線：拍 → **立刻回到相機**（可連拍），辨識在背景排隊跑。
 * 沒訊號也照樣拍：照片＋座標先進佇列，有訊號再自動補辨識。
 *
 * 這一支只管「排隊與重試」，真正的呼叫在 gemini.js（含節流與 429 退避）。
 */

import { recognizeReceipt } from './gemini.js';
import { RECEIPT_PROMPT, validate } from './country-rules/japan.js';

export const STATUS = {
  pending: 'pending',       // 排隊中（可能是沒訊號）
  running: 'running',
  done: 'done',
  failed: 'failed',         // 兩個模型都失敗 → 待手動輸入（§5 第 3 條）
};

/**
 * 佇列。刻意做成一次只跑一件：
 * 併發跑會直接撞 RPM，而且低溫下同時開多個請求特別耗電（§16 第 12 條）。
 * gemini.js 已經有節流，這裡再序列化一次，兩層都不要出錯。
 */
export function createQueue({ getApiKey, getSettings, onUpdate, save }) {
  const items = new Map();
  let running = false;
  let completed = 0;          // 這次開 App 以來辨識成功幾張（純粹給人看的計數）

  const emit = () => onUpdate?.(summary());

  function summary() {
    const list = [...items.values()];
    return {
      completed,
      total: list.length,
      pending: list.filter((i) => i.status === STATUS.pending).length,
      running: list.filter((i) => i.status === STATUS.running).length,
      done: list.filter((i) => i.status === STATUS.done).length,
      failed: list.filter((i) => i.status === STATUS.failed).length,
      items: list,
    };
  }

  function add(item) {
    items.set(item.id, { ...item, status: STATUS.pending, attempts: 0 });
    emit();
    pump();
    return item.id;
  }

  /** 重試某一筆（例如回到有訊號的地方，或手動按重試）。 */
  function retry(id) {
    const it = items.get(id);
    if (!it) return;
    it.status = STATUS.pending;
    it.error = null;
    emit();
    pump();
  }

  function retryAllFailed() {
    for (const it of items.values()) {
      if (it.status === STATUS.failed) { it.status = STATUS.pending; it.error = null; }
    }
    emit();
    pump();
  }

  async function pump() {
    if (running) return;
    const next = [...items.values()].find((i) => i.status === STATUS.pending);
    if (!next) return;

    // 沒訊號就不要浪費電去試（§16 第 12 條）。回到有訊號時 online 事件會再叫醒。
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;

    running = true;
    next.status = STATUS.running;
    next.attempts++;
    emit();

    try {
      const r = await recognizeReceipt({
        apiKey: getApiKey(),
        prompt: RECEIPT_PROMPT,
        imageBase64: next.imageBase64,
        mimeType: next.mimeType || 'image/jpeg',
        coords: next.coords,
      });

      if (!r.ok) {
        next.status = STATUS.failed;
        // 失敗一定要留下「為什麼」——只印「失敗了」查不出是額度爆掉、
        // 圖片有問題、還是 JSON 壞掉
        next.error = r.error || '辨識失敗';
        next.attempts_detail = r.attempts;
      } else {
        const settings = getSettings();
        const v = validate(r.data, {
          tripStart: settings.tripStart,
          tripEnd: settings.tripEnd,
          medianByCategory: settings.medianByCategory,
        });
        next.status = STATUS.done;
        next.data = r.data;
        next.model = r.model;
        next.escalated = r.escalated;
        next.issues = v.issues;
        next.hardFail = v.hardFail;
        await save?.(next);

        // 落地成草稿之後就把它請出佇列：東西已經在「待確認」那張卡上了，
        // 留在這裡只是佔畫面（她 2026-09-08 問「那個辨識什麼的不能刪除嗎」），
        // 而且每一筆都還抱著一張 base64 照片，不放掉很吃記憶體。
        completed += 1;
        items.delete(next.id);
      }
    } catch (e) {
      next.status = STATUS.failed;
      next.error = e.message;
    } finally {
      running = false;
      emit();
      // 排下一個。用 setTimeout 讓出主執行緒，UI 才不會卡住
      setTimeout(pump, 0);
    }
  }

  // 回到有訊號就自動繼續（§3「有訊號再自動補辨識」）
  if (typeof addEventListener === 'function') {
    addEventListener('online', () => pump());
  }

  /** 手動請走一筆（失敗又不想再試的那種）。 */
  function remove(id) {
    items.delete(id);
    emit();
  }

  return { add, retry, retryAllFailed, remove, summary, pump, _items: items };
}
