// Transforms: a chain of dplyr / tidyr steps that turns one dataset into another.
import { rsym, rstr, rnum, rvec } from '../rcode.js';

const cols = (names) => (names.length === 1 ? rsym(names[0]) : rvec(names.map(rsym), '    '));

// Each step type: label, a one-line help text, default settings, and its R code.
// `schema` is the input dataset's columns (for knowing which are numeric).
export const STEP_TYPES = {
  pivot_longer: {
    label: 'Wide → long (melt / pivot longer)',
    help: 'Stack several columns into two: one naming the column a value came from, one holding the value. Use this to turn a Prism-style table (one column per group) into the long format ggplot2 and most tests need.',
    defaults: (schema) => ({
      cols: (schema?.columns || []).filter((c) => c.type === 'numeric').map((c) => c.name),
      names_to: 'group', values_to: 'value', drop_na: true,
    }),
    code: (s) => {
      if (!s.cols?.length) throw new Error('Choose the columns to stack.');
      const lines = [`pivot_longer(${cols(s.cols)}, names_to = ${rstr(s.names_to || 'group')}, values_to = ${rstr(s.values_to || 'value')}${s.drop_na ? ', values_drop_na = TRUE' : ''})`];
      lines.push(`mutate(${rsym(s.names_to || 'group')} = factor(${rsym(s.names_to || 'group')}, levels = ${rvec(s.cols.map(rstr), '    ')}))`);
      return lines;
    },
  },
  pivot_wider: {
    label: 'Long → wide (pivot wider)',
    help: 'Spread a long table out: one new column for every value of a "names" column.',
    defaults: () => ({ names_from: '', values_from: '', id_cols: [], values_fn: 'none' }),
    code: (s) => {
      if (!s.names_from || !s.values_from) throw new Error('Choose the names and values columns.');
      const a = [];
      if (s.id_cols?.length) a.push(`id_cols = ${cols(s.id_cols)}`);
      a.push(`names_from = ${rsym(s.names_from)}`, `values_from = ${rsym(s.values_from)}`);
      if (s.values_fn && s.values_fn !== 'none') a.push(`values_fn = ${s.values_fn}`);
      return [`pivot_wider(${a.join(', ')})`];
    },
  },
  transpose: {
    label: 'Transpose (swap rows and columns)',
    help: 'Rows become columns. Optionally use one column\'s values as the new column names.',
    defaults: () => ({ names_col: '' }),
    code: (s) => [`pb_transpose(${s.names_col ? `names_col = ${rstr(s.names_col)}` : ''})`],
  },
  filter: {
    label: 'Filter rows',
    help: 'Keep only the rows that match a condition.',
    defaults: () => ({ column: '', op: '==', value: '', values: [] }),
    code: (s, schema) => {
      if (!s.column) throw new Error('Choose a column to filter on.');
      const c = rsym(s.column);
      const numeric = schema?.columns?.find((x) => x.name === s.column)?.type === 'numeric';
      const lit = (v) => (numeric ? rnum(v) : rstr(v));
      switch (s.op) {
        case 'in': return [`filter(${c} %in% ${rvec((s.values || []).map(lit), '    ')})`];
        case 'not in': return [`filter(!${c} %in% ${rvec((s.values || []).map(lit), '    ')})`];
        case 'missing': return [`filter(is.na(${c}))`];
        case 'not missing': return [`filter(!is.na(${c}))`];
        default: return [`filter(${c} ${s.op} ${lit(s.value)})`];
      }
    },
  },
  reorder: {
    label: 'Reorder groups (factor levels)',
    help: 'Set the order groups appear in on graphs and in results.',
    defaults: () => ({ column: '', levels: [] }),
    code: (s) => {
      if (!s.column) throw new Error('Choose a column.');
      return [`mutate(${rsym(s.column)} = pb_relevel(${rsym(s.column)}, ${rvec((s.levels || []).map(rstr), '    ')}))`];
    },
  },
  rename: {
    label: 'Rename a column',
    help: '',
    defaults: () => ({ from: '', to: '' }),
    code: (s) => {
      if (!s.from || !s.to) throw new Error('Choose a column and a new name.');
      return [`rename(${rsym(s.to)} = ${rsym(s.from)})`];
    },
  },
  mutate: {
    label: 'Calculate a column',
    help: 'Add a column (or overwrite one) using an R expression of the other columns, e.g. log10(value) or value / mean(value[group == "Control"]) * 100.',
    defaults: () => ({ name: 'new_value', expr: '' }),
    code: (s) => {
      if (!s.name) throw new Error('Give the new column a name.');
      if (!s.expr?.trim()) throw new Error('Type an expression, or pick a preset.');
      return [`mutate(${rsym(s.name)} = ${s.expr.trim()})`];
    },
  },
  convert: {
    label: 'Change a column type',
    help: 'Treat numbers as groups (categories), or text as numbers.',
    defaults: () => ({ column: '', to: 'factor' }),
    code: (s) => {
      if (!s.column) throw new Error('Choose a column.');
      const c = rsym(s.column);
      const fn = { factor: `pb_factor(${c})`, numeric: `as.numeric(as.character(${c}))`, text: `as.character(${c})` }[s.to];
      return [`mutate(${c} = ${fn})`];
    },
  },
  select: {
    label: 'Keep / drop columns',
    help: '',
    defaults: (schema) => ({ columns: (schema?.columns || []).map((c) => c.name), drop: false }),
    code: (s) => {
      if (!s.columns?.length) throw new Error('Choose at least one column.');
      return [s.drop ? `select(-${cols(s.columns)})` : `select(${s.columns.map(rsym).join(', ')})`];
    },
  },
  summarise: {
    label: 'Summarise by group (mean, SD, SEM, n…)',
    help: 'One row per group with summary statistics. Handy for pre-computed error bars or tables.',
    defaults: () => ({ group_by: [], column: '', stats: ['mean', 'sd', 'sem', 'n'] }),
    code: (s) => {
      if (!s.column) throw new Error('Choose the column to summarise.');
      const v = rsym(s.column);
      const all = {
        mean: `mean = mean(${v}, na.rm = TRUE)`,
        sd: `sd = sd(${v}, na.rm = TRUE)`,
        n: `n = sum(!is.na(${v}))`,
        sem: `sem = sd(${v}, na.rm = TRUE) / sqrt(sum(!is.na(${v})))`,
        median: `median = median(${v}, na.rm = TRUE)`,
        min: `min = min(${v}, na.rm = TRUE)`,
        max: `max = max(${v}, na.rm = TRUE)`,
      };
      const chosen = (s.stats || []).filter((k) => all[k]).map((k) => all[k]);
      if (!chosen.length) throw new Error('Pick at least one statistic.');
      const by = s.group_by?.length ? `, .by = ${cols(s.group_by)}` : '';
      return [`summarise(\n    ${chosen.join(',\n    ')}${by}\n  )`];
    },
  },
  arrange: {
    label: 'Sort rows',
    help: '',
    defaults: () => ({ column: '', desc: false }),
    code: (s) => {
      if (!s.column) throw new Error('Choose a column.');
      return [`arrange(${s.desc ? `desc(${rsym(s.column)})` : rsym(s.column)})`];
    },
  },
  drop_na: {
    label: 'Remove rows with missing values',
    help: '',
    defaults: () => ({ columns: [] }),
    code: (s) => [`drop_na(${(s.columns || []).map(rsym).join(', ')})`],
  },
};

export const MUTATE_PRESETS = [
  { label: 'log10', expr: (c) => `log10(${rsym(c)})` },
  { label: 'log2', expr: (c) => `log2(${rsym(c)})` },
  { label: 'Natural log', expr: (c) => `log(${rsym(c)})` },
  { label: 'Square root', expr: (c) => `sqrt(${rsym(c)})` },
  { label: 'Z-score', expr: (c) => `as.numeric(scale(${rsym(c)}))` },
  { label: '% of the mean of a control group', expr: (c, g, lvl) => `${rsym(c)} / mean(${rsym(c)}[${rsym(g || 'group')} == ${rstr(lvl || 'Control')}], na.rm = TRUE) * 100` },
  { label: 'Normalise to 0–100%', expr: (c) => `(${rsym(c)} - min(${rsym(c)}, na.rm = TRUE)) / diff(range(${rsym(c)}, na.rm = TRUE)) * 100` },
  { label: 'Difference from the first value', expr: (c) => `${rsym(c)} - first(${rsym(c)})` },
];

export function transformCode(node, inputRName, inputSchema) {
  const lines = [];
  for (const step of node.steps || []) {
    if (step.disabled) continue;
    const t = STEP_TYPES[step.type];
    if (!t) throw new Error(`Unknown step type ${step.type}`);
    for (const l of t.code(step, inputSchema)) lines.push(l);
  }
  if (!lines.length) return `${node.rname} <- ${inputRName}`;
  return `${node.rname} <- ${inputRName} |>\n${lines.map((l) => '  ' + l).join(' |>\n')}`;
}

export function stepCode(step, schema) {
  return STEP_TYPES[step.type].code(step, schema).join('\n');
}

