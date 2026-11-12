import { describe, expect, it } from 'vitest';

import { templateRefusals } from './flow-template.js';
import { isVarPathError, parseVarPath } from './varpath.js';

describe('templateRefusals (port of shared/flow_templates.py REFUSED rules)', () => {
  it.each([
    ['{topic!r}', "Placeholder '{topic!r}' is not allowed: conversions such as '!r' are not supported. Write '{topic}'."],
    ['{a[b]!s:>4}', "Placeholder '{a[b]!s:>4}' is not allowed: conversions such as '!s' are not supported. Write '{a[b]}'."],
    ['{a._b}', "Placeholder '{a._b}' is not allowed: '_b' starts with '_'. Rename that variable or key."],
    ['{_a.b}', "Placeholder '{_a.b}' is not allowed: '_a' starts with '_'. Rename that variable or key."],
    ['x {a[_b]} y', "Placeholder '{a[_b]}' is not allowed: '_b' starts with '_'. Rename that variable or key."],
  ])('refuses %s', (template, reason) => {
    expect(templateRefusals(template)).toEqual([reason]);
  });

  it.each([
    'plain text',
    '{topic} and {user.name} and {items[0]}',
    // A bare name is a value lookup, underscore or not.
    '{_x}',
    // Escaped braces, positional and formatted placeholders, a JSON example: not refused.
    '{{a._b}} {} {0} {.a} {topic:>10} {"a": 1}',
    // A conversion after a non-identifier head is "formatted", not refused.
    '{"hi!": 1}',
    // A bad path is sent as written.
    '{a..b} {a[]}',
    // A template that does not parse is never refused, even with a refused placeholder in it.
    '{a._b} }',
    '{a!r',
  ])('accepts %s', (template) => {
    expect(templateRefusals(template)).toEqual([]);
  });

  it('reports each refused placeholder once', () => {
    expect(templateRefusals('{a!r} {a!r} {b._c}')).toHaveLength(2);
  });
});

describe('parseVarPath: underscore segments (shared/state_path.py)', () => {
  it.each(['variables._x', 'variables.a.__class__', 'variables.a[0]._p | fallback', 'variables.shared[_k].x'])(
    'refuses %s',
    (path) => {
      const parsed = parseVarPath(path);
      expect(isVarPathError(parsed) && parsed.error).toMatch(/is not allowed: path segments cannot start with '_'/);
    },
  );

  it('accepts names with an inner underscore and a default that starts with one', () => {
    expect(isVarPathError(parseVarPath('variables.user_name.first_x'))).toBe(false);
    expect(isVarPathError(parseVarPath('variables.a | _default'))).toBe(false);
  });
});
