// A transform: input dataset → steps → output, with a live preview.
import { h, fill, rebuild, debounce } from './dom.js';
import {
  field, select, bindSelect, bindInput, bindCheck, multiCheck, iconButton,
  levelsOf, dataTable, section, codeBlock, messageBox,
} from './widgets.js';
import { itemHeader, warningsBox } from './common.js';
import { STEP_TYPES, MUTATE_PRESETS } from '../codegen/transform.js';
import { datasets, getItem, depsOf } from '../model.js';

export class TransformView {
  constructor(app, item) {
    this.app = app;
    this.item = item;
    this.el = h('div.view.split');
    this.left = h('div.pane.controls', { 'data-scroll': 'controls' });
    this.right = h('div.pane.output');
    this.el.append(this.left, this.right);
    this.refresh = debounce(() => this.runPreview(), 300);
    this.render();
    this.runPreview();
  }

  destroy() { this.refresh.cancel(); }

  onChange({ id }) {
    const deps = new Set([this.item.id, ...depsOf(this.item)]);
    if (!id || deps.has(id) || this.app.isUpstream(id, this.item.id)) this.refresh();
  }

  onResult({ id }) {
    if (id === this.item.input) this.render();
  }

  changed(structural = false) {
    this.app.store.change(this.item.id);
    if (structural) this.render();
  }

  // Columns a step can refer to: the input's, plus any made by earlier steps,
  // plus what the output ends up with.
  columnsFor(index) {
    const names = [];
    const add = (n) => { if (n && !names.includes(n)) names.push(n); };
    (this.app.engine.schemaOf(this.item.input)?.columns || []).forEach((c) => add(c.name));
    this.item.steps.slice(0, index).forEach((s) => {
      if (s.type === 'pivot_longer') { add(s.names_to); add(s.values_to); }
      if (s.type === 'mutate') add(s.name);
      if (s.type === 'rename') add(s.to);
      if (s.type === 'summarise') (s.stats || []).forEach(add);
      if (s.type === 'transpose') add('name');
    });
    // After steps whose new columns depend on the data, offer what the output has.
    if (this.item.steps.slice(0, index).some((s) => ['pivot_wider', 'transpose'].includes(s.type))) {
      (this.app.engine.result(this.item.id)?.schema?.columns || []).forEach((c) => add(c.name));
    }
    return names.map((n) => [n, n]);
  }

  levelsFor(col) {
    return [...new Set([...levelsOf(this.app.engine.schemaOf(this.item.input), col), ...levelsOf(this.app.engine.result(this.item.id)?.schema, col)])];
  }

  render() {
    rebuild(this.left, () => this.controls());
  }

  controls() {
    const it = this.item;
    const p = this.app.store.project;
    const inputOptions = datasets(p).filter((d) => d.id !== it.id).map((d) => [d.id, d.name]);
    const steps = it.steps.map((s, i) => this.stepCard(s, i));
    const addSel = select('', Object.entries(STEP_TYPES).map(([k, t]) => [k, t.label]), (type) => {
      const schema = this.app.engine.schemaOf(it.input);
      it.steps.push({ type, ...STEP_TYPES[type].defaults(schema) });
      this.changed(true);
    }, { placeholder: '+ Add a step…', k: 'add-step' });
    addSel.classList.add('add-select');
    return h('div',
      itemHeader(this.app, it, 'Transform'),
      field('Start from', bindSelect(it, 'input', inputOptions, () => this.changed(true), { placeholder: 'Choose a dataset…', k: 'input' })),
      h('div.steps', steps.length ? steps : h('div.hint', 'No steps yet: the output is a copy of the input.')),
      addSel);
  }

  stepCard(step, i) {
    const t = STEP_TYPES[step.type];
    const it = this.item;
    const cols = this.columnsFor(i);
    const k = (name) => `s${i}-${name}`;
    const ch = (structural) => () => this.changed(structural);
    let body;
    switch (step.type) {
      case 'pivot_longer':
        body = [
          field('Columns to stack', multiCheck(cols, step.cols, (v) => { step.cols = v; this.changed(); }, { k: k('cols') })),
          h('div.row2',
            field('Name column', bindInput(step, 'names_to', ch(), { k: k('names') })),
            field('Value column', bindInput(step, 'values_to', ch(), { k: k('values') }))),
          bindCheck(step, 'drop_na', 'Drop empty cells', ch(), { k: k('dropna') }),
        ];
        break;
      case 'pivot_wider':
        body = [
          field('New column names from', bindSelect(step, 'names_from', cols, ch(), { placeholder: 'Choose…', k: k('nf') })),
          field('Values from', bindSelect(step, 'values_from', cols, ch(), { placeholder: 'Choose…', k: k('vf') })),
          field('Identify rows by (optional)', multiCheck(cols, step.id_cols, (v) => { step.id_cols = v; this.changed(); }, { k: k('id') })),
          field('If several values fall in one cell', bindSelect(step, 'values_fn', [['none', 'Keep them all (list)'], ['mean', 'Mean'], ['median', 'Median'], ['sum', 'Sum'], ['length', 'Count']], ch(), { k: k('fn') })),
        ];
        break;
      case 'transpose':
        body = [field('Use this column for the new column names', bindSelect(step, 'names_col', cols, ch(), { placeholder: '(none: Row 1, Row 2…)', k: k('nc') }))];
        break;
      case 'filter': {
        const levels = this.levelsFor(step.column);
        const ops = [['==', 'equals'], ['!=', 'does not equal'], ['>', '>'], ['>=', '≥'], ['<', '<'], ['<=', '≤'], ['in', 'is one of'], ['not in', 'is not one of'], ['not missing', 'is not empty'], ['missing', 'is empty']];
        body = [h('div.row3',
          bindSelect(step, 'column', cols, ch(true), { placeholder: 'Column…', k: k('col') }),
          bindSelect(step, 'op', ops, ch(true), { k: k('op') }),
          ['in', 'not in', 'missing', 'not missing'].includes(step.op) ? null
            : levels.length && ['==', '!='].includes(step.op)
              ? bindSelect(step, 'value', levels.map((l) => [l, l]), ch(), { placeholder: 'Value…', k: k('val') })
              : bindInput(step, 'value', ch(), { k: k('val'), placeholder: 'Value' })),
        ['in', 'not in'].includes(step.op) ? multiCheck(levels.map((l) => [l, l]), step.values, (v) => { step.values = v; this.changed(); }, { k: k('vals'), empty: 'Choose a column with groups.' }) : null];
        break;
      }
      case 'reorder': {
        const all = [...new Set([...(step.levels || []), ...this.levelsFor(step.column)])];
        if (step.column && all.length && (step.levels || []).length !== all.length) step.levels = all;
        body = [
          field('Column', bindSelect(step, 'column', cols, () => { step.levels = this.levelsFor(step.column); this.changed(true); }, { placeholder: 'Choose…', k: k('col') })),
          h('ol.reorder', (step.levels || []).map((lv, j) => h('li', h('span', lv),
            iconButton('up', 'Move up', () => { if (j > 0) { [step.levels[j - 1], step.levels[j]] = [step.levels[j], step.levels[j - 1]]; this.changed(true); } }, { disabled: j === 0 }),
            iconButton('down', 'Move down', () => { if (j < step.levels.length - 1) { [step.levels[j + 1], step.levels[j]] = [step.levels[j], step.levels[j + 1]]; this.changed(true); } }, { disabled: j === step.levels.length - 1 })))),
        ];
        break;
      }
      case 'rename':
        body = [h('div.row2',
          field('Column', bindSelect(step, 'from', cols, ch(), { placeholder: 'Choose…', k: k('from') })),
          field('New name', bindInput(step, 'to', ch(), { k: k('to') })))];
        break;
      case 'mutate': {
        const checkMsg = h('div.code-check', { 'data-check': k('expr') });
        const checkExpr = debounce(async () => {
          if (!step.expr?.trim()) { fill(checkMsg); return; }
          const r = await this.app.engine.checkCode(step.expr);
          fill(checkMsg, r.ok ? '' : h('span.err', r.error.split('\n')[0]));
        }, 400);
        const exprInput = bindInput(step, 'expr', () => { this.changed(); checkExpr(); }, { k: k('expr'), mono: true, placeholder: 'e.g. log10(value)' });
        const presetCol = { col: cols.find(([n]) => n === 'value')?.[0] || cols[0]?.[0] || '' };
        body = [
          field('New column name', bindInput(step, 'name', ch(), { k: k('name') })),
          field('= R expression', exprInput, { hint: 'Use column names directly. Any R function works: log10(), sqrt(), ifelse(), round()…' }),
          checkMsg,
          h('div.presets', h('span.hint', 'Presets:'),
            select(presetCol.col, cols, (v) => { presetCol.col = v; }, { k: k('pcol'), title: 'Column for the preset' }),
            select('', MUTATE_PRESETS.map((pr, j) => [String(j), pr.label]), (j) => {
              if (j === '') return;
              const group = cols.find(([n]) => n === 'group')?.[0];
              const lvl = group ? this.levelsFor(group)[0] : undefined;
              step.expr = MUTATE_PRESETS[Number(j)].expr(presetCol.col, group, lvl);
              this.changed(true);
            }, { placeholder: 'Insert…', k: k('preset') })),
        ];
        break;
      }
      case 'convert':
        body = [h('div.row2',
          field('Column', bindSelect(step, 'column', cols, ch(), { placeholder: 'Choose…', k: k('col') })),
          field('Make it', bindSelect(step, 'to', [['factor', 'Groups (categories)'], ['numeric', 'Numbers'], ['text', 'Plain text']], ch(), { k: k('to') })))];
        break;
      case 'select':
        body = [
          h('div.segline', select(step.drop ? 'drop' : 'keep', [['keep', 'Keep only'], ['drop', 'Drop']], (v) => { step.drop = v === 'drop'; this.changed(); }, { k: k('drop') })),
          multiCheck(cols, step.columns, (v) => { step.columns = v; this.changed(); }, { k: k('cols') }),
        ];
        break;
      case 'summarise':
        body = [
          field('Summarise', bindSelect(step, 'column', cols, ch(), { placeholder: 'Choose a number column…', k: k('col') })),
          field('For each combination of', multiCheck(cols, step.group_by, (v) => { step.group_by = v; this.changed(); }, { k: k('by') })),
          field('Statistics', multiCheck([['mean', 'Mean'], ['sd', 'SD'], ['sem', 'SEM'], ['n', 'n'], ['median', 'Median'], ['min', 'Min'], ['max', 'Max']], step.stats, (v) => { step.stats = v; this.changed(); }, { k: k('stats') })),
        ];
        break;
      case 'arrange':
        body = [h('div.row2',
          field('Sort by', bindSelect(step, 'column', cols, ch(), { placeholder: 'Choose…', k: k('col') })),
          bindCheck(step, 'desc', 'Largest first', ch(), { k: k('desc') }))];
        break;
      case 'drop_na':
        body = [field('Look for empty cells in', multiCheck(cols, step.columns, (v) => { step.columns = v; this.changed(); }, { k: k('cols') }), { hint: 'Nothing ticked = any column.' })];
        break;
      default:
        body = [];
    }
    const move = (d) => {
      const j = i + d;
      if (j < 0 || j >= it.steps.length) return;
      [it.steps[i], it.steps[j]] = [it.steps[j], it.steps[i]];
      this.changed(true);
    };
    return h('div.card.step', { class: step.disabled ? 'off' : '' },
      h('div.card-head',
        h('span.step-n', String(i + 1)), h('span.card-title', t.label),
        h('span.grow'),
        iconButton(step.disabled ? 'eyeOff' : 'eye', step.disabled ? 'Turn this step on' : 'Turn this step off', () => { step.disabled = !step.disabled; this.changed(true); }),
        iconButton('up', 'Move up', () => move(-1), { disabled: i === 0 }),
        iconButton('down', 'Move down', () => move(1), { disabled: i === it.steps.length - 1 }),
        iconButton('trash', 'Delete step', () => { it.steps.splice(i, 1); this.changed(true); })),
      t.help ? h('div.card-help', t.help) : null,
      h('div.card-body', body));
  }

  async runPreview() {
    const it = this.item;
    const out = this.right;
    if (!getItem(this.app.store.project, it.id)) return;
    out.classList.add('loading');
    const res = await this.app.engine.preview(it.id).catch((e) => ({ ok: false, error: e.message }));
    out.classList.remove('loading');
    const r = this.app.engine.result(it.id);
    fill(out, 
      h('div.out-head', h('h3', 'Result'), res.ok ? h('span.muted', `${res.table.nrow} rows × ${res.table.columns.length} columns${res.table.nrow > res.table.rows.length ? ` (showing first ${res.table.rows.length})` : ''}`) : null),
      res.ok ? dataTable(res.table) : messageBox(r?.incomplete ? 'info' : 'error', res.error),
      warningsBox(r?.warnings),
      section('R code', codeBlock(r?.code || ''), { k: 'code', open: true }));
    // Columns may have changed: refresh the dropdowns.
    this.render();
  }
}
