import type { ApiClient } from '../http/client.js';

/**
 * Key-Value tables API — ported from
 * features/key-value-tables/services/key-value-tables-api.service.ts (table CRUD only;
 * entries are read and written by key-value nodes at run time).
 */
export interface KeyValueTable {
  id: number;
  name: string;
  description?: string;
  entry_count?: number;
  created_at?: string;
  updated_at?: string;
}

interface Paginated<T> {
  count: number;
  results: T[];
}

export class KeyValueTablesApi {
  constructor(private readonly client: ApiClient) {}

  async list(): Promise<KeyValueTable[]> {
    const response = await this.client.get<Paginated<KeyValueTable> | KeyValueTable[]>('key-value-tables/', {
      query: { limit: 1000 },
    });
    return Array.isArray(response) ? response : response.results;
  }

  /** Table names are unique per org, case-insensitively (KeyValueTableSerializer). */
  async findByName(name: string): Promise<KeyValueTable | undefined> {
    const wanted = name.toLowerCase();
    return (await this.list()).find((table) => table.name.toLowerCase() === wanted);
  }

  async create(request: { name: string; description?: string }): Promise<KeyValueTable> {
    return this.client.post('key-value-tables/', { body: request });
  }
}
