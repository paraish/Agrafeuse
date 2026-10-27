// What the assistant is told: how to answer (ACTION_GUIDE) and what is in the
// project. Without permission to see data, it gets only names: items,
// columns, their types and group names. With it, also the first rows of the
// open dataset and the results of analyses.
import { ACTION_GUIDE } from './actions.js';
import { TESTS } from '../codegen/stats.js';
import { GEOMS, effectiveLayers } from '../codegen/graph.js';
import { getItem } from '../model.js';

const MAX_LEVELS = 12;
const MAX_COLUMNS = 30;
const SAMPLE_ROWS = 15;

export function systemPrompt() {
  return `You are the assistant inside Agrafeuse, a point-and-click app for statistics and graphs that runs R (ggplot2, dplyr) in the browser.
You help by explaining, and by doing things in the app through actions that the user reviews before they run.
${ACTION_GUIDE}
Be brief and concrete. Choose tests carefully (paired data needs a subject column; non-normal or small samples suggest non-parametric tests) and say why in one sentence.`;
}

function describeColumns(schema) {
  if (!schema?.columns) return 'columns not known yet';
  const cols = schema.columns.slice(0, MAX_COLUMNS).map((c) => {
    if (c.type === 'numeric') return `${c.name} (number)`;
    const lv = c.levels || [];
    const shown = lv.slice(0, MAX_LEVELS).join(', ');
    return lv.length ? `${c.name} (groups: ${shown}${lv.length > MAX_LEVELS ? `, … ${lv.length} in all` : ''})` : `${c.name} (text)`;
  });
  if (schema.columns.length > MAX_COLUMNS) cols.push(`… ${schema.columns.length} columns in all`);
  return cols.join('; ');
}

// The project as a few lines of text.
export function projectSummary(app, { shareValues = false, preview = null } = {}) {
  const p = app.store.project;
  const engine = app.engine;
  const open = app.store.item();
  const name = (id) => getItem(p, id)?.name || '?';
  const lines = [`Project "${p.name}".${open ? ` Open now: ${open.kind === 'data' ? 'data table' : open.kind} "${open.name}".` : ''}`];
  const ds = p.items.filter((it) => it.kind === 'data' || it.kind === 'transform');
  if (ds.length) lines.push('Datasets:');
  for (const it of ds) {
    const s = engine.schemaOf(it.id);
    const rows = s?.nrow != null ? `${s.nrow} rows` : '';
    const kind = it.kind === 'data' ? 'data table' : `transform of "${name(it.input)}"`;
    const pipe = it.kind === 'data' && it.pipe?.steps?.length ? `; its pipeline has ${it.pipe.steps.length} step(s): ${it.pipe.steps.map((x) => x.type).join(', ')}` : '';
    lines.push(`- "${it.name}" (${kind}${rows ? `, ${rows}` : ''}): ${describeColumns(s)}${pipe}`);
  }
  const analyses = p.items.filter((it) => it.kind === 'analysis');
  if (analyses.length) lines.push('Analyses:');
  for (const a of analyses) {
    const vars = ['y', 'group', 'subject', 'factorB', 'x'].filter((k) => a[k]).map((k) => `${k}=${a[k]}`).join(', ');
    let line = `- "${a.name}": ${a.test} (${TESTS[a.test]?.label || ''}) on "${name(a.dataset)}"${vars ? `, ${vars}` : ''}`;
    const r = engine.result(a.id);
    if (shareValues && r?.ok && r.result?.summary) line += `. Result: ${r.result.summary.replace(/\s+/g, ' ').slice(0, 300)}`;
    lines.push(line);
  }
  const graphs = p.items.filter((it) => it.kind === 'graph');
  if (graphs.length) lines.push('Graphs:');
  for (const g of graphs) {
    const eff = effectiveLayers(g).filter((l) => !l.hidden && GEOMS[l.geom]);
    const main = eff.find((l) => l.aes?.x?.mode === 'col');
    const maps = main ? ['x', 'y', 'colour', 'fill', 'group'].filter((k) => main.aes?.[k]?.mode === 'col').map((k) => `${k}=${main.aes[k].col}`).join(', ') : '';
    const stats = (g.annotations || []).map((x) => (x.kind === 'compare' ? 'compare groups' : `${x.kind} from "${name(x.analysis)}"`));
    lines.push(`- "${g.name}": data "${name(main?.dataset)}"${maps ? `, ${maps}` : ''}; layers: ${eff.map((l) => l.geom).join(', ') || 'none'}${stats.length ? `; stats: ${stats.join(', ')}` : ''}${g.notes?.length ? `; ${g.notes.length} text box(es)` : ''}`);
  }
  if (shareValues && preview?.table?.rows?.length) {
    const t = preview.table;
    const head = t.columns.map((c) => c.name).join(',');
    const rows = t.rows.slice(0, SAMPLE_ROWS).map((r) => r.join(','));
    lines.push(`First rows of "${preview.name}"${t.nrow > rows.length ? ` (${t.nrow} rows in all)` : ''}:`, head, ...rows);
  }
  return lines.join('\n');
}

// The dataset whose rows to show the model: the open one, or the one the open item uses.
export function previewTarget(app) {
  const it = app.store.item();
  if (!it) return null;
  if (it.kind === 'data' || it.kind === 'transform') return it.id;
  if (it.kind === 'analysis') return it.dataset || null;
  if (it.kind === 'graph') return effectiveLayers(it).find((l) => l.dataset)?.dataset || null;
  return null;
}

// Messages for the model: instructions + project, recent conversation, the new request.
// history: [{ role: 'user' | 'assistant', content }]
export function buildMessages(app, history, request, opts = {}) {
  const sys = `${systemPrompt()}\n\n${projectSummary(app, opts)}`;
  return [
    { role: 'system', content: sys },
    ...history.slice(-6),
    { role: 'user', content: request },
  ];
}
