// Worker / DO 共用的狀態存取小工具
import { readConfig } from './config.js';
import { HarkClient } from './hark.js';

const CORE_NAME = 'core';

export function coreStub(env) {
  return env.CORE.get(env.CORE.idFromName(CORE_NAME));
}

export async function coreOp(env, op, payload = {}) {
  const response = await coreStub(env).fetch('https://core.internal/op', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ op, ...payload }),
  });
  if (!response.ok) {
    throw new Error(`core op ${op} failed: HTTP ${response.status}`);
  }
  return response.json();
}

export function runnerStub(env, accountId) {
  return env.RUNNER.get(env.RUNNER.idFromName(String(accountId)));
}

/** 把上游附件登記成媒體索引項目（不再落地檔案，改為記錄上游 URL） */
export async function recordMedia(env, accountId, attachments = []) {
  if (!attachments.length) return;
  const stamp = Math.floor(Date.now() / 1000);
  await coreOp(env, 'addMedia', {
    items: attachments.map((attachment) => ({
      name: attachment.filename,
      media_type: attachment.mediaType,
      bytes: Number(attachment.size) || 0,
      mtime: stamp,
      accountId,
      downloadUrl: attachment.downloadUrl,
    })),
  });
}

/** 查詢上游額度並寫回帳號 */
export async function refreshUsage(env, accountId, { pending = true } = {}) {
  const config = readConfig(env);
  const { account } = await coreOp(env, 'account', { id: accountId });
  if (!account) return null;
  if (pending) {
    await coreOp(env, 'usage', { id: accountId, usage: { status: 'loading', updated_at: Math.floor(Date.now() / 1000) } });
  }
  const client = new HarkClient(config, account.cookie_header);
  try {
    const usage = await client.queryUsage(Math.min(config.chatTimeout, 180));
    const record = { status: 'ready', ...usage, updated_at: Math.floor(Date.now() / 1000) };
    await coreOp(env, 'usage', { id: accountId, usage: record });
    await coreOp(env, 'mark', { id: accountId, ok: true });
    return record;
  } catch (error) {
    const record = {
      status: 'error',
      error: error?.message || String(error),
      updated_at: Math.floor(Date.now() / 1000),
    };
    await coreOp(env, 'usage', { id: accountId, usage: record });
    if (error?.kind === 'auth') {
      await coreOp(env, 'mark', { id: accountId, ok: false, note: record.error });
    }
    return record;
  }
}

export async function currentAccount(env, accountId) {
  const { account } = await coreOp(env, 'account', { id: accountId });
  return account ?? null;
}