// Graphs: layers (geoms + aesthetic mappings) and plot settings → ggplot2 code.
import { rsym, rstr, rnum, rvec, rbool } from '../rcode.js';

// Aesthetics. kind decides the "fixed value" editor; mapOnly ones can only be columns.
// A graph can map some of them plot-wide (g.base.aes), for every layer to inherit.
export const AES = {
  x: { label: 'X', mapOnly: true },
  y: { label: 'Y', mapOnly: true },
  colour: { label: 'Colour', kind: 'colour' },
  fill: { label: 'Fill', kind: 'colour' },
  shape: { label: 'Symbol', kind: 'shape', discrete: true },
  size: { label: 'Size', kind: 'number', min: 0, max: 20, step: 0.5, def: 2 },
  alpha: { label: 'Opacity', kind: 'number', min: 0, max: 1, step: 0.05, def: 0.7 },
  linetype: { label: 'Line type', kind: 'linetype', discrete: true },
  linewidth: { label: 'Line width', kind: 'number', min: 0, max: 10, step: 0.1, def: 0.8 },
  group: { label: 'Group', mapOnly: true, title: 'Separate lines, fits, boxes and side-by-side positions by a column, without colouring them' },
  label: { label: 'Label text', mapOnly: true },
  ymin: { label: 'Y min', mapOnly: true },
  ymax: { label: 'Y max', mapOnly: true },
};

export const SHAPES = [
  [16, 'Filled circle'], [1, 'Open circle'], [21, 'Circle (fill + outline)'],
  [15, 'Filled square'], [0, 'Open square'], [22, 'Square (fill + outline)'],
  [17, 'Filled triangle'], [2, 'Open triangle'], [24, 'Triangle (fill + outline)'],
  [18, 'Filled diamond'], [5, 'Open diamond'], [23, 'Diamond (fill + outline)'],
  [3, 'Plus'], [4, 'Cross'], [8, 'Star'],
];

export const LINETYPES = ['solid', 'dashed', 'dotted', 'dotdash', 'longdash', 'twodash'];

export const ERROR_TYPES = [
  ['sem', 'Mean ± SEM', 'ag_mean_sem'],
  ['sd', 'Mean ± SD', 'ag_mean_sd'],
  ['ci', 'Mean with 95% CI', 'ag_mean_ci'],
  ['iqr', 'Median with interquartile range', 'ag_median_iqr'],
  ['range', 'Median with range', 'ag_median_range'],
];
const errorFun = (k) => (ERROR_TYPES.find((e) => e[0] === k) || ERROR_TYPES[0])[2];

const DODGE = 'position_dodge(width = 0.8)';
const dodgeParam = { key: 'dodge', label: 'Place groups side by side (dodge)', type: 'bool', def: false };
const errorArgs = (p) => {
  const a = [`fun.data = ${errorFun(p.error)}`];
  if (p.direction && p.direction !== 'both') a.push(`fun.args = list(direction = ${rstr(p.direction)})`);
  return a;
};
const errorParams = [
  { key: 'error', label: 'Show', type: 'select', options: ERROR_TYPES.map((e) => [e[0], e[1]]), def: 'sem' },
  { key: 'direction', label: 'Direction', type: 'select', options: [['both', 'Both'], ['up', 'Up only'], ['down', 'Down only']], def: 'both' },
];

// Every geom the builder offers. build() returns the function and its extra arguments.
export const GEOMS = {
  point: {
    label: 'Points', category: 'Points',
    aes: ['x', 'y', 'colour', 'fill', 'shape', 'size', 'alpha', 'group'], required: ['x', 'y'],
    params: [dodgeParam],
    build: (p) => ({ fn: 'geom_point', args: p.dodge ? [`position = ${DODGE}`] : [] }),
  },
  jitter: {
    label: 'Points, jittered (scatter dot plot)', category: 'Points',
    aes: ['x', 'y', 'colour', 'fill', 'shape', 'size', 'alpha', 'group'], required: ['x', 'y'],
    params: [{ key: 'width', label: 'Jitter width', type: 'number', def: 0.15, min: 0, max: 1, step: 0.05 }, dodgeParam],
    build: (p) => ({
      fn: 'geom_point',
      args: [p.dodge
        ? `position = position_jitterdodge(jitter.width = ${rnum(p.width)}, jitter.height = 0, dodge.width = 0.8, seed = 1)`
        : `position = position_jitter(width = ${rnum(p.width)}, height = 0, seed = 1)`],
    }),
  },
  dotplot: {
    label: 'Dot plot (stacked dots)', category: 'Points',
    aes: ['x', 'y', 'colour', 'fill', 'alpha', 'group'], required: ['x', 'y'],
    params: [{ key: 'dotsize', label: 'Dot size', type: 'number', def: 1, min: 0.1, max: 5, step: 0.1 },
      { key: 'binwidth', label: 'Bin width (blank = automatic)', type: 'text', def: '' }, dodgeParam],
    build: (p) => ({
      fn: 'geom_dotplot',
      args: ['binaxis = "y"', 'stackdir = "center"', `dotsize = ${rnum(p.dotsize)}`,
        ...(p.binwidth !== '' && p.binwidth != null ? [`binwidth = ${rnum(p.binwidth)}`] : []),
        ...(p.dodge ? [`position = ${DODGE}`] : [])],
    }),
  },
  mean_bar: {
    label: 'Bar at the mean (or median)', category: 'Summaries',
    aes: ['x', 'y', 'colour', 'fill', 'alpha', 'linewidth', 'group'], required: ['x', 'y'],
    params: [{ key: 'fun', label: 'Bar height', type: 'select', options: [['mean', 'Mean'], ['median', 'Median']], def: 'mean' },
      { key: 'width', label: 'Bar width', type: 'number', def: 0.6, min: 0.05, max: 1, step: 0.05 }, dodgeParam],
    build: (p) => ({
      fn: 'stat_summary',
      args: [`fun = ${p.fun || 'mean'}`, 'geom = "col"', `width = ${rnum(p.width)}`, ...(p.dodge ? [`position = ${DODGE}`] : [])],
    }),
  },
  mean_line: {
    label: 'Line at the mean (or median)', category: 'Summaries',
    aes: ['x', 'y', 'colour', 'linewidth', 'alpha', 'group'], required: ['x', 'y'],
    params: [{ key: 'fun', label: 'Line at', type: 'select', options: [['mean', 'Mean'], ['median', 'Median']], def: 'mean' },
      { key: 'width', label: 'Line length', type: 'number', def: 0.5, min: 0.05, max: 1, step: 0.05 }, dodgeParam],
    build: (p) => {
      const f = p.fun || 'mean';
      return { fn: 'stat_summary', args: [`fun = ${f}`, `fun.min = ${f}`, `fun.max = ${f}`, 'geom = "errorbar"', `width = ${rnum(p.width)}`, ...(p.dodge ? [`position = ${DODGE}`] : [])] };
    },
  },
  errorbar: {
    label: 'Error bars (SEM, SD, 95% CI…)', category: 'Summaries',
    aes: ['x', 'y', 'colour', 'linewidth', 'alpha', 'group'], required: ['x', 'y'],
    params: [...errorParams, { key: 'width', label: 'Cap width', type: 'number', def: 0.3, min: 0, max: 1, step: 0.05 }, dodgeParam],
    build: (p) => ({ fn: 'stat_summary', args: [...errorArgs(p), 'geom = "errorbar"', `width = ${rnum(p.width)}`, ...(p.dodge ? [`position = ${DODGE}`] : [])] }),
  },
  pointrange: {
    label: 'Mean point with error line', category: 'Summaries',
    aes: ['x', 'y', 'colour', 'shape', 'size', 'linewidth', 'alpha', 'group'], required: ['x', 'y'],
    params: [...errorParams, dodgeParam],
    build: (p) => ({ fn: 'stat_summary', args: [...errorArgs(p), 'geom = "pointrange"', ...(p.dodge ? [`position = ${DODGE}`] : [])] }),
  },
  mean_point: {
    label: 'Point at the mean', category: 'Summaries',
    aes: ['x', 'y', 'colour', 'fill', 'shape', 'size', 'alpha', 'group'], required: ['x', 'y'],
    params: [{ key: 'fun', label: 'Point at', type: 'select', options: [['mean', 'Mean'], ['median', 'Median']], def: 'mean' }, dodgeParam],
    build: (p) => ({ fn: 'stat_summary', args: [`fun = ${p.fun || 'mean'}`, 'geom = "point"', ...(p.dodge ? [`position = ${DODGE}`] : [])] }),
  },
  mean_connect: {
    label: 'Line connecting the means', category: 'Summaries',
    aes: ['x', 'y', 'colour', 'linetype', 'linewidth', 'group', 'alpha'], required: ['x', 'y'],
    params: [{ key: 'fun', label: 'Connect', type: 'select', options: [['mean', 'Means'], ['median', 'Medians']], def: 'mean' }],
    build: (p, layer) => {
      // Lines need a group; default to the colour column, or one line for everything.
      const extraAes = {};
      if (layer.aes?.group?.mode !== 'col') extraAes.group = layer.aes?.colour?.mode === 'col' ? rsym(layer.aes.colour.col) : '1';
      return { fn: 'stat_summary', args: [`fun = ${p.fun || 'mean'}`, 'geom = "line"'], extraAes };
    },
  },
  boxplot: {
    label: 'Box and whiskers', category: 'Distributions',
    aes: ['x', 'y', 'colour', 'fill', 'alpha', 'linewidth', 'group'], required: ['x', 'y'],
    params: [{ key: 'width', label: 'Box width', type: 'number', def: 0.6, min: 0.05, max: 1, step: 0.05 },
      { key: 'outliers', label: 'Show outlier points', type: 'bool', def: true },
      { key: 'staplewidth', label: 'Whisker cap width', type: 'number', def: 0, min: 0, max: 1, step: 0.1 }, dodgeParam],
    build: (p) => ({
      fn: 'geom_boxplot',
      args: [`width = ${rnum(p.width)}`, ...(p.outliers === false ? ['outliers = FALSE'] : []),
        ...(Number(p.staplewidth) > 0 ? [`staplewidth = ${rnum(p.staplewidth)}`] : []),
        ...(p.dodge ? [`position = ${DODGE}`] : [])],
    }),
  },
  violin: {
    label: 'Violin', category: 'Distributions',
    aes: ['x', 'y', 'colour', 'fill', 'alpha', 'linewidth', 'group'], required: ['x', 'y'],
    params: [{ key: 'width', label: 'Width', type: 'number', def: 0.8, min: 0.05, max: 1.5, step: 0.05 },
      { key: 'trim', label: 'Trim tails at the data range', type: 'bool', def: true },
      { key: 'scale', label: 'Scale', type: 'select', options: [['area', 'Same area'], ['width', 'Same width'], ['count', 'Area ∝ n']], def: 'area' }, dodgeParam],
    build: (p) => ({
      fn: 'geom_violin',
      args: [`width = ${rnum(p.width)}`, `trim = ${rbool(p.trim !== false)}`, `scale = ${rstr(p.scale || 'area')}`, ...(p.dodge ? [`position = ${DODGE}`] : [])],
    }),
  },
  histogram: {
    label: 'Histogram', category: 'Distributions',
    aes: ['x', 'colour', 'fill', 'alpha', 'group'], required: ['x'],
    params: [{ key: 'bins', label: 'Number of bins', type: 'number', def: 20, min: 2, max: 200, step: 1 },
      { key: 'position', label: 'Groups', type: 'select', options: [['stack', 'Stacked'], ['identity', 'Overlapping'], ['dodge', 'Side by side']], def: 'stack' }],
    build: (p) => ({ fn: 'geom_histogram', args: [`bins = ${rnum(p.bins)}`, ...(p.position && p.position !== 'stack' ? [`position = ${rstr(p.position)}`] : [])] }),
  },
  density: {
    label: 'Density curve', category: 'Distributions',
    aes: ['x', 'colour', 'fill', 'alpha', 'linewidth', 'linetype', 'group'], required: ['x'],
    params: [{ key: 'adjust', label: 'Smoothness (bandwidth ×)', type: 'number', def: 1, min: 0.1, max: 5, step: 0.1 }],
    build: (p) => ({ fn: 'geom_density', args: Number(p.adjust) !== 1 ? [`adjust = ${rnum(p.adjust)}`] : [] }),
  },
  col: {
    label: 'Bars (heights from a column)', category: 'Bars',
    aes: ['x', 'y', 'colour', 'fill', 'alpha', 'linewidth', 'group'], required: ['x', 'y'],
    params: [{ key: 'width', label: 'Bar width', type: 'number', def: 0.7, min: 0.05, max: 1, step: 0.05 }, dodgeParam],
    build: (p) => ({ fn: 'geom_col', args: [`width = ${rnum(p.width)}`, ...(p.dodge ? [`position = ${DODGE}`] : [])] }),
  },
  bar_count: {
    label: 'Bars (count rows)', category: 'Bars',
    aes: ['x', 'colour', 'fill', 'alpha', 'group'], required: ['x'],
    params: [{ key: 'width', label: 'Bar width', type: 'number', def: 0.7, min: 0.05, max: 1, step: 0.05 }, dodgeParam],
    build: (p) => ({ fn: 'geom_bar', args: [`width = ${rnum(p.width)}`, ...(p.dodge ? [`position = ${DODGE}`] : [])] }),
  },
  errorbar_cols: {
    label: 'Error bars (from min / max columns)', category: 'Bars',
    aes: ['x', 'ymin', 'ymax', 'colour', 'linewidth', 'group'], required: ['x', 'ymin', 'ymax'],
    params: [{ key: 'width', label: 'Cap width', type: 'number', def: 0.3, min: 0, max: 1, step: 0.05 }, dodgeParam],
    build: (p) => ({ fn: 'geom_errorbar', args: [`width = ${rnum(p.width)}`, ...(p.dodge ? [`position = ${DODGE}`] : [])] }),
  },
  line: {
    label: 'Line (connect points)', category: 'Lines',
    aes: ['x', 'y', 'colour', 'linetype', 'linewidth', 'group', 'alpha'], required: ['x', 'y'],
    params: [],
    build: (p, layer) => {
      const extraAes = {};
      if (layer.aes?.group?.mode !== 'col' && layer.xDiscrete) extraAes.group = layer.aes?.colour?.mode === 'col' ? rsym(layer.aes.colour.col) : '1';
      return { fn: 'geom_line', args: [], extraAes };
    },
  },
  area: {
    label: 'Area under a line', category: 'Lines',
    aes: ['x', 'y', 'colour', 'fill', 'alpha', 'group'], required: ['x', 'y'],
    params: [],
    build: () => ({ fn: 'geom_area', args: [] }),
  },
  smooth: {
    label: 'Fitted line / smoother', category: 'Lines',
    aes: ['x', 'y', 'colour', 'fill', 'linetype', 'linewidth', 'group'], required: ['x', 'y'],
    params: [{ key: 'method', label: 'Fit', type: 'select', options: [['lm', 'Straight line'], ['poly2', 'Quadratic'], ['poly3', 'Cubic'], ['loess', 'LOESS smoother']], def: 'lm' },
      { key: 'se', label: 'Show 95% confidence band', type: 'bool', def: true }],
    build: (p) => {
      const m = p.method || 'lm';
      const formula = m === 'poly2' ? 'y ~ poly(x, 2)' : m === 'poly3' ? 'y ~ poly(x, 3)' : 'y ~ x';
      return { fn: 'geom_smooth', args: [`method = ${rstr(m === 'loess' ? 'loess' : 'lm')}`, `formula = ${formula}`, `se = ${rbool(p.se !== false)}`] };
    },
  },
  text: {
    label: 'Text labels', category: 'Other',
    aes: ['x', 'y', 'label', 'colour', 'size', 'group'], required: ['x', 'y', 'label'],
    params: [{ key: 'nudge_y', label: 'Move up by', type: 'number', def: 0, step: 0.1 }],
    build: (p) => ({ fn: 'geom_text', args: Number(p.nudge_y) ? [`nudge_y = ${rnum(p.nudge_y)}`] : [] }),
  },
  tile: {
    label: 'Heatmap tiles', category: 'Other',
    aes: ['x', 'y', 'fill', 'colour', 'alpha', 'group'], required: ['x', 'y', 'fill'],
    params: [],
    build: () => ({ fn: 'geom_tile', args: [] }),
  },
  hline: {
    label: 'Horizontal reference line', category: 'Other', noData: true,
    aes: ['colour', 'linetype', 'linewidth'], required: [],
    params: [{ key: 'intercept', label: 'At Y =', type: 'number', def: 0, step: 0.1 }],
    build: (p) => ({ fn: 'geom_hline', args: [`yintercept = ${rnum(p.intercept)}`] }),
  },
  vline: {
    label: 'Vertical reference line', category: 'Other', noData: true,
    aes: ['colour', 'linetype', 'linewidth'], required: [],
    params: [{ key: 'intercept', label: 'At X =', type: 'number', def: 0, step: 0.1 }],
    build: (p) => ({ fn: 'geom_vline', args: [`xintercept = ${rnum(p.intercept)}`] }),
  },
  custom: {
    label: 'Custom R code (+ anything ggplot2)', category: 'Other', noData: true, custom: true,
    aes: [], required: [], params: [],
    build: () => ({ fn: null, args: [] }),
  },
};

export const GEOM_CATEGORIES = ['Points', 'Summaries', 'Distributions', 'Bars', 'Lines', 'Other'];

export function geomDefaults(key) {
  const out = {};
  for (const p of GEOMS[key].params) out[p.key] = p.def;
  return out;
}

// Tick label formats for continuous axes: [label, R code].
export const NUMBER_FORMATS = {
  n0: ['1', 'scales::label_number(accuracy = 1)'],
  n1: ['0.1', 'scales::label_number(accuracy = 0.1)'],
  n2: ['0.01', 'scales::label_number(accuracy = 0.01)'],
  n3: ['0.001', 'scales::label_number(accuracy = 0.001)'],
  comma: ['1,000', 'scales::label_comma()'],
  pct: ['Add a % sign (50 → 50%)', 'scales::label_percent(scale = 1)'],
  pct100: ['As percent (0.5 → 50%)', 'scales::label_percent()'],
  sci: ['Scientific (1e+03)', 'scales::label_scientific()'],
  pow10: ['Powers of ten (10³)', 'scales::label_log()'],
};

export const FONTS = [['', 'Sans serif'], ['serif', 'Serif'], ['mono', 'Monospace']];

// The lab-figure theme (also used for any unknown theme name) has bold titles.
export function boldTitles(name) {
  return !name || name === 'lab' || !THEMES.some((t) => t[0] === name);
}

export const THEMES = [
  ['lab', 'Lab figure (bold, no grid)', 'ag_theme_lab'],
  ['classic', 'Classic', 'theme_classic'],
  ['bw', 'Black & white grid', 'theme_bw'],
  ['minimal', 'Minimal', 'theme_minimal'],
  ['light', 'Light', 'theme_light'],
  ['gray', 'ggplot2 default (grey)', 'theme_gray'],
  ['linedraw', 'Line drawing', 'theme_linedraw'],
];

export const PALETTES = [
  ['default', 'ggplot2 default'],
  ['okabe', 'Okabe-Ito (colour-blind safe)'],
  ['viridis', 'Viridis'],
  ['grey', 'Greys'],
  ['Set1', 'Brewer: Set1'],
  ['Set2', 'Brewer: Set2'],
  ['Dark2', 'Brewer: Dark2'],
  ['Paired', 'Brewer: Paired'],
  ['Pastel1', 'Brewer: Pastel1'],
  ['manual', 'Pick colours per group'],
];

// Aesthetics that can be mapped for the whole plot.
export const PLOT_AES = ['x', 'y', 'colour', 'fill', 'shape', 'linetype', 'size', 'alpha', 'group'];

const isMapped = (m) => m?.mode === 'col' && !!m.col;

// The plot-wide data and mappings, which layers inherit. Graphs made before
// these existed share whatever all their visible layers have in common.
export function plotBase(g) {
  if (g.base) return { dataset: g.base.dataset || '', aes: g.base.aes || {} };
  const dataLayers = (g.layers || []).filter((l) => !l.hidden && GEOMS[l.geom] && !GEOMS[l.geom].noData);
  const ds = [...new Set(dataLayers.map((l) => l.dataset))];
  const aes = {};
  if (ds.length === 1 && dataLayers.length) {
    for (const [k, m] of Object.entries(dataLayers[0].aes || {})) {
      if (isMapped(m) && dataLayers.every((l) => sameMapping(l.aes?.[k], m))) aes[k] = m;
    }
  }
  return { dataset: ds.length === 1 ? ds[0] : '', aes };
}

// Give a graph made before plot-wide settings its own: what all layers share
// moves up, and the layers inherit it. The plot it draws stays the same.
export function ensureBase(g) {
  if (g.base) return g;
  const base = plotBase(g);
  g.base = { dataset: base.dataset, aes: JSON.parse(JSON.stringify(base.aes)) };
  for (const l of g.layers || []) {
    const geom = GEOMS[l.geom];
    if (!geom || geom.noData) continue;
    l.aes = l.aes || {};
    if (base.dataset && l.dataset === base.dataset) l.dataset = '';
    for (const [k, m] of Object.entries(base.aes)) {
      if (sameMapping(l.aes[k], m)) delete l.aes[k];
      else if (!l.aes[k] && geom.aes.includes(k)) l.aes[k] = { mode: 'none' }; // (a hidden layer without it)
    }
  }
  return g;
}

// A layer as drawn: its own settings, else the plot's data and mappings.
// mode 'none' turns a plot-wide mapping off for one layer.
export function effectiveLayer(l, base) {
  const geom = GEOMS[l.geom];
  if (!geom || geom.noData) return l;
  const aes = {};
  for (const k of geom.aes) {
    const own = l.aes?.[k];
    if (own?.mode === 'none') continue;
    if (own?.mode === 'col' || own?.mode === 'const') aes[k] = own;
    else if (isMapped(base.aes?.[k])) aes[k] = base.aes[k];
  }
  return { ...l, dataset: l.dataset || base.dataset, aes };
}

export function effectiveLayers(g) {
  const base = plotBase(g);
  return (g.layers || []).map((l) => effectiveLayer(l, base));
}

// ---- code generation ------------------------------------------------------------------

function mappingExpr(m, aesKey) {
  const col = rsym(m.col);
  return m.factor || (AES[aesKey]?.discrete && m.numeric) ? `factor(${col})` : col;
}

function constExpr(aesKey, value) {
  const kind = AES[aesKey]?.kind;
  if (kind === 'colour' || kind === 'linetype') return rstr(value);
  return rnum(value);
}

function sameMapping(a, b) {
  return !!a && !!b && a.mode === 'col' && b.mode === 'col' && a.col === b.col && !!a.factor === !!b.factor;
}

// ctx: { rnameOf(id), schemaOf(id), analyses: {id: node} }
export function graphCode(g, ctx) {
  const base = plotBase(g);
  const raw = (g.layers || []).filter((l) => !l.hidden && GEOMS[l.geom]);
  const layers = raw.map((l) => effectiveLayer(l, base));
  const dataLayers = layers.filter((l) => !GEOMS[l.geom].noData);
  for (const l of dataLayers) {
    if (!l.dataset) throw new Error(`Layer "${GEOMS[l.geom].label}" has no dataset: choose one for the layer or for the whole plot.`);
    for (const a of GEOMS[l.geom].required) {
      if (l.aes?.[a]?.mode !== 'col' || !l.aes[a].col) throw new Error(`Layer "${GEOMS[l.geom].label}" needs a column for ${AES[a].label}.`);
    }
  }

  // Which columns are numeric (for x discrete/continuous and colour scales).
  const colType = (dsId, col) => ctx.schemaOf(dsId)?.columns?.find((c) => c.name === col)?.type;
  const isNumericMap = (l, m) => m && m.mode === 'col' && colType(l.dataset, m.col) === 'numeric' && !m.factor;
  const main = dataLayers.find((l) => l.aes?.x?.mode === 'col') || null;
  const xDiscrete = main ? !isNumericMap(main, main.aes.x) : true;
  const yLayer = dataLayers.find((l) => l.aes?.y?.mode === 'col');

  // ggplot(): the plot's data and the mappings every layer inherits.
  const aesStr = (entries) => (entries.length ? `aes(${entries.join(', ')})` : '');
  const baseMaps = Object.entries(base.aes).filter(([k, m]) => AES[k] && isMapped(m));
  const baseData = base.dataset || dataLayers[0]?.dataset;
  const baseEntries = baseMaps.map(([k, m]) => `${k} = ${mappingExpr({ ...m, numeric: isNumericMap({ dataset: baseData }, m) }, k)}`);
  const headArgs = [];
  if (base.dataset) headArgs.push(ctx.rnameOf(base.dataset));
  if (baseEntries.length) headArgs.push(base.dataset ? aesStr(baseEntries) : `mapping = ${aesStr(baseEntries)}`);
  const head = `ggplot(${headArgs.join(', ')})`;

  const parts = [];
  raw.forEach((l, li) => {
    const geom = GEOMS[l.geom];
    if (geom.custom) {
      const code = (l.code || '').trim();
      if (code) parts.push(code);
      return;
    }
    const params = { ...geomDefaults(l.geom), ...(l.params || {}) };
    const built = geom.build(params, { ...layers[li], xDiscrete });
    const maps = new Map();
    const consts = [];
    // A plot-wide X or Y the geom has no use for (e.g. Y for a histogram, which
    // counts) would get in its way: then the layer inherits nothing and lists
    // the mappings it uses itself.
    const standalone = !geom.noData && ['x', 'y'].some((k) => isMapped(base.aes[k]) && !geom.aes.includes(k));
    for (const k of geom.aes) {
      const m = l.aes?.[k];
      const inherited = !geom.noData && !standalone && isMapped(base.aes[k]) ? base.aes[k] : null;
      const eff = layers[li].aes?.[k];
      if (m?.mode === 'col' && m.col) {
        if (!sameMapping(inherited, m)) maps.set(k, mappingExpr({ ...m, numeric: isNumericMap(layers[li], m) }, k));
      } else if (m?.mode === 'const' && m.value !== '' && m.value !== undefined && !AES[k].mapOnly) {
        consts.push(`${k} = ${constExpr(k, m.value)}`);
      } else if (m?.mode === 'none' && inherited) {
        maps.set(k, 'NULL');
      } else if (standalone && isMapped(eff)) {
        maps.set(k, mappingExpr({ ...eff, numeric: isNumericMap(layers[li], eff) }, k));
      }
    }
    for (const [k, v] of Object.entries(built.extraAes || {})) maps.set(k, v);
    const a = [];
    if (!geom.noData && l.dataset && l.dataset !== base.dataset) a.push(`data = ${ctx.rnameOf(l.dataset)}`);
    if (maps.size) a.push(aesStr([...maps].map(([k, v]) => `${k} = ${v}`)));
    a.push(...built.args, ...consts);
    if (standalone) a.push('inherit.aes = FALSE');
    parts.push(`${built.fn}(${a.join(', ')})`);
  });

  // Statistics: computed from the graph's own data, or drawn from analyses.
  for (const ann of g.annotations || []) {
    if (ann.kind === 'compare') {
      parts.push(compareCode(ann, main, yLayer, ctx));
      continue;
    }
    const an = ctx.analyses[ann.analysis];
    if (!an) continue;
    const res = an.rname;
    if (ann.kind === 'brackets') {
      const src = ann.dataset ? { dataset: ann.dataset, x: ann.x, y: ann.y } : main && yLayer
        ? { dataset: main.dataset, x: main.aes.x.col, y: (main.aes.y?.mode === 'col' ? main.aes.y : yLayer.aes.y).col } : null;
      if (!src) throw new Error('P value brackets need a layer with X and Y columns.');
      const a = [res, ctx.rnameOf(src.dataset), `x = ${rstr(src.x)}`, `y = ${rstr(src.y)}`];
      if (ann.format && ann.format !== 'stars') a.push(`format = ${rstr(ann.format)}`);
      if (ann.hide_ns) a.push('hide_ns = TRUE');
      if (ann.y_start !== '' && ann.y_start != null) a.push(`y_start = ${rnum(ann.y_start)}`);
      if (ann.step !== '' && ann.step != null && Number(ann.step) !== 0.09) a.push(`step = ${rnum(ann.step)}`);
      if (ann.text_size && Number(ann.text_size) !== 4.5) a.push(`text_size = ${rnum(ann.text_size)}`);
      parts.push(`ag_brackets(${a.join(', ')})`);
    } else if (ann.kind === 'label') {
      const a = [`${res}$label`, rstr(ann.position || 'top-left')];
      if (ann.text_size && Number(ann.text_size) !== 4.2) a.push(`size = ${rnum(ann.text_size)}`);
      parts.push(`ag_corner_label(${a.join(', ')})`);
    } else if (ann.kind === 'curve') {
      const a = [res];
      if (ann.colour && ann.colour !== '#000000') a.push(`colour = ${rstr(ann.colour)}`);
      if (ann.band === false) a.push('band = FALSE');
      parts.push(`ag_fit_curve(${a.join(', ')})`);
    }
  }

  // Text boxes.
  for (const n of g.notes || []) {
    if (!String(n.text ?? '').trim()) continue;
    parts.push(textBoxCode(n));
  }

  // Colour / fill scales.
  const pal = g.palette?.name || 'default';
  if (pal !== 'default') {
    for (const aesKey of ['colour', 'fill']) {
      const owner = dataLayers.find((l) => l.aes?.[aesKey]?.mode === 'col');
      if (!owner) continue;
      const continuous = isNumericMap(owner, owner.aes[aesKey]);
      const sc = aesKey === 'colour' ? 'colour' : 'fill';
      if (continuous) {
        if (pal === 'viridis') parts.push(`scale_${sc}_viridis_c()`);
        else if (pal === 'grey') parts.push(`scale_${sc}_gradient(low = "grey85", high = "grey10")`);
        continue;
      }
      if (pal === 'okabe') parts.push(`scale_${sc}_manual(values = ag_okabe_ito)`);
      else if (pal === 'viridis') parts.push(`scale_${sc}_viridis_d(end = 0.9)`);
      else if (pal === 'grey') parts.push(sc === 'fill' ? 'scale_fill_grey(start = 0.35, end = 0.9)' : 'scale_colour_grey(start = 0, end = 0.6)');
      else if (pal === 'manual') {
        const entries = Object.entries(g.palette.manual || {}).filter(([, v]) => v);
        if (entries.length) parts.push(`scale_${sc}_manual(values = ${rvec(entries.map(([k, v]) => `${rstr(k)} = ${rstr(v)}`), '  ')})`);
      } else parts.push(`scale_${sc}_brewer(palette = ${rstr(pal)})`);
    }
  }

  // Axes. Ranges go to the coordinate system (coord_cartesian), which zooms
  // without dropping data; scale limits would remove points outside the range
  // and change means, bars and fits.
  const coordLim = {};
  const axis = (which, s, discrete) => {
    if (!s || discrete) return;
    const set = (v) => v !== '' && v != null && !Number.isNaN(Number(v));
    if (set(s.min) || set(s.max)) coordLim[which] = `c(${set(s.min) ? rnum(s.min) : 'NA'}, ${set(s.max) ? rnum(s.max) : 'NA'})`;
    const linear = !s.trans || s.trans === 'identity';
    const a = [];
    if (s.from_zero) a.push('expand = expansion(mult = c(0, 0.05))');
    if (Number(s.step) > 0 && (linear || s.trans === 'sqrt')) a.push(`breaks = scales::breaks_width(${rnum(s.step)})`);
    if (s.format && NUMBER_FORMATS[s.format]) a.push(`labels = ${NUMBER_FORMATS[s.format][1]}`);
    if (s.trans === 'log10') parts.push(`scale_${which}_log10(${a.join(', ')})`);
    else if (s.trans === 'log2') parts.push(`scale_${which}_continuous(${['transform = "log2"', ...a].join(', ')})`);
    else if (s.trans === 'sqrt') parts.push(`scale_${which}_sqrt(${a.join(', ')})`);
    else if (s.reverse) parts.push(`scale_${which}_reverse(${a.join(', ')})`);
    else if (a.length) parts.push(`scale_${which}_continuous(${a.join(', ')})`);
    if (s.from_zero && linear && !s.reverse) parts.push(`expand_limits(${which} = 0)`);
  };
  axis('x', g.x_scale, xDiscrete);
  axis('y', g.y_scale, false);

  if (g.facet?.by) {
    const a = [`vars(${rsym(g.facet.by)})`];
    if (g.facet.scales && g.facet.scales !== 'fixed') a.push(`scales = ${rstr(g.facet.scales)}`);
    if (g.facet.ncol) a.push(`ncol = ${rnum(g.facet.ncol)}`);
    parts.push(`facet_wrap(${a.join(', ')})`);
  }
  const lims = ['x', 'y'].filter((k) => coordLim[k]).map((k) => `${k}lim = ${coordLim[k]}`);
  if (g.flip) parts.push(`coord_flip(${lims.join(', ')})`);
  else if (lims.length) parts.push(`coord_cartesian(${lims.join(', ')})`);

  // Labels. Underlined titles are written as plotmath, e.g. quote(underline(bold("Dose"))).
  const L = g.labels || {};
  const T = g.theme || {};
  const ST = g.style || {};
  const titlesBold = boldTitles(T.name);
  const label = (text, st) => {
    if (!st?.underline) return rstr(text);
    let e = rstr(text);
    if (st.italic) e = `italic(${e})`;
    if (st.bold ?? titlesBold) e = `bold(${e})`;
    return `quote(underline(${e}))`;
  };
  const defaultX = main?.aes?.x?.col;
  const defaultY = (main?.aes?.y?.mode === 'col' ? main.aes.y : yLayer?.aes?.y)?.col;
  const labs = [];
  if (L.title) labs.push(`title = ${label(L.title, ST.title)}`);
  if (L.subtitle) labs.push(`subtitle = ${rstr(L.subtitle)}`);
  if (L.hide_x) labs.push('x = NULL');
  else if (L.x || (ST.x_title?.underline && defaultX)) labs.push(`x = ${label(L.x || defaultX, ST.x_title)}`);
  if (L.hide_y) labs.push('y = NULL');
  else if (L.y || (ST.y_title?.underline && defaultY)) labs.push(`y = ${label(L.y || defaultY, ST.y_title)}`);
  if (L.legend) {
    for (const k of ['colour', 'fill', 'shape']) {
      if (dataLayers.some((l) => l.aes?.[k]?.mode === 'col')) labs.push(`${k} = ${rstr(L.legend)}`);
    }
  }
  if (labs.length) parts.push(`labs(${labs.join(', ')})`);

  // Theme.
  const themeFn = (THEMES.find((t) => t[0] === T.name) || THEMES[0])[2];
  const themeArgs = [`base_size = ${rnum(T.base_size || 14)}`];
  if (ST.family) themeArgs.push(`base_family = ${rstr(ST.family)}`);
  parts.push(`${themeFn}(${themeArgs.join(', ')})`);
  const th = [];
  if (T.legend && T.legend !== 'right') th.push(`legend.position = ${rstr(T.legend)}`);
  if (L.hide_legend_title) th.push('legend.title = element_blank()');
  // `bold: null` means "as the theme does" (the lab-figure theme has bold titles).
  const face = (st, boldByDefault) => {
    if (st?.underline) return 'plain';
    if (st?.bold == null && st?.italic == null) return null;
    const b = st.bold ?? boldByDefault;
    const it = !!st.italic;
    return b && it ? 'bold.italic' : b ? 'bold' : it ? 'italic' : 'plain';
  };
  const element = (name, st, extra = [], boldByDefault = false) => {
    const a = [];
    if (Number(st?.size) > 0) a.push(`size = ${rnum(st.size)}`);
    const f = face(st, boldByDefault);
    if (f) a.push(`face = ${rstr(f)}`);
    if (st?.colour) a.push(`colour = ${rstr(st.colour)}`);
    a.push(...extra);
    if (a.length) th.push(`${name} = element_text(${a.join(', ')})`);
  };
  const align = { left: 0, center: 0.5, right: 1 }[ST.title?.align];
  element('plot.title', ST.title, align !== undefined ? [`hjust = ${align}`] : [], titlesBold);
  element('axis.title.x', ST.x_title, [], titlesBold);
  element('axis.title.y', ST.y_title, [], titlesBold);
  const xAngle = Number(ST.x_text?.angle ?? T.x_angle) || 0;
  element('axis.text.x', ST.x_text, xAngle ? [`angle = ${xAngle}`, 'hjust = 1', `vjust = ${xAngle === 90 ? 0.5 : 1}`] : []);
  const yAngle = Number(ST.y_text?.angle) || 0;
  element('axis.text.y', ST.y_text, yAngle ? [`angle = ${yAngle}`, `hjust = ${yAngle === 90 ? 0.5 : 1}`] : []);
  if (Number(ST.legend_text?.size) > 0) th.push(`legend.text = element_text(size = ${rnum(ST.legend_text.size)})`);
  if (Number(ST.axis_line) > 0) {
    th.push(`axis.line = element_line(linewidth = ${rnum(ST.axis_line)})`, `axis.ticks = element_line(linewidth = ${rnum(ST.axis_line)})`);
  }
  if (th.length) parts.push(`theme(\n  ${th.join(',\n  ')}\n)`);

  const extra = (g.custom || '').trim();
  if (extra) parts.push(extra);

  return `${g.rname} <- ${head}${parts.length ? ' +\n' + parts.map((p) => '  ' + p.replace(/\n/g, '\n  ')).join(' +\n') : ''}`;
}

export const NOTE_DEFAULTS = { text: 'Text', x: 0.5, y: 0.9, data: false, size: 4, colour: '#000000', fill: '#ffffff', border: 0.25, bold: false, italic: false, align: 'center' };

// A text box: ag_text_box("…", x, y, …) with only what differs from the defaults.
function textBoxCode(n) {
  const v = { ...NOTE_DEFAULTS, ...n };
  const a = [rstr(v.text), `x = ${rnum(v.x)}`, `y = ${rnum(v.y)}`];
  if (v.data) a.push('data = TRUE');
  if (Number(v.size) !== 4) a.push(`size = ${rnum(v.size)}`);
  if (v.colour && v.colour.toLowerCase() !== '#000000') a.push(`colour = ${rstr(v.colour)}`);
  if (!v.fill) a.push('fill = NA');
  else {
    if (v.fill.toLowerCase() !== '#ffffff') a.push(`fill = ${rstr(v.fill)}`);
    if (Number(v.border) !== 0.25) a.push(`border = ${rnum(v.border || 0)}`);
  }
  const face = v.bold && v.italic ? 'bold.italic' : v.bold ? 'bold' : v.italic ? 'italic' : '';
  if (face) a.push(`face = ${rstr(face)}`);
  const hjust = { left: 0, center: 0.5, right: 1 }[v.align] ?? 0.5;
  if (hjust !== 0.5) a.push(`hjust = ${hjust}`);
  return `ag_text_box(${a.join(', ')})`;
}

// The groups a layer splits side by side (its fill / colour / group column), if any.
export function sideBySide(layer) {
  const x = layer?.aes?.x?.col;
  for (const k of ['fill', 'colour', 'group']) {
    const m = layer?.aes?.[k];
    if (m?.mode === 'col' && m.col && m.col !== x) return m.col;
  }
  return null;
}

export const COMPARE_TESTS = [
  ['t.test', "Welch's t test (does not assume equal SDs)"],
  ['t.test.equal', 't test (assumes equal SDs)'],
  ['wilcox.test', 'Mann-Whitney / Wilcoxon (non-parametric)'],
];

// "Compare groups": tests computed from the first layer's data (ag_stat_compare).
function compareCode(ann, main, yLayer, ctx) {
  const yCol = (main?.aes?.y?.mode === 'col' ? main.aes.y : yLayer?.aes?.y)?.col;
  if (!main || !yCol) throw new Error('Comparing groups needs a layer with X and Y columns.');
  const x = main.aes.x.col;
  const a = [ctx.rnameOf(main.dataset), `x = ${rstr(x)}`, `y = ${rstr(yCol)}`];
  if (ann.method && ann.method !== 't.test') a.push(`method = ${rstr(ann.method)}`);
  if (ann.comparisons && ann.comparisons !== 'all') a.push(`comparisons = ${rstr(ann.comparisons)}`);
  if (ann.comparisons === 'control' && ann.ref) a.push(`ref = ${rstr(ann.ref)}`);
  if (ann.p_adjust && ann.p_adjust !== 'holm') a.push(`p_adjust = ${rstr(ann.p_adjust)}`);
  if (ann.paired) {
    if (!ann.subject) throw new Error('Paired comparisons need a column that identifies each subject.');
    a.push('paired = TRUE', `subject = ${rstr(ann.subject)}`);
  }
  if (ann.within) {
    const split = sideBySide(main);
    if (!split) throw new Error('To compare side-by-side groups, split the first layer by Fill or Colour.');
    a.push(`within = ${rstr(split)}`);
  }
  if (ann.format && ann.format !== 'stars') a.push(`format = ${rstr(ann.format)}`);
  if (ann.hide_ns) a.push('hide_ns = TRUE');
  if (ann.overall === false) a.push('overall = FALSE');
  else if (ann.position && ann.position !== 'top-left') a.push(`position = ${rstr(ann.position)}`);
  if (ann.y_start !== '' && ann.y_start != null) a.push(`y_start = ${rnum(ann.y_start)}`);
  if (ann.step !== '' && ann.step != null && Number(ann.step) !== 0.09) a.push(`step = ${rnum(ann.step)}`);
  if (ann.text_size && Number(ann.text_size) !== 4.5) a.push(`text_size = ${rnum(ann.text_size)}`);
  return `ag_stat_compare(${a.join(', ')})`;
}

export function graphDeps(g) {
  const ids = new Set();
  const base = plotBase(g);
  if (base.dataset) ids.add(base.dataset);
  for (const l of g.layers || []) {
    if (!l.hidden && GEOMS[l.geom] && !GEOMS[l.geom].noData && (l.dataset || base.dataset)) ids.add(l.dataset || base.dataset);
  }
  for (const a of g.annotations || []) {
    if (a.analysis) ids.add(a.analysis);
    if (a.dataset) ids.add(a.dataset);
  }
  return [...ids];
}
