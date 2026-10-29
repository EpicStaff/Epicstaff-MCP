/**
 * DRF list envelopes — ported from frontend `core/models/api-request.model.ts` (`ApiGetRequest`).
 * Most list routes use `LimitOffsetPagination`; a few answer a bare array. `unwrap` accepts both.
 */
export interface Paginated<T> {
  count: number;
  next?: string | null;
  previous?: string | null;
  results: T[];
}

export function unwrap<T>(response: Paginated<T> | T[]): T[] {
  return Array.isArray(response) ? response : response.results;
}
