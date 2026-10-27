// A data table's dplyr pipeline: a panel stapled to the right of the grid.
// Steps are compact one-line rows (verb + what it does + rows × columns after
// it); click one to edit it, drag to reorder, "+" to add. The result shows in
// the main pane, and can become a new data table or a linked transform.
import { h, fill, icon, rebuild, debounce } from './dom.js';
import { button, iconButton, dataTable, section, codeBlock, messageBox, toast, levelsOf } from './widgets.js';
import { warningsBox } from './common.js';
import { stepFields } from './steps.js';
import { STEP_TYPES, STEP_GROUPS, stepBrief, transformCode } from '../codegen/transform.js';
import { newDataTable, newTransform, uniqueName, clone } from '../model.js';

// Whether each table's panel is open, for as long as the page is open.
const openState = new Map();

export class PipePanel {
  // onShow(view): ask the data view to show 'data' or 'result'.
  constructor(app, item, { onShow }) {
    this.app = app;
    this.item = item;
    this.onShow = onShow;
    this.res = null;
    this.editing = null; // the step being edited (object, so it survives reordering)
    this.el = h('aside.pipe');
    this.resultEl = h('div.pipe-result');
    this.refresh = debounce(() => this.run(), 300);
    this.render();
    if (this.open && this.steps.length) this.run();
  }

  destroy() {
    this.refresh.cancel();
    this.closeMenu?.();
  }

  get steps() { return this.item.pipe?.steps || []; }

  get open() { return openState.get(this.item.id) ?? this.steps.length > 0; }

  set open(v) { openState.set(this.item.id, v); }

  // Something in the project changed: re-run if this table's data or steps did.
  onChange({ id }) {
    if (id === this.item.id && this.open && this.steps.length) this.refresh();
  }

  changed(structural = false) {
    this.app.store.change(this.item.id);
    if (structural) this.render();
    this.onShow('result');
  }

  toggle(open = !this.open) {
    this.open = open;
    this.render();
    if (open && this.steps.length) { this.run(); this.onShow('result'); } else this.onShow('data');
  }

  // ---- what each step sees -------------------------------------------------------------------

  // Columns going into step i: from the last step before it that ran, else the table's.
  schemaAt(i) {
    const plan = this.res?.plan || [];
    for (let j = Math.min(i, plan.length) - 1; j >= 0; j--) if (plan[j]?.stage) return plan[j].stage;
    return this.res?.input || this.app.engine.schemaOf(this.item.id);
  }

  ctx() {
    return {
      columns: (i) => (this.schemaAt(i)?.columns || []).map((c) => [c.name, c.name]),
      levels: (col, i) => levelsOf(this.schemaAt(i), col),
      changed: (structural) => this.changed(structural),
      engine: this.app.engine,
    };
  }

  // ---- steps ---------------------------------------------------------------------------------

  add(type) {
    const it = this.item;
    if (!it.pipe) it.pipe = { steps: [] };
    const step = { type, ...STEP_TYPES[type].defaults(this.schemaAt(it.pipe.steps.length)) };
    it.pipe.steps.push(step);
    this.editing = step;
    this.changed(true);
  }

  move(from, to) {
    const steps = this.steps;
    if (from === to || to < 0 || to >= steps.length) return;
    const [s] = steps.splice(from, 1);
    steps.splice(to, 0, s);
    this.changed(true);
  }

  remove(i) {
    const [s] = this.steps.splice(i, 1);
    if (s === this.editing) this.editing = null;
    this.changed(true);
  }

  clearAll() {
    this.item.pipe.steps = [];
    this.editing = null;
    this.res = null;
    this.changed(true);
    this.renderResult();
    this.onShow('data');
  }

  // ---- running -------------------------------------------------------------------------------

  async run() {
    if (!this.steps.length) { this.res = null; this.render(); this.renderResult(); return; }
    this.resultEl.classList.add('loading');
    this.el.classList.add('busy');
    const res = await this.app.engine.pipe(this.item.id).catch((e) => ({ ok: false, error: e.message }));
    this.resultEl.classList.remove('loading');
    this.el.classList.remove('busy');
    this.res = res;
    this.render();
    this.renderResult();
  }

  // The result in the main pane.
  renderResult() {
    const res = this.res;
    if (!res) { fill(this.resultEl, h('div.hint', 'Add a step to see its result here.')); return; }
    if (!res.ok) { fill(this.resultEl, messageBox('error', res.error)); return; }
    const t = res.table;
    const failed = res.failed != null ? this.steps[res.failed] : null;
    const code = this.code();
    fill(this.resultEl,
      h('div.out-head',
        h('span.muted', `${t.nrow} rows × ${t.columns.length} columns${t.nrow > t.rows.length ? ` (showing the first ${t.rows.length})` : ''}`)),
      failed ? messageBox('error', `Step ${res.failed + 1} (${STEP_TYPES[failed.type]?.verb}) did not work:\n${tidyError(res.error)}`,
        h('div.hint', 'Below is the table before that step.')) : null,
      dataTable(t),
      warningsBox(res.warnings),
      code ? section('R code', codeBlock(code), { k: 'pipe-code', open: false }) : null);
  }

  // The steps that run, as one dplyr pipe.
  code() {
    const plan = this.res?.plan || [];
    const steps = this.steps.filter((s, i) => ['run', 'error', 'skipped'].includes(plan[i]?.state) || (!plan[i] && !s.disabled));
    try {
      return transformCode({ rname: 'result', steps }, this.item.rname, this.app.engine.schemaOf(this.item.id));
    } catch {
      return '';
    }
  }

  // ---- making something of the result -----------------------------------------------------------

  // Every step must be set up and work before the result is kept.
  problem(plan) {
    const bad = plan.find((p) => p.state === 'incomplete' || p.state === 'error');
    if (!bad) return null;
    return `Step ${bad.index + 1} ${bad.state === 'error' ? 'does not work' : 'is not set up yet'}. Fix it, turn it off or delete it first.`;
  }

  async toDataTable() {
    const res = await this.app.engine.pipe(this.item.id, { full: true }).catch((e) => ({ ok: false, error: e.message }));
    if (!res.ok) { toast(res.error, 'error', 8000); return; }
    const why = this.problem(res.plan);
    if (why) { toast(why, 'error', 6000); return; }
    let { columns, rows } = res.table;
    let rowNames = res.table.row_names || [];
    // Row names went into R as a row_name column: turn it back into row names.
    const rn = columns.findIndex((c) => c.name === 'row_name');
    if (rn >= 0) {
      rowNames = rows.map((r) => r[rn]);
      columns = columns.filter((_, j) => j !== rn);
      rows = rows.map((r) => r.filter((_, j) => j !== rn));
    }
    const p = this.app.store.project;
    const t = newDataTable(p, {
      name: uniqueName(p, `${this.item.name} (result)`),
      columns: columns.map((c) => ({ name: c.name, type: c.type === 'numeric' ? 'auto' : 'text' })),
      rows, rowNames,
    });
    this.app.added(t);
    toast(`Made the data table "${t.name}" (${rows.length} rows) from the pipeline.`);
  }

  async toTransform() {
    const res = await this.app.engine.pipe(this.item.id).catch((e) => ({ ok: false, error: e.message }));
    if (!res.ok) { toast(res.error, 'error', 8000); return; }
    const why = this.problem(res.plan);
    if (why) { toast(why, 'error', 6000); return; }
    const p = this.app.store.project;
    const t = newTransform(p, this.item.id, clone(this.steps), uniqueName(p, `${this.item.name} (pipeline)`));
    this.app.added(t);
    toast(`Made the transform "${t.name}": it updates when "${this.item.name}" changes.`);
  }

  // ---- the panel -----------------------------------------------------------------------------

  render() {
    this.el.classList.toggle('collapsed', !this.open);
    rebuild(this.el, () => (this.open ? this.panel() : this.strip()));
  }

  strip() {
    const n = this.steps.length;
    return h('button.pipe-strip', {
      type: 'button', 'data-k': 'pipe-open', onclick: () => this.toggle(true),
      title: 'Open the dplyr pipeline: filter, summarise, select… this table without changing it',
    }, icon('layers'), h('span.pipe-strip-label', 'dplyr pipeline'), n ? h('span.pipe-count', String(n)) : null);
  }

  panel() {
    const steps = this.steps;
    const input = this.res?.input || this.app.engine.schemaOf(this.item.id);
    return h('div.pipe-inner',
      h('div.pipe-head',
        icon('layers'), h('span.pipe-title', 'dplyr pipeline'),
        h('span.grow'),
        steps.length ? iconButton('trash', 'Delete all steps', () => this.clearAll(), { k: 'pipe-clear' }) : null,
        iconButton('arrowRight', 'Collapse the pipeline', () => this.toggle(false), { k: 'pipe-close' })),
      h('div.pipe-scroll', { 'data-scroll': 'pipe' },
        h('div.pipe-source', { title: 'The pipeline starts from this table. It never changes the table itself.' },
          h('code', this.item.rname), h('span.grow'), dims(input)),
        h('ol.pipe-steps', steps.map((s, i) => this.stepRow(s, i))),
        h('button.pipe-add', { type: 'button', 'data-k': 'pipe-add', onclick: (e) => this.menu(e.currentTarget) },
          icon('plus'), steps.length ? 'Add a step' : 'Add a first step (filter, summarise, select…)')),
      h('div.pipe-foot',
        button('New data table', () => this.toDataTable(), {
          iconName: 'table', kind: 'primary', k: 'pipe-to-table', disabled: !steps.length,
          title: 'Copy the result into a new data table you can edit',
        }),
        button('Linked transform', () => this.toTransform(), {
          iconName: 'transform', k: 'pipe-to-transform', disabled: !steps.length,
          title: 'Keep these steps as a transform that updates when this table changes',
        })));
  }

  stepRow(step, i) {
    const t = STEP_TYPES[step.type];
    const p = this.res?.plan?.[i];
    const brief = stepBrief(step, this.schemaAt(i));
    const state = step.disabled ? 'off' : brief.incomplete ? 'incomplete' : p?.state || 'run';
    const open = step === this.editing;
    const last = this.steps.length - 1;
    const badge = state === 'off' ? h('span.pipe-dims', 'off')
      : state === 'incomplete' ? h('span.pipe-flag.warn', { title: brief.text }, icon('alert', 14))
        : state === 'error' ? h('span.pipe-flag.bad', { title: tidyError(p.error) }, icon('alert', 14))
          : state === 'skipped' ? h('span.pipe-dims', { title: 'Not run: an earlier step did not work' }, '–')
            : dims(p?.stage);
    const row = h('div.pipe-row', {
      draggable: 'true',
      title: `${t.label}: ${brief.text}\nClick to edit, drag to move.`,
      onclick: () => { this.editing = open ? null : step; this.render(); if (!open) this.onShow('result'); },
      ondragstart: (e) => {
        this.dragFrom = i;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', String(i));
        li.classList.add('dragging');
      },
      ondragend: () => { this.dragFrom = null; this.el.querySelectorAll('.pipe-step').forEach((x) => x.classList.remove('dragging', 'drop-before', 'drop-after')); },
    },
    h('span.grip', { 'aria-hidden': 'true' }, '⋮⋮'),
    h('span.step-n', String(i + 1)),
    h('code.pipe-verb', t.verb),
    h('span.pipe-brief', { class: brief.incomplete ? 'incomplete' : '' }, brief.text),
    badge);
    const li = h('li.pipe-step', {
      class: [state, open ? 'open' : ''].join(' '),
      'data-step': i,
      ondragover: (e) => {
        if (this.dragFrom == null) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const r = li.getBoundingClientRect();
        const after = e.clientY > r.top + r.height / 2;
        this.el.querySelectorAll('.pipe-step').forEach((x) => x.classList.remove('drop-before', 'drop-after'));
        li.classList.add(after ? 'drop-after' : 'drop-before');
      },
      ondrop: (e) => {
        if (this.dragFrom == null) return;
        e.preventDefault();
        const after = li.classList.contains('drop-after');
        const from = this.dragFrom;
        let to = after ? i + 1 : i;
        if (from < to) to -= 1;
        this.dragFrom = null;
        this.move(from, to);
      },
    }, row, open ? h('div.pipe-edit',
      h('div.pipe-edit-bar',
        h('span.pipe-edit-title', t.label),
        h('span.grow'),
        iconButton(step.disabled ? 'eyeOff' : 'eye', step.disabled ? 'Turn this step on' : 'Turn this step off', () => { step.disabled = !step.disabled; this.changed(true); }, { k: `s${i}-onoff` }),
        iconButton('up', 'Move up', () => this.move(i, i - 1), { disabled: i === 0, k: `s${i}-up` }),
        iconButton('down', 'Move down', () => this.move(i, i + 1), { disabled: i === last, k: `s${i}-down` }),
        iconButton('trash', 'Delete step', () => this.remove(i), { k: `s${i}-del` })),
      t.help ? h('div.card-help', t.help) : null,
      h('div.pipe-fields', stepFields(step, i, this.ctx())),
      state === 'error' ? h('div.pipe-err', tidyError(p.error)) : null) : null);
    return li;
  }

  // The "+" menu of verbs, grouped.
  menu(anchor) {
    this.closeMenu?.();
    const close = () => { pop.remove(); document.removeEventListener('mousedown', outside); document.removeEventListener('keydown', esc); this.closeMenu = null; };
    const outside = (e) => { if (!pop.contains(e.target) && !anchor.contains(e.target)) close(); };
    const esc = (e) => { if (e.key === 'Escape') { close(); anchor.focus(); } };
    const pop = h('div.popover.verb-menu', { role: 'menu', 'aria-label': 'Add a step' },
      STEP_GROUPS.map(([group, types]) => [
        h('div.menu-group', group),
        types.map((type) => h('button', {
          type: 'button', role: 'menuitem', 'data-verb': type,
          onclick: () => { close(); this.add(type); },
        }, h('code', STEP_TYPES[type].verb), h('span', STEP_TYPES[type].short))),
      ]));
    document.body.append(pop);
    const r = anchor.getBoundingClientRect();
    const w = Math.min(300, window.innerWidth - 16);
    const left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8));
    const below = r.bottom + 4;
    const top = below + pop.offsetHeight <= window.innerHeight - 8 ? below : Math.max(8, r.top - 4 - pop.offsetHeight);
    Object.assign(pop.style, { left: `${left}px`, top: `${top}px`, width: `${w}px` });
    pop.querySelector('button')?.focus();
    this.closeMenu = close;
    setTimeout(() => { document.addEventListener('mousedown', outside); document.addEventListener('keydown', esc); }, 0);
  }
}

function dims(schema) {
  if (!schema) return null;
  return h('span.pipe-dims', { title: `${schema.nrow} rows × ${schema.columns.length} columns` }, `${schema.nrow} × ${schema.columns.length}`);
}

// dplyr's errors come as "In argument: … Caused by error: ! what went wrong".
function tidyError(msg) {
  const text = String(msg || '');
  const cause = text.match(/Caused by error[^\n]*:\s*\n?!\s*([\s\S]*)$/);
  const where = text.match(/In argument: `([^`]*)`/);
  return (cause ? `${cause[1].trim()}${where ? ` (in ${where[1]})` : ''}` : text.replace(/^!\s*/, '')).trim();
}
