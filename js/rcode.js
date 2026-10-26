// Small helpers for writing R source code from JavaScript.

const RESERVED = new Set([
  'if', 'else', 'repeat', 'while', 'function', 'for', 'next', 'break', 'in',
  'TRUE', 'FALSE', 'NULL', 'Inf', 'NaN', 'NA', 'NA_integer_', 'NA_real_',
  'NA_character_', 'NA_complex_',
]);

export function isSyntactic(name) {
  return /^((([A-Za-z]|[.][._A-Za-z])[._A-Za-z0-9]*)|[.])$/.test(name) && !RESERVED.has(name);
}

// A column or object name as R code: `Drug A` needs backticks, value does not.
export function rsym(name) {
  name = String(name);
  return isSyntactic(name) ? name : '`' + name.replace(/\\/g, '\\\\').replace(/`/g, '\\`') + '`';
}

// A string literal. JSON escapes are valid R escapes.
export function rstr(s) {
  return JSON.stringify(String(s));
}

export function rnum(x) {
  if (x === null || x === undefined || x === '' || Number.isNaN(Number(x))) return 'NA';
  const n = Number(x);
  if (n === Infinity) return 'Inf';
  if (n === -Infinity) return '-Inf';
  return String(n);
}

export function rbool(b) {
  return b ? 'TRUE' : 'FALSE';
}

// c(...) wrapped over several lines when long.
export function rvec(items, indent = '  ', width = 78) {
  if (!items.length) return 'c()';
  const one = `c(${items.join(', ')})`;
  if (one.length + indent.length <= width) return one;
  const lines = [];
  let line = '';
  for (const it of items) {
    const piece = line ? `, ${it}` : it;
    if (line && indent.length + 2 + line.length + piece.length > width) {
      lines.push(line + ',');
      line = it;
    } else {
      line += piece;
    }
  }
  if (line) lines.push(line);
  return `c(\n${lines.map((l) => indent + '  ' + l).join('\n')}\n${indent})`;
}

export function rstrvec(items, indent) {
  return rvec(items.map(rstr), indent);
}

// Turn a display name like "Data 1 (long)" into an R object name like data_1_long.
export function toRName(display, taken = new Set(), fallback = 'x') {
  let base = String(display || '')
    .toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!base) base = fallback;
  if (/^[0-9]/.test(base)) base = `${fallback}_${base}`;
  if (RESERVED.has(base) || base.startsWith('ag_')) base = `${base}_`;
  let name = base;
  let i = 2;
  while (taken.has(name)) name = `${base}_${i++}`;
  return name;
}

// Indent every line of a block of code.
export function indent(code, by = '  ') {
  return code.split('\n').map((l) => (l ? by + l : l)).join('\n');
}

// key = value argument list, skipping undefined/null values.
export function args(obj) {
  return Object.entries(obj)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k} = ${v}`);
}

export function call(fn, argList, indentBy = '  ', width = 78) {
  const flat = `${fn}(${argList.join(', ')})`;
  if (flat.length <= width || argList.length <= 1) return flat;
  return `${fn}(\n${argList.map((a) => indentBy + '  ' + a).join(',\n')}\n${indentBy})`;
}
