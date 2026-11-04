/**
 * Find one node of a remote graph by backend id or by node name (the flow-source node key) — the
 * lookup behind the tools that act on a single saved node (code test runs, trigger test runs).
 */

/** A node of one kind, as the graph DTO lists it. */
export interface NodeCandidate<Kind extends string = string> {
  kind: Kind;
  node: { id: number; node_name: string };
}

/**
 * The candidate `ref` names: a number matches the backend id, a string the exact node name. Ids of
 * different node kinds come from different tables, so an id can match twice — then the caller must
 * narrow the kind.
 */
export function pickGraphNode<Candidate extends NodeCandidate>(
  candidates: readonly Candidate[],
  ref: number | string,
  graphId: number,
  wantedLabel: string,
): Candidate {
  const matches =
    typeof ref === 'number'
      ? candidates.filter((candidate) => candidate.node.id === ref)
      : candidates.filter((candidate) => candidate.node.node_name === ref);
  if (matches.length === 1 && matches[0] !== undefined) return matches[0];
  if (matches.length > 1) {
    throw new Error(
      `Node ${JSON.stringify(ref)} is ambiguous in graph #${graphId}: it matches ` +
        `${matches.map((match) => `${match.kind} "${match.node.node_name}" (#${match.node.id})`).join(', ')}. ` +
        'Pass node_type to choose one.',
    );
  }
  const available = candidates
    .map((candidate) => `${candidate.kind} "${candidate.node.node_name}" (id ${candidate.node.id})`)
    .slice(0, 30)
    .join(', ');
  throw new Error(
    `No ${wantedLabel} ${JSON.stringify(ref)} in graph #${graphId}. ${
      available ? `Available: ${available}.` : `The graph has no ${wantedLabel}.`
    } Push the flow first if the node exists only in local flow source.`,
  );
}
