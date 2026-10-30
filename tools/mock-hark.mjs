// 本地假 Hark 上游：只實作本專案會用到的端點，用來在 workerd 內做端到端驗證。
import { createServer } from 'node:http';

const PORT = Number(process.env.MOCK_PORT || 8799);
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const conversations = new Map();
const uploads = new Map();

function readBody(request) {
  return new Promise((resolve) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  response.end(body);
}

function authed(request) {
  const cookie = String(request.headers.cookie || '');
  const match = /__Secure-hark\.session_token=([^;]+)/.exec(cookie);
  return Boolean(match) && match[1] !== 'bad';
}

function isoAt(offsetMs) {
  return new Date(Date.now() + offsetMs).toISOString();
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://127.0.0.1:${PORT}`);
  const path = url.pathname;

  // 預簽章上傳（無需 cookie，模擬 S3）
  if (path.startsWith('/upload/')) {
    const key = path.slice('/upload/'.length);
    const body = await readBody(request);
    uploads.set(key, { bytes: body, contentType: request.headers['content-type'] || 'application/octet-stream' });
    response.writeHead(200, { ETag: '"mock"' });
    response.end();
    return;
  }

  if (!authed(request)) {
    sendJson(response, 401, { error: 'unauthorized' });
    return;
  }

  if (path === '/api/auth/get-session' && request.method === 'GET') {
    sendJson(response, 200, { user: { id: 'user_1', email: 'mock@example.com' } });
    return;
  }

  if (path === '/api/profile' && request.method === 'GET') {
    sendJson(response, 200, { email: 'mock@example.com', name: 'Mock User', nickname: 'mock' });
    return;
  }

  if (path === '/api/conversations' && request.method === 'POST') {
    const cid = `conv_${Math.random().toString(36).slice(2, 10)}`;
    conversations.set(cid, { order: [], messages: new Map(), polls: new Map() });
    sendJson(response, 200, { conversationId: cid });
    return;
  }

  if (path === '/api/messages/send' && request.method === 'POST') {
    const cid = url.searchParams.get('cid') || '';
    const conversation = conversations.get(cid);
    if (!conversation) {
      sendJson(response, 404, { error: 'conversation not found' });
      return;
    }
    const body = JSON.parse((await readBody(request)).toString() || '{}');
    const userMessageId = body.idempotencyKey;
    const assistantId = body.responseMessageId;
    conversation.messages.set(assistantId, {
      id: assistantId,
      role: 'assistant',
      source: 'agent',
      triggeredByMessageId: userMessageId,
      content: '',
      isStreaming: true,
      jobStatus: 'running',
      attachments: [],
      prompt: String(body.message || ''),
      hasInput: Array.isArray(body.attachments) && body.attachments.length > 0,
    });
    conversation.order.push(assistantId);
    conversation.polls.set(assistantId, 0);
    sendJson(response, 200, { success: true, messageId: userMessageId });
    return;
  }

  if (path === '/api/messages/history' && request.method === 'GET') {
    const cid = url.searchParams.get('conversationId') || '';
    const conversation = conversations.get(cid);
    if (!conversation) {
      sendJson(response, 404, { error: 'conversation not found' });
      return;
    }
    for (const [id, message] of conversation.messages) {
      const polls = (conversation.polls.get(id) ?? 0) + 1;
      conversation.polls.set(id, polls);
      if (polls < 2) {
        message.content = `生成中${'.'.repeat(polls)}`;
        message.isStreaming = true;
        message.jobStatus = 'running';
        continue;
      }
      message.isStreaming = false;
      message.jobStatus = 'completed';
      if (message.prompt.includes('IMAGE')) {
        message.content = '';
        message.attachments = [{
          id: `att_${id}`,
          name: 'hark-image.png',
          mediaType: 'image/png',
          size: PNG.length,
          downloadUrl: `/api/files/${cid}/att_${id}`,
        }];
      } else {
        message.content = `收到：${message.prompt}`;
      }
    }
    sendJson(response, 200, {
      messages: Object.fromEntries(conversation.messages),
      log: conversation.order.map((id) => ({ id })),
    });
    return;
  }

  if (path === '/api/billing/summary' && request.method === 'GET') {
    sendJson(response, 200, {
      plan: { name: 'hark pro' },
      meters: {
        harkTokens: {
          dailyLimit: 20,
          dailyUsed: 5,
          dailyResetsAt: isoAt(6 * 3600 * 1000),
          poolLimit: 500,
          poolUsed: 100,
          poolResetsAt: isoAt(10 * 86400 * 1000),
        },
      },
    });
    return;
  }

  const presign = /^\/api\/files\/upload\/([^/]+)\/presign$/.exec(path);
  if (presign && request.method === 'POST') {
    const body = JSON.parse((await readBody(request)).toString() || '{}');
    const attachmentId = `att_${Math.random().toString(36).slice(2, 10)}`;
    const s3Key = `uploads/${attachmentId}`;
    sendJson(response, 200, {
      upload_url: `http://127.0.0.1:${PORT}/upload/${s3Key}`,
      attachment_id: attachmentId,
      s3_key: s3Key,
      path: `files/${presign[1]}/${attachmentId}`,
      content_type: body.content_type,
    });
    return;
  }

  const finalize = /^\/api\/files\/([^/]+)\/([^/]+)\/finalize$/.exec(path);
  if (finalize && request.method === 'POST') {
    const body = JSON.parse((await readBody(request)).toString() || '{}');
    const stored = uploads.get(body.s3_key);
    sendJson(response, 200, {
      attachment_id: finalize[2],
      name: 'reference.png',
      media_type: 'image/png',
      size: stored?.bytes.length ?? 0,
      path: body.path,
      s3_key: body.s3_key,
    });
    return;
  }

  const download = /^\/api\/files\/([^/]+)\/([^/]+)$/.exec(path);
  if (download && request.method === 'GET') {
    response.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': PNG.length });
    response.end(PNG);
    return;
  }

  sendJson(response, 404, { error: `unhandled ${request.method} ${path}` });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`mock-hark listening on http://127.0.0.1:${PORT}`);
});