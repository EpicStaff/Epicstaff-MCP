import type { Diagnostic } from '../flow-source/diagnostics.js';
import type { GraphState } from '../graph/graph-state.js';

/**
 * The compiler ↔ pusher contract.
 *
 * `build` is pure and local: it validates the flow source, computes layout, and emits
 * payload TEMPLATES. Backend ids of dependencies are not known at build time, so any
 * position in a payload that needs one carries a `SymbolicRef` placeholder
 * (`{$ref: "agents.researcher"}`). The pusher walks `entities` in order (already
 * dependency-sorted), obtains each backend id (lockfile hit, remote lookup for
 * `existing:` references, or a create call), and substitutes placeholders before POSTing.
 */
export interface SymbolicRef {
  $ref: string; // "<section>.<name>", e.g. "surfaces.web_research"
}

export function isSymbolicRef(value: unknown): value is SymbolicRef {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as SymbolicRef).$ref === 'string' &&
    Object.keys(value as object).length === 1
  );
}

/** Deep-replace every SymbolicRef with the backend id `resolve` returns. */
export function substituteRefs<T>(value: T, resolve: (key: string) => number): T {
  if (isSymbolicRef(value)) {
    return resolve(value.$ref) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => substituteRefs(item, resolve)) as unknown as T;
  }
  if (typeof value === 'object' && value !== null) {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      result[key] = substituteRefs(entry, resolve);
    }
    return result as T;
  }
  return value;
}

/** Collect the ref keys used inside a payload template (for dependency checks). */
export function collectRefs(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (isSymbolicRef(value)) {
    into.add(value.$ref);
  } else if (Array.isArray(value)) {
    for (const item of value) collectRefs(item, into);
  } else if (typeof value === 'object' && value !== null) {
    for (const entry of Object.values(value)) collectRefs(entry, into);
  }
  return into;
}

export type EntityKind =
  | 'secret'
  | 'key_value_table'
  | 'llm_config'
  | 'tool_config'
  | 'python_code_tool'
  | 'mcp_tool'
  | 'knowledge_collection'
  | 'surface'
  | 'agent_definition';

/** How the pusher obtains this entity's backend id. */
export type EntityAction =
  /** Defined locally — create (or update when the lockfile has a stale hash). */
  | 'upsert'
  /** `existing:` reference — look up by name remotely; never created or modified. */
  | 'resolve-existing'
  /**
   * Org-level resource identified by name (secrets, key-value tables): look it up by
   * name on EVERY push and create it only when missing. Never cached in the lockfile —
   * the remote row may have been deleted or (for secrets) must be re-verified.
   */
  | 'ensure';

/**
 * Ref-key suffix for "the RAG of this collection": `<collection ref>#rag:<naive|graph>`
 * resolves to the RAG impl id (`naive_rag_id` / `graph_rag_id`) a knowledge-retriever
 * node searches. The pusher fills it from the lockfile (local collections) or from
 * `source-collections/{id}/available-rags/` (existing ones).
 */
export function ragRefKey(collectionRefKey: string, ragType: 'naive' | 'graph'): string {
  return `${collectionRefKey}#rag:${ragType}`;
}

const RAG_REF_KEY = /^(.+)#rag:(naive|graph)$/;

export function parseRagRefKey(refKey: string): { collectionRefKey: string; ragType: 'naive' | 'graph' } | null {
  const match = RAG_REF_KEY.exec(refKey);
  if (!match) return null;
  return { collectionRefKey: match[1] as string, ragType: match[2] as 'naive' | 'graph' };
}

export interface RagPlan {
  strategy: 'naive' | 'graph';
  /** Backend id or SymbolicRef to an embedding config; resolved by the pusher. */
  embedder: number | SymbolicRef;
  /** graph strategy only. */
  llm?: number | SymbolicRef;
  /**
   * graph strategy only: index configuration applied via
   * `PUT graph-rag/{id}/index-config/` before indexing starts.
   * Present only when the author set at least one field — omitted fields keep
   * backend defaults AND keep the rag content hash stable for existing flows.
   */
  index_config?: {
    chunk_size?: number;
    chunk_overlap?: number;
    entity_types?: string[];
    max_gleanings?: number;
  };
  /**
   * naive strategy only: per-document chunking applied via the
   * document-configs bulk-update endpoint before indexing starts.
   * Present only when the author set at least one field (same hash-stability
   * contract as index_config).
   */
  document_chunking?: {
    chunk_size?: number;
    chunk_overlap?: number;
  };
}

export interface EntityPlan {
  /** Lockfile key: "<section>.<name>". */
  key: string;
  section: string;
  name: string;
  kind: EntityKind;
  action: EntityAction;
  /** action=resolve-existing / ensure: the remote entity name to look up. */
  remoteName?: string;
  /** action=upsert / ensure: payload template (may contain SymbolicRef / template placeholders). */
  payload?: Record<string, unknown>;
  /** action=upsert: content hash over the source definition (lockfile dirty check). */
  contentHash?: string;
  /** knowledge_collection only: absolute paths of documents to upload. */
  documents?: string[];
  /** knowledge_collection only: RAG strategy to attach + index. */
  rag?: RagPlan;
}

export interface BuildArtifact {
  flowName: string;
  description?: string;
  diagnostics: Diagnostic[];
  /** Dependency-ordered entity plans (safe to push sequentially). */
  entities: EntityPlan[];
  /**
   * Desired graph state, laid out (metadata.position/size set on every node).
   * Node data fields that need backend ids carry SymbolicRef placeholders —
   * substitute before diffing against the remote state.
   */
  graph: GraphState;
  /** Human-readable build summary (nodes per type, entity actions, layout bounds). */
  summary: Record<string, unknown>;
}
