// Transforms: a chain of dplyr / tidyr steps that turns one dataset into another.
import { rsym, rstr, rnum, rvec } from '../rcode.js';
import { parseNumber } from './data.js';

const cols = (names) => (names.length === 1 ? rsym(names[0]) : rvec(names.map(rsym), '    '));

// Each step type: label, the dplyr / tidyr verb it uses, a short description
// and a help text, default settings, its R code, and optionally a brief
// one-line summary (otherwise the arguments of the code are shown).
// `schema` is the input dataset's columns (for knowing which are numeric).
export const STEP_TYPES = {
  pivot_longer: {
    label: 'Wide → long (melt / pivot longer)',
    verb: 'pivot_longer', short: 'Wide → long (melt)',
    brief: (s) => `${s.cols.join(', ')} → ${s.names_to || 'group'}, ${s.values_to || 'value'}`,
    help: 'Stack several columns into two: one naming the column a value came from, one holding the value. Use this to turn a table with one column per group into the long format ggplot2 and most tests need.',
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
    verb: 'pivot_wider', short: 'Long → wide',
    brief: (s) => `names from ${s.names_from}, values from ${s.values_from}`,
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
    verb: 'transpose', short: 'Swap rows and columns',
    brief: (s) => (s.names_col ? `names from ${s.names_col}` : 'rows ↔ columns'),
    help: 'Rows become columns. Optionally use one column\'s values as the new column names.',
    defaults: () => ({ names_col: '' }),
    code: (s) => [`ag_transpose(${s.names_col ? `names_col = ${rstr(s.names_col)}` : ''})`],
  },
  filter: {
    label: 'Filter rows',
    verb: 'filter', short: 'Keep rows that match a condition',
    help: 'Keep only the rows that match a condition.',
    defaults: () => ({ column: '', op: '==', value: '', values: [], expr: '' }),
    code: (s, schema) => {
      if (s.op === 'expr') {
        if (!s.expr?.trim()) throw new Error('Type a condition, e.g. weight > 5 & group != "Control".');
        return [`filter(${s.expr.trim()})`];
      }
      if (!s.column) throw new Error('Choose a column to filter on.');
      const c = rsym(s.column);
      // A column made by an earlier step may not be known yet: then go by the values.
      const known = schema?.columns?.find((x) => x.name === s.column);
      const values = ['in', 'not in'].includes(s.op) ? s.values || [] : [s.value];
      const numeric = known ? known.type === 'numeric' : values.length > 0 && values.every((v) => parseNumber(v) != null);
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
    verb: 'relevel', short: 'Set the order of groups',
    brief: (s) => `${s.column}: ${(s.levels || []).join(', ')}`,
    help: 'Set the order groups appear in on graphs and in results.',
    defaults: () => ({ column: '', levels: [] }),
    code: (s) => {
      if (!s.column) throw new Error('Choose a column.');
      return [`mutate(${rsym(s.column)} = ag_relevel(${rsym(s.column)}, ${rvec((s.levels || []).map(rstr), '    ')}))`];
    },
  },
  rename: {
    label: 'Rename a column',
    verb: 'rename', short: 'Rename a column',
    help: '',
    defaults: () => ({ from: '', to: '' }),
    code: (s) => {
      if (!s.from || !s.to) throw new Error('Choose a column and a new name.');
      return [`rename(${rsym(s.to)} = ${rsym(s.from)})`];
    },
  },
  mutate: {
    label: 'Calculate a column',
    verb: 'mutate', short: 'Calculate a new column',
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
    verb: 'convert', short: 'Change a column type',
    brief: (s) => `${s.column} → ${{ factor: 'groups', numeric: 'numbers', text: 'text' }[s.to]}`,
    help: 'Treat numbers as groups (categories), or text as numbers.',
    defaults: () => ({ column: '', to: 'factor' }),
    code: (s) => {
      if (!s.column) throw new Error('Choose a column.');
      const c = rsym(s.column);
      const fn = { factor: `ag_factor(${c})`, numeric: `as.numeric(as.character(${c}))`, text: `as.character(${c})` }[s.to];
      return [`mutate(${c} = ${fn})`];
    },
  },
  select: {
    label: 'Keep / drop columns',
    verb: 'select', short: 'Keep or drop columns',
    help: '',
    defaults: (schema) => ({ columns: (schema?.columns || []).map((c) => c.name), drop: false }),
    code: (s) => {
      if (!s.columns?.length) throw new Error('Choose at least one column.');
      return [s.drop ? `select(-${cols(s.columns)})` : `select(${s.columns.map(rsym).join(', ')})`];
    },
  },
  summarise: {
    label: 'Summarise by group (mean, SD, SEM, n…)',
    verb: 'summarise', short: 'Mean, SD, SEM, n… per group',
    brief: (s) => `${(s.stats || []).join(', ')} of ${s.column}${s.group_by?.length ? ` by ${s.group_by.join(', ')}` : ''}`,
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
    verb: 'arrange', short: 'Sort rows',
    help: '',
    defaults: () => ({ column: '', desc: false }),
    code: (s) => {
      if (!s.column) throw new Error('Choose a column.');
      return [`arrange(${s.desc ? `desc(${rsym(s.column)})` : rsym(s.column)})`];
    },
  },
  drop_na: {
    label: 'Remove rows with missing values',
    verb: 'drop_na', short: 'Remove rows with empty cells',
    brief: (s) => (s.columns?.length ? `empty ${s.columns.join(', ')}` : 'empty anywhere'),
    help: '',
    defaults: () => ({ columns: [] }),
    code: (s) => [`drop_na(${(s.columns || []).map(rsym).join(', ')})`],
  },
  distinct: {
    label: 'Remove duplicate rows (distinct)',
    verb: 'distinct', short: 'Remove duplicate rows',
    brief: (s) => (s.columns?.length ? `${s.columns.join(', ')}${s.keep_all ? '' : ' (only these columns)'}` : 'all columns'),
    help: 'Keep one row for each different combination of the chosen columns (nothing ticked = whole rows that are exact copies).',
    defaults: () => ({ columns: [], keep_all: true }),
    code: (s) => {
      if (!s.columns?.length) return ['distinct()'];
      return [`distinct(${s.columns.map(rsym).join(', ')}${s.keep_all ? ', .keep_all = TRUE' : ''})`];
    },
  },
  slice: {
    label: 'First, last or top rows (slice)',
    verb: 'slice', short: 'First, last, largest or smallest rows',
    brief: (s) => {
      const what = { head: `first ${s.n}`, tail: `last ${s.n}`, max: `${s.n} largest ${s.column}`, min: `${s.n} smallest ${s.column}` }[s.mode];
      return `${what}${s.by?.length ? ` per ${s.by.join(', ')}` : ''}`;
    },
    help: 'Keep some of the rows: the first or last ones, or the ones with the largest or smallest values of a column. Pick columns under "Within each" to do this per group.',
    defaults: () => ({ mode: 'head', n: 5, column: '', by: [] }),
    code: (s) => {
      const n = Number(s.n);
      if (s.n === '' || !Number.isInteger(n) || n < 0) throw new Error('Type how many rows to keep.');
      const by = s.by?.length ? `, by = ${cols(s.by)}` : '';
      if (s.mode === 'max' || s.mode === 'min') {
        if (!s.column) throw new Error('Choose the column to rank the rows by.');
        return [`slice_${s.mode}(${rsym(s.column)}, n = ${n}${by})`];
      }
      return [`slice_${s.mode === 'tail' ? 'tail' : 'head'}(n = ${n}${by})`];
    },
  },
  count: {
    label: 'Count rows per group (count)',
    verb: 'count', short: 'Number of rows per group',
    brief: (s) => (s.columns?.length ? `by ${s.columns.join(', ')}` : 'all rows'),
    help: 'One row per combination of the chosen columns, with the number of rows in a column called n.',
    defaults: () => ({ columns: [], sort: false }),
    code: (s) => [`count(${[...(s.columns || []).map(rsym), s.sort ? 'sort = TRUE' : null].filter(Boolean).join(', ')})`],
  },
};

// How the "+" menu of a data table's pipeline groups the verbs.
export const STEP_GROUPS = [
  ['Rows', ['filter', 'arrange', 'slice', 'distinct', 'drop_na']],
  ['Columns', ['select', 'mutate', 'rename', 'convert', 'reorder']],
  ['Summarise and reshape', ['summarise', 'count', 'pivot_longer', 'pivot_wider', 'transpose']],
];

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

// One line saying what a step does, e.g. "weight > 5" for a filter.
// incomplete = the step still needs settings (text says which).
export function stepBrief(step, schema) {
  const t = STEP_TYPES[step.type];
  if (!t) return { text: `Unknown step ${step.type}`, incomplete: true };
  let code;
  try {
    code = t.code(step, schema).join(' |> ').replace(/\s+/g, ' ');
  } catch (e) {
    return { text: e.message, incomplete: true };
  }
  if (t.brief) return { text: t.brief(step) };
  const m = code.match(/^\w+\((.*)\)$/);
  return { text: (m ? m[1] : code).replace(/^\( /, '(').replace(/ \)$/, ')') };
}

// A data table's pipeline: each step with its R code, or why it does not run
// (switched off, or not set up yet). Steps that do not run are skipped.
export function pipePlan(steps, schema) {
  return steps.map((step, index) => {
    if (step.disabled) return { index, state: 'off' };
    try {
      return { index, state: 'run', code: STEP_TYPES[step.type].code(step, schema).join(' |> ') };
    } catch (e) {
      return { index, state: 'incomplete', error: e.message };
    }
  });
}

