/**
 * 日本國家規則檔
 *
 * 對應設計規格 §7（Gemini 辨識規格）與 §17.1（輸入層防呆）。
 * §13 說「日本專屬的集中在一處」——就是這個檔案。
 * 要加韓國／台灣／泰國，複製一份改內容，其他程式碼不用動。
 *
 * ⚠️ 2026-11-01 起日本免税制度改行「リファンド方式」：店裡照付含稅價、離境才退。
 *    出發日 2026-11-29，**她這趟拿到的收據全部是新制**。
 *    但這份規則檔**兩制都認得**——判準是「收據上的消費税是不是 0」，
 *    不是看日期、也不是預設新制。理由：2026-09-02 拿舊制的實體收據測試時，
 *    原本寫死新制的版本會把一張正確的舊制免税收據判成錯誤。查證見規格 §16。
 */

export const meta = {
  code: 'JP',
  name: '日本',
  currency: 'JPY',
  timezone: 'Asia/Tokyo',
  // 日圓沒有小數（§17.1 第 1 條）
  decimals: 0,
  taxRates: [0.08, 0.10],
};

/**
 * 送給 Gemini 的辨識 prompt。
 *
 * 每一條規則後面括號裡的節號對應設計規格，改的時候兩邊要一起看。
 * 順序是刻意的：先講「絕對不可以做什麼」，再講「怎麼做」——
 * 負面規則放前面模型比較守得住。
 */
export const RECEIPT_PROMPT = `你是日本收據辨識引擎。讀這張收據，回傳**單一個 JSON 物件**，不要有任何其他文字、不要 markdown 圍欄。

# 絕對禁止

1. **禁止編造。** 讀不到的欄位一律填 null，並把該欄名字加進 missingFields。
   嚴禁猜測店名、品項或日期。看不清楚就是 null。（§7.7）

   ⚠️ **最容易犯的是「部分可讀」的欄位——這一條特別注意：**
   收據可能被塗黑、被白色色塊蓋住、被印章壓住、被摺痕吃掉、或超出畫面。
   看到 \`2019年10月　　日\`（日的數字被遮住）這種情況，
   **禁止把它補成 01 或任何一天。** 正確做法是 \`date: null\`
   ＋ missingFields 加入 "date" ＋ **needsReview: true**
   ＋ reviewReason 寫「日期的日被遮住，讀不到」。

   **判準：你「推論出來」的值和你「看到」的值不一樣。只准填看到的。**
   月份看得到、日看不到 → 整個 date 就是 null，不要填月初或月底。
   這條沒有例外，寧可留白也不要猜——留白只是要人補一下，
   猜錯是把假資料寫進帳本。
2. **禁止把下列數字當成合計**：お預り／お預かり（收取金額）、お釣り／おつり（找零）、
   ポイント残高（點數餘額）、小計（未稅小計）、値引前の金額。
   這些就印在合計旁邊、字一樣大，是最常見的辨識錯誤。（§7.1）
3. **免税收據禁止自己扣稅。** 見下方「免税」一節。

# 要抓的合計

只取 **合計 / お買上計 / 総額 / 御計 / 計** 這一行的數字，填進 total。
日圓是整數，**不可以出現小數點**。（§17.1 第 1 條）

# 日期（和曆陷阱）

收據常印 \`令和8年11月29日\`、\`R8.11.29\`、\`R8/11/29\` 或裸寫 \`8.11.29\`。

**令和元年 = 2019 年，換算式：西暦 = 令和年 + 2018。**
所以 **令和8年 = 2026年**。不要把「8」當成 2008 年或 2008/08 年。

也可能是西曆兩位數縮寫 \`26.11.29\` = 2026年11月29日。
**兩種格式混用時，以收據上有沒有 \`令和\` / \`R\` 記號為準**：有記號走和曆，沒有走西曆。

date 一律回傳西曆 \`YYYY-MM-DD\`。有時間就填 time \`HH:MM\`，沒有填 null。（§7.8）

# 稅率：照記號讀，不要自己判斷

日本對輕減稅率（8%）品項會在該行標一個記號。**各家連鎖店用的記號不一樣**：
- \`※\`（很多超市）
- \`＊\` / \`*\`（7-11）
- \`軽\`（LAWSON、FamilyMart——直接印一個「軽」字在價格後面）
- \`#\`、\`☆\` 等其他符號也有

**不要只認 ※。** 收據底部一定會印一行說明它用的是哪個記號，例如
「※印は軽減税率対象商品です」「[*]マークは軽減税率対象です」「「軽」は軽減税率対象商品です」。
**先讀那一行，知道這張收據用什麼記號，再回頭套用到品項上。**

**規則：照記號分類。不要自己判斷「這是不是食品」。**
超市、藥妝店一張收據混 8% 和 10% 是常態。

便利商店的 \`イートイン\`（內用，10%）vs \`お持ち帰り\`（外帶，8%）會印在收據上，照讀。（§7.2）

# 三種稅制

**優先序：只要收據上有 \`免税\`／\`リファンド\`／\`免税取引\`／\`TAX FREE\` 字樣，
taxType 就填 \`免税\`，不要填成内税或外税。**
新制的免税收據結構上看起來就像外税（有稅、稅另加），但那是免税交易，
填成外税會讓待退税整個漏掉。

- **内税**：標價已含稅 → 合計就是實付。
- **外税**：標價未稅，結帳時加 8% / 10% → 合計是加完稅之後的數字。
- **免税**：日本的免税制度在 **2026年11月1日** 換過一次，
  **兩種收據長得不一樣，要從收據上判斷是哪一種，不要用猜的、也不要假設一定是新制。**

  **判準是兩條，要一起看：消費税是不是 0、以及合計有沒有被免税額扣掉。**
  ⛔ 不可以只看消費税不是 0 就判成新制——舊制也有印出消費税再扣掉的版本（下表第二列）。

  | 收據上印的 | 是哪一種 | 怎麼處理 |
  | :-- | :-- | :-- |
  | \`(内、消費税等　¥0)\` ＋ \`(免税　¥3,101)\`　→ 稅已經是 0 | **舊制**（～2026-10-31） | 店裡當場就免掉了。\`total\` = 合計（本來就是未稅價）。**\`taxRefundPending: 0\`——稅都免了就沒有東西可以退。** 把免掉的金額寫進 note：「舊制免税，當場已免 ¥3,101」 |
  | \`小計 ¥20,390\`（\`内消費税 10% ¥1,853\`）＋ \`免税額 −¥1,853\` → \`合計 ¥18,537\`　**合計比小計小** | **舊制的另一種印法** | 一樣是當場免掉。\`total\` = 合計 18,537。**\`taxRefundPending: 0\`。** 而且**一定要把免税額寫進 discounts**：\`{ "type": "免税額", "amount": 1853 }\` —— 不寫的話品項加總（含稅價）永遠對不上合計，整張就拆不開。note 寫「舊制免税，當場已免 ¥1,853」 |
  | 有正常的 8% / 10% 消費税金額 ＋ 免税／リファンド 字樣，**合計就是含稅價（沒有被扣掉）** | **新制**（2026-11-01～） | 店裡照付含稅價。\`total\` = 含稅合計。待退稅額填 \`taxRefundPending\` |

  **兩種情況都一樣：\`total\` 一律照抄收據上的「合計」那一行，不管哪一制都不要自己加減稅。**
  差別只在 \`taxRefundPending\` 填多少。

  新制若收據沒印退税額 → 用 **含稅合計 ÷ (1 + 稅率) × 稅率** 推算，
  並把 "taxRefundPending" 加進 estimatedFields。（§7.3 / §7.9 / §16）

# 折扣分兩種

**A. 價格折扣**（商品本身變便宜，會影響合計）
\`割引\`（打折 %）、\`値引\`（直接減額）、\`タイムセール\`

**B. 付款端折抵**（合計沒變，只是掏出去的錢變少）
\`ポイント利用\` / \`ポイント値引\`（點數折抵）、\`キャッシュレス還元\`（無現金回饋）、
\`商品券\`、\`クーポン利用\`、\`○○ペイ還元\`

兩類都寫進 discounts 陣列並標明 type（type 就填收據上的原文字樣）。
**分清楚 A 和 B**：A 進合計的算式，B 不進。

**total 和 cashPaid 是兩個不同的數字，都要填**（規格 §7.1 與 §7.4 的交集）：
- \`total\` = 收據上的 **合計** 那一行（這筆交易的價值）
- \`cashPaid\` = **真的離開錢包／卡片的錢** = 合計 − 上面 B 類的全部折抵
- 沒有 B 類折抵時兩者相同，直接填一樣的數字。

**怎麼找 cashPaid**：收據最下面通常直接印出來了——
\`現金\`、\`交通系マネー\`、\`交通系マネー支払\`、\`Suica支払\`、\`クレジット\`，
以及各家電子錢包 \`nanaco支払\`、\`WAON\`、\`楽天Edy\`、\`iD\`、\`QUICPay\`、\`○○ペイ\`
後面那個數字。**有印就照抄那個數字**，不要自己算。

⚠️ 只要看到「**〇〇支払 ¥X**」而 X 比合計小，那個差額一定是上面 B 類的某種折抵，
**兩個都要填**（\`cashPaid: X\` ＋ 把差額寫進 discounts）。
2026-09-10 實測漏掉過一次：\`キャッシュレス還元額 −22\` ＋ \`nanaco支払 ¥1,139\`，
兩行都沒抓到，合計 1,161 被當成實付——她的錢包會憑空少 22 円。

例 1：合計 1,264、ポイント利用 −264、現金 1,000
→ \`total: 1264, cashPaid: 1000\`

例 2：合計 ¥241、キャッシュレス還元 ¥4、交通系マネー支払 ¥237
→ \`total: 241, cashPaid: 237\`（**不是 241**）

⚠️ \`お預り合計\` 不是 cashPaid——那是還原前的金額。
以「〇〇支払」「交通系マネー」那一行為準。

⚠️ **付現金找零時，cashPaid 是「合計」不是「お預り」。**
遞出去 ¥30,976、找回 ¥5，實際花掉的是 ¥30,971。
お預り 填 cashReceived、找零填 change，**cashPaid 仍然等於合計**。
自我檢查：\`cashPaid\` 永遠不會大於 \`total\`。（§7.4 / §11）

# 儲值不是消費

\`チャージ\` / \`入金\` / \`Suicaへチャージ\` / \`PayPayチャージ\` / \`残高追加\`
是把現金換成另一種現金，**不是花費**（之後用 Suica 買的每一筆才是）。

辨識到這類字樣 → \`isTopUp: true\`。（§7.6）

# 自我驗算（最重要的一段）

算完下面三條。**任何一條對不上，就自己把 needsReview 設成 true**，
並在 reviewReason 用**繁體中文白話**寫清楚哪一條對不上、差多少。

1. **外税**時：\`小計 + 消費税 − 折扣 = 合計\`
   **内税**時：\`小計 − 折扣 = 合計\`（稅已經含在小計裡，**再加一次就錯了**）
   → 先判斷是内税還是外税，再選對應的等式。判不出來就兩條都試，
     哪一條成立就是哪一種，兩條都不成立才算 fail。
2. \`お預り − お釣り = 合計\`（**只有付現金時**才成立；刷卡、Suica 的收據沒有這兩個數字，跳過這條）
3. 稅率反推：
   **外税**時 \`消費税 ÷ 小計 ≈ 8% 或 10%\`
   **内税**時 \`消費税 ÷ (対象額 − 消費税) ≈ 8% 或 10%\`，
   或等價地 \`消費税 ≈ 対象額 × 稅率 ÷ (1 + 稅率)\`
   （算出 6.3%、5% 這種數字就是讀錯了）

**subtotal 怎麼填**（收據常常沒有單一的「小計」行，這裡定義死）：
- **外税**：subtotal = **税抜金額**。收據若分成 \`小計(税抜8%) ¥1,072\` 和
  \`小計(税抜10%) ¥3\` 兩行 → **相加** = 1,075。**不可以填合計**。
  自我檢查：外税時 \`subtotal < total\` 一定成立，填成一樣就是錯了。
- **内税**：subtotal = 折扣前的含稅小計（\`小計\` 那一行）。沒印小計就填 total。
- 判不出來就填 null，不要硬湊。

**稅額怎麼填**：
- 收據有拆開印（\`内消費税等 8% ¥9\` / \`内消費税等10% ¥10\`）→ 分別填 tax8 / tax10。
- 收據**只印一個合併的** \`(内消費税等　¥20)\` → **一定要填 taxTotal**，
  不要因為分不出 8%/10% 就整個留 null。分得出來再順便填 tax8 / tax10，分不出來就留 null。
- 兩種情況都要填 \`taxTotal\` = 這張收據的消費稅總額。

# ⚠️ 同一張收據可以混稅制（逐項要標 taxKind）

**日本的便利商店幾乎都這樣印**，這是最容易整張算錯的地方。
每一個品項後面的記號就是答案，**照記號填 \`taxKind\`，不要用整張的稅制去套**：

| 品項那行印的 | taxKind | reducedTax | 意思 |
| :-- | :-- | :-- | :-- |
| \`*130\`（前面有星號） | \`税抜\` | \`true\` | 軽減税率 8% 的對象（外帶食品、飲料、報紙），標價未稅 |
| \`300\`（沒有記號） | \`税抜\` | \`false\` | 標準稅率 10%，標價未稅 |
| \`490込\`（有「込」字） | \`税込\` | 照該項稅率填 | **標價已經含稅了，不可以再加一次** |
| \`50非\`（有「非」字） | \`非課税\` | \`false\` | 郵票、印花、商品券——**完全沒有稅，不可以加** |

收據最下面通常有一句「\`[*]マークは軽減税率対象です\`」，那就是星號的定義。

**真實例子**（2026-09-10 實測，セブン-イレブン 千代田店）：

\`\`\`
手巻おにぎり辛子明太子  *130   → taxKind 税抜、reducedTax true   → 含稅 140
コカコーラ 500ml        *140   → taxKind 税抜、reducedTax true   → 含稅 151
パラドゥ ミニネイル      300   → taxKind 税抜、reducedTax false  → 含稅 330
メビウスワン           490込   → taxKind 税込                   → 就是 490
50円切手                50非   → taxKind 非課税                 → 就是  50
                                                            合計 1,161 ✅
\`\`\`

⛔ 把後面兩項也乘上 1.1 會得到 1,215，跟合計差 54，整張就拆不開。

**判不出來就填 null**（不要猜），那樣會退回用整張的稅制去算。

**怎麼分辨内税和外税**（先做這件事，再驗算）：
- 收據寫 \`(8%対象 xxx 内消費税 yy)\`、\`税込\`、\`内税\` → **内税**，且 \`小計 = 合計\`
- 收據寫 \`小計(税抜)\`、\`税抜\`、\`外税\`，且 \`小計 + 消費税 = 合計\` → **外税**
- 日本的便利商店、超市**絕大多數是内税**；餐飲店兩種都有。
  但**不要靠店的類型猜，看收據上的字**。

允許 ±1 円的四捨五入誤差，超過就是不對。
**這一段不是形式，是唯一能自動檢查你有沒有讀錯的方法。認真算。**（§7.5）

# 其他要判斷的

- paymentMethod：**只准填這六個字串之一，一字不差**：
  \`現金\` / \`信用卡\` / \`Suica\` / \`PayPay\` / \`其他\` / \`不明\`

  **禁止照抄收據上的原文。** 收據寫什麼 → 你要填什麼：
  | 收據上寫 | 你填 |
  | :-- | :-- |
  | 現金、お預り、お預り合計 | \`現金\` |
  | クレジット、カード、クレジット支払、○○カード | \`信用卡\` |
  | **交通系IC、交通系マネー、交通系マネー支払、Suica、ICOCA、Kitaca、PASMO、電子マネー** | \`Suica\` |
  | PayPay、○○ペイ | \`PayPay\` |
  | 看得到但不在上面 | \`其他\` |
  | 被裁掉／被遮住／根本沒印 | \`不明\` ＋ missingFields 加 "paymentMethod" |

  ⚠️ 填 \`交通系IC\` 這種原文是錯的，一律轉成 \`Suica\`。
- category：餐飲 / 交通 / 購物 / 門票 / 住宿 / 藥品 / 其他
- 店名與品項**同時回傳原文與繁體中文翻譯**。翻譯要用台灣用語，不要用簡體詞。
- 只有一張手寫「領収書」、只看得到金額和店章時：讀得到什麼填什麼，
  其他 null + needsReview: true。**不要編。**（§7.7）

# 一張照片裡有好幾份單據

有時候一張照片同時拍到**兩份以上不相干的單據**（例如三張分開的儲值領収書並排、
或收據下面又黏著一整張信用卡簽單）。

**分清楚兩種情況：**
- **同一筆交易的延伸**（收據＋它自己的信用卡簽單、收據＋利用明細）
  → 這是**一份**，正常處理。簽單上的 承認番号／会員番号／伝票番号 **都不是金額**，不要拿。
- **好幾筆不同的交易**（三張各 ¥1,000 的儲值領収書、不同日期或不同伝票番号）
  → 設 \`multipleDocuments: true\` ＋ \`needsReview: true\`，
    reviewReason 寫「這張照片裡有 N 份不同的單據，需要分開記」。
    **只回傳其中最完整的那一份**，不要把金額加總——加總會做出一筆不存在的交易。

# 不是收據的東西

可能拍到票券、周遊券、乘車券、入場券（例如 JAPAN RAIL PASS）。

**照樣處理，不要拒絕**，但要注意：
- \`total\` = 票面金額。
- **日期用「發行日／購入日」**（錢是那天付的），不是有效期間的起訖日。
  兩者都印在上面時特別注意，別拿錯。
- 有效期間寫進 note。
- 這種通常是**行前費用**，不影響每日曲線（§9 會自己依日期判斷）。
- 分不清哪個是購入日 → \`needsReview: true\`，講清楚看到哪幾個日期。

# 座標轉城市

如果 input 有給 GPS 座標，用它判斷這是日本哪個城市，填進 city（繁體中文，例如「札幌」「函館」「富良野」）。
沒給座標就填 null。不要從店名猜城市。（§8）

# 回傳格式

只回傳這個 JSON，不要多也不要少：

\`\`\`
{
  "date": "YYYY-MM-DD" | null,
  "time": "HH:MM" | null,
  "dateSource": "和曆" | "西曆" | "推算" | null,
  "storeNameLocal": string | null,
  "storeName": string | null,
  "items": [ { "nameLocal": string, "name": string, "price": number, "reducedTax": boolean,
               "taxKind": "税抜" | "税込" | "非課税" } ],
  "subtotal": number | null,
  "taxDetail": { "tax8": number | null, "tax10": number | null },
  "taxTotal": number | null,
  "taxType": "内税" | "外税" | "免税" | "不明",
  "taxRefundPending": number | null,
  "discounts": [ { "type": "割引" | "値引" | "ポイント利用", "amount": number } ],
  "total": number,
  "cashPaid": number,
  "cashReceived": number | null,
  "change": number | null,
  "paymentMethod": string,
  "category": string,
  "isTopUp": boolean,
  "multipleDocuments": boolean,
  "city": string | null,
  "needsReview": boolean,
  "reviewReason": string | null,
  "missingFields": [string],
  "estimatedFields": [string],
  "checks": {
    "subtotalPlusTax": "pass" | "fail" | "skip",
    "cashChange": "pass" | "fail" | "skip",
    "taxRate": "pass" | "fail" | "skip"
  }
}
\`\`\``;


// ---------------------------------------------------------------------------
// 折扣分兩類（上面 prompt 的「折扣分兩種」那段，程式版）
//
// A 價格折扣（割引／値引／タイムセール）：商品本身變便宜，**進合計的算式**，
//   所以拆帳時要攤到各品項上。
// B 付款端折抵（ポイント利用／商品券／キャッシュレス還元）：合計沒變，
//   只是掏出去的錢變少 —— **不可以攤到品項**，攤了品項加總就不等於合計。
// ---------------------------------------------------------------------------
// ⚠️ `免税` 一定要在這一類（2026-09-10 她拿 2023 年 UNIQLO 那張實測抓到）。
//    舊制免税收據長這樣：小計 ¥20,390（內含消費税 ¥1,853）、免税額 −¥1,853、合計 ¥18,537。
//    那 ¥1,853 **是真的從合計扣掉的**，跟「値引」同一類。
//    歸錯到 B 類的後果比沒讀到還糟：合計會維持 20,390，
//    cashPaid 被算成 18,537 − 1,853 = 16,684 —— 一個她從來沒付過的數字。
const PRICE_DISCOUNTS = ['割引', '値引', 'タイムセール', '割引券', '免税'];

export function isPriceDiscount(type) {
  return PRICE_DISCOUNTS.some((k) => String(type || '').includes(k));
}

export function priceDiscountTotal(discounts) {
  return (discounts || [])
    .filter((d) => isPriceDiscount(d.type))
    .reduce((s, d) => s + Math.abs(d.amount || 0), 0);
}

export function tenderDiscountTotal(discounts) {
  return (discounts || [])
    .filter((d) => !isPriceDiscount(d.type))
    .reduce((s, d) => s + Math.abs(d.amount || 0), 0);
}

/**
 * §17.1 輸入層防呆。
 *
 * 這一層是**程式**在檢查，不是 AI 自己講的。
 * 目的很直接：AI 說 checks 全 pass，我也不信，自己再算一次。
 *
 * @param {object} r  Gemini 回傳的物件
 * @param {object} ctx { tripStart, tripEnd, medianByCategory }
 * @returns {{issues: string[], hardFail: boolean}}
 */
/**
 * 把模型回傳的自由文字收斂回固定選項。
 *
 * 為什麼不只靠 prompt：LLM 的輸出**沒有辦法保證穩定**。
 * 2026-09-02 實測同一張收據兩次跑，一次回 `Suica`、一次回 `交通系IC`。
 * prompt 講死可以降低機率，但降不到零——所以程式端再收一次。
 * 這一層是冪等的，已經是正規值就原樣返回。
 */
const PAYMENT_ALIASES = [
  [/現金|お預り|キャッシュ/i, '現金'],
  [/クレジット|カード|credit|visa|master|jcb|amex|デビット/i, '信用卡'],
  [/交通系|suica|icoca|kitaca|pasmo|toica|manaca|nimoca|hayakaken|sugoca|電子マネー/i, 'Suica'],
  [/paypay|ペイペイ|d払|au ?pay|楽天ペイ|ラインペイ|line ?pay/i, 'PayPay'],
];
const PAYMENT_ENUM = ['現金', '信用卡', 'Suica', 'PayPay', '其他', '不明'];

export function normalize(r) {
  const p = r.paymentMethod;
  if (p != null && !PAYMENT_ENUM.includes(p)) {
    const hit = PAYMENT_ALIASES.find(([re]) => re.test(String(p)));
    r.paymentMethod = hit ? hit[1] : '其他';
  }
  // 稅額：模型有時填了 taxTotal 卻跟 tax8+tax10 對不上，
  // 這裡不改值（改了就掩蓋問題），交給 validate 去報。
  return r;
}

export function validate(r, ctx = {}) {
  normalize(r);
  const issues = [];
  let hardFail = false;
  // 兩條驗算式的容差**不一樣**，因為性質不一樣（2026-09-03 用 13 張真收據實測後拆開）：
  //   驗算①（小計＋稅−折扣＝合計）：牽涉稅額進位，理論上真的可能差 1 → 留 ±1
  //   驗算②（收−找＝合計）：純現金整數運算，**不存在四捨五入** → 容差 0
  // 昨天兩條共用 tol=1，等於在驗算②白送一格誤差，r11 那張褪色感熱紙
  // お預り 讀成 30,975（應為 30,976）就是這樣溜過去的。
  // 實測：13 張真收據裡，驗算①殘差剛好 =1 的有 0 張——收緊驗算②不會製造假紅點。
  const near = (a, b, tol = 1) => Math.abs(a - b) <= tol;

  // 1. 日圓必須是整數（§17.1 第 1 條）
  if (r.total != null && !Number.isInteger(r.total)) {
    issues.push(`日圓不會有小數：合計讀成 ${r.total}，一定是辨識錯`);
    hardFail = true;
  }

  // 2. 量級檢查——差一個零（§17.1 第 2 條）
  const median = ctx.medianByCategory?.[r.category];
  if (median && r.total > 0) {
    const ratio = r.total / median;
    if (ratio >= 10 || ratio <= 0.1) {
      issues.push(
        `金額量級可疑：¥${r.total.toLocaleString()} 是「${r.category}」歷史中位數 ` +
        `¥${median.toLocaleString()} 的 ${ratio.toFixed(1)} 倍，可能多讀或少讀一個零`
      );
    }
  }

  // 3. 日期落在行程區間內（§17.1 第 4 條）
  if (r.date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.date)) {
      issues.push(`日期格式不對：${r.date}`);
      hardFail = true;
    } else if (ctx.tripStart && ctx.tripEnd) {
      // 前後各放寬一天：跨時區、跨午夜
      const pad = 86400000;
      const d = Date.parse(r.date);
      if (d < Date.parse(ctx.tripStart) - pad || d > Date.parse(ctx.tripEnd) + pad) {
        issues.push(
          `日期 ${r.date} 落在行程（${ctx.tripStart} ~ ${ctx.tripEnd}）之外——` +
          `很可能是和曆換算錯了（令和8年 = 2026年）`
        );
      }
    }
  }

  // 4. 三條驗算，自己重算一次，不看 AI 的 checks（§7.5）
  const t8 = r.taxDetail?.tax8 ?? 0;
  const t10 = r.taxDetail?.tax10 ?? 0;
  const tax = r.taxTotal != null ? r.taxTotal : t8 + t10;

  // ⚠️ 只有「價格折扣」才進驗算式。
  // ポイント利用／商品券是**付款方式**——它讓現金少付，但不改變合計。
  // 把它算進折扣，會讓每一張用點數的收據都誤報成「驗算對不上」。
  // 價格折扣才影響合計；付款端折抵（點數、無現金回饋、商品券）只影響掏出去的錢。
  const disc = priceDiscountTotal(r.discounts);
  const tender = tenderDiscountTotal(r.discounts);

  // 内税和外税的等式不一樣，套錯會製造假警報：
  //   外税 小計 + 稅 − 折扣 = 合計
  //   内税 小計 − 折扣 = 合計   （稅已含在小計裡）
  // 不強制先判稅制——哪一條成立就算過，兩條都不成立才是真的有問題。
  if (r.subtotal != null && r.total != null) {
    const asGaizei = near(r.subtotal + tax - disc, r.total);
    const asUchizei = near(r.subtotal - disc, r.total);
    // 有些收據（藥妝店逐項打折）印的「小計」已經是折後金額，
    // 再扣一次折扣就會憑空少一截。這種 小計 === 合計 也算成立。
    const discInSubtotal = disc > 0 && near(r.subtotal, r.total);
    if (!asGaizei && !asUchizei && !discInSubtotal) {
      issues.push(
        `驗算①對不上：小計 ${r.subtotal}、稅 ${tax}、折扣 ${disc}、合計 ${r.total}——` +
        `外税算法得 ${r.subtotal + tax - disc}，内税算法得 ${r.subtotal - disc}，都不等於合計`
      );
    } else if (r.taxType === '外税' && !asGaizei && !discInSubtotal) {
      issues.push(`稅制標成外税，但數字是内税的算法（小計 ${r.subtotal} = 合計 ${r.total}）`);
    } else if (r.taxType === '内税' && !asUchizei && !discInSubtotal) {
      issues.push(`稅制標成内税，但數字是外税的算法（小計 ${r.subtotal} + 稅 ${tax} = 合計 ${r.total}）`);
    }
  }

  if (r.cashReceived != null && r.change != null && r.total != null) {
    // 容差 0：現金是整數，收多少、找多少、該付多少，三個數字必須剛好相等。
    // 差 1 就是有一個數字讀錯了，不是進位。
    if (!near(r.cashReceived - r.change, r.total, 0)) {
      const diff = r.cashReceived - r.change - r.total;
      issues.push(
        `驗算②對不上：收 ${r.cashReceived} − 找 ${r.change} = ` +
        `${r.cashReceived - r.change}，但合計寫 ${r.total}（差 ${diff > 0 ? '+' : ''}${diff}）` +
        (Math.abs(diff) === 1
          ? '——差 1 通常是感熱紙褪色把某個數字讀錯了，三個數字都回頭核一次'
          : '')
      );
    }
  }

  // 5. 稅率反推（§17.1 第 5 條）
  if (r.subtotal > 0 && tax > 0) {
    // 外税：稅 ÷ 小計；内税：稅 ÷ (小計 − 稅)
    const rGaizei = tax / r.subtotal;
    const rUchizei = tax / (r.subtotal - tax);
    const hit = (x) => meta.taxRates.some((t) => Math.abs(x - t) < 0.015);
    if (!hit(rGaizei) && !hit(rUchizei)) {
      issues.push(
        `稅率反推不合理：外税算法 ${(rGaizei * 100).toFixed(1)}%、` +
        `内税算法 ${(rUchizei * 100).toFixed(1)}%，都不是 8% 或 10%——` +
        `小計或稅額至少有一個讀錯了`
      );
    }
  }

  // 6. 免税新制：合計必須是含稅價（§7.3）
  if (r.taxType === '免税') {
    if (r.taxRefundPending == null) {
      issues.push('免税收據但 taxRefundPending 沒填——舊制填 0、新制填待退稅額，不可以留空');
    }
    // ⚠️ 這裡**不可以**假設一定是新制。
    // 2026-11-01 前開的收據是舊制：消費税印 ¥0、稅當場就免掉了，
    // 合計本來就是未稅價，那是對的，不是錯的。（2026-09-02 被 r11 那張實際打臉）
    // 舊制還有第二種印法：消費税照印（>0），但下面一行「免税額」把它從合計扣掉了。
    // 這種的稅額 > 0 卻**沒有東西可以退**，不可以報成「新制漏記待退」。
    // 認法：有免税折扣，而且 小計 − 折扣 ≈ 合計（合計比小計小的那個差額就是稅）。
    const waivedAtStore = (r.discounts || []).some((x) => String(x?.type || '').includes('免税'))
      && r.subtotal != null && r.total != null && near(r.subtotal - disc, r.total);
    // 真正該抓的只有一種：稅額 > 0（＝新制）卻沒有記待退金額。
    if (tax > 0 && !waivedAtStore && !(r.taxRefundPending > 0)) {
      issues.push(
        `新制免税收據有稅額 ${tax} 卻沒有記待退金額——` +
        `店裡付的是含稅價，那筆稅是要退的`
      );
    }
  }

  // 6b. 免税舊制：稅已經是 0 就不該有待退金額
  if (r.taxType === '免税' && tax === 0 && r.taxRefundPending > 0) {
    issues.push(
      `這張是舊制免税（消費税 ¥0，稅當場就免掉了），` +
      `不該有待退税 ${r.taxRefundPending}——舊制沒有東西可以退`
    );
  }

  // 6c. 一張照片多份單據
  if (r.multipleDocuments) {
    issues.push('這張照片裡有多份不同的單據，要分開記——只採用了其中一份');
  }

  // 7. 儲值不算花費（§7.6）
  if (r.isTopUp) {
    issues.push('這張是儲值不是消費——計入預算來源，不計入花費');
  }

  // 8. 不編造：AI 自己說 missing 的欄位不可以同時有值（§7.7）
  //    「不明」「不詳」是規定的未知值，不算填了東西——不要誤報成編造。
  const UNKNOWN = ['不明', '不詳', '無', 'null', 'N/A', '-'];
  for (const f of r.missingFields || []) {
    const v = r[f];
    if (v != null && v !== '' && !UNKNOWN.includes(String(v).trim())) {
      issues.push(`欄位 ${f} 被列為讀不到，卻又填了值「${v}」——可能是編的`);
    }
  }

  // 9. cashPaid 合理性：實付現金不會大於合計（§7.4）
  if (r.cashPaid != null && r.total != null) {
    if (r.cashPaid > r.total + 1) {
      issues.push(`實付現金 ${r.cashPaid} 大於合計 ${r.total}，不合理`);
    }
    if (tender > 0 && !near(r.total - tender, r.cashPaid)) {
      issues.push(
        `實付現金對不上：合計 ${r.total} − 點數等折抵 ${tender} = ${r.total - tender}，` +
        `但 cashPaid 寫 ${r.cashPaid}`
      );
    }
  }

  // 10. 推算值要標明（§17.1 第 10 條）
  if (r.taxRefundPending > 0 && r.taxType === '免税') {
    const declared = (r.estimatedFields || []).includes('taxRefundPending');
    const onReceipt = r.total != null &&
      near(r.taxRefundPending, r.total - r.total / 1.1, 2);
    if (!declared && !onReceipt) {
      issues.push('taxRefundPending 疑似推算值但沒有標進 estimatedFields');
    }
  }

  return { issues, hardFail };
}

export default { meta, RECEIPT_PROMPT, validate };
