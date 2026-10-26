// App state: the project, which item is open, undo/redo, and autosave in this browser.
import { emptyProject, getItem, clone } from './model.js';
import { exampleProject } from './example.js';

const AUTOSAVE_KEY = 'agrafeuse:project';

export class Store extends EventTarget {
  constructor() {
    super();
    this.project = emptyProject();
    this.selected = null;
    this.history = [];
    this.future = [];
    this.revCounter = 1;
    this.snapshot = null;
    this.snapTimer = null;
    this.saveTimer = null;
  }

  emit(type, detail = {}) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  // Replace the whole project (new, opened, example, or restored).
  load(project, { keepHistory = false, select } = {}) {
    this.project = project;
    let max = 0;
    for (const it of project.items) max = Math.max(max, it.rev || 0);
    this.revCounter = Math.max(this.revCounter, max) + 1;
    if (!keepHistory) { this.history = []; this.future = []; }
    this.snapshot = JSON.stringify(project);
    const want = select !== undefined ? select : this.selected;
    this.selected = want && getItem(project, want) ? want : project.items.find((i) => i.kind === 'graph')?.id || project.items[0]?.id || null;
    this.emit('load');
    this.emit('select', { id: this.selected });
    this.scheduleSave();
  }

  restore() {
    try {
      const raw = localStorage.getItem(AUTOSAVE_KEY);
      if (raw) {
        const p = JSON.parse(raw);
        if (p && p.format === 'agrafeuse' && Array.isArray(p.items)) return this.load(p);
      }
    } catch { /* storage unavailable or corrupt: start fresh */ }
    this.load(exampleProject());
  }

  select(id) {
    this.selected = id;
    this.emit('select', { id });
  }

  item(id = this.selected) {
    return getItem(this.project, id);
  }

  // Call after mutating the project. structural = the list of items or their
  // names changed (navigator needs redrawing).
  change(id = null, { structural = false } = {}) {
    const it = id ? getItem(this.project, id) : null;
    if (it) it.rev = ++this.revCounter;
    this.emit('change', { id, structural });
    this.scheduleSnapshot();
    this.scheduleSave();
  }

  scheduleSnapshot() {
    clearTimeout(this.snapTimer);
    this.snapTimer = setTimeout(() => this.takeSnapshot(), 500);
  }

  takeSnapshot() {
    clearTimeout(this.snapTimer);
    const now = JSON.stringify(this.project);
    if (now === this.snapshot) return;
    if (this.snapshot) this.history.push(this.snapshot);
    if (this.history.length > 100) this.history.shift();
    this.future = [];
    this.snapshot = now;
    this.emit('history');
  }

  undo() {
    this.takeSnapshot();
    if (!this.history.length) return;
    this.future.push(this.snapshot);
    const prev = this.history.pop();
    this.load(JSON.parse(prev), { keepHistory: true });
    this.emit('history');
  }

  redo() {
    if (!this.future.length) return;
    this.history.push(this.snapshot);
    const next = this.future.pop();
    this.load(JSON.parse(next), { keepHistory: true });
    this.emit('history');
  }

  scheduleSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      try { localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(this.project)); } catch { /* full or blocked */ }
    }, 800);
  }

  projectCopy() {
    return clone(this.project);
  }
}
