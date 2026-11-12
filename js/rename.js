// Renaming a data table's column carries the new name to everything that uses
// it: the table's calculated columns and pipeline, and the transforms,
// analyses and graphs downstream. A column stacked by "wide → long" becomes a
// group there (e.g. column "Control" → group "Control"), so the group's new
// name follows too: control groups, filters, per-group colours…
import { depsOf } from './model.js';
import { rsym } from './rcode.js';
import { GEOMS } from './codegen/graph.js';

// Renames a column in an R expression: `old name` or old_name as a symbol, but
// not inside strings, not as a function name (old(…)), an argument name
// (old = …) or after $ / @ / ::.
export function renameInExpr(expr, from, to) {
  if (expr == null || from === to) return expr;
  const s = String(expr);
  const repl = rsym(to);
  const syntactic = /^[A-Za-z.][A-Za-z0-9._]*$/.test(from);
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < s.length && s[j] !== c) j += s[j] === '\\' ? 2 : 1;
      out += s.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === '`') {
      let j = s.indexOf('`', i + 1);
      if (j < 0) j = s.length;
      out += s.slice(i + 1, j) === from ? repl : s.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (/[A-Za-z.]/.test(c) && !/[A-Za-z0-9._]/.test(s[i - 1] || '')) {
      const word = /^[A-Za-z.][A-Za-z0-9._]*/.exec(s.slice(i))[0];
      const before = s.slice(0, i).trimEnd();
      const after = s.slice(i + word.length).trimStart();
      const keep = !syntactic || word !== from || after.startsWith('(') || (after.startsWith('=') && !after.startsWith('=='))
        || /(\$|@|::)$/.test(before);
      out += keep ? word : repl;
      i += word.length;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

// What is renamed: cols (old → new column name) and levels (column → (old → new group name)).
const blank = () => ({ cols: new Map(), levels: new Map() });
const isEmpty = (R) => !R.cols.size && ![...R.levels.values()].some((m) => m.size);
const col = (R) => (v) => (typeof v === 'string' && R.cols.has(v) ? R.cols.get(v) : v);
const level = (R, column) => {
  const m = R.levels.get(column);
  return (v) => (m && typeof v === 'string' && m.has(v) ? m.get(v) : v);
};
const exprs = (R, e) => {
  let out = e;
  for (const [a, b] of R.cols) out = renameInExpr(out, a, b);
  return out;
};

// Transform steps (a transform's, or a data table's own pipeline). Returns what
// is renamed in the result, for whatever uses it next.
export function renameInSteps(steps, R0) {
  const R = { cols: new Map(R0.cols), levels: new Map([...R0.levels].map(([k, v]) => [k, new Map(v)])) };
  for (const s of steps || []) {
    const c = col(R);
    const L = level(R, c(s.column));
    for (const k of ['column', 'names_from', 'values_from', 'names_col', 'from']) if (typeof s[k] === 'string' && s[k]) s[k] = c(s[k]);
    for (const k of ['cols', 'id_cols', 'columns', 'group_by', 'by']) if (Array.isArray(s[k])) s[k] = s[k].map(c);
    if (s.expr) s.expr = exprs(R, s.expr);
    if (typeof s.value === 'string') s.value = L(s.value);
    if (Array.isArray(s.values)) s.values = s.values.map(L);
    if (Array.isArray(s.levels)) s.levels = s.levels.map(L);
    if (s.disabled) continue;
    // After the step: a column it renames is no longer called what we renamed it to.
    if (s.type === 'rename') for (const [a, b] of [...R.cols]) if (b === s.from) R.cols.delete(a);
    // Stacked columns become groups (levels) of the names column.
    if (s.type === 'pivot_longer') {
      const names = s.names_to || 'group';
      for (const [a, b] of [...R.cols]) {
        if (!s.all && !(s.cols || []).includes(b)) continue;
        R.cols.delete(a);
        if (!R.levels.has(names)) R.levels.set(names, new Map());
        R.levels.get(names).set(a, b);
      }
    }
  }
  return R;
}

export function renameInAnalysis(a, R) {
  const c = col(R);
  for (const k of ['y', 'group', 'x', 'subject', 'factorB']) if (typeof a[k] === 'string' && a[k]) a[k] = c(a[k]);
  for (const k of ['columns', 'fixed', 'random']) if (Array.isArray(a[k])) a[k] = a[k].map(c);
  const o = a.options || {};
  if (typeof o.by === 'string') o.by = c(o.by);
  if (a.layout === 'columns') {
    // Each column is a group.
    if (Array.isArray(a.groups)) a.groups = a.groups.map(c);
    if (typeof o.control === 'string') o.control = c(o.control);
  } else {
    const L = level(R, a.group);
    if (Array.isArray(a.groups)) a.groups = a.groups.map(L);
    if (typeof o.control === 'string') o.control = L(o.control);
  }
}

// The parts of a graph that use dataset `src`.
export function renameInGraph(g, src, R) {
  const c = col(R);
  const aes = (map) => { for (const m of Object.values(map || {})) if (m && m.mode === 'col' && m.col) m.col = c(m.col); };
  if (g.base?.dataset === src) aes(g.base.aes);
  let main = null;
  for (const l of g.layers || []) {
    const ds = l.dataset || g.base?.dataset;
    if (!main && GEOMS[l.geom] && !GEOMS[l.geom].noData) main = { l, ds };
    if (ds !== src) continue;
    aes(l.aes);
    for (const p of Array.isArray(GEOMS[l.geom]?.params) ? GEOMS[l.geom].params : []) {
      if (!l.params) break;
      if (p.type === 'column' && typeof l.params[p.key] === 'string') l.params[p.key] = c(l.params[p.key]);
      if (p.type === 'columns' && Array.isArray(l.params[p.key])) l.params[p.key] = l.params[p.key].map(c);
    }
  }
  const onMain = main?.ds === src;
  if (onMain && g.facet?.by) g.facet.by = c(g.facet.by);
  const xCol = main ? (main.l.aes?.x?.mode === 'col' ? main.l.aes.x.col : g.base?.aes?.x?.col) : null;
  for (const ann of g.annotations || []) {
    if (ann.kind === 'compare' && onMain) {
      if (ann.subject) ann.subject = c(ann.subject);
      if (typeof ann.ref === 'string') ann.ref = level(R, xCol)(ann.ref);
    }
    if (ann.dataset === src) {
      if (ann.x) ann.x = c(ann.x);
      if (ann.y) ann.y = c(ann.y);
    }
  }
  // Colours chosen per group.
  const manual = g.palette?.manual;
  if (manual && [...g.layers || [], g.base].some((l) => (l?.dataset || g.base?.dataset) === src)) {
    for (const m of R.levels.values()) {
      for (const [a, b] of m) if (a in manual && !(b in manual)) { manual[b] = manual[a]; delete manual[a]; }
    }
  }
}

// Renames column `from` of data table `table` to `to` everywhere it is used.
// Returns the ids of the items that may have changed.
export function renameColumn(project, table, from, to) {
  if (!from || !to || from === to) return [];
  const R0 = blank();
  R0.cols.set(from, to);
  for (const c of table.columns || []) if (c.formula != null) c.formula = renameInExpr(c.formula, from, to);
  if (table.pipe?.steps?.length) renameInSteps(table.pipe.steps, R0);
  const changed = [table.id];
  const queue = [[table.id, R0]];
  const done = new Set([table.id]);
  while (queue.length) {
    const [src, R] = queue.shift();
    if (isEmpty(R)) continue;
    for (const it of project.items) {
      if (!depsOf(it).includes(src)) continue;
      if (it.kind === 'transform') {
        const out = renameInSteps(it.steps, R);
        if (!done.has(it.id)) { done.add(it.id); queue.push([it.id, out]); }
      } else if (it.kind === 'analysis') renameInAnalysis(it, R);
      else if (it.kind === 'graph') renameInGraph(it, src, R);
      if (!changed.includes(it.id)) changed.push(it.id);
    }
  }
  return changed;
}
