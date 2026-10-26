// A spreadsheet for typing or pasting data. Rows are virtualised so large
// tables stay fast. Keyboard: arrows / Tab / Enter move, typing replaces the
// cell, F2 or double-click edits it, Delete clears, Ctrl+C / Ctrl+V copy and
// paste blocks (to and from Excel), Shift+arrows select a range.
import { h, clear } from './dom.js';
import { parseDelimited, isMissing, parseNumber } from '../codegen/data.js';

const ROW_H = 28;
const OVERSCAN = 10;
const TYPE_OPTIONS = [['auto', 'Auto'], ['number', 'Number'], ['text', 'Text']];

export class Grid {
  constructor(table, { onChange, onSelect } = {}) {
    this.t = table;
    this.onChange = onChange || (() => {});
    this.onSelect = onSelect || (() => {});
    this.sel = { r: 0, c: 0, r2: 0, c2: 0 };
    this.editing = null;
    this.dragging = false;

    this.el = h('div.grid', { tabindex: 0, role: 'grid', 'aria-label': 'Data table' });
    this.sheet = h('table.sheet');
    this.editor = h('input.cell-editor', { type: 'text', spellcheck: 'false', autocomplete: 'off' });
    this.editor.hidden = true;
    this.el.append(this.sheet, this.editor);

    this.el.addEventListener('scroll', () => this.scheduleRender());
    this.el.addEventListener('keydown', (e) => this.onKey(e));
    this.el.addEventListener('mousedown', (e) => this.onMouseDown(e));
    this.el.addEventListener('mouseover', (e) => this.onMouseOver(e));
    this.el.addEventListener('dblclick', (e) => this.onDblClick(e));
    window.addEventListener('mouseup', this.onMouseUp = () => { this.dragging = false; });
    this.el.addEventListener('copy', (e) => this.onCopy(e));
    this.el.addEventListener('cut', (e) => { this.onCopy(e); this.clearSelection(); });
    this.el.addEventListener('paste', (e) => this.onPaste(e));
    this.editor.addEventListener('keydown', (e) => this.onEditorKey(e));
    this.editor.addEventListener('blur', () => this.commitEdit());
    this.editor.addEventListener('paste', (e) => {
      const text = e.clipboardData?.getData('text/plain') || '';
      if (/[\t\n]/.test(text.trim())) { e.preventDefault(); this.cancelEdit(); this.pasteText(text); }
    });
    this.computeTypes();
    this.observer = new ResizeObserver(() => this.scheduleRender());
    this.observer.observe(this.el);
    this.render();
  }

  destroy() {
    window.removeEventListener('mouseup', this.onMouseUp);
    this.observer.disconnect();
  }

  // ---- model access --------------------------------------------------------------------
  get ncol() { return this.t.columns.length; }
  get nrowShown() { return Math.max(this.t.rows.length + 25, 40); }
  get(r, c) {
    if (r < 0) return this.t.columns[c]?.name ?? '';
    return this.t.rows[r]?.[c] ?? '';
  }
  set(r, c, v) {
    while (c >= this.ncol) this.t.columns.push({ name: `Column ${this.ncol + 1}`, type: 'auto' });
    if (r < 0) { this.t.columns[c].name = v; return; }
    while (r >= this.t.rows.length) this.t.rows.push([]);
    const row = this.t.rows[r];
    while (row.length < c) row.push('');
    row[c] = v;
  }

  changed(structural = false) {
    this.computeTypes();
    this.render();
    this.onChange({ structural });
  }

  // Which columns hold numbers (for right-alignment and flagging bad cells).
  computeTypes() {
    this.types = this.t.columns.map((col, j) => {
      if (col.type === 'number') return 'numeric';
      if (col.type === 'text') return 'text';
      for (const row of this.t.rows) {
        const v = row[j];
        if (!isMissing(v) && parseNumber(v) === undefined) return 'text';
      }
      return 'numeric';
    });
  }

  rect() {
    const { r, c, r2, c2 } = this.sel;
    return { r0: Math.min(r, r2), r1: Math.max(r, r2), c0: Math.min(c, c2), c1: Math.max(c, c2) };
  }

  // ---- rendering ---------------------------------------------------------------------------
  scheduleRender() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => { this.raf = null; this.render(); });
  }

  render() {
    const height = this.el.clientHeight || 600;
    const first = Math.max(0, Math.floor(this.el.scrollTop / ROW_H) - OVERSCAN);
    const last = Math.min(this.nrowShown, Math.ceil((this.el.scrollTop + height) / ROW_H) + OVERSCAN);
    const { r0, r1, c0, c1 } = this.rect();
    const ncolShown = this.ncol + 1;

    const colgroup = h('colgroup', h('col', { style: { width: '46px' } }),
      Array.from({ length: ncolShown }, () => h('col', { style: { width: '128px' } })));

    const headCells = [h('th.corner', { title: 'Select all', 'data-r': 'all' }, '')];
    for (let c = 0; c < ncolShown; c++) {
      const ghost = c === this.ncol;
      const selected = r0 === -1 && c >= c0 && c <= c1;
      const col = this.t.columns[c];
      const typeSel = ghost ? null : h('select.coltype', {
        title: 'Column type: Auto decides from the values',
        'aria-label': `Type of column ${col.name}`,
        onmousedown: (e) => e.stopPropagation(),
        onchange: (e) => { col.type = e.target.value; this.changed(); },
      }, TYPE_OPTIONS.map(([v, l]) => h('option', { value: v, selected: col.type === v }, l)));
      headCells.push(h('th.colhead', {
        'data-r': -1, 'data-c': c,
        class: [ghost ? 'ghost' : '', selected ? 'sel' : '', this.types[c] === 'numeric' ? 'num' : ''].join(' '),
      }, h('div.colname', ghost ? '+ new column' : (col.name || `Column ${c + 1}`)), typeSel));
    }

    const body = [h('tr.spacer', h('td', { colspan: ncolShown + 1, style: { height: `${first * ROW_H}px` } }))];
    for (let r = first; r < last; r++) {
      const cells = [h('th.rowhead', { 'data-r': r, 'data-c': 'row', class: r >= r0 && r <= r1 && c0 === 0 && c1 >= this.ncol - 1 ? 'sel' : '' }, String(r + 1))];
      const row = this.t.rows[r];
      for (let c = 0; c < ncolShown; c++) {
        const v = row?.[c] ?? '';
        const cls = [];
        if (r >= r0 && r <= r1 && c >= c0 && c <= c1) cls.push('sel');
        if (r === this.sel.r && c === this.sel.c) cls.push('active');
        if (c === this.ncol) cls.push('ghost');
        else if (this.types[c] === 'numeric') {
          cls.push('num');
          if (this.t.columns[c].type === 'number' && !isMissing(v) && parseNumber(v) === undefined) cls.push('bad');
        }
        cells.push(h('td', { 'data-r': r, 'data-c': c, class: cls.join(' ') }, v));
      }
      body.push(h('tr', cells));
    }
    body.push(h('tr.spacer', h('td', { colspan: ncolShown + 1, style: { height: `${Math.max(0, this.nrowShown - last) * ROW_H}px` } })));

    clear(this.sheet);
    this.sheet.append(colgroup, h('thead', h('tr', headCells)), h('tbody', body));
    if (this.editing) this.placeEditor();
  }

  cellEl(r, c) {
    return this.sheet.querySelector(`[data-r="${r}"][data-c="${c}"]`);
  }

  scrollIntoView(r) {
    if (r < 0) return;
    const top = r * ROW_H;
    const head = this.sheet.tHead?.offsetHeight || 50;
    const view = this.el.clientHeight - head;
    if (top < this.el.scrollTop) this.el.scrollTop = top;
    else if (top + ROW_H > this.el.scrollTop + view) this.el.scrollTop = top + ROW_H - view;
  }

  select(r, c, extend = false) {
    r = Math.max(-1, Math.min(r, this.nrowShown - 1));
    c = Math.max(0, Math.min(c, this.ncol));
    if (extend) { this.sel.r2 = r; this.sel.c2 = c; } else this.sel = { r, c, r2: r, c2: c };
    this.scrollIntoView(extend ? this.sel.r2 : r);
    this.render();
    this.onSelect(this.rect());
  }

  move(dr, dc, extend = false) {
    const base = extend ? { r: this.sel.r2, c: this.sel.c2 } : this.sel;
    this.select(base.r + dr, base.c + dc, extend);
  }

  // ---- editing --------------------------------------------------------------------------------
  startEdit(initial = null) {
    const { r, c } = this.sel;
    this.editing = { r, c, quick: initial !== null };
    this.editor.value = initial !== null ? initial : this.get(r, c);
    this.editor.hidden = false;
    this.placeEditor();
    this.editor.focus();
    const n = this.editor.value.length;
    this.editor.setSelectionRange(n, n);
  }

  placeEditor() {
    const cell = this.cellEl(this.editing.r, this.editing.c);
    if (!cell) { this.editor.style.top = '-1000px'; return; }
    Object.assign(this.editor.style, {
      top: `${cell.offsetTop}px`, left: `${cell.offsetLeft}px`,
      width: `${cell.offsetWidth}px`, height: `${cell.offsetHeight}px`,
    });
  }

  commitEdit() {
    if (!this.editing) return;
    const { r, c } = this.editing;
    const value = this.editor.value;
    this.editing = null;
    this.editor.hidden = true;
    if (value !== this.get(r, c)) {
      const structural = r < 0 || c >= this.ncol;
      this.set(r, c, value);
      this.changed(structural);
    } else this.render();
  }

  cancelEdit() {
    this.editing = null;
    this.editor.hidden = true;
    this.el.focus();
    this.render();
  }

  onEditorKey(e) {
    const ed = this.editing;
    if (!ed) return;
    const go = (dr, dc) => { e.preventDefault(); this.commitEdit(); this.el.focus(); this.move(dr, dc); };
    if (e.key === 'Enter') go(e.shiftKey ? -1 : 1, 0);
    else if (e.key === 'Tab') go(0, e.shiftKey ? -1 : 1);
    else if (e.key === 'Escape') { e.preventDefault(); this.cancelEdit(); }
    else if (ed.quick && e.key === 'ArrowDown') go(1, 0);
    else if (ed.quick && e.key === 'ArrowUp') go(-1, 0);
    else if (ed.quick && e.key === 'ArrowLeft' && this.editor.selectionStart === 0) go(0, -1);
    else if (ed.quick && e.key === 'ArrowRight' && this.editor.selectionStart === this.editor.value.length) go(0, 1);
  }

  // ---- keyboard & mouse ------------------------------------------------------------------------
  onKey(e) {
    if (this.editing || e.target !== this.el) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key;
    if (k === 'ArrowDown') { e.preventDefault(); this.move(1, 0, e.shiftKey); }
    else if (k === 'ArrowUp') { e.preventDefault(); this.move(-1, 0, e.shiftKey); }
    else if (k === 'ArrowRight') { e.preventDefault(); this.move(0, 1, e.shiftKey); }
    else if (k === 'ArrowLeft') { e.preventDefault(); this.move(0, -1, e.shiftKey); }
    else if (k === 'Tab') { e.preventDefault(); this.move(0, e.shiftKey ? -1 : 1); }
    else if (k === 'Enter') { e.preventDefault(); this.move(e.shiftKey ? -1 : 1, 0); }
    else if (k === 'F2') { e.preventDefault(); this.startEdit(); }
    else if (k === 'Delete' || k === 'Backspace') { e.preventDefault(); this.clearSelection(); }
    else if (mod && (k === 'a' || k === 'A')) {
      e.preventDefault();
      this.sel = { r: 0, c: 0, r2: Math.max(0, this.t.rows.length - 1), c2: Math.max(0, this.ncol - 1) };
      this.render();
    } else if (!mod && !e.altKey && k.length === 1) {
      e.preventDefault();
      this.startEdit(k);
    }
  }

  target(e) {
    const cell = e.target.closest('td[data-r], th[data-r]');
    if (!cell || !this.el.contains(cell)) return null;
    const r = cell.getAttribute('data-r');
    const c = cell.getAttribute('data-c');
    return { r: r === 'all' ? 'all' : Number(r), c: c === 'row' ? 'row' : Number(c) };
  }

  onMouseDown(e) {
    if (e.target === this.editor || e.target.closest('select')) return;
    const t = this.target(e);
    if (!t) return;
    if (this.editing) this.commitEdit();
    e.preventDefault();
    this.el.focus({ preventScroll: true });
    if (t.r === 'all') {
      this.sel = { r: 0, c: 0, r2: Math.max(0, this.t.rows.length - 1), c2: Math.max(0, this.ncol - 1) };
      this.render();
      return;
    }
    if (t.c === 'row') {
      const keep = e.shiftKey ? this.sel.r : t.r;
      this.sel = { r: keep, c: 0, r2: t.r, c2: Math.max(0, this.ncol - 1) };
      this.render();
      this.onSelect(this.rect());
      return;
    }
    if (t.r === -1 && t.c === this.ncol) {
      // "+ new column": add it and start typing its name.
      this.set(-1, t.c, `Column ${t.c + 1}`);
      this.changed(true);
      this.select(-1, t.c);
      this.startEdit('');
      return;
    }
    this.select(t.r, t.c, e.shiftKey);
    this.dragging = true;
  }

  onMouseOver(e) {
    if (!this.dragging) return;
    const t = this.target(e);
    if (!t || t.c === 'row' || t.r === 'all') return;
    if (t.r !== this.sel.r2 || t.c !== this.sel.c2) this.select(t.r, t.c, true);
  }

  onDblClick(e) {
    const t = this.target(e);
    if (!t || t.c === 'row' || t.r === 'all') return;
    this.select(t.r, t.c);
    this.startEdit();
  }

  // ---- clipboard & range operations -------------------------------------------------------------
  onCopy(e) {
    if (this.editing) return;
    const { r0, r1, c0, c1 } = this.rect();
    const lines = [];
    for (let r = r0; r <= r1; r++) {
      const vals = [];
      for (let c = c0; c <= c1; c++) vals.push(this.get(r, c));
      lines.push(vals.join('\t'));
    }
    e.clipboardData.setData('text/plain', lines.join('\n'));
    e.preventDefault();
  }

  onPaste(e) {
    if (this.editing) return;
    e.preventDefault();
    this.pasteText(e.clipboardData?.getData('text/plain') || '');
  }

  // Paste a block of tab-separated text at the selection. Pasting into the
  // header row uses the first line as column names.
  pasteText(text) {
    if (!text) return;
    // Spreadsheets put tab-separated text on the clipboard. Anything else is
    // one value per line (never split on commas: "1,5" may be a decimal).
    const clean = text.replace(/\r?\n$/, '');
    const rows = clean.includes('\t') ? parseDelimited(clean, '\t') : clean.split(/\r?\n/).map((l) => [l]);
    if (!rows.length) return;
    const { r0, c0 } = this.rect();
    let r = r0;
    let block = rows;
    if (r === -1) {
      rows[0].forEach((v, j) => this.set(-1, c0 + j, v.trim()));
      block = rows.slice(1);
      r = 0;
    }
    block.forEach((line, i) => line.forEach((v, j) => this.set(r + i, c0 + j, v.trim())));
    this.sel = { r: r0, c: c0, r2: r + Math.max(0, block.length - 1), c2: c0 + Math.max(...rows.map((x) => x.length)) - 1 };
    this.changed(true);
  }

  clearSelection() {
    const { r0, r1, c0, c1 } = this.rect();
    let touched = false;
    for (let r = Math.max(0, r0); r <= r1; r++) {
      for (let c = c0; c <= Math.min(c1, this.ncol - 1); c++) {
        if (this.get(r, c) !== '') { this.set(r, c, ''); touched = true; }
      }
    }
    if (touched) this.changed();
  }

  insertRow() {
    const { r0 } = this.rect();
    this.t.rows.splice(Math.max(0, r0), 0, []);
    this.changed(true);
  }

  deleteRows() {
    const { r0, r1 } = this.rect();
    if (r0 < 0) return;
    this.t.rows.splice(r0, r1 - r0 + 1);
    this.select(r0, this.sel.c);
    this.changed(true);
  }

  insertColumn() {
    const { c0 } = this.rect();
    const at = Math.min(c0, this.ncol);
    this.t.columns.splice(at, 0, { name: `Column ${this.ncol + 1}`, type: 'auto' });
    for (const row of this.t.rows) if (row.length > at) row.splice(at, 0, '');
    this.changed(true);
  }

  deleteColumns() {
    const { c0, c1 } = this.rect();
    const last = Math.min(c1, this.ncol - 1);
    if (c0 > last) return;
    this.t.columns.splice(c0, last - c0 + 1);
    for (const row of this.t.rows) row.splice(c0, last - c0 + 1);
    this.select(this.sel.r, Math.min(c0, this.ncol));
    this.changed(true);
  }
}
