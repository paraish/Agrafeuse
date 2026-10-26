// The graph builder: layers on the left, live preview on the right.
import { h, fill, rebuild, debounce, download, safeFilename } from './dom.js';
import {
  field, select, bindSelect, bindInput, bindCheck, checkbox, colour, segmented, iconButton, button,
  columnOptions, levelsOf, section, codeBlock, messageBox, input, toast,
} from './widgets.js';
import { itemHeader, warningsBox } from './common.js';
import { GEOMS, GEOM_CATEGORIES, AES, SHAPES, LINETYPES, THEMES, PALETTES, geomDefaults } from '../codegen/graph.js';
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
      section('Titles and axes', this.axes(), { k: 'axes', open: false }),
      section('Colours', this.colours(), { k: 'colours', open: false }),
      section('Style', this.style(), { k: 'style', open: false }),
      section('Custom ggplot2 code', this.customCode(), { k: 'custom', open: !!g.custom }));
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

  // ---- titles, axes, colours, style -------------------------------------------------------

  mainLayer() {
    return this.item.layers.find((l) => !GEOMS[l.geom].noData && l.aes?.x?.mode === 'col');
  }

  axes() {
    const g = this.item;
    const L = g.labels = g.labels || {};
    const ch = (s) => () => this.changed(s);
    const main = this.mainLayer();
    const xNumeric = main && this.schema(main.dataset)?.columns?.find((c) => c.name === main.aes.x.col)?.type === 'numeric' && !main.aes.x.factor;
    const axis = (which, s, label) => h('div.axis-block',
      h('h4', label),
      h('div.params',
        h('div.param', h('label', 'Scale'), bindSelect(s, 'trans', [['identity', 'Linear'], ['log10', 'Log 10'], ['log2', 'Log 2'], ['sqrt', 'Square root']], ch(), { k: `${which}-trans` })),
        h('div.param', h('label', 'Minimum'), bindInput(s, 'min', ch(), { type: 'number', k: `${which}-min`, width: '80px', placeholder: 'auto' })),
        h('div.param', h('label', 'Maximum'), bindInput(s, 'max', ch(), { type: 'number', k: `${which}-max`, width: '80px', placeholder: 'auto' })),
        h('div.param', bindCheck(s, 'from_zero', 'Start exactly at 0', ch(), { k: `${which}-zero` }))));
    g.x_scale = g.x_scale || { trans: 'identity' };
    g.y_scale = g.y_scale || { trans: 'identity' };
    return [
      field('Title', bindInput(L, 'title', ch(), { k: 'title', placeholder: '(none)' })),
      h('div.row2',
        field('X axis title', h('div.inline', bindInput(L, 'x', ch(), { k: 'xlab', placeholder: main?.aes?.x?.col || '(column name)' }), bindCheck(L, 'hide_x', 'hide', ch(), { k: 'hidex' }))),
        field('Y axis title', h('div.inline', bindInput(L, 'y', ch(), { k: 'ylab', placeholder: '(column name)' }), bindCheck(L, 'hide_y', 'hide', ch(), { k: 'hidey' })))),
      h('div.row2',
        field('Legend title', h('div.inline', bindInput(L, 'legend', ch(), { k: 'leglab', placeholder: '(column name)' }), bindCheck(L, 'hide_legend_title', 'hide', ch(), { k: 'hideleg' }))),
        field('X labels', segmented([['0', 'Flat'], ['45', '45°'], ['90', '90°']], String(g.theme?.x_angle || 0), (v) => { g.theme.x_angle = Number(v); this.changed(true); }, { k: 'xangle', small: true }))),
      axis('y', g.y_scale, 'Y axis'),
      xNumeric ? axis('x', g.x_scale, 'X axis') : h('div.hint', 'The X axis shows groups. Reorder groups with a "Reorder groups" step in a transform.'),
    ];
  }

  colours() {
    const g = this.item;
    g.palette = g.palette || { name: 'default', manual: {} };
    const owner = g.layers.find((l) => ['colour', 'fill'].some((a) => l.aes?.[a]?.mode === 'col'));
    const aesKey = owner ? (owner.aes.fill?.mode === 'col' ? 'fill' : 'colour') : null;
    const levels = owner ? levelsOf(this.schema(owner.dataset), owner.aes[aesKey].col) : [];
    const pal = g.palette;
    const out = [field('Palette for colour / fill columns', bindSelect(pal, 'name', PALETTES, () => this.changed(true), { k: 'palette' }))];
    if (!owner) out.push(h('div.hint', 'No layer maps Colour or Fill to a column yet. Fixed colours are set in each layer.'));
    if (pal.name === 'manual' && owner) {
      pal.manual = pal.manual || {};
      out.push(h('div.swatches', levels.map((lv, j) => h('div.swatch',
        colour(pal.manual[lv] || DEFAULT_SWATCHES[j % DEFAULT_SWATCHES.length], (v) => { pal.manual[lv] = v; this.changed(); }, { k: `sw-${lv}` }),
        h('span', lv)))));
      levels.forEach((lv, j) => { if (!pal.manual[lv]) pal.manual[lv] = DEFAULT_SWATCHES[j % DEFAULT_SWATCHES.length]; });
    }
    return out;
  }

  style() {
    const g = this.item;
    g.theme = g.theme || { name: 'prism', base_size: 14 };
    g.facet = g.facet || { by: '' };
    const ch = (s) => () => this.changed(s);
    const main = this.mainLayer();
    const cols = main ? columnOptions(this.schema(main.dataset)) : [];
    return [
      h('div.row2',
        field('Theme', bindSelect(g.theme, 'name', THEMES.map(([k, l]) => [k, l]), ch(), { k: 'theme' })),
        field('Font size (pt)', bindInput(g.theme, 'base_size', ch(), { type: 'number', min: 6, max: 40, step: 1, k: 'fontsize' }))),
      h('div.row2',
        field('Legend', bindSelect(g.theme, 'legend', [['right', 'Right'], ['top', 'Top'], ['bottom', 'Bottom'], ['left', 'Left'], ['none', 'Hidden']], ch(), { k: 'legend' })),
        field('Orientation', bindCheck(g, 'flip', 'Horizontal (flip X and Y)', ch(), { k: 'flip' }))),
      h('div.row2',
        field('Separate panels by', bindSelect(g.facet, 'by', cols, ch(), { placeholder: '(one panel)', k: 'facet' })),
        g.facet.by ? field('Panel axes', bindSelect(g.facet, 'scales', [['fixed', 'Same for all'], ['free_y', 'Own Y axis'], ['free_x', 'Own X axis'], ['free', 'Own X and Y']], ch(), { k: 'fscales' })) : null),
    ];
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
    const sizeCtl = (key, label) => h('label.size', label, input(g.size[key], (v) => { if (v > 0 && v <= 50) { g.size[key] = v; this.changed(); } }, { type: 'number', step: 0.25, min: 1, max: 50, width: '62px', k: `size-${key}` }));
    this.img = h('img.plot', { alt: `Preview of ${g.name}`, onload: () => this.fitImage() });
    this.stage = h('div.stage', { class: 'fit' }, this.img);
    this.status = h('div.preview-status');
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
      this.stage, this.status, this.below);
    this.zoomHost = this.right.querySelector('.segmented');
    this.resize = new ResizeObserver(() => this.fitImage());
    this.resize.observe(this.right);
  }

  // "Fit" scales the plot to the space available, keeping its proportions;
  // "100%" shows it at its real size (1 inch = 96 screen pixels).
  fitImage() {
    const s = this.item.size || {};
    const w = (Number(s.width) || 5) * 96;
    const ht = (Number(s.height) || 4) * 96;
    if (this.zoom !== 'fit') { this.img.style.width = `${w}px`; return; }
    const availW = this.right.clientWidth - 40;
    // On narrow screens the panes stack and the page scrolls, so use the window height.
    const stacked = getComputedStyle(this.el).display !== 'grid';
    const paneH = stacked ? window.innerHeight * 0.55 : this.right.clientHeight - (this.right.querySelector('.preview-bar')?.offsetHeight || 50) - 70;
    const availH = Math.max(200, paneH);
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

