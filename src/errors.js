// 錯誤型別與 OpenAI 錯誤封裝
export class HarkError extends Error {
  constructor(message) {
    super(message);
    this.name = this.constructor.name;
    this.kind = 'upstream';
  }
}

export class HarkAuthError extends HarkError {
  constructor(message) {
    super(message);
    this.kind = 'auth';
  }
}

export class HarkNetworkError extends HarkError {
  constructor(message) {
    super(message);
    this.kind = 'network';
  }
}

export class HarkGenerationError extends HarkError {
  constructor(message) {
    super(message);
    this.kind = 'generation';
  }
}

export class HarkUsageError extends HarkError {
  constructor(message) {
    super(message);
    this.kind = 'usage';
  }
}

/** 對外 API 錯誤（會轉成 OpenAI 錯誤信封或 {detail}） */
export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function statusForError(error) {
  if (error instanceof HarkAuthError) return 401;
  if (error instanceof HarkGenerationError) {
    return /timed out/i.test(error.message) ? 504 : 502;
  }
  if (error instanceof HarkError) return 502;
  if (error instanceof ApiError) return error.status;
  return 500;
}

export function errorKindForStatus(status) {
  if (status === 401) return 'authentication_error';
  if (status === 404) return 'not_found_error';
  if (status === 504) return 'timeout_error';
  if (status === 501) return 'not_implemented_error';
  if (status >= 500) return 'server_error';
  return 'invalid_request_error';
}

export function openAIError(message, status) {
  return Response.json(
    { error: { message, type: errorKindForStatus(status), param: null, code: status } },
    { status },
  );
}

/** 依路徑決定錯誤格式：/v1/* 用 OpenAI 信封，其餘用 {detail} */
export function respondError(pathname, error) {
  const status = statusForError(error);
  const message = error?.message || String(error);
  if (pathname.startsWith('/v1/')) return openAIError(message, status);
  return Response.json({ detail: message }, { status });
}