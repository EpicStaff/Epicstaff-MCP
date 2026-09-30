/**
 * Audio transcription node — the wire list is `audio_transcription_node_list`.
 * Ported from frontend `models/audio-to-text.model.ts` + bulk-save emission in `utils/save/payload.ts`.
 */

import type { NodeDtoMetadata } from '../graph.js';

export interface AudioToTextNodeDto {
  id: number;
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
