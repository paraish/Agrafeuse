// Ready-made starting points for new graphs. Each one is just a set of layers,
// which the user can then change or add to.
import { newGraph } from '../model.js';

const map = (c) => (c ? { mode: 'col', col: c } : undefined);
const fixed = (v) => ({ mode: 'const', value: v });
let n = 0;
const L = (geom, dataset, aes, params = {}) => ({ id: `l${Date.now().toString(36)}${n++}`, geom, dataset, aes, params });

// Small schematic pictures for the gallery.
const T = {
  scatter: '<path d="M8 40h40M8 40V6"/><g fill="currentColor" stroke="none"><circle cx="16" cy="26" r="1.8"/><circle cx="18" cy="22" r="1.8"/><circle cx="15" cy="20" r="1.8"/><circle cx="29" cy="14" r="1.8"/><circle cx="27" cy="18" r="1.8"/><circle cx="30" cy="11" r="1.8"/><circle cx="41" cy="24" r="1.8"/><circle cx="39" cy="28" r="1.8"/><circle cx="42" cy="30" r="1.8"/></g><path d="M12 22h8M25 15h8M36 27h8"/>',
  bars: '<path d="M8 40h40M8 40V6"/><rect x="12" y="20" width="8" height="20"/><rect x="25" y="12" width="8" height="28"/><rect x="38" y="26" width="8" height="14"/><path d="M16 16v4M29 8v4M42 22v4M14 16h4M27 8h4M40 22h4"/>',
  box: '<path d="M8 40h40M8 40V6"/><rect x="12" y="16" width="8" height="14"/><rect x="25" y="10" width="8" height="12"/><rect x="38" y="20" width="8" height="12"/><path d="M12 22h8M25 15h8M38 27h8M16 10v6M16 30v5M29 5v5M29 22v6M42 15v5M42 32v4"/>',
  violin: '<path d="M8 40h40M8 40V6"/><path d="M16 8c-5 8-5 16 0 30 5-14 5-22 0-30zM29 6c-6 8-6 14 0 28 6-14 6-20 0-28zM42 14c-5 8-5 14 0 24 5-10 5-16 0-24z"/>',
  grouped: '<path d="M8 40h40M8 40V6"/><rect x="11" y="24" width="6" height="16"/><rect x="17" y="18" width="6" height="22" fill="currentColor" fill-opacity=".35"/><rect x="28" y="16" width="6" height="24"/><rect x="34" y="10" width="6" height="30" fill="currentColor" fill-opacity=".35"/>',
  xy: '<path d="M8 40h40M8 40V6"/><path d="M10 36 46 10"/><g fill="currentColor" stroke="none"><circle cx="14" cy="31" r="1.8"/><circle cx="20" cy="30" r="1.8"/><circle cx="25" cy="24" r="1.8"/><circle cx="31" cy="22" r="1.8"/><circle cx="36" cy="16" r="1.8"/><circle cx="43" cy="14" r="1.8"/></g>',
  line: '<path d="M8 40h40M8 40V6"/><path d="M12 32 22 24 32 20 44 12"/><path d="M12 36 22 32 32 30 44 26" stroke-dasharray="3 2"/><path d="M22 21v6M32 17v6M44 9v6M22 29v6M32 27v6"/>',
  hist: '<path d="M8 40h40M8 40V6"/><path d="M11 40V32h5v-10h5v-8h5v6h5v10h5v6h5v4"/>',
  blank: '<path d="M8 40h40M8 40V6"/><path d="M28 16v14M21 23h14"/>',
};

export const GRAPH_TEMPLATES = [
  { key: 'scatter_dot', label: 'Scatter dot plot', desc: 'Every value, with a line at the mean ± SEM', thumb: T.scatter, needs: ['x', 'y'] },
  { key: 'bar_points', label: 'Bar graph with points', desc: 'Mean ± SEM bars and the individual values', thumb: T.bars, needs: ['x', 'y'] },
  { key: 'box', label: 'Box and whiskers', desc: 'Median, quartiles and the individual values', thumb: T.box, needs: ['x', 'y'] },
  { key: 'violin', label: 'Violin plot', desc: 'The distribution shape, with the median', thumb: T.violin, needs: ['x', 'y'] },
  { key: 'grouped_bars', label: 'Grouped bars', desc: 'Two factors: groups side by side, mean ± SEM', thumb: T.grouped, needs: ['x', 'y', 'group'] },
  { key: 'xy', label: 'XY scatter with a line', desc: 'Two measurements, with a fitted straight line', thumb: T.xy, needs: ['x', 'y'], numericX: true },
  { key: 'time_course', label: 'Lines over time', desc: 'Mean ± SEM at each X, one line per group', thumb: T.line, needs: ['x', 'y'], optional: ['group'] },
  { key: 'histogram', label: 'Histogram', desc: 'How one measurement is distributed', thumb: T.hist, needs: ['y'] },
  { key: 'blank', label: 'Blank', desc: 'Start empty and add layers yourself', thumb: T.blank, needs: [] },
];

export function thumb(t) {
  return `<svg viewBox="0 0 54 46" width="54" height="46" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${t.thumb}</svg>`;
}

export function graphFromTemplate(project, key, { dataset, x, y, group, name }) {
  const g = { name };
  const ax = { x: map(x), y: map(y) };
  const col = group ? map(group) : map(x);
  switch (key) {
    case 'scatter_dot':
      g.layers = [
        L('jitter', dataset, { ...ax, colour: col, size: fixed(2.2) }, { width: 0.15 }),
        L('mean_line', dataset, { ...ax, linewidth: fixed(0.8) }, { width: 0.45 }),
        L('errorbar', dataset, { ...ax, linewidth: fixed(0.8) }, { error: 'sem', width: 0.25 }),
      ];
      g.theme = { name: 'lab', base_size: 14, legend: 'none', x_angle: 0 };
      g.palette = { name: 'okabe', manual: {} };
      break;
    case 'bar_points':
      g.layers = [
        L('mean_bar', dataset, { ...ax, fill: fixed('#d9d9d9'), colour: fixed('#000000') }, { width: 0.6 }),
        L('errorbar', dataset, { ...ax, linewidth: fixed(0.7) }, { error: 'sem', direction: 'up', width: 0.25 }),
        L('jitter', dataset, { ...ax, size: fixed(1.8) }, { width: 0.12 }),
      ];
      g.y_scale = { trans: 'identity', min: '', max: '', from_zero: true };
      break;
    case 'box':
      g.layers = [
        L('boxplot', dataset, { ...ax, fill: col, alpha: fixed(0.5) }, { width: 0.6, outliers: false, staplewidth: 0.4 }),
        L('jitter', dataset, { ...ax, size: fixed(1.6) }, { width: 0.12 }),
      ];
      g.theme = { name: 'lab', base_size: 14, legend: 'none', x_angle: 0 };
      g.palette = { name: 'okabe', manual: {} };
      break;
    case 'violin':
      g.layers = [
        L('violin', dataset, { ...ax, fill: col, alpha: fixed(0.6) }, { width: 0.8, trim: true, scale: 'width' }),
        L('mean_line', dataset, { ...ax, linewidth: fixed(0.8) }, { fun: 'median', width: 0.3 }),
      ];
      g.theme = { name: 'lab', base_size: 14, legend: 'none', x_angle: 0 };
      g.palette = { name: 'okabe', manual: {} };
      break;
    case 'grouped_bars': {
      const gp = { ...ax, fill: map(group) };
      g.layers = [
        L('mean_bar', dataset, { ...gp, colour: fixed('#000000') }, { width: 0.7, dodge: true }),
        L('errorbar', dataset, gp, { error: 'sem', direction: 'up', width: 0.25, dodge: true }),
        L('jitter', dataset, { ...gp, shape: fixed(21), size: fixed(1.6) }, { width: 0.12, dodge: true }),
      ];
      g.theme = { name: 'lab', base_size: 14, legend: 'top', x_angle: 0 };
      g.palette = { name: 'grey', manual: {} };
      g.y_scale = { trans: 'identity', min: '', max: '', from_zero: true };
      break;
    }
    case 'xy':
      g.layers = [
        L('point', dataset, { ...ax, size: fixed(2.2) }),
        L('smooth', dataset, { ...ax, colour: fixed('#0072B2') }, { method: 'lm', se: true }),
      ];
      break;
    case 'time_course': {
      const gp = group ? { ...ax, colour: map(group) } : ax;
      g.layers = [
        L('mean_connect', dataset, { ...gp, linewidth: fixed(0.8) }),
        L('errorbar', dataset, gp, { error: 'sem', width: 0.2 }),
        L('mean_point', dataset, { ...gp, size: fixed(2.5) }),
      ];
      if (group) g.palette = { name: 'okabe', manual: {} };
      break;
    }
    case 'histogram':
      g.layers = [L('histogram', dataset, { x: map(y), fill: fixed('#9ecae1'), colour: fixed('#ffffff') }, { bins: 20 })];
      g.y_scale = { trans: 'identity', min: '', max: '', from_zero: true };
      break;
    default:
      g.layers = [];
  }
  g.labels = { title: '', x: '', y: '', legend: '' };
  if (['scatter_dot', 'bar_points', 'box', 'violin'].includes(key)) g.labels.hide_x = false;
  g.layers = (g.layers || []).map((l) => ({ ...l, aes: Object.fromEntries(Object.entries(l.aes).filter(([, v]) => v)) }));
  return newGraph(project, g);
}
