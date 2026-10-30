// 環境變數 → 設定（專案統一字首 HARK2API_*）
const DEFAULTS = {
  upstream: 'https://hark.com',
  chatTimeout: 300,
  requestTimeout: 30,
  pollInterval: 1,
  settleSeconds: 1.5,
  taskQueueLimit: 8,
  maxMediaBytes: 20 * 1024 * 1024,
  timezone: 'Asia/Shanghai',
  locale: 'zh-CN',
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
};

function numeric(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function readConfig(env) {
  const upstream = String(env.HARK2API_UPSTREAM || DEFAULTS.upstream).replace(/\/+$/, '');
  return {
    upstream,
    apiKey: String(env.HARK2API_KEY || '').trim(),
    cookie: String(env.HARK2API_COOKIE || '').trim(),
    chatTimeout: Math.min(900, numeric(env.HARK2API_CHAT_TIMEOUT, DEFAULTS.chatTimeout)),
    requestTimeout: numeric(env.HARK2API_REQUEST_TIMEOUT, DEFAULTS.requestTimeout),
    pollInterval: numeric(env.HARK2API_POLL_INTERVAL, DEFAULTS.pollInterval),
    settleSeconds: numeric(env.HARK2API_SETTLE_SECONDS, DEFAULTS.settleSeconds),
    taskQueueLimit: Math.max(1, Math.trunc(numeric(env.HARK2API_TASK_QUEUE_LIMIT, DEFAULTS.taskQueueLimit))),
    maxMediaBytes: Math.trunc(numeric(env.HARK2API_MAX_MEDIA_BYTES, DEFAULTS.maxMediaBytes)),
    timezone: String(env.HARK2API_TIMEZONE || DEFAULTS.timezone),
    locale: String(env.HARK2API_LOCALE || DEFAULTS.locale),
    userAgent: String(env.HARK2API_USER_AGENT || DEFAULTS.userAgent),
    publicBase: String(env.HARK2API_PUBLIC_BASE || '').replace(/\/+$/, ''),
  };
}