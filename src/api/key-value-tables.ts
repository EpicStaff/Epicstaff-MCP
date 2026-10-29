import type { ApiClient } from '../http/client.js';
import type { AuthorshipFields } from '../models/authorship.js';
import type { Paginated } from './paging.js';
import { unwrap } from './paging.js';

/**
 * Key-Value tables API — ported from
 * features/key-value-tables/services/key-value-tables-api.service.ts + models/key-value-table.model.ts.
 * Tables are org-scoped and name-unique per org (case-insensitive); deleting one moves it to the
 * recycle bin. Entries are normally read and written by key-value nodes at run time; the entry
 * routes are the editor's hand-edit path.
 */
export interface KeyValueTable extends Partial<AuthorshipFields> {
  id: number;
  name: string;
  description?: string;
  entry_count?: number;
  created_at?: string;
  updated_at?: string;
}

export interface CreateKeyValueTableRequest {
  name: string;
  description?: string;
}

export type UpdateKeyValueTableRequest = Partial<CreateKeyValueTableRequest>;

/** `GET key-value-tables/{id}/usage/`: the key-value nodes bound to the table, and their flows. */
export interface KeyValueTableUsage {
  node_count: number;
  flow_count: number;
}

/** The full entry: `GET key-value-table-entries/{id}/` and the create / update responses. */
export interface KeyValueTableEntry {
  id: number;
  table: number;
  key: string;
  value: unknown;
  created_at: string;
  updated_at: string;
  updated_by_session: number | null;
  updated_by_graph: number | null;
  updated_by_graph_name: string | null;
}

/** A row of the entries list: no `value` (up to 256 KiB each), only the start of its JSON text. */
export interface KeyValueTableEntryListItem extends Omit<KeyValueTableEntry, 'value'> {
  value_preview: string;
  value_truncated: boolean;
}

export type KeyValueEntryOrdering = 'key' | '-key' | 'session' | '-session' | 'updated_at' | '-updated_at';

export interface KeyValueEntriesQuery {
  table: number;
  search?: string;
  ordering?: KeyValueEntryOrdering;
  /** The backend caps a page at 100 (KeyValueTableEntryPagination). */
  limit: number;
  offset: number;
}

export interface KeyValueEntryLookup {
  exists: boolean;
  value_preview: string | null;
  updated_at: string | null;
}

export class KeyValueTablesApi {
  constructor(private readonly client: ApiClient) {}

  async list(): Promise<KeyValueTable[]> {
    return unwrap(
      await this.client.get<Paginated<KeyValueTable> | KeyValueTable[]>('key-value-tables/', {
        query: { limit: 1000 },
      }),
    );
  }

  /** Table names are unique per org, case-insensitively (KeyValueTableSerializer). */
  async findByName(name: string): Promise<KeyValueTable | undefined> {
    const wanted = name.toLowerCase();
    return (await this.list()).find((table) => table.name.toLowerCase() === wanted);
  }

  async create(request: CreateKeyValueTableRequest): Promise<KeyValueTable> {
    return this.client.post('key-value-tables/', { body: request });
  }

  async update(id: number, request: UpdateKeyValueTableRequest): Promise<KeyValueTable> {
    return this.client.patch(`key-value-tables/${id}/`, { body: request });
  }

  /** Moves the table and its entries to the recycle bin. */
  async delete(id: number): Promise<void> {
    await this.client.delete<void>(`key-value-tables/${id}/`);
  }

  async usage(id: number): Promise<KeyValueTableUsage> {
    return this.client.get<KeyValueTableUsage>(`key-value-tables/${id}/usage/`);
  }

  async listEntries(query: KeyValueEntriesQuery): Promise<Paginated<KeyValueTableEntryListItem>> {
    return this.client.get<Paginated<KeyValueTableEntryListItem>>('key-value-table-entries/', {
      query: {
        table: query.table,
        limit: query.limit,
        offset: query.offset,
        ...(query.search ? { search: query.search } : {}),
        ...(query.ordering ? { ordering: query.ordering } : {}),
      },
    });
  }

  async getEntry(id: number): Promise<KeyValueTableEntry> {
    return this.client.get<KeyValueTableEntry>(`key-value-table-entries/${id}/`);
  }

  async createEntry(request: { table: number; key: string; value: unknown }): Promise<KeyValueTableEntry> {
    return this.client.post<KeyValueTableEntry>('key-value-table-entries/', { body: request });
  }

  async updateEntry(id: number, request: { key?: string; value?: unknown }): Promise<KeyValueTableEntry> {
    return this.client.patch<KeyValueTableEntry>(`key-value-table-entries/${id}/`, { body: request });
  }

  async deleteEntry(id: number): Promise<void> {
    await this.client.delete<void>(`key-value-table-entries/${id}/`);
  }

  /** Which of `keys` exist in the table (`POST key-value-tables/{id}/entries/lookup/`). */
  async lookupEntries(tableId: number, keys: string[]): Promise<Record<string, KeyValueEntryLookup>> {
    return this.client.post<Record<string, KeyValueEntryLookup>>(`key-value-tables/${tableId}/entries/lookup/`, {
      body: { keys },
    });
  }
}
