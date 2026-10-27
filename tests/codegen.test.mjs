// Generates R code for many project configurations and runs it in native R.
// Usage: R_SCRIPT=/path/to/Rscript node tests/codegen.test.mjs
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { exampleProject } from '../js/example.js';
import { addFixtures } from './fixtures.mjs';
import { getItem, newDataTable, newTransform, newAnalysis, newGraph, itemCode, topoOrder, itemPackages } from '../js/model.js';
import { dataSchema } from '../js/codegen/data.js';
import { testDefaults, usesMixedModel } from '../js/codegen/stats.js';
import { GEOMS, geomDefaults, PALETTES } from '../js/codegen/graph.js';

const p = exampleProject();
addFixtures(p);
const plant = p.items.find((i) => i.name === 'Plant growth');
const plantLong = p.items.find((i) => i.name === 'Plant growth (long)');
const tooth = p.items.find((i) => i.name === 'Tooth growth');
const dnase = p.items.find((i) => i.name === 'DNase assay');

// Repeated measures: 8 mice x 3 times, two genotypes. Deterministic values.
const rmRows = [];
for (let m = 1; m <= 8; m++) for (const [ti, t] of ['Day 0', 'Day 7', 'Day 14'].entries()) {
  const geno = m <= 4 ? 'WT' : 'KO';
  const v = 10 + m * 0.7 + ti * (geno === 'KO' ? 4 : 2) + ((m * 7 + ti * 3) % 5) * 0.3;
  rmRows.push([`Mouse ${m}`, geno, t, v.toFixed(2)]);
}
const rm = newDataTable(p, { name: 'Repeated', columns: [{ name: 'mouse', type: 'text' }, { name: 'genotype', type: 'text' }, { name: 'time', type: 'text' }, { name: 'Body weight', type: 'auto' }], rows: rmRows });
const decayRows = [0, 1, 2, 3, 4, 6, 8, 12, 16, 24].map((t) => [String(t), (20 + 80 * Math.exp(-0.25 * t) + ((t * 13) % 7) * 0.4 - 1).toFixed(2)]);
const decay = newDataTable(p, { name: 'Decay', columns: [{ name: 'time', type: 'auto' }, { name: 'signal', type: 'auto' }], rows: decayRows });

const wideOpts = (test, extra = {}) => ({ layout: 'columns', columns: ['Control', 'Treatment 1', 'Treatment 2'], groups: ['Control', 'Treatment 1'], ...extra });
const longOpts = (extra = {}) => ({ layout: 'long', y: 'weight', group: 'group', groups: ['Control', 'Treatment 2'], ...extra });
const add = (test, ds, extra, opts = {}) => newAnalysis(p, test, ds.id, { ...extra, options: { ...testDefaults(test), ...opts } });

for (const t of ['descriptive', 'normality', 'ttest_unpaired', 'ttest_paired', 'ttest_ratio', 'mann_whitney', 'wilcoxon_paired', 'anova1', 'welch_anova', 'kruskal', 'rm_anova', 'friedman']) {
  add(t, plant, wideOpts(t));
}
add('one_sample', plant, { layout: 'columns', columns: ['Control'] }, { mu: 5 });
add('one_sample', plantLong, { layout: 'long', y: 'weight', group: 'group', oneLevel: 'Treatment 2' }, { mu: 5, kind: 'wilcoxon' });
for (const t of ['descriptive', 'ttest_unpaired', 'mann_whitney', 'anova1', 'welch_anova', 'kruskal']) add(t, plantLong, longOpts());
add('anova1', plantLong, longOpts(), { compare: 'control', control: 'Control', correction: 'dunnettx' });
add('anova1', plantLong, longOpts(), { compare: 'none' });
add('kruskal', plantLong, longOpts(), { compare: 'control', control: 'Control', padjust: 'holm' });
add('ttest_paired', rm, { layout: 'long', y: 'Body weight', group: 'time', subject: 'mouse', groups: ['Day 0', 'Day 14'] });
add('rm_anova', rm, { layout: 'long', y: 'Body weight', group: 'time', subject: 'mouse' }, { compare: 'control', control: 'Day 0', correction: 'holm' });
add('friedman', rm, { layout: 'long', y: 'Body weight', group: 'time', subject: 'mouse' });
for (const scope of ['B_within_A', 'A', 'B', 'cells', 'none']) add('anova2', tooth, { y: 'length', group: 'supplement', factorB: 'dose' }, { scope, sstype: scope === 'A' ? 'I' : 'III', correction: 'holm' });
add('anova2', tooth, { y: 'length', group: 'dose', factorB: 'supplement' }, { interaction: false, scope: 'A', compare: 'control', control: '0.5', correction: 'dunnettx' });
const mixed = add('mixed', rm, { y: 'Body weight', fixed: ['genotype', 'time'], random: ['mouse'] }, { by: 'time' });
add('mixed', rm, { y: 'Body weight', fixed: ['time'], random: ['mouse'] }, { compare: 'control', control: 'Day 0', correction: 'dunnettx' });
for (const method of ['pearson', 'spearman', 'kendall']) add('correlation', dnase, { x: 'concentration', y: 'density' }, { method });
for (const model of ['linear', 'origin', 'poly2', 'poly3', 'log', 'power', 'mm']) add('regression', dnase, { x: 'concentration', y: 'density' }, { model });
add('regression', decay, { x: 'time', y: 'signal' }, { model: 'decay' });
add('regression', decay, { x: 'time', y: 'signal' }, { model: 'exp' });

// Transforms: every step type.
newTransform(p, tooth.id, [
  { type: 'filter', column: 'length', op: '>', value: '5' },
  { type: 'filter', column: 'supplement', op: 'in', values: ['Orange juice', 'Ascorbic acid'] },
  { type: 'filter', column: 'dose', op: 'not missing' },
  { type: 'reorder', column: 'supplement', levels: ['Orange juice'] },
  { type: 'mutate', name: 'log length', expr: 'log10(length)' },
  { type: 'convert', column: 'dose', to: 'numeric' },
  { type: 'rename', from: 'log length', to: 'loglen' },
  { type: 'arrange', column: 'loglen', desc: true },
  { type: 'drop_na', columns: [] },
  { type: 'select', columns: ['supplement', 'dose', 'length', 'loglen'] },
], 'Tooth transformed');
const trSum = newTransform(p, tooth.id, [{ type: 'summarise', group_by: ['supplement', 'dose'], column: 'length', stats: ['mean', 'sd', 'sem', 'n', 'median', 'min', 'max'] }], 'Tooth summary');
const trWide = newTransform(p, trSum.id, [{ type: 'select', columns: ['supplement', 'dose', 'mean'] }, { type: 'pivot_wider', names_from: 'supplement', values_from: 'mean' }], 'Tooth wide');
newTransform(p, trWide.id, [{ type: 'transpose', names_col: 'dose' }], 'Tooth transposed');
newTransform(p, plant.id, [{ type: 'transpose' }], 'Plant transposed');
newTransform(p, tooth.id, [
  { type: 'filter', op: 'expr', expr: 'length > 10 & dose != 2' },
  { type: 'mutate', name: 'double', expr: 'length * 2' },
  { type: 'filter', column: 'double', op: '>=', value: '20' }, // made by a step: numeric from its value
  { type: 'slice', mode: 'max', n: 2, column: 'length', by: ['supplement'] },
  { type: 'distinct', columns: ['supplement'], keep_all: true },
], 'Tooth more verbs');
newTransform(p, tooth.id, [{ type: 'count', columns: ['supplement', 'dose'], sort: true }, { type: 'slice', mode: 'head', n: 3 }], 'Tooth counts');
// Grouping: steps work within groups until ungroup or summarise; per-step "by" settings give way to it.
newTransform(p, tooth.id, [
  { type: 'group_by', columns: ['supplement', 'dose'] },
  { type: 'mutate', name: 'pct', expr: 'length / mean(length) * 100' },
  { type: 'filter', column: 'pct', op: '>', value: '90' },
  { type: 'slice', mode: 'min', n: 2, column: 'pct', by: ['not a column'] },
  { type: 'arrange', column: 'length', desc: true },
  { type: 'summarise', column: 'length', stats: ['mean', 'n'], group_by: ['not a column'] },
  { type: 'group_by', columns: ['supplement'] },
  { type: 'count', columns: ['dose'] },
], 'Tooth grouped (ends grouped)');
newTransform(p, tooth.id, [
  { type: 'group_by', columns: ['dose'] },
  { type: 'distinct', columns: ['supplement'] },
  { type: 'ungroup' },
  { type: 'ungroup' },
  { type: 'group_by', columns: [], disabled: true },
], 'Tooth group then ungroup');
newTransform(p, tooth.id, [
  { type: 'distinct', columns: [] },
  { type: 'slice', mode: 'tail', n: 4, by: ['dose'] },
  { type: 'slice', mode: 'min', n: 1, column: 'length' },
  { type: 'count', columns: [] },
], 'Tooth slices');

// Graphs: every geom, several settings.
const map = (c) => ({ mode: 'col', col: c });
const fx = (v) => ({ mode: 'const', value: v });
for (const [key, g] of Object.entries(GEOMS)) {
  let layer;
  if (g.noData && !g.custom) layer = { geom: key, aes: { colour: fx('#ff0000'), linetype: fx('dashed') }, params: geomDefaults(key) };
  else if (g.custom) layer = { geom: key, code: 'annotate("text", x = 1, y = 7, label = "custom")' };
  else if (['histogram', 'density', 'bar_count'].includes(key)) layer = { geom: key, dataset: plantLong.id, aes: { x: map(key === 'bar_count' ? 'group' : 'weight'), fill: map('group'), alpha: fx(0.6) }, params: geomDefaults(key) };
  else if (key === 'errorbar_cols') layer = { geom: key, dataset: trSum.id, aes: { x: map('dose'), ymin: map('mean'), ymax: map('max'), colour: map('supplement') }, params: { ...geomDefaults(key), dodge: true } };
  else if (key === 'text') layer = { geom: key, dataset: plantLong.id, aes: { x: map('group'), y: map('weight'), label: map('weight') }, params: { nudge_y: 0.1 } };
  else if (key === 'tile') layer = { geom: key, dataset: trSum.id, aes: { x: map('dose'), y: map('supplement'), fill: map('mean') }, params: {} };
  else if (key === 'col') layer = { geom: key, dataset: trSum.id, aes: { x: map('dose'), y: map('mean'), fill: map('supplement') }, params: { ...geomDefaults(key), dodge: true } };
  else layer = { geom: key, dataset: plantLong.id, aes: { x: map('group'), y: map('weight'), colour: map('group'), size: g.aes.includes('size') ? fx(2) : undefined }, params: geomDefaults(key) };
  const base = key === 'hline' || key === 'vline' || key === 'custom'
    ? [{ geom: 'jitter', dataset: plantLong.id, aes: { x: map('group'), y: map('weight') }, params: geomDefaults('jitter') }] : [];
  newGraph(p, { name: `Geom ${key}`, layers: [...base, layer].map((l, i) => ({ id: `l${i}`, ...l })) });
}
PALETTES.forEach(([pal], i) => newGraph(p, {
  name: `Palette ${pal}`,
  layers: [{ id: 'l1', geom: 'boxplot', dataset: tooth.id, aes: { x: map('dose'), y: map('length'), fill: map('supplement'), colour: i % 2 ? map('supplement') : undefined }, params: { dodge: true } }],
  palette: { name: pal, manual: { 'Orange juice': '#ffa500', 'Ascorbic acid': '#336699' } },
  theme: { name: ['lab', 'classic', 'bw', 'minimal', 'light', 'gray', 'linedraw'][i % 7], base_size: 12, legend: ['right', 'top', 'bottom', 'none'][i % 4], x_angle: [0, 45, 90][i % 3] },
  labels: { title: 'T', subtitle: 'S', x: 'X', y: 'Y', legend: 'L', hide_legend_title: i % 2 === 0 },
  y_scale: { trans: ['identity', 'log10', 'log2', 'sqrt'][i % 4], min: i % 3 ? '' : '1', max: '', from_zero: i % 4 === 0 },
  facet: i % 3 === 0 ? { by: 'supplement', scales: 'free_y', ncol: 1 } : { by: '' },
  flip: i === 4,
  custom: i === 2 ? 'guides(fill = guide_legend(nrow = 1))' : '',
}));
newGraph(p, { name: 'Continuous colour', layers: [{ id: 'l1', geom: 'point', dataset: dnase.id, aes: { x: map('concentration'), y: map('density'), colour: map('density') } }], palette: { name: 'viridis' }, x_scale: { trans: 'log10', min: '0.01', max: '', from_zero: false } });
newGraph(p, { name: 'Two datasets', layers: [
  { id: 'l1', geom: 'point', dataset: tooth.id, aes: { x: map('dose'), y: map('length') } },
  { id: 'l2', geom: 'point', dataset: trSum.id, aes: { x: map('dose'), y: map('mean'), colour: fx('#cc0000'), size: fx(4) } }] });
newGraph(p, { name: 'Mixed brackets', layers: [
  { id: 'l1', geom: 'mean_bar', dataset: rm.id, aes: { x: map('time'), y: map('Body weight'), fill: map('genotype') }, params: { dodge: true } },
  { id: 'l2', geom: 'mean_connect', dataset: rm.id, aes: { x: map('time'), y: map('Body weight'), colour: map('genotype') } }],
  annotations: [{ id: 'a1', kind: 'brackets', analysis: mixed.id, format: 'p', hide_ns: false }, { id: 'a2', kind: 'label', analysis: mixed.id, position: 'bottom-right' }] });

// Row names typed in the grid: kept through wide → long and used as subject IDs.
const paired = newDataTable(p, {
  name: 'Paired with row names',
  columns: [{ name: 'Before', type: 'auto' }, { name: 'After', type: 'auto' }],
  rows: [['5.1', '6.0'], ['4.8', '5.9'], ['5.5', '6.4'], ['5.0', '5.2'], ['4.9', '6.1']],
  rowNames: ['Mouse 1', 'Mouse 2', 'Mouse 3', 'Mouse 4', 'Mouse 5'],
});
const pairedLong = newTransform(p, paired.id, [{ type: 'pivot_longer', cols: ['Before', 'After'], names_to: 'time', values_to: 'weight', drop_na: true }], 'Paired long');
add('ttest_paired', pairedLong, { layout: 'long', y: 'weight', group: 'time', subject: 'row_name', groups: ['Before', 'After'] });

// Formatting options from the panel under the graph.
newGraph(p, {
  name: 'Styled',
  layers: [{ id: 'l1', geom: 'jitter', dataset: plantLong.id, aes: { x: map('group'), y: map('weight'), colour: map('group') }, params: geomDefaults('jitter') }],
  labels: { title: 'Styled title', subtitle: 'Sub', x: '', y: 'Weight (g)' },
  theme: { name: 'classic', base_size: 12, legend: 'bottom' },
  style: {
    family: 'serif', axis_line: 1.2,
    title: { size: 18, bold: false, italic: true, underline: true, align: 'left' },
    x_title: { underline: true }, y_title: { size: 16, italic: true },
    x_text: { size: 12, angle: 45, bold: true }, y_text: { angle: 90, italic: true }, legend_text: { size: 9 },
  },
  y_scale: { trans: 'identity', min: 3, max: 7, step: 0.5, format: 'n1', reverse: true },
});
newGraph(p, {
  name: 'Log axis formats',
  layers: [{ id: 'l1', geom: 'point', dataset: dnase.id, aes: { x: map('concentration'), y: map('density') } }],
  x_scale: { trans: 'log10', format: 'pow10' },
  y_scale: { trans: 'identity', from_zero: true, step: 0.25, format: 'pct100' },
  style: { y_title: { underline: true, bold: true }, x_title: { bold: false }, title: { align: 'right' } },
  theme: { name: 'lab', base_size: 14, x_angle: 90 },
});

// Plot-wide data and aesthetics, inherited by layers (and switched off in some).
newGraph(p, {
  name: 'Plot-wide: lines per mouse',
  base: { dataset: rm.id, aes: { x: map('time'), y: map('Body weight'), group: map('mouse'), colour: map('genotype') } },
  layers: [
    { id: 'l1', geom: 'line', dataset: '', aes: { alpha: fx(0.5) } },
    { id: 'l2', geom: 'point', dataset: '', aes: { size: fx(2), shape: map('genotype') } },
    { id: 'l3', geom: 'mean_connect', dataset: '', aes: { group: { mode: 'none' }, linewidth: fx(1.4) }, params: geomDefaults('mean_connect') },
    { id: 'l4', geom: 'errorbar', dataset: '', aes: { group: { mode: 'none' }, colour: { mode: 'none' } }, params: geomDefaults('errorbar') },
    { id: 'l5', geom: 'hline', aes: { linetype: fx('dashed') }, params: { intercept: 20 } },
  ],
  palette: { name: 'okabe' },
});
newGraph(p, {
  name: 'Plot-wide: distributions',
  base: { dataset: plantLong.id, aes: { x: map('weight'), y: map('weight'), fill: map('group') } },
  layers: [
    { id: 'l1', geom: 'histogram', dataset: '', aes: { alpha: fx(0.6) }, params: { bins: 10, position: 'identity' } },
    { id: 'l2', geom: 'density', dataset: '', aes: { fill: { mode: 'none' }, colour: map('group') }, params: geomDefaults('density') },
  ],
});
newGraph(p, {
  name: 'Plot-wide: mappings without data',
  base: { dataset: '', aes: { x: map('group'), y: map('weight') } },
  layers: [{ id: 'l1', geom: 'jitter', dataset: plantLong.id, aes: {}, params: geomDefaults('jitter') },
    { id: 'l2', geom: 'smooth', dataset: dnase.id, aes: { x: map('concentration'), y: map('density') }, params: geomDefaults('smooth') }],
});
newGraph(p, {
  name: 'Plot-wide: dodged groups',
  base: { dataset: tooth.id, aes: { x: map('dose'), y: map('length'), fill: map('supplement'), group: map('supplement') } },
  layers: ['mean_bar', 'errorbar', 'jitter'].map((geom, i) => ({ id: `l${i}`, geom, dataset: '', aes: {}, params: { ...geomDefaults(geom), dodge: true } })),
  annotations: [],
});

// Schemas: data tables from JS, transforms unknown (null) like before R runs.
const schemaOf = (id) => {
  const it = getItem(p, id);
  return it?.kind === 'data' ? dataSchema(it) : null;
};

const items = topoOrder(p);
const jobs = items.map((it) => {
  try {
    return { id: it.id, name: it.name, kind: it.kind, rname: it.rname, code: itemCode(p, it, schemaOf), packages: itemPackages(it), w: it.size?.width || 5, h: it.size?.height || 4 };
  } catch (e) {
    return { id: it.id, name: it.name, kind: it.kind, codegenError: e.message };
  }
});
// Mixed models again with the nlme fallback engine.
for (const it of items.filter((x) => x.kind === 'analysis' && usesMixedModel(x))) {
  const opts = { mixedEngine: 'nlme' };
  jobs.push({ id: it.id, name: `${it.name} [nlme]`, kind: it.kind, rname: it.rname, code: itemCode(p, it, schemaOf, opts), packages: itemPackages(it, opts) });
}
const dir = mkdtempSync(join(tmpdir(), 'agtest-'));
writeFileSync(join(dir, 'jobs.json'), JSON.stringify(jobs));
writeFileSync(join(dir, 'run.R'), `
suppressPackageStartupMessages({ library(ggplot2); library(dplyr); library(tidyr) })
source("R/helpers.R")
jobs <- jsonlite::fromJSON(${JSON.stringify(join(dir, 'jobs.json'))}, simplifyVector = FALSE)
fails <- 0
for (j in jobs) {
  if (!is.null(j$codegenError)) { cat(sprintf("CODEGEN  %-40s %s\\n", j$name, j$codegenError)); fails <- fails + 1; next }
  r <- jsonlite::fromJSON(ag_eval_json(j$code))
  if (r$ok && j$kind == "graph") r <- jsonlite::fromJSON(ag_draw(get(j$rname), tempfile(fileext = ".svg"), "svg", j$w, j$h))
  if (r$ok && j$kind == "analysis") invisible(ag_result_json(get(j$rname)))
  if (r$ok && j$kind %in% c("data", "transform")) invisible(ag_describe(get(j$rname)))
  w <- if (length(r$warnings)) paste0("  [warnings: ", paste(r$warnings, collapse = " | "), "]") else ""
  if (!r$ok) { fails <- fails + 1; cat(sprintf("FAIL     %-40s %s\\n---\\n%s\\n---\\n", j$name, r$error, j$code)) }
  else cat(sprintf("ok       %-40s%s\\n", j$name, substr(w, 1, 200)))
}
cat("\\n", length(jobs), "items,", fails, "failures\\n")
if (fails) quit(status = 1)
`);
const R = process.env.R_SCRIPT || 'Rscript';
try {
  const out = execFileSync(R, [join(dir, 'run.R')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  console.log(out);
} catch (e) {
  console.log(e.stdout);
  console.error(e.stderr);
  process.exit(1);
}
