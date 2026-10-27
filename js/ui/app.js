// The application shell: top bar, navigator, the open item, and creating /
// opening / saving things.
import { h, fill, icon, rebuild, download, pickFile, safeFilename } from './dom.js';
import { button, iconButton, select, modal, toast, field, input } from './widgets.js';
import {
  KINDS, itemsOf, getItem, assignRName, depsOf, dependentsOf, removeItem, clone, newId, uniqueName,
  newDataTable, newTransform, newAnalysis, datasets, emptyProject,
} from '../model.js';
import { exampleProject } from '../example.js';
import { ABOUT, CITATION, AI_CREDIT } from '../about.js';
import { parseDelimited, tableFromRows } from '../codegen/data.js';
import { TESTS, TEST_CATEGORIES } from '../codegen/stats.js';
import { projectScript } from '../codegen/script.js';
import { DataView } from './dataView.js';
import { TransformView } from './transformView.js';
import { GraphView } from './graphView.js';
import { StatsView, autofillAnalysis } from './statsView.js';
import { CodeView } from './codeView.js';
import { GRAPH_TEMPLATES, thumb, graphFromTemplate } from './templates.js';

const KIND_ICON = { data: 'table', transform: 'transform', analysis: 'stats', graph: 'graph' };
const R_DATASETS = [
  ['PlantGrowth', 'PlantGrowth: plant weight in 3 groups'], ['ToothGrowth', 'ToothGrowth: supplement × dose'],
  ['sleep', 'sleep: paired drug comparison'], ['ChickWeight', 'ChickWeight: chick weights over time, 4 diets'],
  ['CO2', 'CO2: plant CO2 uptake (repeated measures)'], ['InsectSprays', 'InsectSprays: insect counts, 6 sprays'],
  ['warpbreaks', 'warpbreaks: wool × tension'], ['chickwts', 'chickwts: chick weight by feed'],
  ['Puromycin', 'Puromycin: enzyme kinetics'], ['DNase', 'DNase: ELISA dose-response'],
  ['iris', 'iris: flower measurements'], ['mtcars', 'mtcars: car data'], ['airquality', 'airquality: New York air quality'],
];

export class App {
  constructor(root, store, engine) {
    this.root = root;
    this.store = store;
    this.engine = engine;
    this.view = null;
    this.build();
    store.addEventListener('load', () => { this.renderNav(); this.mount(); });
    store.addEventListener('select', () => { this.renderNav(); this.mount(); });
    store.addEventListener('change', (e) => {
      if (e.detail.structural) this.renderNav();
      this.view?.onChange?.(e.detail);
    });
    store.addEventListener('history', () => this.updateHistoryButtons());
    engine.addEventListener('status', (e) => this.updateStatus(e.detail));
    engine.addEventListener('result', (e) => {
      this.updateNavStatus(e.detail.id);
      this.view?.onResult?.(e.detail);
    });
    document.addEventListener('keydown', (e) => this.onKey(e));
  }

  // ---- layout ---------------------------------------------------------------------------

  build() {
    this.status = h('button.rstatus', { type: 'button', title: 'R status', onclick: () => this.statusClick() }, h('span.dot'), h('span.text', 'R is starting…'));
    this.projectName = input(this.store.project.name, (v) => { this.store.project.name = v; this.store.change(); }, { k: 'project-name' });
    this.projectName.classList.add('project-name');
    this.projectName.setAttribute('aria-label', 'Project name');
    this.undoBtn = iconButton('undo', 'Undo (Ctrl+Z)', () => this.store.undo());
    this.redoBtn = iconButton('redo', 'Redo (Ctrl+Shift+Z)', () => this.store.redo());
    const top = h('header.topbar',
      iconButton('menu', 'Show or hide the project panel', () => this.root.classList.toggle('nav-open'), { cls: 'nav-toggle' }),
      h('div.brand', h('img.logo', { src: 'assets/icon.svg', alt: '', width: 30, height: 30 }), h('span', 'Agrafeuse')),
      this.projectName,
      h('span.grow'),
      button('New', () => this.newProject(), { iconName: 'file', title: 'Start a new project' }),
      button('Open', () => this.openFile(), { iconName: 'folder', title: 'Open an .RData project, an .RData file from R, or a CSV' }),
      button('Save .RData', () => this.saveRData(), { iconName: 'save', kind: 'primary', title: 'Save everything as an .RData file (Ctrl+S)' }),
      this.undoBtn, this.redoBtn,
      this.status);
    this.nav = h('nav.nav', { 'aria-label': 'Project' });
    this.main = h('main.main');
    fill(this.root, top, this.nav, this.main, this.footer());
    this.updateHistoryButtons();
  }

  // Citation and attribution. Copies and modified versions must keep this
  // notice (GNU AGPL v3 section 7(b); see NOTICE).
  footer() {
    const link = (href, text) => h('a', { href, target: '_blank', rel: 'noopener' }, text);
    const citeText = h('span.cite-text', CITATION);
    const copy = () => {
      const fallback = () => {
        window.getSelection().selectAllChildren(citeText);
        toast('Copying is blocked here; the citation is selected, so press Ctrl+C or ⌘C.');
      };
      try { navigator.clipboard.writeText(CITATION).then(() => toast('Citation copied.'), fallback); } catch { fallback(); }
    };
    return h('footer.site-foot',
      h('p.cite', h('strong', 'How to cite: '), `if ${ABOUT.name} contributed to your work, please cite `, citeText, ' ',
        h('button.btn.btn-small', { type: 'button', onclick: copy }, 'Copy citation')),
      h('p.lab', `${ABOUT.name} is made by the Misra Lab. Want to see what else we do? Visit `, link(ABOUT.lab, 'misralab.ca'), '. ',
        AI_CREDIT),
      h('p.legal', 'For research use only, not for diagnostic procedures. Provided as is, without warranty. ',
        'Statistics are computed by R; please also cite R and the R packages your analysis used (listed in its R code). ',
        'Not affiliated with or endorsed by GraphPad Software. Free software under the ', link(ABOUT.license, 'GNU AGPL v3'), '; ',
        link(ABOUT.url, 'source code'), '. Your data stays on your computer.'));
  }

  renderNav() {
    const p = this.store.project;
    if (document.activeElement !== this.projectName) this.projectName.value = p.name;
    rebuild(this.nav, () => h('div.nav-inner',
      Object.entries(KINDS).map(([kind, meta]) => h('section.nav-sec',
        h('div.nav-head', h('span', meta.label),
          iconButton('plus', `New ${meta.one.toLowerCase()}`, () => this.create(kind), { k: `new-${kind}` })),
        h('ul', itemsOf(p, kind).map((it) => this.navItem(it)),
          itemsOf(p, kind).length ? null : h('li.empty', h('button.link', { type: 'button', onclick: () => this.create(kind) }, `+ New ${meta.one.toLowerCase()}`))))),
      h('div.nav-foot',
        h('button.nav-item', { type: 'button', class: this.store.selected === '__code' ? 'on' : '', onclick: () => this.store.select('__code') },
          icon('code'), h('span.name', 'Whole project as R code')))));
  }

  navItem(it) {
    const r = this.engine.result(it.id);
    const bad = r && !r.ok && !r.incomplete;
    return h('li', { 'data-id': it.id },
      h('button.nav-item', {
        type: 'button', class: it.id === this.store.selected ? 'on' : '', 'data-k': `nav-${it.id}`,
        onclick: () => { this.store.select(it.id); this.root.classList.remove('nav-open'); },
        title: bad ? r.error : it.name,
      }, icon(KIND_ICON[it.kind]), h('span.name', it.name), h('span.state', { class: bad ? 'bad' : '' })),
      iconButton('menu', `Actions for ${it.name}`, (e) => this.itemMenu(it, e.currentTarget), { cls: 'item-menu' }));
  }

  updateNavStatus(id) {
    const li = this.nav.querySelector(`li[data-id="${CSS.escape(id)}"]`);
    if (!li) return;
    const r = this.engine.result(id);
    const bad = r && !r.ok && !r.incomplete;
    li.querySelector('.state')?.classList.toggle('bad', !!bad);
    li.querySelector('.nav-item').title = bad ? r.error : getItem(this.store.project, id)?.name || '';
  }

  mount() {
    this.view?.destroy?.();
    const id = this.store.selected;
    const it = id && id !== '__code' ? getItem(this.store.project, id) : null;
    if (id === '__code') this.view = new CodeView(this);
    else if (!it) this.view = { el: this.welcome() };
    else if (it.kind === 'data') this.view = new DataView(this, it);
    else if (it.kind === 'transform') this.view = new TransformView(this, it);
    else if (it.kind === 'analysis') this.view = new StatsView(this, it);
    else this.view = new GraphView(this, it);
    fill(this.main, this.view.el);
  }

  welcome() {
    return h('div.view.welcome',
      h('img', { src: 'assets/icon.svg', alt: '', width: 120, height: 120 }),
      h('h1', 'Agrafeuse'),
      h('p.lead', 'Graphs and statistics with R, in your browser. Your data never leaves this computer.'),
      h('div.welcome-actions',
        button('New data table', () => this.create('data'), { iconName: 'table', kind: 'primary' }),
        button('Open a file', () => this.openFile(), { iconName: 'folder' }),
        button('Load the example project', () => this.store.load(exampleProject()), { iconName: 'spark' })));
  }

  updateStatus({ state, text }) {
    this.status.className = `rstatus ${state}`;
    this.status.querySelector('.text').textContent = state === 'ready' ? 'R ready' : state === 'busy' ? 'Running…' : text;
    this.status.title = text;
  }

  statusClick() {
    if (this.engine.state !== 'error') { toast(this.engine.statusText); return; }
    this.engine.start().then(() => this.mount()).catch(() => toast(this.engine.statusText, 'error', 8000));
  }

  updateHistoryButtons() {
    this.undoBtn.disabled = !this.store.history.length && this.store.snapshot === JSON.stringify(this.store.project);
    this.redoBtn.disabled = !this.store.future.length;
  }

  // ---- helpers views call ----------------------------------------------------------------

  renameItem(item) {
    assignRName(this.store.project, item);
    this.store.change(item.id, { structural: true });
  }

  // Does item `id` (directly or indirectly) feed into item `target`?
  isUpstream(id, target) {
    const p = this.store.project;
    const seen = new Set();
    const walk = (t) => {
      const it = getItem(p, t);
      if (!it || seen.has(t)) return false;
      seen.add(t);
      return depsOf(it).some((d) => d === id || walk(d));
    };
    return walk(target);
  }

  // The long version of a one-column-per-group table (made if it doesn't exist yet).
  longVersion(tableId, columns) {
    const p = this.store.project;
    const found = itemsOf(p, 'transform').find((t) => t.input === tableId && t.steps.length === 1 && t.steps[0].type === 'pivot_longer'
      && t.steps[0].names_to === 'group' && t.steps[0].values_to === 'value' && JSON.stringify(t.steps[0].cols) === JSON.stringify(columns));
    if (found) return found;
    const src = getItem(p, tableId);
    const t = newTransform(p, tableId, [{ type: 'pivot_longer', cols: columns, names_to: 'group', values_to: 'value', drop_na: true }], uniqueName(p, `${src.name} (long)`));
    this.store.change(t.id, { structural: true });
    return t;
  }

  // A sensible new graph for an analysis's data.
  graphForAnalysis(a) {
    const p = this.store.project;
    const t = TESTS[a.test];
    let opts;
    let template = 'scatter_dot';
    if (t.inputs.x) {
      opts = { dataset: a.dataset, x: a.x, y: a.y };
      template = a.test === 'correlation' ? 'xy' : 'blank';
    } else if (t.inputs.layout && a.layout === 'columns') {
      const cols = t.inputs.two ? a.groups : a.columns;
      opts = { dataset: this.longVersion(a.dataset, cols).id, x: 'group', y: 'value' };
    } else if (a.test === 'anova2') {
      const withinA = (a.options?.scope || 'A_within_B') === 'A_within_B';
      opts = { dataset: a.dataset, x: withinA ? a.factorB : a.group, y: a.y, group: withinA ? a.group : a.factorB };
      template = 'grouped_bars';
    } else if (a.test === 'mixed') {
      const by = a.options?.by;
      opts = by ? { dataset: a.dataset, x: by, y: a.y, group: a.fixed[0] } : { dataset: a.dataset, x: a.fixed[0], y: a.y };
      template = by ? 'grouped_bars' : 'scatter_dot';
    } else {
      opts = { dataset: a.dataset, x: a.group, y: a.y };
    }
    const g = graphFromTemplate(p, template, { ...opts, name: uniqueName(p, `${a.name} graph`) });
    if (template === 'blank') {
      g.layers.push({ id: `l${Date.now().toString(36)}`, geom: 'point', dataset: opts.dataset, aes: { x: { mode: 'col', col: opts.x }, y: { mode: 'col', col: opts.y } }, params: {} });
      if (a.options?.model === '4pl' && !a.options?.logx) g.x_scale = { trans: 'log10', min: '', max: '', from_zero: false };
    }
    return g;
  }

  // ---- creating things -----------------------------------------------------------------------

  create(kind) {
    if (kind === 'data') return this.newDataDialog();
    if (kind === 'transform') return this.newTransformDialog();
    if (kind === 'analysis') return this.newAnalysisDialog();
    return this.newGraphDialog();
  }

  added(item) {
    this.store.change(item.id, { structural: true });
    this.store.select(item.id);
  }

  async newDataDialog() {
    const p = this.store.project;
    const card = (key, title, desc, close) => h('button.choice', { type: 'button', onclick: () => close(key) }, h('b', title), h('span', desc));
    let rName = 'PlantGrowth';
    const choice = await modal({
      title: 'New data table',
      body: (close) => h('div.choices',
        card('column', 'Column table', 'One column per group, like Prism. For t tests and one-way ANOVA.', close),
        card('xy', 'XY table', 'An X column and a Y column. For correlation, regression and curves.', close),
        card('long', 'Long table', 'One row per measurement, with a column for each factor. For two-way ANOVA and mixed models.', close),
        card('import', 'Import a file', 'CSV or TSV (save Excel sheets as CSV, or just paste into a table).', close),
        h('div.choice.with-select', h('b', 'An example dataset from R'),
          select(rName, R_DATASETS, (v) => { rName = v; }, { k: 'rdataset' }),
          button('Use it', () => close('r'), { kind: 'primary' }))),
    });
    if (!choice) return;
    let item;
    if (choice === 'column') item = newDataTable(p, { columns: [{ name: 'Control', type: 'auto' }, { name: 'Treated', type: 'auto' }, { name: 'Group C', type: 'auto' }] });
    else if (choice === 'xy') item = newDataTable(p, { columns: [{ name: 'X', type: 'auto' }, { name: 'Y', type: 'auto' }] });
    else if (choice === 'long') item = newDataTable(p, { columns: [{ name: 'subject', type: 'text' }, { name: 'group', type: 'text' }, { name: 'value', type: 'auto' }] });
    else if (choice === 'import') {
      const file = await pickFile('.csv,.tsv,.txt');
      if (!file) return;
      item = this.tableFromText(await file.text(), file.name);
      if (!item) return;
    } else {
      try {
        const t = await this.engine.rDataset(rName);
        item = newDataTable(p, {
          name: uniqueName(p, rName),
          columns: t.columns.map((c) => ({ name: c.name, type: c.type === 'numeric' ? 'auto' : 'text' })),
          rows: t.rows,
        });
      } catch (e) { toast(`Could not load ${rName}: ${e.message}`, 'error'); return; }
    }
    this.added(item);
  }

  tableFromText(text, filename) {
    const rows = parseDelimited(text);
    if (!rows.length) { toast('That file looks empty.', 'error'); return null; }
    const t = tableFromRows(rows[0], rows.slice(1));
    const p = this.store.project;
    toast(`Imported ${t.rows.length} rows from ${filename}.`);
    return newDataTable(p, { name: uniqueName(p, filename.replace(/\.[^.]+$/, '')), ...t });
  }

  async newTransformDialog(inputId) {
    const p = this.store.project;
    const sources = datasets(p);
    if (!sources.length) { toast('Make a data table first.', 'error'); return; }
    let input = inputId || this.currentDataset() || sources[0].id;
    const ok = await modal({
      title: 'New transform',
      body: h('div', h('p', 'A transform takes a dataset and reshapes, filters or calculates from it. The original stays untouched.'),
        field('Start from', select(input, sources.map((d) => [d.id, d.name]), (v) => { input = v; }, { k: 'tr-input' }))),
      actions: [{ label: 'Cancel', value: () => null }, { label: 'Create', kind: 'primary', value: () => true }],
    });
    if (!ok) return;
    const schema = this.engine.schemaOf(input);
    const nums = (schema?.columns || []).filter((c) => c.type === 'numeric').map((c) => c.name);
    const facs = (schema?.columns || []).filter((c) => c.type !== 'numeric');
    const steps = nums.length >= 2 && !facs.length ? [{ type: 'pivot_longer', cols: nums, names_to: 'group', values_to: 'value', drop_na: true }] : [];
    const src = getItem(p, input);
    this.added(newTransform(p, input, steps, uniqueName(p, `${src.name} (${steps.length ? 'long' : 'transformed'})`)));
  }

  currentDataset() {
    const it = this.store.item();
    if (!it) return null;
    if (it.kind === 'data' || it.kind === 'transform') return it.id;
    if (it.kind === 'analysis') return it.dataset;
    if (it.kind === 'graph') return it.layers.find((l) => l.dataset)?.dataset;
    return null;
  }

  async newAnalysisDialog(datasetId) {
    const p = this.store.project;
    const sources = datasets(p);
    if (!sources.length) { toast('Make a data table first.', 'error'); return; }
    let ds = datasetId || this.currentDataset() || sources[0].id;
    const choice = await modal({
      title: 'New analysis',
      wide: true,
      body: (close) => h('div',
        field('Data', select(ds, sources.map((d) => [d.id, d.name]), (v) => { ds = v; }, { k: 'an-ds' })),
        h('div.test-list', TEST_CATEGORIES.map((cat) => h('div.test-cat', h('h4', cat),
          Object.entries(TESTS).filter(([, t]) => t.category === cat).map(([key, t]) =>
            h('button.choice', { type: 'button', onclick: () => close(key), 'data-k': `test-${key}` }, h('b', t.label), h('span', t.short))))))),
    });
    if (!choice) return;
    await this.engine.ensure(ds).catch(() => {});
    const a = newAnalysis(p, choice, ds);
    autofillAnalysis(a, this.engine.schemaOf(ds));
    this.added(a);
  }

  async newGraphDialog(datasetId) {
    const p = this.store.project;
    const sources = datasets(p);
    if (!sources.length) { toast('Make a data table first.', 'error'); return; }
    const state = { template: 'scatter_dot', dataset: datasetId || this.currentDataset() || sources[0].id, x: '', y: '', group: '' };
    const prefill = () => {
      const s = this.engine.schemaOf(state.dataset);
      const cols = s?.columns || [];
      const nums = cols.filter((c) => c.type === 'numeric').map((c) => c.name);
      const facs = cols.filter((c) => c.type !== 'numeric').map((c) => c.name);
      const t = GRAPH_TEMPLATES.find((x) => x.key === state.template);
      state.wide = nums.length >= 2 && !facs.length && !t.numericX && t.needs.includes('x');
      if (state.wide) { state.x = 'group'; state.y = 'value'; state.group = ''; return; }
      state.x = t.numericX ? nums[0] || '' : facs[0] || nums[0] || '';
      state.y = nums.find((n) => n !== state.x) || '';
      state.group = facs.find((f) => f !== state.x) || '';
    };
    await this.engine.ensure(state.dataset).catch(() => {});
    prefill();
    const result = await modal({
      title: 'New graph',
      wide: true,
      body: (close) => {
        const host = h('div');
        const draw = () => {
          const s = this.engine.schemaOf(state.dataset);
          const cols = (s?.columns || []).map((c) => [c.name, c.name]);
          const t = GRAPH_TEMPLATES.find((x) => x.key === state.template);
          fill(host, 
            h('div.gallery', GRAPH_TEMPLATES.map((tp) => h('button.tpl', {
              type: 'button', class: tp.key === state.template ? 'on' : '', 'data-k': `tpl-${tp.key}`,
              onclick: () => { state.template = tp.key; prefill(); draw(); },
            }, h('span.thumb', { html: thumb(tp) }), h('b', tp.label), h('span', tp.desc)))),
            h('div.row3',
              field('Data', select(state.dataset, sources.map((d) => [d.id, d.name]), async (v) => {
                state.dataset = v; await this.engine.ensure(v).catch(() => {}); prefill(); draw();
              }, { k: 'g-ds' })),
              state.wide ? null : t.needs.includes('x') || t.key === 'time_course' ? field('X', select(state.x, cols, (v) => { state.x = v; }, { k: 'g-x', placeholder: 'Choose…' })) : null,
              state.wide ? null : t.needs.includes('y') ? field(t.key === 'histogram' ? 'Values' : 'Y', select(state.y, cols, (v) => { state.y = v; }, { k: 'g-y', placeholder: 'Choose…' })) : null,
              state.wide ? null : t.needs.includes('group') || t.optional?.includes('group') ? field(t.key === 'grouped_bars' ? 'Groups side by side' : 'Lines by (optional)', select(state.group, cols, (v) => { state.group = v; }, { k: 'g-group', placeholder: '(none)' })) : null),
            state.wide ? h('div.hint', 'This table has one column per group, so the graph will use its long version (a "group" and a "value" column), which Agrafeuse creates for you.') : null,
            h('div.modal-actions', button('Cancel', () => close(null)), button('Create graph', () => close(state), { kind: 'primary', k: 'create-graph' })));
        };
        draw();
        return host;
      },
    });
    if (!result) return;
    let ds = result.dataset;
    if (result.wide) {
      const nums = this.engine.schemaOf(ds).columns.filter((c) => c.type === 'numeric').map((c) => c.name);
      ds = this.longVersion(ds, nums).id;
    }
    const g = graphFromTemplate(p, result.template, { dataset: ds, x: result.x, y: result.y, group: result.group || '', name: uniqueName(p, `${getItem(p, result.dataset).name} graph`) });
    this.added(g);
  }

  // ---- item menu --------------------------------------------------------------------------------

  itemMenu(it, anchor) {
    document.querySelector('.popover')?.remove();
    const close = () => { pop.remove(); document.removeEventListener('mousedown', outside); };
    const outside = (e) => { if (!pop.contains(e.target)) close(); };
    const pop = h('div.popover', { role: 'menu' },
      h('button', { type: 'button', role: 'menuitem', onclick: () => { close(); this.duplicate(it); } }, icon('copy'), 'Duplicate'),
      h('button', { type: 'button', role: 'menuitem', class: 'danger', onclick: () => { close(); this.remove(it); } }, icon('trash'), 'Delete'));
    const r = anchor.getBoundingClientRect();
    Object.assign(pop.style, { top: `${r.bottom + 4}px`, left: `${Math.min(r.left, window.innerWidth - 180)}px` });
    document.body.append(pop);
    setTimeout(() => document.addEventListener('mousedown', outside), 0);
  }

  duplicate(it) {
    const p = this.store.project;
    const c = clone(it);
    c.id = newId(p, it.kind);
    c.name = uniqueName(p, `${it.name} copy`);
    assignRName(p, c);
    p.items.splice(p.items.indexOf(it) + 1, 0, c);
    this.added(c);
  }

  async remove(it) {
    const p = this.store.project;
    const users = dependentsOf(p, it.id).map((id) => getItem(p, id)?.name).filter(Boolean);
    const ok = await modal({
      title: `Delete "${it.name}"?`,
      body: h('p', users.length ? `These use it and will need another source: ${users.join(', ')}.` : 'You can undo this with Ctrl+Z.'),
      actions: [{ label: 'Cancel', value: () => null }, { label: 'Delete', kind: 'danger', value: () => true }],
    });
    if (!ok) return;
    removeItem(p, it.id);
    if (this.store.selected === it.id) this.store.selected = p.items[0]?.id || null;
    this.store.change(null, { structural: true });
    this.mount();
  }

  // ---- files -------------------------------------------------------------------------------------

  async newProject() {
    const choice = await modal({
      title: 'New project',
      body: h('p', 'This replaces the project open now. Save it as .RData first if you want to keep it (you can also undo with Ctrl+Z).'),
      actions: [{ label: 'Cancel', value: () => null }, { label: 'Example project', value: () => 'example' }, { label: 'Blank project', kind: 'primary', value: () => 'blank' }],
    });
    if (!choice) return;
    this.store.takeSnapshot();
    const prev = this.store.snapshot;
    this.store.load(choice === 'example' ? exampleProject() : emptyProject(), { keepHistory: true, select: null });
    if (prev) { this.store.history.push(prev); this.updateHistoryButtons(); }
  }

  async openFile() {
    const file = await pickFile('.RData,.rdata,.rda,.csv,.tsv,.txt,.json');
    if (!file) return;
    const name = file.name.toLowerCase();
    try {
      if (/\.(csv|tsv|txt)$/.test(name)) {
        const item = this.tableFromText(await file.text(), file.name);
        if (item) this.added(item);
        return;
      }
      if (name.endsWith('.json')) {
        const proj = JSON.parse(await file.text());
        if (proj.format !== 'agrafeuse') throw new Error('Not a Agrafeuse project file.');
        this.loadProject(proj);
        return;
      }
      toast('Reading the .RData file…');
      const out = await this.engine.loadRData(new Uint8Array(await file.arrayBuffer()));
      if (out.project) {
        this.loadProject(out.project);
        toast(`Opened "${out.project.name}".`);
        return;
      }
      const frames = Object.entries(out.frames);
      if (!frames.length) { toast(`No data frames found in ${file.name} (it has: ${out.objects.join(', ') || 'nothing'}).`, 'error', 8000); return; }
      const p = this.store.project;
      let last;
      for (const [nm, t] of frames) {
        last = newDataTable(p, { name: uniqueName(p, nm), columns: t.columns.map((c) => ({ name: c.name, type: c.type === 'numeric' ? 'auto' : 'text' })), rows: t.rows });
      }
      this.added(last);
      toast(`Added ${frames.length} data table${frames.length > 1 ? 's' : ''} from ${file.name}.`);
    } catch (e) {
      toast(`Could not open ${file.name}: ${e.message}`, 'error', 8000);
    }
  }

  loadProject(proj) {
    this.store.takeSnapshot();
    const prev = this.store.snapshot;
    this.engine.reset();
    this.store.load(proj, { keepHistory: true, select: null });
    if (prev) { this.store.history.push(prev); this.updateHistoryButtons(); }
  }

  async saveRData() {
    try {
      toast('Saving… (running everything once in R)');
      const bytes = await this.engine.saveRData();
      download(bytes, safeFilename(this.store.project.name, 'RData'));
    } catch (e) {
      toast(`Save failed: ${e.message}`, 'error', 8000);
    }
  }

  exportScript() {
    const code = projectScript(this.store.project, { helpers: this.engine.helpers, schemaOf: this.engine.schemaOf, mixedEngine: this.engine.mixedChoice || 'lme4' });
    download(code, safeFilename(this.store.project.name, 'R'), 'text/plain');
  }

  onKey(e) {
    const mod = e.ctrlKey || e.metaKey;
    if (!mod) return;
    const inText = e.target.closest('input, textarea, select, [contenteditable]');
    if (e.key === 's' || e.key === 'S') { e.preventDefault(); this.saveRData(); return; }
    if (inText) return;
    if ((e.key === 'z' || e.key === 'Z') && !e.shiftKey) { e.preventDefault(); this.store.undo(); }
    else if (((e.key === 'z' || e.key === 'Z') && e.shiftKey) || e.key === 'y') { e.preventDefault(); this.store.redo(); }
  }
}
