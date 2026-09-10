/**
 * 分帳與代墊 —— 誰欠我多少、我欠誰多少。
 *
 * 為什麼要有這一支（2026-09-09，她挑的 P0 之二）：
 * 他們九個人去北海道，租車、包車、大餐很可能是她先刷卡。
 * 原本的模型只知道「這筆是誰付的」（`record.payer`），
 * **不知道「這筆是付給誰用的」** —— 所以 App 會說她花了 ¥120,000，
 * 而其中 ¥96,000 其實是別人的。回來要算錢的時候完全幫不上忙。
 *
 * 這一支跟 split.js 一樣是**純函式**：不碰 IndexedDB、不碰 DOM、不呼叫 API，
 * 在 Node 測得到。理由也一樣——這是「錢會不會漂掉」的地方，
 * 一旦搬進 app.js 就變成最容易錯的東西放在最難測的地方。
 *
 * ⛔ 三條鐵律：
 *   1. **Σ 每個人分到的 === 這筆的金額**，一個單位都不准差（跟 split.js 同一條）。
 *      分不平的餘數固定塞給付款人自己——她墊了錢，多吃 ¥1 不會有人有意見，
 *      但讓某個朋友莫名其妙多欠 ¥1 是會被問的。
 *   2. **不同幣別絕對不相加**。她有日圓也有新幣的紀錄，
 *      「阿明欠你 45,000」而不說是哪一種錢，是會出事的。所以一律**按幣別分開結算**。
 *   3. **沒有指定分帳對象的紀錄 = 全部算付款人自己的**。
 *      這是舊資料的行為，不可以因為多了這個功能就讓九月之前的帳突然變成大家平分。
 */

import { isSpending } from './model.js';
import { decimalsOf, toMinor, fromMinor } from './split.js';

/**
 * 這一筆是分給誰的。
 *
 * 回傳的一定是**至少含一個人**的陣列。沒填、空陣列、或填了但那些人都不存在
 * → 退回「付款人自己」，也就是這個功能出現之前的行為。
 *
 * @param record 一筆品項紀錄
 * @param validIds 目前存在的人（設定裡刪掉的人不該還在分帳裡）；沒給就不過濾
 */
export function sharesOf(record, validIds = null) {
  const payer = record?.payer;
  let list = Array.isArray(record?.shares) ? record.shares.filter(Boolean) : [];
  if (validIds) {
    const ok = new Set(validIds);
    list = list.filter((id) => ok.has(id));
  }
  // 去重：同一個人在同一筆裡出現兩次，會讓他吃到兩份
  list = [...new Set(list)];
  return list.length ? list : (payer ? [payer] : []);
}

/**
 * 把一筆金額平分給 n 個人，**保證加起來完全等於原金額**。
 *
 * 用最小單位的整數算（¥ 是 1，S$ 是 0.01），先每人拿地板值，
 * 剩下的餘數一個一個發出去——餘數優先給 `remainderTo` 指定的那個位置（付款人）。
 *
 * 例：¥45,000 分 9 個人 → 每人 ¥5,000，沒有餘數。
 *     ¥1,000 分 3 個人 → 333 / 333 / 334，多的那 1 塊給付款人。
 *
 * @returns 每人分到多少（最小單位的整數），順序跟 ids 一致
 */
export function shareAmountsMinor(amountMinor, count, remainderTo = 0) {
  if (count <= 0) return [];
  return weightedAmountsMinor(amountMinor, new Array(count).fill(1), remainderTo);
}

/**
 * 這一筆裡每個人算幾份。
 *
 * 2026-09-10 加的。本來一律平分，她要的是「阿明點了兩份」這種情況。
 * `record.weights` 是**選填**的 `{ 人id: 份數 }` —— 沒有這一欄就是每人 1 份，
 * 也就是九月十號以前所有的資料**行為一個位元都不會變**（跟鐵律 3 同一個道理）。
 *
 * 份數一律收斂成 1..99 的整數。**不接受 0 份**：0 的意思是「他沒有份」，
 * 那該做的是把人從 `shares` 拿掉，而不是在這裡留一個 0 ——
 * 留 0 會讓總份數算錯，全部都是 0 還會除以零。
 *
 * @param record 一筆品項紀錄
 * @param ids    這筆分給誰（`sharesOf` 的結果）；回傳的份數跟它同順序
 */
export function weightsOf(record, ids = []) {
  const w = record?.weights;
  return ids.map((id) => {
    const n = Math.round(Number(w?.[id]));
    return Number.isFinite(n) && n >= 1 ? Math.min(n, 99) : 1;
  });
}

/**
 * 按**份數**分一筆金額，一樣保證加起來完全等於原金額。
 *
 * 每人先拿 floor(金額 × 他的份數 ÷ 總份數)，剩下的餘數從付款人那一格開始
 * 一個單位一個單位發出去 —— 跟平分版是同一條餘數規則（鐵律 1）。
 *
 * ⚠️ 全部都是 1 份的時候，結果必須跟舊的平分**完全一樣**：
 * floor(abs × 1 ÷ n) === floor(abs ÷ n)，餘數迴圈也一模一樣。
 * `test_settle` 有一組隨機對拍在盯這件事，不要改壞。
 *
 * 例：¥45,000、9 個人、阿明 2 份 → 總共 10 份 → 阿明 ¥9,000、其他 8 人各 ¥4,500。
 */
export function weightedAmountsMinor(amountMinor, weights = [], remainderTo = 0) {
  const n = weights.length;
  if (n <= 0) return [];
  const w = weights.map((x) => {
    const v = Math.round(Number(x));
    return Number.isFinite(v) && v >= 1 ? Math.min(v, 99) : 1;
  });
  const total = w.reduce((s, x) => s + x, 0);
  const sign = amountMinor < 0 ? -1 : 1;
  const abs = Math.abs(amountMinor);

  const out = w.map((x) => Math.floor((abs * x) / total));
  let rest = abs - out.reduce((s, x) => s + x, 0);
  // 從付款人那格開始發餘數，發完為止
  let i = Math.max(0, Math.min(n - 1, remainderTo));
  while (rest > 0) {
    out[i] += 1;
    rest -= 1;
    i = (i + 1) % n;
  }
  return out.map((x) => x * sign);
}

/**
 * 算出每一對人之間的債務關係。
 *
 * @param records   已確認的品項紀錄
 * @param opts.validIds 目前存在的人
 * @returns { [currency]: { [debtor]: { [creditor]: minorAmount } } }
 *          debtor 欠 creditor 多少（最小單位，未淨額化）
 */
export function rawDebts(records = [], { validIds = null } = {}) {
  const out = {};

  for (const r of records) {
    // 儲值不是消費（用現金儲 Suica，錢是變少了但那是她自己的卡）
    if (!isSpending(r)) continue;
    const amount = Number(r.amount);
    if (!Number.isFinite(amount) || amount === 0) continue;

    const payer = r.payer;
    if (!payer) continue;                       // 不知道誰付的，算不出誰欠誰

    const ids = sharesOf(r, validIds);
    if (ids.length <= 1 && ids[0] === payer) continue;   // 純自己的花費，沒有債務

    const currency = r.currency || 'JPY';
    const d = decimalsOf(currency);
    const amountM = toMinor(amount, d);

    // 餘數塞給付款人自己（鐵律 1）
    const payerIdx = ids.indexOf(payer);
    const parts = weightedAmountsMinor(amountM, weightsOf(r, ids), payerIdx >= 0 ? payerIdx : 0);

    const cur = (out[currency] ||= {});
    ids.forEach((who, i) => {
      if (who === payer) return;                // 自己那份不算欠自己
      const row = (cur[who] ||= {});
      row[payer] = (row[payer] || 0) + parts[i];
    });
  }

  return out;
}

/**
 * 已經還過的錢。
 *
 * @param settlements [{ from, to, amount, currency }] —— from 付給 to
 */
export function applySettlements(debts, settlements = []) {
  const out = JSON.parse(JSON.stringify(debts));
  for (const s of settlements) {
    const amount = Number(s?.amount);
    if (!s?.from || !s?.to || !Number.isFinite(amount) || amount === 0) continue;
    const currency = s.currency || 'JPY';
    const d = decimalsOf(currency);
    const cur = (out[currency] ||= {});
    const row = (cur[s.from] ||= {});
    row[s.to] = (row[s.to] || 0) - toMinor(amount, d);
  }
  return out;
}

/**
 * 兩個人之間互相欠來欠去 → 收成一個方向的淨額。
 *
 * A 欠 B ¥5,000、B 欠 A ¥2,000 → 結論是 A 欠 B ¥3,000，
 * 不要在畫面上同時列兩行讓她自己減。
 */
export function netPairs(debts) {
  const out = {};
  for (const [currency, byDebtor] of Object.entries(debts)) {
    const seen = new Set();
    const pairs = [];
    for (const [a, row] of Object.entries(byDebtor)) {
      for (const b of Object.keys(row)) {
        const key = a < b ? `${a}|${b}` : `${b}|${a}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const [x, y] = key.split('|');
        const net = (byDebtor[x]?.[y] || 0) - (byDebtor[y]?.[x] || 0);
        if (net === 0) continue;
        // 一律寫成「from 欠 to」
        pairs.push(net > 0 ? { from: x, to: y, amountM: net } : { from: y, to: x, amountM: -net });
      }
    }
    out[currency] = pairs;
  }
  return out;
}

/**
 * 結算頁要的東西 —— 從「我」的角度看。
 *
 * @param records      已確認的品項紀錄
 * @param settlements  已還款紀錄
 * @param meId         「我」是誰（通常是 p1）
 * @param people       [{id, name}]，用來過濾已刪掉的人並附上名字
 *
 * @returns {
 *   byCurrency: {
 *     [currency]: {
 *       rows: [{ personId, name, net, owesMe, iOwe }],   // net > 0 = 他欠我
 *       totalOwedToMe, totalIOwe,
 *       others: [{ from, fromName, to, toName, amount }] // 跟我無關的（別人之間）
 *     }
 *   },
 *   currencies: [...]                                     // 有債務的幣別
 * }
 */
export function settleUp({ records = [], settlements = [], meId = 'p1', people = [] } = {}) {
  const validIds = people.length ? people.map((p) => p.id) : null;
  const nameOf = (id) => people.find((p) => p.id === id)?.name || id;

  const pairs = netPairs(applySettlements(rawDebts(records, { validIds }), settlements));

  const byCurrency = {};
  for (const [currency, list] of Object.entries(pairs)) {
    const d = decimalsOf(currency);
    const mine = new Map();     // personId → 淨額（最小單位，正 = 他欠我）
    const others = [];

    for (const p of list) {
      if (p.to === meId) {
        mine.set(p.from, (mine.get(p.from) || 0) + p.amountM);
      } else if (p.from === meId) {
        mine.set(p.to, (mine.get(p.to) || 0) - p.amountM);
      } else {
        others.push({
          from: p.from, fromName: nameOf(p.from),
          to: p.to, toName: nameOf(p.to),
          amount: fromMinor(p.amountM, d),
        });
      }
    }

    const rows = [...mine.entries()]
      .filter(([, m]) => m !== 0)
      .map(([personId, m]) => ({
        personId,
        name: nameOf(personId),
        net: fromMinor(m, d),
        owesMe: m > 0 ? fromMinor(m, d) : 0,
        iOwe: m < 0 ? fromMinor(-m, d) : 0,
      }))
      // 欠我最多的排前面；我欠人的沉到最下面
      .sort((a, b) => b.net - a.net);

    const totalOwedToMeM = [...mine.values()].filter((m) => m > 0).reduce((s, m) => s + m, 0);
    const totalIOweM = [...mine.values()].filter((m) => m < 0).reduce((s, m) => s - m, 0);

    if (!rows.length && !others.length) continue;

    byCurrency[currency] = {
      rows,
      others,
      totalOwedToMe: fromMinor(totalOwedToMeM, d),
      totalIOwe: fromMinor(totalIOweM, d),
    };
  }

  return { byCurrency, currencies: Object.keys(byCurrency) };
}

/**
 * 這趟旅行裡，**真正屬於「我」的花費**是多少。
 *
 * 為什麼要單獨算：首頁的「總支出」是掏出去的錢（她的錢包確實少了那麼多），
 * 但那不等於她的花費——九人晚餐 ¥45,000 裡只有 ¥5,000 是她的。
 * 兩個數字都要有，而且**不可以混用**：
 *   · 現金錢包 / 還付不付得出來 → 用掏出去的錢
 *   · 這趟我花了多少 / 預算 → 用這一支
 *
 * @returns { [currency]: number }
 */
export function myShareTotals(records = [], { meId = 'p1', validIds = null } = {}) {
  const out = {};
  for (const r of records) {
    if (!isSpending(r)) continue;
    const amount = Number(r.amount);
    if (!Number.isFinite(amount) || amount === 0) continue;

    const ids = sharesOf(r, validIds);
    if (!ids.includes(meId)) continue;          // 這筆完全跟我無關（別人的花費，我只是代墊）

    const currency = r.currency || 'JPY';
    const d = decimalsOf(currency);
    const amountM = toMinor(amount, d);
    const payerIdx = ids.indexOf(r.payer);
    const parts = weightedAmountsMinor(amountM, weightsOf(r, ids), payerIdx >= 0 ? payerIdx : 0);
    const myPart = parts[ids.indexOf(meId)];

    out[currency] = (out[currency] || 0) + myPart;
  }
  for (const c of Object.keys(out)) out[c] = fromMinor(out[c], decimalsOf(c));
  return out;
}

/**
 * 把每一筆換成「**只有我那一份**」的樣子，其他欄位原樣保留。
 *
 * 為什麼需要這個投影：預算問的是「我這趟花了多少」，
 * 但 records 裡存的是**掏出去的錢**。九人晚餐 ¥45,000 記在她名下，
 * 直接拿去扣預算，等於把朋友的八份也算成她花掉了——
 * 預算會在第三天就見底，然後她開始不敢花錢。
 *
 * 完全不關她的事的那幾筆（她只是代墊）會被濾掉，不是留一筆 0。
 *
 * `amountHome` 按同一個比例縮——本位幣本來就是換算值，
 * 不需要（也不該）再走一次分帳的整數餘數規則。
 */
export function toMyShare(records = [], { meId = 'p1', validIds = null } = {}) {
  const out = [];
  for (const r of records) {
    const amount = Number(r.amount);
    if (!Number.isFinite(amount) || amount === 0) { out.push(r); continue; }

    const ids = sharesOf(r, validIds);
    // 沒有分帳（就是付款人自己）→ 原樣保留，不要動到任何舊資料的行為
    if (ids.length <= 1) { out.push(r); continue; }
    if (!ids.includes(meId)) continue;              // 純代墊，不是我的花費

    const currency = r.currency || 'JPY';
    const d = decimalsOf(currency);
    const payerIdx = ids.indexOf(r.payer);
    const parts = weightedAmountsMinor(toMinor(amount, d), weightsOf(r, ids), payerIdx >= 0 ? payerIdx : 0);
    const myAmount = fromMinor(parts[ids.indexOf(meId)], d);

    out.push({
      ...r,
      amount: myAmount,
      amountHome: r.amountHome == null ? r.amountHome : r.amountHome * (myAmount / amount),
      myShareOf: amount,          // 原本整筆多少，畫面上想講「你墊了 X」時用得到
    });
  }
  return out;
}
