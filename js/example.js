// The example project: one dataset (R's classic PlantGrowth data) entered as a
// column table (one column per group), reshaped to long format, analysed with a one-way
// ANOVA, and graphed with the ANOVA's p values on top.
import { emptyProject, newDataTable, newTransform, newAnalysis, newGraph } from './model.js';
import { ensureBase } from './codegen/graph.js';

const PLANT = [['4.17', '4.81', '6.31'], ['5.58', '4.17', '5.12'], ['5.18', '4.41', '5.54'], ['6.11', '3.59', '5.5'], ['4.5', '5.87', '5.37'], ['4.61', '3.83', '5.29'], ['5.17', '6.03', '4.92'], ['4.53', '4.89', '6.15'], ['5.33', '4.32', '5.8'], ['5.14', '4.69', '5.26']];
const col = (name, type = 'auto') => ({ name, type });
const map = (c) => ({ mode: 'col', col: c });
const fixed = (v) => ({ mode: 'const', value: v });

export function exampleProject() {
  const p = emptyProject('Example project');

  const plant = newDataTable(p, {
    name: 'Plant growth',
    columns: [col('Control'), col('Treatment 1'), col('Treatment 2')],
    rows: PLANT.map((r) => [...r]),
  });
  const plantLong = newTransform(p, plant.id, [
    { type: 'pivot_longer', cols: ['Control', 'Treatment 1', 'Treatment 2'], names_to: 'group', values_to: 'weight', drop_na: true },
  ], 'Plant growth (long)');
  const anova = newAnalysis(p, 'anova1', plantLong.id, { name: 'One-way ANOVA', y: 'weight', group: 'group' });
  newGraph(p, ensureBase({
    name: 'Plant growth: scatter dot plot',
    layers: [
      { id: 'l1', geom: 'jitter', dataset: plantLong.id, aes: { x: map('group'), y: map('weight'), colour: map('group'), size: fixed(2.5) }, params: { width: 0.15 } },
      { id: 'l2', geom: 'mean_line', dataset: plantLong.id, aes: { x: map('group'), y: map('weight'), linewidth: fixed(0.8) }, params: { width: 0.45 } },
      { id: 'l3', geom: 'errorbar', dataset: plantLong.id, aes: { x: map('group'), y: map('weight'), linewidth: fixed(0.8) }, params: { error: 'sem', width: 0.25 } },
    ],
    labels: { title: '', x: '', y: 'Dried weight (g)', legend: '', hide_x: true },
    theme: { name: 'lab', base_size: 14, legend: 'none' },
    palette: { name: 'okabe', manual: {} },
    size: { width: 4, height: 4, dpi: 300 },
    annotations: [{ id: 'a1', kind: 'brackets', analysis: anova.id, format: 'stars', hide_ns: false }],
  }));
  return p;
}
