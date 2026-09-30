import { KnowledgeApi } from '../api/knowledge.js';
import { type BuildArtifact, collectRefs, parseRagRefKey } from '../compiler/artifact.js';
import type { AppContext } from '../context.js';
import { logger } from '../util/logger.js';

/**
 * Collection-RAG resolver for knowledge-retriever nodes.
 *
 * A knowledge-retriever node addresses a RAG by `(source_collection, rag_type, rag_id)`,
 * where `rag_id` is the RAG impl id that `source-collections/{id}/available-rags/`
 * surfaces (backend KnowledgeNodeValidator). The compiler emits it as
 * `{$ref: "<collection ref>#rag:<type>"}` (see `ragRefKey`). For a collection defined in
 * this flow the entity pusher already put the id in the idMap (it attached the RAG);
 * this fills the rest — `existing:` collections — from the backend. Nothing is created.
 */
export async function resolveRagRefs(
  artifact: BuildArtifact,
  idMap: Map<string, number>,
  context: AppContext,
): Promise<Map<string, number>> {
  const resolved = new Map<string, number>();
  const knowledge = new KnowledgeApi(context.client);

  for (const refKey of collectRefs(artifact.graph)) {
    const ragRef = parseRagRefKey(refKey);
    if (ragRef === null || idMap.has(refKey)) continue;

    const collectionId = idMap.get(ragRef.collectionRefKey);
    if (collectionId === undefined) {
      throw new Error(
        `Knowledge-retriever RAG ref "${refKey}" names collection "${ragRef.collectionRefKey}", which was not ` +
          'resolved — compiler ordering bug.',
      );
    }
    const candidates = (await knowledge.listAvailableRags(collectionId)).filter(
      (rag) => rag.rag_type === ragRef.ragType,
    );
    if (candidates.length === 0) {
      throw new Error(
        `Collection #${collectionId} (${ragRef.collectionRefKey}) has no ${ragRef.ragType} RAG. Attach and index one ` +
          `in EpicStaff, or set rag: to the type it has.`,
      );
    }
    // Several RAGs of one type: the most recently created one is the live configuration.
    const newest = [...candidates].sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')))[0]!;
    if (candidates.length > 1) {
      logger.info(
        `Collection #${collectionId} has ${candidates.length} ${ragRef.ragType} RAGs — using the newest (#${newest.rag_id})`,
      );
    }
    resolved.set(refKey, newest.rag_id);
  }

  return resolved;
}
