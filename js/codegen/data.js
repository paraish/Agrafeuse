// Data tables: the grid the user types into, turned into an R data.frame.
import { rsym, rstr, rnum, rvec } from '../rcode.js';

const MISSING = new Set(['', 'na', 'nan', 'n/a', '.', '-']);

export function isMissing(s) {
  return s === null || s === undefined || MISSING.has(String(s).trim().toLowerCase());
}

export function parseNumber(s) {
  if (isMissing(s)) return null;
  const t = String(s).trim().replace(/^\+/, '');
  if (!/^-?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(t)) return undefined;
  return Number(t);
}

// Number of rows that hold any data (trailing empty rows are ignored).
export function usedRowCount(table) {
  for (let r = table.rows.length - 1; r >= 0; r--) {
    if ((table.rows[r] || []).some((v) => !isMissing(v))) return r + 1;
  }
  return 0;
}

// The columns R will see: names made unique, types decided, values parsed.
// type 'auto' becomes numeric when every non-empty cell is a number.
export function inferColumns(table) {
  const nrow = usedRowCount(table);
  const out = [];
  const seen = new Set();
  table.columns.forEach((col, j) => {
    const raw = [];
    for (let r = 0; r < nrow; r++) raw.push((table.rows[r] || [])[j] ?? '');
    const hasData = raw.some((v) => !isMissing(v));
    let name = String(col.name ?? '').trim();
    if (!name && !hasData) return;
    if (!name) name = `V${j + 1}`;
    let unique = name;
    for (let i = 2; seen.has(unique); i++) unique = `${name}_${i}`;
    seen.add(unique);

    const parsed = raw.map(parseNumber);
    const allNumeric = parsed.every((v) => v !== undefined);
    let type = col.type === 'number' ? 'numeric' : col.type === 'text' ? 'factor' : allNumeric ? 'numeric' : 'factor';
    let values;
    let bad = 0;
    if (type === 'numeric') {
      values = parsed.map((v) => {
        if (v === undefined) { bad++; return null; }
        return v;
      });
    } else {
      values = raw.map((v) => (isMissing(v) ? null : String(v).trim()));
    }
    const levels = type === 'factor' ? [...new Set(values.filter((v) => v !== null))] : [];
    out.push({ name: unique, index: j, type, values, levels, bad, missing: values.filter((v) => v === null).length });
  });
  return { nrow, columns: out };
}

// The same shape the R side returns from pb_describe(), so dropdowns can be
// filled before R has started.
export function dataSchema(table) {
  const { nrow, columns } = inferColumns(table);
  return {
    nrow,
    columns: columns.map((c) => ({
      name: c.name,
      type: c.type,
      levels: c.type === 'factor' ? c.levels : (new Set(c.values.filter((v) => v !== null)).size <= 30
        ? [...new Set(c.values.filter((v) => v !== null))].sort((a, b) => a - b).map(String) : []),
      missing: c.missing,
    })),
  };
}

export function dataCode(table) {
  const { columns } = inferColumns(table);
  if (!columns.length) return `${table.rname} <- data.frame()`;
  const parts = columns.map((c) => {
    let vec;
    if (c.type === 'numeric') {
      vec = rvec(c.values.map(rnum), '  ');
    } else {
      const v = rvec(c.values.map((x) => (x === null ? 'NA' : rstr(x))), '  ');
      vec = `factor(${v}, levels = ${rvec(c.levels.map(rstr), '  ')})`;
    }
    return `  ${rsym(c.name)} = ${vec}`;
  });
  return `${table.rname} <- data.frame(\n${parts.join(',\n')},\n  check.names = FALSE\n)`;
}

// --- CSV / TSV parsing for imports and pastes ---------------------------------

export function detectDelimiter(text) {
  const first = text.split(/\r?\n/).slice(0, 5).join('\n');
  const counts = { '\t': 0, ',': 0, ';': 0 };
  let inQ = false;
  for (const ch of first) {
    if (ch === '"') inQ = !inQ;
    else if (!inQ && ch in counts) counts[ch]++;
  }
  if (counts['\t'] > 0) return '\t';
  return counts[';'] > counts[','] ? ';' : ',';
}

export function parseDelimited(text, delim = detectDelimiter(text)) {
  const rows = [];
  let row = [];
  let field = '';
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false;
      } else field += ch;
    } else if (ch === '"' && field === '') inQ = true;
    else if (ch === delim) { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  while (rows.length && rows[rows.length - 1].every((v) => v === '')) rows.pop();
  return rows;
}

// A data table node from a header row + body rows of strings.
export function tableFromRows(header, body) {
  const ncol = Math.max(header.length, ...body.map((r) => r.length), 0);
  const columns = [];
  for (let j = 0; j < ncol; j++) columns.push({ name: (header[j] ?? '').trim() || `V${j + 1}`, type: 'auto' });
  const rows = body.map((r) => {
    const out = [];
    for (let j = 0; j < ncol; j++) out.push(r[j] ?? '');
    return out;
  });
  return { columns, rows };
}
