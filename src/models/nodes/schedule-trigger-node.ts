/** Ported from frontend `models/schedule-trigger.model.ts` + `buildScheduleBlock` in `utils/save/payload.ts`. */

import type { NodeDtoMetadata } from '../graph.js';

export type WeekdayCode = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

export type ScheduleRunMode = 'once' | 'repeat';

export type ScheduleIntervalUnit = 'seconds' | 'minutes' | 'hours' | 'days' | 'weeks' | 'months';

export type ScheduleEndType = 'never' | 'on_date' | 'after_n_runs';

/**
 * Interval block as emitted by the bulk-save builder. `every`/`unit` mirror the
 * client draft state, which may still be null when a repeat schedule is incomplete
 * (the frontend emits them verbatim).
 */
export interface ScheduleIntervalWrite {
  every: number | null;
  unit: ScheduleIntervalUnit | null;
  weekdays: WeekdayCode[];
}

export interface ScheduleEndWrite {
  type: ScheduleEndType;
  date_time: string | null;
  max_runs: number | null;
}

/** Schedule block used in create/update request bodies. */
export interface ScheduleBlockWrite {
  run_mode: ScheduleRunMode;
  start_date_time: string;
  interval: ScheduleIntervalWrite | null;
  end: ScheduleEndWrite;
  timezone: string;
}

// ── Response-side types (nullable sub-fields for draft nodes) ────────────────

export interface GetScheduleIntervalBlock {
  every: number | null;
  unit: ScheduleIntervalUnit | null;
  weekdays: WeekdayCode[];
}

export interface GetScheduleEndBlock {
  type: ScheduleEndType | null;
  date_time: string | null;
  max_runs: number | null;
}

export interface GetScheduleBlock {
  run_mode: ScheduleRunMode | null;
  timezone: string;
  start_date_time: string | null;
  next_run_date_time: string | null;
  interval: GetScheduleIntervalBlock | null;
  end: GetScheduleEndBlock;
}

export interface ScheduleTriggerNodeDto {
  id: number;
  node_name: string;
  graph: number;
  is_active: boolean;
  metadata: Record<string, unknown>;
  content_hash: string;
  created_at: string;
  updated_at: string;
  current_runs: number;
  schedule: GetScheduleBlock | null;
}

/** Bulk-save item body. `schedule: null` (and `is_active: false`) for draft nodes without a start date. */
export interface ScheduleTriggerNodeWrite {
  node_name: string;
  graph: number;
  is_active: boolean;
  metadata: NodeDtoMetadata;
  schedule: ScheduleBlockWrite | null;
}
