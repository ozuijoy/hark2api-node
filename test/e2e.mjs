// 端到端測試：真的跑 workerd（wrangler dev）+ 假上游，逐項打 API。
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const PORT = 8788;
const MOCK_PORT = 8799;
const BASE = `http://127.0.0.1:${PORT}`;
const KEY = 'sk-test';
const WRANGLER = process.env.WRANGLER_BIN || '/app/user-packages/node/lib/node_modules/wrangler/bin/wrangler.js';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

let passed = 0;
const failures = [];

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function api(path, { key = KEY, ...init } = {}) {
  const headers = new Headers(init.headers || {});
  if (key) headers.set('Authorization', `Bearer ${key}`);
  return fetch(`${BASE}${path}`, { ...init, headers });
}

async function waitFor(check_, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await check_();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(500);
  }
  throw new Error(`timeout waiting: ${lastError?.message || 'condition'}`);
}

async function pollTask(id, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await api(`/v1/images/tasks/${id}`);
    const task = await response.json();
    if (task.status === 'completed' || task.status === 'failed') return task;
    await delay(400);
  }
  throw new Error(`task ${id} did not finish`);
}

const mock = spawn(process.execPath, ['tools/mock-hark.mjs'], {
  env: { ...process.env, MOCK_PORT: String(MOCK_PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: true,
});
mock.stdout.on('data', (chunk) => process.stdout.write(`[mock] ${chunk}`));

const PERSIST_DIR = `/tmp/h2a-e2e-state-${Date.now()}`;

const wrangler = spawn(process.execPath, [
  WRANGLER, 'dev', '--port', String(PORT), '--ip', '127.0.0.1',
  '--persist-to', PERSIST_DIR,
  '--var', `HARK2API_UPSTREAM:http://127.0.0.1:${MOCK_PORT}`,
  '--var', 'HARK2API_COOKIE:sess_test',
  '--var', `HARK2API_KEY:${KEY}`,
  '--var', 'HARK2API_POLL_INTERVAL:0.2',
  '--var', 'HARK2API_SETTLE_SECONDS:0.3',
  '--var', 'HARK2API_CHAT_TIMEOUT:60',
], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });

let wranglerLog = '';
wrangler.stdout.on('data', (chunk) => { wranglerLog += chunk; });
wrangler.stderr.on('data', (chunk) => { wranglerLog += chunk; });

function shutdown() {
  for (const child of [wrangler, mock]) {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
    }
  }
}

process.on('exit', shutdown);

try {
  console.log('waiting for workerd…');
  await waitFor(async () => {
    const response = await fetch(`${BASE}/healthz`);
    return response.ok;
  }, 120000);

  // ---- 基本端點
  const health = await (await api('/healthz')).json();
  check('healthz 回報 cookie 已設定', health.ok === true && health.cookie_configured === true, JSON.stringify(health));

  const ready = await api('/readyz');
  check('readyz 200', ready.status === 200);

  const index = await api('/', { key: null });
  const indexText = await index.text();
  check('首頁回傳後台 HTML', index.status === 200 && indexText.includes('<html'), `status=${index.status}`);

  const qr = await api('/docs/images/qq-group.png', { key: null });
  check('docs 靜態圖可讀', qr.status === 200 && (qr.headers.get('content-type') || '').includes('image/png'));

  const noKey = await api('/v1/models', { key: null });
  const noKeyBody = await noKey.json();
  check('缺少 API Key 時 401', noKey.status === 401 && noKeyBody.error?.type === 'authentication_error');

  const models = await api('/v1/models');
  const modelsBody = await models.json();
  check('models 回兩個模型', models.status === 200 && modelsBody.data?.length === 2 && modelsBody.data[0].id === 'hark');

  // ---- chat（非串流）
  const chat = await api('/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'hark', messages: [{ role: 'user', content: '你好' }] }),
  });
  const chatBody = await chat.json();
  check('chat 非串流回覆正確', chat.status === 200 && chatBody.choices?.[0]?.message?.content === '收到：你好', JSON.stringify(chatBody).slice(0, 200));

  // ---- chat（串流）
  const streamResponse = await api('/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'hark', messages: [{ role: 'user', content: '串流測試' }], stream: true }),
  });
  const streamText = await streamResponse.text();
  check('chat 串流有 delta 與 [DONE]', streamResponse.status === 200
    && streamText.includes('"role":"assistant"')
    && streamText.includes('串流測試')
    && streamText.includes('[DONE]'), streamText.slice(0, 300));

  // ---- responses
  const responses = await api('/v1/responses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'hark', input: 'RESP 測試' }),
  });
  const responsesBody = await responses.json();
  check('responses 非串流回 envelope', responses.status === 200
    && responsesBody.object === 'response'
    && responsesBody.output_text === '收到：RESP 測試', JSON.stringify(responsesBody).slice(0, 200));

  const respStream = await api('/v1/responses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'hark', input: 'RESP 串流', stream: true }),
  });
  const respStreamText = await respStream.text();
  check('responses 串流有事件序列', respStreamText.includes('event: response.created')
    && respStreamText.includes('event: response.output_text.delta')
    && respStreamText.includes('event: response.completed'));

  // ---- images/generations（url）
  const image = await api('/v1/images/generations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: 'IMAGE 一只貓', response_format: 'url' }),
  });
  const imageBody = await image.json();
  const imageUrl = imageBody.data?.[0]?.url;
  check('images/generations 回 url', image.status === 200 && typeof imageUrl === 'string' && imageUrl.includes('/v1/media/'), JSON.stringify(imageBody).slice(0, 200));

  const mediaResponse = await fetch(imageUrl);
  const mediaBytes = Buffer.from(await mediaResponse.arrayBuffer());
  check('媒體代理回傳 PNG 位元組', mediaResponse.status === 200
    && (mediaResponse.headers.get('content-type') || '').includes('image/png')
    && mediaBytes.equals(PNG), `${mediaResponse.status} ${mediaBytes.length}B`);

  // ---- images/generations（b64_json）
  const b64 = await api('/v1/images/generations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: 'IMAGE b64', response_format: 'b64_json' }),
  });
  const b64Body = await b64.json();
  check('images/generations 回 b64_json', b64.status === 200
    && Buffer.from(b64Body.data?.[0]?.b64_json || '', 'base64').equals(PNG));

  // ---- images/tasks（背景任務，走 DO alarm）
  const taskResponse = await api('/v1/images/tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'idem-1' },
    body: JSON.stringify({ prompt: 'IMAGE 排隊任務', response_format: 'url' }),
  });
  const queued = await taskResponse.json();
  check('建立任務回 202 與 queued', taskResponse.status === 202 && queued.status === 'queued' && queued.object === 'image.task',
    `status=${taskResponse.status} ${JSON.stringify(queued).slice(0, 200)}`);

  const reuse = await api('/v1/images/tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'idem-1' },
    body: JSON.stringify({ prompt: 'IMAGE 排隊任務', response_format: 'url' }),
  });
  const reused = await reuse.json();
  check('相同 Idempotency-Key 回同一個任務', reuse.status === 202 && reused.id === queued.id);

  const conflict = await api('/v1/images/tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'idem-1' },
    body: JSON.stringify({ prompt: 'IMAGE 不同內容', response_format: 'url' }),
  });
  check('Idempotency-Key 內容不同時 409', conflict.status === 409);

  const finished = await pollTask(queued.id);
  check('背景任務完成並回 data', finished.status === 'completed'
    && finished.data?.[0]?.url?.includes('/v1/media/')
    && Object.keys(finished).every((key) => !['request_hash', 'idempotency_key_hash', 'account_id'].includes(key)),
    JSON.stringify(finished).slice(0, 300));

  const finishedMedia = await fetch(finished.data[0].url);
  check('任務產物可下載', finishedMedia.status === 200);

  const missingTask = await api('/v1/images/tasks/task_not_exist');
  check('不存在的任務回 404', missingTask.status === 404);

  // ---- images/edits（同步 + 非同步）
  const form = new FormData();
  form.append('prompt', 'IMAGE 改圖');
  form.append('image', new Blob([PNG], { type: 'image/png' }), 'reference.png');
  form.append('response_format', 'url');
  const edit = await api('/v1/images/edits', { method: 'POST', body: form });
  const editBody = await edit.json();
  check('images/edits 同步回圖片', edit.status === 200 && editBody.data?.[0]?.url, JSON.stringify(editBody).slice(0, 200));

  const asyncForm = new FormData();
  asyncForm.append('prompt', 'IMAGE 非同步改圖');
  asyncForm.append('image', new Blob([PNG], { type: 'image/png' }), 'reference.png');
  asyncForm.append('async', 'true');
  const asyncEdit = await api('/v1/images/edits', { method: 'POST', body: asyncForm });
  const asyncEditBody = await asyncEdit.json();
  check('images/edits 非同步回 202', asyncEdit.status === 202 && asyncEditBody.status === 'queued',
    `status=${asyncEdit.status} ${JSON.stringify(asyncEditBody).slice(0, 200)}`);
  const asyncDone = await pollTask(asyncEditBody.id);
  check('非同步改圖完成', asyncDone.status === 'completed' && asyncDone.data?.[0]?.url, JSON.stringify(asyncDone).slice(0, 300));

  // ---- style-prompt
  const styleForm = new FormData();
  styleForm.append('image', new Blob([PNG], { type: 'image/png' }), 'ref.png');
  const style = await api('/admin/style-prompt', { method: 'POST', body: styleForm });
  const styleBody = await style.json();
  check('style-prompt 回提示詞', style.status === 200 && typeof styleBody.prompt === 'string' && styleBody.prompt.length > 0);

  // ---- 管理後台
  const status = await (await api('/admin/status')).json();
  check('admin/status 回服務資訊', status.service === 'hark2api-node'
    && status.upstream === `http://127.0.0.1:${MOCK_PORT}`
    && status.api_key_enabled === true
    && status.accounts.total >= 1
    && status.media.count > 0, JSON.stringify(status));

  const accounts = await (await api('/admin/accounts')).json();
  check('admin/accounts 列出環境帳號', accounts.accounts?.length === 1 && accounts.accounts[0].id === 'env');

  const tasksList = await (await api('/admin/tasks')).json();
  check('admin/tasks 有紀錄且不含私有欄位', tasksList.tasks.length >= 2
    && tasksList.tasks.every((task) => !('request_hash' in task) && !('account_id' in task)),
    `tasks=${tasksList.tasks.length}`);

  const doneTask = tasksList.tasks.find((task) => task.status === 'completed');
  const deleteTask = await api(`/admin/tasks/${doneTask.id}`, { method: 'DELETE' });
  check('admin 可刪除已完成任務', deleteTask.status === 200);

  const clear = await api('/admin/tasks/clear', { method: 'POST' });
  check('admin 可清空已完成任務', clear.status === 200);

  const media = await (await api('/admin/media')).json();
  check('admin/media 有項目且含 url/bytes', media.count > 0 && media.media[0].url.includes('/v1/media/'));

  const cleanup = await (await api('/admin/media/cleanup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ max_age_seconds: 1, dry_run: true }),
  })).json();
  const afterCleanup = await (await api('/admin/media')).json();
  check('media 清理 dry-run 只統計不刪檔', cleanup.dry_run === true
    && cleanup.removed > 0
    && afterCleanup.count === media.count, `dry=${cleanup.removed} before=${media.count} after=${afterCleanup.count}`);

  // ---- 新增帳號（持久化）→ 再刪除
  const addAccount = await api('/admin/accounts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label: '測試帳號', cookie_header: 'sess_second' }),
  });
  const added = await addAccount.json();
  check('新增帳號會驗證 profile', addAccount.status === 200 && added.profile?.email === 'mock@example.com', JSON.stringify(added).slice(0, 200));

  const afterAdd = await (await api('/admin/accounts')).json();
  check('新增後帳號數為 1（取代環境帳號）', afterAdd.accounts.length === 1 && afterAdd.accounts[0].id === added.id);

  const usageReady = await waitFor(async () => {
    const list = await (await api('/admin/accounts')).json();
    const account = list.accounts.find((item) => item.id === added.id);
    return account?.usage?.status === 'ready' ? account.usage : null;
  }, 30000);
  check('額度查詢寫回帳號', usageReady.plan === 'hark pro' && usageReady.daily?.left === '75%', JSON.stringify(usageReady).slice(0, 200));

  const badCookie = await api('/admin/accounts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cookie_header: 'bad' }),
  });
  check('錯誤 cookie 建帳號被拒（422）', badCookie.status === 422);

  const test = await (await api(`/admin/accounts/${added.id}/test`, { method: 'POST' })).json();
  check('帳號測試成功', test.ok === true);

  const exported = await (await api('/admin/accounts/export')).json();
  check('匯出含 cookie_header', exported.version === 1 && exported.accounts[0]?.cookie_header === 'sess_second');

  const deleted = await api(`/admin/accounts/${added.id}`, { method: 'DELETE' });
  check('刪除帳號成功', deleted.status === 200);

  const afterDelete = await (await api('/admin/accounts')).json();
  check('刪除後回退到環境帳號', afterDelete.accounts.length === 1 && afterDelete.accounts[0].id === 'env');
} catch (error) {
  failures.push(`未預期例外：${error?.stack || error}`);
  console.error(error);
} finally {
  shutdown();
  await delay(300);
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log('\n失敗項目：');
    for (const item of failures) console.log(` - ${item}`);
    console.log('\n--- wrangler log (tail) ---');
    console.log(wranglerLog.split('\n').slice(-40).join('\n'));
  }
  process.exit(failures.length ? 1 : 0);
}