/**
 * Bulk delete — ported from frontend `shared/models/bulk-delete/bulk-delete.model.ts` and
 * `shared/utils/bulk-delete-params.util.ts`. Backend: BulkDeleteActionMixin (tables/views/mixins.py):
 * `POST <list>/bulk-delete/` with `{ids}`; `?dry_run=true` reports what would happen and the usage
 * that blocks a delete, without deleting. A single DELETE runs the same usage rule.
 */
export type BulkDeleteSkipReason = 'in_use_restricted' | 'protected';

export interface BulkDeleteUsageRef {
  resource_type: string;
  id: number;
  name: string | null;
}

export interface BulkDeleteUsageBucket {
  resource_type: string;
  visible_count: number;
  visible_sample: BulkDeleteUsageRef[];
  truncated: boolean;
}

export interface BulkDeleteUsageReport {
  blocked: boolean;
  by_resource_type: BulkDeleteUsageBucket[];
}

export interface BulkDeleteSkippedEntry {
  id: number;
  reason: BulkDeleteSkipReason;
}

export interface BulkDeleteResponse {
  dry_run: boolean;
  deleted_count: number;
  deleted_ids: number[];
  deletable_ids: number[];
  not_found_ids: number[];
  skipped: BulkDeleteSkippedEntry[];
  /** Keyed by entity id as a string; filled on dry run only, `{}` on a real delete. */
  usage: Record<string, BulkDeleteUsageReport>;
}

/** `bulkDeleteParams`: only a dry run sends a query parameter. */
export function bulkDeleteQuery(dryRun: boolean): Record<string, string> | undefined {
  return dryRun ? { dry_run: 'true' } : undefined;
}
