// What the assistant can do: a small set of JSON actions, each mapped onto
// the same project changes the user makes by hand. Actions are checked before
// they run (items and columns must exist), and a whole batch is one undo step.
import { STEP_TYPES } from '../codegen/transform.js';
import { TESTS, testDefaults } from '../codegen/stats.js';
import { GEOMS, AES, PLOT_AES, NOTE_DEFAULTS, PALETTES, THEMES, geomDefaults, ensureBase, sideBySide, effectiveLayers } from '../codegen/graph.js';
import { GRAPH_TEMPLATES, graphFromTemplate } from '../ui/templates.js';
import { getItem, itemsOf, newTransform, newAnalysis, uniqueName, clone } from '../model.js';
import { openPipeline } from '../ui/pipePanel.js';

// The instructions the model gets (kept short: small models have small context windows).
export const ACTION_GUIDE = `Answer with ONE JSON object and nothing else:
{"reply": "<short message for the user>", "actions": [<actions>]}
Use "actions": [] when the user only asks a question. Use exact item and column names from the project.
Actions ("graph"/"table"/"dataset" may be left out to mean the item that is open or was just made):
{"do":"pipeline_step","table":T,"step":STEP} add a dplyr step to a data table's own pipeline (shown next to it), or to a transform's steps
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
Tests and graphs by group need a column of groups and a column of numbers (long data). For a table with one column per group, just name the table in new_analysis / new_graph (no x, y or group): the app treats each column as a group.`;

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
        const raw = Array.isArray(obj.actions) ? obj.actions : Array.isArray(obj.steps) ? obj.steps : obj.action ? [obj.action] : [];
        return { reply: String(obj.reply ?? obj.message ?? obj.answer ?? ''), actions: raw.filter((a) => a && typeof a === 'object').map(normalizeAction) };
      }
    } catch { /* not JSON: show it as text */ }
  }
  return { reply: clean, actions: [], unparsed: true };
}

// ---- understanding what the model meant ------------------------------------------------------
// Small models paraphrase: "action" for "do", "create_graph", "summarize",
// "color", "Mann-Whitney"… These are mapped onto what the app knows.

const key = (s) => String(s ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
const squash = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

const ACTION_ALIASES = {
  graph: 'new_graph', make_graph: 'new_graph', create_graph: 'new_graph', add_graph: 'new_graph', plot: 'new_graph', new_plot: 'new_graph', create_plot: 'new_graph', make_plot: 'new_graph', chart: 'new_graph',
  analysis: 'new_analysis', analyse: 'new_analysis', analyze: 'new_analysis', run_analysis: 'new_analysis', run_test: 'new_analysis', test: 'new_analysis', statistics: 'new_analysis', stats: 'new_analysis', add_analysis: 'new_analysis', create_analysis: 'new_analysis',
  step: 'pipeline_step', add_step: 'pipeline_step', pipeline: 'pipeline_step', add_pipeline_step: 'pipeline_step', dplyr: 'pipeline_step',
  transform: 'new_transform', create_transform: 'new_transform', add_transform: 'new_transform', new_dataset: 'new_transform',
  compare: 'compare_groups', add_compare: 'compare_groups', compare_means: 'compare_groups', stat_compare_means: 'compare_groups', p_values: 'compare_groups', add_p_values: 'compare_groups', brackets: 'compare_groups',
  layer: 'add_layer', new_layer: 'add_layer',
  title: 'labels', titles: 'labels', set_labels: 'labels', set_title: 'labels', label: 'labels', set_titles: 'labels',
  set_axis: 'axis', scale: 'axis', set_scale: 'axis',
  theme: 'style', palette: 'style', set_style: 'style', colours: 'style', colors: 'style', set_theme: 'style',
  aes: 'plot_aes', set_aes: 'plot_aes', mapping: 'plot_aes', map: 'plot_aes', aesthetics: 'plot_aes',
  text: 'text_box', annotate: 'text_box', annotation: 'text_box', note: 'text_box', add_text: 'text_box', add_text_box: 'text_box',
  show: 'open', select: 'open', open_item: 'open', go_to: 'open',
  show_stats: 'show_analysis', add_analysis_to_graph: 'show_analysis', analysis_to_graph: 'show_analysis',
};

const STEP_ALIASES = {
  summarize: 'summarise', summary: 'summarise', aggregate: 'summarise', groupby: 'group_by', group: 'group_by',
  melt: 'pivot_longer', gather: 'pivot_longer', longer: 'pivot_longer', wide_to_long: 'pivot_longer', to_long: 'pivot_longer',
  spread: 'pivot_wider', wider: 'pivot_wider', long_to_wide: 'pivot_wider', to_wide: 'pivot_wider',
  sort: 'arrange', order: 'arrange', order_by: 'arrange', head: 'slice', top: 'slice', top_n: 'slice', slice_head: 'slice', slice_max: 'slice', slice_min: 'slice',
  unique: 'distinct', dropna: 'drop_na', remove_na: 'drop_na', remove_missing: 'drop_na',
  calculate: 'mutate', compute: 'mutate', new_column: 'mutate', add_column: 'mutate', calculated_column: 'mutate',
  keep: 'select', drop: 'select', columns: 'select', tally: 'count', where: 'filter', subset: 'filter', relevel: 'reorder', factor: 'convert',
};

// Statistical tests by the names people (and models) use for them.
const TEST_ALIASES = [
  [/paired.*(t|ratio)|t.*paired/, 'ttest_paired'], [/ratio/, 'ttest_ratio'], [/one.?sample/, 'one_sample'],
  [/wilcoxon.*(paired|signed)|signed.?rank|paired.*wilcoxon/, 'wilcoxon_paired'], [/mann|whitney|wilcox|rank.?sum/, 'mann_whitney'],
  [/welch.*anova|anova.*welch|games/, 'welch_anova'], [/kruskal/, 'kruskal'], [/friedman/, 'friedman'],
  [/repeated|rm.?anova/, 'rm_anova'], [/two.?way|2.?way|anova2/, 'anova2'], [/mixed|lmer|lme/, 'mixed'],
  [/anova|one.?way/, 'anova1'], [/correl|pearson|spearman|kendall/, 'correlation'], [/regress|linear model|fit|dose/, 'regression'],
  [/normal|shapiro/, 'normality'], [/descri|summary|mean/, 'descriptive'], [/t.?test|student|welch|unpaired/, 'ttest_unpaired'],
];

export function resolveTest(name) {
  if (TESTS[name]) return name;
  const k = key(name);
  if (TESTS[k]) return k;
  const hit = TEST_ALIASES.find(([re]) => re.test(String(name).toLowerCase()));
  return hit ? hit[1] : name;
}

function resolveTemplate(name) {
  const k = key(name);
  if (GRAPH_TEMPLATES.some((t) => t.key === k)) return k;
  const s = String(name || '').toLowerCase();
  if (/group.*bar|bar.*group|dodge|side/.test(s)) return 'grouped_bars';
  if (/bar|column/.test(s)) return 'bar_points';
  if (/box/.test(s)) return 'box';
  if (/violin/.test(s)) return 'violin';
  if (/hist/.test(s)) return 'histogram';
  if (/time|line|course/.test(s)) return 'time_course';
  if (/xy|regress|correl|fit/.test(s)) return 'xy';
  if (/dot|scatter|strip|jitter|point/.test(s)) return 'scatter_dot';
  return k;
}

const COMPARE_METHODS = (m) => {
  const s = String(m || '').toLowerCase();
  if (!s) return undefined;
  if (/wilcox|mann|whitney|non.?param|rank/.test(s)) return 'wilcox.test';
  if (/student|equal|pooled|t\.test\.equal/.test(s)) return 't.test.equal';
  return 't.test';
};

const STAT_ALIASES = { average: 'mean', avg: 'mean', std: 'sd', stdev: 'sd', standard_deviation: 'sd', se: 'sem', sterr: 'sem', standard_error: 'sem', count: 'n', number: 'n', minimum: 'min', maximum: 'max' };
const OP_ALIASES = { '=': '==', eq: '==', equals: '==', is: '==', equal: '==', ne: '!=', not: '!=', not_equal: '!=', '<>': '!=', gt: '>', greater: '>', greater_than: '>', above: '>', ge: '>=', gte: '>=', lt: '<', less: '<', less_than: '<', below: '<', le: '<=', lte: '<=', is_in: 'in', one_of: 'in', not_in: 'not in', condition: 'expr', expression: 'expr' };

const asList = (v) => (v == null || v === '' ? undefined : Array.isArray(v) ? v : [v]);

export function normalizeStep(step) {
  if (!step || typeof step !== 'object') return step;
  const s = { ...step };
  let t = key(s.type ?? s.do ?? s.verb ?? s.step ?? s.action);
  if (t === 'drop' && s.drop === undefined) s.drop = true;
  if (/^slice_(max|min|head|tail)$/.test(t) && !s.mode) s.mode = t.slice(6);
  t = STEP_ALIASES[t] || t;
  s.type = t;
  delete s.do; delete s.verb; delete s.step; delete s.action;
  if (s.col && !s.column) s.column = s.col;
  if (s.variable && !s.column) s.column = s.variable;
  if (t === 'pivot_longer' && !s.cols) s.cols = asList(s.columns);
  if (['group_by', 'select', 'count', 'distinct', 'drop_na'].includes(t)) s.columns = asList(s.columns ?? s.by ?? s.group_by ?? s.cols ?? s.column);
  if (t === 'summarise') {
    s.group_by = asList(s.group_by ?? s.by ?? s.groups);
    s.stats = asList(s.stats ?? s.functions ?? s.statistics ?? s.fun)?.map((x) => STAT_ALIASES[key(x)] || key(x));
    if (!s.column && s.value) s.column = s.value;
  }
  if (t === 'filter') {
    if (s.condition || s.expression || s.expr) { s.expr = s.expr ?? s.condition ?? s.expression; if (!s.column || s.op === 'expr') s.op = 'expr'; }
    if (s.op != null) s.op = OP_ALIASES[key(s.op)] || s.op;
    if (s.operator && !s.op) s.op = OP_ALIASES[key(s.operator)] || s.operator;
    if (Array.isArray(s.value)) { s.values = s.value; s.op = s.op === '!=' ? 'not in' : 'in'; }
  }
  if (t === 'mutate') { s.name = s.name ?? s.new_column ?? s.column; s.expr = s.expr ?? s.expression ?? s.formula; }
  if (t === 'arrange') s.desc = s.desc ?? (/desc/i.test(String(s.order ?? s.direction ?? '')) || undefined);
  if (t === 'slice') { s.n = s.n ?? s.count ?? s.number; if (s.by && !Array.isArray(s.by)) s.by = [s.by]; }
  if (t === 'rename') { s.from = s.from ?? s.old ?? s.column; s.to = s.to ?? s.new ?? s.new_name; }
  return s;
}

export function normalizeAction(raw) {
  let a = { ...raw };
  // {"new_graph": {...}} → {"do": "new_graph", ...}
  const keys = Object.keys(a);
  if (keys.length === 1 && a[keys[0]] && typeof a[keys[0]] === 'object' && !Array.isArray(a[keys[0]])) a = { do: keys[0], ...a[keys[0]] };
  let d = key(a.do ?? a.action ?? a.type ?? a.command ?? a.tool);
  delete a.action; delete a.command; delete a.tool;
  if (!HANDLERS[d] && ACTION_ALIASES[d]) d = ACTION_ALIASES[d];
  // A bare dplyr step ({"do": "filter", …}) goes into the pipeline.
  if (!HANDLERS[d] && (STEP_TYPES[d] || STEP_TYPES[STEP_ALIASES[d]])) {
    const { do: _, type: __, table, dataset, data, ...rest } = a;
    a = { do: 'pipeline_step', table: table ?? dataset ?? data, step: { type: d, ...rest } };
    d = 'pipeline_step';
  }
  if (a.type && d !== 'pipeline_step' && a.type !== d && !a.test && !a.template && !a.geom) {
    if (d === 'new_analysis') a.test = a.type;
    else if (d === 'new_graph') a.template = a.type;
  }
  a.do = d;
  delete a.type;
  const pick = (...names) => names.map((n) => a[n]).find((v) => v != null && v !== '');
  switch (d) {
    case 'pipeline_step':
      a.table = pick('table', 'dataset', 'data', 'source');
      a.step = normalizeStep(a.step ?? a.steps?.[0] ?? null);
      break;
    case 'new_transform':
      a.from = pick('from', 'dataset', 'data', 'source', 'table');
      a.steps = (asList(a.steps) || []).map(normalizeStep);
      break;
    case 'new_analysis':
      a.test = resolveTest(pick('test', 'method', 'analysis', 'name') || '');
      a.dataset = pick('dataset', 'data', 'table', 'source', 'from');
      a.y = pick('y', 'value', 'values', 'response', 'outcome', 'measure', 'dependent', 'variable');
      a.group = pick('group', 'groups_column', 'factor', 'by', 'group_by', 'grouping', 'independent', 'factorA', 'treatment');
      if (Array.isArray(a.group)) a.group = a.group[0];
      a.subject = pick('subject', 'id', 'subject_id', 'block', 'pairing', 'paired_by');
      a.factorB = pick('factorB', 'factor_b', 'factor2', 'second_factor');
      if (d === 'new_analysis' && a.name && TESTS[resolveTest(a.name)] === TESTS[a.test]) delete a.name;
      break;
    case 'new_graph':
      a.template = resolveTemplate(pick('template', 'kind', 'graph_type', 'style', 'chart') || 'scatter_dot');
      a.dataset = pick('dataset', 'data', 'table', 'source', 'from');
      a.x = pick('x', 'x_column', 'xvar', 'group_column');
      a.y = pick('y', 'y_column', 'yvar', 'value', 'values');
      a.group = pick('group', 'colour', 'color', 'fill', 'by');
      break;
    case 'compare_groups':
      a.graph = pick('graph', 'plot', 'target');
      a.method = COMPARE_METHODS(pick('method', 'test'));
      if (a.comparisons && !['all', 'control', 'none'].includes(a.comparisons)) a.comparisons = /control|ref|vs/.test(String(a.comparisons)) ? 'control' : 'all';
      a.ref = pick('ref', 'control', 'reference');
      break;
    case 'plot_aes': case 'add_layer':
      a.graph = pick('graph', 'plot', 'target');
      if (a.aes || a.mapping || a.aesthetics) {
        const src = a.aes || a.mapping || a.aesthetics;
        a.aes = Object.fromEntries(Object.entries(src).map(([k, v]) => [{ color: 'colour', col: 'colour' }[key(k)] || key(k), v]));
      } else if (d === 'plot_aes') {
        a.aes = Object.fromEntries(PLOT_AES.filter((k) => a[k] !== undefined || (k === 'colour' && a.color !== undefined)).map((k) => [k, a[k] ?? a.color]));
      }
      if (d === 'add_layer') a.geom = key(pick('geom', 'layer', 'kind') || '');
      break;
    case 'labels':
      a.graph = pick('graph', 'plot', 'target');
      a.x = a.x ?? a.xlab ?? a.x_title ?? a.x_label;
      a.y = a.y ?? a.ylab ?? a.y_title ?? a.y_label;
      a.title = a.title ?? a.main;
      break;
    case 'text_box': case 'axis': case 'style': case 'show_analysis':
      a.graph = pick('graph', 'plot', 'target');
      if (d === 'text_box') a.text = a.text ?? a.label ?? a.content;
      if (d === 'style' && a.colours) a.palette = a.palette ?? a.colours;
      break;
    default:
  }
  for (const k of Object.keys(a)) if (a[k] === undefined) delete a[k];
  return a;
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

// Tries the actions on a copy of the project: which would work, and why not.
export function checkActions(app, actions) {
  const ctx = { app, p: clone(app.store.project), made: {}, last: {}, show: null, dry: true };
  return actions.map((a) => {
    try {
      const note = run(ctx, a);
      return { ok: true, note };
    } catch (e) {
      return { ok: false, note: e instanceof Skip ? e.message : `Error: ${e.message}` };
    }
  });
}

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
  const id = closest(key, pool.flatMap((it) => [it.name, it.rname]));
  return id ? pool.find((it) => it.name === id || it.rname === id) : null;
}

// The option a name most likely means: exact, then ignoring case, spaces and
// punctuation, then a unique option that starts with or contains it, then a
// near miss (a typo or two). Null when nothing is close.
export function closest(name, options) {
  const s = String(name ?? '');
  if (!s || !options.length) return null;
  const hit = options.find((o) => o === s) || options.find((o) => o.toLowerCase() === s.toLowerCase());
  if (hit) return hit;
  const k = squash(s);
  if (!k) return null;
  const same = options.filter((o) => squash(o) === k);
  if (same.length) return same[0];
  const starts = options.filter((o) => squash(o).startsWith(k) || k.startsWith(squash(o)) && squash(o).length >= 3);
  if (starts.length === 1) return starts[0];
  const contains = options.filter((o) => squash(o).includes(k) || (squash(o).length >= 4 && k.includes(squash(o))));
  if (contains.length === 1) return contains[0];
  let best = null;
  let bestD = Infinity;
  let tie = false;
  for (const o of options) {
    const d = editDistance(k, squash(o));
    if (d < bestD) { bestD = d; best = o; tie = false; } else if (d === bestD) tie = true;
  }
  // Two options equally close (e.g. "Treatment" for "Treatment 1" and "Treatment 2"): don't guess.
  return bestD <= Math.max(1, Math.floor(k.length / 5)) && !tie ? best : null;
}

function editDistance(a, b) {
  const m = a.length;
  const n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}

// The item an action is about: named, else the one just made, else the open one.
function target(ctx, name, kinds, what) {
  if (name) {
    const it = findItem(ctx, name, kinds);
    if (!it) throw new Skip(`There is no ${what} called "${name}".`);
    return it;
  }
  for (const k of kinds) if (ctx.last[k]) return getItem(ctx.p, ctx.last[k]);
  const open = getItem(ctx.p, ctx.app.store.selected);
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
    const hit = closest(s, cols);
    if (!hit) throw new Skip(`"${s}" is not a ${label} of this data (it has ${cols.join(', ')}).`);
    return hit;
  };
}

// A table with one column of numbers per group ("wide"): its number columns, else null.
function wideColumns(ctx, ds) {
  const cols = ctx.app.engine.schemaOf(ds.id)?.columns;
  if (!cols) return null;
  const nums = cols.filter((c) => c.type === 'numeric').map((c) => c.name);
  const others = cols.filter((c) => c.type !== 'numeric' && !/^row_name(_\d+)?$/.test(c.name));
  return nums.length >= 2 && !others.length ? nums : null;
}

// The long version of a wide table (columns "group" and "value"), made if needed:
// the same one the app's own "Graph it" makes.
function longVersion(ctx, ds, cols) {
  const found = itemsOf(ctx.p, 'transform').find((t) => t.input === ds.id && t.steps.length === 1 && t.steps[0].type === 'pivot_longer'
    && t.steps[0].names_to === 'group' && t.steps[0].values_to === 'value' && JSON.stringify(t.steps[0].cols) === JSON.stringify(cols));
  if (found) return found;
  const t = newTransform(ctx.p, ds.id, [{ type: 'pivot_longer', cols, names_to: 'group', values_to: 'value', drop_na: true }], uniqueName(ctx.p, `${ds.name} (long)`));
  made(ctx, t);
  return t;
}

function levelsOf(ctx, datasetId, col) {
  return ctx.app.engine.schemaOf(datasetId)?.columns?.find((c) => c.name === col)?.levels || [];
}

// A step as the pipeline and transforms store it: defaults, then what the model said,
// with column names checked where the columns are known. `fixCol` checks against the input.
function makeStep(step, fixCol, schema) {
  step = normalizeStep(step);
  if (!step || !STEP_TYPES[step.type]) throw new Skip(`Unknown step "${step?.type}". Steps are: ${Object.keys(STEP_TYPES).join(', ')}.`);
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

// Only options the test has.
function pickOptions(test, given) {
  const out = {};
  for (const [k, v] of Object.entries(given || {})) if (test.options.some((o) => o.key === k)) out[k] = v;
  return out;
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
    const t = target(ctx, a.table || a.dataset, ['data', 'transform'], 'data table');
    if (t.kind === 'transform') {
      // A transform is a pipeline already: the step goes at its end.
      const first = !t.steps.some((x) => !x.disabled);
      t.steps.push(makeStep(a.step, first ? columnFixer(ctx, t.input) : null, ctx.app.engine.schemaOf(t.input)));
      ctx.show = t.id;
      ctx.last.transform = t.id;
      return `(added to the steps of the transform "${t.name}")`;
    }
    t.pipe = t.pipe || { steps: [] };
    const first = !t.pipe.steps.some((s) => !s.disabled);
    const schema = ctx.app.engine.schemaOf(t.id);
    t.pipe.steps.push(makeStep(a.step, first ? columnFixer(ctx, t.id) : null, schema));
    if (!ctx.dry) openPipeline(t.id);
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
    const wide = wideColumns(ctx, ds);
    if (wide && inputs.layout && inputs.group) {
      // One column per group: compare the columns themselves.
      const named = [a.y, a.group, ...(asList(a.groups) || []), ...(asList(a.columns) || [])].map((c) => closest(c, wide)).filter(Boolean);
      const chosen = [...new Set(named)].length >= 2 ? [...new Set(named)] : wide;
      const extra = { layout: 'columns', columns: chosen, groups: chosen.slice(0, 2) };
      if (a.name) extra.name = uniqueName(ctx.p, a.name);
      const an = newAnalysis(ctx.p, a.test, ds.id, { ...extra, options: { ...testDefaults(a.test), ...pickOptions(test, a.options) } });
      made(ctx, an, a.name);
      ctx.show = an.id;
      return `(each column of "${ds.name}" is a group: ${inputs.two ? chosen.slice(0, 2).join(' vs ') : chosen.join(', ')})`;
    }
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
      const named = (asList(a.groups) || []).map((g) => closest(g, lv.map(String)) || String(g));
      extra.groups = named.length >= 2 ? named.slice(0, 2) : lv.slice(0, 2);
    }
    const opts = { ...testDefaults(a.test), ...pickOptions(test, a.options) };
    if (a.name) extra.name = uniqueName(ctx.p, a.name);
    const an = newAnalysis(ctx.p, a.test, ds.id, { ...extra, options: opts });
    made(ctx, an, a.name);
    ctx.show = an.id;
  },

  new_graph(ctx, a) {
    const tpl = GRAPH_TEMPLATES.find((t) => t.key === a.template) || GRAPH_TEMPLATES[0];
    let ds = target(ctx, a.dataset, ['data', 'transform'], 'dataset');
    const wide = wideColumns(ctx, ds);
    let note;
    if (wide && tpl.needs.includes('x') && !tpl.numericX) {
      // One column per group: graph its long version (group on X, values on Y).
      const long = longVersion(ctx, ds, wide);
      note = `(using "${long.name}", the long version of "${ds.name}")`;
      ds = long;
      a = { ...a, x: 'group', y: 'value', group: undefined };
    }
    const fix = columnFixer(ctx, ds.id);
    const x = fix(a.x), y = fix(a.y), group = fix(a.group);
    for (const k of tpl.needs) if (!{ x, y, group }[k]) throw new Skip(`A ${tpl.label.toLowerCase()} needs ${k === 'group' ? 'a group column' : `an ${k.toUpperCase()} column`}.`);
    const g = graphFromTemplate(ctx.p, tpl.key, { dataset: ds.id, x, y, group, name: uniqueName(ctx.p, a.name || `${ds.name} graph`) });
    made(ctx, g, a.name);
    ctx.show = g.id;
    return note;
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
