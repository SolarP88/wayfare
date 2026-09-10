/**
 * Service Worker —— 讓 App「沒訊號也打得開」。
 *
 * 為什麼要有這支（2026-09-09 查出來的洞）：
 * `manifest.webmanifest` 讓 App 可以加到主畫面、有自己的圖示、全螢幕，
 * 看起來就像一個裝好的 App —— 但**程式本體還是每次都要從網路抓**。
 * 北海道山區、地下街、飛機上，點開圖示就是一片白畫面。
 *
 * ⚠️ 這跟之前測過的「離線拍照」**不是同一件事**：
 *   · 已測過：App **開著**的時候斷網 → 照片排隊，回線再辨識。沒問題。
 *   · 沒測過：**斷網時把 App 打開** ← 真實情境就是這個。走進店裡、掏手機、點圖示。
 *
 * 做法：安裝時把 App 本體整包存進 Cache Storage，之後一律先讀快取。
 *
 * ⛔ 兩種東西永遠不快取（寫在 fetch handler，別動）：
 *   · Gemini 辨識 API —— POST，而且回應跟這張照片綁死
 *   · 匯率 API —— 拿到三天前的匯率去算錢，比「抓不到匯率」更糟：
 *     抓不到你會知道要自己填，拿到舊的你不會知道
 * 這兩個都是跨網域，下面的規則只碰同網域 + SheetJS 那一個網址，所以自然不會碰到。
 */

/* deploy.sh 會把這行換成當次檔案內容的雜湊。
   換一個版本號 = 換一個 cache 名字 = 手機下次連上網就會抓到新版。
   本機直接開檔時就維持 4cec06b314fc，不影響功能。 */
const VERSION = '4cec06b314fc';
const CACHE = `wayfare-${VERSION}`;

/* 版本號還是佔位符 = 這份沒有經過 deploy.sh = **本機開發中**。
   2026-09-09 踩到：本機改了 db.js，瀏覽器卻一直跑舊的——因為 sw.js 一個字沒變，
   瀏覽器認定 SW 沒更新，於是快取裡的舊檔案永遠不會被換掉。
   （這正是版本戳要防的事，只是本機沒有版本戳可用。）

   所以開發時反過來走「網路優先」：抓得到就用新的，抓不到才退回快取。
   線上（版本戳蓋過）維持快取優先——那才是「沒訊號也打得開」需要的行為。 */
const DEV = VERSION === '__' + 'BUILD__';

/* 匯出 Excel 用的。CDN 來的，但**一定要快取** ——
   不然人在飛機上想匯出，SheetJS 抓不到，匯出鈕整個掛掉。 */
const XLSX_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';

/**
 * 要預先存起來的檔案。
 *
 * ⚠️ **這份清單必須跟 tools/deploy.sh 的白名單一致**（`./` 和 CDN 除外）。
 * 少列一個檔，那個檔離線時就是 404 —— 而且**線上測不出來**，
 * 因為線上永遠抓得到。`tools/test_sw.mjs` 就是在自動比對這件事。
 */
const SHELL = [
  './',
  'index.html',
  'manifest.webmanifest',
  'src/app.js',
  'src/camera.js',
  'src/db.js',
  'src/export.js',
  'src/fx.js',
  'src/gemini.js',
  'src/model.js',
  'src/queue.js',
  'src/refund.js',
  'src/settle.js',
  'src/split.js',
  'src/stats.js',
  'src/wallet.js',
  'src/country-rules/japan.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);

    /* 同網域這些是 App 的命脈，少一個就別裝了 —— 寧可維持舊版可以離線，
       也不要裝一個「開得起來但缺一個模組」的半套版本。

       ⛔ `cache: 'reload'` 不可以拿掉。
       `cache.addAll(SHELL)` 預設會**先問瀏覽器的 HTTP 快取**——於是「安裝新版」
       有機會把**舊檔案**存進新快取。實際後果：我修好一個 bug、她點了「有新版本」，
       新快取裡裝的還是舊程式，而且從此固定住，怎麼重開都一樣。
       2026-09-09 本機實測就是這樣：sw.js 換了、快取名也換了，
       但 fetch('src/db.js') 拿回來的還是上一版。
       'reload' 強迫每一個檔都真的去網路拿。 */
    await cache.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })));

    /* SheetJS 是跨網域。CDN 偶爾會抽風，但那不該讓整個更新失敗
       （匯出離線掛掉 << App 整個打不開）。所以單獨試，失敗就算了。 */
    try {
      await cache.add(new Request(XLSX_CDN, { mode: 'cors', cache: 'reload' }));
    } catch (err) {
      console.warn('[sw] SheetJS 沒快取到，離線匯出會不能用：', err);
    }
    /* 這裡**故意不呼叫 skipWaiting()**。
       她選的是「跳橫幅問我，點了才更新」——新版本要在旁邊等，
       不可以在她記帳打到一半時把頁面抽掉。真正的切換在下面的 message handler。 */
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    /* 舊版本的 cache 全部清掉。不清的話手機儲存空間會一版一版疊上去。 */
    const names = await caches.keys();
    await Promise.all(
      names.filter((n) => n.startsWith('wayfare-') && n !== CACHE)
           .map((n) => caches.delete(n))
    );
    await self.clients.claim();
  })());
});

/** 首頁的橫幅按下去時，app.js 會送這個訊息過來。 */
self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (e) => {
  const req = e.request;

  /* 只管 GET。POST（Gemini 辨識）交給瀏覽器自己處理。 */
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;
  const isXlsx = req.url === XLSX_CDN;

  /* 其他所有跨網域請求（匯率 API、Gemini）一律不碰。 */
  if (!sameOrigin && !isXlsx) return;

  e.respondWith((async () => {
    /* 開 App 這件事本身（導覽請求）。
       離線時網路一定失敗，所以先給快取裡的 index.html —— 這一行就是
       「沒訊號點開圖示不再是白畫面」的關鍵。 */
    if (req.mode === 'navigate') {
      if (DEV) {
        try { return await fetchAndCache(req); } catch { /* 沒網路就往下走快取 */ }
      }
      const hit = await caches.match('index.html', { cacheName: CACHE })
               || await caches.match('./', { cacheName: CACHE });
      if (hit) {
        /* 有快取就先給快取（開得快、離線也開得起來），
           同時在背景抓新的存起來，下次開就是新版。 */
        fetchAndCache(req).catch(() => {});
        return hit;
      }
      return fetch(req);
    }

    /* 其餘同網域資源（模組、manifest）與 SheetJS：快取優先（開發時網路優先，見上面 DEV）。 */
    if (DEV) {
      try { return await fetchAndCache(req); } catch { /* 沒網路就往下走快取 */ }
    }
    const hit = await caches.match(req, { cacheName: CACHE });
    if (hit) return hit;

    try {
      return await fetchAndCache(req);
    } catch (err) {
      /* 離線又沒快取到 —— 通常表示這個檔沒列進 SHELL（見上面的警告）。
         給一個看得懂的錯誤，不要讓瀏覽器丟一句沒頭沒尾的 TypeError。 */
      return new Response(`離線，而且這個檔沒有被快取：${url.pathname}`,
        { status: 504, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }
  })());
});

/** 抓網路，成功就順手存進快取（只存正常回應，錯誤頁不存）。 */
async function fetchAndCache(req) {
  const res = await fetch(req);
  if (res && res.ok && (res.type === 'basic' || res.type === 'cors')) {
    const cache = await caches.open(CACHE);
    cache.put(req, res.clone());
  }
  return res;
}
