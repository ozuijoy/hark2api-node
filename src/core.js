// Core Durable Object：全域狀態（帳號池 / 任務索引 / 媒體索引）
// 帳號、任務與媒體索引都存在 Durable Object storage，不需要 D1 / KV / R2
import { readConfig } from './config.js';
import { parseCookieHeader } from './util.js';

const ACCOUNTS = 'accounts';
const TASK_INDEX = 'task:index';
const MEDIA_INDEX = 'media:index';
const VIRTUAL = 'virtual';
const STALE_MS = 900 * 1000; // 超過這個時間沒心跳的 processing 任務視為孤兒

const taskKey = (id) => `task:${id}`;
const mediaKey = (name) => `media:${name}`;
const now = () => Math.floor(Date.now() / 1000);

export class Core {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.storage = ctx.storage;
    this.config = readConfig(env);
    ctx.blockConcurrencyWhile(async () => {
      await this.#sweepStaleTasks();
    });
  }

  async #sweepStaleTasks() {
    const index = (await this.storage.get(TASK_INDEX)) ?? [];
    if (!index.length) return;
    const records = await this.storage.get(index.map(taskKey));
    const stale = [];
    for (const [key, task] of records) {
      if (!task || !['queued', 'processing'].includes(task.status)) continue;
      const updatedAt = Number(task.updated_at ?? task.created_at ?? 0) * 1000;
      if (Date.now() - updatedAt < STALE_MS) continue;
      await this.storage.put(key, {
        ...task,
        status: 'failed',
        progress: null,
        progress_known: false,
        phase: '失败',
        error: 'worker interrupted by service restart',
        updated_at: now(),
      });
      stale.push(key);
    }
    return stale;
  }

  async #accounts() {
    return (await this.storage.get(ACCOUNTS)) ?? [];
  }

  async #virtual() {
    return (await this.storage.get(VIRTUAL)) ?? { ok: null, note: '', use_count: 0, last_used: null, usage: null };
  }

  /** 有持久化帳號就用它，否則用環境變數的 cookie 當虛擬帳號 */
  async #records() {
    const persisted = await this.#accounts();
    if (persisted.length) return persisted;
    if (this.config.cookie) {
      const virtual = await this.#virtual();
      return [{
        id: 'env',
        label: 'environment cookie',
        cookie_header: this.config.cookie,
        enabled: true,
        ...virtual,
      }];
    }
    return [];
  }

  #hasCredential(account) {
    return Boolean(String(account.cookie_header ?? '').trim());
  }

  async #index(key) {
    return (await this.storage.get(key)) ?? [];
  }

  async #putIndex(key, list) {
    await this.storage.put(key, list);
  }

  async #listTasks(limit = 50) {
    const index = await this.#index(TASK_INDEX);
    const ids = index.slice(0, Math.max(1, Math.min(limit, 200)));
    if (!ids.length) return [];
    const records = await this.storage.get(ids.map(taskKey));
    return ids.map((id) => records.get(taskKey(id))).filter(Boolean);
  }

  async #ordered() {
    const records = (await this.#records()).filter(
      (account) => account.enabled !== false && this.#hasCredential(account),
    );
    const healthy = records.filter((account) => account.ok !== false);
    return (healthy.length ? healthy : records).sort(
      (a, b) => (Number(a.last_used ?? 0) - Number(b.last_used ?? 0))
        || (Number(a.use_count ?? 0) - Number(b.use_count ?? 0)),
    );
  }

  async #stats() {
    const persisted = await this.#accounts();
    if (!persisted.length) {
      const records = await this.#records();
      const virtual = await this.#virtual();
      return {
        total: records.length ? 1 : 0,
        enabled: records.length ? 1 : 0,
        disabled: 0,
        healthy: virtual.ok === true ? 1 : 0,
        error: virtual.ok === false ? 1 : 0,
      };
    }
    const enabled = persisted.filter((account) => account.enabled !== false);
    return {
      total: persisted.length,
      enabled: enabled.length,
      disabled: persisted.length - enabled.length,
      healthy: enabled.filter((account) => account.ok === true).length,
      error: enabled.filter((account) => account.ok === false).length,
    };
  }

  async #publicAccounts() {
    const persisted = await this.#accounts();
    if (persisted.length) {
      return persisted.map(({ cookie_header: _ignored, ...rest }) => rest);
    }
    const records = await this.#records();
    return records.map((account) => ({
      id: 'env',
      label: 'environment cookie',
      enabled: true,
      ok: account.ok,
      note: account.note,
      use_count: account.use_count,
      last_used: account.last_used,
      usage: account.usage,
      persistent: false,
    }));
  }

  async #mutateAccount(id, mutator) {
    const accounts = await this.#accounts();
    const index = accounts.findIndex((account) => String(account.id) === String(id));
    if (index < 0) return null;
    const next = { ...accounts[index] };
    mutator(next);
    next.updated_at = now();
    accounts[index] = next;
    await this.storage.put(ACCOUNTS, accounts);
    const { cookie_header: _ignored, ...rest } = next;
    return rest;
  }

  async fetch(request) {
    const { op, ...body } = await request.json();
    switch (op) {
      case 'health':
        return Response.json({ ok: true });

      case 'snapshot': {
        const [accounts, tasks, media] = await Promise.all([
          this.#records(),
          this.#listTasks(50),
          this.#index(MEDIA_INDEX),
        ]);
        return Response.json({ accounts, tasks, mediaCount: media.length });
      }

      case 'pick':
        return Response.json({ candidates: await this.#ordered() });

      case 'account': {
        const record = (await this.#records()).find((item) => String(item.id) === String(body.id));
        return Response.json({ account: record ?? null });
      }

      case 'accounts':
        return Response.json({ accounts: await this.#publicAccounts(), stats: await this.#stats() });

      case 'export': {
        const records = await this.#records();
        const selected = body.ids?.length ? new Set(body.ids.map(String)) : null;
        return Response.json({
          version: 1,
          accounts: records
            .filter((account) => !selected || selected.has(String(account.id)))
            .filter((account) => this.#hasCredential(account))
            .map((account) => ({
              label: String(account.label ?? ''),
              cookie_header: String(account.cookie_header ?? ''),
              enabled: account.enabled !== false,
            })),
        });
      }

      case 'add': {
        const accounts = await this.#accounts();
        const stamp = now();
        const account = {
          id: `acc_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`,
          label: String(body.label ?? '').trim(),
          cookie_header: String(body.cookie ?? '').trim(),
          enabled: true,
          ok: null,
          note: '',
          created_at: stamp,
          updated_at: stamp,
          last_used: null,
          use_count: 0,
          profile: body.profile ?? null,
        };
        accounts.push(account);
        await this.storage.put(ACCOUNTS, accounts);
        return Response.json({ account });
      }

      case 'update': {
        if (String(body.id) === 'env') {
          // 環境變數帳號不可持久化修改
          return Response.json({ account: null });
        }
        const updated = await this.#mutateAccount(body.id, (account) => {
          for (const [key, value] of Object.entries(body.fields ?? {})) {
            if (!['label', 'cookie_header', 'enabled'].includes(key) || value === null || value === undefined) continue;
            account[key] = typeof value === 'string' ? value.trim() : value;
          }
          if (body.fields && 'cookie_header' in body.fields) account.ok = null;
        });
        return Response.json({ account: updated });
      }

      case 'delete': {
        if (String(body.id) === 'env') return Response.json({ deleted: false, virtual: true });
        const accounts = await this.#accounts();
        const next = accounts.filter((account) => String(account.id) !== String(body.id));
        if (next.length === accounts.length) return Response.json({ deleted: false });
        await this.storage.put(ACCOUNTS, next);
        return Response.json({ deleted: true });
      }

      case 'mark': {
        if (String(body.id) === 'env') {
          const virtual = await this.#virtual();
          await this.storage.put(VIRTUAL, {
            ...virtual,
            ok: body.ok === true,
            note: String(body.note ?? '').slice(0, 300),
            checked_at: now(),
          });
          return Response.json({ ok: true });
        }
        await this.#mutateAccount(body.id, (account) => {
          account.ok = body.ok === true;
          account.note = String(body.note ?? '').slice(0, 300);
          account.checked_at = now();
        });
        return Response.json({ ok: true });
      }

      case 'used': {
        if (String(body.id) === 'env') {
          const virtual = await this.#virtual();
          await this.storage.put(VIRTUAL, {
            ...virtual,
            last_used: Date.now() / 1000,
            use_count: Number(virtual.use_count ?? 0) + 1,
          });
          return Response.json({ ok: true });
        }
        await this.#mutateAccount(body.id, (account) => {
          account.last_used = Date.now() / 1000;
          account.use_count = Number(account.use_count ?? 0) + 1;
        });
        return Response.json({ ok: true });
      }

      case 'usage': {
        if (String(body.id) === 'env') {
          const virtual = await this.#virtual();
          await this.storage.put(VIRTUAL, { ...virtual, usage: body.usage ?? null });
          if (body.usage && body.usage.status === 'ready') {
            await this.storage.put(VIRTUAL, {
              ...(await this.#virtual()),
              usage: body.usage,
              ok: true,
              note: '',
            });
          }
          return Response.json({ ok: true });
        }
        await this.#mutateAccount(body.id, (account) => {
          account.usage = body.usage ?? null;
        });
        return Response.json({ ok: true });
      }

      case 'profile':
        await this.#mutateAccount(body.id, (account) => {
          account.profile = body.profile ?? null;
        });
        return Response.json({ ok: true });

      case 'tasks':
        return Response.json({ tasks: await this.#listTasks(body.limit ?? 50) });

      case 'task': {
        const task = await this.storage.get(taskKey(body.id));
        return Response.json({ task: task ?? null });
      }

      case 'createTask': {
        const index = await this.#index(TASK_INDEX);
        if (body.keyHash) {
          const recent = index.slice(0, 1000);
          const records = recent.length ? await this.storage.get(recent.map(taskKey)) : new Map();
          for (const task of records.values()) {
            if (!task || task.idempotency_key_hash !== body.keyHash) continue;
            if (task.request_hash !== body.requestHash) {
              return Response.json({ status: 'conflict' });
            }
            return Response.json({ status: 'reused', task });
          }
        }
        const recent = index.slice(0, 1000);
        const records = recent.length ? await this.storage.get(recent.map(taskKey)) : new Map();
        const active = [...records.values()].filter(
          (task) => task && task.kind === 'image' && ['queued', 'processing'].includes(task.status),
        ).length;
        if (active >= this.config.taskQueueLimit) return Response.json({ status: 'full' });

        const stamp = now();
        const task = {
          id: `task_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`,
          object: 'image.task',
          kind: body.kind ?? 'image',
          prompt: body.prompt ?? '',
          status: 'queued',
          progress: null,
          progress_known: false,
          phase: '排队中',
          created_at: stamp,
          updated_at: stamp,
          result: null,
          error: null,
          usage_status: 'idle',
          response_format: body.response_format ?? 'url',
          request_hash: body.requestHash ?? null,
          idempotency_key_hash: body.keyHash ?? null,
        };
        await this.storage.put(taskKey(task.id), task);
        await this.#putIndex(TASK_INDEX, [task.id, ...index]);
        return Response.json({ status: 'created', task });
      }

      case 'patchTask': {
        const key = taskKey(body.id);
        const task = await this.storage.get(key);
        if (!task) return Response.json({ task: null });
        const next = { ...task, ...body.fields, updated_at: now() };
        await this.storage.put(key, next);
        return Response.json({ task: next });
      }

      case 'deleteTask': {
        const key = taskKey(body.id);
        const task = await this.storage.get(key);
        if (!task) return Response.json({ deleted: false });
        await this.storage.delete(key);
        const index = await this.#index(TASK_INDEX);
        await this.#putIndex(TASK_INDEX, index.filter((id) => id !== body.id));
        return Response.json({ deleted: true });
      }

      case 'clearTasks': {
        const index = await this.#index(TASK_INDEX);
        const records = index.length ? await this.storage.get(index.map(taskKey)) : new Map();
        const removable = [];
        for (const [key, task] of records) {
          if (task && ['completed', 'failed'].includes(task.status)) removable.push(key);
        }
        if (removable.length) await this.storage.delete(removable);
        const removedIds = new Set(removable.map((key) => key.slice('task:'.length)));
        await this.#putIndex(TASK_INDEX, index.filter((id) => !removedIds.has(id)));
        return Response.json({ removed: removable.length });
      }

      case 'media': {
        const index = await this.#index(MEDIA_INDEX);
        if (!index.length) return Response.json({ media: [] });
        const records = await this.storage.get(index.map(mediaKey));
        const media = index.map((name) => records.get(mediaKey(name))).filter(Boolean);
        return Response.json({ media });
      }

      case 'mediaLookup': {
        const record = await this.storage.get(mediaKey(body.name));
        return Response.json({ media: record ?? null });
      }

      case 'addMedia': {
        const index = await this.#index(MEDIA_INDEX);
        const added = [];
        for (const item of body.items ?? []) {
          if (!item?.name) continue;
          const record = {
            name: item.name,
            media_type: item.media_type ?? 'application/octet-stream',
            bytes: Number(item.bytes ?? 0),
            mtime: Number(item.mtime ?? now()),
            kind: String(item.media_type ?? '').startsWith('video/') ? 'video' : 'image',
            accountId: item.accountId ?? null,
            downloadUrl: item.downloadUrl ?? null,
          };
          await this.storage.put(mediaKey(record.name), record);
          added.push(record.name);
        }
        const merged = [...new Set([...added, ...index])];
        await this.#putIndex(MEDIA_INDEX, merged);
        return Response.json({ added });
      }

      case 'deleteMedia': {
        const key = mediaKey(body.name);
        const record = await this.storage.get(key);
        if (!record) return Response.json({ deleted: false });
        await this.storage.delete(key);
        const index = await this.#index(MEDIA_INDEX);
        await this.#putIndex(MEDIA_INDEX, index.filter((name) => name !== body.name));
        return Response.json({ deleted: true, bytes: record.bytes ?? 0 });
      }

      case 'cleanupMedia': {
        const index = await this.#index(MEDIA_INDEX);
        const records = index.length ? await this.storage.get(index.map(mediaKey)) : new Map();
        const cutoff = now() - Math.max(1, Number(body.maxAgeSeconds ?? 7 * 86400));
        let removed = 0;
        let bytesRemoved = 0;
        const keep = [];
        for (const name of index) {
          const record = records.get(mediaKey(name));
          if (!record || Number(record.mtime) > cutoff) {
            keep.push(name);
            continue;
          }
          removed += 1;
          bytesRemoved += Number(record.bytes ?? 0);
          if (!body.dryRun) {
            await this.storage.delete(mediaKey(name));
          } else {
            keep.push(name);
          }
        }
        if (!body.dryRun && keep.length !== index.length) await this.#putIndex(MEDIA_INDEX, keep);
        return Response.json({ removed, bytes_removed: bytesRemoved });
      }

      case 'stats':
        return Response.json({ stats: await this.#stats() });

      default:
        return Response.json({ error: `unknown op: ${op}` }, { status: 400 });
    }
  }
}

export { parseCookieHeader };