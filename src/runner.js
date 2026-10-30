// Runner Durable Object：一個帳號一個實例，同帳號的生成任務在此排隊執行
import { readConfig } from './config.js';
import { HarkClient } from './hark.js';
import { sseChunk } from './util.js';

export class Runner {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.config = readConfig(env);
    this.tail = Promise.resolve();
  }

  /** 以 promise 鏈實作互斥鎖：同一帳號同時只跑一個生成 */
  async #exclusive(task) {
    const previous = this.tail;
    let release;
    this.tail = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await task();
    } finally {
      release();
    }
  }

  async fetch(request) {
    const body = await request.json();
    if (body.op === 'run') return this.#runStream(body);
    if (body.op === 'media') return this.#media(body);
    return Response.json({ error: `unknown op: ${body.op}` }, { status: 400 });
  }

  #runStream(body) {
    const encoder = new TextEncoder();
    const self = this;
    let cancelled = false;

    return new Response(new ReadableStream({
      cancel() {
        cancelled = true;
      },
      async start(controller) {
        const send = (event) => {
          if (cancelled) return;
          try {
            controller.enqueue(encoder.encode(sseChunk(event)));
          } catch {
            cancelled = true;
          }
        };

        try {
          await self.#exclusive(async () => {
            const client = new HarkClient(self.config, body.cookie);
            const iterator = client.run(body.prompt, {
              timeout: body.timeout,
              requireAttachment: body.requireAttachment === true,
              inputAttachment: body.inputAttachment ?? null,
            });
            try {
              for (;;) {
                const { value, done } = await iterator.next();
                if (done) break;
                if (cancelled) {
                  await iterator.return?.();
                  break;
                }
                send(value);
              }
            } finally {
              if (cancelled) await iterator.return?.();
            }
          });
        } catch (error) {
          send({
            type: 'error',
            error: error?.message || String(error),
            kind: error?.kind || 'unknown',
            name: error?.name || 'Error',
          });
        } finally {
          try {
            controller.close();
          } catch {
            /* 已關閉 */
          }
        }
      },
    }), {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Accel-Buffering': 'no',
      },
    });
  }

  async #media(body) {
    const client = new HarkClient(this.config, body.cookie);
    let upstream;
    try {
      upstream = await client.fetchMedia(body.downloadUrl);
    } catch (error) {
      return Response.json({ error: error?.message || String(error) }, { status: error?.kind === 'auth' ? 401 : 502 });
    }
    const mediaType = String(upstream.headers.get('Content-Type') || body.mediaType || 'application/octet-stream').split(';')[0];
    if (mediaType === 'text/html') {
      await upstream.body?.cancel().catch(() => {});
      return Response.json({ error: 'Hark returned a login page while downloading an attachment' }, { status: 401 });
    }
    const headers = new Headers();
    headers.set('Content-Type', mediaType);
    const length = upstream.headers.get('Content-Length');
    if (length) headers.set('Content-Length', length);
    headers.set('Cache-Control', 'private, max-age=300');
    return new Response(upstream.body, { headers });
  }
}