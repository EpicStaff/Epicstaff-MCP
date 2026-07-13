/**
 * Flow-source loader.
 *
 * Loads a flow directory: discovers `flow.yaml` / `*.flow.yaml` (and `.yml` /
 * `.json` variants), parses each file, deep-merges by top-level section
 * (duplicate symbolic names across files are errors), validates against the
 * zod schema and runs the language rule pass (forbidden node types, one-of
 * checks, local file existence).
 *
 * Never throws for content problems — everything is reported as diagnostics.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

import {
  hasErrors,
  joinPath,
  makeError,
  makeWarning,
  type Diagnostic,
} from './diagnostics.js';
import { flowSourceSchema, type FlowSource } from './schema/index.js';

export interface FlowLoadResult {
  /**
   * The parsed flow source, or `null` when the files could not be merged or
   * failed schema validation. Note: rule-pass errors (e.g. a forbidden node
   * type) still return the parsed source alongside error diagnostics — check
   * `hasErrors(diagnostics)` before building.
   */
  source: FlowSource | null;
  diagnostics: Diagnostic[];
  /** Source file basenames that were loaded, in processing order. */
  files: string[];
}

const ROOT_FILE_PATTERN = /^flow\.(ya?ml|json)$/;
const SPLIT_FILE_PATTERN = /\.flow\.(ya?ml|json)$/;

const NAMED_MAP_SECTIONS = ['llm_configs', 'knowledge', 'surfaces', 'agents'] as const;
const TOOL_SUBSECTIONS = ['tool_configs', 'python_code_tools', 'mcp_tools'] as const;

type RawObject = Record<string, unknown>;

/** Where each merged section / entry came from, keyed by diagnostic path. */
type ProvenanceMap = Map<string, string>;

export async function loadFlowDirectory(flowDir: string): Promise<FlowLoadResult> {
  const diagnostics: Diagnostic[] = [];

  let fileNames: string[];
  try {
    fileNames = await discoverSourceFiles(flowDir);
  } catch (cause) {
    diagnostics.push(makeError('', `flow directory not readable: ${describeCause(cause)}`));
    return { source: null, diagnostics, files: [] };
  }

  if (fileNames.length === 0) {
    diagnostics.push(
      makeError(
        '',
        'no flow source files found — expected flow.yaml (or flow.yml / flow.json) or *.flow.yaml split files',
      ),
    );
    return { source: null, diagnostics, files: [] };
  }

  const merged: RawObject = {};
  const provenance: ProvenanceMap = new Map();

  for (const fileName of fileNames) {
    const filePath = path.join(flowDir, fileName);
    let text: string;
    try {
      text = await fs.readFile(filePath, 'utf8');
    } catch (cause) {
      diagnostics.push(makeError('', `cannot read file: ${describeCause(cause)}`, fileName));
      continue;
    }

    let data: unknown;
    try {
      data = fileName.endsWith('.json') ? JSON.parse(text) : parseYaml(text);
    } catch (cause) {
      diagnostics.push(makeError('', `parse error: ${describeCause(cause)}`, fileName));
      continue;
    }

    if (data === null || data === undefined) {
      continue; // empty file contributes nothing
    }
    if (!isPlainObject(data)) {
      diagnostics.push(
        makeError('', 'top level of a flow source file must be a mapping of sections', fileName),
      );
      continue;
    }

    mergeFile(merged, provenance, fileName, data, diagnostics);
  }

  if (hasErrors(diagnostics)) {
    return { source: null, diagnostics, files: fileNames };
  }

  const parsed = flowSourceSchema.safeParse(merged);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      diagnostics.push(issueToDiagnostic(issue, provenance));
    }
    return { source: null, diagnostics, files: fileNames };
  }

  const source = parsed.data;
  diagnostics.push(...collectNodeTypeDiagnostics(source, provenance));
  diagnostics.push(...(await collectLocalFileDiagnostics(source, provenance, flowDir)));

  return { source, diagnostics, files: fileNames };
}

async function discoverSourceFiles(flowDir: string): Promise<string[]> {
  const entries = await fs.readdir(flowDir, { withFileTypes: true });
  return entries
    .filter(
      (entry) =>
        entry.isFile() && (ROOT_FILE_PATTERN.test(entry.name) || SPLIT_FILE_PATTERN.test(entry.name)),
    )
    .map((entry) => entry.name)
    .sort();
}

// ---------------------------------------------------------------------------
// Deep merge by top-level section, with per-entry provenance + duplicate checks
// ---------------------------------------------------------------------------

function mergeFile(
  merged: RawObject,
  provenance: ProvenanceMap,
  fileName: string,
  data: RawObject,
  diagnostics: Diagnostic[],
): void {
  for (const [section, value] of Object.entries(data)) {
    if (section === 'meta') {
      mergeNamedMap(merged, provenance, fileName, 'meta', value, diagnostics, 'meta key');
    } else if ((NAMED_MAP_SECTIONS as readonly string[]).includes(section)) {
      mergeNamedMap(merged, provenance, fileName, section, value, diagnostics, 'symbolic name');
    } else if (section === 'tools') {
      mergeToolsSection(merged, provenance, fileName, value, diagnostics);
    } else if (section === 'flow') {
      mergeFlowSection(merged, provenance, fileName, value, diagnostics);
    } else {
      // Unknown top-level section: keep it so zod reports it as an unknown key.
      mergeOpaque(merged, provenance, fileName, section, value, diagnostics);
    }
  }
}

/** Merge a `name → entity` map section; a name defined in two files is an error. */
function mergeNamedMap(
  merged: RawObject,
  provenance: ProvenanceMap,
  fileName: string,
  sectionPath: string,
  value: unknown,
  diagnostics: Diagnostic[],
  duplicateNoun: string,
): void {
  if (!isPlainObject(value)) {
    mergeOpaque(merged, provenance, fileName, sectionPath, value, diagnostics);
    return;
  }

  const target = getOrCreateObject(merged, provenance, fileName, sectionPath, diagnostics);
  if (target === null) {
    return;
  }

  for (const [name, entity] of Object.entries(value)) {
    const entryPath = `${sectionPath}.${name}`;
    if (Object.prototype.hasOwnProperty.call(target, name)) {
      const firstFile = provenance.get(entryPath);
      diagnostics.push(
        makeError(
          entryPath,
          `duplicate ${duplicateNoun} '${name}' in section '${sectionPath}'${
            firstFile !== undefined ? ` — already defined in ${firstFile}` : ''
          }`,
          fileName,
        ),
      );
      continue;
    }
    target[name] = entity;
    provenance.set(entryPath, fileName);
  }
}

function mergeToolsSection(
  merged: RawObject,
  provenance: ProvenanceMap,
  fileName: string,
  value: unknown,
  diagnostics: Diagnostic[],
): void {
  if (!isPlainObject(value)) {
    mergeOpaque(merged, provenance, fileName, 'tools', value, diagnostics);
    return;
  }
  const tools = getOrCreateObject(merged, provenance, fileName, 'tools', diagnostics);
  if (tools === null) {
    return;
  }
  for (const [key, subValue] of Object.entries(value)) {
    if ((TOOL_SUBSECTIONS as readonly string[]).includes(key)) {
      mergeNamedMap(tools, provenance, fileName, `tools.${key}`, subValue, diagnostics, 'symbolic name');
    } else {
      mergeOpaque(tools, provenance, fileName, `tools.${key}`, subValue, diagnostics);
    }
  }
}

function mergeFlowSection(
  merged: RawObject,
  provenance: ProvenanceMap,
  fileName: string,
  value: unknown,
  diagnostics: Diagnostic[],
): void {
  if (!isPlainObject(value)) {
    mergeOpaque(merged, provenance, fileName, 'flow', value, diagnostics);
    return;
  }
  const flow = getOrCreateObject(merged, provenance, fileName, 'flow', diagnostics);
  if (flow === null) {
    return;
  }
  for (const [key, subValue] of Object.entries(value)) {
    if (key === 'nodes') {
      mergeNamedMap(flow, provenance, fileName, 'flow.nodes', subValue, diagnostics, 'symbolic name');
    } else if (key === 'edges' && Array.isArray(subValue)) {
      const edges = Array.isArray(flow['edges']) ? (flow['edges'] as unknown[]) : [];
      const baseIndex = edges.length;
      subValue.forEach((edge, index) => {
        provenance.set(`flow.edges[${baseIndex + index}]`, fileName);
        edges.push(edge);
      });
      flow['edges'] = edges;
      provenance.set('flow.edges', fileName);
    } else {
      mergeOpaque(flow, provenance, fileName, `flow.${key}`, subValue, diagnostics);
    }
  }
}

/** Assign a value that cannot be entry-merged; defining it in two files is an error. */
function mergeOpaque(
  target: RawObject,
  provenance: ProvenanceMap,
  fileName: string,
  fullPath: string,
  value: unknown,
  diagnostics: Diagnostic[],
): void {
  const key = lastPathSegment(fullPath);
  if (Object.prototype.hasOwnProperty.call(target, key)) {
    const firstFile = provenance.get(fullPath);
    diagnostics.push(
      makeError(
        fullPath,
        `'${fullPath}' is defined in more than one file${
          firstFile !== undefined ? ` — already defined in ${firstFile}` : ''
        }`,
        fileName,
      ),
    );
    return;
  }
  target[key] = value;
  provenance.set(fullPath, fileName);
}

/**
 * Fetch `merged[<last segment of sectionPath>]` as an object container,
 * creating it when absent. Returns null (with a diagnostic) when a previous
 * file already set the section to a non-mergeable value.
 */
function getOrCreateObject(
  parent: RawObject,
  provenance: ProvenanceMap,
  fileName: string,
  sectionPath: string,
  diagnostics: Diagnostic[],
): RawObject | null {
  const key = lastPathSegment(sectionPath);
  const current = parent[key];
  if (current === undefined) {
    const created: RawObject = {};
    parent[key] = created;
    if (!provenance.has(sectionPath)) {
      provenance.set(sectionPath, fileName);
    }
    return created;
  }
  if (isPlainObject(current)) {
    return current;
  }
  const firstFile = provenance.get(sectionPath);
  diagnostics.push(
    makeError(
      sectionPath,
      `'${sectionPath}' is defined in more than one file with incompatible shapes${
        firstFile !== undefined ? ` — already defined in ${firstFile}` : ''
      }`,
      fileName,
    ),
  );
  return null;
}

// ---------------------------------------------------------------------------
// zod issue → diagnostic
// ---------------------------------------------------------------------------

function issueToDiagnostic(issue: z.ZodIssue, provenance: ProvenanceMap): Diagnostic {
  let message = issue.message;

  if (issue.code === z.ZodIssueCode.unrecognized_keys) {
    const keys = issue.keys.map((key) => `'${key}'`).join(', ');
    message = `unknown key${issue.keys.length > 1 ? 's' : ''} ${keys} — not part of the flow source schema (check for typos)`;
  } else if (issue.code === z.ZodIssueCode.invalid_union) {
    message = 'value does not match any accepted form for this field';
  } else if (issue.code === z.ZodIssueCode.invalid_union_discriminator) {
    // Issue path already ends with the discriminator key ('type').
    const options = issue.options.map((option) => `'${String(option)}'`).join(', ');
    message = `unknown node type — expected one of ${options}`;
  }

  return makeError(joinPath(issue.path), message, lookupProvenance(provenance, issue.path));
}

function lookupProvenance(
  provenance: ProvenanceMap,
  segments: ReadonlyArray<string | number>,
): string | undefined {
  for (let length = segments.length; length >= 1; length -= 1) {
    const file = provenance.get(joinPath(segments.slice(0, length)));
    if (file !== undefined) {
      return file;
    }
  }
  return undefined;
}

function nodeFile(provenance: ProvenanceMap, nodeName: string): string | undefined {
  return lookupProvenance(provenance, ['flow', 'nodes', nodeName]);
}

// ---------------------------------------------------------------------------
// Rule pass: node-type policy + one-of checks not expressible in the union
// ---------------------------------------------------------------------------

function collectNodeTypeDiagnostics(source: FlowSource, provenance: ProvenanceMap): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const [nodeName, node] of Object.entries(source.flow.nodes)) {
    const nodePath = `flow.nodes.${nodeName}`;
    const file = nodeFile(provenance, nodeName);

    if (node.type === 'llm') {
      diagnostics.push(
        makeError(
          `${nodePath}.type`,
          "node type 'llm' is legacy and can no longer be created — use an 'agent' node instead",
          file,
        ),
      );
    } else if (node.type === 'code-agent') {
      diagnostics.push(
        makeError(
          `${nodePath}.type`,
          "node type 'code-agent' is legacy and can no longer be created — use an 'agent' node with a python tool instead",
          file,
        ),
      );
    } else if (node.type === 'crew') {
      diagnostics.push(
        makeWarning(
          `${nodePath}.type`,
          "node type 'crew' is deprecated — prefer 'agent' and 'task' nodes",
          file,
        ),
      );
    } else if (node.type === 'python') {
      const hasCode = node.code !== undefined;
      const hasCodeFile = node.code_file !== undefined;
      if (hasCode === hasCodeFile) {
        diagnostics.push(makeError(nodePath, 'provide exactly one of code / code_file', file));
      }
    }
  }
  return diagnostics;
}

// ---------------------------------------------------------------------------
// Rule pass: local files referenced by the source must exist inside the flow dir
// ---------------------------------------------------------------------------

async function collectLocalFileDiagnostics(
  source: FlowSource,
  provenance: ProvenanceMap,
  flowDir: string,
): Promise<Diagnostic[]> {
  const diagnostics: Diagnostic[] = [];

  const check = async (relativePath: string, atPath: string, file: string | undefined) => {
    if (path.isAbsolute(relativePath) || path.normalize(relativePath).startsWith('..')) {
      diagnostics.push(
        makeError(
          atPath,
          `'${relativePath}' must be a relative path inside the flow directory`,
          file,
        ),
      );
      return;
    }
    try {
      const stat = await fs.stat(path.resolve(flowDir, relativePath));
      if (!stat.isFile()) {
        diagnostics.push(makeError(atPath, `'${relativePath}' is not a file`, file));
      }
    } catch {
      diagnostics.push(
        makeError(
          atPath,
          `file not found: '${relativePath}' (resolved against the flow directory)`,
          file,
        ),
      );
    }
  };

  for (const [collectionName, collection] of Object.entries(source.knowledge)) {
    const file = lookupProvenance(provenance, ['knowledge', collectionName]);
    for (const [index, documentPath] of collection.documents.entries()) {
      await check(documentPath, `knowledge.${collectionName}.documents[${index}]`, file);
    }
  }

  for (const [toolName, tool] of Object.entries(source.tools.python_code_tools)) {
    if (tool.code_file !== undefined) {
      const file = lookupProvenance(provenance, ['tools', 'python_code_tools', toolName]);
      await check(tool.code_file, `tools.python_code_tools.${toolName}.code_file`, file);
    }
  }

  for (const [nodeName, node] of Object.entries(source.flow.nodes)) {
    if (node.type === 'python' && node.code_file !== undefined) {
      await check(node.code_file, `flow.nodes.${nodeName}.code_file`, nodeFile(provenance, nodeName));
    }
  }

  for (const [index, edge] of source.flow.edges.entries()) {
    if (edge.condition?.code_file !== undefined) {
      const file = lookupProvenance(provenance, ['flow', 'edges', index]);
      await check(edge.condition.code_file, `flow.edges[${index}].condition.code_file`, file);
    }
  }

  return diagnostics;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is RawObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function lastPathSegment(sectionPath: string): string {
  const segments = sectionPath.split('.');
  const last = segments[segments.length - 1];
  return last ?? sectionPath;
}

function describeCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
