/**
 * Pure reference resolution over a parsed {@link FlowSource}.
 *
 * Builds a symbol table from the section keys, resolves every cross-reference
 * position, and reports unresolved references, type-mismatched references and
 * circular subgraph references as diagnostics. Successfully resolved
 * references are collected as `{kind: 'local', name}` or
 * `{kind: 'existing', remoteName}`.
 */
import { makeError, type Diagnostic } from './diagnostics.js';
import type {
  EntityRef,
  FlowSource,
  InlineSurfaceSource,
  CatalogSurfaceSource,
} from './schema/index.js';

export type ResolvedRef =
  | { kind: 'local'; name: string }
  | { kind: 'existing'; remoteName: string };

/** Sections that local symbolic references resolve against. */
export type SymbolSection =
  | 'llm_configs'
  | 'tools.tool_configs'
  | 'tools.python_code_tools'
  | 'tools.mcp_tools'
  | 'knowledge'
  | 'surfaces'
  | 'agents'
  | 'nodes';

/** Reference target namespaces that have no local symbol table in this flow. */
export type RemoteOnlySection = 'flows' | 'crews';

export interface ResolvedReference {
  /** Dot path of the reference position, e.g. `agents.researcher.llm_config`. */
  path: string;
  section: SymbolSection | RemoteOnlySection;
  ref: ResolvedRef;
}

export interface ResolvedFlow {
  flowName: string;
  symbols: Record<SymbolSection, string[]>;
  /** Every successfully resolved reference; failures appear only in diagnostics. */
  references: ResolvedReference[];
  diagnostics: Diagnostic[];
}

const SECTION_LABELS: Record<SymbolSection, string> = {
  llm_configs: 'LLM config',
  'tools.tool_configs': 'tool config',
  'tools.python_code_tools': 'python code tool',
  'tools.mcp_tools': 'MCP tool',
  knowledge: 'knowledge collection',
  surfaces: 'surface',
  agents: 'agent',
  nodes: 'node',
};

const MAX_KNOWN_NAMES_IN_MESSAGE = 8;

export function resolveFlow(source: FlowSource): ResolvedFlow {
  const diagnostics: Diagnostic[] = [];
  const references: ResolvedReference[] = [];

  const symbols: Record<SymbolSection, string[]> = {
    llm_configs: Object.keys(source.llm_configs),
    'tools.tool_configs': Object.keys(source.tools.tool_configs),
    'tools.python_code_tools': Object.keys(source.tools.python_code_tools),
    'tools.mcp_tools': Object.keys(source.tools.mcp_tools),
    knowledge: Object.keys(source.knowledge),
    surfaces: Object.keys(source.surfaces),
    agents: Object.keys(source.agents),
    nodes: Object.keys(source.flow.nodes),
  };

  function resolveEntity(ref: EntityRef, section: SymbolSection, path: string): void {
    if (typeof ref !== 'string') {
      references.push({ path, section, ref: { kind: 'existing', remoteName: ref.existing } });
      return;
    }
    if (symbols[section].includes(ref)) {
      references.push({ path, section, ref: { kind: 'local', name: ref } });
      return;
    }
    const otherSection = (Object.keys(symbols) as SymbolSection[]).find(
      (candidate) => candidate !== section && symbols[candidate].includes(ref),
    );
    if (otherSection !== undefined) {
      diagnostics.push(
        makeError(
          path,
          `type mismatch: '${ref}' is defined in section '${otherSection}', but this position expects a ${SECTION_LABELS[section]}`,
        ),
      );
      return;
    }
    diagnostics.push(
      makeError(
        path,
        `unresolved reference '${ref}' — ${knownNamesHint(section, symbols[section])}. ` +
          `Use { existing: "${ref}" } to reference an entity that already exists on the backend.`,
      ),
    );
  }

  function resolveNodeName(name: string, path: string): void {
    if (symbols.nodes.includes(name)) {
      references.push({ path, section: 'nodes', ref: { kind: 'local', name } });
      return;
    }
    diagnostics.push(
      makeError(path, `unknown node '${name}' — ${knownNamesHint('nodes', symbols.nodes)}`),
    );
  }

  function resolveSurfaceBody(
    surface: InlineSurfaceSource | CatalogSurfaceSource,
    basePath: string,
  ): void {
    surface.python_tools.forEach((entry, index) => {
      resolveEntity(entry.tool, 'tools.python_code_tools', `${basePath}.python_tools[${index}].tool`);
    });
    surface.mcp_tools.forEach((entry, index) => {
      resolveEntity(entry.tool, 'tools.mcp_tools', `${basePath}.mcp_tools[${index}].tool`);
    });
    surface.knowledge.forEach((entry, index) => {
      resolveEntity(entry.collection, 'knowledge', `${basePath}.knowledge[${index}].collection`);
    });
  }

  // --- knowledge: graph RAG may reference an LLM config -------------------
  for (const [collectionName, collection] of Object.entries(source.knowledge)) {
    if (collection.rag.strategy === 'graph' && collection.rag.llm_config !== undefined) {
      resolveEntity(
        collection.rag.llm_config,
        'llm_configs',
        `knowledge.${collectionName}.rag.llm_config`,
      );
    }
  }

  // --- catalog surfaces ----------------------------------------------------
  for (const [surfaceName, surface] of Object.entries(source.surfaces)) {
    const basePath = `surfaces.${surfaceName}`;
    resolveSurfaceBody(surface, basePath);
    if (surface.owner_agent !== undefined) {
      resolveEntity(surface.owner_agent, 'agents', `${basePath}.owner_agent`);
    }
  }

  // --- agents ---------------------------------------------------------------
  for (const [agentName, agent] of Object.entries(source.agents)) {
    const basePath = `agents.${agentName}`;
    resolveEntity(agent.llm_config, 'llm_configs', `${basePath}.llm_config`);
    if (agent.fcm_llm_config !== undefined) {
      resolveEntity(agent.fcm_llm_config, 'llm_configs', `${basePath}.fcm_llm_config`);
    }
    agent.default_surfaces.forEach((entry, index) => {
      resolveEntity(entry.surface, 'surfaces', `${basePath}.default_surfaces[${index}].surface`);
    });
  }

  // --- nodes ------------------------------------------------------------------
  for (const [nodeName, node] of Object.entries(source.flow.nodes)) {
    const basePath = `flow.nodes.${nodeName}`;
    switch (node.type) {
      case 'agent':
      case 'task': {
        resolveEntity(node.agent, 'agents', `${basePath}.agent`);
        node.surfaces.forEach((ref, index) => {
          resolveEntity(ref, 'surfaces', `${basePath}.surfaces[${index}]`);
        });
        if (node.inline_surface !== undefined) {
          resolveSurfaceBody(node.inline_surface, `${basePath}.inline_surface`);
        }
        break;
      }
      case 'decision-table': {
        node.rules.forEach((rule, index) => {
          resolveNodeName(rule.next_node, `${basePath}.rules[${index}].next_node`);
        });
        if (node.default_next_node !== undefined) {
          resolveNodeName(node.default_next_node, `${basePath}.default_next_node`);
        }
        break;
      }
      case 'classification-decision-table': {
        resolveEntity(node.llm_config, 'llm_configs', `${basePath}.llm_config`);
        node.categories.forEach((category, index) => {
          resolveNodeName(category.next_node, `${basePath}.categories[${index}].next_node`);
        });
        if (node.default_next_node !== undefined) {
          resolveNodeName(node.default_next_node, `${basePath}.default_next_node`);
        }
        break;
      }
      case 'subgraph': {
        const refPath = `${basePath}.graph`;
        if (typeof node.graph !== 'string') {
          references.push({
            path: refPath,
            section: 'flows',
            ref: { kind: 'existing', remoteName: node.graph.existing },
          });
        } else if (node.graph === source.meta.name) {
          diagnostics.push(
            makeError(
              refPath,
              `circular subgraph reference: '${node.graph}' is this flow itself`,
            ),
          );
        } else {
          // A local subgraph name refers to a sibling flow directory; its
          // existence is validated at build time, not here.
          references.push({ path: refPath, section: 'flows', ref: { kind: 'local', name: node.graph } });
        }
        break;
      }
      case 'crew': {
        if (node.crew !== undefined) {
          references.push({
            path: `${basePath}.crew`,
            section: 'crews',
            ref: { kind: 'existing', remoteName: node.crew.existing },
          });
        }
        break;
      }
      default:
        break; // node types without reference positions
    }
  }

  // --- edges ---------------------------------------------------------------
  source.flow.edges.forEach((edge, index) => {
    resolveNodeName(edge.from, `flow.edges[${index}].from`);
    if (edge.to !== undefined) {
      resolveNodeName(edge.to, `flow.edges[${index}].to`);
    }
  });

  return { flowName: source.meta.name, symbols, references, diagnostics };
}

/** Find the resolution recorded for a reference position, if it resolved. */
export function findResolution(resolved: ResolvedFlow, path: string): ResolvedRef | undefined {
  return resolved.references.find((reference) => reference.path === path)?.ref;
}

function knownNamesHint(section: SymbolSection, known: readonly string[]): string {
  if (known.length === 0) {
    return `no ${SECTION_LABELS[section]}s are defined in this flow`;
  }
  const shown = known.slice(0, MAX_KNOWN_NAMES_IN_MESSAGE).map((name) => `'${name}'`);
  const suffix = known.length > MAX_KNOWN_NAMES_IN_MESSAGE ? ', …' : '';
  return `known ${SECTION_LABELS[section]}s: ${shown.join(', ')}${suffix}`;
}
