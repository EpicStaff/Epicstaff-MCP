/**
 * Placeholders EpicStaff refuses in an author's template — a port of the REFUSED rules of
 * `src/shared/flow_templates.py` (EpicStaff 1.5.0), which the backend checks on every save
 * (`tables/validators/run_refusal_validator.py`) and crew at run time.
 *
 * The grammar is Python `str.format`'s. A template that does not parse is never refused (it is
 * sent as written). A placeholder is refused when it uses a `!r` / `!s` / `!a` conversion after an
 * identifier head, or when it is a path (`.` or `[`) with a segment starting with `_`.
 */

/** Author-facing reasons the backend refuses `template`, one per refused placeholder; [] when none. */
export function templateRefusals(template: string): string[] {
  const fields = parseFields(template);
  if (fields === null) return [];
  const reasons = fields.map(refusalOf).filter((reason): reason is string => reason !== null);
  return [...new Set(reasons)];
}

interface Field {
  name: string;
  conversion: string | null;
  spec: string;
}

/** `string.Formatter().parse`: every replacement field, or null when the template does not parse. */
function parseFields(template: string): Field[] | null {
  const fields: Field[] = [];
  let i = 0;
  while (i < template.length) {
    const char = template[i]!;
    if (char === '}') {
      if (template[i + 1] !== '}') return null; // single '}'
      i += 2;
      continue;
    }
    if (char !== '{') {
      i += 1;
      continue;
    }
    if (template[i + 1] === '{') {
      i += 2;
      continue;
    }
    // A field runs to its matching '}'; a format spec may nest one level of braces.
    let depth = 1;
    let end = i + 1;
    for (; end < template.length && depth > 0; end++) {
      if (template[end] === '{') depth += 1;
      else if (template[end] === '}') depth -= 1;
    }
    if (depth > 0) return null;
    const field = splitField(template.slice(i + 1, end - 1));
    if (field === null) return null;
    fields.push(field);
    i = end;
  }
  return fields;
}

/** CPython `parse_field`: name, then `!conversion`, then `:spec`. */
function splitField(text: string): Field | null {
  let i = 0;
  for (; i < text.length; i++) {
    const char = text[i];
    if (char === '{') return null;
    if (char === '[') {
      while (i < text.length && text[i] !== ']') i++;
      continue;
    }
    if (char === '!' || char === ':') break;
  }
  const name = text.slice(0, i);
  if (text[i] === '!') {
    if (i + 1 >= text.length) return null;
    const conversion = text[i + 1]!;
    if (i + 2 < text.length && text[i + 2] !== ':') return null;
    return { name, conversion, spec: text.slice(i + 3) };
  }
  return { name, conversion: null, spec: text[i] === ':' ? text.slice(i + 1) : '' };
}

const IDENTIFIER = /^[\p{L}\p{Nl}_][\p{L}\p{Nl}\p{Mn}\p{Mc}\p{Nd}\p{Pc}]*$/u;

function refusalOf({ name, conversion, spec }: Field): string | null {
  const headEnd = name.search(/[.[]/);
  const head = headEnd === -1 ? name : name.slice(0, headEnd);
  // Positional placeholders are never filled, but never refused either.
  if (head === '' || /^\d+$/.test(head)) return null;
  const field = name + (conversion !== null ? `!${conversion}` : '') + (spec ? `:${spec}` : '');
  if (conversion !== null) {
    return ['r', 's', 'a'].includes(conversion) && IDENTIFIER.test(head)
      ? `Placeholder '{${field}}' is not allowed: conversions such as '!${conversion}' are not supported. Write '{${name}}'.`
      : null;
  }
  if (spec || headEnd === -1) return null;
  const keys = pathKeys(name.slice(headEnd));
  if (keys === null) return null; // a bad path is sent as written, not refused
  const underscored = [head, ...keys].find((key) => key.startsWith('_'));
  return underscored === undefined
    ? null
    : `Placeholder '{${field}}' is not allowed: '${underscored}' starts with '_'. Rename that variable or key.`;
}

/** CPython `formatter_field_name_split` rest: `.attr` / `[key]` steps, or null when malformed. */
function pathKeys(rest: string): string[] | null {
  const keys: string[] = [];
  let i = 0;
  while (i < rest.length) {
    const char = rest[i];
    let key: string;
    if (char === '.') {
      let end = i + 1;
      while (end < rest.length && rest[end] !== '.' && rest[end] !== '[') end++;
      key = rest.slice(i + 1, end);
      i = end;
    } else if (char === '[') {
      const end = rest.indexOf(']', i + 1);
      if (end === -1) return null;
      key = rest.slice(i + 1, end);
      i = end + 1;
      if (i < rest.length && rest[i] !== '.' && rest[i] !== '[') return null;
    } else {
      return null;
    }
    if (key === '') return null;
    keys.push(key);
  }
  return keys;
}
