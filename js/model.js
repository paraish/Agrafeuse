// The project: an ordered list of items (data tables, transforms, analyses,
// graphs). Everything the app knows lives in this plain JSON object, which is
// what gets saved inside the .RData file.
import { toRName } from './rcode.js';
import { dataCode } from './codegen/data.js';
import { transformCode } from './codegen/transform.js';
import { analysisCode, analysisPackages, TESTS, testDefaults } from './codegen/stats.js';
import { graphCode, graphDeps } from './codegen/graph.js';

export const KINDS = {
  data: { label: 'Data tables', one: 'Data table', prefix: 'Data', fallback: 'data' },
  transform: { label: 'Transforms', one: 'Transform', prefix: 'Transform', fallback: 'data' },
  analysis: { label: 'Analyses', one: 'Analysis', prefix: 'Analysis', fallback: 'stats' },
  graph: { label: 'Graphs', one: 'Graph', prefix: 'Graph', fallback: 'plot' },
};

// Names that would shadow functions people use all the time.
const AVOID = ['c', 't', 'T', 'F', 'D', 'I', 'q', 'data', 'mean', 'sd', 'df', 'plot', 'table', 'list',
  'matrix', 'sum', 'max', 'min', 'log', 'exp', 'gamma', 'beta', 'pt', 'qt', 'd', 'w', 'fit', 'emm', 'mc',
  'test', 'cmp', 'start', 'value', 'group', 'factor', 'levels', 'names', 'length', 'summary', 'print'];

export function emptyProject(name = 'Untitled project') {
  return { format: 'agrafeuse', version: 1, name, seq: 0, items: [] };
}

export function getItem(project, id) {
  return project.items.find((it) => it.id === id) || null;
}

export function itemsOf(project, kind) {
  return project.items.filter((it) => it.kind === kind);
}

export function newId(project, kind) {
  project.seq = (project.seq || 0) + 1;
  return `${kind[0]}${project.seq}`;
}

export function assignRName(project, item) {
  const taken = new Set([...AVOID, ...project.items.filter((it) => it !== item).map((it) => it.rname)]);
  item.rname = toRName(item.name, taken, KINDS[item.kind].fallback);
  return item.rname;
}

export function nextName(project, kind, base = KINDS[kind].prefix) {
  const names = new Set(project.items.map((it) => it.name));
  for (let i = 1; ; i++) {
    const n = `${base} ${i}`;
    if (!names.has(n)) return n;
  }
}

export function addItem(project, item) {
  item.id = item.id || newId(project, item.kind);
  if (!item.name) item.name = nextName(project, item.kind);
  assignRName(project, item);
  project.items.push(item);
  return item;
}

export function newDataTable(project, { name, columns, rows, rowNames } = {}) {
  const cols = columns || [{ name: 'Group A', type: 'auto' }, { name: 'Group B', type: 'auto' }, { name: 'Group C', type: 'auto' }];
  return addItem(project, {
    kind: 'data', name,
    columns: cols,
    rows: rows || [],
    rowNames: rowNames || [],
  });
}

export function newTransform(project, input, steps = [], name) {
  const src = getItem(project, input);
  return addItem(project, {
    kind: 'transform',
    name: name || (src ? uniqueName(project, `${src.name} (transformed)`) : undefined),
    input, steps,
  });
}

export function newAnalysis(project, test, dataset, extra = {}) {
  return addItem(project, {
    kind: 'analysis',
    name: extra.name || uniqueName(project, TESTS[test].label),
    test, dataset, layout: 'long', y: '', group: '', subject: '', columns: [], groups: [],
    factorB: '', x: '', fixed: [], random: [],
    options: testDefaults(test),
    ...extra,
  });
}

export function newGraph(project, extra = {}) {
  return addItem(project, {
    kind: 'graph',
    layers: [],
    labels: { title: '', x: '', y: '', legend: '' },
    theme: { name: 'lab', base_size: 14, legend: 'right', x_angle: 0 },
    palette: { name: 'default', manual: {} },
    x_scale: { trans: 'identity', min: '', max: '', from_zero: false },
    y_scale: { trans: 'identity', min: '', max: '', from_zero: false },
    facet: { by: '', scales: 'fixed', ncol: '' },
    flip: false,
    size: { width: 5, height: 4, dpi: 300 },
    annotations: [],
    custom: '',
    ...extra,
  });
}

export function uniqueName(project, base) {
  const names = new Set(project.items.map((it) => it.name));
  if (!names.has(base)) return base;
  for (let i = 2; ; i++) if (!names.has(`${base} ${i}`)) return `${base} ${i}`;
}

// Items an item reads from (must be computed first).
export function depsOf(item) {
  switch (item.kind) {
    case 'transform': return item.input ? [item.input] : [];
    case 'analysis': return item.dataset ? [item.dataset] : [];
    case 'graph': return graphDeps(item);
    default: return [];
  }
}

// Every item that (directly or indirectly) uses `id`.
export function dependentsOf(project, id) {
  const out = new Set();
  let grew = true;
  while (grew) {
    grew = false;
    for (const it of project.items) {
      if (out.has(it.id)) continue;
      if (depsOf(it).some((d) => d === id || out.has(d))) { out.add(it.id); grew = true; }
    }
  }
  return [...out];
}

// Data first, then everything in an order where dependencies come first.
export function topoOrder(project) {
  const order = [];
  const seen = new Set();
  const visiting = new Set();
  const visit = (it) => {
    if (!it || seen.has(it.id)) return;
    if (visiting.has(it.id)) throw new Error(`"${it.name}" depends on itself.`);
    visiting.add(it.id);
    for (const d of depsOf(it)) visit(getItem(project, d));
    visiting.delete(it.id);
    seen.add(it.id);
    order.push(it);
  };
  const rank = { data: 0, transform: 1, analysis: 2, graph: 3 };
  [...project.items].sort((a, b) => rank[a.kind] - rank[b.kind]).forEach(visit);
  return order;
}

// Candidate datasets for transforms, analyses and graph layers.
export function datasets(project) {
  return project.items.filter((it) => it.kind === 'data' || it.kind === 'transform');
}

// options.mixedEngine: 'lme4' (default) or 'nlme', for mixed-effects analyses.
export function itemCode(project, item, schemaOf, options = {}) {
  const rnameOf = (id) => {
    const it = getItem(project, id);
    if (!it) throw new Error('A dataset this uses was deleted.');
    return it.rname;
  };
  const ctx = {
    rnameOf, schemaOf, mixedEngine: options.mixedEngine || 'lme4',
    analyses: Object.fromEntries(itemsOf(project, 'analysis').map((a) => [a.id, a])),
  };
  switch (item.kind) {
    case 'data': return dataCode(item);
    case 'transform': {
      if (!item.input) throw new Error('Choose the dataset to transform.');
      return transformCode(item, rnameOf(item.input), schemaOf(item.input));
    }
    case 'analysis': return analysisCode(item, ctx);
    case 'graph': return graphCode(item, ctx);
    default: throw new Error(`Unknown item kind ${item.kind}`);
  }
}

export function itemPackages(item, options = {}) {
  return item.kind === 'analysis' ? analysisPackages(item, options) : [];
}

export function removeItem(project, id) {
  project.items = project.items.filter((it) => it.id !== id);
  // Drop references so nothing points at a deleted item.
  for (const it of project.items) {
    if (it.kind === 'graph') {
      it.annotations = (it.annotations || []).filter((a) => a.analysis !== id);
      for (const l of it.layers || []) if (l.dataset === id) l.dataset = '';
    }
    if (it.kind === 'transform' && it.input === id) it.input = '';
    if (it.kind === 'analysis' && it.dataset === id) it.dataset = '';
  }
}

export function clone(x) {
  return JSON.parse(JSON.stringify(x));
}
