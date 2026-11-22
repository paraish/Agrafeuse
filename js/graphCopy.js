// A graph's look applied to other data: a copy of the graph that draws another
// dataset, with each column it used matched to a column of the new data.
// Everything else (layers, colours, theme, fonts, sizes, text boxes, tests on
// the graph) is kept.
import { clone, newId, uniqueName, assignRName, getItem } from './model.js';
import { plotBase, GEOMS, AES } from './codegen/graph.js';
import { renameInGraph } from './rename.js';

const dataLayers = (g) => (g.layers || []).filter((l) => GEOMS[l.geom] && !GEOMS[l.geom].noData);

// The dataset a graph mainly draws: the plot-wide one, or the first layer's.
export function mainDataset(g) {
  return plotBase(g).dataset || dataLayers(g).find((l) => l.dataset)?.dataset || '';
}

// The columns of dataset `ds` the graph uses, in order: [{ col, roles: ['X', 'Colour'…] }].
export function usedColumns(g, ds) {
  const out = new Map();
  const add = (col, role) => {
    if (!col) return;
    if (!out.has(col)) out.set(col, []);
    if (!out.get(col).includes(role)) out.get(col).push(role);
  };
  const base = plotBase(g);
  const aes = (map) => { for (const [k, m] of Object.entries(map || {})) if (m?.mode === 'col' && m.col) add(m.col, AES[k]?.label || k); };
  if (base.dataset === ds) aes(base.aes);
  for (const l of dataLayers(g)) {
    if ((l.dataset || base.dataset) !== ds) continue;
    aes(l.aes);
    for (const p of Array.isArray(GEOMS[l.geom].params) ? GEOMS[l.geom].params : []) {
      const v = l.params?.[p.key];
      if (p.type === 'column' && v) add(v, p.label);
      if (p.type === 'columns' && Array.isArray(v)) v.forEach((c) => add(c, p.label));
    }
  }
  if (g.facet?.by && mainDataset(g) === ds) add(g.facet.by, 'Panels');
  for (const a of g.annotations || []) if (a.kind === 'compare' && a.paired && a.subject) add(a.subject, 'Subject');
  return [...out].map(([col, roles]) => ({ col, roles }));
}

// A first guess at the new column for each one used: the same name, else an
// unused column of the same kind (numbers or groups), in order.
export function guessMapping(used, oldSchema, newSchema) {
  const cols = newSchema?.columns || [];
  const type = (schema, name) => (schema?.columns?.find((c) => c.name === name)?.type === 'numeric' ? 'numeric' : 'group');
  const taken = new Set();
  const map = {};
  for (const { col } of used) if (cols.some((c) => c.name === col)) { map[col] = col; taken.add(col); }
  for (const { col } of used) {
    if (map[col]) continue;
    const want = type(oldSchema, col);
    const pick = cols.find((c) => !taken.has(c.name) && (c.type === 'numeric' ? 'numeric' : 'group') === want && !/^row_name/.test(c.name))
      || cols.find((c) => !taken.has(c.name) && (c.type === 'numeric' ? 'numeric' : 'group') === want)
      || cols.find((c) => !taken.has(c.name));
    map[col] = pick?.name || '';
    if (pick) taken.add(pick.name);
  }
  return map;
}

// Adds (after `g`) and returns a copy of graph g that draws dataset `to` where
// it drew `from`, with columns renamed by `mapping` ({ old: new }).
export function graphForDataset(project, g, from, to, mapping) {
  const c = clone(g);
  c.id = newId(project, 'graph');
  c.name = uniqueName(project, `${g.name} (${getItem(project, to)?.name || 'copy'})`);
  assignRName(project, c);
  const changed = (col) => !!col && mapping[col] != null && mapping[col] !== col;
  // What the axis and legend titles described, before the swap.
  const main = dataLayers(c).find((l) => (l.aes?.x?.mode === 'col')) || null;
  const base = plotBase(c);
  const colOf = (k) => (main?.aes?.[k]?.mode === 'col' ? main.aes[k].col : base.aes?.[k]?.mode === 'col' ? base.aes[k].col : '');
  const before = { x: colOf('x'), y: colOf('y'), legend: colOf('fill') || colOf('colour') };

  if (c.base?.dataset === from) c.base.dataset = to;
  for (const l of c.layers || []) if (l.dataset === from) l.dataset = to;
  // Results of analyses of the old data do not belong on the new data (tests run on the graph itself stay).
  c.annotations = (c.annotations || []).filter((a) => a.kind === 'compare' || (!a.analysis && a.dataset !== from));
  for (const a of c.annotations) if (a.ref && changed(before.x)) delete a.ref; // a control group of the old data
  const R = { cols: new Map(Object.entries(mapping).filter(([a, b]) => b && a !== b)), levels: new Map() };
  renameInGraph(c, to, R);

  // Titles typed for the old columns, and the ranges of their axes, go when the column changes.
  const L = c.labels = c.labels || {};
  if (changed(before.x)) { L.x = ''; if (c.x_scale) { c.x_scale.min = ''; c.x_scale.max = ''; } }
  if (changed(before.y)) { L.y = ''; if (c.y_scale) { c.y_scale.min = ''; c.y_scale.max = ''; } }
  if (changed(before.legend)) L.legend = '';
  project.items.splice(project.items.indexOf(g) + 1, 0, c);
  return c;
}
