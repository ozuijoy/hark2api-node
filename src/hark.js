// Hark 上游 HTTP 客戶端：fetch + 手動 Cookie，長輪詢歷史訊息
import {
  HarkAuthError,
  HarkError,
  HarkGenerationError,
  HarkNetworkError,
} from './errors.js';
import {
  buildCookieHeader,
  extensionFor,
  parseBillingSummary,
  parseCookieHeader,
  replyAttachments,
  replyMessages,
  replyStage,
  replyTerminal,
  replyText,
  sleep,
  uuid,
} from './util.js';

export class HarkClient {
  constructor(config, cookieInput) {
    this.config = config;
    this.upstream = config.upstream;
    this.apiBase = `${this.upstream}/api/`;
    this.cookieHeader = buildCookieHeader(cookieInput ?? '');
    this.cookieCount = Object.keys(parseCookieHeader(cookieInput ?? '')).length;
    this.headers = {
      Accept: 'application/json, text/plain, */*',
      'User-Agent': config.userAgent,
      Origin: this.upstream,
      Referer: `${this.upstream}/`,
      'X-Hark-Locale': config.locale,
      Cookie: this.cookieHeader,
    };
  }

  url(path) {
    return new URL(path.replace(/^\/+/, ''), this.apiBase).toString();
  }

  async requestJson(method, path, { json, params, timeout, raw } = {}) {
    const target = new URL(this.url(path));
    for (const [key, value] of Object.entries(params ?? {})) {
      if (value !== undefined && value !== null) target.searchParams.set(key, String(value));
    }
    const headers = { ...this.headers };
    let body;
    if (json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(json);
    } else if (raw !== undefined) {
      body = raw;
    }

    let response;
    try {
      response = await fetch(target.toString(), {
        method,
        headers,
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(Math.round((timeout ?? this.config.requestTimeout) * 1000)),
      });
    } catch (error) {
      if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
        throw new HarkNetworkError('Hark request timed out');
      }
      throw new HarkNetworkError(`Hark request failed: ${error?.name || 'TypeError'}`);
    }

    if (response.status === 401 || response.status === 403) {
      throw new HarkAuthError('Hark session is not authenticated or has expired');
    }
    if (response.status >= 300 && response.status < 400) {
      throw new HarkAuthError('Hark redirected the API request; refresh the cookie');
    }
    if (response.status >= 400) {
      const detail = (await response.text()).trim().replace(/\s+/g, ' ').slice(0, 240);
      throw new HarkError(`Hark API HTTP ${response.status}: ${detail || 'upstream error'}`);
    }
    let data;
    try {
      data = await response.json();
    } catch {
      throw new HarkError('Hark returned a non-JSON response');
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new HarkError('Hark returned an unexpected JSON response');
    }
    return data;
  }

  async getUserId() {
    const data = await this.requestJson('GET', '/auth/get-session');
    const userId = data?.user?.id;
    if (!userId) throw new HarkAuthError('Hark session did not contain a user');
    return String(userId);
  }

  async getProfile() {
    const data = await this.requestJson('GET', '/profile');
    const email = String(data?.email ?? '').trim();
    if (!email) throw new HarkAuthError('Hark profile did not contain an email');
    return {
      email,
      name: String(data?.name ?? '').trim(),
      nickname: String(data?.nickname ?? '').trim(),
    };
  }

  async createConversation() {
    const data = await this.requestJson('POST', '/conversations', {
      json: { title: '未命名项目', timezone: this.config.timezone, autoTitle: true },
    });
    const conversationId = data?.conversationId;
    if (!conversationId) throw new HarkError('Hark did not return a conversation id');
    return String(conversationId);
  }

  async sendMessage(conversationId, prompt, userId, attachments = null) {
    const messageId = crypto.randomUUID();
    const payload = {
      timezone: this.config.timezone,
      conversationId,
      message: prompt,
      idempotencyKey: messageId,
      responseMessageId: crypto.randomUUID(),
      expectedUserId: userId,
    };
    if (attachments?.length) payload.attachments = attachments;
    const data = await this.requestJson('POST', '/messages/send', {
      json: payload,
      params: { cid: conversationId },
    });
    if (data?.success === false) throw new HarkGenerationError('Hark rejected the message');
    return String(data?.messageId || messageId);
  }

  async uploadAttachment(conversationId, bytes, filename, mediaType) {
    if (bytes.length > this.config.maxMediaBytes) {
      throw new HarkGenerationError('input attachment exceeds the configured size limit');
    }
    const safeName = String(filename || 'attachment').split(/[\\/]/).pop() || 'attachment';
    const type = String(mediaType || 'application/octet-stream').split(';')[0].trim().toLowerCase();

    const presigned = await this.requestJson('POST', `/files/upload/${conversationId}/presign`, {
      json: { filename: safeName, content_type: type, size: bytes.length },
    });
    const uploadUrl = presigned?.upload_url;
    if (typeof uploadUrl !== 'string' || !/^https?:\/\//.test(uploadUrl)) {
      throw new HarkGenerationError('Hark did not return a valid attachment upload URL');
    }

    let uploaded;
    try {
      uploaded = await fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': String(presigned.content_type || type) },
        body: bytes,
        signal: AbortSignal.timeout(Math.max(this.config.requestTimeout, 60) * 1000),
      });
    } catch (error) {
      throw new HarkNetworkError(`attachment upload failed: ${error?.name || 'TypeError'}`);
    }
    if (uploaded.status >= 400) {
      await uploaded.body?.cancel().catch(() => {});
      throw new HarkError(`attachment upload failed: HTTP ${uploaded.status}`);
    }
    await uploaded.body?.cancel().catch(() => {});

    const attachmentId = presigned.attachment_id;
    const s3Key = presigned.s3_key;
    const path = presigned.path;
    if (![attachmentId, s3Key, path].every((value) => typeof value === 'string' && value)) {
      throw new HarkGenerationError('Hark returned incomplete attachment metadata');
    }
    const finalized = await this.requestJson('POST', `/files/${conversationId}/${attachmentId}/finalize`, {
      json: { s3_key: s3Key, path },
    });
    return {
      attachment_id: finalized?.attachment_id || attachmentId,
      name: finalized?.name || safeName,
      media_type: finalized?.media_type || type,
      size: finalized?.size || bytes.length,
      path: finalized?.path || path,
      s3_key: finalized?.s3_key || s3Key,
      kind: 'file',
    };
  }

  async getHistory(conversationId) {
    return this.requestJson('GET', '/messages/history', {
      params: { conversationId, v: '2' },
    });
  }

  async queryUsage(timeout) {
    const summary = await this.requestJson('GET', '/billing/summary', {
      timeout: timeout ?? this.config.requestTimeout,
    });
    return parseBillingSummary(summary, this.config.timezone);
  }

  /** 附件不再落地到本機，改為保留上游 URL 由 Worker 代理串流 */
  attachmentRecord(attachment) {
    const downloadUrl = attachment?.downloadUrl;
    if (typeof downloadUrl !== 'string' || !downloadUrl.startsWith('/api/files/')) {
      throw new HarkGenerationError('Hark returned an invalid attachment URL');
    }
    const mediaType = String(attachment?.mediaType || 'application/octet-stream').split(';')[0];
    const extension = extensionFor(mediaType, attachment?.name);
    return {
      filename: `${uuid()}${extension}`,
      name: String(attachment?.name || 'attachment'),
      mediaType,
      size: Number(attachment?.size) || 0,
      downloadUrl,
    };
  }

  /** 代理下載：直接回傳上游的串流 Response */
  async fetchMedia(downloadUrl) {
    if (typeof downloadUrl !== 'string' || !downloadUrl.startsWith('/api/files/')) {
      throw new HarkGenerationError('Hark returned an invalid attachment URL');
    }
    const target = new URL(downloadUrl.replace(/^\/+/, ''), `${this.upstream}/`);
    let response;
    try {
      response = await fetch(target.toString(), {
        headers: { ...this.headers, Accept: '*/*' },
        redirect: 'follow',
        signal: AbortSignal.timeout(Math.max(this.config.requestTimeout, 60) * 1000),
      });
    } catch (error) {
      throw new HarkNetworkError(`attachment download failed: ${error?.name || 'TypeError'}`);
    }
    if (response.status === 401 || response.status === 403) {
      throw new HarkAuthError('Hark session is not authenticated or has expired');
    }
    if (response.status >= 400) {
      await response.body?.cancel().catch(() => {});
      throw new HarkError(`attachment download failed: HTTP ${response.status}`);
    }
    return response;
  }

  /**
   * 一次完整生成：建對話 → （可選上傳）→ 送出 → 輪詢到靜止。
   * 逐段 yield 事件，最後一個事件型別是 result。
   */
  async *run(prompt, options = {}) {
    const timeout = Math.max(1, Math.min(options.timeout ?? this.config.chatTimeout, 900));
    const deadline = Date.now() + timeout * 1000;

    const userId = await this.getUserId();
    const conversationId = await this.createConversation();

    let attachments = null;
    if (options.inputAttachment) {
      const { filename, mediaType, bytes } = options.inputAttachment;
      attachments = [await this.uploadAttachment(conversationId, bytes, filename, mediaType)];
    }
    const messageId = await this.sendMessage(conversationId, prompt, userId, attachments);

    let emitted = '';
    let lastState = '';
    let lastStage = null;
    let terminalAt = null;
    let finalMessages = [];

    for (;;) {
      const payload = await this.getHistory(conversationId);
      const messages = replyMessages(payload, messageId);
      const text = replyText(messages);
      const found = replyAttachments(messages);
      const stage = replyStage(messages);

      if (stage !== lastStage) {
        lastStage = stage;
        yield { type: 'stage', stage };
      }
      if (text !== emitted) {
        const delta = text.startsWith(emitted) ? text.slice(emitted.length) : text;
        if (delta) yield { type: 'delta', text: delta };
        emitted = text;
      }

      const state = JSON.stringify([
        text,
        found.map((item) => String(item.id ?? item.downloadUrl ?? item.name)),
        messages.map((message) => [message.id, message.isStreaming, message.jobStatus, message.content]),
      ]);

      if (replyTerminal(messages)) {
        if (state !== lastState) {
          terminalAt = Date.now();
        } else if (terminalAt !== null && Date.now() - terminalAt >= this.config.settleSeconds * 1000) {
          finalMessages = messages;
          break;
        }
      } else {
        terminalAt = null;
      }
      lastState = state;

      if (Date.now() >= deadline) {
        throw new HarkGenerationError("timed out waiting for Hark's response");
      }
      await sleep(Math.max(50, this.config.pollInterval * 1000));
    }

    yield { type: 'stage', stage: 'finalizing' };

    const downloaded = replyAttachments(finalMessages).map((item) => this.attachmentRecord(item));
    const finalText = replyText(finalMessages);
    if (options.requireAttachment && !downloaded.some((item) => item.mediaType.startsWith('image/'))) {
      throw new HarkGenerationError('Hark finished without returning an image attachment');
    }
    if (!finalText && !downloaded.length) {
      throw new HarkGenerationError('Hark finished without a visible response');
    }
    yield {
      type: 'result',
      conversationId,
      messageId,
      text: finalText,
      attachments: downloaded,
    };
  }
}

export function attachmentMarkdown(attachments, baseUrl) {
  return attachments.map((attachment) => {
    const name = String(attachment.name || attachment.filename || 'attachment');
    const url = `${String(baseUrl).replace(/\/+$/, '')}/v1/media/${attachment.filename}`;
    return String(attachment.mediaType ?? '').startsWith('image/')
      ? `![${name}](${url})`
      : `[${name}](${url})`;
  }).join('\n\n');
}