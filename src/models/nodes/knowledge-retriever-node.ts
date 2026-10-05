/**
 * Knowledge-retriever node — searches one RAG of a source collection and writes the
 * joined results to `output_variable_path`. Wire list is `knowledge_node_list`.
 * Ported from frontend `pages/flows-page/components/flow-visual-programming/models/knowledge-retriever-node.model.ts`,
 * `shared/models/agent-search-config.model.ts`, and the bulk-save emission in
 * `visual-programming/utils/save/payload.ts`.
 */

import type { NodeDtoMetadata } from '../graph.js';

export type RagType = 'naive' | 'graph';

export type GraphSearchMethod = 'basic' | 'local' | 'global' | 'drift';

/**
 * `AgentSearchConfigs` — per-RAG search parameters. The nested config objects are
 * passed through verbatim (the backend's NestedSearchConfigSerializer validates them).
 */
export interface AgentSearchConfigs {
  naive?: Record<string, unknown> | null;
  graph?: ({ search_method: GraphSearchMethod } & Record<string, unknown>) | null;
}

export interface KnowledgeRetrieverNodeData {
  source_collection: number | null;
  rag_type: RagType | null;
  /** The RAG impl id (`naive_rag_id` / `graph_rag_id`) surfaced by `available-rags/`. */
  rag_id: number | null;
  /** Query template; `{name}` placeholders are filled from `input_map` at run time. */
  query: string;
  search_method: GraphSearchMethod | null;
  search_configs: AgentSearchConfigs | null;
}

export interface KnowledgeRetrieverNodeDto {
  id: number;
  graph: number | null;
  source_collection: number | null;
  search_configs: AgentSearchConfigs | null;
  created_at?: string;
  updated_at?: string;
  metadata: Record<string, unknown>;
  node_name: string;
  input_map: Record<string, unknown>;
  output_variable_path: string | null;
  query: string;
  /** Write-only on the backend — absent from reads. */
  search_method?: GraphSearchMethod | null;
  rag_type: RagType | null;
  rag_id: number | null;
  content_hash?: string | null;
}

export interface KnowledgeRetrieverNodeWrite {
  node_name: string;
  graph: number;
  input_map: Record<string, unknown>;
  output_variable_path: string | null;
  source_collection: number | null;
  rag_type: RagType | null;
  rag_id: number | null;
  query: string;
  search_method: GraphSearchMethod | null;
  search_configs: AgentSearchConfigs | null;
  metadata: NodeDtoMetadata;
}
