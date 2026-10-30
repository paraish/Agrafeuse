// A spreadsheet for typing or pasting data. Rows are virtualised so large
// tables stay fast. Keyboard: arrows / Tab / Enter move, typing replaces the
// cell, F2 or double-click edits it, Delete clears, Ctrl+C / Ctrl+V copy and
// paste blocks (to and from Excel), Shift+arrows select a range.
// Column names are the header row; row names are an optional first column
// (index -1 here), e.g. subject IDs, which R gets as a "row_name" column.
// Columns move by dragging the grip in their header, or with Ctrl+Shift+arrows.
// Calculated columns (col.formula) show values R works out (this.computed);
// they cannot be typed into, and their header opens their formula (onFormula).
import { h, clear } from './dom.js';
import { parseDelimited, isMissing, parseNumber } from '../codegen/data.js';

const ROW_H = 28;
const OVERSCAN = 10;
const TYPE_OPTIONS = [['auto', 'Auto'], ['number', 'Number'], ['text', 'Text']];
const RN = -1; // the row-names column

export class Grid {
  constructor(table, { onChange, onSelect, onFormula } = {}) {
    this.t = table;
    this.onChange = onChange || (() => {});
    this.onSelect = onSelect || (() => {});
    this.onFormula = onFormula || (() => {});
    this.computed = {}; // calculated column name -> values (text), from R
    this.computedTypes = {};
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
    window.addEventListener('mouseup', this.onMouseUp = () => {
      this.dragging = false;
      // A plain click on a column name opens it for renaming (a drag across names still selects columns).
      const c = this.headerClick;
      this.headerClick = null;
      const s = this.sel;
      if (c != null && !this.editing && s.r === -1 && s.r2 === -1 && s.c === c && s.c2 === c) {
        this.startEdit();
        this.editor.select();
      }
    });
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
  isFormula(c) { return c >= 0 && this.t.columns[c]?.formula != null; }

  get(r, c) {
    if (c === RN) return r < 0 ? 'Row names' : this.t.rowNames?.[r] ?? '';
    if (r < 0) return this.t.columns[c]?.name ?? '';
    if (this.isFormula(c)) return this.computed[this.t.columns[c].name]?.[r] ?? '';
    return this.t.rows[r]?.[c] ?? '';
  }
  set(r, c, v) {
    if (r >= 0 && this.isFormula(c)) return; // calculated: R fills it in
    if (c === RN) {
      if (r < 0) return; // the "Row names" heading is fixed
      this.t.rowNames = this.t.rowNames || [];
      while (this.t.rowNames.length < r) this.t.rowNames.push('');
      this.t.rowNames[r] = v;
      while (r >= this.t.rows.length) this.t.rows.push([]);
      return;
    }
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
      if (col.formula != null) return this.computedTypes[col.name] === 'numeric' || !this.computedTypes[col.name] ? 'numeric' : 'text';
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

    const colgroup = h('colgroup', h('col', { style: { width: '46px' } }), h('col', { style: { width: '132px' } }),
      Array.from({ length: ncolShown }, () => h('col', { style: { width: '128px' } })));

    const headCells = [
      h('th.corner', { title: 'Select all', 'data-r': 'all' }, h('div.corner-label', 'name'), h('div.corner-label', 'type')),
      h('th.colhead.rowname-head', {
        'data-r': -1, 'data-c': RN, class: r0 === -1 && c0 === RN ? 'sel' : '',
        title: 'Optional labels for each row, e.g. subject or sample IDs: click a cell below and type. In R they become a "row_name" column.',
      }, h('div.colname', 'Row names'), h('div.colsub', 'labels (optional)')),
    ];
    for (let c = 0; c < ncolShown; c++) {
      const ghost = c === this.ncol;
      const selected = r0 === -1 && c >= c0 && c <= c1;
      const col = this.t.columns[c];
      const formula = !ghost && col.formula != null;
      const typeSel = ghost ? h('button.link.colsub.col-new-fx', {
        type: 'button', title: 'Add a column calculated from the others (like dplyr\'s mutate)',
        onmousedown: (e) => { e.stopPropagation(); e.preventDefault(); this.onFormula(null); },
      }, 'ƒ calculated') : formula ? h('div.colsub.formula-text', {
        title: `Calculated: ${col.formula}\nClick to change the formula`,
        onmousedown: (e) => { e.stopPropagation(); e.preventDefault(); this.onFormula(c); },
      }, `= ${col.formula}`) : h('select.coltype', {
        title: 'Column type: Auto decides from the values',
        'aria-label': `Type of column ${col.name}`,
        onmousedown: (e) => e.stopPropagation(),
        onchange: (e) => { col.type = e.target.value; this.changed(); },
      }, TYPE_OPTIONS.map(([v, l]) => h('option', { value: v, selected: col.type === v }, l)));
      headCells.push(h('th.colhead', {
        'data-r': -1, 'data-c': c,
        class: [ghost ? 'ghost' : '', selected ? 'sel' : '', this.types[c] === 'numeric' ? 'num' : '', formula ? 'formula' : ''].join(' '),
      }, ghost ? null : h('span.col-grip', { title: 'Drag to move this column', 'aria-hidden': 'true' }, '⋮⋮'),
      ghost || formula ? null : h('button.col-fx', {
        type: 'button', title: 'Calculate a new column from this one (log, ratio, % of mean…)', tabindex: -1,
        onmousedown: (e) => { e.stopPropagation(); e.preventDefault(); this.onFormula(null, c); },
      }, 'ƒ'),
      h('div.colname', { title: ghost ? 'Add a column' : formula ? 'Click to change the formula or the name' : 'Click to rename' },
        formula ? h('span.fx-mark', 'ƒ ') : null, ghost ? '+ new column' : (col.name || `Column ${c + 1}`)), typeSel));
    }

    const body = [h('tr.spacer', h('td', { colspan: ncolShown + 2, style: { height: `${first * ROW_H}px` } }))];
    for (let r = first; r < last; r++) {
      const inRows = r >= r0 && r <= r1;
      const cells = [
        h('th.rowhead', { 'data-r': r, 'data-c': 'row', class: inRows && c0 <= RN && c1 >= this.ncol - 1 ? 'sel' : '' }, String(r + 1)),
        h('td.rowname', {
          'data-r': r, 'data-c': RN,
          class: [inRows && c0 <= RN ? 'sel' : '', r === this.sel.r && this.sel.c === RN ? 'active' : ''].join(' '),
        }, this.t.rowNames?.[r] ?? ''),
      ];
      const row = this.t.rows[r];
      for (let c = 0; c < ncolShown; c++) {
        const v = this.isFormula(c) ? this.get(r, c) : row?.[c] ?? '';
        const cls = [];
        if (r >= r0 && r <= r1 && c >= c0 && c <= c1) cls.push('sel');
        if (r === this.sel.r && c === this.sel.c) cls.push('active');
        if (c === this.ncol) cls.push('ghost');
        else if (this.isFormula(c)) cls.push('formula', this.types[c] === 'numeric' ? 'num' : '');
        else if (this.types[c] === 'numeric') {
          cls.push('num');
          if (this.t.columns[c].type === 'number' && !isMissing(v) && parseNumber(v) === undefined) cls.push('bad');
        }
        cells.push(h('td', { 'data-r': r, 'data-c': c, class: cls.join(' ') }, v));
      }
      body.push(h('tr', cells));
    }
    body.push(h('tr.spacer', h('td', { colspan: ncolShown + 2, style: { height: `${Math.max(0, this.nrowShown - last) * ROW_H}px` } })));

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
    c = Math.max(RN, Math.min(c, this.ncol));
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
    if (r < 0 && c === RN) return;
    if (this.isFormula(c)) { this.onFormula(c); return; } // calculated: change its formula instead
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
      const structural = r < 0 || c >= this.ncol || c === RN;
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
    if (mod && e.shiftKey && (k === 'ArrowLeft' || k === 'ArrowRight')) { e.preventDefault(); this.moveSelection(k === 'ArrowLeft' ? -1 : 1); }
    else if (k === 'ArrowDown') { e.preventDefault(); this.move(1, 0, e.shiftKey); }
    else if (k === 'ArrowUp') { e.preventDefault(); this.move(-1, 0, e.shiftKey); }
    else if (k === 'ArrowRight') { e.preventDefault(); this.move(0, 1, e.shiftKey); }
    else if (k === 'ArrowLeft') { e.preventDefault(); this.move(0, -1, e.shiftKey); }
    else if (k === 'Tab') { e.preventDefault(); this.move(0, e.shiftKey ? -1 : 1); }
    else if (k === 'Enter') { e.preventDefault(); this.move(e.shiftKey ? -1 : 1, 0); }
    else if (k === 'F2') { e.preventDefault(); this.startEdit(); }
    else if (k === 'Delete' || k === 'Backspace') { e.preventDefault(); this.clearSelection(); }
    else if (mod && (k === 'a' || k === 'A')) {
      e.preventDefault();
      this.sel = { r: 0, c: RN, r2: Math.max(0, this.t.rows.length - 1), c2: Math.max(0, this.ncol - 1) };
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
    if (e.target.closest('.col-grip') && t.r === -1 && t.c >= 0) {
      e.preventDefault();
      this.startColumnDrag(e, t.c);
      return;
    }
    if (this.editing) this.commitEdit();
    e.preventDefault();
    this.el.focus({ preventScroll: true });
    if (t.r === 'all') {
      this.sel = { r: 0, c: RN, r2: Math.max(0, this.t.rows.length - 1), c2: Math.max(0, this.ncol - 1) };
      this.render();
      return;
    }
    if (t.c === 'row') {
      const keep = e.shiftKey ? this.sel.r : t.r;
      this.sel = { r: keep, c: RN, r2: t.r, c2: Math.max(0, this.ncol - 1) };
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
    this.headerClick = t.r === -1 && t.c >= 0 && !e.shiftKey ? t.c : null;
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
    if (this.t.rowNames?.length > r0) this.t.rowNames.splice(Math.max(0, r0), 0, '');
    this.changed(true);
  }

  deleteRows() {
    const { r0, r1 } = this.rect();
    if (r0 < 0) return;
    this.t.rows.splice(r0, r1 - r0 + 1);
    this.t.rowNames?.splice(r0, r1 - r0 + 1);
    this.select(r0, this.sel.c);
    this.changed(true);
  }

  insertColumn() {
    const { c0 } = this.rect();
    const at = Math.max(0, Math.min(c0, this.ncol));
    this.t.columns.splice(at, 0, { name: `Column ${this.ncol + 1}`, type: 'auto' });
    for (const row of this.t.rows) if (row.length > at) row.splice(at, 0, '');
    this.changed(true);
  }

  // ---- moving columns ----------------------------------------------------------------------------

  // Drag a column by its grip; the selected columns go together when it is one of them.
  // A line shows where they will land, and the grid scrolls sideways near its edges.
  startColumnDrag(e, c) {
    if (this.editing) this.commitEdit();
    const { r0, c0, c1 } = this.rect();
    const block = r0 === -1 && c0 >= 0 && c >= c0 && c <= c1 ? [c0, Math.min(c1, this.ncol - 1)] : [c, c];
    this.sel = { r: -1, c: block[0], r2: -1, c2: block[1] };
    this.render();
    const line = h('div.col-drop');
    this.el.append(line);
    this.el.classList.add('col-dragging');
    let to = null;
    const move = (ev) => {
      const heads = [...this.sheet.querySelectorAll('thead th.colhead[data-c]')].filter((th) => Number(th.dataset.c) >= 0 && Number(th.dataset.c) < this.ncol);
      const gr = this.el.getBoundingClientRect();
      to = this.ncol;
      let x = null;
      for (const th of heads) {
        const r = th.getBoundingClientRect();
        if (ev.clientX < r.left + r.width / 2) { to = Number(th.dataset.c); x = r.left; break; }
      }
      if (x === null) x = heads.length ? heads[heads.length - 1].getBoundingClientRect().right : gr.left;
      Object.assign(line.style, { left: `${x - gr.left + this.el.scrollLeft - 1}px`, top: `${this.el.scrollTop}px`, height: `${this.el.clientHeight}px` });
      // The row numbers and row names stay on the left (about 180 px).
      if (ev.clientX > gr.right - 30) this.el.scrollLeft += 16;
      else if (ev.clientX < gr.left + 200) this.el.scrollLeft -= 16;
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      line.remove();
      this.el.classList.remove('col-dragging');
      if (to != null) this.moveColumns(block[0], block[1], to);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    move(e);
  }

  // Move the selected columns one place left (-1) or right (+1).
  moveSelection(d) {
    const { c0, c1 } = this.rect();
    const a = Math.max(0, c0);
    const b = Math.min(c1, this.ncol - 1);
    if (a > b) return;
    if (d < 0 && a > 0) this.moveColumns(a, b, a - 1);
    else if (d > 0 && b < this.ncol - 1) this.moveColumns(a, b, b + 2);
  }

  // Move columns c0..c1 (names, types and every row's values) to sit before
  // column `to` (ncol = at the end). They stay selected.
  moveColumns(c0, c1, to) {
    if (to >= c0 && to <= c1 + 1) return;
    const n = c1 - c0 + 1;
    const at = to > c1 ? to - n : to;
    const width = this.ncol;
    const reorder = (arr) => { const block = arr.splice(c0, n); arr.splice(at, 0, ...block); };
    reorder(this.t.columns);
    for (const row of this.t.rows) {
      while (row.length < width) row.push('');
      reorder(row);
    }
    this.sel = { r: -1, c: at, r2: -1, c2: at + n - 1 };
    this.changed(true);
    this.onSelect(this.rect());
  }

  deleteColumns() {
    const { c1 } = this.rect();
    const c0 = Math.max(0, this.rect().c0); // the row-names column stays (clear it instead)
    const last = Math.min(c1, this.ncol - 1);
    if (c0 > last) return;
    this.t.columns.splice(c0, last - c0 + 1);
    for (const row of this.t.rows) row.splice(c0, last - c0 + 1);
    this.select(this.sel.r, Math.min(c0, this.ncol));
    this.changed(true);
  }
}
