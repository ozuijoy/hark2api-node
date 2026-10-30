// 純函式工具層：Cookie 解析、額度整形、Hark 歷史訊息判定、SSE 解析
import { HarkUsageError } from './errors.js';

export function parseCookieHeader(text) {
  const out = {};
  const raw = String(text ?? '').trim();
  if (raw && !raw.includes(';') && !raw.includes('=')) {
    return { '__Secure-hark.session_token': raw };
  }
  for (const piece of raw.split(';')) {
    const item = piece.trim();
    if (!item || !item.includes('=')) continue;
    const index = item.indexOf('=');
    const name = item.slice(0, index).trim();
    if (name) out[name] = item.slice(index + 1).trim();
  }
  return out;
}

export function buildCookieHeader(text) {
  return Object.entries(parseCookieHeader(text))
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');
}

const zonedFormatters = new Map();

function formatterFor(timezone) {
  let formatter = zonedFormatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    zonedFormatters.set(timezone, formatter);
  }
  return formatter;
}

/** 取得某個時間點在指定時區的牆上時間（年月日時分秒） */
export function zonedParts(date, timezone) {
  const parts = {};
  for (const part of formatterFor(timezone).formatToParts(date)) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour,
    minute: parts.minute,
    second: parts.second,
  };
}

function pad(value) {
  return String(value).padStart(2, '0');
}

export function formatZoned(date, timezone) {
  const p = zonedParts(date, timezone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}`;
}

/** 產生帶時區位移的 ISO 字串 */
function isoWithOffset(date, timezone) {
  const p = zonedParts(date, timezone);
  const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const offsetMinutes = Math.round((wall - Math.floor(date.getTime() / 1000) * 1000) / 60000);
  const sign = offsetMinutes < 0 ? '-' : '+';
  const abs = Math.abs(offsetMinutes);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`
    + `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function previousMonth(parts) {
  let year = parts.year;
  let month = parts.month - 1;
  if (month === 0) {
    year -= 1;
    month = 12;
  }
  const day = Math.min(parts.day, daysInMonth(year, month));
  return { year, month, day, hour: parts.hour, minute: parts.minute, second: parts.second };
}

/** 把 Hark 的 billing meters 整形成帳號頁用的額度資料 */
export function parseBillingSummary(payload, timezone = 'Asia/Shanghai', now = new Date()) {
  let timezoneName = timezone || 'Asia/Shanghai';
  try {
    formatterFor(timezoneName);
  } catch {
    throw new HarkUsageError(`未知时区：${timezoneName}`);
  }

  const meters = payload?.meters?.harkTokens ?? {};
  const plan = String(payload?.plan?.name ?? '').trim();
  if (typeof meters !== 'object' || meters === null || Array.isArray(meters)) {
    throw new HarkUsageError('额度响应缺少 harkTokens 数据');
  }

  const current = now instanceof Date ? now : new Date();

  const number = (name) => {
    const value = meters[name];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
      throw new HarkUsageError(`额度字段 ${name} 格式无效`);
    }
    return value;
  };

  const resetTime = (name, label) => {
    const value = meters[name];
    if (typeof value !== 'string') throw new HarkUsageError(`${label}重置时间缺失`);
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) throw new HarkUsageError(`${label}重置时间格式无效`);
    return parsed;
  };

  const meter = (limitName, usedName, resetName, label, monthly = false) => {
    const limit = number(limitName);
    const used = number(usedName);
    if (limit <= 0 || used > limit) throw new HarkUsageError(`${label}额度数值无效`);
    const resetAt = resetTime(resetName, label);
    const parts = zonedParts(resetAt, timezoneName);
    let duration;
    if (monthly) {
      const start = previousMonth(parts);
      duration = Math.max(1, Math.round(
        (Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second)
          - Date.UTC(start.year, start.month - 1, start.day, start.hour, start.minute, start.second)) / 1000,
      ));
    } else {
      duration = 86400;
    }
    const remainingSeconds = Math.max(0, Math.round((resetAt.getTime() - current.getTime()) / 1000));
    const remaining = limit - used;
    const leftPercent = Math.max(0, Math.min(100, Math.round((remaining / limit) * 100)));
    const resetLeftPercent = Math.max(0, Math.min(100, Math.round((remainingSeconds / duration) * 100)));
    return {
      left: `${leftPercent}%`,
      used,
      limit,
      remaining,
      reset: formatZoned(resetAt, timezoneName),
      reset_at: isoWithOffset(resetAt, timezoneName),
      reset_duration_seconds: duration,
      reset_left_percent: resetLeftPercent,
    };
  };

  return {
    plan: plan || '未知套餐',
    daily: meter('dailyLimit', 'dailyUsed', 'dailyResetsAt', '每日'),
    monthly: meter('poolLimit', 'poolUsed', 'poolResetsAt', '月度', true),
    source: 'billing_summary',
  };
}

/** 兩種 history 形狀都整形成 log 順序 */
export function historyMessages(payload) {
  const raw = payload?.messages ?? {};
  let byId;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    byId = new Map(Object.entries(raw).filter(([, value]) => value && typeof value === 'object'));
  } else if (Array.isArray(raw)) {
    byId = new Map(
      raw.filter((value) => value && typeof value === 'object' && value.id).map((value) => [String(value.id), value]),
    );
  } else {
    byId = new Map();
  }

  const ordered = [];
  const seen = new Set();
  for (const entry of payload?.log ?? []) {
    if (!entry || typeof entry !== 'object') continue;
    const messageId = String(entry.id ?? '');
    const message = byId.get(messageId);
    if (message) {
      ordered.push(message);
      seen.add(messageId);
    }
  }
  for (const [messageId, message] of byId) {
    if (!seen.has(messageId)) ordered.push(message);
  }
  return ordered;
}

export function replyMessages(payload, userMessageId) {
  return historyMessages(payload).filter(
    (message) => message.role === 'assistant' && message.triggeredByMessageId === userMessageId,
  );
}

export function replyText(messages) {
  const parts = [];
  for (const message of messages) {
    if (message.source === 'web' || message.source === 'onboarding') continue;
    const content = message.content;
    if (typeof content === 'string' && content.trim() && !parts.includes(content.trim())) {
      parts.push(content.trim());
    }
  }
  return parts.join('\n\n');
}

export function replyAttachments(messages) {
  const out = [];
  const seen = new Set();
  for (const message of messages) {
    for (const attachment of message.attachments ?? []) {
      if (!attachment || typeof attachment !== 'object') continue;
      const key = String(attachment.id ?? attachment.downloadUrl ?? attachment.name ?? '');
      if (key && !seen.has(key)) {
        seen.add(key);
        out.push(attachment);
      }
    }
  }
  return out;
}

const ACTIVE_STATES = new Set(['queued', 'pending', 'running', 'processing', 'in_progress', 'streaming']);
const COMPLETE_STATES = new Set(['completed', 'failed', 'cancelled', 'interrupted']);

const isActive = (message) => message.isStreaming === true
  || ACTIVE_STATES.has(String(message.jobStatus ?? '').toLowerCase());

export function replyStage(messages) {
  if (!messages.length) return 'waiting';
  if (messages.some(isActive)) return 'generating';
  if (messages.some((message) => message.attachments
    || (typeof message.content === 'string' && message.content.trim()))) {
    return 'finalizing';
  }
  return 'waiting';
}

/** Hark 已有可見回答或工具執行完成時回 true */
export function replyTerminal(messages) {
  if (messages.some(isActive)) return false;
  for (const message of messages) {
    const source = message.source;
    if (source !== 'web' && source !== 'onboarding') {
      if (typeof message.content === 'string' && message.content.trim()) return true;
      if (message.attachments) return true;
    }
    if (COMPLETE_STATES.has(message.jobStatus)) return true;
  }
  return false;
}

const EXTENSION_MAP = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/avif': '.avif',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'audio/mpeg': '.mp3',
  'audio/wav': '.wav',
  'application/pdf': '.pdf',
  'text/plain': '.txt',
  'application/zip': '.zip',
};

export function extensionFor(mediaType, filename) {
  const match = /(\.[a-z0-9]{1,8})$/i.exec(String(filename ?? ''));
  if (match) {
    const extension = match[1].toLowerCase();
    return extension === '.jpe' ? '.jpg' : extension;
  }
  return EXTENSION_MAP[String(mediaType ?? '').toLowerCase()] ?? '.bin';
}

export function mediaTypeFromFilename(name) {
  const extension = String(name ?? '').toLowerCase().match(/\.[a-z0-9]+$/)?.[0] ?? '';
  for (const [type, ext] of Object.entries(EXTENSION_MAP)) {
    if (ext === extension) return type;
  }
  if (extension === '.jpeg') return 'image/jpeg';
  if (extension === '.m4v') return 'video/mp4';
  return 'application/octet-stream';
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

export function uuid() {
  return crypto.randomUUID().replace(/-/g, '');
}

function hex(buffer) {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function sha256Hex(text) {
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

export async function sha256Bytes(bytes) {
  return hex(await crypto.subtle.digest('SHA-256', bytes));
}

export function bytesToBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

export function base64ToBytes(text) {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) out[index] = binary.charCodeAt(index);
  return out;
}

/** 逐段解析 SSE，容忍跨 chunk 的半個事件 */
export async function* sseEvents(response) {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index;
      while ((index = buffer.indexOf('\n\n')) >= 0) {
        const raw = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        for (const line of raw.split('\n')) {
          if (!line.startsWith('data: ')) continue;
          try {
            yield JSON.parse(line.slice(6));
          } catch {
            /* 忽略不完整或非 JSON 的行 */
          }
        }
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* 已關閉 */
    }
  }
}

export function sseChunk(data) {
  return `data: ${JSON.stringify(data)}\n\n`;
}

export function sseEvent(name, data) {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}