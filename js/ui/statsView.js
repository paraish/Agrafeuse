// An analysis: choose a test and the data, read the results, put them on a graph.
import { h, fill, rebuild, debounce, icon } from './dom.js';
import {
  field, select, bindSelect, bindInput, bindCheck, multiCheck, segmented, button, columnOptions,
  levelsOf, dataTable, section, codeBlock, messageBox, modal, toast,
} from './widgets.js';
import { itemHeader, warningsBox } from './common.js';
import { TESTS, TEST_CATEGORIES, testDefaults, normaliseCorrection } from '../codegen/stats.js';
import { datasets, itemsOf, getItem } from '../model.js';

// Sensible first choices for an analysis, based on the dataset's columns.
export function autofillAnalysis(a, s) {
  if (!s) return;
  const nums = s.columns.filter((c) => c.type === 'numeric').map((c) => c.name);
  const facs = s.columns.filter((c) => c.type !== 'numeric').map((c) => c.name);
  const t = TESTS[a.test];
  a.layout = t.inputs.layout && nums.length >= 2 && !facs.length ? 'columns' : 'long';
  a.columns = nums;
  a.groups = a.layout === 'columns' ? nums.slice(0, 2) : [];
  a.y = nums.find((n) => !/^(id|subject)$/i.test(n)) || '';
  a.x = '';
  if (t.inputs.x) { a.x = nums[0] || ''; a.y = nums[1] || ''; }
  a.subject = s.columns.find((c) => /subject|^id$|row_name|mouse|animal|patient|participant|donor|rat|individual/i.test(c.name))?.name || '';
  const groups = facs.filter((f) => f !== a.subject);
  a.group = groups[0] || '';
  a.factorB = groups[1] || '';
  if (a.layout === 'long' && a.group) a.groups = levelsOf(s, a.group).slice(0, 2);
  a.fixed = groups.slice(0, 2);
  a.random = a.subject ? [a.subject] : [];
}

export class StatsView {
  constructor(app, item) {
    this.app = app;
    this.item = item;
    this.el = h('div.view.split.stats-view');
    this.left = h('div.pane.controls', { 'data-scroll': 'controls' });
    this.right = h('div.pane.output');
    this.el.append(this.left, this.right);
    this.refresh = debounce(() => this.run(), 350);
    this.render();
    this.run();
  }

  destroy() { this.refresh.cancel(); }

  onChange({ id }) {
    if (!id || id === this.item.id || this.app.isUpstream(id, this.item.id)) this.refresh();
  }

  onResult({ id }) {
    if (id === this.item.dataset) {
      const sig = JSON.stringify(this.app.engine.schemaOf(id)?.columns);
      if (sig !== this.sig) { this.sig = sig; this.render(); }
    }
  }

  changed(structural = false) {
    this.app.store.change(this.item.id);
    if (structural) this.render();
  }

  render() {
    rebuild(this.left, () => this.controls());
  }

  schema() {
    return this.app.engine.schemaOf(this.item.dataset);
  }

  autofill() {
    autofillAnalysis(this.item, this.schema());
  }

  controls() {
    const a = this.item;
    const t = TESTS[a.test];
    const p = this.app.store.project;
    const testOptions = TEST_CATEGORIES.map((cat) => ({ group: cat, options: Object.entries(TESTS).filter(([, x]) => x.category === cat).map(([k, x]) => [k, x.label]) }));
    const about = h('details.about', { open: true }, h('summary', icon('info', 14), ' About this test'),
      t.explain.split('\n\n').map((para) => h('p', para.split('\n').map((line, i) => [i ? h('br') : null, line]))));
    const ds = field('Data', bindSelect(a, 'dataset', datasets(p).map((d) => [d.id, d.name]), () => {
      if (this.schema()) this.autofill(); else this.app.engine.ensure(a.dataset).then(() => { this.autofill(); this.changed(true); });
      this.changed(true);
    }, { placeholder: 'Choose a dataset…', k: 'dataset' }));
    return h('div',
      itemHeader(this.app, a, 'Analysis'),
      field('Test', select(a.test, testOptions, (v) => {
        const wasAuto = a.name === TESTS[a.test].label || a.name.startsWith(`${TESTS[a.test].label} `);
        a.test = v;
        a.options = { ...testDefaults(v) };
        if (wasAuto) { a.name = TESTS[v].label; this.app.renameItem(a); }
        if (this.schema()) this.autofill();
        this.changed(true);
      }, { k: 'test' })),
      about,
      ds,
      a.dataset ? this.inputs() : h('div.hint', 'Choose the data to analyse.'),
      a.dataset ? this.options() : null);
  }

  inputs() {
    const a = this.item;
    const t = TESTS[a.test];
    const s = this.schema();
    if (!s) return h('div.hint', 'Reading the columns of this dataset…');
    const all = columnOptions(s);
    const nums = columnOptions(s, { types: ['numeric'] });
    const ch = (st) => () => this.changed(st);
    const out = [];
    if (t.inputs.layout) {
      out.push(field('How is the data laid out?', segmented([
        ['columns', 'One column per group', 'Each column is a group'],
        ['long', 'Values + group columns', 'One row per value, with a column naming its group'],
      ], a.layout, (v) => { a.layout = v; this.changed(true); }, { k: 'layout' })));
    }
    const columnsLayout = t.inputs.layout && a.layout === 'columns';
    if (columnsLayout) {
      if (t.inputs.two) {
        a.groups = a.groups || [];
        out.push(h('div.row2',
          field('First group', select(a.groups[0] || '', nums, (v) => { a.groups[0] = v; this.changed(); }, { placeholder: 'Choose…', k: 'g1' })),
          field('Second group', select(a.groups[1] || '', nums, (v) => { a.groups[1] = v; this.changed(); }, { placeholder: 'Choose…', k: 'g2' }))));
        if (t.inputs.subject) out.push(h('div.hint', 'Each row is one subject (the two values in a row are a pair).'));
      } else if (t.inputs.oneGroup) {
        out.push(field('Column', select(a.columns?.[0] || '', nums, (v) => { a.columns = [v]; this.changed(); }, { placeholder: 'Choose…', k: 'col1' })));
      } else {
        out.push(field('Groups (columns)', multiCheck(nums, a.columns, (v) => { a.columns = v; this.changed(); }, { k: 'cols' })));
        if (t.inputs.subject) out.push(h('div.hint', 'Each row is one subject, measured in every column.'));
      }
      return out;
    }
    if (t.inputs.x) out.push(field('X', bindSelect(a, 'x', nums, ch(), { placeholder: 'Choose a number column…', k: 'x' })));
    if (t.inputs.y) out.push(field(t.inputs.x ? 'Y' : 'Values (Y)', bindSelect(a, 'y', nums, ch(), { placeholder: 'Choose a number column…', k: 'y' })));
    if (t.inputs.group) {
      const label = t.inputs.factorB ? 'Factor A' : t.inputs.group === 'optional' ? 'Groups (optional)' : 'Groups';
      out.push(field(label, bindSelect(a, 'group', all.filter(([n]) => n !== a.y), () => {
        a.groups = levelsOf(s, a.group).slice(0, 2);
        this.changed(true);
      }, { placeholder: t.inputs.group === 'optional' ? '(all values together)' : 'Choose a column…', k: 'group' })));
    }
    if (t.inputs.factorB) out.push(field('Factor B', bindSelect(a, 'factorB', all.filter(([n]) => n !== a.y && n !== a.group), ch(true), { placeholder: 'Choose a column…', k: 'factorB' })));
    if (t.inputs.two && a.group) {
      const lv = levelsOf(s, a.group).map((l) => [l, l]);
      a.groups = a.groups || [];
      out.push(h('div.row2',
        field('First group', select(a.groups[0] || '', lv, (v) => { a.groups[0] = v; this.changed(); }, { placeholder: 'Choose…', k: 'lv1' })),
        field('Second group', select(a.groups[1] || '', lv, (v) => { a.groups[1] = v; this.changed(); }, { placeholder: 'Choose…', k: 'lv2' }))));
    }
    if (t.inputs.oneGroup && a.group) {
      out.push(field('Which group', bindSelect(a, 'oneLevel', levelsOf(s, a.group).map((l) => [l, l]), ch(), { placeholder: '(all values)', k: 'onelevel' })));
    }
    if (t.inputs.subject) {
      out.push(field('Subject ID', bindSelect(a, 'subject', all.filter(([n]) => n !== a.y && n !== a.group), ch(), { placeholder: 'Choose the column that identifies each subject…', k: 'subject' }),
        { hint: 'Values with the same ID were measured on the same subject (or are a matched set).' }));
    }
    if (t.inputs.fixed) {
      out.push(field('Fixed effects (what you are testing)', multiCheck(all.filter(([n]) => n !== a.y), a.fixed, (v) => { a.fixed = v; this.changed(true); }, { k: 'fixed' }),
        { hint: 'The first one ticked is the one compared in the multiple comparisons. Numbers are treated as groups.' }));
      out.push(field('Random effects (clusters)', multiCheck(all.filter(([n]) => n !== a.y && !(a.fixed || []).includes(n)), a.random, (v) => { a.random = v; this.changed(); }, { k: 'random' }),
        { hint: 'e.g. subject, litter, culture, batch: groups of measurements that are related to each other.' }));
    }
    return out;
  }

  options() {
    const a = this.item;
    const t = TESTS[a.test];
    const s = this.schema();
    a.options = a.options || testDefaults(a.test);
    const o = a.options;
    const ch = (st) => () => this.changed(st);
    const rows = [];
    for (const opt of t.options) {
      if (opt.showIf && !opt.showIf(o)) continue;
      const k = `opt-${opt.key}`;
      if (opt.type === 'bool') { rows.push(h('div.param', bindCheck(o, opt.key, opt.label, ch(), { k }))); continue; }
      let options = opt.options;
      if (opt.type === 'level' || opt.type === 'levelA' || opt.type === 'levelFixed') {
        let lv;
        if (opt.type === 'levelA') lv = levelsOf(s, ['B_within_A', 'B'].includes(o.scope) ? a.factorB : a.group);
        else if (opt.type === 'levelFixed') lv = levelsOf(s, (a.fixed || [])[0]);
        else lv = a.layout === 'columns' && t.inputs.layout ? (a.columns || []) : levelsOf(s, a.group);
        options = lv.map((l) => [l, l]);
        if (!o[opt.key] && lv.length) o[opt.key] = lv[0];
      }
      if (opt.type === 'fixedVar') options = [['', '(none)'], ...(a.fixed || []).filter((f, i) => opt.key !== 'by' || i > 0).map((f) => [f, f])];
      if (opt.key === 'correction') {
        o.correction = normaliseCorrection(o);
        options = options.filter(([v]) => !(o.compare === 'pairs' && v === 'dunnettx') && !(o.compare === 'control' && v === 'tukey'));
      }
      if (opt.type === 'number') {
        rows.push(h('div.param', h('label', opt.label), bindInput(o, opt.key, ch(), { type: 'number', k, width: '90px' })));
        continue;
      }
      rows.push(h('div.param', h('label', opt.label), bindSelect(o, opt.key, options, ch(true), { k })));
    }
    return rows.length ? section('Options', h('div.params', rows), { k: 'options' }) : null;
  }

  async run() {
    const a = this.item;
    if (!getItem(this.app.store.project, a.id)) return;
    this.right.classList.add('loading');
    let r;
    try { r = await this.app.engine.ensure(a.id); } catch (e) { r = { ok: false, error: e.message }; }
    this.right.classList.remove('loading');
    const res = r.result;
    const t = TESTS[a.test];
    const body = [];
    if (!r.ok) body.push(messageBox(r.incomplete ? 'info' : 'error', r.error));
    else {
      body.push(h('div.result-head', h('h3', res.title), t.annotations.length ? button('Add to a graph', () => this.addToGraph(), { iconName: 'graph', kind: 'primary', k: 'to-graph' }) : null));
      if (res.summary) body.push(h('p.summary', res.summary));
      for (const n of res.notes || []) body.push(messageBox('info', n));
      for (const tab of res.tables) body.push(h('div.result-table', h('h4', tab.name), dataTable(tab)));
    }
    body.push(warningsBox(r.warnings));
    body.push(section('R code', codeBlock(r.code || ''), { k: 'code', open: false }));
    fill(this.right, ...body.filter(Boolean));
  }

  async addToGraph() {
    const a = this.item;
    const p = this.app.store.project;
    const graphs = itemsOf(p, 'graph');
    const choice = await modal({
      title: 'Show these results on a graph',
      body: (close) => h('div',
        h('p', 'Pick a graph, or make a new one from this data.'),
        h('div.choice-list',
          graphs.map((g) => button(g.name, () => close(g.id), { iconName: 'graph' })),
          button('New graph from this data', () => close('__new'), { iconName: 'plus', kind: 'primary' }))),
    });
    if (!choice) return;
    const g = choice === '__new' ? this.app.graphForAnalysis(a) : getItem(p, choice);
    const res = this.app.engine.result(a.id)?.result;
    const kinds = TESTS[a.test].annotations.filter((k) => k !== 'brackets' || res?.has_comparisons);
    const wanted = kinds.includes('brackets') ? ['brackets'] : kinds;
    g.annotations = (g.annotations || []).filter((x) => x.analysis !== a.id);
    for (const kind of wanted) {
      g.annotations.push({ id: `a${Date.now().toString(36)}${kind}`, analysis: a.id, kind, format: 'stars', position: 'top-left', colour: '#0072B2' });
    }
    this.app.store.change(g.id, { structural: true });
    this.app.store.select(g.id);
    toast(`Added to "${g.name}".`);
  }
}
