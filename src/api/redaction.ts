import { ApiError } from '../http/errors.js';

/**
 * Error hygiene for requests that carry a credential (a new user's password, the first superadmin's
 * password). The backend already redacts password fields in its validation envelope
 * (rbac/validation/base.py `_echo`), but a failure must never put a credential into a tool result or
 * a log line even if a backend version echoes it — so the raw body excerpt is dropped, every
 * sensitive field's `value` is replaced, and any echo of the credential itself is cut from the text.
 */
export const REDACTED_VALUE = '[redacted]';

export interface SensitiveInput {
  /** Request field that carries the credential. */
  field: string;
  /** The credential itself — scrubbed wherever it appears in the error text. */
  value: string;
}

export async function withRedactedErrors<T>(sensitive: readonly SensitiveInput[], call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    const sensitiveFields = new Set(sensitive.map((input) => input.field));
    const scrub = (text: string): string =>
      sensitive.reduce((scrubbed, input) => (input.value ? scrubbed.split(input.value).join(REDACTED_VALUE) : scrubbed), text);
    const issues = error.validationErrors?.map((issue) => ({
      field: issue.field,
      value: sensitiveFields.has(issue.field) ? REDACTED_VALUE : issue.value,
      reason: scrub(issue.reason),
    }));
    const summary = issues?.length ? issues.map((issue) => `${issue.field}: ${issue.reason}`).join('; ') : undefined;
    const message = summary ? `Validation failed — ${summary}` : scrub(`${error.message}${backendReason(error.bodyExcerpt)}`);
    // No bodyExcerpt: it is the raw response body, which is exactly what may echo the credential.
    throw new ApiError(error.status, error.url, message, issues);
  }
}

/**
 * The backend's own reason from its `{status_code, code, message}` envelope
 * (utils/exception_handler.py) or a FastAPI `{detail}` body, as " — <code>: <message>";
 * '' when the body is neither.
 */
export function backendReason(bodyExcerpt: string | undefined): string {
  if (!bodyExcerpt) return '';
  try {
    const body = JSON.parse(bodyExcerpt) as { code?: unknown; message?: unknown; detail?: unknown };
    const message =
      typeof body.message === 'string' ? body.message : typeof body.detail === 'string' ? body.detail : undefined;
    if (message === undefined) return '';
    return typeof body.code === 'string' ? ` — ${body.code}: ${message}` : ` — ${message}`;
  } catch {
    return '';
  }
}
