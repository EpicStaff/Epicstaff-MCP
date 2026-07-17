import { describe, expect, it } from 'vitest';

import { FLOW_NODE_TYPES, FORBIDDEN_NODE_TYPES } from '../flow-source/schema/flow.js';
import { NODE_REFERENCE } from './node-reference.js';
import { introspectNodeSchemas } from './node-schema-introspect.js';

/** Guards the node catalog against drift: schema, prose, and introspection must agree. */
describe('node reference catalog', () => {
  const introspected = introspectNodeSchemas();
  const introspectedTypes = introspected.map((node) => node.type);

  it('introspects exactly the non-forbidden writable node types', () => {
    const expected = FLOW_NODE_TYPES.filter((type) => !FORBIDDEN_NODE_TYPES.includes(type as never));
    expect(new Set(introspectedTypes)).toEqual(new Set(expected));
  });

  it('omits forbidden node types entirely', () => {
    for (const forbidden of FORBIDDEN_NODE_TYPES) {
      expect(introspectedTypes).not.toContain(forbidden);
    }
  });

  it('has a documented reference entry for every writable node type', () => {
    for (const type of FLOW_NODE_TYPES) {
      const entry = NODE_REFERENCE[type];
      expect(entry, `NODE_REFERENCE missing entry for '${type}'`).toBeDefined();
      expect(entry.summary.length).toBeGreaterThan(0);
      expect(entry.whenToUse.length).toBeGreaterThan(0);
      expect(Array.isArray(entry.caveats)).toBe(true);
    }
  });

  it('derives well-formed fields for each node type', () => {
    for (const node of introspected) {
      for (const field of node.fields) {
        expect(typeof field.name).toBe('string');
        expect(typeof field.required).toBe('boolean');
      }
      // `type` and `position` are omitted from the authoring field list.
      expect(node.fields.map((field) => field.name)).not.toContain('type');
      expect(node.fields.map((field) => field.name)).not.toContain('position');
    }
  });

  it('marks crew as deprecated and others as not', () => {
    expect(introspected.find((node) => node.type === 'crew')?.deprecated).toBe(true);
    expect(introspected.find((node) => node.type === 'agent')?.deprecated).toBe(false);
  });

  it('keeps the severe classification-decision-table caveat', () => {
    const caveats = NODE_REFERENCE['classification-decision-table'].caveats.join(' ').toLowerCase();
    expect(caveats).toContain('first category');
  });

  it('keeps the agent-needs-tasks caveat', () => {
    const caveats = NODE_REFERENCE.agent.caveats.join(' ').toLowerCase();
    expect(caveats).toContain('task');
  });
});
