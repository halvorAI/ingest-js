/** Stable error codes and their HTTP status (`specs/04-api.md` §2). Never rename a code. */
export const ERROR_CODES = {
  invalid_request: 400,
  unauthorized: 401,
  key_environment_mismatch: 401,
  forbidden: 403,
  not_found: 404,
  idempotency_conflict: 409,
  payload_too_large: 413,
  invalid_event: 422,
  invalid_signature: 422,
  pan_detected: 422,
  environment_mismatch: 422,
  unknown_source: 422,
  unprocessable: 422,
  rate_limited: 429,
  internal_error: 500,
  unavailable: 503,
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

export class HalvorError extends Error {
  override readonly name = 'HalvorError';

  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: readonly unknown[],
  ) {
    super(message);
  }
}

export interface ErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    details?: readonly unknown[];
    request_id: string;
  };
}

export function httpStatus(code: ErrorCode): (typeof ERROR_CODES)[ErrorCode] {
  return ERROR_CODES[code];
}

/** Unknown errors are reported as internal_error without leaking their message. */
export function errorBody(err: unknown, requestId: string): ErrorBody {
  if (err instanceof HalvorError) {
    return {
      error: {
        code: err.code,
        message: err.message,
        ...(err.details !== undefined ? { details: err.details } : {}),
        request_id: requestId,
      },
    };
  }
  return { error: { code: 'internal_error', message: 'Internal error', request_id: requestId } };
}
