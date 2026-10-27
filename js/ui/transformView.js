// A transform: input dataset → steps → output, with a live preview.
import { h, fill, rebuild, debounce } from './dom.js';
import { field, select, bindSelect, iconButton, levelsOf, dataTable, section, codeBlock, messageBox } from './widgets.js';
import { itemHeader, warningsBox } from './common.js';
import { stepFields } from './steps.js';
import { STEP_TYPES } from '../codegen/transform.js';
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
      if (s.type === 'count') add('n');
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
    const body = stepFields(step, i, {
      columns: (j) => this.columnsFor(j),
      levels: (col) => this.levelsFor(col),
      changed: (structural) => this.changed(structural),
      engine: this.app.engine,
    });
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
