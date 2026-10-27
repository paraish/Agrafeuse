// The graph builder: layers on the left; the live preview, which can be resized by
// dragging, with the formatting controls underneath it on the right.
import { h, fill, rebuild, debounce, download, safeFilename } from './dom.js';
import {
  field, select, bindSelect, bindInput, bindCheck, checkbox, colour, segmented, iconButton, button,
  columnOptions, levelsOf, section, codeBlock, messageBox, input, toast,
} from './widgets.js';
import { itemHeader, warningsBox } from './common.js';
import {
  GEOMS, GEOM_CATEGORIES, AES, PLOT_AES, SHAPES, LINETYPES, THEMES, PALETTES, NUMBER_FORMATS, FONTS,
  COMPARE_TESTS, NOTE_DEFAULTS, geomDefaults, boldTitles, ensureBase, effectiveLayers, sideBySide,
} from '../codegen/graph.js';
import { TESTS } from '../codegen/stats.js';
import { datasets, itemsOf, getItem, depsOf, clone } from '../model.js';

const MIME = { svg: 'image/svg+xml', pdf: 'application/pdf', png: 'image/png', tiff: 'image/tiff' };
const ANN_KINDS = { brackets: 'P value brackets', label: 'Result text', curve: 'Fitted curve' };

export class GraphView {
  constructor(app, item) {
    this.app = app;
    this.item = item;
    ensureBase(item); // older graphs: what all layers share becomes plot-wide
    this.zoom = 'fit';
    this.el = h('div.view.split.graph-view');
    this.left = h('div.pane.controls', { 'data-scroll': 'controls' });
    this.right = h('div.pane.preview-pane');
    this.el.append(this.left, this.right);
    this.schemaSig = '';
    this.scheduleRender = debounce(() => this.renderPlot(), 250);
    this.buildPreview();
    this.render();
    this.renderPlot();
    // Make sure every dataset's columns are known, for the dropdowns.
    for (const d of depsOf(item)) if (!this.app.engine.schemaOf(d) && getItem(app.store.project, d)?.kind === 'transform') this.app.engine.ensure(d);
  }

  destroy() {
    this.scheduleRender.cancel();
    this.resize?.disconnect();
    if (this.url) URL.revokeObjectURL(this.url);
  }

  onChange({ id }) {
    if (!id || id === this.item.id || this.app.isUpstream(id, this.item.id)) this.scheduleRender();
  }

  onResult({ id }) {
    if (!depsOf(this.item).includes(id)) return;
    const sig = JSON.stringify(depsOf(this.item).map((d) => this.app.engine.schemaOf(d)?.columns));
    if (sig !== this.schemaSig) { this.schemaSig = sig; this.render(); }
  }

  changed(structural = false) {
    this.app.store.change(this.item.id);
    if (structural) this.render();
  }

  render() {
    rebuild(this.left, () => this.controls());
    this.renderFormat();
    this.placeNoteHandles();
  }

  schema(id) {
    return this.app.engine.schemaOf(id);
  }

  // ---- controls -------------------------------------------------------------------------

  controls() {
    const g = this.item;
    return h('div',
      itemHeader(this.app, g, 'Graph'),
      section('Whole plot', this.baseCard(), { k: 'base', sub: this.baseSummary() }),
      section('Layers', [
        h('div.hint', 'Each layer draws the data one way. Layers listed first are drawn first (underneath).'),
        ...g.layers.map((l, i) => this.layerCard(l, i)),
        h('div.add-row', button('Add layer', () => this.addLayer(), { iconName: 'plus', kind: 'primary', k: 'add-layer' })),
      ], { k: 'layers', sub: `${g.layers.length}` }),
      section('Statistics on the graph', this.annotations(), { k: 'stats', sub: g.annotations?.length ? String(g.annotations.length) : '' }),
      section('Text boxes', this.notes(), { k: 'notes', sub: g.notes?.length ? String(g.notes.length) : '' }),
      section('Custom ggplot2 code', this.customCode(), { k: 'custom', open: !!g.custom }),
      h('div.hint', 'Titles, axes, fonts, colours and layout are under the graph.'));
  }

  // ---- plot-wide data and aesthetics: ggplot(data, aes(...)) ------------------------------

  baseSummary() {
    const n = Object.values(this.item.base.aes).filter((m) => m?.col).length;
    return n ? `${n} mapped` : '';
  }

  baseCard() {
    const g = this.item;
    const base = g.base;
    const schema = this.schema(base.dataset);
    const cols = columnOptions(schema);
    const cell = (a) => {
      const m = base.aes[a];
      const numeric = schema?.columns?.find((c) => c.name === m?.col)?.type === 'numeric';
      const asGroups = ['x', 'colour', 'fill', 'group'].includes(a) && m && numeric
        ? checkbox(!!m.factor, 'as groups', (v) => { m.factor = v; this.changed(); }, { k: `base-${a}-f`, title: 'Treat the numbers as separate groups (categories)' }) : null;
      return h('div.base-cell', { title: AES[a].title },
        h('label', AES[a].label),
        select(m?.col || '', cols, (v) => {
          if (v) {
            base.aes[a] = { mode: 'col', col: v };
            // Layers that map the same column now just inherit it.
            for (const l of g.layers) {
              const own = l.aes?.[a];
              if (own?.mode === 'col' && own.col === v && !own.factor && (!l.dataset || l.dataset === base.dataset)) delete l.aes[a];
            }
          } else delete base.aes[a];
          this.changed(true);
        }, { placeholder: '—', k: `base-${a}` }),
        asGroups);
    };
    return h('div.card.base-card', h('div.card-body',
      h('div.hint', 'Data and mappings for every layer, like ggplot(data, aes(…)). A layer can still use its own, or switch one off.'),
      field('Data', bindSelect(base, 'dataset', datasets(this.app.store.project).map((d) => [d.id, d.name]), () => {
        this.changed(true);
        if (base.dataset && !this.schema(base.dataset)) this.app.engine.ensure(base.dataset);
      }, { placeholder: '(each layer chooses its own)', k: 'base-ds' })),
      h('div.base-aes', PLOT_AES.map(cell))));
  }

  // The plot-wide mapping a layer would inherit for an aesthetic, if any.
  inherited(l, a) {
    const m = this.item.base?.aes?.[a];
    return !GEOMS[l.geom].noData && m?.mode === 'col' && m.col ? m : null;
  }

  layerCard(l, i) {
    const g = this.item;
    const geom = GEOMS[l.geom];
    const k = (s) => `l${i}-${s}`;
    const geomOptions = GEOM_CATEGORIES.map((cat) => ({
      group: cat, options: Object.entries(GEOMS).filter(([, x]) => x.category === cat).map(([key, x]) => [key, x.label]),
    }));
    const move = (d) => {
      const j = i + d;
      if (j < 0 || j >= g.layers.length) return;
      [g.layers[i], g.layers[j]] = [g.layers[j], g.layers[i]];
      this.changed(true);
    };
    const head = h('div.card-head',
      h('span.step-n', String(i + 1)),
      select(l.geom, geomOptions, (v) => this.changeGeom(l, v), { k: k('geom') }),
      h('span.grow'),
      iconButton(l.hidden ? 'eyeOff' : 'eye', l.hidden ? 'Show layer' : 'Hide layer', () => { l.hidden = !l.hidden; this.changed(true); }),
      iconButton('up', 'Move up (drawn earlier, underneath)', () => move(-1), { disabled: i === 0 }),
      iconButton('down', 'Move down (drawn later, on top)', () => move(1), { disabled: i === g.layers.length - 1 }),
      iconButton('copy', 'Duplicate layer', () => { const c = clone(l); c.id = `l${Date.now().toString(36)}`; g.layers.splice(i + 1, 0, c); this.changed(true); }),
      iconButton('trash', 'Delete layer', () => { g.layers.splice(i, 1); this.changed(true); }));
    let body;
    if (geom.custom) {
      body = [this.codeBox(l, 'code', 'e.g. annotate("text", x = 1, y = 10, label = "n = 12")', k('code'))];
    } else {
      const plotData = g.base?.dataset ? getItem(this.app.store.project, g.base.dataset) : null;
      const schema = geom.noData ? null : this.schema(l.dataset || g.base?.dataset);
      body = [
        geom.noData ? null : field('Data', bindSelect(l, 'dataset', datasets(this.app.store.project).map((d) => [d.id, d.name]), () => {
          this.changed(true);
          if (l.dataset && !this.schema(l.dataset)) this.app.engine.ensure(l.dataset);
        }, { placeholder: plotData ? `The plot's data (${plotData.name})` : 'Choose a dataset…', k: k('ds') })),
        h('div.aes-grid', geom.aes.map((a) => this.aesRow(l, a, schema, k(`aes-${a}`)))),
        geom.params.length ? h('div.params', geom.params.map((p) => this.paramRow(l, p, k(`p-${p.key}`)))) : null,
      ];
    }
    return h('div.card.layer', { class: l.hidden ? 'off' : '' }, head, h('div.card-body', body));
  }

  // One aesthetic of a layer. Unset = the plot-wide mapping, if there is one.
  aesRow(l, a, schema, k) {
    const def = AES[a];
    const from = this.inherited(l, a);
    const m = l.aes[a] || (from ? { mode: 'inherit' } : { mode: 'none' });
    const required = GEOMS[l.geom].required.includes(a) && !from;
    const colOpts = columnOptions(schema);
    const colType = schema?.columns?.find((c) => c.name === m.col)?.type;
    const setMap = (patch) => { l.aes[a] = { ...m, ...patch }; };
    const asGroups = (a === 'x' || a === 'colour' || a === 'fill' || a === 'group') && m.mode === 'col' && colType === 'numeric'
      ? checkbox(!!m.factor, 'as groups', (v) => { setMap({ factor: v }); this.changed(); }, { k: `${k}-f`, title: 'Treat the numbers as separate groups (categories)' }) : null;
    const label = h('label', { title: def.title }, def.label, required ? h('span.req', ' *') : null);

    if (def.mapOnly) {
      // One menu: the plot's mapping (if any), a column, or (when the plot maps it) none.
      const value = m.mode === 'col' ? m.col || '' : m.mode === 'none' && from ? '__none' : '';
      const opts = from && !GEOMS[l.geom].required.includes(a) ? [...colOpts, ['__none', '(none in this layer)']] : colOpts;
      const sel = select(value, opts, (v) => {
        if (v === '__none') l.aes[a] = { mode: 'none' };
        else if (v) setMap({ mode: 'col', col: v });
        else delete l.aes[a];
        this.changed(true);
      }, { placeholder: from ? `from the plot: ${from.col}` : required ? 'Choose a column…' : '—', k: `${k}-col` });
      if (from && m.mode === 'inherit') sel.classList.add('inherits');
      return h('div.aes-row', label, h('div.aes-ctl', sel, asGroups));
    }
    const modes = from
      ? [['inherit', 'Plot', `Use the plot-wide mapping (${from.col})`], ['col', 'Column', 'Varies with a column'], ['const', 'Fixed', 'One fixed value'], ['none', 'Off', 'Not used in this layer']]
      : [['none', '—', 'Not set (use the default)'], ['col', 'Column', 'Varies with a column'], ['const', 'Fixed', 'One fixed value']];
    const seg = segmented(modes, m.mode, (mode) => {
      if (mode === 'inherit' || (mode === 'none' && !from)) delete l.aes[a];
      else if (mode === 'none') l.aes[a] = { mode: 'none' };
      else if (mode === 'col') l.aes[a] = { mode: 'col', col: l.aes[a]?.col || '' };
      else l.aes[a] = { mode: 'const', value: defaultConst(a) };
      this.changed(true);
    }, { k: `${k}-mode`, small: true });
    let ctl = null;
    if (m.mode === 'inherit') ctl = h('span.inherited', { title: 'From the whole-plot settings' }, from.col);
    else if (m.mode === 'col') {
      ctl = select(m.col || '', colOpts, (v) => {
        if (v) setMap({ mode: 'col', col: v }); else delete l.aes[a];
        this.changed(true);
      }, { placeholder: '—', k: `${k}-col` });
    } else if (m.mode === 'const') ctl = this.constControl(l, a, m, k);
    return h('div.aes-row', label, h('div.aes-ctl', seg, ctl, asGroups));
  }

  constControl(l, a, m, k) {
    const set = (v) => { l.aes[a] = { mode: 'const', value: v }; this.changed(); };
    switch (AES[a].kind) {
      case 'colour': return h('span.colour-pick', colour(m.value, set, { k: `${k}-c` }), input(m.value, (v) => { if (/^#[0-9a-f]{6}$/i.test(v)) set(v); }, { k: `${k}-hex`, width: '78px', mono: true }));
      case 'shape': return select(String(m.value), SHAPES.map(([v, lbl]) => [String(v), lbl]), (v) => set(Number(v)), { k: `${k}-s` });
      case 'linetype': return select(m.value, LINETYPES.map((v) => [v, v]), set, { k: `${k}-lt` });
      default: return input(m.value, (v) => set(v), { type: 'number', step: AES[a].step, min: AES[a].min, max: AES[a].max, k: `${k}-n`, width: '80px' });
    }
  }

  paramRow(l, p, k) {
    l.params = l.params || {};
    if (l.params[p.key] === undefined) l.params[p.key] = p.def;
    const ch = () => this.changed();
    switch (p.type) {
      case 'bool': return h('div.param', bindCheck(l.params, p.key, p.label, ch, { k }));
      case 'select': return h('div.param', h('label', p.label), bindSelect(l.params, p.key, p.options, ch, { k }));
      case 'number': return h('div.param', h('label', p.label), bindInput(l.params, p.key, ch, { type: 'number', step: p.step, min: p.min, max: p.max, k, width: '80px' }));
      default: return h('div.param', h('label', p.label), bindInput(l.params, p.key, ch, { k, width: '80px' }));
    }
  }

  changeGeom(l, key) {
    const geom = GEOMS[key];
    const keep = {};
    for (const a of geom.aes) if (l.aes?.[a]) keep[a] = l.aes[a];
    l.geom = key;
    l.aes = keep;
    const old = l.params || {};
    l.params = geomDefaults(key);
    for (const p of geom.params) if (old[p.key] !== undefined) l.params[p.key] = old[p.key];
    if (!geom.noData && !l.dataset && !this.item.base?.dataset) l.dataset = this.item.layers.find((x) => x.dataset)?.dataset || '';
    this.changed(true);
  }

  addLayer() {
    const g = this.item;
    if (g.base?.dataset) {
      // Inherits the plot's data and mappings; a summary layer if X and Y are mapped.
      const geom = g.base.aes.x?.col && g.base.aes.y?.col ? 'mean_point' : 'point';
      g.layers.push({ id: `l${Date.now().toString(36)}`, geom, dataset: '', aes: {}, params: geomDefaults(geom) });
      this.changed(true);
      return;
    }
    const base = g.layers.find((l) => l.dataset && !GEOMS[l.geom].noData);
    const aes = {};
    if (base) for (const a of ['x', 'y']) if (base.aes[a]) aes[a] = { ...base.aes[a] };
    g.layers.push({ id: `l${Date.now().toString(36)}`, geom: base ? 'mean_point' : 'point', dataset: base?.dataset || datasets(this.app.store.project)[0]?.id || '', aes, params: geomDefaults(base ? 'mean_point' : 'point') });
    this.changed(true);
  }

  codeBox(obj, key, placeholder, k) {
    const msg = h('div.code-check');
    const check = debounce(async () => {
      const code = (obj[key] || '').trim();
      if (!code) { fill(msg); return; }
      const r = await this.app.engine.checkCode(code);
      fill(msg, r.ok ? h('span.ok', '✓ Valid R') : h('span.err', r.error.split('\n').slice(0, 2).join(' ')));
    }, 400);
    const ta = h('textarea.mono', { rows: 3, placeholder, 'data-k': k, spellcheck: 'false' });
    ta.value = obj[key] || '';
    ta.addEventListener('input', () => { obj[key] = ta.value; this.app.store.change(this.item.id); check(); });
    if (obj[key]) check();
    return h('div.codebox', ta, msg);
  }

  // ---- statistics ------------------------------------------------------------------------

  annotations() {
    const g = this.item;
    g.annotations = g.annotations || [];
    const analyses = itemsOf(this.app.store.project, 'analysis');
    const usable = analyses.filter((a) => (TESTS[a.test]?.annotations || []).length);
    const cards = g.annotations.map((ann, i) => (ann.kind === 'compare' ? this.compareCard(ann, i) : this.analysisCard(ann, i, usable)));
    return [
      cards.length ? null : h('div.hint', 'Put p values on the graph: compare its groups right here (t tests or Mann-Whitney tests, with brackets), or draw the results of an analysis (brackets, result text, fitted curves).'),
      ...cards,
      h('div.add-row',
        button('Compare groups', () => this.addCompare(), { iconName: 'plus', kind: 'primary', k: 'add-compare', title: "Tests between the graph's groups, drawn as brackets" }),
        usable.length
          ? button('From an analysis', () => this.addAnalysisAnnotation(usable), { iconName: 'stats', k: 'add-ann' })
          : button('New analysis…', () => this.app.newAnalysisDialog(g.base?.dataset || g.layers.find((l) => l.dataset)?.dataset), { iconName: 'stats', k: 'new-ann-analysis' })),
      cards.length ? h('div.hint', 'Brackets go between the groups on the X axis of the first layer. For side-by-side groups (dodge), compare them within each X group.') : null,
    ];
  }

  addCompare() {
    const g = this.item;
    const main = this.mainLayer();
    // Side-by-side groups (a split by fill or colour, dodged): compare those within each X group.
    const within = !!sideBySide(main) && g.layers.some((l) => l.params?.dodge);
    g.annotations.push({ id: `a${Date.now().toString(36)}`, kind: 'compare', method: 't.test', comparisons: 'all', p_adjust: 'holm', format: 'stars', overall: !within, position: 'top-left', within });
    this.changed(true);
  }

  addAnalysisAnnotation(usable) {
    // Prefer an analysis of the data this graph shows (or of the table it came from).
    const g = this.item;
    const p = this.app.store.project;
    const shown = new Set(effectiveLayers(g).map((l) => l.dataset).filter(Boolean));
    for (const id of [...shown]) { const src = getItem(p, id); if (src?.kind === 'transform') shown.add(src.input); }
    const a = [...usable].reverse().find((x) => shown.has(x.dataset)) || usable[usable.length - 1];
    g.annotations.push({ id: `a${Date.now().toString(36)}`, analysis: a.id, kind: TESTS[a.test].annotations[0], format: 'stars', position: 'top-left' });
    this.changed(true);
  }

  bracketParams(ann, k, ch) {
    const more = ann.y_start !== '' && ann.y_start != null || (ann.step !== '' && ann.step != null) || !!ann.text_size;
    return [
      h('div.param', h('label', 'Show'), bindSelect(ann, 'format', [['stars', 'Stars (*, **, ns)'], ['p', 'p = 0.0123'], ['number', '0.0123']], ch(), { k: k('fmt') })),
      h('div.param', bindCheck(ann, 'hide_ns', 'Hide non-significant (ns)', ch(), { k: k('ns') })),
      h('details.more', { open: more },
        h('summary', 'Bracket height, spacing and text size'),
        h('div.param', h('label', 'Start height (blank = automatic)'), bindInput(ann, 'y_start', ch(), { type: 'number', k: k('y0'), width: '80px' })),
        h('div.param', h('label', 'Spacing'), bindInput(ann, 'step', ch(), { type: 'number', step: 0.01, k: k('step'), width: '80px', placeholder: '0.09' })),
        h('div.param', h('label', 'Text size'), bindInput(ann, 'text_size', ch(), { type: 'number', step: 0.5, k: k('ts'), width: '80px', placeholder: '4.5' }))),
    ];
  }

  // Tests between the graph's groups, computed from its own data.
  compareCard(ann, i) {
    const g = this.item;
    const k = (x) => `ann${i}-${x}`;
    const ch = (structural) => () => this.changed(structural);
    const main = this.mainLayer();
    const schema = this.schema(main?.dataset);
    const x = main?.aes?.x?.col;
    const split = sideBySide(main);
    const compared = ann.within && split ? split : x;
    const levels = levelsOf(schema, compared);
    const opts = [
      split ? h('div.param', h('label', 'Compare'), select(ann.within ? 'within' : 'x',
        [['x', `Groups on the X axis (${x})`], ['within', `${split} within each ${x}`]],
        (v) => { ann.within = v === 'within'; if (ann.within) ann.overall = false; this.changed(true); }, { k: k('within') })) : null,
      h('div.param', h('label', 'Test'), bindSelect(ann, 'method', COMPARE_TESTS, ch(), { k: k('method') })),
      h('div.param', h('label', 'Which pairs'), bindSelect(ann, 'comparisons', [['all', 'All pairs'], ['control', 'Each against a control'], ['none', 'None (overall test only)']], ch(true), { k: k('cmp') })),
      ann.comparisons === 'control' ? h('div.param', h('label', 'Control group'), bindSelect(ann, 'ref', levels.map((l) => [l, l]), ch(), { placeholder: levels[0] ? `(first: ${levels[0]})` : '(first group)', k: k('ref') })) : null,
      h('div.param', bindCheck(ann, 'paired', 'Paired (the same subjects in each group)', ch(true), { k: k('paired') })),
      ann.paired ? h('div.param', h('label', 'Subject column'), bindSelect(ann, 'subject', columnOptions(schema), ch(), { placeholder: 'Choose…', k: k('subject') })) : null,
      ann.comparisons !== 'none' ? h('div.param', h('label', 'Adjust P values for'), bindSelect(ann, 'p_adjust', [['holm', 'Multiple comparisons (Holm)'], ['bonferroni', 'Multiple comparisons (Bonferroni)'], ['BH', 'False discovery rate (Benjamini-Hochberg)'], ['none', 'Nothing (unadjusted)']], ch(), { k: k('adj') })) : null,
      ann.comparisons !== 'none' ? this.bracketParams(ann, k, ch) : null,
      ann.within ? null : h('div.param', bindCheck({ overall: ann.overall !== false }, 'overall', 'Show the overall test (ANOVA / Kruskal-Wallis) in a corner', (v) => { ann.overall = v; this.changed(true); }, { k: k('overall') })),
      !ann.within && ann.overall !== false ? h('div.param', h('label', 'Corner'), bindSelect(ann, 'position', [['top-left', 'Top left'], ['top-right', 'Top right'], ['bottom-left', 'Bottom left'], ['bottom-right', 'Bottom right']], ch(), { k: k('pos') })) : null,
    ];
    return h('div.card.ann',
      h('div.card-head', h('span.card-title', 'Compare groups'), h('span.muted.ann-sub', x ? `${main.aes.y?.col || ''} by ${compared}` : ''), h('span.grow'),
        iconButton('trash', 'Remove', () => { g.annotations.splice(i, 1); this.changed(true); }, { k: k('del') })),
      h('div.card-body.params', main ? opts : h('div.hint', 'Give the first layer X and Y columns first.')));
  }

  analysisCard(ann, i, usable) {
    const g = this.item;
    const an = getItem(this.app.store.project, ann.analysis);
    const kinds = (TESTS[an?.test]?.annotations || []);
    const k = (s) => `ann${i}-${s}`;
    const ch = (structural) => () => this.changed(structural);
    let opts = [];
    if (ann.kind === 'brackets') {
      opts = this.bracketParams(ann, k, ch);
    } else if (ann.kind === 'label') {
      opts = [
        h('div.param', h('label', 'Position'), bindSelect(ann, 'position', [['top-left', 'Top left'], ['top-right', 'Top right'], ['bottom-left', 'Bottom left'], ['bottom-right', 'Bottom right']], ch(), { k: k('pos') })),
        h('div.param', h('label', 'Text size'), bindInput(ann, 'text_size', ch(), { type: 'number', step: 0.5, k: k('ts'), width: '80px', placeholder: '4.2' })),
      ];
    } else if (ann.kind === 'curve') {
      opts = [
        h('div.param', h('label', 'Colour'), colour(ann.colour || '#000000', (v) => { ann.colour = v; this.changed(); }, { k: k('col') })),
        h('div.param', bindCheck({ band: ann.band !== false }, 'band', 'Show 95% confidence band (straight lines and polynomials)', (v) => { ann.band = v; this.changed(); }, { k: k('band') })),
      ];
    }
    return h('div.card.ann',
      h('div.card-head',
        select(ann.analysis, usable.map((a) => [a.id, a.name]), (v) => {
          ann.analysis = v;
          const ks = TESTS[getItem(this.app.store.project, v).test].annotations;
          if (!ks.includes(ann.kind)) ann.kind = ks[0];
          this.changed(true);
        }, { k: k('an') }),
        select(ann.kind, kinds.map((x) => [x, ANN_KINDS[x]]), (v) => { ann.kind = v; this.changed(true); }, { k: k('kind') }),
        h('span.grow'),
        iconButton('trash', 'Remove', () => { g.annotations.splice(i, 1); this.changed(true); })),
      h('div.card-body.params', opts));
  }

  // ---- text boxes ----------------------------------------------------------------------------

  notes() {
    const g = this.item;
    g.notes = g.notes || [];
    return [
      g.notes.length ? null : h('div.hint', 'Add text anywhere on the graph: a note, a label for a group, n = 12…'),
      ...g.notes.map((n, i) => this.noteCard(n, i)),
      h('div.add-row', button('Add text box', () => {
        g.notes.push({ id: `n${Date.now().toString(36)}`, ...NOTE_DEFAULTS });
        this.changed(true);
      }, { iconName: 'plus', k: 'add-note' })),
      g.notes.length ? h('div.hint', 'Drag a text box\'s handle (●) on the graph to move it.') : null,
    ];
  }

  noteCard(n, i) {
    const g = this.item;
    const k = (x) => `note${i}-${x}`;
    const ch = (structural) => () => this.changed(structural);
    const ta = h('textarea', { rows: 2, 'data-k': k('text'), placeholder: 'Text (Enter for a new line)' });
    ta.value = n.text ?? '';
    ta.addEventListener('input', () => { n.text = ta.value; this.changed(); this.placeNoteHandles(); });
    // Panel positions are shown as % (stored as 0–1).
    const pos = (key) => (n.data
      ? bindInput(n, key, ch(), { type: 'number', step: 'any', k: k(key), width: '72px' })
      : input(Math.round((n[key] ?? 0.5) * 1000) / 10, (v) => { n[key] = v === '' ? 0 : Number(v) / 100; this.changed(); this.placeNoteHandles(); },
        { type: 'number', step: 1, min: 0, max: 100, k: k(key), width: '64px' }));
    const toggle = (key, label, title) => h('button', {
      type: 'button', class: `tg tg-${key}${n[key] ? ' on' : ''}`, title, 'aria-pressed': n[key] ? 'true' : 'false', 'data-k': k(key),
      onclick: () => { n[key] = !n[key]; this.changed(true); },
    }, label);
    return h('div.card.note',
      h('div.card-head', h('span.step-n', String(i + 1)), h('span.card-title', 'Text box'), h('span.grow'),
        iconButton('copy', 'Duplicate', () => { g.notes.splice(i + 1, 0, { ...n, id: `n${Date.now().toString(36)}`, y: Math.max(0, (n.y ?? 0.5) - 0.1) }); this.changed(true); }),
        iconButton('trash', 'Delete text box', () => { g.notes.splice(i, 1); this.changed(true); }, { k: k('del') })),
      h('div.card-body',
        ta,
        h('div.note-row',
          h('label', 'Text'), bindInput(n, 'size', ch(), { type: 'number', step: 0.5, min: 1, max: 20, k: k('size'), width: '60px' }),
          colour(n.colour || '#000000', (v) => { n.colour = v; this.changed(); }, { k: k('colour') }),
          h('span.toggles', toggle('bold', 'B', 'Bold'), toggle('italic', 'I', 'Italic')),
          segmented([['left', 'Left'], ['center', 'Centre'], ['right', 'Right']], n.align || 'center', (v) => { n.align = v; this.changed(true); }, { k: k('align'), small: true })),
        h('div.note-row',
          h('label', 'Box'), segmented([['box', 'Box'], ['none', 'No box']], n.fill ? 'box' : 'none', (v) => { if (v === 'box') n.fill = n.lastFill || '#ffffff'; else { n.lastFill = n.fill; n.fill = ''; } this.changed(true); }, { k: k('box'), small: true }),
          n.fill ? [colour(n.fill, (v) => { n.fill = v; this.changed(); }, { k: k('fill') }),
            h('span.muted', 'outline'), bindInput(n, 'border', ch(), { type: 'number', step: 0.05, min: 0, max: 3, k: k('border'), width: '60px' })] : null),
        h('div.note-row',
          h('label', 'Where'), h('span.muted', 'X'), pos('x'), h('span.muted', 'Y'), pos('y'), h('span.muted', n.data ? '' : '% of the panel'),
          bindCheck(n, 'data', 'axis values', () => {
            // Switching to axis values: start from the middle of the visible axes, if known.
            const geo = this.geometry;
            if (n.data && geo?.h && geo?.v) {
              const mid = (r, f) => r[0] + f * (r[1] - r[0]);
              n.x = Number(mid(geo.h.range, n.x ?? 0.5).toPrecision(3));
              n.y = Number(mid(geo.v.range, n.y ?? 0.5).toPrecision(3));
            } else if (!n.data) { n.x = 0.5; n.y = 0.9; }
            this.changed(true);
          }, { k: k('data') }))));
  }

  // Grips over the preview, one per text box placed by panel position, to drag it.
  placeNoteHandles() {
    if (!this.noteLayer) return;
    const geo = this.geometry;
    const notes = this.item.notes || [];
    fill(this.noteLayer, geo ? notes.map((n, i) => {
      if (n.data || !String(n.text ?? '').trim()) return null;
      const left = geo.left + (n.x ?? 0.5) * (geo.right - geo.left);
      const top = geo.top + (1 - (n.y ?? 0.5)) * (geo.bottom - geo.top);
      return h('span.note-grip', {
        style: { left: `${(left * 100).toFixed(3)}%`, top: `${(top * 100).toFixed(3)}%` },
        title: `Drag to move "${String(n.text).split('\n')[0].slice(0, 40)}"`, 'data-note': i,
        onpointerdown: (e) => this.startNoteDrag(e, n),
      });
    }) : null);
  }

  startNoteDrag(e, n) {
    const geo = this.geometry;
    if (e.button !== 0 || !geo) return;
    e.preventDefault();
    e.stopPropagation();
    const grip = e.currentTarget;
    const rect = this.img.getBoundingClientRect();
    const frameRect = this.frame.getBoundingClientRect();
    const clamp = (v) => Math.min(1, Math.max(0, v));
    let next = null;
    grip.classList.add('dragging');
    const move = (ev) => {
      const fx = (ev.clientX - rect.left) / rect.width;
      const fy = (ev.clientY - rect.top) / rect.height;
      next = { x: clamp((fx - geo.left) / (geo.right - geo.left)), y: clamp((geo.bottom - fy) / (geo.bottom - geo.top)) };
      grip.style.left = `${ev.clientX - frameRect.left}px`;
      grip.style.top = `${ev.clientY - frameRect.top}px`;
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      grip.classList.remove('dragging');
      if (!next) return;
      n.x = Math.round(next.x * 1000) / 1000;
      n.y = Math.round(next.y * 1000) / 1000;
      this.changed(true);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  // ---- formatting panel (under the graph) --------------------------------------------------

  // The first layer with an X column (with what it inherits from the plot).
  mainLayer() {
    return effectiveLayers(this.item).find((l) => !GEOMS[l.geom].noData && l.aes?.x?.mode === 'col');
  }

  renderFormat() {
    if (this.formatHost) rebuild(this.formatHost, () => this.formatPanel());
  }

  formatPanel() {
    const g = this.item;
    g.labels = g.labels || {};
    g.style = g.style || {};
    g.theme = g.theme || { name: 'lab', base_size: 14 };
    // Older projects kept the X label angle on the theme.
    if (g.theme.x_angle !== undefined) {
      g.style.x_text = { ...(g.style.x_text || {}), angle: g.style.x_text?.angle ?? g.theme.x_angle };
      delete g.theme.x_angle;
    }
    const tabs = [['axes', 'Axes'], ['text', 'Title and fonts'], ['legend', 'Legend and colours'], ['layout', 'Layout']];
    this.formatTab = this.formatTab || 'axes';
    const body = {
      axes: () => [h('div.hint.fmt-tip', 'Tip: on the graph, drag along an axis to stretch or shrink it, and double-click the axis to reset it.'),
        h('div.fmt-cols', this.axisColumn('x'), this.axisColumn('y'))],
      text: () => this.textTab(),
      legend: () => this.legendTab(),
      layout: () => this.layoutTab(),
    }[this.formatTab]();
    return h('div.format-card',
      h('div.fmt-tabs', { role: 'tablist' }, tabs.map(([k, l]) => h('button', {
        type: 'button', role: 'tab', class: k === this.formatTab ? 'on' : '', 'aria-selected': k === this.formatTab ? 'true' : 'false', 'data-k': `fmt-tab-${k}`,
        onclick: () => { this.formatTab = k; this.renderFormat(); },
      }, l))),
      h('div.fmt-body', body));
  }

  // Bold / italic / underline buttons. `bold: null` means "as the theme does".
  faceToggles(st, keys, k) {
    const themeBold = boldTitles(this.item.theme?.name);
    const defs = { bold: ['B', 'Bold', themeBold && /title/.test(k)], italic: ['I', 'Italic', false], underline: ['U', 'Underline', false] };
    return h('span.toggles', keys.map((key) => {
      const on = st[key] ?? defs[key][2];
      return h('button', {
        type: 'button', class: `tg tg-${key}${on ? ' on' : ''}`, title: defs[key][1], 'aria-pressed': on ? 'true' : 'false', 'data-k': `${k}-${key}`,
        onclick: () => { st[key] = !on; this.changed(true); },
      }, defs[key][0]);
    }));
  }

  fmtRow(label, ...controls) {
    return h('div.fmt-row', h('span.fmt-label', label), h('div.fmt-ctl', controls));
  }

  numberBox(obj, key, { k, placeholder = 'auto', step = 1, min = 0, max, width = '64px' } = {}) {
    return bindInput(obj, key, () => this.changed(), { type: 'number', k, placeholder, step, min, max, width });
  }

  axisColumn(which) {
    const g = this.item;
    const L = g.labels;
    const titleSt = g.style[`${which}_title`] = g.style[`${which}_title`] || {};
    const textSt = g.style[`${which}_text`] = g.style[`${which}_text`] || {};
    const scale = g[`${which}_scale`] = g[`${which}_scale`] || { trans: 'identity' };
    const main = this.mainLayer();
    const xNumeric = main && this.schema(main.dataset)?.columns?.find((c) => c.name === main.aes.x.col)?.type === 'numeric' && !main.aes.x.factor;
    const continuous = which === 'y' || xNumeric;
    const ch = (st) => () => this.changed(st);
    const linear = !scale.trans || scale.trans === 'identity';
    const fmts = Object.entries(NUMBER_FORMATS).filter(([key]) => key !== 'pow10' || scale.trans === 'log10').map(([key, [label]]) => [key, label]);
    const placeholder = which === 'x' ? main?.aes?.x?.col : (main?.aes?.y?.col || '');
    return h('div.fmt-col',
      h('h4', which === 'x' ? 'X axis' : 'Y axis'),
      this.fmtRow('Title', bindInput(L, which, ch(), { k: `${which}lab`, placeholder: placeholder || '(column name)' }), bindCheck(L, `hide_${which}`, 'hide', ch(), { k: `hide${which}` })),
      this.fmtRow('Title text', this.numberBox(titleSt, 'size', { k: `${which}-tsize`, placeholder: 'size' }), this.faceToggles(titleSt, ['bold', 'italic', 'underline'], `${which}-title`)),
      this.fmtRow('Tick labels', this.numberBox(textSt, 'size', { k: `${which}-lsize`, placeholder: 'size' }), this.faceToggles(textSt, ['bold', 'italic'], `${which}-text`),
        segmented([['0', '0°'], ['45', '45°'], ['90', '90°']], String(textSt.angle || 0), (v) => { textSt.angle = Number(v); this.changed(true); }, { k: `${which}-angle`, small: true })),
      continuous ? [
        this.fmtRow('Scale', bindSelect(scale, 'trans', [['identity', 'Linear'], ['log10', 'Log 10'], ['log2', 'Log 2'], ['sqrt', 'Square root']], ch(true), { k: `${which}-trans` }),
          linear ? bindCheck(scale, 'reverse', 'reverse', ch(), { k: `${which}-rev` }) : null),
        this.fmtRow('Range', this.numberBox(scale, 'min', { k: `${which}-min`, placeholder: 'min', step: 'any', min: undefined, width: '72px' }), h('span.muted', 'to'),
          this.numberBox(scale, 'max', { k: `${which}-max`, placeholder: 'max', step: 'any', min: undefined, width: '72px' }),
          linear ? bindCheck(scale, 'from_zero', 'start at 0', ch(), { k: `${which}-zero` }) : null),
        this.fmtRow('Ticks', linear || scale.trans === 'sqrt' ? this.numberBox(scale, 'step', { k: `${which}-step`, placeholder: 'every…', step: 'any', width: '72px' }) : null,
          bindSelect(scale, 'format', fmts, ch(), { k: `${which}-fmt`, placeholder: 'Number format: automatic' })),
      ] : h('div.hint', 'This axis shows groups. To change their order, add a "Reorder groups" step to the transform that makes this data.'));
  }

  textTab() {
    const g = this.item;
    const L = g.labels;
    const st = g.style.title = g.style.title || {};
    const ch = (s) => () => this.changed(s);
    return h('div.fmt-cols',
      h('div.fmt-col',
        h('h4', 'Graph title'),
        this.fmtRow('Title', bindInput(L, 'title', ch(), { k: 'title', placeholder: '(none)' })),
        this.fmtRow('Subtitle', bindInput(L, 'subtitle', ch(), { k: 'subtitle', placeholder: '(none)' })),
        this.fmtRow('Title text', this.numberBox(st, 'size', { k: 'title-size', placeholder: 'size' }), this.faceToggles(st, ['bold', 'italic', 'underline'], 'title-face'),
          segmented([['left', 'Left'], ['center', 'Centre'], ['right', 'Right']], st.align || '', (v) => { st.align = v; this.changed(true); }, { k: 'title-align', small: true }))),
      h('div.fmt-col',
        h('h4', 'Fonts and lines'),
        this.fmtRow('Font', bindSelect(g.style, 'family', FONTS, ch(), { k: 'family' })),
        this.fmtRow('Base size', bindInput(g.theme, 'base_size', ch(), { type: 'number', min: 6, max: 40, step: 1, k: 'fontsize', width: '64px' }), h('span.muted', 'pt (other sizes are relative to this unless set)')),
        this.fmtRow('Axis lines', this.numberBox(g.style, 'axis_line', { k: 'axis-line', placeholder: 'width', step: 0.1 }), h('span.muted', 'line and tick thickness'))));
  }

  legendTab() {
    const g = this.item;
    const L = g.labels;
    g.palette = g.palette || { name: 'default', manual: {} };
    const leg = g.style.legend_text = g.style.legend_text || {};
    const ch = (s) => () => this.changed(s);
    const owner = effectiveLayers(g).find((l) => !GEOMS[l.geom].noData && ['colour', 'fill'].some((a) => l.aes?.[a]?.mode === 'col'));
    const aesKey = owner ? (owner.aes.fill?.mode === 'col' ? 'fill' : 'colour') : null;
    const levels = owner ? levelsOf(this.schema(owner.dataset), owner.aes[aesKey].col) : [];
    const pal = g.palette;
    let swatches = null;
    if (pal.name === 'manual' && owner) {
      pal.manual = pal.manual || {};
      levels.forEach((lv, j) => { if (!pal.manual[lv]) pal.manual[lv] = DEFAULT_SWATCHES[j % DEFAULT_SWATCHES.length]; });
      swatches = h('div.swatches', levels.map((lv) => h('div.swatch',
        colour(pal.manual[lv], (v) => { pal.manual[lv] = v; this.changed(); }, { k: `sw-${lv}` }), h('span', lv))));
    }
    return h('div.fmt-cols',
      h('div.fmt-col',
        h('h4', 'Colours'),
        this.fmtRow('Palette', bindSelect(pal, 'name', PALETTES, ch(true), { k: 'palette' })),
        owner ? swatches : h('div.hint', 'No layer maps Colour or Fill to a column. Fixed colours are set in each layer.')),
      h('div.fmt-col',
        h('h4', 'Legend'),
        this.fmtRow('Position', bindSelect(g.theme, 'legend', [['right', 'Right'], ['top', 'Top'], ['bottom', 'Bottom'], ['left', 'Left'], ['none', 'Hidden']], ch(), { k: 'legend' })),
        this.fmtRow('Title', bindInput(L, 'legend', ch(), { k: 'leglab', placeholder: '(column name)' }), bindCheck(L, 'hide_legend_title', 'hide', ch(), { k: 'hideleg' })),
        this.fmtRow('Text size', this.numberBox(leg, 'size', { k: 'leg-size', placeholder: 'size' }))));
  }

  layoutTab() {
    const g = this.item;
    g.facet = g.facet || { by: '' };
    const ch = (s) => () => this.changed(s);
    const main = this.mainLayer();
    const cols = columnOptions(this.schema(main?.dataset || g.base?.dataset));
    return h('div.fmt-cols',
      h('div.fmt-col',
        h('h4', 'Look'),
        this.fmtRow('Theme', bindSelect(g.theme, 'name', THEMES.map(([k, l]) => [k, l]), ch(true), { k: 'theme' })),
        this.fmtRow('Orientation', bindCheck(g, 'flip', 'Horizontal (swap X and Y)', ch(), { k: 'flip' })),
        this.fmtRow('Size', h('span.muted', 'Drag the graph\'s edges, or type the size above it.'))),
      h('div.fmt-col',
        h('h4', 'Panels'),
        this.fmtRow('Split by', bindSelect(g.facet, 'by', cols, ch(true), { placeholder: '(one panel)', k: 'facet' })),
        g.facet.by ? this.fmtRow('Panel axes', bindSelect(g.facet, 'scales', [['fixed', 'Same for all'], ['free_y', 'Own Y axis'], ['free_x', 'Own X axis'], ['free', 'Own X and Y']], ch(), { k: 'fscales' })) : null));
  }

  customCode() {
    return [
      h('div.hint', 'Anything else ggplot2 can do, added with "+" at the end of the plot. Several pieces can be joined with "+". Example: scale_y_continuous(breaks = seq(0, 10, 2))'),
      this.codeBox(this.item, 'custom', 'scale_y_continuous(breaks = seq(0, 10, 2))', 'custom-code'),
    ];
  }

  // ---- preview -----------------------------------------------------------------------------

  buildPreview() {
    const g = this.item;
    g.size = g.size || { width: 5, height: 4, dpi: 300 };
    this.exportFmt = 'pdf';
    const sizeCtl = (key, label) => {
      const el = input(g.size[key], (v) => { if (v >= 1 && v <= 50) { g.size[key] = v; this.changed(); this.fitImage(); } }, { type: 'number', step: 0.1, min: 1, max: 50, width: '62px', k: `size-${key}` });
      this[`${key}Input`] = el;
      return h('label.size', label, el);
    };
    this.img = h('img.plot', { alt: `Preview of ${g.name}`, onload: () => this.fitImage(), draggable: 'false' });
    // Drag the right edge, bottom edge or corner to resize the graph (Shift keeps the shape).
    const handle = (mode, title) => h('span', { class: `rh rh-${mode}`, title, onpointerdown: (e) => this.startResize(e, mode) });
    this.ghost = h('div.resize-ghost', { hidden: true }, h('span.size-badge'));
    // Strips over the axes: drag to stretch or shrink an axis, double-click to reset it.
    const zone = (orient) => h('div', {
      class: `axis-zone axis-zone-${orient}`, hidden: true,
      onpointerdown: (e) => this.startAxisDrag(e, orient),
      ondblclick: () => this.resetAxis(orient),
    });
    this.zoneV = zone('v');
    this.zoneH = zone('h');
    this.axisGuide = h('div.axis-guide', { hidden: true });
    this.axisBadge = h('span.axis-badge', { hidden: true });
    this.noteLayer = h('div.note-handles');
    this.frame = h('div.plot-frame', {
      tabindex: 0, 'aria-label': 'Graph preview. Drag its edges, or use Shift + arrow keys, to resize. Drag along an axis to stretch it.',
      onkeydown: (e) => this.keyResize(e),
    }, h('div.plot-clip', this.img), this.zoneV, this.zoneH, this.noteLayer, this.axisGuide, this.axisBadge,
    handle('e', 'Drag to change the width'), handle('s', 'Drag to change the height'), handle('se', 'Drag to resize (hold Shift to keep the shape)'), this.ghost);
    this.stage = h('div.stage', { class: 'fit' }, this.frame);
    this.status = h('div.preview-status');
    this.formatHost = h('div.format-panel');
    this.below = h('div.preview-below');
    const dpi = input(g.size.dpi || 300, (v) => { g.size.dpi = v; this.app.store.change(g.id); }, { type: 'number', step: 50, min: 72, max: 1200, width: '64px', k: 'dpi' });
    const dpiWrap = h('label.size', 'dpi', dpi);
    this.svgText = true;
    this.fmtHost = h('span.fmt-pick');
    // Format buttons; SVG can keep its text as text (editable in Illustrator / Inkscape).
    const pickFormat = () => fill(this.fmtHost,
      segmented([['pdf', 'PDF'], ['svg', 'SVG'], ['png', 'PNG'], ['tiff', 'TIFF']], this.exportFmt, (v) => {
        this.exportFmt = v;
        dpiWrap.hidden = !['png', 'tiff'].includes(v);
        pickFormat();
      }, { small: true, k: 'fmt' }),
      this.exportFmt === 'svg' ? checkbox(this.svgText, 'editable text', (v) => { this.svgText = v; }, {
        k: 'svg-text', title: 'Keep text as text, to edit it in Illustrator or Inkscape (it then uses the fonts of the computer that opens it). Off: text is drawn as shapes and looks the same everywhere.',
      }) : null);
    pickFormat();
    dpiWrap.hidden = true;
    fill(this.right,
      h('div.preview-bar',
        sizeCtl('width', 'W'), h('span.times', '×'), sizeCtl('height', 'H'), h('span.muted', 'inches'),
        segmented([['fit', 'Fit'], ['100', '100%']], this.zoom, (z) => this.setZoom(z), { small: true, k: 'zoom' }),
        h('span.grow'),
        this.fmtHost, dpiWrap,
        button('Export', () => this.exportPlot(), { iconName: 'download', kind: 'primary', k: 'export' })),
      this.stage, this.status, this.formatHost, this.below);
    this.zoomHost = this.right.querySelector('.segmented');
    this.resize = new ResizeObserver(() => this.fitImage());
    this.resize.observe(this.right);
  }

  setSize(width, height) {
    const g = this.item;
    g.size.width = width;
    g.size.height = height;
    this.widthInput.value = width;
    this.heightInput.value = height;
    this.changed();
    this.fitImage();
  }

  startResize(e, mode) {
    if (e.button !== 0) return;
    e.preventDefault();
    const g = this.item;
    const pxPerIn = this.img.getBoundingClientRect().width / (Number(g.size.width) || 5);
    const start = { x: e.clientX, y: e.clientY, w: Number(g.size.width) || 5, h: Number(g.size.height) || 4 };
    const clamp = (v) => Math.min(30, Math.max(1, Math.round(v * 10) / 10));
    let next = null;
    this.frame.classList.add('resizing');
    const move = (ev) => {
      let w = start.w;
      let ht = start.h;
      if (mode !== 's') w = start.w + (ev.clientX - start.x) / pxPerIn;
      if (mode !== 'e') ht = start.h + (ev.clientY - start.y) / pxPerIn;
      if (mode === 'se' && ev.shiftKey) ht = w * (start.h / start.w);
      next = [clamp(w), clamp(ht)];
      this.ghost.hidden = false;
      Object.assign(this.ghost.style, { width: `${next[0] * pxPerIn}px`, height: `${next[1] * pxPerIn}px` });
      this.ghost.firstChild.textContent = `${next[0]} × ${next[1]} in`;
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      this.frame.classList.remove('resizing');
      this.ghost.hidden = true;
      if (next) this.setSize(next[0], next[1]);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  keyResize(e) {
    if (!e.shiftKey || !e.key.startsWith('Arrow')) return;
    e.preventDefault();
    const g = this.item;
    const step = e.altKey ? 0.5 : 0.1;
    const r = (v) => Math.min(30, Math.max(1, Math.round(v * 10) / 10));
    let w = Number(g.size.width) || 5;
    let ht = Number(g.size.height) || 4;
    if (e.key === 'ArrowRight') w += step;
    if (e.key === 'ArrowLeft') w -= step;
    if (e.key === 'ArrowDown') ht += step;
    if (e.key === 'ArrowUp') ht -= step;
    this.setSize(r(w), r(ht));
  }

  // ---- dragging an axis to change its range -------------------------------------------------

  // Which scale an on-screen axis belongs to (X and Y swap when the graph is flipped).
  axisScale(orient) {
    const g = this.item;
    const which = (orient === 'v') !== !!g.flip ? 'y' : 'x';
    g[`${which}_scale`] = g[`${which}_scale`] || { trans: 'identity' };
    return { which, scale: g[`${which}_scale`] };
  }

  placeAxisZones() {
    const geo = this.geometry;
    const pct = (v) => `${(v * 100).toFixed(3)}%`;
    const label = (orient) => `Drag to stretch or shrink the ${this.axisScale(orient).which.toUpperCase()} axis. Double-click to reset it.`;
    if (geo?.v) {
      const w = Math.min(geo.left, 0.14);
      Object.assign(this.zoneV.style, { left: pct(geo.left - w), width: pct(w + 0.015), top: pct(geo.top), height: pct(geo.bottom - geo.top) });
      this.zoneV.title = label('v');
    }
    if (geo?.h) {
      const ht = Math.min(1 - geo.bottom, 0.14);
      Object.assign(this.zoneH.style, { left: pct(geo.left), width: pct(geo.right - geo.left), top: pct(geo.bottom - 0.015), height: pct(ht + 0.015) });
      this.zoneH.title = label('h');
    }
    this.zoneV.hidden = !geo?.v;
    this.zoneH.hidden = !geo?.h;
  }

  // The value grabbed follows the pointer; the far end of the axis stays put.
  startAxisDrag(e, orient) {
    const geo = this.geometry;
    if (e.button !== 0 || !geo?.[orient]) return;
    e.preventDefault();
    e.stopPropagation();
    const { which, scale } = this.axisScale(orient);
    const rect = this.img.getBoundingClientRect();
    const [r0, r1] = geo[orient].range;
    // Screen positions of the low and high ends of the visible range.
    const vertical = orient === 'v';
    const lo = vertical ? rect.top + geo.bottom * rect.height : rect.left + geo.left * rect.width;
    const hi = vertical ? rect.top + geo.top * rect.height : rect.left + geo.right * rect.width;
    const pos = (ev) => (vertical ? ev.clientY : ev.clientX);
    const start = pos(e);
    const v0 = r0 + ((start - lo) / (hi - lo)) * (r1 - r0);
    const keepLow = Math.abs(start - lo) > Math.abs(start - hi);
    const anchor = keepLow ? lo : hi;
    let next = null;
    this.frame.classList.add('axis-dragging');
    this.axisGuide.className = `axis-guide axis-guide-${orient}`;
    const move = (ev) => {
      const p = pos(ev);
      const frac = Math.max(0.05, (keepLow ? p - lo : hi - p) / (hi - lo));
      const range = keepLow ? [r0, r0 + (v0 - r0) / frac] : [r1 - (r1 - v0) / frac, r1];
      next = this.rangeToLimits(range, scale);
      // Live preview: stretch the picture around the fixed end until R redraws it.
      const k = (p - anchor) / (start - anchor);
      if (Number.isFinite(k) && k > 0.05) {
        const origin = vertical ? `50% ${anchor - rect.top}px` : `${anchor - rect.left}px 50%`;
        this.img.style.transformOrigin = origin;
        this.img.style.transform = vertical ? `scaleY(${k})` : `scaleX(${k})`;
      }
      const frameRect = this.frame.getBoundingClientRect();
      this.axisGuide.hidden = false;
      if (vertical) Object.assign(this.axisGuide.style, { top: `${p - frameRect.top}px`, left: `${geo.left * 100}%`, width: `${(geo.right - geo.left) * 100}%`, height: '' });
      else Object.assign(this.axisGuide.style, { left: `${p - frameRect.left}px`, top: `${geo.top * 100}%`, height: `${(geo.bottom - geo.top) * 100}%`, width: '' });
      this.axisBadge.hidden = false;
      this.axisBadge.textContent = `${which.toUpperCase()} axis: ${fmtNum(next[0])} to ${fmtNum(next[1])}`;
      Object.assign(this.axisBadge.style, { left: `${ev.clientX - frameRect.left + 14}px`, top: `${ev.clientY - frameRect.top + 14}px` });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      this.frame.classList.remove('axis-dragging');
      this.axisGuide.hidden = true;
      this.axisBadge.hidden = true;
      if (!next) { this.img.style.transform = ''; return; }
      scale.min = next[0];
      scale.max = next[1];
      this.changed(true);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  // A visible range (in the scale's own units, including ggplot2's padding)
  // back to the axis minimum and maximum to type into coord_cartesian().
  rangeToLimits([a, b], scale) {
    const lowPad = scale.from_zero ? 0 : 0.05;
    const highPad = 0.05;
    const d = (b - a) / (1 + lowPad + highPad);
    const l1 = a + lowPad * d;
    const l2 = l1 + d;
    const trans = scale.trans || 'identity';
    const inverse = { identity: (v) => v, log10: (v) => 10 ** v, log2: (v) => 2 ** v, sqrt: (v) => v * Math.abs(v) }[trans] || ((v) => v);
    let out = [inverse(l1), inverse(l2)];
    if (scale.reverse && trans === 'identity') out = out.map((v) => -v);
    out.sort((x, y) => x - y);
    if (trans === 'log10' || trans === 'log2') return out.map((v) => Number(v.toPrecision(2)));
    const step = 10 ** (Math.floor(Math.log10(Math.abs(out[1] - out[0]) || 1)) - 1);
    return out.map((v) => Number((Math.round(v / step) * step).toPrecision(12)));
  }

  resetAxis(orient) {
    const { scale } = this.axisScale(orient);
    scale.min = '';
    scale.max = '';
    this.changed(true);
  }

  // "Fit" scales the plot to the space available, keeping its proportions;
  // "100%" shows it at its real size (1 inch = 96 screen pixels).
  fitImage() {
    const s = this.item.size || {};
    const w = (Number(s.width) || 5) * 96;
    const ht = (Number(s.height) || 4) * 96;
    if (this.zoom !== 'fit') { this.img.style.width = `${w}px`; return; }
    const availW = this.right.clientWidth - 48;
    // The graph gets most of the pane's height; the formatting panel sits below it.
    const stacked = getComputedStyle(this.el).display !== 'grid';
    const paneH = stacked ? window.innerHeight * 0.55 : (this.right.clientHeight - (this.right.querySelector('.preview-bar')?.offsetHeight || 50)) * 0.62;
    const availH = Math.max(220, paneH);
    const scale = Math.max(0.2, Math.min(availW / w, availH / ht, 1.5));
    this.img.style.width = `${Math.round(w * scale)}px`;
  }

  setZoom(z) {
    this.zoom = z;
    this.stage.className = `stage ${z === 'fit' ? 'fit' : 'actual'}`;
    const seg = segmented([['fit', 'Fit'], ['100', '100%']], z, (v) => this.setZoom(v), { small: true, k: 'zoom' });
    this.zoomHost.replaceWith(seg);
    this.zoomHost = seg;
    this.fitImage();
  }

  async renderPlot() {
    const g = this.item;
    if (!getItem(this.app.store.project, g.id)) return;
    this.stage.classList.add('busy');
    let res;
    try {
      res = await this.app.engine.render(g.id);
    } catch (e) {
      res = { ok: false, error: e.message };
    }
    this.stage.classList.remove('busy');
    if (res.ok && res.svg) {
      if (this.url) URL.revokeObjectURL(this.url);
      this.url = URL.createObjectURL(new Blob([res.svg], { type: 'image/svg+xml' }));
      this.img.src = this.url;
      this.img.style.transform = '';
      this.geometry = res.geometry || null;
      this.placeAxisZones();
      this.placeNoteHandles();
      this.fitImage();
      this.stage.classList.remove('stale');
      fill(this.status);
    } else {
      this.img.style.transform = '';
      this.geometry = null;
      this.placeAxisZones();
      this.placeNoteHandles();
      this.stage.classList.toggle('stale', !!this.url);
      if (!this.url) this.img.removeAttribute('src');
      fill(this.status, messageBox(res.incomplete ? 'info' : 'error', res.error || 'Could not draw the graph.'));
    }
    const r = this.app.engine.result(g.id);
    fill(this.below, 
      warningsBox(res.warnings),
      section('R code for this graph', codeBlock(r?.code || ''), { k: 'gcode', open: false }));
  }

  async exportPlot() {
    const g = this.item;
    const fmt = this.exportFmt;
    const want = fmt === 'svg' && this.svgText ? 'svg_text' : fmt;
    try {
      toast(`Preparing ${fmt.toUpperCase()}…`);
      const out = await this.app.engine.exportGraph(g.id, want, { width: g.size.width, height: g.size.height, dpi: g.size.dpi || 300 });
      download(out.bytes, safeFilename(g.name, fmt), MIME[fmt]);
      if (want === 'svg_text' && out.format !== 'svg_text') toast('Saved the SVG with its text drawn as shapes: editable text needs the svglite R package, which could not be loaded here.', 'info', 8000);
    } catch (e) {
      toast(`Export failed: ${e.message}`, 'error', 8000);
    }
  }
}

function fmtNum(v) {
  return Number.isFinite(v) ? String(Number(v.toPrecision(4))) : '–';
}

const DEFAULT_SWATCHES = ['#4c72b0', '#dd8452', '#55a868', '#c44e52', '#8172b3', '#937860', '#da8bc3', '#8c8c8c', '#ccb974', '#64b5cd'];

function defaultConst(a) {
  switch (AES[a].kind) {
    case 'colour': return '#000000';
    case 'shape': return 16;
    case 'linetype': return 'dashed';
    default: return AES[a].def ?? 1;
  }
}

