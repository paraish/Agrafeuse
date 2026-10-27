// A data table: the spreadsheet plus import and shortcuts to the next steps,
// with a dplyr pipeline panel on the right whose result can be shown instead
// of the grid.
import { h, fill, icon, pickFile } from './dom.js';
import { button, toast, codeBlock, section } from './widgets.js';
import { Grid } from './grid.js';
import { parseDelimited, tableFromRows, inferColumns, dataCode } from '../codegen/data.js';
import { newTransform, uniqueName } from '../model.js';
import { itemHeader } from './common.js';
import { PipePanel } from './pipePanel.js';

export class DataView {
  constructor(app, item) {
    this.app = app;
    this.item = item;
    this.el = h('div.view.data-view');
    this.mode = 'data';
    this.render();
  }

  destroy() {
    this.grid?.destroy();
    this.pipe?.destroy();
  }

  onChange(e) {
    if (e.id === this.item.id) this.updateInfo();
    this.pipe?.onChange(e);
  }

  // Show the grid ('data') or the pipeline's result ('result').
  show(mode) {
    const piped = this.pipe.open && this.pipe.steps.length > 0;
    this.mode = piped ? mode : 'data';
    this.tabs.hidden = !piped;
    this.gridHost.hidden = this.mode !== 'data';
    this.pipe.resultEl.hidden = this.mode !== 'result';
    for (const b of this.tabs.children) {
      const on = b.dataset.mode === this.mode;
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    }
  }

  render() {
    const it = this.item;
    this.grid?.destroy();
    this.pipe?.destroy();
    this.grid = new Grid(it, {
      onChange: ({ structural }) => this.app.store.change(it.id, { structural }),
    });
    this.pipe = new PipePanel(this.app, it, { onShow: (mode) => this.show(mode) });
    const tab = (mode, label) => h('button', {
      type: 'button', role: 'tab', 'data-mode': mode, 'data-k': `tab-${mode}`, onclick: () => this.show(mode),
    }, label);
    this.tabs = h('div.data-tabs', { role: 'tablist', 'aria-label': 'Show' },
      tab('data', 'Data table'), tab('result', 'Pipeline result'));
    this.gridHost = h('div.grid-host', this.grid.el);
    this.info = h('div.data-info');
    const toolbar = h('div.toolbar',
      button('Import CSV / TSV', () => this.importFile(), { iconName: 'upload', title: 'Replace this table with a CSV or TSV file' }),
      h('span.sep'),
      button('Insert row', () => this.grid.insertRow(), { title: 'Insert a row above the selection' }),
      button('Delete rows', () => this.grid.deleteRows(), { title: 'Delete the selected rows' }),
      button('Insert column', () => this.grid.insertColumn(), { title: 'Insert a column left of the selection' }),
      button('Delete columns', () => this.grid.deleteColumns(), { title: 'Delete the selected columns' }),
      h('span.grow'),
      button('Wide → long', () => this.makeLong(), { iconName: 'transform', title: 'Stack the number columns into group + value columns (needed for most graphs and tests)' }),
      button('Graph it', () => this.graphIt(), { iconName: 'graph', kind: 'primary' }));
    fill(this.el, 
      itemHeader(this.app, it, 'Data table'),
      h('div.hintbar', icon('info'), h('span', 'Type or paste (Ctrl+V) straight from Excel. The top row holds the column names (click one to rename it; the menu under it sets its type). Row names on the left are optional labels such as subject IDs. Each column can be a group, or use one row per observation with columns for the groups (long format).')),
      toolbar,
      h('div.data-body',
        h('div.data-main', this.tabs, this.gridHost, this.pipe.resultEl),
        this.pipe.el),
      this.info,
      section('R code for this table', h('div', { 'data-code': '' }), { k: 'code', open: false }));
    this.el.querySelector('details[data-sec="code"]').addEventListener('toggle', (e) => {
      if (e.target.open) fill(e.target.querySelector('[data-code]'), codeBlock(dataCode(this.item)));
    });
    this.updateInfo();
    this.show(this.pipe.open && this.pipe.steps.length ? this.mode : 'data');
  }

  updateInfo() {
    const { nrow, columns } = inferColumns(this.item);
    const bad = columns.filter((c) => c.bad);
    fill(this.info, 
      h('span', `${nrow} rows × ${columns.length} columns`),
      ...columns.map((c) => h('span.colinfo', { title: c.type === 'numeric' ? 'Numbers' : 'Text / groups' },
        h('b', c.name), c.type === 'numeric' ? ' 123' : ' abc')),
      bad.length ? h('span.warn', `Not numbers (treated as missing): ${bad.map((c) => `${c.name} (${c.bad})`).join(', ')}`) : null);
  }

  async importFile() {
    const file = await pickFile('.csv,.tsv,.txt,text/csv,text/tab-separated-values');
    if (!file) return;
    const text = await file.text();
    const rows = parseDelimited(text);
    if (!rows.length) { toast('That file looks empty.', 'error'); return; }
    const t = tableFromRows(rows[0], rows.slice(1));
    this.item.columns = t.columns;
    this.item.rows = t.rows;
    this.item.rowNames = t.rowNames;
    if (this.item.name.startsWith('Data ')) this.item.name = uniqueName(this.app.store.project, file.name.replace(/\.[^.]+$/, ''));
    this.app.renameItem(this.item);
    this.render();
    toast(`Imported ${t.rows.length} rows from ${file.name}.`);
  }

  makeLong() {
    const { columns } = inferColumns(this.item);
    const nums = columns.filter((c) => c.type === 'numeric').map((c) => c.name);
    if (nums.length < 2) { toast('Wide → long needs at least two number columns.', 'error'); return; }
    const p = this.app.store.project;
    const t = newTransform(p, this.item.id, [{ type: 'pivot_longer', cols: nums, names_to: 'group', values_to: 'value', drop_na: true }],
      uniqueName(p, `${this.item.name} (long)`));
    this.app.store.change(t.id, { structural: true });
    this.app.store.select(t.id);
  }

  graphIt() {
    this.app.newGraphDialog(this.item.id);
  }
}

