/**
 * Audio transcription node — the wire list is `audio_transcription_node_list`.
 * Ported from frontend `visual-programming/core/models/audio-to-text.model.ts` + bulk-save emission in `visual-programming/utils/save/payload.ts`.
 */

import type { AuthorshipFields, NumberedNodeDto } from '../authorship.js';
import type { NodeDtoMetadata } from '../graph.js';

export interface AudioToTextNodeDto extends AuthorshipFields, NumberedNodeDto {
  id: number;
  created_at: string;
  node_name: string;
  graph: number;
  input_map: Record<string, unknown>;
  output_variable_path: string | null;
  metadata: Record<string, unknown>;
}

export interface AudioToTextNodeWrite {
  node_name: string;
  graph: number;
  input_map: Record<string, unknown>;
  output_variable_path: string | null;
  metadata: NodeDtoMetadata;
}
