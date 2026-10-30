// Task Durable Object：用 alarm 驅動長任務，撐得住超過 30 秒的生成
// 一次生成最長 900 秒，遠超 Worker 請求 / waitUntil 的預算，只有 alarm 能撐住。
import { readConfig } from './config.js';
import { coreOp, recordMedia, refreshUsage, runnerStub } from './state.js';
import { base64ToBytes, sseEvents } from './util.js';

const CHUNK = 900_000; // base64 字串分片大小（DO storage 單值上限 2MB）

function phaseFor(stage) {
  return {
    waiting: '等待 Hark 响应',
    generating: 'Hark 生成中',
    finalizing: '整理结果',
  }[stage] ?? '处理中';
}

export class Task {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.config = readConfig(env);
  }

  async fetch(request) {
    const body = await request.json();
    if (body.op === 'start') {
      await this.ctx.storage.put('taskId', body.taskId);
      await this.ctx.storage.put('spec', {
        prompt: body.prompt ?? '',
        timeout: body.timeout ?? null,
        response_format: body.response_format ?? 'url',
      });
      if (body.attachment) await this.#putAttachment(body.attachment);
      await this.ctx.storage.setAlarm(Date.now() + 50);
      return Response.json({ ok: true });
    }
    if (body.op === 'status') {
      return Response.json({ taskId: (await this.ctx.storage.get('taskId')) ?? null });
    }
    return Response.json({ error: `unknown op: ${body.op}` }, { status: 400 });
  }

  async #putAttachment(attachment) {
    const data = String(attachment.b64 ?? '');
    const count = Math.max(1, Math.ceil(data.length / CHUNK));
    const entries = new Map([['att:meta', { filename: attachment.filename, mediaType: attachment.mediaType, count }]]);
    for (let index = 0; index < count; index += 1) {
      entries.set(`att:${index}`, data.slice(index * CHUNK, (index + 1) * CHUNK));
    }
    await this.ctx.storage.put(entries);
  }

  async #takeAttachment() {
    const meta = await this.ctx.storage.get('att:meta');
    if (!meta) return null;
    const keys = Array.from({ length: meta.count }, (_, index) => `att:${index}`);
    const records = await this.ctx.storage.get(keys);
    let data = '';
    for (const key of keys) data += records.get(key) ?? '';
    await this.ctx.storage.delete(['att:meta', ...keys]);
    return {
      filename: meta.filename,
      mediaType: meta.mediaType,
      bytes: base64ToBytes(data),
    };
  }

  async #cleanup() {
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.deleteAlarm();
  }

  async alarm() {
    const taskId = await this.ctx.storage.get('taskId');
    if (!taskId) return;
    const started = Date.now();
    const elapsed = () => Math.round((Date.now() - started) / 10) / 100;

    try {
      const { task } = await coreOp(this.env, 'task', { id: taskId });
      if (!task || ['completed', 'failed'].includes(task.status)) {
        await this.#cleanup();
        return;
      }
      await coreOp(this.env, 'patchTask', {
        id: taskId,
        fields: { status: 'processing', progress: null, progress_known: false, phase: '等待 Hark 响应' },
      });

      const spec = (await this.ctx.storage.get('spec')) ?? {};
      const attachment = await this.#takeAttachment();
      const { candidates } = await coreOp(this.env, 'pick', {});
      if (!candidates.length) throw new Error('no Hark account is configured');

      let lastError = null;
      for (const account of candidates) {
        if (!String(account.cookie_header ?? '').trim()) continue;
        const outcome = await this.#runOnce(account, spec, attachment, taskId);

        if (outcome.type === 'result') {
          const images = outcome.attachments
            .filter((item) => String(item.mediaType ?? '').startsWith('image/'))
            .map((item) => ({
              filename: item.filename,
              mediaType: item.mediaType,
              size: Number(item.size) || 0,
            }));
          if (!images.length) throw new Error('Hark did not return an image');

          await recordMedia(this.env, account.id, outcome.attachments);
          await coreOp(this.env, 'mark', { id: account.id, ok: true });
          await coreOp(this.env, 'used', { id: account.id });
          await coreOp(this.env, 'patchTask', {
            id: taskId,
            fields: {
              status: 'completed',
              progress: 100,
              progress_known: true,
              phase: '已完成',
              elapsed: elapsed(),
              result: { images },
              account_id: account.id,
              usage_status: 'idle',
            },
          });
          this.ctx.waitUntil(
            refreshUsage(this.env, account.id)
              .then((usage) => coreOp(this.env, 'patchTask', {
                id: taskId,
                fields: { usage, usage_status: usage?.status ?? 'error' },
              }))
              .catch(() => {}),
          );
          await this.#cleanup();
          return;
        }

        if (outcome.type === 'auth') {
          lastError = outcome.error;
          await coreOp(this.env, 'mark', {
            id: account.id,
            ok: false,
            note: String(outcome.error ?? '').slice(0, 300),
          });
          continue;
        }
        throw new Error(outcome.error);
      }
      throw new Error(lastError || 'no Hark account is available');
    } catch (error) {
      await coreOp(this.env, 'patchTask', {
        id: taskId,
        fields: {
          status: 'failed',
          progress: null,
          progress_known: false,
          phase: '失败',
          elapsed: elapsed(),
          error: error?.message || String(error),
        },
      }).catch(() => {});
      await this.#cleanup();
    }
  }

  async #runOnce(account, spec, attachment, taskId) {
    const response = await runnerStub(this.env, account.id).fetch('https://runner.internal/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        op: 'run',
        cookie: account.cookie_header,
        prompt: spec.prompt,
        timeout: Math.min(spec.timeout ?? this.config.chatTimeout, 840),
        requireAttachment: true,
        inputAttachment: attachment
          ? { filename: attachment.filename, mediaType: attachment.mediaType, bytes: attachment.bytes }
          : null,
      }),
    });
    if (!response.ok) return { type: 'error', error: `runner HTTP ${response.status}` };

    let result = null;
    let failure = null;
    for await (const event of sseEvents(response)) {
      if (event.type === 'stage') {
        await coreOp(this.env, 'patchTask', {
          id: taskId,
          fields: { phase: phaseFor(event.stage), progress: null, progress_known: false },
        });
      } else if (event.type === 'error') {
        failure = event;
      } else if (event.type === 'result') {
        result = event;
      }
    }
    if (result) return { type: 'result', ...result, accountId: account.id };
    if (failure) return { type: failure.kind === 'auth' ? 'auth' : 'error', error: failure.error };
    return { type: 'error', error: 'Hark stream ended without a result' };
  }
}