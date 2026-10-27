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

// The project as a few lines of text. `project` can be a working copy with
// items a plan has made so far (their columns are then predicted from their steps).
export function projectSummary(app, { shareValues = false, preview = null, compact = false, project = null } = {}) {
  const p = project || app.store.project;
  const engine = app.engine;
  const open = getItem(p, app.store.selected);
  const name = (id) => getItem(p, id)?.name || '?';
  const schemaOf = (id) => engine.schemaOf(id) || predictSchema(p, id, schemaOf);
  const lines = [`Project "${p.name}".${open ? ` Open now: ${open.kind === 'data' ? 'data table' : open.kind} "${open.name}".` : ''}`];
  const ds = p.items.filter((it) => it.kind === 'data' || it.kind === 'transform');
  if (ds.length) lines.push('Datasets:');
  for (const it of ds) {
    const s = schemaOf(it.id);
    const rows = s?.nrow != null ? `${s.nrow} rows` : s?.predicted ? 'just planned' : '';
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

// The columns a transform will have, worked out from its input and steps
// (for datasets a plan makes before R has run them). Null when it cannot tell.
export function predictSchema(project, id, schemaOf) {
  const it = getItem(project, id);
  if (!it || it.kind !== 'transform') return null;
  const input = schemaOf(it.input);
  if (!input?.columns) return null;
  let cols = input.columns.map((c) => ({ ...c }));
  let grouped = null;
  const has = (n) => cols.some((c) => c.name === n);
  for (const st of it.steps || []) {
    if (st.disabled) continue;
    switch (st.type) {
      case 'pivot_longer': {
        const stacked = new Set(st.cols || []);
        cols = cols.filter((c) => !stacked.has(c.name));
        cols.push({ name: st.names_to || 'group', type: 'factor', levels: [...(st.cols || [])] }, { name: st.values_to || 'value', type: 'numeric' });
        break;
      }
      case 'mutate': if (st.name && !has(st.name)) cols.push({ name: st.name, type: 'numeric' }); break;
      case 'rename': cols = cols.map((c) => (c.name === st.from ? { ...c, name: st.to } : c)); break;
      case 'convert': cols = cols.map((c) => (c.name === st.column ? { ...c, type: st.to === 'numeric' ? 'numeric' : 'factor' } : c)); break;
      case 'select': {
        const set = new Set(st.columns || []);
        cols = cols.filter((c) => (st.drop ? !set.has(c.name) : set.has(c.name)));
        break;
      }
      case 'group_by': grouped = st.columns || null; break;
      case 'ungroup': grouped = null; break;
      case 'summarise': {
        const by = grouped || st.group_by || [];
        cols = [...cols.filter((c) => by.includes(c.name)), ...(st.stats || []).map((x) => ({ name: x, type: 'numeric' }))];
        grouped = null;
        break;
      }
      case 'count': cols = [...cols.filter((c) => (st.columns || []).includes(c.name) || (grouped || []).includes(c.name)), { name: 'n', type: 'numeric' }]; break;
      case 'distinct': if (st.columns?.length && !st.keep_all) cols = cols.filter((c) => st.columns.includes(c.name)); break;
      case 'pivot_wider': case 'transpose': return null;
      default: // filter, arrange, slice, drop_na, reorder: the same columns
    }
  }
  return { columns: cols, predicted: true };
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

// About 3.5 characters per token for English and JSON.
export function estimateTokens(text) {
  return Math.ceil(String(text || '').length / 3.5);
}

// ---- planning: think, then break the request into steps ------------------------------------------

const PLAN_EXAMPLES = `Examples, for a table "Plates" with one column per group (Control (number), Drug (number)):
User: compare control and drug, show it as a dot plot with the p value, and call the y axis "Colonies"
{"thinking":"Two independent groups, one column each; the samples are small, so a Mann-Whitney test. The graph needs the comparison on it, then a Y title.","plan":["Run a Mann-Whitney test comparing Control and Drug in Plates","Make a scatter dot plot of Plates","Compare the groups on that graph with a Mann-Whitney test","Set the graph's Y axis title to \"Colonies\""],"reply":"I'll test Control against Drug and show it on a dot plot."}
User: what is an SEM?
{"thinking":"A question; nothing to do in the app.","plan":[],"reply":"The standard error of the mean: how precisely the mean is known (the SD divided by the square root of n)."}`;

export function planPrompt() {
  return `You are the assistant inside Agrafeuse, a point-and-click app for statistics and graphs (R, ggplot2, dplyr) that runs in the browser.
The app can: reshape, filter and summarise data (dplyr steps in a table's pipeline, or a new dataset made from another), run statistical tests (t tests, Mann-Whitney, Wilcoxon, ANOVA, Welch's ANOVA, Kruskal-Wallis, repeated measures, Friedman, two-way ANOVA, mixed models, correlation, regression, descriptive statistics), make graphs (dot plots, bars with points, box, violin, grouped bars, lines over time, XY with a fit, histograms), add compared groups or an analysis's p values to a graph, add text boxes, and set titles, axes, colours and themes.
First think about what the user wants and what their data allow. Then break the request into an ordered list of small steps, each one thing the app can do, in the order they must happen (data before the tests and graphs that use it; a graph before the p values or titles on it). Say in each step which dataset, columns and test or graph it uses, with names exactly as listed in the project.
Answer with ONE JSON object and nothing else: {"thinking": "<one to three sentences>", "plan": ["<step 1>", "<step 2>", ...], "reply": "<short message for the user>"}
If the user only asks a question, answer it in "reply" and leave "plan" empty. Use at most 8 steps.
${PLAN_EXAMPLES}`;
}

// The planning call: what the user asked, with the project and recent conversation.
export function planMessages(app, history, request, opts = {}) {
  const budget = opts.budget || 100000;
  let sys = `${planPrompt()}\n\n${projectSummary(app, opts)}`;
  if (estimateTokens(sys) + estimateTokens(request) > budget - 300) sys = `${planPrompt()}\n\n${projectSummary(app, { ...opts, compact: true })}`;
  let past = history.slice(-4);
  const size = () => estimateTokens(sys) + estimateTokens(request) + past.reduce((n, m) => n + estimateTokens(m.content), 0);
  while (past.length && size() > budget) past = past.slice(2);
  return [{ role: 'system', content: sys }, ...past, { role: 'user', content: request }];
}

// One step of a plan: the actions for it, seeing the working copy (what earlier steps made).
export function stepMessages(app, request, plan, k, done, opts = {}) {
  const budget = opts.budget || 100000;
  const content = `The user asked: "${request}"
The plan:
${plan.map((st, j) => `${j + 1}. ${st}`).join('\n')}
Done so far: ${done.length ? done.join(' ') : 'nothing yet.'}
Now give the actions for step ${k + 1} only: "${plan[k]}". Items made by earlier steps are listed in the project with their columns. Answer with the JSON object {"reply": "...", "actions": [...]}.`;
  let sys = `${systemPrompt()}\n\n${projectSummary(app, opts)}`;
  if (estimateTokens(sys) + estimateTokens(content) > budget - 300) sys = `${systemPrompt()}\n\n${projectSummary(app, { ...opts, compact: true })}`;
  return [{ role: 'system', content: sys }, { role: 'user', content }];
}

// Asking again when some proposed actions cannot be done.
export function repairRequest(problems) {
  return `Some of your actions cannot be done in this project:\n${problems.map((p) => `- action ${p.index + 1} (${p.do}): ${p.why}`).join('\n')}\nAnswer again with the whole corrected JSON object. Use only dataset, item and column names exactly as listed in the project; leave out what cannot be done.`;
}
