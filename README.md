# hark2api-node

把 Hark 網頁版包成 **OpenAI 相容 API**，跑在 Cloudflare Workers 上。單一 Worker + 三個 Durable Object，前端是一頁式控制台，託管在同一支 Worker 的靜態資源裡 —— 沒有伺服器、沒有 R2 / D1 / KV、沒有建置流程。

- **OpenAI 相容**：`/v1/models`、`/v1/chat/completions`（含 SSE 串流）、`/v1/responses`、`/v1/images/generations`、`/v1/images/edits`
- **多帳號池**：輪替、每日／每月額度、停用、連通測試、匯出
- **長任務**：`/v1/images/tasks` 背景生成，靠 DO alarm 續跑，不受 30 秒請求限制
- **冪等**：`Idempotency-Key`
- **媒體代理**：出圖回 `url` 而不是 base64，Worker 帶 cookie 串流轉發
- **控制台**：`/` 開起來就是管理介面（帳號、試玩、任務、媒體、設定）

## 架構

```
Client ──► Worker  src/index.js
             ├── Static Assets   public/index.html（控制台）
             ├── Core   DO       帳號池、任務索引、媒體索引、設定
             ├── Runner DO       每帳號一個實例，序列化同帳號的生成
             └── Task   DO       一次生成 = 一個 DO，alarm 驅動、可查狀態
                        │
                        └──► https://hark.com   （fetch + Cookie）
```

### 為什麼長這樣

四個設計決定，都是被 Workers 的執行模型逼出來的：

1. **長任務用 DO `alarm()`**：請求回傳後 `waitUntil` 只剩約 30 秒，而一次生成要 1–5 分鐘。所以每個任務實例化成一個 `Task` DO，狀態寫進自己的 storage，靠 alarm 續命；`GET /v1/images/tasks/{id}` 只是讀狀態。
2. **同帳號序列化用 `Runner` DO**：Runner 借用 DO 的單執行緒語意，用 promise 鏈排隊，同帳號的生成天然不會並發打上游（同一個 session 併發會互相踩）。`HARK2API_TASK_QUEUE_LIMIT` 是單帳號排隊上限，超過回 429。
3. **媒體不落地**：`url` 指向 `/v1/media/{id}`，Worker 拿 cookie 回頭向上游串流轉發。省掉物件儲存，也避開「整包下載進記憶體」的 Worker 記憶體上限。
4. **狀態全在 DO storage**：帳號、任務、媒體索引都是小顆 KV 形狀的資料，`Core` / `Task` 自己的 storage 就夠，不必為了持久化多開 D1 或 KV。

## 檔案

| 檔案 | 內容 |
| --- | --- |
| `src/index.js` | Worker 入口：路由、驗證、OpenAI 請求／回應整形 |
| `src/hark.js` | 上游客戶端：fetch、Cookie、歷史訊息長輪詢、SSE 解析 |
| `src/core.js` | `Core` DO：帳號池、任務索引、媒體索引、設定 |
| `src/runner.js` | `Runner` DO：每帳號一個，序列化生成任務 |
| `src/task.js` | `Task` DO：任務狀態機 + alarm 續跑 |
| `src/state.js` | 額度查詢與回寫 |
| `src/util.js` | Cookie 解析、SSE 解析、額度整形、歷史訊息判定 |
| `src/errors.js` | `ApiError` + OpenAI 錯誤格式 |
| `src/config.js` | 環境變數 → 設定 |
| `public/index.html` | 控制台（單檔，無建置） |
| `tools/mock-hark.mjs` | 本地假上游，測試用 |
| `test/e2e.mjs` | 端到端測試 |

## 部署

```sh
cd hark2api-node
npm install
npx wrangler deploy
npx wrangler secret put HARK2API_COOKIE   # 貼 hark.com 的 cookie header
npx wrangler secret put HARK2API_KEY      # 建議設；不設等於任何人有網址就能呼叫
```

部署完 `<worker>.<subdomain>.workers.dev` 就是控制台。多個帳號在「帳號」頁貼 cookie 加入即可，存在 `Core` 的 storage，重新部署不會掉。

**部署後第一件事**：在控制台按一次「測試」，確認上游接受 Cloudflare 出口 IP。這是唯一沒辦法在本地驗證的變數 —— 若上游按 IP 段封鎖，會一路 401/403/5xx，那就得換成自架出口（Tunnel / Containers），程式本身不用改。

## 設定

| 變數 | 預設 | 說明 |
| --- | --- | --- |
| `HARK2API_COOKIE` | — | secret。單一 cookie，當成一個虛擬帳號，不寫入 storage |
| `HARK2API_KEY` | 空 | `/v1/*`、`/admin/*` 的 Bearer key；`/v1/media/*` 不驗（靠不可猜的 id） |
| `HARK2API_UPSTREAM` | `https://hark.com` | 上游位址 |
| `HARK2API_CHAT_TIMEOUT` | `300` | 單次生成等待上限（秒，最多 900） |
| `HARK2API_REQUEST_TIMEOUT` | `30` | 上游單次請求逾時（秒） |
| `HARK2API_POLL_INTERVAL` | `1` | 輪詢歷史訊息的間隔（秒） |
| `HARK2API_SETTLE_SECONDS` | `1.5` | 收到完成訊號後的靜默期，避免抓到半截訊息 |
| `HARK2API_TASK_QUEUE_LIMIT` | `8` | 單帳號同時排隊任務上限 |
| `HARK2API_MAX_MEDIA_BYTES` | `20971520` | 上傳參考圖上限（20MB） |
| `HARK2API_TIMEZONE` | `Asia/Shanghai` | 額度週期換算 |
| `HARK2API_LOCALE` | `zh-CN` | 上游請求語系 |
| `HARK2API_USER_AGENT` | Chrome UA | 上游請求 UA |
| `HARK2API_PUBLIC_BASE` | 空 | 回傳 `url` 用的對外網域；空則用請求的 host |

## API

| 方法 | 路徑 | 說明 |
| --- | --- | --- |
| GET | `/healthz` `/readyz` | 存活／就緒 |
| GET | `/v1/models` | 可用模型 |
| POST | `/v1/chat/completions` | model 決定走文字或出圖；`stream: true` 走 SSE |
| POST | `/v1/responses` | Responses API |
| POST | `/v1/images/generations` | `n` 只支援 1；`response_format` 可選 `url` / `b64_json` |
| POST | `/v1/images/edits` | multipart；`async=true` 轉背景任務 |
| POST | `/v1/images/tasks` | 建背景任務 |
| GET | `/v1/images/tasks/{id}` | 查任務 |
| GET | `/v1/media/{id}` | 媒體代理 |
| GET | `/admin/status` | 服務資訊 |
| GET/POST | `/admin/accounts` | 列表／新增 |
| GET | `/admin/accounts/export` | 匯出（`?ids=` 可選） |
| PATCH/DELETE | `/admin/accounts/{id}` | 改／刪 |
| POST | `/admin/accounts/{id}/test` | 連通測試 |
| POST | `/admin/accounts/{id}/usage` | 重新查額度 |
| POST | `/admin/style-prompt` | 從參考圖抽風格提示詞 |
| GET | `/admin/tasks` | 任務列表 |
| POST | `/admin/tasks/clear` | 清已完成任務 |
| DELETE | `/admin/tasks/{id}` | 刪任務 |
| GET | `/admin/media` | 媒體列表 |
| POST | `/admin/media/cleanup` | 清媒體索引 |
| DELETE | `/admin/media/{id}` | 刪媒體 |

```sh
curl https://<worker>.workers.dev/v1/images/generations \
  -H "Authorization: Bearer $HARK2API_KEY" \
  -H 'content-type: application/json' \
  -d '{"model":"gpt-image-1","prompt":"a cat astronaut, watercolor","n":1,"response_format":"url"}'
```

## 本地開發與測試

```sh
npm test        # 起 workerd + tools/mock-hark.mjs，端到端跑 38 項，不需要真 cookie
npm run dev     # 本地 Worker；上游仍是真 hark.com，cookie 放 .dev.vars
```

`npm test` 會覆蓋：OpenAI 端點（含 SSE 串流）、`url` / `b64_json` 兩種回傳、背景任務走真實 alarm、`Idempotency-Key`（重複 → 同任務，內容不同 → 409）、multipart 編輯（同步＋非同步）、媒體位元組完全一致、帳號 CRUD／測試／額度／匯出、任務與媒體清理。

## 已知限制

1. **上游 IP 封鎖**：見上面「部署後第一件事」。這是唯一未實測的外部變數。
2. `n` 只能是 1，其他值回 422。
3. `mask`、`size` 不支援，回 422（上游介面沒有對應概念）。
4. **媒體不持久**：Worker 只是代理，上游刪檔或 cookie 失效，舊圖就讀不到。要永久保存得另外接 R2，`/v1/media/{id}` 加一個分支即可。
5. **cookie 過期要手動更新**，沒有自動續期。
6. 免費方案每日 10 萬請求、每次請求 CPU 時間有限；個人用足夠，多人共用要上付費方案（$5/月起）。