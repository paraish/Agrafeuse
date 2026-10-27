// The settings of one transform step (filter, mutate, summarise…). Shared by
// the Transform view and a data table's pipeline panel.
//   ctx.columns(i)       [[name, label]] of the columns step i can use
//   ctx.levels(col, i)   the values of a column, as step i sees them
//   ctx.changed(structural)  call after a change (structural = redraw the controls)
//   ctx.engine           for checking typed R code
import { h, fill, debounce } from './dom.js';
import { field, select, bindSelect, bindInput, bindCheck, multiCheck, iconButton } from './widgets.js';
import { MUTATE_PRESETS } from '../codegen/transform.js';

const FILTER_OPS = [['==', 'equals'], ['!=', 'does not equal'], ['>', '>'], ['>=', '≥'], ['<', '<'], ['<=', '≤'],
  ['in', 'is one of'], ['not in', 'is not one of'], ['not missing', 'is not empty'], ['missing', 'is empty'],
  ['expr', 'R condition…']];

export function stepFields(step, i, ctx) {
  const cols = ctx.columns(i);
  const k = (name) => `s${i}-${name}`;
  const ch = (structural) => () => ctx.changed(structural);
  const pick = (key, label) => field(label, multiCheck(cols, step[key], (v) => { step[key] = v; ctx.changed(); }, { k: k(key) }));
  switch (step.type) {
    case 'pivot_longer':
      return [
        field('Columns to stack', multiCheck(cols, step.cols, (v) => { step.cols = v; ctx.changed(); }, { k: k('cols') })),
        h('div.row2',
          field('Name column', bindInput(step, 'names_to', ch(), { k: k('names') })),
          field('Value column', bindInput(step, 'values_to', ch(), { k: k('values') }))),
        bindCheck(step, 'drop_na', 'Drop empty cells', ch(), { k: k('dropna') }),
      ];
    case 'pivot_wider':
      return [
        field('New column names from', bindSelect(step, 'names_from', cols, ch(), { placeholder: 'Choose…', k: k('nf') })),
        field('Values from', bindSelect(step, 'values_from', cols, ch(), { placeholder: 'Choose…', k: k('vf') })),
        field('Identify rows by (optional)', multiCheck(cols, step.id_cols, (v) => { step.id_cols = v; ctx.changed(); }, { k: k('id') })),
        field('If several values fall in one cell', bindSelect(step, 'values_fn', [['none', 'Keep them all (list)'], ['mean', 'Mean'], ['median', 'Median'], ['sum', 'Sum'], ['length', 'Count']], ch(), { k: k('fn') })),
      ];
    case 'transpose':
      return [field('Use this column for the new column names', bindSelect(step, 'names_col', cols, ch(), { placeholder: '(none: Row 1, Row 2…)', k: k('nc') }))];
    case 'filter': {
      if (step.op === 'expr') {
        const expr = codeInput(step, 'expr', ctx, k('expr'), 'e.g. weight > 5 & group != "Control"');
        return [
          bindSelect(step, 'op', FILTER_OPS, ch(true), { k: k('op') }),
          expr.el, expr.msg,
          h('div.hint', 'Keep rows where this is TRUE. Use column names directly; combine with & (and), | (or).'),
        ];
      }
      const levels = ctx.levels(step.column, i);
      const valueControl = ['in', 'not in', 'missing', 'not missing'].includes(step.op) ? null
        : levels.length && ['==', '!='].includes(step.op)
          ? bindSelect(step, 'value', levels.map((l) => [l, l]), ch(), { placeholder: 'Value…', k: k('val') })
          : bindInput(step, 'value', ch(), { k: k('val'), placeholder: 'Value' });
      return [
        h('div.row3',
          bindSelect(step, 'column', cols, ch(true), { placeholder: 'Column…', k: k('col') }),
          bindSelect(step, 'op', FILTER_OPS, ch(true), { k: k('op') }),
          valueControl),
        ['in', 'not in'].includes(step.op) ? multiCheck(levels.map((l) => [l, l]), step.values, (v) => { step.values = v; ctx.changed(); }, { k: k('vals'), empty: 'Choose a column with groups.' }) : null,
      ];
    }
    case 'reorder': {
      const all = [...new Set([...(step.levels || []), ...ctx.levels(step.column, i)])];
      if (step.column && all.length && (step.levels || []).length !== all.length) step.levels = all;
      const swap = (a, b) => { [step.levels[a], step.levels[b]] = [step.levels[b], step.levels[a]]; ctx.changed(true); };
      return [
        field('Column', bindSelect(step, 'column', cols, () => { step.levels = ctx.levels(step.column, i); ctx.changed(true); }, { placeholder: 'Choose…', k: k('col') })),
        h('ol.reorder', (step.levels || []).map((lv, j) => h('li', h('span', lv),
          iconButton('up', 'Move up', () => swap(j - 1, j), { disabled: j === 0 }),
          iconButton('down', 'Move down', () => swap(j, j + 1), { disabled: j === step.levels.length - 1 })))),
      ];
    }
    case 'rename':
      return [h('div.row2',
        field('Column', bindSelect(step, 'from', cols, ch(), { placeholder: 'Choose…', k: k('from') })),
        field('New name', bindInput(step, 'to', ch(), { k: k('to') })))];
    case 'mutate': {
      const presetCol = { col: cols.find(([n]) => n === 'value')?.[0] || cols[0]?.[0] || '' };
      const expr = codeInput(step, 'expr', ctx, k('expr'), 'e.g. log10(value)');
      return [
        field('New column name', bindInput(step, 'name', ch(), { k: k('name') })),
        field('= R expression', expr.el, { hint: 'Use column names directly. Any R function works: log10(), sqrt(), ifelse(), round()…' }),
        expr.msg,
        h('div.presets', h('span.hint', 'Presets:'),
          select(presetCol.col, cols, (v) => { presetCol.col = v; }, { k: k('pcol'), title: 'Column for the preset' }),
          select('', MUTATE_PRESETS.map((pr, j) => [String(j), pr.label]), (j) => {
            if (j === '') return;
            const group = cols.find(([n]) => n === 'group')?.[0];
            const lvl = group ? ctx.levels(group, i)[0] : undefined;
            step.expr = MUTATE_PRESETS[Number(j)].expr(presetCol.col, group, lvl);
            ctx.changed(true);
          }, { placeholder: 'Insert…', k: k('preset') })),
      ];
    }
    case 'convert':
      return [h('div.row2',
        field('Column', bindSelect(step, 'column', cols, ch(), { placeholder: 'Choose…', k: k('col') })),
        field('Make it', bindSelect(step, 'to', [['factor', 'Groups (categories)'], ['numeric', 'Numbers'], ['text', 'Plain text']], ch(), { k: k('to') })))];
    case 'select':
      return [
        h('div.segline', select(step.drop ? 'drop' : 'keep', [['keep', 'Keep only'], ['drop', 'Drop']], (v) => { step.drop = v === 'drop'; ctx.changed(); }, { k: k('drop') })),
        multiCheck(cols, step.columns, (v) => { step.columns = v; ctx.changed(); }, { k: k('cols') }),
      ];
    case 'summarise':
      return [
        field('Summarise', bindSelect(step, 'column', cols, ch(), { placeholder: 'Choose a number column…', k: k('col') })),
        pick('group_by', 'For each combination of'),
        field('Statistics', multiCheck([['mean', 'Mean'], ['sd', 'SD'], ['sem', 'SEM'], ['n', 'n'], ['median', 'Median'], ['min', 'Min'], ['max', 'Max']], step.stats, (v) => { step.stats = v; ctx.changed(); }, { k: k('stats') })),
      ];
    case 'arrange':
      return [h('div.row2',
        field('Sort by', bindSelect(step, 'column', cols, ch(), { placeholder: 'Choose…', k: k('col') })),
        bindCheck(step, 'desc', 'Largest first', ch(), { k: k('desc') }))];
    case 'drop_na':
      return [field('Look for empty cells in', multiCheck(cols, step.columns, (v) => { step.columns = v; ctx.changed(); }, { k: k('columns') }), { hint: 'Nothing ticked = any column.' })];
    case 'distinct':
      return [
        field('One row for each combination of', multiCheck(cols, step.columns, (v) => { step.columns = v; ctx.changed(true); }, { k: k('columns') }), { hint: 'Nothing ticked = drop rows that are exact copies.' }),
        step.columns?.length ? bindCheck(step, 'keep_all', 'Keep the other columns too', ch(), { k: k('keepall') }) : null,
      ];
    case 'slice':
      return [
        h('div.row3',
          bindSelect(step, 'mode', [['head', 'First'], ['tail', 'Last'], ['max', 'Largest'], ['min', 'Smallest']], ch(true), { k: k('mode') }),
          bindInput(step, 'n', ch(), { k: k('n'), type: 'number', min: 0, step: 1, placeholder: 'n' }),
          ['max', 'min'].includes(step.mode) ? bindSelect(step, 'column', cols, ch(), { placeholder: 'of column…', k: k('col') }) : h('span.hint', 'rows')),
        pick('by', 'Within each (optional)'),
      ];
    case 'count':
      return [
        pick('columns', 'Count rows for each combination of'),
        bindCheck(step, 'sort', 'Largest counts first', ch(), { k: k('sort') }),
      ];
    default:
      return [];
  }
}

// A one-line R code input, and where it says if the code does not parse.
function codeInput(step, key, ctx, k, placeholder) {
  const msg = h('div.code-check', { 'data-check': k });
  const check = debounce(async () => {
    if (!step[key]?.trim()) { fill(msg); return; }
    const r = await ctx.engine.checkCode(step[key]);
    fill(msg, r.ok ? '' : h('span.err', r.error.split('\n')[0]));
  }, 400);
  const el = bindInput(step, key, () => { ctx.changed(); check(); }, { k, mono: true, placeholder });
  return { el, msg };
}
