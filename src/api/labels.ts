import type { ApiClient } from '../http/client.js';
import { type Paginated, unwrap } from './paging.js';

/**
 * Labels API — ported from features/flows/services/labels-api.service.ts (`labels/`, flow labels)
 * and features/tools/services/tools-labels.service.ts (`tool-labels/`, tool labels), with the DTOs
 * of shared/models/label.model.ts. Backend: LabelViewSet / ToolLabelViewSet (BaseLabelViewSet) —
 * org-scoped, two independent label trees that never share rows. A label nests under a `parent`;
 * names are unique per parent. Flows carry labels as `label_ids` (graph PATCH), tools as `labels`.
 */
export type LabelScope = 'flow' | 'tool';

export const LABEL_COLORS = ['default', 'purple', 'blue', 'green', 'orange', 'red'] as const;
export type LabelColor = (typeof LABEL_COLORS)[number];

export interface LabelDto {
  id: number;
  name: string;
  parent: number | null;
  /** "parent/child" path within the scope's tree. */
  full_path: string;
  created_at: string;
  metadata: { color?: LabelColor };
}

export interface CreateLabelRequest {
  name: string;
  parent?: number | null;
  metadata?: { color?: LabelColor };
}

/** `PatchLabelRequest` widened with `parent`, which the backend's PATCH also accepts. */
export type PatchLabelRequest = Partial<CreateLabelRequest>;

const LABEL_PATHS: Record<LabelScope, string> = { flow: 'labels/', tool: 'tool-labels/' };

export class LabelsApi {
  constructor(private readonly client: ApiClient) {}

  async list(scope: LabelScope): Promise<LabelDto[]> {
    return unwrap(
      await this.client.get<Paginated<LabelDto> | LabelDto[]>(LABEL_PATHS[scope], { query: { limit: 1000 } }),
    );
  }

  async create(scope: LabelScope, request: CreateLabelRequest): Promise<LabelDto> {
    return this.client.post<LabelDto>(LABEL_PATHS[scope], { body: request });
  }

  async patch(scope: LabelScope, id: number, request: PatchLabelRequest): Promise<LabelDto> {
    return this.client.patch<LabelDto>(`${LABEL_PATHS[scope]}${id}/`, { body: request });
  }

  /** Deletes the label and its child labels (CASCADE); flows/tools only lose the tag. */
  async delete(scope: LabelScope, id: number): Promise<void> {
    await this.client.delete<void>(`${LABEL_PATHS[scope]}${id}/`);
  }
}
