import type { ApiClient } from '../http/client.js';
import type { UserSummary } from '../models/authorship.js';
import { type UserSession, withUserSession } from './user-session.js';

/**
 * Recycle bin API — ported from features/recycle-bin/services/recycle-bin-api.service.ts,
 * constants/recycle-bin-sources.constants.ts, models/recycle-bin.model.ts and
 * services/recycle-bin/recycle-bin-settings-api.service.ts.
 *
 * Every deletable resource has its own bin hanging off its list URL (`<list>/recycle-bin/`), with
 * bulk `restore/` and `purge/` bodies of `{ids}` (1–100). Backend: RecycleBinActionsMixin
 * (tables/views/recycle_bin_mixins.py) — org-scoped; a row of another org is a 404.
 *
 * Two routes refuse API keys, so they carry the user-session bearer token instead:
 *  - every purge (`purge_permissions`: superadmin only, never an API key — a purge cannot be undone);
 *  - the secrets bin (SecretViewSet is closed to personal API keys).
 */

/** One backend bin endpoint family. */
export type RecycleBinSourceKey =
  | 'flow'
  | 'agent'
  | 'surface'
  | 'python_tool'
  | 'mcp_tool'
  | 'collection'
  | 'key_value_table'
  | 'secret'
  | 'realtime_channel'
  | 'webhook_trigger'
  | 'storage';

interface RecycleBinSourceDefinition {
  /** List URL relative to the API root; the bin endpoints hang off it. */
  path: string;
  /** The Kind label the editor shows. */
  kind: string;
}

/** Every source of the bin, once (RECYCLE_BIN_SOURCES). */
export const RECYCLE_BIN_SOURCES: Record<RecycleBinSourceKey, RecycleBinSourceDefinition> = {
  storage: { path: 'storage/', kind: 'File or folder' },
  flow: { path: 'graphs/', kind: 'Flow' },
  agent: { path: 'agent-definitions/', kind: 'Agent' },
  surface: { path: 'surfaces/', kind: 'Surface' },
  python_tool: { path: 'python-code-tool/', kind: 'Python tool' },
  mcp_tool: { path: 'mcp-tools/', kind: 'MCP tool' },
  collection: { path: 'source-collections/', kind: 'Collection' },
  key_value_table: { path: 'key-value-tables/', kind: 'Key-value table' },
  secret: { path: 'secrets/', kind: 'Secret' },
  realtime_channel: { path: 'realtime-channels/', kind: 'Voice channel' },
  webhook_trigger: { path: 'webhook-triggers/', kind: 'Webhook trigger' },
};

export const RECYCLE_BIN_SOURCE_KEYS = Object.keys(RECYCLE_BIN_SOURCES) as RecycleBinSourceKey[];

/** Rows per page of every bin list; the backend caps a page at 100 (RecycleBinPagination). */
export const RECYCLE_BIN_PAGE_SIZE = 50;
export const RECYCLE_BIN_MAX_PAGE_SIZE = 100;

/** The bulk endpoints take at most this many ids per call. */
export const RECYCLE_BIN_BULK_ID_LIMIT = 100;

export interface GetRecycleBinContentResponse {
  name: string;
  kind: string;
}

export interface GetRecycleBinHiddenContentsResponse {
  kind: string;
  count: number;
}

export type GetRecycleBinDetailResponse =
  | { label: string; value: string | number | null; format: 'text' | 'date' | 'size' | 'notice' }
  | { label: string; value: UserSummary | null; format: 'user' };

export interface GetRecycleBinEntryResponse {
  id: number;
  name: string;
  /** ISO 8601 */
  deleted_at: string;
  days_left: number;
  details: GetRecycleBinDetailResponse[];
  /** At most 100, only the ones the user may read; `contents_total` has the full count. */
  contents: GetRecycleBinContentResponse[];
  hidden_contents: GetRecycleBinHiddenContentsResponse[];
  contents_total: number;
  /** Storage rows only. */
  item_type?: 'file' | 'folder';
}

export interface GetRecycleBinPageResponse {
  count: number;
  next: string | null;
  previous: string | null;
  results: GetRecycleBinEntryResponse[];
}

export interface RestoreRecycleBinItemResponse {
  id: number;
  name: string;
  renamed_from: string | null;
  /** Whether everything that used the item is connected again (it kept its links in the bin). */
  links_restored: boolean;
}

export interface RecycleBinBulkFailureResponse {
  id: number;
  name: string;
  message: string;
}

export interface RecycleBinBulkRestoreResponse {
  restored: RestoreRecycleBinItemResponse[];
  failed: RecycleBinBulkFailureResponse[];
}

export interface RecycleBinBulkPurgeResponse {
  purged: number[];
  failed: RecycleBinBulkFailureResponse[];
}

/** Server-side query of a bin list (`search` matches the item's own name). */
export interface RecycleBinListQuery {
  limit: number;
  offset: number;
  search?: string;
  /** `-deleted_at` (default), `deleted_at`, `days_left` or `-days_left`. */
  ordering?: string;
  /** Storage only: `file` or `folder`. */
  itemType?: 'file' | 'folder';
}

/**
 * What a bulk restore acts on: the selected ids (the editor's only form, `RecycleBinSelection`) or
 * `all: true` for every item of the bin (RecycleBinBulkRequestSerializer). MCP sends `all` only to
 * restore — a whole-bin purge is not exposed, it cannot be undone.
 */
export type RecycleBinRestoreSelection = { ids: number[] } | { all: true };

export interface GetRecycleBinSettingsResponse {
  retention_days: number;
}

export class RecycleBinApi {
  constructor(
    private readonly client: ApiClient,
    private readonly session: UserSession,
  ) {}

  /** One page of a bin, normalized to the current entry shape (see {@link normalizeBinPage}). */
  async list(source: RecycleBinSourceKey, query: RecycleBinListQuery): Promise<GetRecycleBinPageResponse> {
    const params = {
      limit: query.limit,
      offset: query.offset,
      ordering: query.ordering ?? '-deleted_at',
      ...(query.search ? { search: query.search } : {}),
      ...(source === 'storage' && query.itemType ? { item_type: query.itemType } : {}),
    };
    const response = await this.call(source, false, (bearerToken) =>
      this.client.get<WireRecycleBinPage | WireRecycleBinEntry[]>(binPath(source), {
        query: params,
        ...bearer(bearerToken),
      }),
    );
    return normalizeBinPage(response, query);
  }

  async restore(source: RecycleBinSourceKey, selection: RecycleBinRestoreSelection): Promise<RecycleBinBulkRestoreResponse> {
    return this.call(source, false, (bearerToken) =>
      this.client.post<RecycleBinBulkRestoreResponse>(`${binPath(source)}restore/`, {
        body: selection,
        ...bearer(bearerToken),
      }),
    );
  }

  /** Delete for good. Superadmin only and refused to API keys — always sent with the user session. */
  async purge(source: RecycleBinSourceKey, ids: number[]): Promise<RecycleBinBulkPurgeResponse> {
    return this.call(source, true, (bearerToken) =>
      this.client.post<RecycleBinBulkPurgeResponse>(`${binPath(source)}purge/`, {
        body: { ids },
        ...bearer(bearerToken),
      }),
    );
  }

  /** Deployment-wide retention: how many days a deleted item stays restorable. */
  async getSettings(): Promise<GetRecycleBinSettingsResponse> {
    return this.client.get<GetRecycleBinSettingsResponse>('recycle-bin/settings/');
  }

  /** Route a call through the user session when the backend refuses API keys for it. */
  private async call<T>(
    source: RecycleBinSourceKey,
    sessionOnly: boolean,
    request: (bearerToken: string | undefined) => Promise<T>,
  ): Promise<T> {
    if (sessionOnly || source === 'secret') {
      return withUserSession(this.session, (bearerToken) => request(bearerToken));
    }
    return request(undefined);
  }
}

/**
 * A bin entry as a backend may send it. `hidden_contents` exists only since upstream bbdd9736e7 (the
 * day d545c7a was cut) — a deployment one release older omits it — and every list field is treated
 * as optional so a missing one reads as empty instead of crashing the caller.
 */
export type WireRecycleBinEntry = Omit<
  GetRecycleBinEntryResponse,
  'details' | 'contents' | 'hidden_contents' | 'contents_total'
> &
  Partial<Pick<GetRecycleBinEntryResponse, 'details' | 'contents' | 'hidden_contents' | 'contents_total'>>;

/** A bin page as a backend may send it (paged since upstream 5cffd81598; a bare array before). */
export interface WireRecycleBinPage {
  count?: number;
  next?: string | null;
  previous?: string | null;
  results?: WireRecycleBinEntry[];
}

export function normalizeBinEntry(entry: WireRecycleBinEntry): GetRecycleBinEntryResponse {
  const contents = entry.contents ?? [];
  const hiddenContents = entry.hidden_contents ?? [];
  return {
    ...entry,
    details: entry.details ?? [],
    contents,
    hidden_contents: hiddenContents,
    contents_total:
      entry.contents_total ?? contents.length + hiddenContents.reduce((total, item) => total + item.count, 0),
  };
}

/**
 * The current page shape from whatever the backend sent. An unpaged list (older backends) is
 * searched and paged here, so callers see the same `count` / `results` contract.
 */
export function normalizeBinPage(
  response: WireRecycleBinPage | WireRecycleBinEntry[],
  query: Pick<RecycleBinListQuery, 'limit' | 'offset' | 'search'>,
): GetRecycleBinPageResponse {
  if (Array.isArray(response)) {
    const wanted = query.search?.trim().toLowerCase();
    const matching = wanted ? response.filter((entry) => entry.name.toLowerCase().includes(wanted)) : response;
    return {
      count: matching.length,
      next: null,
      previous: null,
      results: matching.slice(query.offset, query.offset + query.limit).map(normalizeBinEntry),
    };
  }
  const results = (response.results ?? []).map(normalizeBinEntry);
  return {
    count: response.count ?? results.length,
    next: response.next ?? null,
    previous: response.previous ?? null,
    results,
  };
}

function binPath(source: RecycleBinSourceKey): string {
  return `${RECYCLE_BIN_SOURCES[source].path}recycle-bin/`;
}

function bearer(bearerToken: string | undefined): { bearerToken?: string } {
  return bearerToken === undefined ? {} : { bearerToken };
}
