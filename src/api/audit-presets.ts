import type { ApiClient } from '../http/client.js';
import type { AuditMatchScope } from './audit.js';
import { type Paginated, unwrap } from './paging.js';

/**
 * Saved audit-search filters — ported from frontend `features/audit/services/audit-presets-api.service.ts`
 * with the DTOs of `features/audit/models/audit-preset.models.ts`. Backend: AuditFilterPresetViewSet
 * (tables/views/model_view_sets.py) — org-scoped, gated on `audit: read` for every action. A preset is
 * private to its author or shared with the organization (one-way); only the author may edit or delete
 * it, and a colleague's private preset answers 404. Deleting is permanent (no recycle bin).
 */

/**
 * The auditor search body plus the frontend-only `ui_state` (the filter panel), which is never sent
 * to the auditor. Keys checked by tables/validators/audit_filter_body_validator.py.
 */
export interface AuditPresetBody {
  filters?: Record<string, unknown>;
  query?: string;
  match_scope?: AuditMatchScope;
  cursor?: string;
  size?: number;
  ui_state?: Record<string, unknown>;
}

export interface AuditPreset {
  id: number;
  name: string;
  filter_body: AuditPresetBody;
  is_owner: boolean;
  is_shared: boolean;
  created_by_name: string;
  created_at: string;
  updated_at: string;
}

/** Only the author may PATCH; sharing is one-way, so `is_shared` is only ever sent as true. */
export interface AuditPresetChanges {
  name?: string;
  filter_body?: AuditPresetBody;
  is_shared?: true;
}

export class AuditPresetsApi {
  constructor(private readonly client: ApiClient) {}

  /** The caller's own presets plus every shared one. */
  async list(): Promise<AuditPreset[]> {
    return unwrap(
      await this.client.get<Paginated<AuditPreset> | AuditPreset[]>('audit-filter-presets/', { query: { limit: 1000 } }),
    );
  }

  async create(name: string, filterBody: AuditPresetBody, isShared: boolean): Promise<AuditPreset> {
    return this.client.post<AuditPreset>('audit-filter-presets/', {
      body: { name, filter_body: filterBody, is_shared: isShared },
    });
  }

  async update(id: number, changes: AuditPresetChanges): Promise<AuditPreset> {
    return this.client.patch<AuditPreset>(`audit-filter-presets/${id}/`, { body: changes });
  }

  async delete(id: number): Promise<void> {
    await this.client.delete<void>(`audit-filter-presets/${id}/`);
  }
}
