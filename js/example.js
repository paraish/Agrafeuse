// A small example project that shows the main features. The data are three
// classic R datasets: PlantGrowth, ToothGrowth and DNase (run 1).
import { emptyProject, newDataTable, newTransform, newAnalysis, newGraph } from './model.js';

const PLANT = [['4.17', '4.81', '6.31'], ['5.58', '4.17', '5.12'], ['5.18', '4.41', '5.54'], ['6.11', '3.59', '5.5'], ['4.5', '5.87', '5.37'], ['4.61', '3.83', '5.29'], ['5.17', '6.03', '4.92'], ['4.53', '4.89', '6.15'], ['5.33', '4.32', '5.8'], ['5.14', '4.69', '5.26']];
const TOOTH_LEN = {
  'VC 0.5': [4.2, 11.5, 7.3, 5.8, 6.4, 10, 11.2, 11.2, 5.2, 7],
  'VC 1': [16.5, 16.5, 15.2, 17.3, 22.5, 17.3, 13.6, 14.5, 18.8, 15.5],
  'VC 2': [23.6, 18.5, 33.9, 25.5, 26.4, 32.5, 26.7, 21.5, 23.3, 29.5],
  'OJ 0.5': [15.2, 21.5, 17.6, 9.7, 14.5, 10, 8.2, 9.4, 16.5, 9.7],
  'OJ 1': [19.7, 23.3, 23.6, 26.4, 20, 25.2, 25.8, 21.2, 14.5, 27.3],
  'OJ 2': [25.5, 26.4, 22.4, 24.5, 24.8, 30.9, 26.4, 27.3, 29.4, 23],
};
const DNASE = [['0.04882812', '0.017'], ['0.04882812', '0.018'], ['0.1953125', '0.121'], ['0.1953125', '0.124'], ['0.390625', '0.206'], ['0.390625', '0.215'], ['0.78125', '0.377'], ['0.78125', '0.374'], ['1.5625', '0.614'], ['1.5625', '0.609'], ['3.125', '1.019'], ['3.125', '1.001'], ['6.25', '1.334'], ['6.25', '1.364'], ['12.5', '1.73'], ['12.5', '1.71']];

const col = (name, type = 'auto') => ({ name, type });
const map = (c) => ({ mode: 'col', col: c });
const fixed = (v) => ({ mode: 'const', value: v });

export function exampleProject() {
  const p = emptyProject('Example project');

  // 1. A Prism-style column table → long format → one-way ANOVA → scatter dot plot.
  const plant = newDataTable(p, {
    name: 'Plant growth',
    columns: [col('Control'), col('Treatment 1'), col('Treatment 2')],
    rows: PLANT.map((r) => [...r]),
  });
  const plantLong = newTransform(p, plant.id, [
    { type: 'pivot_longer', cols: ['Control', 'Treatment 1', 'Treatment 2'], names_to: 'group', values_to: 'weight', drop_na: true },
  ], 'Plant growth (long)');
  const anova = newAnalysis(p, 'anova1', plantLong.id, { name: 'One-way ANOVA', y: 'weight', group: 'group' });
  newGraph(p, {
    name: 'Plant growth: scatter dot plot',
    layers: [
      { id: 'l1', geom: 'jitter', dataset: plantLong.id, aes: { x: map('group'), y: map('weight'), colour: map('group'), size: fixed(2.5) }, params: { width: 0.15 } },
      { id: 'l2', geom: 'mean_line', dataset: plantLong.id, aes: { x: map('group'), y: map('weight'), linewidth: fixed(0.8) }, params: { width: 0.45 } },
      { id: 'l3', geom: 'errorbar', dataset: plantLong.id, aes: { x: map('group'), y: map('weight'), linewidth: fixed(0.8) }, params: { error: 'sem', width: 0.25 } },
    ],
    labels: { title: '', x: '', y: 'Dried weight (g)', legend: '', hide_x: true },
    theme: { name: 'prism', base_size: 14, legend: 'none', x_angle: 0 },
    palette: { name: 'okabe', manual: {} },
    size: { width: 4, height: 4, dpi: 300 },
    annotations: [{ id: 'a1', kind: 'brackets', analysis: anova.id, format: 'stars', hide_ns: false }],
  });

  // 2. A long table with two factors → two-way ANOVA → grouped bar chart.
  const toothRows = [];
  for (const [key, vals] of Object.entries(TOOTH_LEN)) {
    const [supp, dose] = key.split(' ');
    for (const v of vals) toothRows.push([supp === 'VC' ? 'Ascorbic acid' : 'Orange juice', dose, String(v)]);
  }
  const tooth = newDataTable(p, {
    name: 'Tooth growth',
    columns: [col('supplement', 'text'), col('dose', 'text'), col('length')],
    rows: toothRows,
  });
  const anova2 = newAnalysis(p, 'anova2', tooth.id, {
    name: 'Two-way ANOVA', y: 'length', group: 'supplement', factorB: 'dose',
    options: { interaction: true, sstype: 'III', scope: 'A_within_B', compare: 'pairs', correction: 'sidak' },
  });
  newGraph(p, {
    name: 'Tooth growth: grouped bars',
    layers: [
      { id: 'l1', geom: 'mean_bar', dataset: tooth.id, aes: { x: map('dose'), y: map('length'), fill: map('supplement'), colour: fixed('#000000') }, params: { width: 0.7, dodge: true } },
      { id: 'l2', geom: 'errorbar', dataset: tooth.id, aes: { x: map('dose'), y: map('length'), fill: map('supplement') }, params: { error: 'sd', direction: 'up', width: 0.25, dodge: true } },
      { id: 'l3', geom: 'jitter', dataset: tooth.id, aes: { x: map('dose'), y: map('length'), fill: map('supplement'), shape: fixed(21), size: fixed(1.8) }, params: { width: 0.12, dodge: true } },
    ],
    labels: { title: '', x: 'Vitamin C dose (mg/day)', y: 'Tooth length (mm)', legend: 'Supplement' },
    theme: { name: 'prism', base_size: 14, legend: 'top', x_angle: 0 },
    palette: { name: 'manual', manual: { 'Ascorbic acid': '#d9d9d9', 'Orange juice': '#f4a261' } },
    y_scale: { trans: 'identity', min: '', max: '', from_zero: true },
    size: { width: 5, height: 4.5, dpi: 300 },
    annotations: [{ id: 'a1', kind: 'brackets', analysis: anova2.id, format: 'stars', hide_ns: false }],
  });

  // 3. An XY table → 4-parameter dose-response fit → curve on a log axis.
  const dnase = newDataTable(p, {
    name: 'DNase assay',
    columns: [col('concentration'), col('density')],
    rows: DNASE.map((r) => [...r]),
  });
  const fit = newAnalysis(p, 'regression', dnase.id, { name: 'Dose-response fit', x: 'concentration', y: 'density', options: { model: '4pl', logx: false } });
  newGraph(p, {
    name: 'DNase: dose-response curve',
    layers: [
      { id: 'l1', geom: 'point', dataset: dnase.id, aes: { x: map('concentration'), y: map('density'), shape: fixed(21), fill: fixed('#ffffff'), size: fixed(2.5) }, params: {} },
    ],
    labels: { title: '', x: 'DNase concentration (ng/ml)', y: 'Optical density' },
    theme: { name: 'prism', base_size: 14, legend: 'right', x_angle: 0 },
    x_scale: { trans: 'log10', min: '', max: '', from_zero: false },
    size: { width: 5, height: 4, dpi: 300 },
    annotations: [
      { id: 'a1', kind: 'curve', analysis: fit.id, colour: '#0072B2', band: true },
      { id: 'a2', kind: 'label', analysis: fit.id, position: 'top-left' },
    ],
  });
  return p;
}
