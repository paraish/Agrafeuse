// Pieces shared by the item views.
import { h, icon } from './dom.js';
import { input, toast } from './widgets.js';

// Name (editable), what kind of item it is, and its name in R.
export function itemHeader(app, item, kindLabel, actions = []) {
  const chip = h('button.rname', {
    type: 'button',
    title: 'The name of this object in R (click to copy)',
    onclick: () => navigator.clipboard?.writeText(item.rname).then(() => toast(`Copied ${item.rname}`)),
  }, icon('code', 14), h('span', item.rname));
  const nameInput = input(item.name, (v) => {
    item.name = v;
    app.renameItem(item);
    chip.lastChild.textContent = item.rname;
  }, { k: 'item-name' });
  nameInput.classList.add('title-input');
  nameInput.setAttribute('aria-label', `${kindLabel} name`);
  return h('div.item-head', h('div.kind', kindLabel), nameInput, chip, h('div.head-actions', actions));
}

export function statusLine(res) {
  if (!res) return null;
  if (!res.ok) return h('div.message', { class: res.incomplete ? 'info' : 'error' }, icon(res.incomplete ? 'info' : 'alert'), h('div', res.error));
  return null;
}

export function warningsBox(list) {
  const items = [...new Set((list || []).filter(Boolean))];
  if (!items.length) return null;
  return h('details.warnings', h('summary', icon('alert', 14), ` ${items.length} R ${items.length === 1 ? 'message' : 'messages'}`),
    h('ul', items.map((w) => h('li', w))));
}
