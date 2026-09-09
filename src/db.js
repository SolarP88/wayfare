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
const DB_VERSION = 3;

export const STORES = {
  receipts: 'receipts',   // 一張收據（§6，2026-09-08 拆多筆之後才有）
  records: 'records',     // 一個品項一筆（拆帳前是「一張收據一筆」）
  photos: 'photos',       // Blob，跟 record 分開存，列表查詢時不用把圖一起載出來
  wallet: 'wallet',       // 錢包操作（§11）
  settings: 'settings',   // 單一一筆，id = 'main'
  queue: 'queue',         // 待辨識佇列（沒訊號時照樣拍，§3）
  settlements: 'settlements',  // 誰還了誰多少錢（2026-09-09 分帳）
};

/** 收據的兩種狀態。draft 的東西**不進統計、不動錢包**，直到她按下確認。 */
export const RECEIPT_STATUS = { draft: 'draft', confirmed: 'confirmed' };

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
      const upgradeTx = req.transaction;

      if (!db.objectStoreNames.contains(STORES.records)) {
        const s = db.createObjectStore(STORES.records, { keyPath: 'id' });
        s.createIndex('date', 'date');
        s.createIndex('payer', 'payer');
        s.createIndex('category', 'category');
        s.createIndex('needsReview', 'needsReview');
        s.createIndex('receiptId', 'receiptId');
      }
      // 一張收據一列。品項掛在它底下（§6，2026-09-08）
      if (!db.objectStoreNames.contains(STORES.receipts)) {
        const s = db.createObjectStore(STORES.receipts, { keyPath: 'id' });
        s.createIndex('date', 'date');
        s.createIndex('status', 'status');
      }
      // 照片獨立一個 store：列紀錄時不該把幾十 MB 的圖一起讀出來
      if (!db.objectStoreNames.contains(STORES.photos)) {
        const s = db.createObjectStore(STORES.photos, { keyPath: 'id' });
        s.createIndex('recordId', 'recordId');   // 舊索引，v1 的資料還在用
        s.createIndex('receiptId', 'receiptId');
      }

      // ---- v1 → v2：拆多筆之前存的資料要接得上 ----------------------------
      // 舊的一筆 = 一張收據，所以：receiptId 指向自己、補一張同 id 的收據、
      // 照片從綁 recordId 改成綁 receiptId（同一個值，加一個索引就好）。
      // ⚠️ 這段一定要跑在 versionchange transaction 裡，不能等 onsuccess——
      //    中間任何一步失敗，整個升級會回滾，不會留下半套資料。
      if (e.oldVersion >= 1 && e.oldVersion < 2 && upgradeTx) {
        const recStore = upgradeTx.objectStore(STORES.records);
        if (!recStore.indexNames.contains('receiptId')) recStore.createIndex('receiptId', 'receiptId');
        const rcpStore = upgradeTx.objectStore(STORES.receipts);
        const photoStore = upgradeTx.objectStore(STORES.photos);
        if (!photoStore.indexNames.contains('receiptId')) {
          photoStore.createIndex('receiptId', 'receiptId');
        }
        recStore.openCursor().onsuccess = (ev) => {
          const cur = ev.target.result;
          if (!cur) return;
          const r = cur.value;
          if (!r.receiptId) {
            rcpStore.put(migratedReceipt(r));
            cur.update({
              ...r,
              receiptId: r.id,
              seq: 1,
              status: RECEIPT_STATUS.confirmed,   // 舊資料視同已確認，不要突然全變待確認
            });
          }
          cur.continue();
        };
        photoStore.openCursor().onsuccess = (ev) => {
          const cur = ev.target.result;
          if (!cur) return;
          const p = cur.value;
          if (!p.receiptId && p.recordId) cur.update({ ...p, receiptId: p.recordId });
          cur.continue();
        };
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
      // v3：還款紀錄。用 if 包住所以舊使用者升級時只會多這一個 store，
      // 既有的收據 / 品項 / 錢包一個都不會動到。
      if (!db.objectStoreNames.contains(STORES.settlements)) {
        db.createObjectStore(STORES.settlements, { keyPath: 'id', autoIncrement: true });
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

/**
 * 刪一張收據 = 連同它底下所有品項一起進「最近刪除」。
 *
 * ⚠️ 拆多筆之後**不可以只刪一個品項**——剩下的品項加總就不等於合計了，
 *    現金錢包會跟著錯。要少算一項就去確認頁改，不是刪。
 */
export async function softDeleteReceipt(receiptId) {
  const at = new Date().toISOString();
  const rc = await get(STORES.receipts, receiptId);
  const lines = await recordsOf(receiptId);
  if (!rc && !lines.length) return null;
  if (rc) await put(STORES.receipts, { ...rc, deletedAt: at });
  for (const l of lines) await put(STORES.records, { ...l, deletedAt: at });
  return { receipt: rc, lines: lines.length };
}

export async function undeleteReceipt(receiptId) {
  const rc = await get(STORES.receipts, receiptId);
  const lines = (await all(STORES.records)).filter((r) => r.receiptId === receiptId);
  if (rc) { const { deletedAt, ...rest } = rc; void deletedAt; await put(STORES.receipts, rest); }
  for (const l of lines) { const { deletedAt, ...rest } = l; void deletedAt; await put(STORES.records, rest); }
  return { receipt: rc, lines: lines.length };
}

/** 正常查詢一律排除已刪除的。要看回收桶自己去 allRecords(true)。 */
export async function allRecords(includeDeleted = false) {
  const rows = await all(STORES.records);
  return includeDeleted ? rows : rows.filter((r) => !r.deletedAt);
}

/** 回收桶列的是**收據**，不是散落的品項（§17.2 一張一張復原才看得懂）。 */
export async function recentlyDeleted() {
  return (await all(STORES.receipts)).filter((r) => r.deletedAt);
}

// ---------------------------------------------------------------------------
// 收據（一張收據 + 它底下的品項一起寫、一起讀）
// ---------------------------------------------------------------------------

/** 舊資料升級用：一筆舊紀錄長成一張收據。只搬收據層的欄位。 */
function migratedReceipt(r) {
  return {
    id: r.id,
    date: r.date,
    storeName: r.storeName, storeNameLocal: r.storeNameLocal,
    total: r.amount, currency: r.currency,
    payer: r.payer, paymentMethod: r.paymentMethod, category: r.category,
    city: r.city, citySource: r.citySource, coords: r.coords,
    taxType: r.taxType, taxDetail: r.taxDetail,
    taxRefundPending: r.taxRefundPending, refundStatus: r.refundStatus,
    refundActual: r.refundActual, refundedAt: r.refundedAt,
    discounts: r.discounts, isTopUp: r.isTopUp,
    entryMode: r.entryMode,
    needsReview: r.needsReview, reviewReason: r.reviewReason, issues: r.issues,
    note: r.note,
    status: RECEIPT_STATUS.confirmed,
    migratedFrom: 'v1',
  };
}

export async function allReceipts(includeDeleted = false) {
  const rows = await all(STORES.receipts);
  return includeDeleted ? rows : rows.filter((r) => !r.deletedAt);
}

export async function recordsOf(receiptId, includeDeleted = false) {
  const db = await openDB();
  const idx = tx(db, STORES.records, 'readonly').index('receiptId');
  const rows = await wrap(idx.getAll(receiptId));
  return (includeDeleted ? rows : rows.filter((r) => !r.deletedAt))
    .sort((a, b) => (a.seq || 0) - (b.seq || 0));
}

/**
 * 一批收據標記成「退税已到款」（2026-09-09 退税清單）。
 *
 * ⚠️ 收據表與品項表**兩邊都要改**，而且要在同一個 transaction 裡。
 *    `wallet.pendingRefund()` 讀的是 records，確認頁讀的是 receipts——
 *    只改一邊的話，機場明明核完了，統計頁還一直印著「待退 ¥12,340」。
 *
 * ⚠️ 只動每張收據的**第一筆**品項：`taxRefundPending` 只掛在那一筆
 *    （split.js:255），其餘幾筆本來就是 null，寫進去反而會被重複計算。
 *
 * @param items [{ receiptId, actual }] —— actual 是分配回來的實退金額
 * @param at    退到款的時間
 */
export async function markRefunded(items = [], at = new Date().toISOString()) {
  if (!items.length) return 0;
  const db = await openDB();
  const t = db.transaction([STORES.receipts, STORES.records], 'readwrite');
  const rcp = t.objectStore(STORES.receipts);
  const rec = t.objectStore(STORES.records);
  const idx = rec.index('receiptId');

  for (const it of items) {
    const patch = { refundStatus: 'received', refundActual: it.actual, refundedAt: at };

    await new Promise((resolve, reject) => {
      const req = rcp.get(it.receiptId);
      req.onsuccess = () => { if (req.result) rcp.put({ ...req.result, ...patch }); resolve(); };
      req.onerror = () => reject(req.error);
    });

    await new Promise((resolve, reject) => {
      const req = idx.openCursor(it.receiptId);
      req.onsuccess = (e) => {
        const cur = e.target.result;
        if (!cur) { resolve(); return; }
        // 只有掛著待退金額的那一筆要改
        if (Number(cur.value.taxRefundPending) > 0) cur.update({ ...cur.value, ...patch });
        cur.continue();
      };
      req.onerror = () => reject(req.error);
    });
  }

  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve(items.length);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

/**
 * 撤銷退税標記（按錯了要救得回來）。
 */
export async function unmarkRefunded(receiptIds = []) {
  const items = receiptIds.map((receiptId) => ({ receiptId, actual: null }));
  if (!items.length) return 0;
  const db = await openDB();
  const t = db.transaction([STORES.receipts, STORES.records], 'readwrite');
  const rcp = t.objectStore(STORES.receipts);
  const rec = t.objectStore(STORES.records);
  const idx = rec.index('receiptId');

  for (const it of items) {
    const patch = { refundStatus: 'pending', refundActual: null, refundedAt: null };
    await new Promise((resolve, reject) => {
      const req = rcp.get(it.receiptId);
      req.onsuccess = () => { if (req.result) rcp.put({ ...req.result, ...patch }); resolve(); };
      req.onerror = () => reject(req.error);
    });
    await new Promise((resolve, reject) => {
      const req = idx.openCursor(it.receiptId);
      req.onsuccess = (e) => {
        const cur = e.target.result;
        if (!cur) { resolve(); return; }
        if (Number(cur.value.taxRefundPending) > 0) cur.update({ ...cur.value, ...patch });
        cur.continue();
      };
      req.onerror = () => reject(req.error);
    });
  }

  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve(items.length);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

/**
 * 一張收據＋它的品項一次寫進去（同一個 transaction）。
 *
 * ⚠️ 為什麼要同一個 transaction：分兩次寫，中間關掉 App 就會留下
 *    「有收據沒品項」或「有品項沒收據」的半套資料，兩種都會讓統計對不上。
 */
export async function saveReceipt(receipt, lines) {
  const db = await openDB();
  const t = db.transaction([STORES.receipts, STORES.records], 'readwrite');
  const rcp = t.objectStore(STORES.receipts);
  const rec = t.objectStore(STORES.records);

  // 先清掉這張收據原本的品項（確認頁可能刪過行、少了幾筆）
  const idx = rec.index('receiptId');
  await new Promise((resolve, reject) => {
    const req = idx.openCursor(receipt.id);
    req.onsuccess = (e) => {
      const cur = e.target.result;
      if (!cur) { resolve(); return; }
      cur.delete();
      cur.continue();
    };
    req.onerror = () => reject(req.error);
  });

  rcp.put(receipt);
  for (const l of lines) rec.put(l);

  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve({ receipt, lines: lines.length });
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export async function draftReceipts() {
  return (await allReceipts()).filter((r) => r.status === RECEIPT_STATUS.draft);
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
// 封面照（§9 首頁頂部）
//
// 放在 settings store 的另一把鑰匙（id: 'cover'），不占 photos store——
// photos 那邊是「收據的憑據」，健檢與匯出都會掃它，混進一張風景照只會添亂。
// ---------------------------------------------------------------------------

export async function putCover(blob) {
  return put(STORES.settings, { id: 'cover', blob, at: new Date().toISOString() });
}

export async function getCover() {
  return get(STORES.settings, 'cover');
}

export async function clearCover() {
  return del(STORES.settings, 'cover');
}

// ---------------------------------------------------------------------------
// 付款人頭像（她自己上傳的圖，例如 iPhone 的 Memoji）
//
// 跟封面照一樣放 settings store，鑰匙是 `avatar:<付款人id>`。
// 不進 photos store —— 那邊是收據憑據，健檢與匯出都會掃。
// ---------------------------------------------------------------------------

export async function putAvatar(payerId, blob) {
  return put(STORES.settings, { id: `avatar:${payerId}`, blob, at: new Date().toISOString() });
}

export async function getAvatar(payerId) {
  return get(STORES.settings, `avatar:${payerId}`);
}

export async function clearAvatar(payerId) {
  return del(STORES.settings, `avatar:${payerId}`);
}

// ---------------------------------------------------------------------------
// 重新開始（§17.2 的例外：這兩支是**真的刪掉**，不進回收桶）
//
// 所以呼叫端一定要先問過、而且問兩次。這裡只負責刪，不負責攔。
// ---------------------------------------------------------------------------

/**
 * 清掉所有帳，**保留設定**（匯率、行程、付款人、頭像、封面、API key）。
 * 出發前把測試資料掃乾淨用的。
 */
export async function clearAllRecords() {
  const db = await openDB();
  const stores = [STORES.receipts, STORES.records, STORES.photos, STORES.wallet, STORES.settlements];
  const t = db.transaction(stores, 'readwrite');
  for (const name of stores) t.objectStore(name).clear();
  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve(true);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

/**
 * 整個資料庫刪掉，回到初次安裝。
 *
 * ⚠️ 一定要先關掉連線，否則刪除會卡在 blocked 一直不完成。
 *    刪完呼叫端應該直接重新載入頁面——記憶體裡的狀態已經沒有意義了。
 */
export async function wipeEverything() {
  const db = await openDB();
  db.close();
  dbPromise = null;
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve(true);
    req.onerror = () => resolve(false);
    req.onblocked = () => resolve(false);
    setTimeout(() => resolve(false), 4000);
  });
}

// ---------------------------------------------------------------------------
// 照片
// ---------------------------------------------------------------------------

/**
 * 照片綁的是**收據**不是品項（2026-09-08）。
 * 一張收據拆成六個品項，照片只有一份，掛在收據上才不會存六次。
 */
export async function putPhoto(receiptId, blob) {
  const id = `${receiptId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  await put(STORES.photos, {
    id, receiptId, recordId: receiptId, blob, at: new Date().toISOString(),
  });
  return id;
}

export async function photosOf(receiptId) {
  const db = await openDB();
  const idx = tx(db, STORES.photos, 'readonly').index('receiptId');
  return wrap(idx.getAll(receiptId));
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
