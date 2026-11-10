// A calculated column for a data table: pick a column and what to do with it
// (log, ratio, % of the mean…), or type any R expression of the columns, as in
// dplyr's mutate(). R previews the first values as you go.
import { h, fill, debounce } from './dom.js';
import { modal, select, input, multiCheck, messageBox, field } from './widgets.js';
import { rsym, rnum, rstr } from '../rcode.js';
import { inferColumns } from '../codegen/data.js';

const S = rsym;
const num = (x) => rnum(x === '' || x == null ? 0 : x);
const txt = (c) => `as.character(${S(c)})`;
const int = (x, def) => { const n = Math.round(Number(x)); return x === '' || x == null || !Number.isFinite(n) ? def : Math.max(1, n); };

// Each: label, what extra it needs ('number', 'column' or 'columns'), the R expression, a name.
// text: works on any column (e.g. the row names), with its own settings (fields: [key, label, type, default]).
// The text ones split a label such as "C4A50A+" (cell line × dose × treatment) into one column per factor.
export const FORMULA_PRESETS = [
  { id: 'log10', label: 'log10', expr: (c) => `log10(${S(c)})`, name: (c) => `log10 ${c}` },
  { id: 'log2', label: 'log2', expr: (c) => `log2(${S(c)})`, name: (c) => `log2 ${c}` },
  { id: 'ln', label: 'Natural log (ln)', expr: (c) => `log(${S(c)})`, name: (c) => `ln ${c}` },
  { id: 'sqrt', label: 'Square root', expr: (c) => `sqrt(${S(c)})`, name: (c) => `sqrt ${c}` },
  { id: 'times', label: '× a number', needs: 'number', def: 1000, expr: (c, x) => `${S(c)} * ${num(x.k)}`, name: (c, x) => `${c} × ${x.k}` },
  { id: 'divide', label: '÷ a number', needs: 'number', def: 1000, expr: (c, x) => `${S(c)} / ${num(x.k)}`, name: (c, x) => `${c} ÷ ${x.k}` },
  { id: 'plus', label: '+ a number', needs: 'number', def: 1, expr: (c, x) => `${S(c)} + ${num(x.k)}`, name: (c, x) => `${c} + ${x.k}` },
  { id: 'minus', label: '− a number (e.g. a blank)', needs: 'number', def: 0, expr: (c, x) => `${S(c)} - ${num(x.k)}`, name: (c, x) => `${c} − ${x.k}` },
  { id: 'pct_mean', label: '% of its mean', expr: (c) => `${S(c)} / mean(${S(c)}, na.rm = TRUE) * 100`, name: (c) => `${c} % of mean` },
  { id: 'pct_first', label: '% of its first value', expr: (c) => `${S(c)} / first(${S(c)}) * 100`, name: (c) => `${c} % of first` },
  { id: 'pct_max', label: '% of its largest value', expr: (c) => `${S(c)} / max(${S(c)}, na.rm = TRUE) * 100`, name: (c) => `${c} % of max` },
  { id: 'center', label: 'Minus its mean (centred)', expr: (c) => `${S(c)} - mean(${S(c)}, na.rm = TRUE)`, name: (c) => `${c} centred` },
  { id: 'z', label: 'z-score', expr: (c) => `as.numeric(scale(${S(c)}))`, name: (c) => `${c} z-score` },
  { id: 'rank', label: 'Rank (1 = smallest)', expr: (c) => `rank(${S(c)}, na.last = "keep")`, name: (c) => `${c} rank` },
  { id: 'ratio', label: '÷ another column (ratio)', needs: 'column', expr: (c, x) => `${S(c)} / ${S(x.other)}`, name: (c, x) => `${c} / ${x.other}` },
  { id: 'diff', label: '− another column (difference)', needs: 'column', expr: (c, x) => `${S(c)} - ${S(x.other)}`, name: (c, x) => `${c} − ${x.other}` },
  { id: 'sum', label: '+ another column (sum)', needs: 'column', expr: (c, x) => `${S(c)} + ${S(x.other)}`, name: (c, x) => `${c} + ${x.other}` },
  { id: 'pct_change', label: '% change from another column', needs: 'column', expr: (c, x) => `(${S(c)} - ${S(x.other)}) / ${S(x.other)} * 100`, name: (c, x) => `${c} % change from ${x.other}` },
  { id: 'row_mean', label: 'Mean of several columns (per row)', needs: 'columns', expr: (c, x) => `rowMeans(cbind(${[c, ...(x.others || [])].map(S).join(', ')}), na.rm = TRUE)`, name: (c, x) => `mean of ${[c, ...(x.others || [])].join(', ')}` },
  { id: 'threshold', label: 'Groups: above or below a number', needs: 'number', def: 0, expr: (c, x) => `ifelse(${S(c)} > ${num(x.k)}, "above ${x.k}", "${x.k} or below")`, name: (c) => `${c} group` },
  { id: 'part', text: true, label: 'Text: the part between separators', fields: [['sep', 'Separator', 'text', '_'], ['which', 'Part number', 'number', 1]],
    expr: (c, x) => `sapply(strsplit(${txt(c)}, ${rstr(x.sep || ' ')}, fixed = TRUE), "[", ${int(x.which, 1)})`, name: (c, x) => `${c} part ${int(x.which, 1)}` },
  { id: 'chars', text: true, label: 'Text: characters from … to …', fields: [['from', 'From character', 'number', 1], ['to', 'To character', 'number', 2]],
    expr: (c, x) => `substr(${txt(c)}, ${int(x.from, 1)}, ${int(x.to, 2)})`, name: (c, x) => `${c} ${int(x.from, 1)}-${int(x.to, 2)}` },
  { id: 'last', text: true, label: 'Text: the last characters', fields: [['n', 'How many', 'number', 1]],
    expr: (c, x) => { const n = int(x.n, 1); return `substring(${txt(c)}, nchar(${txt(c)})${n > 1 ? ` - ${n - 1}` : ''})`; }, name: (c, x) => `${c} last ${int(x.n, 1)}` },
  { id: 'number_in', text: true, label: 'Text: the number in it (1st, 2nd…)', fields: [['nth', 'Which number', 'number', 1]],
    expr: (c, x) => `as.numeric(sapply(regmatches(${txt(c)}, gregexpr("[0-9.]+", ${txt(c)})), "[", ${int(x.nth, 1)}))`, name: (c, x) => `${c} number ${int(x.nth, 1)}` },
  { id: 'contains', text: true, label: 'Text: contains … (yes / no groups)', fields: [['pat', 'Text to look for', 'text', '+']],
    expr: (c, x) => `ifelse(grepl(${rstr(x.pat || '')}, ${txt(c)}, fixed = TRUE), ${rstr(`with ${x.pat || ''}`)}, ${rstr(`without ${x.pat || ''}`)})`, name: (c, x) => `${c} ${x.pat || ''}` },
  { id: 'combine', text: true, label: 'Combine columns into one label', needs: 'columns',
    expr: (c, x) => `paste(${[c, ...(x.others || [])].map(S).join(', ')})`, name: (c, x) => [c, ...(x.others || [])].join(' × ') },
  { id: 'custom', label: 'Your own R expression' },
];

// Opens the dialog. index: the calculated column to change (null for a new one);
// source: the column to start from. Resolves to { action: 'save' | 'remove' | 'values', name, formula } or null.
export function formulaDialog(app, table, { index = null, source = null } = {}) {
  const editing = index != null ? table.columns[index] : null;
  const cols = inferColumns(table).columns.filter((c, j) => !editing || c.index !== index);
  const names = cols.map((c) => c.name);
  const numbers = cols.filter((c) => c.type === 'numeric').map((c) => c.name);
  const sourceName = source != null && table.columns[source] && !table.columns[source].formula ? table.columns[source].name : null;
  const first = sourceName || numbers[0] || names[0] || '';
  // Starting from a text column (or a table with no numbers): a text preset.
  const textStart = !numbers.includes(first);
  const state = {
    preset: editing ? 'custom' : textStart ? 'part' : 'log10',
    col: first,
    k: '',
    other: numbers.find((n) => n !== first) || '',
    others: [],
    name: editing ? editing.name : '',
    expr: editing ? editing.formula : '',
    nameTouched: !!editing,
  };
  const exprInput = input(state.expr, (v) => { state.expr = v; state.preset = 'custom'; presetSel.value = 'custom'; drawExtra(); check(); }, { k: 'fx-expr', mono: true, placeholder: 'e.g. log10(weight) or weight / length * 100' });
  const nameInput = input(state.name, (v) => { state.name = v; state.nameTouched = true; }, { k: 'fx-name', placeholder: 'Name of the new column' });
  const preview = h('div.fx-preview');
  const extra = h('div.fx-extra');
  const fromRow = h('div.fx-from');
  let presetSel;

  // A preset writes the expression (and a name, until the user types one).
  const apply = () => {
    const p = FORMULA_PRESETS.find((x) => x.id === state.preset);
    if (!p || !p.expr) return;
    if (state.k === '' && p.def !== undefined) state.k = String(p.def);
    for (const [key, , , def] of p.fields || []) if (state[key] === undefined) state[key] = def;
    state.expr = p.expr(state.col, state);
    exprInput.value = state.expr;
    if (!state.nameTouched) { state.name = p.name(state.col, state); nameInput.value = state.name; }
    check();
  };
  // Number presets offer the number columns; text ones any column (the row names too).
  const choices = (p) => (p?.text || !numbers.length ? names : numbers);
  const drawExtra = () => {
    const p = FORMULA_PRESETS.find((x) => x.id === state.preset);
    const pool = choices(p);
    if (p?.expr && !pool.includes(state.col)) state.col = pool[0] || '';
    fill(fromRow, field('Column', select(state.col, pool.map((n) => [n, n]), (v) => { state.col = v; drawExtra(); apply(); }, { k: 'fx-col' })));
    const others = pool.filter((n) => n !== state.col);
    state.others = (state.others || []).filter((n) => others.includes(n));
    fill(extra,
      p?.needs === 'number' ? field(p.id === 'threshold' ? 'Threshold' : 'Number', input(state.k, (v) => { state.k = v; apply(); }, { type: 'number', step: 'any', k: 'fx-k', width: '120px' })) : null,
      p?.needs === 'column' ? field('Other column', select(state.other, others.map((n) => [n, n]), (v) => { state.other = v; apply(); }, { k: 'fx-other', placeholder: 'Choose…' })) : null,
      p?.needs === 'columns' ? field(p.id === 'combine' ? 'And' : 'With', multiCheck(others.map((n) => [n, n]), state.others, (v) => { state.others = v; apply(); }, { k: 'fx-others' })) : null,
      p?.fields ? h('div.row2', p.fields.map(([key, label, type, def]) => field(label, input(state[key] ?? def, (v) => { state[key] = v; apply(); },
        { type, step: 1, min: type === 'number' ? 1 : undefined, k: `fx-${key}`, width: type === 'number' ? '90px' : '120px' })))) : null);
    fromRow.hidden = state.preset === 'custom';
  };
  presetSel = select(state.preset, FORMULA_PRESETS.map((p) => [p.id, p.label]), (v) => { state.preset = v; drawExtra(); apply(); }, { k: 'fx-preset' });

  // R works out the first values (or says what is wrong).
  let lastCheck = null;
  const check = debounce(async () => {
    const expr = state.expr.trim();
    if (!expr) { fill(preview, h('span.muted', 'Type an expression.')); lastCheck = null; return; }
    fill(preview, h('span.muted', 'Working it out…'));
    const res = await app.engine.tryFormula(table.id, expr).catch((e) => ({ ok: false, error: e.message }));
    if (state.expr.trim() !== expr) return;
    lastCheck = res;
    fill(preview, res.ok
      ? [h('span.muted', `First values (${res.type === 'numeric' ? 'numbers' : 'text / groups'}): `), h('code', [].concat(res.values).join(', '))]
      : messageBox('error', String(res.error).split('\n').slice(0, 3).join('\n')));
  }, 350);

  drawExtra();
  if (editing) check(); else apply();

  const actions = [{ label: 'Cancel', value: () => null }];
  if (editing) {
    actions.push({ label: 'Delete column', kind: 'danger', value: () => ({ action: 'remove' }) });
    actions.push({ label: 'Turn into plain values', value: () => ({ action: 'values' }) });
  }
  actions.push({
    label: editing ? 'Save' : 'Add column', kind: 'primary',
    value: () => {
      const name = state.name.trim();
      if (!name) { nameInput.focus(); fill(preview, messageBox('error', 'Give the column a name.')); return undefined; }
      if (names.includes(name)) { nameInput.focus(); fill(preview, messageBox('error', `There is already a column called "${name}".`)); return undefined; }
      if (!state.expr.trim()) { exprInput.focus(); return undefined; }
      if (lastCheck && !lastCheck.ok) return undefined; // fix the formula first
      return { action: 'save', name, formula: state.expr.trim() };
    },
  });

  return modal({
    title: editing ? `Calculated column "${editing.name}"` : 'Add a calculated column',
    wide: true,
    body: h('div.fx-dialog',
      h('p.hint', 'A column worked out from the others (like dplyr\'s mutate). It updates whenever the data change. The "Text:" presets split a label such as "C4A50A+" into one column per condition (e.g. cell line, dose, treatment).'),
      h('div.row2', field('Start from', presetSel), fromRow),
      extra,
      field('= R expression', exprInput, { hint: 'Use column names directly (names with spaces in `backticks`). Any R function works: log10(), round(), ifelse(), mean()…' }),
      field('New column', nameInput),
      preview),
    actions,
  });
}
