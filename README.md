# hark2api-node

把 Hark 網頁版的對話流程包成一支 OpenAI 相容的 HTTP API，跑在單一 Cloudflare Worker 上。

打進來的 `POST /v1/images/generations` 在後端其實是一次真實的網頁對話：送 prompt、盯著
對話歷史等圖出現、再把附件抓回來。這個專案的工作是把那段過程藏起來，讓外面看起來就是一個
普通的 API，並在同一個網址上附一個管理帳號、任務與媒體的控制台。

沒有伺服器要顧，沒有 R2 / D1 / KV，也沒有前端建置流程 —— 部署起來就是一支 Worker 加三種
Durable Object。

---

## 先讓它跑起來

```sh
npm install
npx wrangler deploy
npx wrangler secret put HARK2API_COOKIE   # 貼上 hark.com 的 cookie 標頭
npx wrangler secret put HARK2API_KEY      # 選填；不設等於任何拿到網址的人都能呼叫
```

部署完打開 `<worker>.<你的子域>.workers.dev`，那就是控制台，也是 API 的根路徑。

**第一件事不是打 API，是在控制台按一次「測試」。** 這是整包唯一沒被實測過的環節：上游
願不願意接受 Cloudflare 的出口 IP。如果它按網段封鎖，測試會一路 401/403，那就是出口的
問題，得另外掛 relay 或 Tunnel；程式不用改。

要加第二個帳號，在「帳號」頁貼 cookie 就好，它存進 Durable Object storage，重新部署不掉。

---

## 一次生成走哪條路

兩條路徑共用同一段執行邏輯 —— 送 prompt、盯對話歷史、收附件，都是 Runner 在做。
差別只在「誰在等結果」。

### 同步（`/v1/images/generations` 預設）

```json
{"model": "hark-image", "prompt": "黃昏的港口，水彩", "n": 1}
```

1. **驗身分。** 有設 `HARK2API_KEY` 就要求 `Authorization: Bearer …`，`/v1/*` 與
   `/admin/*` 都管；`/v1/media/*` 例外（瀏覽器 `<img>` 帶不了標頭）。
2. **驗欄位。** `n` 只能是 1（上游一次就回一張），`response_format` 只能是 `url` 或
   `b64_json`，其餘直接 422 —— 早點拒絕，比跑到一半才失敗好。
3. **挑帳號。** Core 依額度與健康度排序，把請求交給該帳號的 Runner DO。Runner 一個帳號
   一個實例、靠 promise 鏈排隊，所以同一份 cookie 永遠不會被兩個請求同時使用。
4. **在線上等。** Worker 直接讀 Runner 推回來的 SSE，一個 stage 一個 stage 往下走，
   收完才回應。客戶端只要還在等，這條連線就一直開著。

### 非同步（`"async": true`、`POST /v1/images/tasks`、`edits` 帶 `async=true`）

1. **建任務。** 產生 `task_` 加 20 位十六進位的 id，寫進 Core，狀態 `queued`。帶了
   `Idempotency-Key` 的話：同 key 同內容拿到同一個任務，同 key 不同內容回 409；
   排隊任務超過 `HARK2API_TASK_QUEUE_LIMIT`（預設 8）回 429。
2. **馬上回 202。** Task DO 把 prompt（或參考圖）收進自己的 storage，設一個 50 毫秒後
   的 alarm，Worker 就交差了。HTTP 連線關掉之後，工作還活著。
3. **alarm 醒來**，Task DO 向 Core 要候選帳號，逐一交給 Runner 執行；某個帳號回認證錯誤
   就標記它不健康、換下一個 —— 這是整條流程唯一的重試。
4. **Runner 操作上游。** 送 prompt 後每 `HARK2API_POLL_INTERVAL`（預設 1 秒）輪詢一次
   對話歷史；看到完成訊號再等 `HARK2API_SETTLE_SECONDS`（預設 1.5 秒），確認沒有後續
   片段才收工。
5. **收尾。** 附件寫進 Core 的媒體索引，任務轉 `completed`，順手把該帳號額度重查一次
   寫回，Task DO 清掉自己的暫存。
6. **之後才有人來問。** `GET /v1/images/tasks/{id}` 只是讀 Core 的狀態：
   `queued` → `processing` → `completed`／`failed`，附帶 `phase` 與 `progress`。
7. **取圖。** `GET /v1/media/{name}` 帶著同一份 cookie 回頭找上游，把位元組串流轉發，
   `Cache-Control: private, max-age=300`。

---

## 為什麼是這個形狀

四個都是被平台限制逼出來的，不是偏好：

**背景任務靠 alarm 續命。** `ctx.waitUntil` 在回應之後只給約 30 秒，而一次生成要一到
五分鐘（硬上限 900 秒）。所以非同步任務長成自己的 Task DO，狀態存在自己的 storage，
靠 alarm 一站一站往下跑。同步路徑則是反過來：讓請求自己掛著等，簡單，但慢的生成不適合。

**Runner 擋併發。** 同一份 cookie 同時開兩條對話會互相踩，而 Worker 沒有全域鎖。Durable
Object 天生單執行緒、單實例，於是「一個帳號一個 Runner」剛好就是那把鎖，不用自己寫 mutex。

**媒體不落地。** 圖片可能十幾 MB，塞進 storage 貴又慢。改成 `url` 指回 Worker，
需要時帶 cookie 回去上游串流轉發 —— 省掉物件儲存，也避開 Worker 的記憶體上限。

**狀態放在 DO。** 帳號、任務、媒體索引都是小顆、KV 形狀的資料，Core 與 Task 自己的
storage 就夠；不需要為持久化多開一個 D1 或 KV。

---

## 端點

| 方法 | 路徑 | 備註 |
| --- | --- | --- |
| `GET` | `/healthz` `/readyz` | 存活／就緒 |
| `GET` | `/v1/models` | `hark`、`hark-image` |
| `POST` | `/v1/chat/completions` | model 決定走文字還是出圖；`stream: true` 給 SSE |
| `POST` | `/v1/responses` | Responses API 形式 |
| `POST` | `/v1/images/generations` | 同步等結果，回 `url` 或 `b64_json` |
| `POST` | `/v1/images/edits` | multipart；`async=true` 轉背景任務 |
| `POST` | `/v1/images/tasks` | 直接建背景任務，回 202 |
| `GET` | `/v1/images/tasks/{id}` | 狀態：`queued` / `processing` / `completed` / `failed` |
| `GET` | `/v1/media/{name}` | 媒體代理，不驗 API key |
| `GET` | `/admin/status` | 服務資訊 |
| `GET` `POST` | `/admin/accounts` | 列表／新增 |
| `GET` | `/admin/accounts/export` | 匯出（`?ids=` 可選） |
| `PATCH` `DELETE` | `/admin/accounts/{id}` | 修改／刪除 |
| `POST` | `/admin/accounts/{id}/test` | 連通測試 |
| `POST` | `/admin/accounts/{id}/usage` | 重查額度 |
| `POST` | `/admin/style-prompt` | 從參考圖抽風格提示詞 |
| `GET` | `/admin/tasks` | 任務列表 |
| `POST` | `/admin/tasks/clear` | 清掉已結束的任務 |
| `DELETE` | `/admin/tasks/{id}` | 刪任務（執行中的回 409） |
| `GET` | `/admin/media` | 媒體列表 |
| `POST` | `/admin/media/cleanup` | 清索引 |
| `DELETE` | `/admin/media/{name}` | 刪單筆 |

```sh
curl https://<worker>.workers.dev/v1/images/generations \
  -H "Authorization: Bearer $HARK2API_KEY" \
  -H 'content-type: application/json' \
  -d '{"model":"hark-image","prompt":"黃昏的港口，水彩","n":1,"response_format":"url"}'
```

---

## 設定

| 變數 | 預設 | 作用 |
| --- | --- | --- |
| `HARK2API_COOKIE` | — | secret。一份 cookie 當一個虛擬帳號，不寫進 storage |
| `HARK2API_KEY` | 空 | secret。`/v1/*`、`/admin/*` 的 Bearer key |
| `HARK2API_UPSTREAM` | `https://hark.com` | 上游位址 |
| `HARK2API_CHAT_TIMEOUT` | `300` | 單次生成等待上限，秒，硬上限 900 |
| `HARK2API_REQUEST_TIMEOUT` | `30` | 上游單次請求逾時，秒 |
| `HARK2API_POLL_INTERVAL` | `1` | 輪詢歷史訊息的間隔，秒 |
| `HARK2API_SETTLE_SECONDS` | `1.5` | 完成訊號後的靜默期，用來避開半截訊息 |
| `HARK2API_TASK_QUEUE_LIMIT` | `8` | 同時排隊的任務上限 |
| `HARK2API_MAX_MEDIA_BYTES` | `20971520` | 參考圖上傳上限（20 MB） |
| `HARK2API_TIMEZONE` | `Asia/Shanghai` | 額度週期換算 |
| `HARK2API_LOCALE` | `zh-CN` | 上游請求語系 |
| `HARK2API_USER_AGENT` | 桌面 Chrome | 上游請求 UA |
| `HARK2API_PUBLIC_BASE` | 空 | 回傳 `url` 用的對外網域；空則用進來的 Host |

---

## 本機開發

```sh
npm test        # 起 workerd + 假上游，38 項端到端，不需要真 cookie
npm run dev     # 本地 Worker，上游是真的 hark.com，cookie 放 .dev.vars
```

`npm test` 跑的是 `test/e2e.mjs`，上游是 `tools/mock-hark.mjs`：OpenAI 端點與 SSE 串流、
`url` 與 `b64_json` 兩種回傳、真的走 alarm 的背景任務、Idempotency-Key 的重複與衝突、
multipart 編輯的同步與非同步、媒體代理的位元組完全一致、帳號 CRUD／測試／額度／匯出、
任務與媒體的清理。

改了 `public/favicon.svg` 之後跑 `./tools/build-icons.sh`，它會重新產生 `.ico`（16/32/48）
與 180×180 的 iOS 圖示，需要 `rsvg-convert` 和 ImageMagick。

---

## 邊界

- **上游可能擋 Cloudflare 的 IP。** 沒實測過，這是最大的未知。擋了就得換出口。
- **媒體不持久。** Worker 只是代理；上游刪檔或 cookie 過期，舊圖就讀不到。要永久保存得
  另外接 R2，在 `/v1/media/{name}` 加一個分支即可。
- **一張圖一次請求。** `n` 只能是 1。`mask`、`size` 沒有對應概念，給了回 422。
- **cookie 要自己續。** 過期不會自動處理，得回控制台換一份。
- **同步路徑會掛著連線等。** 生成慢的時候，請求會開著好幾分鐘；趕時間或要一次排很多張，
  走非同步端點。
- **免費方案 10 萬請求／日**，個人用足夠；多人共用請上付費方案。

---

## 檔案

| 檔案 | 內容 |
| --- | --- |
| `wrangler.jsonc` | Worker、三個 DO 與靜態資源的綁定 |
| `src/index.js` | 路由、驗證、OpenAI 請求與回應整形 |
| `src/hark.js` | 上游客戶端：fetch、cookie、歷史輪詢、SSE |
| `src/core.js` | Core DO：帳號池、任務索引、媒體索引、設定 |
| `src/runner.js` | Runner DO：每帳號一個，序列化生成 |
| `src/task.js` | Task DO：狀態機 + alarm |
| `src/state.js` | 額度查詢與回寫 |
| `src/util.js` | cookie / SSE 解析、額度整形、訊息判定 |
| `src/errors.js` | 錯誤型別與 OpenAI 錯誤格式 |
| `src/config.js` | 環境變數 → 設定 |
| `public/index.html` | 控制台，單檔 |
| `public/favicon.svg` | 標記原始檔，分頁圖示與 topbar 共用 |
| `public/favicon.ico` `public/apple-touch-icon.png` | 由上面的 SVG 產生的光柵版 |
| `tools/mock-hark.mjs` | 假上游 |
| `tools/build-icons.sh` | 重產 `.ico` 與 iOS 圖示 |
| `test/e2e.mjs` | 端到端測試 |