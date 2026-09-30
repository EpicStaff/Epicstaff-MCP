import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { hasErrors } from './diagnostics.js';
import { loadFlowDirectory } from './loader.js';

const FIXTURES_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../tests/fixtures/flow-source',
);

function fixture(name: string): string {
  return path.join(FIXTURES_DIR, name);
}

describe('loadFlowDirectory', () => {
  it('loads a complete valid flow with zero diagnostics', async () => {
    const { source, diagnostics, files } = await loadFlowDirectory(fixture('valid-basic'));

    expect(diagnostics).toEqual([]);
    expect(files).toEqual(['flow.yaml']);
    expect(source).not.toBeNull();

    const flow = source!;
    expect(flow.meta.name).toBe('research-and-write');
    expect(Object.keys(flow.flow.nodes)).toEqual(['start', 'research', 'write', 'finish']);
    expect(flow.flow.edges).toHaveLength(3);

    // defaults applied
    const researcher = flow.agents['researcher']!;
    expect(researcher.max_iter).toBe(10);
    expect(researcher.cache).toBe(true);
    expect(researcher.max_retry_limit).toBe(2);

    // shorthand normalization: bare tool ref → {tool, mode: 'allow'}
    const surface = flow.surfaces['web_research']!;
    expect(surface.python_tools).toEqual([{ tool: 'fetch_page', mode: 'allow' }]);
    expect(surface.knowledge).toEqual([{ collection: 'docs' }]);

    // default_surfaces object form with default place
    expect(researcher.default_surfaces).toEqual([{ surface: 'web_research', place: 'all' }]);

    // existing-ref passthrough
    expect(researcher.fcm_llm_config).toEqual({ existing: 'org-default-fcm' });
  });

  it('deep-merges split files by top-level section', async () => {
    const { source, diagnostics, files } = await loadFlowDirectory(fixture('valid-split'));

    expect(diagnostics).toEqual([]);
    expect(files).toEqual(['agents.flow.yaml', 'flow.yaml']);
    expect(source?.agents['helper']?.llm_config).toBe('default');
    expect(source?.meta.name).toBe('split-example');
  });

  it('reports an unknown key typo as a located error diagnostic', async () => {
    const { source, diagnostics } = await loadFlowDirectory(fixture('invalid-unknown-key'));

    expect(source).toBeNull();
    expect(diagnostics).toHaveLength(1);
    const diagnostic = diagnostics[0]!;
    expect(diagnostic.severity).toBe('error');
    expect(diagnostic.path).toBe('agents.researcher');
    expect(diagnostic.file).toBe('flow.yaml');
    expect(diagnostic.message).toContain("'instrutions'");
    expect(diagnostic.message).toContain('typo');
  });

  it("rejects the legacy 'llm' node type with an error diagnostic", async () => {
    const { source, diagnostics } = await loadFlowDirectory(fixture('invalid-llm-node'));

    // The rest of the file still parses; the error comes from the rule pass.
    expect(source).not.toBeNull();
    expect(diagnostics).toHaveLength(1);
    const diagnostic = diagnostics[0]!;
    expect(diagnostic.severity).toBe('error');
    expect(diagnostic.path).toBe('flow.nodes.analyze.type');
    expect(diagnostic.file).toBe('flow.yaml');
    expect(diagnostic.message).toContain('legacy');
    expect(diagnostic.message).toContain("'agent' node");
  });

  it("accepts the deprecated 'crew' node type with a warning diagnostic", async () => {
    const { source, diagnostics } = await loadFlowDirectory(fixture('warning-crew-node'));

    expect(source).not.toBeNull();
    expect(hasErrors(diagnostics)).toBe(false);
    expect(diagnostics).toHaveLength(1);
    const diagnostic = diagnostics[0]!;
    expect(diagnostic.severity).toBe('warning');
    expect(diagnostic.path).toBe('flow.nodes.legacy.type');
    expect(diagnostic.message).toContain('deprecated');
  });

  it('reports a duplicate symbolic name across split files', async () => {
    const { source, diagnostics } = await loadFlowDirectory(fixture('invalid-duplicate-name'));

    expect(source).toBeNull();
    expect(diagnostics).toHaveLength(1);
    const diagnostic = diagnostics[0]!;
    expect(diagnostic.severity).toBe('error');
    expect(diagnostic.path).toBe('agents.researcher');
    // extra.flow.yaml sorts first, so flow.yaml is the file that re-defines it
    expect(diagnostic.file).toBe('flow.yaml');
    expect(diagnostic.message).toContain('duplicate');
    expect(diagnostic.message).toContain('extra.flow.yaml');
  });

  it('reports a knowledge document missing from the flow directory', async () => {
    const { source, diagnostics } = await loadFlowDirectory(fixture('invalid-missing-document'));

    expect(source).not.toBeNull();
    expect(diagnostics).toHaveLength(1);
    const diagnostic = diagnostics[0]!;
    expect(diagnostic.severity).toBe('error');
    expect(diagnostic.path).toBe('knowledge.docs.documents[0]');
    expect(diagnostic.message).toContain('file not found');
    expect(diagnostic.message).toContain('docs/nope.md');
  });

  it('reports an unknown node type with the list of allowed types', async () => {
    const flowDir = await fs.mkdtemp(path.join(os.tmpdir(), 'es-mcp-flow-'));
    try {
      await fs.writeFile(
        path.join(flowDir, 'flow.yaml'),
        [
          'meta:',
          '  name: typo-node-type',
          'flow:',
          '  nodes:',
          '    start:',
          '      type: start',
          '    broken:',
          '      type: pyton',
          '  edges:',
          '    - from: start',
          '      to: broken',
        ].join('\n'),
        'utf8',
      );

      const { source, diagnostics } = await loadFlowDirectory(flowDir);

      expect(source).toBeNull();
      expect(diagnostics).toHaveLength(1);
      const diagnostic = diagnostics[0]!;
      expect(diagnostic.path).toBe('flow.nodes.broken.type');
      expect(diagnostic.message).toContain('unknown node type');
      expect(diagnostic.message).toContain("'python'");
    } finally {
      await fs.rm(flowDir, { recursive: true, force: true });
    }
  });

  it('reports a directory without any flow source files', async () => {
    const { source, diagnostics } = await loadFlowDirectory(FIXTURES_DIR);

    expect(source).toBeNull();
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.message).toContain('no flow source files found');
  });
});
