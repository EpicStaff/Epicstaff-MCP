import { describe, expect, it } from 'vitest';
import { storedPythonCode } from './python-code-text.js';

describe('storedPythonCode (DRF CharField trim_whitespace → Python str.strip())', () => {
  it('drops the final newline and any leading / trailing blank lines of a block', () => {
    expect(storedPythonCode('def main():\n    total = 1\n    return total\n')).toBe(
      'def main():\n    total = 1\n    return total',
    );
    expect(storedPythonCode('\n\ndef main():\n    return 1\n\n\n')).toBe('def main():\n    return 1');
  });

  it('strips CRLF and Python-only whitespace at the edges, never inside', () => {
    expect(storedPythonCode('def main():\r\n    return 1\r\n')).toBe('def main():\r\n    return 1');
    expect(storedPythonCode('\x1c\x85 x = 1 \u3000\u2028')).toBe('x = 1');
    // JS trim() would strip a BOM; Python's strip() keeps it.
    expect(storedPythonCode('\ufeffx = 1')).toBe('\ufeffx = 1');
    expect(storedPythonCode('def main():\n\n    return 1')).toBe('def main():\n\n    return 1');
  });

  it('maps whitespace-only code to the empty string', () => {
    expect(storedPythonCode(' \n\t ')).toBe('');
  });
});
