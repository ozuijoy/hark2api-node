# hark2api-node

[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![Durable Objects](https://img.shields.io/badge/Durable%20Objects-3%20classes-6b46c1)](https://developers.cloudflare.com/durable-objects/)
[![Node](https://img.shields.io/badge/node-%3E%3D20-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Tests](https://img.shields.io/badge/tests-38%20passed-brightgreen)](test/e2e.mjs)

`hark2api-node` 是部署於 Cloudflare Workers 的 API 閘道，將 Hark 網頁版的圖像生成流程
封裝為 OpenAI 相容的 HTTP 介面。服務以單一 Worker 執行，狀態由三個 Durable Object 管理，
不依賴 R2、D1 或 KV。同一個 Worker 亦提供靜態託管的網頁控制台，用於管理帳號、任務與媒體。

---

## 功能

- **OpenAI 相容端點**：`/v1/models`、`/v1/chat/completions`（支援 SSE 串流）、
  `/v1/responses`、`/v1/images/generations`、`/v1/images/edits`
- **多帳號池**：輪替、每日與每月額度、健康狀態、連通測試、設定匯出
- **非同步任務**：`/v1/images/tasks`，由 Durable Object alarm 驅動，不受 Worker 回應時限約束
- **冪等請求**：`Idempotency-Key`，相同鍵與相同內容回傳同一任務
- **媒體代理**：以 URL 形式回傳圖片，由 Worker 串流轉發，不寫入物件儲存
- **網頁控制台**：帳號管理、即時生成、任務與媒體檢視

---

## 架構

```
Client ──► Worker (src/index.js)
             ├── Static Assets   public/index.html
             ├── Core   DO       帳號池、任務索引、媒體索引、設定
             ├── Runner DO       每帳號一實例，序列化生成請求
             └── Task   DO       單次非同步任務，alarm 驅動
                        │
                        └──► hark.com（fetch + Cookie）
```

### 元件職責

| 元件 | 職責 | 採用理由 |
| --- | --- | --- |
| Worker | 路由、驗證、OpenAI 介面轉換、靜態資源 | 無狀態，可水平擴展 |
| Core DO | 帳號、任務、媒體索引與設定的唯一寫入點 | 需要跨請求共享且持久的小型狀態 |
| Runner DO | 單一帳號的序列化執行 | Durable Object 為單執行緒、單實例，天然提供每帳號互斥 |
| Task DO | 非同步任務狀態機 | `ctx.waitUntil` 於回應後僅有約 30 秒預算，長任務需 alarm |

### 請求流程

同步與非同步路徑共用 Runner 的執行邏輯，差異僅在等待結果的一方。

**同步路徑** — `POST /v1/images/generations`（預設）

1. 驗證 `Authorization: Bearer`；`/v1/media/*` 與靜態資源不驗證
2. 驗證欄位：`n` 必須為 1，`response_format` 必須為 `url` 或 `b64_json`，不符回傳 422
3. Core 依額度與健康狀態排序候選帳號，請求交由該帳號的 Runner 執行
4. Worker 讀取 Runner 的 SSE 事件流，完成後回應

**非同步路徑** — `async: true`、`POST /v1/images/tasks`、`edits` 搭配 `async=true`

1. 建立任務（`task_` 加 20 位十六進位），狀態 `queued`，回傳 202
2. Task DO 保存 prompt 與參考圖，設定 50 毫秒後的 alarm
3. alarm 觸發後向 Core 取得候選帳號並逐一執行；僅認證失敗時切換帳號
4. 依 `HARK2API_POLL_INTERVAL` 輪詢上游對話歷史，取得完成訊號後靜默
   `HARK2API_SETTLE_SECONDS`
5. 附件寫入媒體索引，任務轉為 `completed`，並重新查詢該帳號額度
6. `GET /v1/images/tasks/{id}` 讀取狀態；`GET /v1/media/{name}` 代理位元組，
   回應帶 `Cache-Control: private, max-age=300`

---

## 系統需求

| 項目 | 版本／說明 |
| --- | --- |
| Cloudflare 帳號 | Workers 免費方案即可 |
| Node.js | 20 以上 |
| Wrangler | 4.x（`devDependencies` 已列） |
| hark.com Cookie | 有效的登入工作階段 |

---

## 部署

```sh
npm install
npx wrangler secret put HARK2API_COOKIE   # 必要
npx wrangler secret put HARK2API_KEY      # 建議設定
npx wrangler deploy
```

`HARK2API_KEY` 未設定時，`/v1/*` 與 `/admin/*` 不驗證身分，任何取得網址者可呼叫。

部署完成後開啟 `<worker>.<subdomain>.workers.dev`，於控制台執行帳號的「測試」。

> **驗證步驟不可省略。** 上游是否接受 Cloudflare 出口 IP 尚未實測。若遭封鎖，帳號測試
> 會持續回傳 401／403，需改由自架出口（Tunnel 或 relay）轉發；程式本身無需修改。

新增帳號時，於控制台「帳號」頁貼上 Cookie 即可；資料存於 Core 的 storage，重新部署後保留。

---

## 設定

| 變數 | 預設 | 說明 |
| --- | --- | --- |
| `HARK2API_COOKIE` | — | Secret。單一 Cookie 視為一個虛擬帳號，不寫入 storage |
| `HARK2API_KEY` | 空 | Secret。`/v1/*` 與 `/admin/*` 的 Bearer key |
| `HARK2API_UPSTREAM` | `https://hark.com` | 上游位址 |
| `HARK2API_CHAT_TIMEOUT` | `300` | 單次生成等待上限（秒），硬上限 900 |
| `HARK2API_REQUEST_TIMEOUT` | `30` | 上游單次請求逾時（秒） |
| `HARK2API_POLL_INTERVAL` | `1` | 輪詢對話歷史的間隔（秒） |
| `HARK2API_SETTLE_SECONDS` | `1.5` | 完成訊號後的靜默期（秒），避免取得不完整訊息 |
| `HARK2API_TASK_QUEUE_LIMIT` | `8` | 同時排隊的任務上限 |
| `HARK2API_MAX_MEDIA_BYTES` | `20971520` | 參考圖上傳上限（20 MB） |
| `HARK2API_TIMEZONE` | `Asia/Shanghai` | 額度週期換算時區 |
| `HARK2API_LOCALE` | `zh-CN` | 上游請求語系 |
| `HARK2API_USER_AGENT` | 桌面版 Chrome | 上游請求 User-Agent |
| `HARK2API_PUBLIC_BASE` | 空 | 回傳 URL 使用的對外網域；未設定時採用請求 Host |

---

## API 參考

### OpenAI 相容端點

| 方法 | 路徑 | 說明 |
| --- | --- | --- |
| `GET` | `/v1/models` | 可用模型：`hark`、`hark-image` |
| `POST` | `/v1/chat/completions` | 依 model 決定文字或圖像；`stream: true` 回傳 SSE |
| `POST` | `/v1/responses` | Responses API 形式 |
| `POST` | `/v1/images/generations` | 同步生成；`async: true` 轉為任務 |
| `POST` | `/v1/images/edits` | `multipart/form-data`；`async=true` 轉為任務 |
| `POST` | `/v1/images/tasks` | 建立背景任務，回傳 202 |
| `GET` | `/v1/images/tasks/{id}` | 狀態：`queued`／`processing`／`completed`／`failed` |
| `GET` | `/v1/media/{name}` | 媒體代理，不驗證 API key |

### 管理端點

| 方法 | 路徑 | 說明 |
| --- | --- | --- |
| `GET` | `/healthz` `/readyz` | 存活與就緒檢查 |
| `GET` | `/admin/status` | 服務資訊 |
| `GET` `POST` | `/admin/accounts` | 列表／新增 |
| `GET` | `/admin/accounts/export` | 匯出；`?ids=` 可選 |
| `PATCH` `DELETE` | `/admin/accounts/{id}` | 修改／刪除 |
| `POST` | `/admin/accounts/{id}/test` | 連通測試 |
| `POST` | `/admin/accounts/{id}/usage` | 重新查詢額度 |
| `POST` | `/admin/style-prompt` | 由參考圖擷取風格提示詞 |
| `GET` | `/admin/tasks` | 任務列表 |
| `POST` | `/admin/tasks/clear` | 清除已結束任務 |
| `DELETE` | `/admin/tasks/{id}` | 刪除任務；執行中回傳 409 |
| `GET` | `/admin/media` | 媒體列表 |
| `POST` | `/admin/media/cleanup` | 清除媒體索引 |
| `DELETE` | `/admin/media/{name}` | 刪除單筆媒體 |

### 錯誤回應

| 狀態碼 | 情境 |
| --- | --- |
| `400` | `Idempotency-Key` 超過 256 字元 |
| `401` | 缺少或錯誤的 API key |
| `404` | 任務或媒體不存在 |
| `409` | `Idempotency-Key` 內容衝突；刪除執行中的任務 |
| `422` | 欄位驗證失敗：`n` 不為 1、`response_format` 非法、`prompt` 為空 |
| `429` | 任務佇列已滿 |
| `502` | 上游結束但未產生可見結果 |

---

## 使用範例

同步生成：

```sh
curl https://<worker>.workers.dev/v1/images/generations \
  -H "Authorization: Bearer $HARK2API_KEY" \
  -H 'content-type: application/json' \
  -d '{"model":"hark-image","prompt":"黃昏的港口，水彩","n":1,"response_format":"url"}'
```

非同步生成並輪詢：

```sh
curl https://<worker>.workers.dev/v1/images/tasks \
  -H "Authorization: Bearer $HARK2API_KEY" \
  -H 'content-type: application/json' \
  -d '{"prompt":"黃昏的港口，水彩"}'

curl https://<worker>.workers.dev/v1/images/tasks/<task_id> \
  -H "Authorization: Bearer $HARK2API_KEY"
```

串流對話：

```sh
curl -N https://<worker>.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer $HARK2API_KEY" \
  -H 'content-type: application/json' \
  -d '{"model":"hark","stream":true,"messages":[{"role":"user","content":"介紹這個 API"}]}'
```

任何支援自訂 `base_url` 的 OpenAI 客戶端皆可接入，將 `base_url` 指向
`https://<worker>.workers.dev/v1` 即可。

---

## 本機開發與測試

```sh
npm test        # workerd + 本地假上游，38 項端到端測試，無需真實 Cookie
npm run dev     # 本地 Worker，上游為真實 hark.com，Cookie 置於 .dev.vars
```

`npm test` 執行 `test/e2e.mjs`，上游為 `tools/mock-hark.mjs`，涵蓋：

- OpenAI 端點與 SSE 串流
- `url` 與 `b64_json` 兩種回傳格式
- 經由真實 alarm 觸發的背景任務
- `Idempotency-Key` 的重複與衝突行為
- `multipart` 編輯的同步與非同步模式
- 媒體代理的位元組一致性
- 帳號 CRUD、連通測試、額度與匯出
- 任務與媒體的清理

修改 `public/favicon.svg` 後執行 `./tools/build-icons.sh` 重新產生 `favicon.ico`
（16／32／48）與 180×180 的 iOS 圖示，需 `rsvg-convert` 與 ImageMagick。

---

## 專案結構

```
src/
  index.js     路由、驗證、OpenAI 介面轉換
  hark.js      上游 HTTP 客戶端（fetch、Cookie、歷史輪詢、SSE）
  core.js      Core DO：帳號池、任務索引、媒體索引、設定
  runner.js    Runner DO：每帳號一實例，序列化生成
  task.js      Task DO：任務狀態機與 alarm
  state.js     額度查詢與回寫
  util.js      Cookie／SSE 解析、額度整形、訊息判定
  errors.js    錯誤型別與 OpenAI 錯誤格式
  config.js    環境變數轉設定
public/
  index.html   控制台（單檔，無建置流程）
  favicon.svg  標記原始檔
tools/
  mock-hark.mjs     本地假上游
  build-icons.sh    圖示光柵化
test/
  e2e.mjs      端到端測試
wrangler.jsonc Worker、Durable Object 與靜態資源綁定
```

---

## 已知限制

| 限制 | 說明 |
| --- | --- |
| 上游 IP 未驗證 | 尚未確認上游是否封鎖 Cloudflare 出口 IP，部署後需執行帳號測試 |
| 媒體不持久 | Worker 僅代理；上游刪檔或 Cookie 失效後，既有 URL 無法存取。需要永久保存時可於 `/v1/media/{name}` 加入 R2 分支 |
| 單張輸出 | `n` 僅支援 1；`mask` 與 `size` 無對應概念，回傳 422 |
| Cookie 需手動更新 | 過期不會自動續期，需於控制台替換 |
| 同步請求佔用連線 | 生成期間連線維持開啟，長時間或大量生成建議使用非同步端點 |
| 免費方案額度 | 每日 10 萬次請求；多人共用建議升級付費方案 |

---

## 授權

本專案未附授權條款。