// Form controls bound to plain objects, plus modals, toasts and result tables.
import { h, icon, fill } from './dom.js';

let uid = 0;
const nextId = () => `w${++uid}`;

export function field(label, control, { hint, wide = false, k } = {}) {
  const id = control?.id || null;
  return h('div.field', { class: wide ? 'wide' : '', 'data-field': k },
    label ? h('label', { for: id }, label) : null,
    h('div.control', control, hint ? h('div.hint', hint) : null));
}

// options: [[value, label], ...] or [{ group, options: [[v, l]] }]
export function select(value, options, onChange, { k, placeholder, disabled, title } = {}) {
  const el = h('select', { 'data-k': k, id: nextId(), disabled, title });
  if (placeholder !== undefined) el.append(h('option', { value: '' }, placeholder));
  const add = (parent, [v, l, extra]) => parent.append(h('option', { value: v, disabled: extra?.disabled }, l));
  for (const o of options) {
    if (o && o.group) {
      const g = h('optgroup', { label: o.group });
      o.options.forEach((x) => add(g, x));
      el.append(g);
    } else add(el, o);
  }
  el.value = value ?? '';
  if (value && el.value !== String(value)) {
    // Keep a value that is not offered visible. If there are other choices it
    // really is gone (e.g. a renamed column); with none, they just aren't known yet.
    const known = options.length > 0;
    el.append(h('option', { value }, known ? `${value} (missing)` : value));
    el.value = value;
    if (known) el.classList.add('missing');
  }
  el.addEventListener('change', () => onChange(el.value));
  return el;
}

export function bindSelect(obj, key, options, after, opts = {}) {
  return select(obj[key], options, (v) => { obj[key] = v; after?.(v); }, opts);
}

export function input(value, onInput, { k, type = 'text', placeholder, step, min, max, mono, width, onCommit } = {}) {
  const el = h('input', {
    'data-k': k, id: nextId(), type, placeholder, step, min, max,
    class: mono ? 'mono' : '', style: width ? { width } : null,
  });
  el.value = value ?? '';
  el.addEventListener('input', () => onInput(type === 'number' ? (el.value === '' ? '' : Number(el.value)) : el.value));
  if (onCommit) el.addEventListener('change', () => onCommit(el.value));
  return el;
}

export function bindInput(obj, key, after, opts = {}) {
  return input(obj[key], (v) => { obj[key] = v; after?.(v); }, opts);
}

export function checkbox(checked, label, onChange, { k, title } = {}) {
  const id = nextId();
  const box = h('input', { type: 'checkbox', id, 'data-k': k, checked });
  box.addEventListener('change', () => onChange(box.checked));
  return h('label.check', { for: id, title }, box, h('span', label));
}

export function bindCheck(obj, key, label, after, opts = {}) {
  return checkbox(!!obj[key], label, (v) => { obj[key] = v; after?.(v); }, opts);
}

export function colour(value, onChange, { k } = {}) {
  const el = h('input', { type: 'color', 'data-k': k, id: nextId() });
  el.value = /^#[0-9a-f]{6}$/i.test(value || '') ? value : '#000000';
  el.addEventListener('input', () => onChange(el.value));
  return el;
}

export function segmented(options, value, onChange, { k, small } = {}) {
  return h('div.segmented', { class: small ? 'small' : '', role: 'radiogroup' },
    options.map(([v, l, title]) => h('button', {
      type: 'button', class: v === value ? 'on' : '', 'data-k': k ? `${k}:${v}` : null, title,
      role: 'radio', 'aria-checked': v === value ? 'true' : 'false',
      onclick: () => { if (v !== value) onChange(v); },
    }, l)));
}

// A list of checkboxes for picking several things (keeps the order of `options`).
export function multiCheck(options, selected, onChange, { k, empty = 'Nothing to choose from yet.' } = {}) {
  if (!options.length) return h('div.hint', empty);
  const set = new Set(selected || []);
  return h('div.multicheck', options.map(([v, l]) => checkbox(set.has(v), l, (on) => {
    if (on) set.add(v); else set.delete(v);
    onChange(options.map((o) => o[0]).filter((x) => set.has(x)));
  }, { k: k ? `${k}:${v}` : null })));
}

// Which columns to use: every one ticked to start with; untick those to leave
// out. `selected` empty means every column (including ones added later), and
// ticking them all again goes back to that. "None" clears the ticks so a few
// can be picked; nothing is stored until at least one is ticked.
export function columnPicker(options, selected, onChange, { k, empty = 'Nothing to choose from yet.' } = {}) {
  if (!options.length) return h('div.hint', empty);
  const all = options.map((o) => o[0]);
  const box = h('div.colpicker');
  const draw = (cur) => {
    const left = all.filter((v) => !cur.includes(v));
    fill(box,
      h('div.colpicker-bar',
        h('span', { class: left.length ? 'colpicker-out' : 'muted' },
          !cur.length ? 'Tick the columns to use.' : left.length ? `Left out: ${left.join(', ')}` : `All ${all.length} columns (untick any to leave them out)`),
        h('span.grow'),
        h('button.link', { type: 'button', 'data-k': k ? `${k}-all` : null, onclick: () => pick(all) }, 'All'),
        h('button.link', { type: 'button', 'data-k': k ? `${k}-none` : null, onclick: () => draw([]) }, 'None')),
      multiCheck(options, cur, (v) => pick(v), { k }));
  };
  const pick = (cur) => {
    draw(cur);
    if (cur.length) onChange(cur.length === all.length ? [] : cur);
  };
  draw(selected?.length ? all.filter((v) => selected.includes(v)) : all);
  return box;
}

export function iconButton(name, title, onclick, { k, cls = '', disabled } = {}) {
  return h('button.icon-btn', { type: 'button', title, 'aria-label': title, onclick, 'data-k': k, class: cls, disabled }, icon(name));
}

export function button(label, onclick, { kind = '', iconName, title, k, disabled } = {}) {
  return h('button.btn', { type: 'button', class: kind, onclick, title, 'data-k': k, disabled },
    iconName ? icon(iconName) : null, label ? h('span', label) : null);
}

export function section(title, body, { k, open = true, actions, sub } = {}) {
  const det = h('details.section', { open, 'data-sec': k },
    h('summary', h('span.sec-title', title), sub ? h('span.sec-sub', sub) : null, actions ? h('span.sec-actions', { onclick: (e) => e.stopPropagation() }, actions) : null),
    h('div.sec-body', body));
  return det;
}

const TYPE_BADGE = { numeric: '123', factor: 'abc', character: 'abc', logical: 'T/F', date: 'date' };

// Column choices from a schema: [[name, label]], optionally only some types.
export function columnOptions(schema, { types } = {}) {
  if (!schema) return [];
  return schema.columns
    .filter((c) => !types || types.includes(c.type))
    .map((c) => [c.name, `${c.name}  ·  ${TYPE_BADGE[c.type] || c.type}`]);
}

export function levelsOf(schema, col) {
  return schema?.columns?.find((c) => c.name === col)?.levels || [];
}

// A data frame (as returned by ag_preview / ag_result_json) as an HTML table.
export function dataTable(table, { maxRows = 500, highlight } = {}) {
  if (!table || !table.columns) return h('div.hint', 'No data.');
  const cols = table.columns.map((c) => (typeof c === 'string' ? { name: c } : c));
  const rows = (table.rows || []).slice(0, maxRows);
  return h('div.table-wrap',
    h('table.results',
      h('thead', h('tr', cols.map((c) => h('th', { title: c.type || '' }, c.name, c.type ? h('span.type', TYPE_BADGE[c.type] || c.type) : null)))),
      h('tbody', rows.map((r) => h('tr', r.map((v, j) => {
        const name = cols[j]?.name || '';
        const cls = [];
        if (/p value/i.test(name)) cls.push('pval');
        if (name === 'Significance' && v && v !== 'ns') cls.push('sig');
        if (highlight?.(name, v)) cls.push('hl');
        return h('td', { class: cls.join(' ') }, v);
      }))))));
}

// ---- modal dialogs -------------------------------------------------------------------

export function modal({ title, body, actions = [], wide = false, onClose }) {
  return new Promise((resolve) => {
    const close = (value) => {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      onClose?.();
      resolve(value);
    };
    const onKey = (e) => { if (e.key === 'Escape') close(null); };
    const dialog = h('div.modal', { class: wide ? 'wide' : '', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('div.modal-head', h('h2', title), iconButton('x', 'Close', () => close(null))),
      h('div.modal-body', typeof body === 'function' ? body(close) : body),
      actions.length ? h('div.modal-actions', actions.map((a) => button(a.label, () => {
        const v = a.value ? a.value() : a.label;
        if (v !== undefined) close(v);
      }, { kind: a.kind || '' }))) : null);
    const overlay = h('div.overlay', { onmousedown: (e) => { if (e.target === overlay) close(null); } }, dialog);
    document.addEventListener('keydown', onKey);
    document.body.append(overlay);
    const first = dialog.querySelector('input, select, textarea, button.primary');
    first?.focus();
  });
}

export function toast(message, kind = 'info', ms = 4000) {
  let host = document.querySelector('.toasts');
  if (!host) { host = h('div.toasts', { role: 'status', 'aria-live': 'polite' }); document.body.append(host); }
  const t = h('div.toast', { class: kind }, icon(kind === 'error' ? 'alert' : 'info'), h('span', message));
  host.append(t);
  setTimeout(() => t.remove(), ms);
}

export function messageBox(kind, text, extra) {
  return h('div.message', { class: kind }, icon(kind === 'error' ? 'alert' : 'info'), h('div', h('div', text), extra));
}

export function codeBlock(code) {
  return h('pre.code', h('code', code));
}
