/**
 * 拍照與定位 —— 規格 §3、§8。
 *
 * 核心原則：**拍照永遠成功。** 沒訊號也照樣拍，照片＋GPS 先存進手機排隊，
 * 有訊號再自動補辨識。GPS 晶片不需網路，飛航模式也抓得到。
 */

/**
 * 壓到 1024px（§4）。
 * 參考專案作者的第二個遺憾就是未壓縮直傳 3–5MB —— 日本漫遊網路差很多，
 * 而且低溫下傳大檔特別耗電（§16 第 12 條）。
 */
export async function compress(file, maxEdge = 1024, quality = 0.85) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);

  const canvas = typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(w, h)
    : Object.assign(document.createElement('canvas'), { width: w, height: h });
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();

  const blob = canvas.convertToBlob
    ? await canvas.convertToBlob({ type: 'image/jpeg', quality })
    : await new Promise((res) => canvas.toBlob(res, 'image/jpeg', quality));

  return { blob, width: w, height: h, originalSize: file.size, size: blob.size };
}

export async function toBase64(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  // 分段避免 apply 的參數上限（大圖會炸）
  for (let i = 0; i < buf.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

/**
 * 抓一次座標。**永不 reject** —— 定位失敗不可以擋住拍照（§8 三層 fallback）。
 * 抓不到就回 null，之後退回行程表，再不行由使用者手動選。
 */
export function getCoords({ timeoutMs = 8000 } = {}) {
  return new Promise((resolve) => {
    if (!navigator.geolocation) { resolve(null); return; }
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    // 自己也設一個逾時：室內深處的時候瀏覽器有時候不會如期回呼
    setTimeout(() => finish(null), timeoutMs + 500);
    navigator.geolocation.getCurrentPosition(
      (p) => finish({ lat: +p.coords.latitude.toFixed(5), lng: +p.coords.longitude.toFixed(5) }),
      () => finish(null),
      { enableHighAccuracy: false, timeout: timeoutMs, maximumAge: 60000 },
    );
  });
}

/**
 * 依日期從行程表推城市（§8 第 2 順位，GPS 失效時用）。
 * 行程是純文字設定，一行一個：`旭川  2026-11-29  2026-11-30`
 */
export function cityFromSchedule(dateISO, schedule) {
  const d = String(dateISO || '').slice(0, 10);
  if (!d) return null;
  for (const row of schedule || []) {
    if (!row.from) continue;
    const to = row.to || row.from;
    if (d >= row.from && d <= to) return row.city;
  }
  return null;
}

/** 解析設定頁那個純文字行程框。格式壞掉的行**跳過並回報**，不要靜靜吞掉。 */
export function parseSchedule(text) {
  const rows = [];
  const bad = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    // 「旭川 2026-11-29 2026-11-30」或「旭川 11/29-11/30」
    const iso = line.match(/^(\S+)\s+(\d{4}-\d{2}-\d{2})(?:\s*[~\-—]\s*|\s+)(\d{4}-\d{2}-\d{2})$/);
    if (iso) { rows.push({ city: iso[1], from: iso[2], to: iso[3] }); continue; }
    const one = line.match(/^(\S+)\s+(\d{4}-\d{2}-\d{2})$/);
    if (one) { rows.push({ city: one[1], from: one[2], to: one[2] }); continue; }
    bad.push(line);
  }
  return { rows, bad };
}
