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
How to choose: find the dataset first, then its columns. The value to analyse (y) is a "number" column; groups come from a "groups" column. Copy names exactly as listed under "Datasets", with their spaces and capitals.
Be brief and concrete. Choose tests carefully (paired data needs a subject column; non-normal or small samples suggest non-parametric tests) and say why in one sentence.
${EXAMPLES}`;
}

// A few worked answers: small models follow examples better than rules.
const EXAMPLES = `Examples, for a project with a dataset "Mice" (columns: weight (number); genotype (groups: WT, KO); mouse (groups: m1, m2, …)) and a table "Plates" (one column per group: Control (number), Drug (number)):
User: is weight different between genotypes?
{"reply":"Two independent groups, so an unpaired (Welch's) t test.","actions":[{"do":"new_analysis","test":"ttest_unpaired","dataset":"Mice","y":"weight","group":"genotype"}]}
User: show weight by genotype as a box plot with the p value
{"reply":"A box plot of weight by genotype, with a t test on it.","actions":[{"do":"new_graph","template":"box","dataset":"Mice","x":"genotype","y":"weight"},{"do":"compare_groups","method":"t.test"}]}
User: mean and SD of weight for each genotype
{"reply":"Added to the pipeline of Mice.","actions":[{"do":"pipeline_step","table":"Mice","step":{"type":"group_by","columns":["genotype"]}},{"do":"pipeline_step","table":"Mice","step":{"type":"summarise","column":"weight","stats":["mean","sd","n"]}}]}
User: compare Control and Drug in Plates
{"reply":"Each column of Plates is a group: Mann-Whitney test, as the groups are small.","actions":[{"do":"new_analysis","test":"mann_whitney","dataset":"Plates"},{"do":"new_graph","template":"scatter_dot","dataset":"Plates"},{"do":"compare_groups","method":"wilcox.test"}]}
User: what does the p value mean?
{"reply":"It is the chance of seeing a difference at least this big if the groups really did not differ; below 0.05 is usually called significant.","actions":[]}`;

function describeColumns(schema, compact = false) {
  if (!schema?.columns) return 'columns not known yet';
  const maxCols = compact ? 12 : MAX_COLUMNS;
  const maxLevels = compact ? 5 : MAX_LEVELS;
  const cols = schema.columns.slice(0, maxCols).map((c) => {
    if (c.type === 'numeric') return `${c.name} (number)`;
    const lv = c.levels || [];
    const shown = lv.slice(0, maxLevels).join(', ');
    const what = /^row_name(_\d+)?$/.test(c.name) ? 'row names / IDs' : 'groups';
    return lv.length ? `${c.name} (${what}: ${shown}${lv.length > maxLevels ? `, … ${lv.length} in all` : ''})` : `${c.name} (text)`;
  });
  if (schema.columns.length > maxCols) cols.push(`… ${schema.columns.length} columns in all`);
  return cols.join('; ');
}

// Number columns only (besides row names): each column is a group.
function isWide(schema) {
  const cols = schema?.columns || [];
  return cols.filter((c) => c.type === 'numeric').length >= 2 && !cols.some((c) => c.type !== 'numeric' && !/^row_name(_\d+)?$/.test(c.name));
}

// The project as a few lines of text.
export function projectSummary(app, { shareValues = false, preview = null, compact = false } = {}) {
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
    const wide = isWide(s) ? ' One column per group: to compare or graph these groups, just name this dataset (the app reshapes it).' : '';
    lines.push(`- "${it.name}" (${kind}${rows ? `, ${rows}` : ''}): ${describeColumns(s, compact)}.${wide}${pipe}`);
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
  if (shareValues && preview?.table?.rows?.length && !compact) {
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
// history: [{ role: 'user' | 'assistant', content }]. budget: roughly how many tokens
// the prompt may use (small in-browser models have small context windows); the
// oldest turns are dropped to fit.
export function buildMessages(app, history, request, opts = {}) {
  const budget = opts.budget || 100000;
  let sys = `${systemPrompt()}\n\n${projectSummary(app, opts)}`;
  // A big project in a small model: a shorter description (fewer groups, no sample rows).
  if (estimateTokens(sys) + estimateTokens(request) > budget - 300) sys = `${systemPrompt()}\n\n${projectSummary(app, { ...opts, compact: true })}`;
  let past = history.slice(-6);
  const size = () => estimateTokens(sys) + estimateTokens(request) + past.reduce((n, m) => n + estimateTokens(m.content), 0);
  while (past.length && size() > budget) past = past.slice(2);
  return [
    { role: 'system', content: sys },
    ...past,
    { role: 'user', content: request },
  ];
}

// About 3.5 characters per token for English and JSON.
export function estimateTokens(text) {
  return Math.ceil(String(text || '').length / 3.5);
}

// Asking again when some proposed actions cannot be done.
export function repairRequest(problems) {
  return `Some of your actions cannot be done in this project:\n${problems.map((p) => `- action ${p.index + 1} (${p.do}): ${p.why}`).join('\n')}\nAnswer again with the whole corrected JSON object. Use only dataset, item and column names exactly as listed in the project; leave out what cannot be done.`;
}
