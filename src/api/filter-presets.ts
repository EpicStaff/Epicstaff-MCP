import type { ApiClient } from '../http/client.js';
import { type Paginated, unwrap } from './paging.js';

/**
 * Saved list-filter presets of the flows and tools pages — ported from
 * features/flows/services/flow-filter-presets-api.service.ts + models/flow-filter-preset.model.ts and
 * features/tools/services/tool-filter-presets-api.service.ts + models/tool-filter-preset.model.ts.
 *
 * Backend: FlowFilterPresetViewSet / ToolFilterPresetViewSet — org-scoped and private to their author
 * (another user's preset is a 404), gated on FLOWS / TOOLS read for every action. Names are unique per
 * author and organization. `filter_body` is the page's filter state; the backend only checks its
 * top-level keys and their types (tables/validators/{flow,tool}_filter_body_validator.py).
 */
export type FilterPresetScope = 'flow' | 'tool';

export interface FilterPreset {
  id: number;
  name: string;
  filter_body: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface FilterPresetCreate {
  name: string;
  filter_body: Record<string, unknown>;
}

export interface FilterPresetUpdate {
  name?: string;
  filter_body?: Record<string, unknown>;
}

const FILTER_PRESET_PATHS: Record<FilterPresetScope, string> = {
  flow: 'flow-filter-presets/',
  tool: 'tool-filter-presets/',
};

/**
 * The `filter_body` keys each scope accepts (`FlowsFilterState` / `ToolsFilterState` minus the
 * transient search term) — the backend rejects any other key.
 */
export const FILTER_BODY_KEYS: Record<FilterPresetScope, readonly string[]> = {
  flow: ['sortOrder', 'includedFlowIds', 'includedLabelIds', 'customConditions'],
  tool: [
    'showFavoriteOnly',
    'showNotFavoriteOnly',
    'sourceBuiltIn',
    'sourceCustom',
    'usageBuckets',
    'unusedOnly',
    'sortOrder',
    'includedToolIds',
    'includedLabelIds',
    'customConditions',
  ],
};

export class FilterPresetsApi {
  constructor(private readonly client: ApiClient) {}

  /** The caller's presets in the active organization (`getPresets`: one page of up to 1000). */
  async list(scope: FilterPresetScope): Promise<FilterPreset[]> {
    return unwrap(
      await this.client.get<Paginated<FilterPreset> | FilterPreset[]>(FILTER_PRESET_PATHS[scope], {
        query: { limit: 1000 },
      }),
    );
  }

  async create(scope: FilterPresetScope, payload: FilterPresetCreate): Promise<FilterPreset> {
    return this.client.post<FilterPreset>(FILTER_PRESET_PATHS[scope], { body: payload });
  }

  async update(scope: FilterPresetScope, id: number, changes: FilterPresetUpdate): Promise<FilterPreset> {
    return this.client.patch<FilterPreset>(`${FILTER_PRESET_PATHS[scope]}${id}/`, { body: changes });
  }

  async delete(scope: FilterPresetScope, id: number): Promise<void> {
    await this.client.delete<void>(`${FILTER_PRESET_PATHS[scope]}${id}/`);
  }
}
