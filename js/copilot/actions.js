// What the assistant can do: a small set of JSON actions, each mapped onto
// the same project changes the user makes by hand. Actions are checked before
// they run (items and columns must exist), and a whole batch is one undo step.
import { STEP_TYPES } from '../codegen/transform.js';
import { TESTS, testDefaults } from '../codegen/stats.js';
import { GEOMS, AES, PLOT_AES, NOTE_DEFAULTS, PALETTES, THEMES, geomDefaults, ensureBase, sideBySide, effectiveLayers } from '../codegen/graph.js';
import { GRAPH_TEMPLATES, graphFromTemplate } from '../ui/templates.js';
import { getItem, newTransform, newAnalysis, uniqueName } from '../model.js';
import { openPipeline } from '../ui/pipePanel.js';

// The instructions the model gets (kept short: small models have small context windows).
export const ACTION_GUIDE = `Answer with ONE JSON object and nothing else:
{"reply": "<short message for the user>", "actions": [<actions>]}
Use "actions": [] when the user only asks a question. Use exact item and column names from the project.
Actions ("graph"/"table"/"dataset" may be left out to mean the item that is open or was just made):
{"do":"pipeline_step","table":T,"step":STEP} add a dplyr step to a data table's own pipeline (shown next to it)
{"do":"new_transform","from":D,"name":N,"steps":[STEP,...]} make a new dataset from another one
{"do":"new_analysis","test":TEST,"dataset":D,"y":C,"group":C, plus "subject":C | "factorB":C | "x":C | "fixed":[C] | "random":[C] when the test needs them, "groups":[two levels] for two-group tests}
{"do":"new_graph","template":TEMPLATE,"dataset":D,"x":C,"y":C,"group":C}
{"do":"add_layer","graph":G,"geom":GEOM,"aes":{"colour":C or {"value":"#d62728"},"size":{"value":3}}}
{"do":"plot_aes","graph":G,"aes":{"x":C,"y":C,"colour":C,"fill":C,"shape":C,"group":C}} mappings for every layer (null removes one)
{"do":"compare_groups","graph":G,"method":"t.test|t.test.equal|wilcox.test","comparisons":"all|control|none","ref":LEVEL,"paired":false,"subject":C,"format":"stars|p","hide_ns":false}
{"do":"show_analysis","graph":G,"analysis":A} draw an analysis's p values on a graph
{"do":"text_box","graph":G,"text":TEXT,"x":0-1,"y":0-1}
{"do":"labels","graph":G,"title":T,"x":T,"y":T,"legend":T}
{"do":"axis","graph":G,"axis":"x|y","scale":"linear|log10|log2|sqrt","min":N,"max":N,"from_zero":true}
{"do":"style","graph":G,"palette":"okabe|viridis|grey|Set1|Set2|Dark2","theme":"lab|classic|bw|minimal","legend":"right|top|bottom|none"}
{"do":"open","item":NAME}
STEP is one of:
{"type":"filter","column":C,"op":"==|!=|>|>=|<|<=","value":V} {"type":"filter","column":C,"op":"in","values":[V]} {"type":"filter","op":"expr","expr":"R condition"}
{"type":"select","columns":[C],"drop":false} {"type":"mutate","name":C,"expr":"R expression"} {"type":"rename","from":C,"to":C}
{"type":"group_by","columns":[C]} {"type":"ungroup"} {"type":"summarise","column":C,"stats":["mean","sd","sem","n","median","min","max"],"group_by":[C]}
{"type":"arrange","column":C,"desc":false} {"type":"count","columns":[C]} {"type":"slice","mode":"head|tail|max|min","n":5,"column":C}
{"type":"distinct","columns":[C]} {"type":"drop_na","columns":[C]} {"type":"pivot_longer","cols":[C],"names_to":"group","values_to":"value"} {"type":"pivot_wider","names_from":C,"values_from":C}
TEST: ${Object.entries(TESTS).map(([k, t]) => `${k}${testNeeds(t)}`).join(' | ')}
TEMPLATE: ${GRAPH_TEMPLATES.filter((t) => t.key !== 'blank').map((t) => t.key + (t.needs.includes('group') ? '(group)' : '')).join(' | ')}
GEOM: ${Object.keys(GEOMS).filter((k) => !GEOMS[k].custom).join(' | ')}
Tests and most graphs need long data (one row per value, a group column and a value column); a table with one column per group can be made long with pivot_longer.`;

function testNeeds(t) {
  const i = t.inputs || {};
  const n = [i.x && 'x', i.y && 'y', i.group === true && 'group', i.subject && 'subject', i.factorB && 'factorB', i.fixed && 'fixed', i.random && 'random'].filter(Boolean);
  return n.length ? `(${n.join(',')})` : '';
}

// ---- reading the model's answer ---------------------------------------------------------------

// The JSON object in a reply, also when it comes in a code fence, after a <think> block, or with prose around it.
export function parseReply(text) {
  const clean = String(text || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  const start = clean.indexOf('{');
  const end = clean.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      const obj = JSON.parse(clean.slice(start, end + 1));
      if (obj && typeof obj === 'object') {
        return { reply: String(obj.reply ?? obj.message ?? ''), actions: Array.isArray(obj.actions) ? obj.actions.filter((a) => a && typeof a === 'object') : [] };
      }
    } catch { /* not JSON: show it as text */ }
  }
  return { reply: clean, actions: [], unparsed: true };
}

// ---- describing actions (the plan the user approves) -----------------------------------------

const list = (v) => (Array.isArray(v) ? v.join(', ') : v ?? '');

export function describeAction(a) {
  const on = (key, fallback) => (a[key] ? `"${a[key]}"` : fallback);
  switch (a.do) {
    case 'pipeline_step': return `Add ${stepText(a.step)} to the pipeline of ${on('table', 'the open table')}`;
    case 'new_transform': return `Make a new dataset${a.name ? ` "${a.name}"` : ''} from ${on('from', 'the open dataset')}: ${(a.steps || []).map(stepText).join(', then ') || 'a copy'}`;
    case 'new_analysis': {
      const t = TESTS[a.test];
      const vars = ['y', 'group', 'subject', 'factorB', 'x'].filter((k) => a[k]).map((k) => `${k} = ${a[k]}`);
      if (a.fixed) vars.push(`fixed = ${list(a.fixed)}`);
      if (a.random) vars.push(`random = ${list(a.random)}`);
      return `Run ${t ? t.label : a.test} on ${on('dataset', 'the open dataset')}${vars.length ? ` (${vars.join(', ')})` : ''}`;
    }
    case 'new_graph': {
      const t = GRAPH_TEMPLATES.find((x) => x.key === a.template);
      return `Make a graph: ${t ? t.label.toLowerCase() : a.template} of ${on('dataset', 'the open dataset')}${a.x ? `, X = ${a.x}` : ''}${a.y ? `, Y = ${a.y}` : ''}${a.group ? `, groups = ${a.group}` : ''}`;
    }
    case 'add_layer': return `Add a layer to ${on('graph', 'the graph')}: ${GEOMS[a.geom]?.label || a.geom}`;
    case 'plot_aes': return `On ${on('graph', 'the graph')}, map for every layer: ${Object.entries(a.aes || {}).map(([k, v]) => `${AES[k]?.label || k} = ${v ?? 'none'}`).join(', ')}`;
    case 'compare_groups': return `Compare the groups on ${on('graph', 'the graph')} (${{ 't.test.equal': 't test', 'wilcox.test': 'Mann-Whitney / Wilcoxon' }[a.method] || "Welch's t test"}${a.comparisons === 'control' ? `, each against ${a.ref || 'the first group'}` : a.comparisons === 'none' ? ', overall test only' : ''}${a.paired ? `, paired by ${a.subject}` : ''})`;
    case 'show_analysis': return `Show the p values of ${on('analysis', 'the analysis')} on ${on('graph', 'the graph')}`;
    case 'text_box': return `Add the text "${String(a.text ?? '').split('\n')[0]}" to ${on('graph', 'the graph')}`;
    case 'labels': return `Set titles on ${on('graph', 'the graph')}: ${['title', 'x', 'y', 'legend'].filter((k) => a[k] != null).map((k) => `${k} "${a[k]}"`).join(', ')}`;
    case 'axis': return `${(a.axis || 'y').toUpperCase()} axis of ${on('graph', 'the graph')}: ${[a.scale && a.scale !== 'linear' ? `${a.scale} scale` : a.scale, a.min != null || a.max != null ? `range ${a.min ?? 'auto'} to ${a.max ?? 'auto'}` : null, a.from_zero ? 'start at 0' : null].filter(Boolean).join(', ') || 'reset'}`;
    case 'style': return `Style ${on('graph', 'the graph')}: ${['palette', 'theme', 'legend'].filter((k) => a[k]).map((k) => `${k} ${a[k]}`).join(', ')}`;
    case 'open': return `Open "${a.item}"`;
    default: return `Unknown action "${a.do}" (will be skipped)`;
  }
}

function stepText(s) {
  if (!s || !STEP_TYPES[s.type]) return `an unknown step${s?.type ? ` "${s.type}"` : ''}`;
  const t = STEP_TYPES[s.type];
  const bits = {
    filter: s.op === 'expr' ? s.expr : s.op === 'in' ? `${s.column} in ${list(s.values)}` : `${s.column} ${s.op || '=='} ${s.value ?? ''}`,
    select: `${s.drop ? 'drop' : 'keep'} ${list(s.columns)}`,
    mutate: `${s.name} = ${s.expr}`,
    rename: `${s.from} → ${s.to}`,
    group_by: list(s.columns),
    summarise: `${list(s.stats || ['mean', 'sd', 'sem', 'n'])} of ${s.column}${s.group_by?.length ? ` by ${list(s.group_by)}` : ''}`,
    arrange: `${s.column}${s.desc ? ' (largest first)' : ''}`,
    count: list(s.columns),
    slice: `${s.mode || 'head'} ${s.n ?? 5}${s.column ? ` by ${s.column}` : ''}`,
    pivot_longer: list(s.cols),
  }[s.type];
  return `${t.verb}${bits ? ` (${bits})` : ''}`;
}

// ---- applying actions --------------------------------------------------------------------------

class Skip extends Error {}

// Runs the actions in order. Returns [{ text, ok, note }] and the item to show.
export function applyActions(app, actions) {
  const store = app.store;
  const p = store.project;
  const ctx = { app, p, made: {}, last: {}, show: null };
  const results = [];
  store.takeSnapshot(); // so the whole batch is one undo step
  for (const a of actions) {
    const text = describeAction(a);
    try {
      const note = run(ctx, a);
      results.push({ text, ok: true, note });
    } catch (e) {
      results.push({ text, ok: false, note: e instanceof Skip ? e.message : `Error: ${e.message}` });
    }
  }
  store.change(null, { structural: true });
  store.takeSnapshot();
  if (ctx.show) store.select(ctx.show);
  return results;
}

function run(ctx, a) {
  const handler = HANDLERS[a.do];
  if (!handler) throw new Skip(`The app has no action "${a.do}".`);
  return handler(ctx, a);
}

// Items by name: exact, then ignoring case and spaces, then the start of the name.
function findItem(ctx, name, kinds) {
  const pool = ctx.p.items.filter((it) => kinds.includes(it.kind));
  if (!name) return null;
  const key = String(name).trim();
  const madeId = ctx.made[key.toLowerCase()];
  if (madeId) return getItem(ctx.p, madeId);
  const norm = (s) => String(s).toLowerCase().replace(/\s+/g, ' ').trim();
  return pool.find((it) => it.name === key) || pool.find((it) => norm(it.name) === norm(key))
    || pool.find((it) => it.rname === key) || pool.find((it) => norm(it.name).startsWith(norm(key))) || null;
}

// The item an action is about: named, else the one just made, else the open one.
function target(ctx, name, kinds, what) {
  if (name) {
    const it = findItem(ctx, name, kinds);
    if (!it) throw new Skip(`There is no ${what} called "${name}".`);
    return it;
  }
  for (const k of kinds) if (ctx.last[k]) return getItem(ctx.p, ctx.last[k]);
  const open = ctx.app.store.item();
  if (open && kinds.includes(open.kind)) return open;
  if (open?.kind === 'graph' && kinds.some((k) => k === 'data' || k === 'transform')) {
    const ds = effectiveLayers(open).find((l) => l.dataset)?.dataset;
    if (ds) return getItem(ctx.p, ds);
  }
  if (open?.kind === 'analysis' && kinds.some((k) => k === 'data' || k === 'transform')) return getItem(ctx.p, open.dataset);
  throw new Skip(`Say which ${what} to use.`);
}

function made(ctx, item, requested) {
  ctx.last[item.kind] = item.id;
  if (requested) ctx.made[String(requested).trim().toLowerCase()] = item.id;
  ctx.made[item.name.toLowerCase()] = item.id;
}

// Column names as the dataset spells them (fixing case); unknown ones are an error
// when the dataset's columns are known.
function columnFixer(ctx, datasetId) {
  const cols = ctx.app.engine.schemaOf(datasetId)?.columns?.map((c) => c.name);
  return (name, label = 'column') => {
    if (name == null || name === '') return name;
    if (!cols) return String(name);
    const s = String(name);
    const hit = cols.find((c) => c === s) || cols.find((c) => c.toLowerCase() === s.toLowerCase());
    if (!hit) throw new Skip(`"${s}" is not a ${label} of this data (it has ${cols.join(', ')}).`);
    return hit;
  };
}

function levelsOf(ctx, datasetId, col) {
  return ctx.app.engine.schemaOf(datasetId)?.columns?.find((c) => c.name === col)?.levels || [];
}

// A step as the pipeline and transforms store it: defaults, then what the model said,
// with column names checked where the columns are known. `fixCol` checks against the input.
function makeStep(step, fixCol, schema) {
  if (!step || !STEP_TYPES[step.type]) throw new Skip(`Unknown step "${step?.type}".`);
  const out = { type: step.type, ...STEP_TYPES[step.type].defaults(schema) };
  for (const [k, v] of Object.entries(step)) if (k !== 'type' && v !== undefined) out[k] = v;
  // Columns can only be checked for the first step (later ones see columns made on the way).
  if (fixCol) {
    for (const k of ['column', 'from', 'names_from', 'values_from']) if (typeof out[k] === 'string' && out[k]) out[k] = fixCol(out[k]);
    for (const k of ['columns', 'cols', 'group_by', 'by', 'id_cols']) if (Array.isArray(out[k])) out[k] = out[k].map((c) => fixCol(c));
  }
  if (out.type === 'filter' && out.op === 'in' && !Array.isArray(out.values)) out.values = [out.value].filter((v) => v != null);
  if (out.type === 'filter' && out.value != null) out.value = String(out.value);
  if (out.type === 'slice' && out.n != null) out.n = Number(out.n);
  if (out.type === 'summarise' && !(out.stats || []).length) out.stats = ['mean', 'sd', 'sem', 'n'];
  if (out.type === 'pivot_longer') {
    out.names_to = out.names_to || 'group';
    out.values_to = out.values_to || 'value';
    if (out.drop_na === undefined) out.drop_na = true;
  }
  return out;
}

function graphOf(ctx, a) {
  const g = target(ctx, a.graph, ['graph'], 'graph');
  ensureBase(g);
  return g;
}

const aesValue = (v) => {
  if (v == null || v === '') return null;
  if (typeof v === 'string') return { mode: 'col', col: v };
  if (typeof v === 'object' && 'value' in v) return { mode: 'const', value: v.value };
  if (typeof v === 'object' && v.col) return { mode: 'col', col: v.col };
  return null;
};

const HANDLERS = {
  open(ctx, a) {
    const it = findItem(ctx, a.item, ['data', 'transform', 'analysis', 'graph']);
    if (!it) throw new Skip(`There is no item called "${a.item}".`);
    ctx.show = it.id;
  },

  pipeline_step(ctx, a) {
    const t = target(ctx, a.table || a.dataset, ['data'], 'data table');
    t.pipe = t.pipe || { steps: [] };
    const first = !t.pipe.steps.some((s) => !s.disabled);
    const schema = ctx.app.engine.schemaOf(t.id);
    t.pipe.steps.push(makeStep(a.step, first ? columnFixer(ctx, t.id) : null, schema));
    openPipeline(t.id);
    ctx.show = t.id;
    ctx.last.data = t.id;
  },

  new_transform(ctx, a) {
    const src = target(ctx, a.from || a.dataset, ['data', 'transform'], 'dataset');
    const schema = ctx.app.engine.schemaOf(src.id);
    const steps = (a.steps || []).map((s, i) => makeStep(s, i === 0 ? columnFixer(ctx, src.id) : null, schema));
    const t = newTransform(ctx.p, src.id, steps, uniqueName(ctx.p, a.name || `${src.name} (transformed)`));
    made(ctx, t, a.name);
    ctx.show = t.id;
  },

  new_analysis(ctx, a) {
    const test = TESTS[a.test];
    if (!test) throw new Skip(`Unknown test "${a.test}".`);
    const ds = target(ctx, a.dataset, ['data', 'transform'], 'dataset');
    const fix = columnFixer(ctx, ds.id);
    const inputs = test.inputs || {};
    const extra = { layout: 'long' };
    for (const k of ['y', 'group', 'subject', 'factorB', 'x']) if (a[k]) extra[k] = fix(a[k]);
    for (const k of ['fixed', 'random']) if (Array.isArray(a[k])) extra[k] = a[k].map((c) => fix(c));
    const need = (k, label) => { if (inputs[k] === true && !extra[k] && !(k === 'fixed' && extra.fixed?.length)) throw new Skip(`${test.label} needs ${label}.`); };
    need('y', 'a value column (y)'); need('group', 'a group column'); need('subject', 'a subject column');
    need('factorB', 'a second factor (factorB)'); need('x', 'an x column');
    if (inputs.fixed && !extra.fixed?.length) extra.fixed = [extra.group].filter(Boolean);
    if (inputs.random && !extra.random?.length && extra.subject) extra.random = [extra.subject];
    if (inputs.two) {
      const lv = levelsOf(ctx, ds.id, extra.group);
      extra.groups = Array.isArray(a.groups) && a.groups.length >= 2 ? a.groups.map(String).slice(0, 2) : lv.slice(0, 2);
    }
    const opts = testDefaults(a.test);
    for (const [k, v] of Object.entries(a.options || {})) if (k in opts || test.options.some((o) => o.key === k)) opts[k] = v;
    if (a.name) extra.name = uniqueName(ctx.p, a.name);
    const an = newAnalysis(ctx.p, a.test, ds.id, { ...extra, options: opts });
    made(ctx, an, a.name);
    ctx.show = an.id;
  },

  new_graph(ctx, a) {
    const tpl = GRAPH_TEMPLATES.find((t) => t.key === a.template) || GRAPH_TEMPLATES[0];
    const ds = target(ctx, a.dataset, ['data', 'transform'], 'dataset');
    const fix = columnFixer(ctx, ds.id);
    const x = fix(a.x), y = fix(a.y), group = fix(a.group);
    for (const k of tpl.needs) if (!{ x, y, group }[k]) throw new Skip(`A ${tpl.label.toLowerCase()} needs ${k === 'group' ? 'a group column' : `an ${k.toUpperCase()} column`}.`);
    const g = graphFromTemplate(ctx.p, tpl.key, { dataset: ds.id, x, y, group, name: uniqueName(ctx.p, a.name || `${ds.name} graph`) });
    made(ctx, g, a.name);
    ctx.show = g.id;
  },

  add_layer(ctx, a) {
    const g = graphOf(ctx, a);
    const geom = GEOMS[a.geom];
    if (!geom || geom.custom) throw new Skip(`Unknown layer type "${a.geom}".`);
    const fix = columnFixer(ctx, g.base.dataset);
    const aes = {};
    for (const [k, v] of Object.entries(a.aes || {})) {
      const m = aesValue(v);
      if (!m || !geom.aes.includes(k)) continue;
      if (m.mode === 'col') m.col = fix(m.col);
      aes[k] = m;
    }
    g.layers.push({ id: `l${Date.now().toString(36)}${g.layers.length}`, geom: a.geom, dataset: '', aes, params: { ...geomDefaults(a.geom), ...(a.params || {}) } });
    ctx.last.graph = g.id;
    ctx.show = g.id;
  },

  plot_aes(ctx, a) {
    const g = graphOf(ctx, a);
    if (a.dataset) g.base.dataset = target(ctx, a.dataset, ['data', 'transform'], 'dataset').id;
    const fix = columnFixer(ctx, g.base.dataset);
    for (const [k, v] of Object.entries(a.aes || {})) {
      if (!PLOT_AES.includes(k)) continue;
      if (v == null || v === '') delete g.base.aes[k];
      else g.base.aes[k] = { mode: 'col', col: fix(typeof v === 'object' ? v.col : v) };
    }
    ctx.last.graph = g.id;
    ctx.show = g.id;
  },

  compare_groups(ctx, a) {
    const g = graphOf(ctx, a);
    const main = effectiveLayers(g).find((l) => !GEOMS[l.geom].noData && l.aes?.x?.mode === 'col');
    if (!main) throw new Skip('The graph needs a layer with X and Y first.');
    const fix = columnFixer(ctx, main.dataset);
    const within = a.within != null ? !!a.within && !!sideBySide(main) : !!sideBySide(main) && g.layers.some((l) => l.params?.dodge);
    const ann = {
      id: `a${Date.now().toString(36)}`, kind: 'compare',
      method: ['t.test', 't.test.equal', 'wilcox.test'].includes(a.method) ? a.method : 't.test',
      comparisons: ['all', 'control', 'none'].includes(a.comparisons) ? a.comparisons : 'all',
      ref: a.ref ? String(a.ref) : '', p_adjust: ['holm', 'bonferroni', 'BH', 'none'].includes(a.p_adjust) ? a.p_adjust : 'holm',
      paired: !!a.paired, subject: a.paired ? fix(a.subject) : '', within,
      format: ['stars', 'p', 'number'].includes(a.format) ? a.format : 'stars', hide_ns: !!a.hide_ns,
      overall: a.overall !== undefined ? !!a.overall : !within, position: 'top-left',
    };
    if (ann.paired && !ann.subject) throw new Skip('Paired comparisons need the subject column.');
    g.annotations = g.annotations || [];
    g.annotations.push(ann);
    ctx.last.graph = g.id;
    ctx.show = g.id;
  },

  show_analysis(ctx, a) {
    const g = graphOf(ctx, a);
    const an = target(ctx, a.analysis, ['analysis'], 'analysis');
    const kinds = TESTS[an.test]?.annotations || [];
    if (!kinds.length) throw new Skip(`"${an.name}" has nothing to draw on a graph.`);
    const kind = kinds.includes(a.kind) ? a.kind : kinds[0];
    g.annotations = (g.annotations || []).filter((x) => !(x.analysis === an.id && x.kind === kind));
    g.annotations.push({ id: `a${Date.now().toString(36)}`, analysis: an.id, kind, format: a.format === 'p' ? 'p' : 'stars', position: 'top-left' });
    ctx.last.graph = g.id;
    ctx.show = g.id;
  },

  text_box(ctx, a) {
    const g = graphOf(ctx, a);
    if (!String(a.text ?? '').trim()) throw new Skip('The text box has no text.');
    const frac = (v, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(1, Math.max(0, n > 1 ? n / 100 : n)) : d; };
    g.notes = g.notes || [];
    g.notes.push({ ...NOTE_DEFAULTS, id: `n${Date.now().toString(36)}`, text: String(a.text), x: frac(a.x, 0.5), y: frac(a.y, 0.9), bold: !!a.bold, italic: !!a.italic, align: ['left', 'center', 'right'].includes(a.align) ? a.align : 'center' });
    ctx.last.graph = g.id;
    ctx.show = g.id;
  },

  labels(ctx, a) {
    const g = graphOf(ctx, a);
    g.labels = g.labels || {};
    for (const k of ['title', 'subtitle', 'x', 'y', 'legend']) {
      if (a[k] == null) continue;
      g.labels[k] = String(a[k]);
      if (k === 'x' || k === 'y') g.labels[`hide_${k}`] = false;
    }
    ctx.last.graph = g.id;
    ctx.show = g.id;
  },

  axis(ctx, a) {
    const g = graphOf(ctx, a);
    const which = a.axis === 'x' ? 'x' : 'y';
    const s = g[`${which}_scale`] = g[`${which}_scale`] || { trans: 'identity' };
    const trans = { linear: 'identity', identity: 'identity', log10: 'log10', log: 'log10', log2: 'log2', sqrt: 'sqrt' }[a.scale];
    if (trans) s.trans = trans;
    if (a.min !== undefined) s.min = a.min === null ? '' : Number(a.min);
    if (a.max !== undefined) s.max = a.max === null ? '' : Number(a.max);
    if (a.from_zero !== undefined) s.from_zero = !!a.from_zero;
    ctx.last.graph = g.id;
    ctx.show = g.id;
  },

  style(ctx, a) {
    const g = graphOf(ctx, a);
    const notes = [];
    if (a.palette) {
      if (PALETTES.some(([k]) => k === a.palette)) g.palette = { ...(g.palette || {}), name: a.palette };
      else notes.push(`no palette "${a.palette}"`);
    }
    g.theme = g.theme || { name: 'lab', base_size: 14 };
    if (a.theme) {
      if (THEMES.some(([k]) => k === a.theme)) g.theme.name = a.theme;
      else notes.push(`no theme "${a.theme}"`);
    }
    if (a.legend && ['right', 'top', 'bottom', 'left', 'none'].includes(a.legend)) g.theme.legend = a.legend;
    if (a.base_size) g.theme.base_size = Number(a.base_size) || g.theme.base_size;
    ctx.last.graph = g.id;
    ctx.show = g.id;
    return notes.length ? `Skipped: ${notes.join(', ')}.` : undefined;
  },
};
