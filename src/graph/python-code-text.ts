/**
 * Ported from the backend's `PythonCodeSerializer`
 * (src/django_app/tables/serializers/model_serializers/python_serializers.py): its `code` is a DRF
 * `CharField` with the default `trim_whitespace=True`, so whatever a save sends is stored — and read
 * back — as Python's `code.strip()`. Every python code block goes through it: python nodes, webhook
 * trigger code, classification-table pre/post computation and python tools.
 */

/** The characters Python's `str.strip()` removes (`str.isspace()`); not the same set as JS `trim()`. */
const PYTHON_WHITESPACE: ReadonlySet<string> = new Set([
  '\t',
  '\n',
  '\v',
  '\f',
  '\r',
  '\x1c',
  '\x1d',
  '\x1e',
  '\x1f',
  ' ',
  '\x85',
  '\xa0',
  '\u1680',
  '\u2000',
  '\u2001',
  '\u2002',
  '\u2003',
  '\u2004',
  '\u2005',
  '\u2006',
  '\u2007',
  '\u2008',
  '\u2009',
  '\u200a',
  '\u2028',
  '\u2029',
  '\u202f',
  '\u205f',
  '\u3000',
]);

/** The code text as EpicStaff stores it: `code.strip()` with Python's whitespace set. Inner text is untouched. */
export function storedPythonCode(code: string): string {
  let start = 0;
  let end = code.length;
  while (start < end && PYTHON_WHITESPACE.has(code.charAt(start))) start += 1;
  while (end > start && PYTHON_WHITESPACE.has(code.charAt(end - 1))) end -= 1;
  return code.slice(start, end);
}
