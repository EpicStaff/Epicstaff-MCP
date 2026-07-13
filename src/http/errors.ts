import type { ValidationIssue } from '../util/result.js';

/**
 * Normalized API error. Mirrors the frontend's two-tier model:
 * structured validation errors (validation-errors.interceptor.ts) vs everything else.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    message: string,
    readonly validationErrors?: ValidationIssue[],
    readonly bodyExcerpt?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface BackendValidationBody {
  errors: Array<{ field?: unknown; value?: unknown; reason?: unknown }>;
}

function isValidationBody(body: unknown): body is BackendValidationBody {
  return (
    typeof body === 'object' &&
    body !== null &&
    Array.isArray((body as BackendValidationBody).errors) &&
    (body as BackendValidationBody).errors.every((item) => typeof item === 'object' && item !== null)
  );
}

/** Build an ApiError from a non-2xx response, extracting structured validation errors when present. */
export async function toApiError(response: Response, url: string): Promise<ApiError> {
  const raw = await response.text().catch(() => '');
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    body = undefined;
  }

  if ((response.status === 400 || response.status === 422) && isValidationBody(body)) {
    const issues: ValidationIssue[] = body.errors.map((item) => ({
      field: String(item.field ?? ''),
      value: item.value,
      reason: String(item.reason ?? ''),
    }));
    const summary = issues.map((issue) => `${issue.field}: ${issue.reason}`).join('; ');
    return new ApiError(response.status, url, `Validation failed — ${summary}`, issues, excerpt(raw));
  }

  if (response.status === 403) {
    return new ApiError(
      response.status,
      url,
      'Forbidden — the current user/organization lacks permission for this operation.',
      undefined,
      excerpt(raw),
    );
  }

  return new ApiError(response.status, url, `Request failed with HTTP ${response.status}`, undefined, excerpt(raw));
}

function excerpt(raw: string): string | undefined {
  if (!raw) return undefined;
  return raw.length > 600 ? `${raw.slice(0, 600)}…` : raw;
}
