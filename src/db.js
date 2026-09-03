/**
 * 儲存層 —— IndexedDB。規格 §4「資料 + 照片 → 手機本機 IndexedDB」。
 *
 * 為什麼是 IndexedDB 不是 localStorage：**照片一定要留**（§4，參考專案作者的第一個遺憾），
 * localStorage 只能存字串而且約 5MB，200 張壓過的照片放不下。
 *
 * ⚠️ 這一支在 Node 裡跑不起來（沒有 indexedDB），測試要在瀏覽器做。
 *    純計算的部分刻意都放在 model.js / wallet.js / stats.js，那些在 Node 測得到。
 *
 * ⚠️ iOS Safari 對長期沒用的網站會清資料（§12、§16 第 8 條）。
 *    旅行期間天天用不受影響；回來後盡快匯出。
 */

const DB_NAME = 'travel-receipts';
const DB_VERSION = 1;

export const STORES = {
  records: 'records',     // 一筆消費（§6）
  photos: 'photos',       // Blob，跟 record 分開存，列表查詢時不用把圖一起載出來
  wallet: 'wallet',       // 錢包操作（§11）
  settings: 'settings',   // 單一一筆，id = 'main'
  queue: 'queue',         // 待辨識佇列（沒訊號時照樣拍，§3）
};

let dbPromise = null;

export function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('這個環境沒有 IndexedDB（Node 裡跑不起來，要在瀏覽器測）'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORES.records)) {
        const s = db.createObjectStore(STORES.records, { keyPath: 'id' });
        s.createIndex('date', 'date');
        s.createIndex('payer', 'payer');
        s.createIndex('category', 'category');
        s.createIndex('needsReview', 'needsReview');
      }
      // 照片獨立一個 store：列紀錄時不該把幾十 MB 的圖一起讀出來
      if (!db.objectStoreNames.contains(STORES.photos)) {
        const s = db.createObjectStore(STORES.photos, { keyPath: 'id' });
        s.createIndex('recordId', 'recordId');
      }
      if (!db.objectStoreNames.contains(STORES.wallet)) {
        const s = db.createObjectStore(STORES.wallet, { keyPath: 'id', autoIncrement: true });
        s.createIndex('payerId', 'payerId');
      }
      if (!db.objectStoreNames.contains(STORES.settings)) {
        db.createObjectStore(STORES.settings, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORES.queue)) {
        const s = db.createObjectStore(STORES.queue, { keyPath: 'id' });
        s.createIndex('status', 'status');
      }
      void e;
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(db, store, mode) {
  return db.transaction(store, mode).objectStore(store);
}

function wrap(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function put(store, value) {
  const db = await openDB();
  return wrap(tx(db, store, 'readwrite').put(value));
}

export async function get(store, key) {
  const db = await openDB();
  return wrap(tx(db, store, 'readonly').get(key));
}

export async function all(store) {
  const db = await openDB();
  return wrap(tx(db, store, 'readonly').getAll());
}

export async function del(store, key) {
  const db = await openDB();
  return wrap(tx(db, store, 'readwrite').delete(key));
}

// ---------------------------------------------------------------------------
// 刪除永遠先進「最近刪除」，不直接消失（§17.2：戴手套誤觸機率高很多）
// ---------------------------------------------------------------------------

export async function softDelete(recordId) {
  const r = await get(STORES.records, recordId);
  if (!r) return null;
  r.deletedAt = new Date().toISOString();
  await put(STORES.records, r);
  return r;
}

export async function undelete(recordId) {
  const r = await get(STORES.records, recordId);
  if (!r) return null;
  delete r.deletedAt;
  await put(STORES.records, r);
  return r;
}

/** 正常查詢一律排除已刪除的。要看回收桶自己去 allRecords(true)。 */
export async function allRecords(includeDeleted = false) {
  const rows = await all(STORES.records);
  return includeDeleted ? rows : rows.filter((r) => !r.deletedAt);
}

export async function recentlyDeleted() {
  return (await all(STORES.records)).filter((r) => r.deletedAt);
}

// ---------------------------------------------------------------------------
// 設定：單一一筆
// ---------------------------------------------------------------------------

export async function loadSettings(defaults) {
  const s = await get(STORES.settings, 'main');
  return { ...defaults, ...(s || {}), id: 'main' };
}

export async function saveSettings(settings) {
  return put(STORES.settings, { ...settings, id: 'main' });
}

// ---------------------------------------------------------------------------
// 照片
// ---------------------------------------------------------------------------

export async function putPhoto(recordId, blob) {
  const id = `${recordId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  await put(STORES.photos, { id, recordId, blob, at: new Date().toISOString() });
  return id;
}

export async function photosOf(recordId) {
  const db = await openDB();
  const idx = tx(db, STORES.photos, 'readonly').index('recordId');
  return wrap(idx.getAll(recordId));
}

/**
 * 還剩多少空間（§17.4：手機空間快滿要在首頁紅字提醒）。
 * 瀏覽器不支援就回 null——不要編一個數字出來。
 */
export async function storageEstimate() {
  if (!navigator?.storage?.estimate) return null;
  const { usage, quota } = await navigator.storage.estimate();
  return { usage, quota, percent: quota ? usage / quota : null };
}
