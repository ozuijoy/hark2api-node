// Cloudflare Worker 入口：OpenAI 相容層 + 管理後台 API + 靜態資源
import { readConfig } from './config.js';
import { ApiError, respondError, statusForError } from './errors.js';
import { HarkClient, attachmentMarkdown } from './hark.js';
import { coreOp, currentAccount, recordMedia, refreshUsage, runnerStub } from './state.js';
import { bytesToBase64, sseChunk, sseEvent, sseEvents, sha256Bytes, sha256Hex, uuid } from './util.js';

export { Core } from './core.js';
export { Runner } from './runner.js';
export { Task } from './task.js';

const STYLE_EXTRACTION_PROMPT = `你是资深视觉设计师和图像生成提示词工程师。请分析用户上传的参考图，只提取可复用的视觉风格，不要描述具体主体、人物身份、物体名称、文字内容、品牌或故事情节。

请输出一段可以直接放在图像生成提示词开头的中文风格提示词，严格包含以下 7 行，每行一个维度，不要添加开场白、结尾解释、Markdown 代码块或编号：
视觉方向：艺术媒介、设计流派、整体气质与时代感
色彩系统：主色、辅助色、明度、饱和度、冷暖关系与调色倾向
光线氛围：光源方向、光质、对比度、阴影层次与空气感
材质质感：表面材质、纹理颗粒、笔触或渲染质感、细节锐度
构图镜头：构图秩序、留白、视角、焦段感、景别与视觉重心
空间层次：前中后景关系、景深、透视、尺度感与背景处理
后期控制：色彩分级、胶片或数字质感、清晰度、噪点、边缘与整体完成度

每一行写成紧凑但专业的短语组合，总长度控制在 500 个汉字以内。只保留图片中确实能观察到的风格特征，不臆造不存在的风格；如果图像混合多种风格，请提炼它们的共同视觉语言。输出内容要能自然衔接用户后续输入的主体和场景描述。`;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Expose-Headers': '*',
};

const now = () => Math.floor(Date.now() / 1000);

// ---------------------------------------------------------------- 請求工具

function withCors(response) {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(CORS_HEADERS)) headers.set(key, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function json(data, init = {}) {
  return Response.json(data, init);
}

async function jsonBody(request) {
  try {
    const value = await request.json();
    if (!value || typeof value !== 'object') throw new Error('not an object');
    return value;
  } catch {
    throw new ApiError(422, 'request validation failed');
  }
}

function baseUrl(request, config) {
  return config.publicBase || new URL(request.url).origin;
}

function authorize(config, request) {
  if (!config.apiKey) return;
  const header = request.headers.get('Authorization') ?? '';
  if (!header.toLowerCase().startsWith('bearer ')) {
    throw new ApiError(401, 'missing Authorization: Bearer <key>');
  }
  if (header.split(/\s+/)[1]?.trim() !== config.apiKey) {
    throw new ApiError(401, 'invalid API key');
  }
}

function contentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((item) => {
      if (typeof item === 'string') return item;
      if (item && typeof item.text === 'string') return item.text;
      return '';
    }).join('');
  }
  return content === null || content === undefined ? '' : String(content);
}

function buildPrompt(messages) {
  const blocks = [];
  for (const message of messages) {
    const text = contentText(message?.content).trim();
    if (text) blocks.push(`${String(message.role).toUpperCase()}:\n${text}`);
  }
  if (!blocks.length) throw new ApiError(422, 'messages must contain text');
  if (blocks.length === 1 && messages[0].role === 'user') return contentText(messages[0].content).trim();
  return `${blocks.join('\n\n')}\n\nASSISTANT:`;
}

function responsesPrompt(body) {
  const messages = [];
  if (body.instructions) messages.push({ role: 'system', content: body.instructions });
  const input = body.input ?? '';
  if (typeof input === 'string') {
    messages.push({ role: 'user', content: input });
  } else if (Array.isArray(input)) {
    for (const item of input) {
      if (typeof item === 'string') {
        messages.push({ role: 'user', content: item });
      } else if (item && item.role) {
        messages.push({ role: String(item.role), content: item.content });
      } else if (item && item.type === 'input_text') {
        messages.push({ role: 'user', content: item.text });
      } else if (item && item.type === 'function_call_output') {
        messages.push({ role: 'user', content: String(item.output ?? '') });
      }
    }
  }
  return buildPrompt(messages);
}

// ---------------------------------------------------------------- 帳號池執行（含容錯切換）

function eventStatus(kind) {
  if (kind === 'auth') return 401;
  return 502;
}

/**
 * 依序嘗試候選帳號；只在「還沒吐出任何內容」且是認證錯誤時換帳號。
 * yield 的事件：stage / delta / result（result 帶 accountId）
 */
async function* runEvents(env, params) {
  const { candidates } = await coreOp(env, 'pick', {});
  if (!candidates.length) throw new ApiError(401, 'no Hark account is configured');

  let lastError = null;
  let tried = 0;
  for (const account of candidates) {
    if (!String(account.cookie_header ?? '').trim()) continue;
    tried += 1;
    const response = await runnerStub(env, account.id).fetch('https://runner.internal/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        op: 'run',
        cookie: account.cookie_header,
        prompt: params.prompt,
        timeout: params.timeout,
        requireAttachment: params.requireAttachment === true,
        inputAttachment: params.inputAttachment ?? null,
      }),
    });
    if (!response.ok) {
      lastError = `runner HTTP ${response.status}`;
      continue;
    }

    let forwarded = 0;
    let failover = false;
    for await (const event of sseEvents(response)) {
      if (event.type === 'error') {
        if (forwarded === 0 && event.kind === 'auth') {
          lastError = event.error;
          await coreOp(env, 'mark', {
            id: account.id,
            ok: false,
            note: String(event.error ?? '').slice(0, 300),
          });
          failover = true;
          break;
        }
        throw new ApiError(eventStatus(event.kind), event.error ?? 'upstream error');
      }
      if (event.type === 'result') {
        await recordMedia(env, account.id, event.attachments ?? []);
        await coreOp(env, 'mark', { id: account.id, ok: true });
        await coreOp(env, 'used', { id: account.id });
        yield { ...event, accountId: account.id };
        return;
      }
      forwarded += 1;
      yield { ...event, accountId: account.id };
    }
    if (failover) continue;
    lastError = lastError || 'Hark stream ended without a result';
  }

  if (!tried) throw new ApiError(401, 'no Hark account is configured');
  throw new ApiError(401, lastError || 'no Hark account is available');
}

async function runCollect(env, params) {
  let result = null;
  for await (const event of runEvents(env, params)) {
    if (event.type === 'result') result = event;
  }
  if (!result) throw new ApiError(502, 'Hark finished without a visible response');
  return result;
}

function streamHeaders(extra = {}) {
  return {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-store',
    'X-Accel-Buffering': 'no',
    ...extra,
  };
}

function streamFrom(fn) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    async start(controller) {
      const write = (text) => {
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          /* 串流已關閉 */
        }
      };
      try {
        await fn(write);
      } finally {
        try {
          controller.close();
        } catch {
          /* 已關閉 */
        }
      }
    },
  });
}

// ---------------------------------------------------------------- 媒體與圖片整形

async function fetchMediaBytes(env, accountId, downloadUrl) {
  const account = await currentAccount(env, accountId);
  if (!account) throw new ApiError(502, 'Hark account is no longer available');
  const response = await runnerStub(env, accountId).fetch('https://runner.internal/op', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ op: 'media', cookie: account.cookie_header, downloadUrl }),
  });
  if (!response.ok) {
    throw new ApiError(response.status === 401 ? 401 : 502, `attachment download failed: HTTP ${response.status}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

async function imageData(env, images, prompt, format, base, accountId) {
  const usable = images.filter((item) => String(item.mediaType ?? '').startsWith('image/'));
  if (!usable.length) throw new ApiError(502, 'Hark did not return an image');
  const data = [];
  for (const image of usable) {
    const filename = String(image.filename ?? '');
    if (!filename || filename.includes('/')) throw new ApiError(502, 'Hark returned an invalid image filename');
    const item = { revised_prompt: prompt };
    if (format === 'b64_json') {
      const record = (await coreOp(env, 'mediaLookup', { name: filename })).media;
      if (!record?.downloadUrl) throw new ApiError(502, 'media record not found');
      item.b64_json = bytesToBase64(await fetchMediaBytes(env, record.accountId ?? accountId, record.downloadUrl));
    } else {
      item.url = `${base}/v1/media/${filename}`;
    }
    data.push(item);
  }
  return data;
}

function publicTask(task) {
  const output = { ...task };
  for (const key of ['request_hash', 'idempotency_key_hash', 'account_id']) delete output[key];
  return output;
}

async function taskResponse(env, task, base) {
  const format = String(task.response_format ?? 'url');
  const output = publicTask(task);
  if (task.status === 'completed') {
    output.data = await imageData(env, task.result?.images ?? [], String(task.prompt ?? ''), format, base, task.account_id);
  }
  return output;
}

function queueSummary(task) {
  return {
    id: task.id,
    task_id: task.id,
    object: 'image.task',
    status: task.status,
    progress: task.progress ?? null,
    progress_known: Boolean(task.progress_known),
    phase: task.phase ?? '排队中',
    created_at: task.created_at,
  };
}

// ---------------------------------------------------------------- 圖片任務排隊

async function queueImage(env, ctx, {
  prompt, timeout, responseFormat = 'url', idempotencyKey = null, attachment = null, kind = 'image',
}) {
  if (!['url', 'b64_json'].includes(responseFormat)) {
    throw new ApiError(422, 'response_format must be url or b64_json');
  }
  if (idempotencyKey && idempotencyKey.length > 256) throw new ApiError(400, 'Idempotency-Key too long');

  let inputMeta = null;
  if (attachment) {
    inputMeta = {
      filename: attachment.filename,
      media_type: attachment.mediaType,
      size: attachment.bytes.length,
      sha256: await sha256Bytes(attachment.bytes),
    };
  }
  const requestHash = await sha256Hex(JSON.stringify({
    input: inputMeta,
    prompt,
    response_format: responseFormat,
  }));
  const keyHash = idempotencyKey ? await sha256Hex(idempotencyKey) : null;

  const created = await coreOp(env, 'createTask', {
    kind,
    prompt,
    response_format: responseFormat,
    requestHash,
    keyHash,
  });

  if (created.status === 'conflict') throw new ApiError(409, 'Idempotency-Key reused with different request');
  if (created.status === 'full') throw new ApiError(429, 'image task queue is full');
  if (created.status === 'reused') return json(queueSummary(created.task), { status: 202 });

  const task = created.task;
  const stub = env.TASK.get(env.TASK.idFromName(task.id));
  await stub.fetch('https://task.internal/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      op: 'start',
      taskId: task.id,
      prompt,
      timeout: timeout ?? null,
      response_format: responseFormat,
      attachment: attachment
        ? {
          filename: attachment.filename,
          mediaType: attachment.mediaType,
          b64: bytesToBase64(attachment.bytes),
        }
        : null,
    }),
  });
  return json(queueSummary(task), { status: 202 });
}

// ---------------------------------------------------------------- 靜態資源

async function serveAsset(env, request, path) {
  const url = new URL(request.url);
  const assetUrl = new URL(path, url.origin);
  return env.ASSETS.fetch(new Request(assetUrl.toString(), request));
}

// ---------------------------------------------------------------- 路由

async function handle(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;
  const config = readConfig(env);
  const method = request.method;
  const base = baseUrl(request, config);

  // 頁面：/ 由靜態資源直接回應（index.html），/admin 導到同一個頁面
  if (path === '/admin' || path === '/admin/') return serveAsset(env, request, '/');
  if (path === '/favicon.ico') return new Response(null, { status: 204 });

  // 健康檢查
  if (path === '/healthz' && method === 'GET') {
    const { accounts } = await coreOp(env, 'snapshot', {});
    const cookieConfigured = accounts.some((account) => String(account.cookie_header ?? '').trim().length > 0);
    return json({ ok: true, service: 'hark2api-node', cookie_configured: cookieConfigured });
  }
  if (path === '/readyz' && method === 'GET') {
    const { accounts } = await coreOp(env, 'snapshot', {});
    if (!accounts.length) throw new ApiError(503, 'HARK2API_COOKIE is not configured and no account has been added');
    return json({ ok: true });
  }

  // 媒體代理不驗 API Key：靠不可猜的檔名，方便 <img>/下載直接取用
  const isApi = path.startsWith('/v1/') && !path.startsWith('/v1/media/');
  const isAdminApi = path.startsWith('/admin/');
  if (isApi || isAdminApi) authorize(config, request);

  if (path === '/v1/models' && method === 'GET') {
    const created = now();
    return json({
      object: 'list',
      data: [
        { id: 'hark', object: 'model', created, owned_by: 'hark' },
        { id: 'hark-image', object: 'model', created, owned_by: 'hark' },
      ],
    });
  }

  // ---- chat completions
  if (path === '/v1/chat/completions' && method === 'POST') {
    const body = await jsonBody(request);
    if (!Array.isArray(body.messages) || !body.messages.length) {
      throw new ApiError(422, 'messages must contain at least one message');
    }
    const model = String(body.model ?? 'hark');
    const prompt = buildPrompt(body.messages);
    const timeout = body.timeout ?? null;

    if (body.stream) {
      const id = `chatcmpl-${uuid()}`;
      const created = now();
      const chunk = (delta, finishReason = null) => sseChunk({
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      });
      return new Response(streamFrom(async (write) => {
        write(chunk({ role: 'assistant' }));
        let accountId = null;
        try {
          let text = '';
          for await (const event of runEvents(env, { prompt, timeout })) {
            if (event.type === 'delta') {
              text += event.text;
              write(chunk({ content: event.text }));
            } else if (event.type === 'result') {
              accountId = event.accountId;
              const markdown = attachmentMarkdown(event.attachments ?? [], base);
              if (markdown) write(chunk({ content: `${event.text ? '\n\n' : ''}${markdown}` }));
            }
          }
          write(chunk({}, 'stop'));
          write('data: [DONE]\n\n');
        } catch (error) {
          write(sseChunk({ error: { message: error?.message || String(error), type: 'server_error' } }));
        } finally {
          if (accountId) ctx.waitUntil(refreshUsage(env, accountId, { pending: false }).catch(() => {}));
        }
      }), { headers: streamHeaders() });
    }

    const result = await runCollect(env, { prompt, timeout });
    const parts = result.text ? [result.text] : [];
    const markdown = attachmentMarkdown(result.attachments ?? [], base);
    if (markdown) parts.push(markdown);
    return json({
      id: `chatcmpl-${uuid()}`,
      object: 'chat.completion',
      created: now(),
      model,
      choices: [{ index: 0, message: { role: 'assistant', content: parts.join('\n\n') }, finish_reason: 'stop' }],
    });
  }

  // ---- responses
  if (path === '/v1/responses' && method === 'POST') {
    const body = await jsonBody(request);
    const model = String(body.model ?? 'hark');
    const prompt = responsesPrompt(body);
    const timeout = body.timeout ?? null;
    const responseId = `resp_${uuid()}`;
    const messageId = `msg_${uuid()}`;
    const envelope = (status, text = '') => ({
      id: responseId,
      object: 'response',
      created_at: now(),
      status,
      model,
      output: [{
        type: 'message',
        id: messageId,
        role: 'assistant',
        status: status === 'completed' ? 'completed' : 'in_progress',
        content: text ? [{ type: 'output_text', text, annotations: [] }] : [],
      }],
      output_text: text,
    });

    if (body.stream) {
      return new Response(streamFrom(async (write) => {
        write(sseEvent('response.created', { type: 'response.created', response: envelope('in_progress') }));
        write(sseEvent('response.output_item.added', {
          type: 'response.output_item.added',
          output_index: 0,
          item: { id: messageId, type: 'message', role: 'assistant', status: 'in_progress', content: [] },
        }));
        write(sseEvent('response.content_part.added', {
          type: 'response.content_part.added',
          item_id: messageId,
          output_index: 0,
          content_index: 0,
          part: { type: 'output_text', text: '', annotations: [] },
        }));
        let full = '';
        let accountId = null;
        try {
          for await (const event of runEvents(env, { prompt, timeout })) {
            if (event.type !== 'delta') {
              if (event.type === 'result') accountId = event.accountId;
              continue;
            }
            full += event.text;
            write(sseEvent('response.output_text.delta', {
              type: 'response.output_text.delta',
              item_id: messageId,
              output_index: 0,
              content_index: 0,
              delta: event.text,
            }));
          }
          write(sseEvent('response.output_text.done', {
            type: 'response.output_text.done',
            item_id: messageId,
            output_index: 0,
            content_index: 0,
            text: full,
          }));
          write(sseEvent('response.output_item.done', {
            type: 'response.output_item.done',
            output_index: 0,
            item: {
              id: messageId,
              type: 'message',
              role: 'assistant',
              status: 'completed',
              content: [{ type: 'output_text', text: full, annotations: [] }],
            },
          }));
          write(sseEvent('response.completed', { type: 'response.completed', response: envelope('completed', full) }));
        } catch (error) {
          write(sseEvent('response.failed', { type: 'response.failed', response: envelope('failed') }));
        } finally {
          if (accountId) ctx.waitUntil(refreshUsage(env, accountId, { pending: false }).catch(() => {}));
        }
      }), { headers: streamHeaders() });
    }

    const result = await runCollect(env, { prompt, timeout });
    const parts = result.text ? [result.text] : [];
    const markdown = attachmentMarkdown(result.attachments ?? [], base);
    if (markdown) parts.push(markdown);
    return json(envelope('completed', parts.join('\n\n')));
  }

  // ---- images/generations
  if (path === '/v1/images/generations' && method === 'POST') {
    const body = await jsonBody(request);
    const prompt = String(body.prompt ?? '');
    if (!prompt) throw new ApiError(422, 'prompt must not be empty');
    const responseFormat = String(body.response_format ?? 'url');
    if (!['url', 'b64_json'].includes(responseFormat)) {
      throw new ApiError(422, 'response_format must be url or b64_json');
    }
    if (body.n !== undefined && Number(body.n) !== 1) {
      throw new ApiError(422, 'Hark supports one image per request');
    }
    if (body.async || body.async_ === true) {
      return queueImage(env, ctx, {
        prompt,
        timeout: body.timeout ?? null,
        responseFormat,
        idempotencyKey: request.headers.get('Idempotency-Key'),
      });
    }
    const result = await runCollect(env, { prompt, timeout: body.timeout ?? null, requireAttachment: true });
    ctx.waitUntil(refreshUsage(env, result.accountId, { pending: false }).catch(() => {}));
    return json({
      created: now(),
      data: await imageData(env, result.attachments ?? [], prompt, responseFormat, base, result.accountId),
    });
  }

  // ---- images/tasks（建立）
  if (path === '/v1/images/tasks' && method === 'POST') {
    const body = await jsonBody(request);
    const prompt = String(body.prompt ?? '');
    if (!prompt) throw new ApiError(422, 'prompt must not be empty');
    return queueImage(env, ctx, {
      prompt,
      timeout: body.timeout ?? null,
      responseFormat: String(body.response_format ?? 'url'),
      idempotencyKey: request.headers.get('Idempotency-Key'),
    });
  }

  // ---- images/tasks/{id}
  const taskMatch = /^\/v1\/images\/tasks\/([A-Za-z0-9_-]{1,64})$/.exec(path);
  if (taskMatch && method === 'GET') {
    const { task } = await coreOp(env, 'task', { id: taskMatch[1] });
    if (!task || task.kind !== 'image') throw new ApiError(404, 'image task not found');
    return json(await taskResponse(env, task, base));
  }

  // ---- images/edits（multipart）
  if (path === '/v1/images/edits' && method === 'POST') {
    let form;
    try {
      form = await request.formData();
    } catch {
      throw new ApiError(422, 'request validation failed');
    }
    const prompt = String(form.get('prompt') ?? '').trim();
    if (!prompt) throw new ApiError(422, 'prompt must not be empty');
    const responseFormat = String(form.get('response_format') ?? 'url');
    if (!['url', 'b64_json'].includes(responseFormat)) {
      throw new ApiError(422, 'response_format must be url or b64_json');
    }
    if (Number(form.get('n') ?? 1) !== 1) throw new ApiError(422, 'Hark supports one edited image per request');
    if (form.get('mask')) throw new ApiError(422, 'mask is not supported by Hark');
    if (form.get('size')) throw new ApiError(422, 'size is not supported by Hark');
    const attachment = await readUpload(form.get('image'), config);
    const timeoutRaw = form.get('timeout');
    const timeout = timeoutRaw ? Number(timeoutRaw) : null;
    if (timeout !== null && (!Number.isFinite(timeout) || timeout < 1 || timeout > 900)) {
      throw new ApiError(422, 'timeout must be between 1 and 900 seconds');
    }
    const asyncMode = String(form.get('async') ?? '').toLowerCase() === 'true';
    if (asyncMode) {
      return queueImage(env, ctx, {
        prompt,
        timeout,
        responseFormat,
        idempotencyKey: request.headers.get('Idempotency-Key'),
        attachment,
      });
    }
    const result = await runCollect(env, { prompt, timeout, requireAttachment: true, inputAttachment: attachment });
    ctx.waitUntil(refreshUsage(env, result.accountId, { pending: false }).catch(() => {}));
    return json({
      created: now(),
      data: await imageData(env, result.attachments ?? [], prompt, responseFormat, base, result.accountId),
    });
  }

  // ---- media（代理上游串流，不落地）
  const mediaMatch = /^\/v1\/media\/([A-Za-z0-9._-]{1,128})$/.exec(path);
  if (mediaMatch && method === 'GET') {
    const name = mediaMatch[1];
    if (name === '.' || name === '..' || name.startsWith('.')) throw new ApiError(404, 'media not found');
    const { media } = await coreOp(env, 'mediaLookup', { name });
    if (!media?.downloadUrl || !media.accountId) throw new ApiError(404, 'media not found');
    const account = await currentAccount(env, media.accountId);
    if (!account) throw new ApiError(404, 'media not found');
    const upstream = await runnerStub(env, media.accountId).fetch('https://runner.internal/op', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        op: 'media',
        cookie: account.cookie_header,
        downloadUrl: media.downloadUrl,
        mediaType: media.media_type,
      }),
    });
    if (!upstream.ok) throw new ApiError(404, 'media not found');
    const headers = new Headers(upstream.headers);
    headers.set('Cache-Control', 'private, max-age=300');
    return new Response(upstream.body, { status: 200, headers });
  }

  // ------------------------------------------------------------ 管理後台
  if (path === '/admin/status' && method === 'GET') {
    const { accounts } = await coreOp(env, 'snapshot', {});
    const { stats } = await coreOp(env, 'stats', {});
    const { media } = await coreOp(env, 'media', {});
    return json({
      service: 'hark2api-node',
      upstream: config.upstream,
      cookie_configured: accounts.some((account) => String(account.cookie_header ?? '').trim().length > 0),
      api_key_enabled: Boolean(config.apiKey),
      accounts: stats,
      media: {
        count: media.length,
        bytes: media.reduce((total, item) => total + Number(item.bytes ?? 0), 0),
      },
    });
  }

  if (path === '/admin/accounts' && method === 'GET') {
    return json(await coreOp(env, 'accounts', {}));
  }

  if (path === '/admin/accounts/export' && method === 'GET') {
    const ids = (url.searchParams.get('ids') ?? '').split(',').map((item) => item.trim()).filter(Boolean);
    const payload = await coreOp(env, 'export', { ids });
    return new Response(JSON.stringify(payload), {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Disposition': 'attachment; filename="hark2api-node-accounts.json"',
      },
    });
  }

  if (path === '/admin/accounts' && method === 'POST') {
    const body = await jsonBody(request);
    const cookie = String(body.cookie_header ?? '').trim();
    if (!cookie) throw new ApiError(422, 'cookie_header must not be empty');
    let profile;
    try {
      profile = await new HarkClient(config, cookie).getProfile();
    } catch (error) {
      if (error?.kind === 'auth') throw new ApiError(422, `账号验证失败，未添加：${error.message}`);
      throw new ApiError(502, `无法验证 Hark 账号：${error.message}`);
    }
    const { account } = await coreOp(env, 'add', { label: String(body.label ?? ''), cookie, profile });
    await coreOp(env, 'mark', { id: account.id, ok: true });
    await coreOp(env, 'usage', { id: account.id, usage: { status: 'loading', updated_at: now() } });
    ctx.waitUntil(refreshUsage(env, account.id, { pending: false }).catch(() => {}));
    const { accounts } = await coreOp(env, 'accounts', {});
    const found = accounts.find((item) => String(item.id) === String(account.id));
    const { cookie_header: _ignored, ...rest } = account;
    return json(found ?? rest);
  }

  const accountIds = /^\/admin\/accounts\/([A-Za-z0-9_-]{1,40})(\/(?:test|usage))?$/.exec(path);

  if (accountIds && method === 'PATCH' && !accountIds[2]) {
    const id = accountIds[1];
    if (id === 'env') throw new ApiError(422, 'the environment account is read-only');
    const body = await jsonBody(request);
    const fields = {};
    if (body.label !== undefined) fields.label = String(body.label);
    if (body.enabled !== undefined) fields.enabled = Boolean(body.enabled);
    if (body.cookie_header !== undefined) {
      const cookie = String(body.cookie_header ?? '').trim();
      if (!cookie) throw new ApiError(422, 'cookie_header must not be empty');
      let profile;
      try {
        profile = await new HarkClient(config, cookie).getProfile();
      } catch (error) {
        if (error?.kind === 'auth') throw new ApiError(422, `Cookie 验证失败，未更新：${error.message}`);
        throw new ApiError(502, `无法验证 Hark Cookie：${error.message}`);
      }
      fields.cookie_header = cookie;
      const { account } = await coreOp(env, 'update', { id, fields });
      if (!account) throw new ApiError(404, 'account not found');
      await coreOp(env, 'profile', { id, profile });
      await coreOp(env, 'mark', { id, ok: true });
      await coreOp(env, 'usage', { id, usage: { status: 'loading', updated_at: now() } });
      ctx.waitUntil(refreshUsage(env, id, { pending: false }).catch(() => {}));
      const { accounts } = await coreOp(env, 'accounts', {});
      return json(accounts.find((item) => String(item.id) === id) ?? account);
    }
    const { account } = await coreOp(env, 'update', { id, fields });
    if (!account) throw new ApiError(404, 'account not found');
    return json(account);
  }

  if (accountIds && method === 'DELETE' && !accountIds[2]) {
    const id = accountIds[1];
    const { deleted, virtual } = await coreOp(env, 'delete', { id });
    if (virtual) throw new ApiError(422, 'the environment account cannot be deleted');
    if (!deleted) throw new ApiError(404, 'account not found');
    return json({ ok: true, deleted: id });
  }

  if (accountIds && method === 'POST' && accountIds[2] === '/test') {
    const id = accountIds[1];
    const account = await currentAccount(env, id);
    if (!account) throw new ApiError(404, 'account not found');
    try {
      const profile = await new HarkClient(config, account.cookie_header).getProfile();
      await coreOp(env, 'profile', { id, profile });
      await coreOp(env, 'mark', { id, ok: true });
      return json({ ok: true, account_id: id, profile });
    } catch (error) {
      await coreOp(env, 'mark', { id, ok: false, note: String(error?.message ?? '').slice(0, 300) });
      return json({ ok: false, account_id: id, error: error?.message || String(error) });
    }
  }

  if (accountIds && method === 'POST' && accountIds[2] === '/usage') {
    const id = accountIds[1];
    const account = await currentAccount(env, id);
    if (!account) throw new ApiError(404, 'account not found');
    await refreshUsage(env, id);
    const { accounts } = await coreOp(env, 'accounts', {});
    return json(accounts.find((item) => String(item.id) === id) ?? {});
  }

  if (path === '/admin/style-prompt' && method === 'POST') {
    let form;
    try {
      form = await request.formData();
    } catch {
      throw new ApiError(422, 'request validation failed');
    }
    const attachment = await readUpload(form.get('image'), config);
    const result = await runCollect(env, {
      prompt: STYLE_EXTRACTION_PROMPT,
      timeout: Math.min(config.chatTimeout, 300),
      inputAttachment: attachment,
    });
    const prompt = String(result.text ?? '').trim();
    if (!prompt) throw new ApiError(502, 'Hark did not return a style prompt');
    ctx.waitUntil(refreshUsage(env, result.accountId, { pending: false }).catch(() => {}));
    return json({ prompt });
  }

  if (path === '/admin/tasks' && method === 'GET') {
    const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit') ?? 50) || 50, 200));
    const { tasks } = await coreOp(env, 'tasks', { limit });
    return json({ tasks: tasks.map(publicTask) });
  }

  if (path === '/admin/tasks/clear' && method === 'POST') {
    const { removed } = await coreOp(env, 'clearTasks', {});
    return json({ ok: true, removed });
  }

  const deleteTask = /^\/admin\/tasks\/([A-Za-z0-9_-]{1,64})$/.exec(path);
  if (deleteTask && method === 'DELETE') {
    const { task } = await coreOp(env, 'task', { id: deleteTask[1] });
    if (!task) throw new ApiError(404, 'task not found');
    if (['queued', 'processing'].includes(task.status)) throw new ApiError(409, 'cannot delete an active task');
    await coreOp(env, 'deleteTask', { id: deleteTask[1] });
    return json({ ok: true, deleted: deleteTask[1] });
  }

  if (path === '/admin/media' && method === 'GET') {
    const { media } = await coreOp(env, 'media', {});
    const items = media.map((item) => ({
      name: item.name,
      url: `${base}/v1/media/${item.name}`,
      bytes: Number(item.bytes ?? 0),
      mtime: Number(item.mtime ?? 0),
      kind: item.kind ?? 'image',
      media_type: item.media_type ?? 'application/octet-stream',
    }));
    return json({
      media: items,
      count: items.length,
      bytes: items.reduce((total, item) => total + item.bytes, 0),
    });
  }

  if (path === '/admin/media/cleanup' && method === 'POST') {
    const body = await jsonBody(request);
    const maxAgeSeconds = Number(body.max_age_seconds ?? 7 * 86400);
    if (!Number.isFinite(maxAgeSeconds) || maxAgeSeconds < 1) {
      throw new ApiError(422, 'max_age_seconds must be at least 1');
    }
    const { removed, bytes_removed } = await coreOp(env, 'cleanupMedia', {
      maxAgeSeconds,
      dryRun: Boolean(body.dry_run),
    });
    return json({
      ok: true,
      dry_run: Boolean(body.dry_run),
      removed,
      bytes_removed,
      errors: [],
    });
  }

  const deleteMedia = /^\/admin\/media\/([A-Za-z0-9._-]{1,128})$/.exec(path);
  if (deleteMedia && method === 'DELETE') {
    const name = deleteMedia[1];
    if (name.startsWith('.')) throw new ApiError(400, 'invalid media filename');
    const { deleted } = await coreOp(env, 'deleteMedia', { name });
    if (!deleted) throw new ApiError(404, 'media not found');
    return json({ ok: true, deleted: name });
  }

  // 其他路徑交給靜態資源（含 /docs/images/qq-group.png）
  return serveAsset(env, request, path);
}

async function readUpload(file, config) {
  if (!file || typeof file === 'string' || !file.size) throw new ApiError(422, 'image must be an image file');
  const mediaType = String(file.type || '').split(';')[0].toLowerCase();
  if (!mediaType.startsWith('image/')) throw new ApiError(422, 'image must be an image file');
  if (file.size > config.maxMediaBytes) throw new ApiError(413, 'image exceeds the configured size limit');
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length > config.maxMediaBytes) throw new ApiError(413, 'image exceeds the configured size limit');
  const filename = String(file.name || 'reference.png').split(/[\\/]/).pop() || 'reference.png';
  return { filename, mediaType, bytes };
}

export default {
  async fetch(request, env, ctx) {
    const path = new URL(request.url).pathname;
    if (request.method === 'OPTIONS') {
      return withCors(new Response(null, { status: 204, headers: CORS_HEADERS }));
    }
    try {
      const response = await handle(request, env, ctx);
      return withCors(response);
    } catch (error) {
      if (!(error instanceof ApiError) && statusForError(error) === 500) {
        console.error('unhandled error', error?.stack || error);
      }
      return withCors(respondError(path, error));
    }
  },
};