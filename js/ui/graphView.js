// The graph builder: layers on the left; the live preview, which can be resized by
// dragging, with the formatting controls underneath it on the right.
import { h, fill, rebuild, debounce, download, safeFilename } from './dom.js';
import {
  field, select, bindSelect, bindInput, bindCheck, checkbox, colour, segmented, iconButton, button,
  columnOptions, levelsOf, section, codeBlock, messageBox, input, toast,
} from './widgets.js';
import { itemHeader, warningsBox } from './common.js';
import { GEOMS, GEOM_CATEGORIES, AES, SHAPES, LINETYPES, THEMES, PALETTES, NUMBER_FORMATS, FONTS, geomDefaults } from '../codegen/graph.js';
import { TESTS } from '../codegen/stats.js';
import { datasets, itemsOf, getItem, depsOf, clone } from '../model.js';

const MIME = { svg: 'image/svg+xml', pdf: 'application/pdf', png: 'image/png', tiff: 'image/tiff' };
const ANN_KINDS = { brackets: 'P value brackets', label: 'Result text', curve: 'Fitted curve' };

export class GraphView {
  constructor(app, item) {
    this.app = app;
    this.item = item;
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
  }

  schema(id) {
    return this.app.engine.schemaOf(id);
  }

  // ---- controls -------------------------------------------------------------------------

  controls() {
    const g = this.item;
    return h('div',
      itemHeader(this.app, g, 'Graph'),
      section('Layers', [
        h('div.hint', 'Each layer draws the data one way. Layers listed first are drawn first (underneath).'),
        ...g.layers.map((l, i) => this.layerCard(l, i)),
        h('div.add-row', button('Add layer', () => this.addLayer(), { iconName: 'plus', kind: 'primary', k: 'add-layer' })),
      ], { k: 'layers', sub: `${g.layers.length}` }),
      section('Statistics on the graph', this.annotations(), { k: 'stats' }),
      section('Custom ggplot2 code', this.customCode(), { k: 'custom', open: !!g.custom }),
      h('div.hint', 'Titles, axes, fonts, colours and layout are under the graph.'));
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
      const schema = geom.noData ? null : this.schema(l.dataset);
      body = [
        geom.noData ? null : field('Data', bindSelect(l, 'dataset', datasets(this.app.store.project).map((d) => [d.id, d.name]), () => {
          this.changed(true);
          if (!this.schema(l.dataset)) this.app.engine.ensure(l.dataset);
        }, { placeholder: 'Choose a dataset…', k: k('ds') })),
        h('div.aes-grid', geom.aes.map((a) => this.aesRow(l, a, schema, k(`aes-${a}`)))),
        geom.params.length ? h('div.params', geom.params.map((p) => this.paramRow(l, p, k(`p-${p.key}`)))) : null,
      ];
    }
    return h('div.card.layer', { class: l.hidden ? 'off' : '' }, head, h('div.card-body', body));
  }

  aesRow(l, a, schema, k) {
    const def = AES[a];
    const m = l.aes[a] || { mode: 'none' };
    const required = GEOMS[l.geom].required.includes(a);
    const colOpts = columnOptions(schema);
    const colType = schema?.columns?.find((c) => c.name === m.col)?.type;
    const setMap = (patch) => { l.aes[a] = { ...m, ...patch }; };
    const asGroups = (a === 'x' || a === 'colour' || a === 'fill' || a === 'group') && m.mode === 'col' && colType === 'numeric'
      ? checkbox(!!m.factor, 'as groups', (v) => { setMap({ factor: v }); this.changed(); }, { k: `${k}-f`, title: 'Treat the numbers as separate groups (categories)' }) : null;
    const colSelect = () => select(m.col || '', colOpts, (v) => {
      if (v) setMap({ mode: 'col', col: v }); else delete l.aes[a];
      this.changed(true);
    }, { placeholder: required ? 'Choose a column…' : '—', k: `${k}-col` });

    if (def.mapOnly) {
      return h('div.aes-row', h('label', def.label, required ? h('span.req', ' *') : null), h('div.aes-ctl', colSelect(), asGroups));
    }
    const modes = segmented([['none', '—', 'Not set (use the default)'], ['col', 'Column', 'Varies with a column'], ['const', 'Fixed', 'One fixed value']], m.mode, (mode) => {
      if (mode === 'none') delete l.aes[a];
      else if (mode === 'col') l.aes[a] = { mode: 'col', col: l.aes[a]?.col || '' };
      else l.aes[a] = { mode: 'const', value: defaultConst(a) };
      this.changed(true);
    }, { k: `${k}-mode`, small: true });
    let ctl = null;
    if (m.mode === 'col') ctl = colSelect();
    else if (m.mode === 'const') ctl = this.constControl(l, a, m, k);
    return h('div.aes-row', h('label', def.label), h('div.aes-ctl', modes, ctl, asGroups));
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
    if (!geom.noData && !l.dataset) l.dataset = this.item.layers.find((x) => x.dataset)?.dataset || '';
    this.changed(true);
  }

  addLayer() {
    const g = this.item;
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
    const analyses = itemsOf(this.app.store.project, 'analysis');
    const usable = analyses.filter((a) => (TESTS[a.test]?.annotations || []).length);
    if (!usable.length) {
      return [h('div.hint', 'Show p values, fitted curves or test results from an analysis on this graph. First run an analysis on this data.'),
        button('New analysis…', () => this.app.newAnalysisDialog(g.layers.find((l) => l.dataset)?.dataset), { iconName: 'stats' })];
    }
    const cards = (g.annotations || []).map((ann, i) => {
      const an = getItem(this.app.store.project, ann.analysis);
      const kinds = (TESTS[an?.test]?.annotations || []);
      const k = (s) => `ann${i}-${s}`;
      const ch = (structural) => () => this.changed(structural);
      let opts = [];
      if (ann.kind === 'brackets') {
        opts = [
          h('div.param', h('label', 'Show'), bindSelect(ann, 'format', [['stars', 'Stars (*, **, ns)'], ['p', 'p = 0.0123'], ['number', '0.0123']], ch(), { k: k('fmt') })),
          h('div.param', bindCheck(ann, 'hide_ns', 'Hide non-significant (ns)', ch(), { k: k('ns') })),
          h('div.param', h('label', 'Start height (blank = automatic)'), bindInput(ann, 'y_start', ch(), { type: 'number', k: k('y0'), width: '80px' })),
          h('div.param', h('label', 'Spacing'), bindInput(ann, 'step', ch(), { type: 'number', step: 0.01, k: k('step'), width: '80px', placeholder: '0.09' })),
          h('div.param', h('label', 'Text size'), bindInput(ann, 'text_size', ch(), { type: 'number', step: 0.5, k: k('ts'), width: '80px', placeholder: '4.5' })),
        ];
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
    });
    return [
      ...cards,
      h('div.add-row', button('Add statistics', () => {
        // Prefer an analysis of the data this graph shows (or of the table it came from).
        const p = this.app.store.project;
        const shown = new Set(g.layers.map((l) => l.dataset).filter(Boolean));
        for (const id of [...shown]) { const src = getItem(p, id); if (src?.kind === 'transform') shown.add(src.input); }
        const a = [...usable].reverse().find((x) => shown.has(x.dataset)) || usable[usable.length - 1];
        g.annotations = g.annotations || [];
        g.annotations.push({ id: `a${Date.now().toString(36)}`, analysis: a.id, kind: TESTS[a.test].annotations[0], format: 'stars', position: 'top-left' });
        this.changed(true);
      }, { iconName: 'plus', k: 'add-ann' })),
      h('div.hint', 'Brackets are drawn between groups on the X axis of the first layer. For two-way designs, put the "within" factor on X and split groups side by side (dodge) by the compared factor.'),
    ];
  }

  // ---- formatting panel (under the graph) --------------------------------------------------

  mainLayer() {
    return this.item.layers.find((l) => !GEOMS[l.geom].noData && l.aes?.x?.mode === 'col');
  }

  renderFormat() {
    if (this.formatHost) rebuild(this.formatHost, () => this.formatPanel());
  }

  formatPanel() {
    const g = this.item;
    g.labels = g.labels || {};
    g.style = g.style || {};
    g.theme = g.theme || { name: 'prism', base_size: 14 };
    // Older projects kept the X label angle on the theme.
    if (g.theme.x_angle !== undefined) {
      g.style.x_text = { ...(g.style.x_text || {}), angle: g.style.x_text?.angle ?? g.theme.x_angle };
      delete g.theme.x_angle;
    }
    const tabs = [['axes', 'Axes'], ['text', 'Title and fonts'], ['legend', 'Legend and colours'], ['layout', 'Layout']];
    this.formatTab = this.formatTab || 'axes';
    const body = {
      axes: () => h('div.fmt-cols', this.axisColumn('x'), this.axisColumn('y')),
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
    const themeBold = (this.item.theme?.name || 'prism') === 'prism';
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
    const owner = g.layers.find((l) => ['colour', 'fill'].some((a) => l.aes?.[a]?.mode === 'col'));
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
    const cols = main ? columnOptions(this.schema(main.dataset)) : [];
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
    this.frame = h('div.plot-frame', {
      tabindex: 0, 'aria-label': 'Graph preview. Drag its edges, or use Shift + arrow keys, to resize.',
      onkeydown: (e) => this.keyResize(e),
    }, this.img, handle('e', 'Drag to change the width'), handle('s', 'Drag to change the height'), handle('se', 'Drag to resize (hold Shift to keep the shape)'), this.ghost);
    this.stage = h('div.stage', { class: 'fit' }, this.frame);
    this.status = h('div.preview-status');
    this.formatHost = h('div.format-panel');
    this.below = h('div.preview-below');
    const dpi = input(g.size.dpi || 300, (v) => { g.size.dpi = v; this.app.store.change(g.id); }, { type: 'number', step: 50, min: 72, max: 1200, width: '64px', k: 'dpi' });
    const dpiWrap = h('label.size', 'dpi', dpi);
    const fmt = select(this.exportFmt, [['pdf', 'PDF'], ['svg', 'SVG'], ['png', 'PNG'], ['tiff', 'TIFF']], (v) => { this.exportFmt = v; dpiWrap.hidden = !['png', 'tiff'].includes(v); }, { k: 'fmt' });
    dpiWrap.hidden = true;
    fill(this.right,
      h('div.preview-bar',
        sizeCtl('width', 'W'), h('span.times', '×'), sizeCtl('height', 'H'), h('span.muted', 'inches'),
        segmented([['fit', 'Fit'], ['100', '100%']], this.zoom, (z) => this.setZoom(z), { small: true, k: 'zoom' }),
        h('span.grow'),
        fmt, dpiWrap,
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
      this.fitImage();
      this.stage.classList.remove('stale');
      fill(this.status);
    } else {
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
    try {
      toast(`Preparing ${fmt.toUpperCase()}…`);
      const bytes = await this.app.engine.exportGraph(g.id, fmt, { width: g.size.width, height: g.size.height, dpi: g.size.dpi || 300 });
      download(bytes, safeFilename(g.name, fmt), MIME[fmt]);
    } catch (e) {
      toast(`Export failed: ${e.message}`, 'error', 8000);
    }
  }
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

