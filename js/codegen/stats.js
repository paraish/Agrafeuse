// Statistical analyses: each test knows which inputs it needs, its options,
// a plain-language explanation, and how to write its R code.
import { rsym, rstr, rnum, rvec, rbool, isSyntactic } from '../rcode.js';

export const CORRECTIONS = [
  ['tukey', 'Tukey (all pairs)'],
  ['dunnettx', 'Dunnett (each vs control)'],
  ['sidak', 'Šidák'],
  ['bonferroni', 'Bonferroni'],
  ['holm', 'Holm'],
  ['fdr', 'False discovery rate (Benjamini-Hochberg)'],
  ['none', "None (Fisher's LSD)"],
];
export const P_ADJUST = [
  ['bonferroni', 'Bonferroni'],
  ['holm', 'Holm'],
  ['fdr', 'False discovery rate (Benjamini-Hochberg)'],
  ['none', 'None'],
];
const ALTERNATIVE = { key: 'alternative', label: 'Hypothesis', type: 'select', def: 'two.sided',
  options: [['two.sided', 'Two-tailed (groups differ)'], ['greater', 'One-tailed: first > second'], ['less', 'One-tailed: first < second']] };
const COMPARE = { key: 'compare', label: 'Compare', type: 'select', def: 'pairs',
  options: [['pairs', 'Every pair of groups'], ['control', 'Each group with a control'], ['none', 'No multiple comparisons']] };
const CONTROL = { key: 'control', label: 'Control group', type: 'level', def: '', showIf: (o) => o.compare === 'control' };
const CORRECTION = { key: 'correction', label: 'Correction for multiple comparisons', type: 'select', def: 'tukey', options: CORRECTIONS, showIf: (o) => o.compare !== 'none' };

// Tukey only makes sense for all pairs, Dunnett only against a control.
export function normaliseCorrection(o) {
  let c = o.correction || 'tukey';
  if (o.compare === 'pairs' && c === 'dunnettx') c = 'tukey';
  if (o.compare === 'control' && c === 'tukey') c = 'dunnettx';
  return c;
}

const CORRECTION_NAMES = {
  tukey: "Tukey's multiple comparisons", dunnettx: "Dunnett's multiple comparisons", sidak: 'Šidák multiple comparisons',
  bonferroni: 'Bonferroni multiple comparisons', holm: 'Holm multiple comparisons', fdr: 'Multiple comparisons (FDR)',
  none: "Fisher's LSD (uncorrected)",
};

// --- shared pieces of generated code ------------------------------------------------------

function filterNA(vars) {
  return `filter(${vars.map((v) => `!is.na(${rsym(v)})`).join(', ')})`;
}

// Build `d`, a long data frame with one value column and one group column,
// from either layout. Returns the code lines and the column names to use.
function prepareGroups(a, ctx, { subject = false, two = false, oneLevel = false } = {}) {
  const src = ctx.rnameOf(a.dataset);
  if (a.layout === 'columns') {
    const columns = two ? (a.groups || []).slice(0, 2) : a.columns || [];
    if (two && columns.length < 2) throw new Error('Choose the two columns (groups) to compare.');
    if (!two && !oneLevel && columns.length < 2) throw new Error('Choose at least two columns (groups).');
    if (oneLevel && !columns.length) throw new Error('Choose a column.');
    const taken = new Set((ctx.schemaOf(a.dataset)?.columns || []).map((c) => c.name));
    const subj = taken.has('subject') ? '.subject' : 'subject';
    const steps = [];
    if (subject) steps.push(`mutate(${rsym(subj)} = factor(row_number()))`);
    steps.push(`pivot_longer(${rvec(columns.map(rsym), '    ')}, names_to = "group", values_to = "value", values_drop_na = TRUE)`);
    steps.push(`mutate(group = factor(group, levels = ${rvec(columns.map(rstr), '    ')}))`);
    return { lines: [`d <- ${src} |>\n    ${steps.join(' |>\n    ')}`], y: 'value', group: 'group', subject: subj, levels: columns };
  }
  if (!a.y) throw new Error('Choose the column with the values (Y).');
  if (!a.group && !oneLevel) throw new Error('Choose the column that defines the groups.');
  if (subject && !a.subject) throw new Error('Choose the column that identifies each subject (matched values share an ID).');
  const vars = [a.y, a.group, subject ? a.subject : null].filter(Boolean);
  const steps = [filterNA(vars)];
  const muts = [];
  let levels = null;
  if (two) {
    levels = (a.groups || []).slice(0, 2);
    if (levels.length < 2) throw new Error('Choose the two groups to compare.');
    steps.push(`filter(${rsym(a.group)} %in% ${rvec(levels.map(rstr), '    ')})`);
    muts.push(`${rsym(a.group)} = factor(${rsym(a.group)}, levels = ${rvec(levels.map(rstr), '    ')})`);
  } else if (a.group) {
    muts.push(`${rsym(a.group)} = ag_factor(${rsym(a.group)})`);
  }
  if (subject) muts.push(`${rsym(a.subject)} = ag_factor(${rsym(a.subject)})`);
  if (muts.length) steps.push(`mutate(${muts.join(', ')})`);
  return { lines: [`d <- ${src} |>\n    ${steps.join(' |>\n    ')}`], y: a.y, group: a.group, subject: a.subject, levels };
}

// nlme cannot handle names like `Body weight` in formulas, so for nlme the
// columns are renamed to plain names first. Returns the rename line (or null)
// and a function mapping old names to new ones.
function plainNames(cols) {
  const map = new Map();
  const used = new Set(cols.filter(isSyntactic));
  for (const c of cols) {
    if (!c || isSyntactic(c) || map.has(c)) continue;
    let base = c.replace(/[^A-Za-z0-9._]/g, '_').replace(/^(?![A-Za-z]|\.(?![0-9]))/, 'v_');
    let n = base;
    for (let i = 2; used.has(n); i++) n = `${base}_${i}`;
    used.add(n);
    map.set(c, n);
  }
  const line = map.size ? `d <- rename(d, ${[...map].map(([o, n]) => `${n} = ${rsym(o)}`).join(', ')})` : null;
  return { line, to: (c) => (c ? map.get(c) || c : c) };
}

function formula(y, rhs) {
  return `${rsym(y)} ~ ${rhs}`;
}

// `factor` is the column being compared (needed to find the control level).
function emmLines(fit, spec, o, extra = '', factor = null) {
  if (o.compare === 'none') return { lines: [], mc: 'NULL', name: null };
  const c = normaliseCorrection(o);
  const ref = o.control && factor ? `, ref = match(${rstr(o.control)}, levels(d$${rsym(factor)}))` : '';
  const method = o.compare === 'control' ? `"trt.vs.ctrl"${ref}` : '"pairwise"';
  return {
    lines: [
      `emm <- emmeans::emmeans(${fit}, ${spec}${extra})`,
      `mc <- emmeans::contrast(emm, method = ${method}, adjust = ${rstr(c)})`,
    ],
    mc: 'mc',
    name: CORRECTION_NAMES[c],
  };
}

function wideLines(p) {
  return `w <- d |>\n    pivot_wider(id_cols = ${rsym(p.subject)}, names_from = ${rsym(p.group)}, values_from = ${rsym(p.y)}) |>\n    na.omit()`;
}

function twoLevels(a, p) {
  const lv = p.levels || (a.layout === 'columns' ? a.groups : a.groups) || [];
  return lv.slice(0, 2);
}

const pairedOrder = (a, p) => twoLevels(a, p).map((g) => `w[[${rstr(g)}]]`);

// --- the tests ------------------------------------------------------------------------------

export const TESTS = {
  descriptive: {
    label: 'Descriptive statistics', category: 'Describe',
    short: 'Mean, SD, SEM, 95% CI, median and range per group.',
    explain: 'Mean, SD, SEM, 95% confidence interval, median, quartiles and range for each group. Use it to check your data before testing.',
    inputs: { layout: true, y: true, group: 'optional' },
    options: [],
    annotations: [],
    code(a, ctx) {
      const p = prepareGroups(a, ctx, { oneLevel: !a.group && a.layout !== 'columns' });
      return [...p.lines, `ag_descriptive(d, ${rstr(p.y)}${p.group ? `, ${rstr(p.group)}` : ''})`];
    },
  },
  normality: {
    label: 'Normality test (Shapiro-Wilk)', category: 'Describe',
    short: 'Could each group come from a normal distribution?',
    explain: 'Tests whether the values in each group could come from a normal (bell-shaped) distribution. t tests and ANOVA assume roughly normal residuals; if this fails clearly, consider a nonparametric test or a log transform.\n\nWith small samples (n < 10) these tests rarely detect anything, and with large samples they flag tiny, harmless deviations, so look at the data too.',
    inputs: { layout: true, y: true, group: 'optional' },
    options: [],
    annotations: [],
    code(a, ctx) {
      const p = prepareGroups(a, ctx, { oneLevel: !a.group && a.layout !== 'columns' });
      return [...p.lines, `ag_normality(d, ${rstr(p.y)}${p.group ? `, ${rstr(p.group)}` : ''})`];
    },
  },

  ttest_unpaired: {
    label: 'Unpaired t test', category: 'Compare two groups',
    short: 'Compare the means of two independent groups.',
    explain: 'Compares the means of two independent groups (different subjects in each group).\n\nWelch\'s version (the default) does not assume the two groups have the same SD and is the safer choice. Untick it for the classic Student\'s t test.\n\nAssumes values are roughly normally distributed within each group. If not, use the Mann-Whitney test.',
    inputs: { layout: true, y: true, group: true, two: true },
    options: [{ key: 'welch', label: "Welch's correction (don't assume equal SDs)", type: 'bool', def: true }, ALTERNATIVE],
    annotations: ['brackets', 'label'],
    code(a, ctx) {
      const p = prepareGroups(a, ctx, { two: true });
      const o = a.options || {};
      const welch = o.welch !== false;
      const title = welch ? "Welch's t test" : "Unpaired t test";
      return [...p.lines,
        `test <- t.test(${formula(p.y, rsym(p.group))}, data = d, var.equal = ${rbool(!welch)}, alternative = ${rstr(o.alternative || 'two.sided')})`,
        `ag_result_two_group(test, d, ${rstr(p.y)}, ${rstr(p.group)}, ${rvec(twoLevels(a, p).map(rstr))}, ${rstr(title)})`];
    },
  },
  ttest_paired: {
    label: 'Paired t test', category: 'Compare two groups',
    short: 'Compare two measurements on the same subjects.',
    explain: 'Compares two measurements made on the same subjects (before/after, left/right, matched pairs). It tests whether the average of the differences is zero.\n\nIn a table with one column per group, each row is one subject. In a long table, choose the column that identifies the subject.\n\nAssumes the differences are roughly normal. If not, use the Wilcoxon matched-pairs test.',
    inputs: { layout: true, y: true, group: true, two: true, subject: true },
    options: [ALTERNATIVE],
    annotations: ['brackets', 'label'],
    code(a, ctx) {
      const p = prepareGroups(a, ctx, { two: true, subject: true });
      const [x1, x2] = pairedOrder(a, p);
      return [...p.lines, wideLines(p),
        `test <- t.test(${x1}, ${x2}, paired = TRUE, alternative = ${rstr(a.options?.alternative || 'two.sided')})`,
        `ag_result_two_group(test, d, ${rstr(p.y)}, ${rstr(p.group)}, ${rvec(twoLevels(a, p).map(rstr))}, "Paired t test", paired = TRUE)`];
    },
  },
  ttest_ratio: {
    label: 'Ratio paired t test', category: 'Compare two groups',
    short: 'Paired comparison of ratios (fold changes).',
    explain: 'Like the paired t test, but for treatments that change values by a consistent factor (e.g. doubling) rather than a consistent amount. It runs a paired t test on the logarithms and reports the geometric mean ratio.\n\nAll values must be positive.',
    inputs: { layout: true, y: true, group: true, two: true, subject: true },
    options: [ALTERNATIVE],
    annotations: ['brackets', 'label'],
    code(a, ctx) {
      const p = prepareGroups(a, ctx, { two: true, subject: true });
      const [x1, x2] = pairedOrder(a, p);
      return [...p.lines, wideLines(p),
        `test <- t.test(log(${x1}), log(${x2}), paired = TRUE, alternative = ${rstr(a.options?.alternative || 'two.sided')})`,
        `ag_result_two_group(test, d, ${rstr(p.y)}, ${rstr(p.group)}, ${rvec(twoLevels(a, p).map(rstr))}, "Ratio paired t test", paired = TRUE, ratio = TRUE)`];
    },
  },
  mann_whitney: {
    label: 'Mann-Whitney test', category: 'Compare two groups',
    short: 'Nonparametric: two independent groups.',
    explain: 'The nonparametric alternative to the unpaired t test. It compares the ranks of the values instead of the means, so it does not assume a normal distribution and is robust to outliers.\n\nAlso called the Wilcoxon rank-sum test.',
    inputs: { layout: true, y: true, group: true, two: true },
    options: [ALTERNATIVE],
    annotations: ['brackets', 'label'],
    code(a, ctx) {
      const p = prepareGroups(a, ctx, { two: true });
      return [...p.lines,
        `test <- wilcox.test(${formula(p.y, rsym(p.group))}, data = d, conf.int = TRUE, alternative = ${rstr(a.options?.alternative || 'two.sided')})`,
        `ag_result_two_group(test, d, ${rstr(p.y)}, ${rstr(p.group)}, ${rvec(twoLevels(a, p).map(rstr))}, "Mann-Whitney test")`];
    },
  },
  wilcoxon_paired: {
    label: 'Wilcoxon matched-pairs test', category: 'Compare two groups',
    short: 'Nonparametric: two matched measurements.',
    explain: 'The nonparametric alternative to the paired t test. It ranks the differences between pairs instead of assuming they are normally distributed.',
    inputs: { layout: true, y: true, group: true, two: true, subject: true },
    options: [ALTERNATIVE],
    annotations: ['brackets', 'label'],
    code(a, ctx) {
      const p = prepareGroups(a, ctx, { two: true, subject: true });
      const [x1, x2] = pairedOrder(a, p);
      return [...p.lines, wideLines(p),
        `test <- wilcox.test(${x1}, ${x2}, paired = TRUE, conf.int = TRUE, alternative = ${rstr(a.options?.alternative || 'two.sided')})`,
        `ag_result_two_group(test, d, ${rstr(p.y)}, ${rstr(p.group)}, ${rvec(twoLevels(a, p).map(rstr))}, "Wilcoxon matched-pairs test", paired = TRUE)`];
    },
  },
  one_sample: {
    label: 'One-sample test', category: 'Compare two groups',
    short: 'Does one group differ from a set value?',
    explain: 'Tests whether the mean (t test) or median (Wilcoxon signed-rank) of one group differs from a hypothetical value, such as 100% or 0.',
    inputs: { layout: true, y: true, group: 'optional', oneGroup: true },
    options: [{ key: 'mu', label: 'Hypothetical value', type: 'number', def: 0 },
      { key: 'kind', label: 'Test', type: 'select', def: 't', options: [['t', 'One-sample t test'], ['wilcoxon', 'Wilcoxon signed-rank test']] }, ALTERNATIVE],
    annotations: ['label'],
    code(a, ctx) {
      const o = a.options || {};
      const mu = rnum(o.mu ?? 0);
      let lines;
      let y;
      if (a.layout === 'columns') {
        const col = (a.columns || [])[0];
        if (!col) throw new Error('Choose the column to test.');
        lines = [`d <- ${ctx.rnameOf(a.dataset)} |>\n    ${filterNA([col])}`];
        y = col;
      } else {
        if (!a.y) throw new Error('Choose the column with the values (Y).');
        const steps = [filterNA([a.y])];
        if (a.group && a.oneLevel) steps.push(`filter(${rsym(a.group)} == ${rstr(a.oneLevel)})`);
        lines = [`d <- ${ctx.rnameOf(a.dataset)} |>\n    ${steps.join(' |>\n    ')}`];
        y = a.y;
      }
      const wil = o.kind === 'wilcoxon';
      const title = wil ? 'Wilcoxon signed-rank test' : 'One-sample t test';
      return [...lines,
        `test <- ${wil ? 'wilcox.test' : 't.test'}(d$${rsym(y)}, mu = ${mu}${wil ? ', conf.int = TRUE' : ''}, alternative = ${rstr(o.alternative || 'two.sided')})`,
        `ag_result_one_sample(test, d, ${rstr(y)}, ${mu}, ${rstr(title)})`];
    },
  },

  anova1: {
    label: 'One-way ANOVA', category: 'Compare three or more groups',
    short: 'Compare three or more independent groups.',
    explain: 'Tests whether the means of three or more independent groups all are equal. A small p value says at least one group differs; the multiple comparisons then tell you which.\n\nTukey compares every pair; Dunnett compares each group with one control group (fewer comparisons, more power). Assumes roughly normal values and similar SDs in every group; if SDs differ a lot, use Welch\'s ANOVA, and if values are not normal, use Kruskal-Wallis.',
    inputs: { layout: true, y: true, group: true },
    packages: ['emmeans'],
    options: [COMPARE, CONTROL, CORRECTION],
    annotations: ['brackets', 'label'],
    code(a, ctx) {
      const p = prepareGroups(a, ctx);
      const o = a.options || { compare: 'pairs' };
      const e = emmLines('fit', `~ ${rsym(p.group)}`, o, '', p.group);
      return [...p.lines,
        `fit <- aov(${formula(p.y, rsym(p.group))}, data = d)`,
        ...e.lines,
        `ag_result_anova(fit, ${e.mc}, d, ${rstr(p.y)}, ${rstr(p.group)}, "One-way ANOVA"${e.name ? `, ${rstr(e.name)}` : ''})`];
    },
  },
  welch_anova: {
    label: "Welch's ANOVA", category: 'Compare three or more groups',
    short: 'One-way ANOVA without assuming equal SDs.',
    explain: "A one-way ANOVA that does not assume equal SDs in the groups. The Games-Howell test then compares every pair of groups, also without assuming equal SDs.",
    inputs: { layout: true, y: true, group: true },
    options: [{ key: 'posthoc', label: 'Multiple comparisons', type: 'select', def: 'gh', options: [['gh', 'Games-Howell (every pair)'], ['none', 'None']] }],
    annotations: ['brackets', 'label'],
    code(a, ctx) {
      const p = prepareGroups(a, ctx);
      const gh = (a.options?.posthoc || 'gh') === 'gh';
      return [...p.lines,
        `test <- oneway.test(${formula(p.y, rsym(p.group))}, data = d, var.equal = FALSE)`,
        gh ? `cmp <- ag_games_howell(d$${rsym(p.y)}, d$${rsym(p.group)})` : 'cmp <- NULL',
        `ag_result_htest_groups(test, cmp, d, ${rstr(p.y)}, ${rstr(p.group)}, "Welch's ANOVA", "Games-Howell multiple comparisons")`];
    },
  },
  kruskal: {
    label: 'Kruskal-Wallis test', category: 'Compare three or more groups',
    short: 'Nonparametric: three or more independent groups.',
    explain: "The nonparametric alternative to one-way ANOVA. It compares the ranks of the values across groups, so it does not assume normality. Dunn's test then compares groups using the same ranks.",
    inputs: { layout: true, y: true, group: true },
    options: [{ ...COMPARE, options: COMPARE.options }, CONTROL,
      { key: 'padjust', label: 'Correction for multiple comparisons', type: 'select', def: 'bonferroni', options: P_ADJUST, showIf: (o) => o.compare !== 'none' }],
    annotations: ['brackets', 'label'],
    code(a, ctx) {
      const p = prepareGroups(a, ctx);
      const o = a.options || {};
      const cmp = o.compare === 'none' ? 'cmp <- NULL'
        : `cmp <- ag_dunn(d$${rsym(p.y)}, d$${rsym(p.group)}, adjust = ${rstr(o.padjust || 'bonferroni')}${o.compare === 'control' && o.control ? `, control = ${rstr(o.control)}` : ''})`;
      return [...p.lines,
        `test <- kruskal.test(${formula(p.y, rsym(p.group))}, data = d)`,
        cmp,
        `ag_result_htest_groups(test, cmp, d, ${rstr(p.y)}, ${rstr(p.group)}, "Kruskal-Wallis test", "Dunn's multiple comparisons", estimate_name = "Mean rank difference")`];
    },
  },
  rm_anova: {
    label: 'Repeated-measures one-way ANOVA', category: 'Compare three or more groups',
    short: 'Three or more measurements on the same subjects.',
    explain: "For three or more measurements on the same subjects (e.g. each animal measured at several time points). It is fitted as a mixed-effects model with a random intercept per subject, which handles missing values, then the treatments are compared.\n\nIn a table with one column per condition, each row is one subject.",
    inputs: { layout: true, y: true, group: true, subject: true },
    mixed: true,
    options: [COMPARE, CONTROL, CORRECTION],
    annotations: ['brackets', 'label'],
    code(a, ctx) {
      let p = prepareGroups(a, ctx, { subject: true });
      const o = a.options || { compare: 'pairs' };
      const nlme = ctx.mixedEngine === 'nlme';
      if (nlme) {
        const pn = plainNames([p.y, p.group, p.subject]);
        if (pn.line) p = { ...p, lines: [...p.lines, pn.line], y: pn.to(p.y), group: pn.to(p.group), subject: pn.to(p.subject) };
      }
      const e = emmLines('fit', `~ ${rsym(p.group)}`, o, nlme ? '' : ', lmer.df = "satterthwaite"', p.group);
      return [...p.lines,
        nlme ? `fit <- nlme::lme(${formula(p.y, rsym(p.group))}, random = ~ 1 | ${rsym(p.subject)}, data = d)`
          : `fit <- lmerTest::lmer(${formula(p.y, `${rsym(p.group)} + (1 | ${rsym(p.subject)})`)}, data = d)`,
        ...e.lines,
        `ag_result_mixed(fit, ${e.mc}, d, ${rstr(p.y)}, ${rstr(p.group)}, "Repeated-measures ANOVA (mixed-effects model)"${e.name ? `, ${rstr(e.name)}` : ''})`];
    },
  },
  friedman: {
    label: 'Friedman test', category: 'Compare three or more groups',
    short: 'Nonparametric: repeated measures, complete data.',
    explain: 'The nonparametric alternative to repeated-measures ANOVA. Every subject must have a value for every condition. Pairs of conditions are then compared with Wilcoxon matched-pairs tests.',
    inputs: { layout: true, y: true, group: true, subject: true },
    options: [{ key: 'padjust', label: 'Correction for multiple comparisons', type: 'select', def: 'holm', options: P_ADJUST }],
    annotations: ['brackets', 'label'],
    code(a, ctx) {
      const p = prepareGroups(a, ctx, { subject: true });
      return [...p.lines,
        `test <- friedman.test(${formula(p.y, `${rsym(p.group)} | ${rsym(p.subject)}`)}, data = d)`,
        `cmp <- ag_pairwise_wilcox_paired(d, ${rstr(p.y)}, ${rstr(p.group)}, ${rstr(p.subject)}, adjust = ${rstr(a.options?.padjust || 'holm')})`,
        `ag_result_htest_groups(test, cmp, d, ${rstr(p.y)}, ${rstr(p.group)}, "Friedman test", "Wilcoxon matched-pairs comparisons", estimate_name = "Difference")`];
    },
  },

  anova2: {
    label: 'Two-way ANOVA', category: 'Two or more factors',
    short: 'Two factors, e.g. genotype × treatment.',
    explain: 'For data grouped by two factors, e.g. genotype × treatment. It tests the effect of each factor and their interaction (whether the effect of one factor depends on the other).\n\nType III sums of squares (the default) are appropriate when group sizes differ. Your data must be in a long table: one column for values and one for each factor.\n\nFor repeated measures, use the mixed-effects model.',
    inputs: { layout: false, y: true, group: true, factorB: true },
    packages: ['emmeans'],
    options: [
      { key: 'interaction', label: 'Include the interaction', type: 'bool', def: true },
      { key: 'sstype', label: 'Sums of squares', type: 'select', def: 'III', options: [['III', 'Type III'], ['I', 'Type I (sequential)']] },
      { key: 'scope', label: 'Multiple comparisons', type: 'select', def: 'A_within_B',
        options: [['A_within_B', 'Factor A within each level of B'], ['B_within_A', 'Factor B within each level of A'], ['A', 'Factor A (main effect)'], ['B', 'Factor B (main effect)'], ['cells', 'Every cell with every other cell'], ['none', 'None']] },
      { ...COMPARE, options: COMPARE.options.filter((x) => x[0] !== 'none'), showIf: (o) => o.scope !== 'none' },
      { ...CONTROL, type: 'levelA' },
      { ...CORRECTION, def: 'sidak', showIf: (o) => o.scope !== 'none' },
    ],
    annotations: ['brackets', 'label'],
    code(a, ctx) {
      if (!a.y || !a.group || !a.factorB) throw new Error('Choose the values column and both factors.');
      if (a.group === a.factorB) throw new Error('Factor A and factor B must be different columns.');
      const o = { interaction: true, sstype: 'III', scope: 'A_within_B', compare: 'pairs', correction: 'sidak', ...(a.options || {}) };
      const A = rsym(a.group); const B = rsym(a.factorB);
      const lines = [`d <- ${ctx.rnameOf(a.dataset)} |>\n    ${filterNA([a.y, a.group, a.factorB])} |>\n    mutate(${A} = ag_factor(${A}), ${B} = ag_factor(${B}))`];
      const rhs = o.interaction ? `${A} * ${B}` : `${A} + ${B}`;
      const contr = o.sstype === 'III' ? `, contrasts = list(${A} = contr.sum, ${B} = contr.sum)` : '';
      lines.push(`fit <- lm(${formula(a.y, rhs)}, data = d${contr})`);
      const specs = { A_within_B: `~ ${A} | ${B}`, B_within_A: `~ ${B} | ${A}`, A: `~ ${A}`, B: `~ ${B}`, cells: `~ ${A} * ${B}` };
      const compared = { A_within_B: a.group, A: a.group, B_within_A: a.factorB, B: a.factorB }[o.scope];
      const e = o.scope === 'none' ? { lines: [], mc: 'NULL', name: null } : emmLines('fit', specs[o.scope], o.scope === 'cells' ? { ...o, compare: 'pairs' } : o, '', compared);
      lines.push(...e.lines);
      lines.push(`ag_result_anova2(fit, ${e.mc}, d, ${rstr(a.y)}, ${rvec([a.group, a.factorB].map(rstr))}, type = ${rstr(o.sstype)}${e.name ? `, posthoc = ${rstr(e.name)}` : ''})`);
      return lines;
    },
  },
  mixed: {
    label: 'Mixed-effects model', category: 'Two or more factors',
    short: 'Repeated or clustered data (subjects, litters, batches).',
    explain: 'Use a mixed-effects model when some measurements are not independent: the same animal measured repeatedly, several cells from the same culture, mice from the same litter.\n\nFixed effects are what you want to test (treatment, time, genotype). Random effects are the "clusters" whose individual differences you are not interested in but must account for (subject, litter, batch). The model lets each cluster have its own baseline (a random intercept); optionally the effect of a fixed factor can also vary between clusters (a random slope).\n\nIt is the modern replacement for repeated-measures ANOVA: it copes with missing values and unequal group sizes. Models are fitted with lme4, with p values from the Satterthwaite approximation (lmerTest), and multiple comparisons use emmeans. (If lme4 cannot be loaded in the browser, nlme is used instead.)\n\nData must be in a long table: one row per measurement, with a column identifying the cluster.',
    inputs: { layout: false, y: true, fixed: true, random: true },
    mixed: true,
    options: [
      { key: 'interaction', label: 'Include interactions between fixed effects', type: 'bool', def: true },
      { key: 'slope', label: 'Random slope for (optional)', type: 'fixedVar', def: '' },
      { key: 'by', label: 'Compare within each level of', type: 'fixedVar', def: '' },
      COMPARE, { ...CONTROL, type: 'levelFixed' }, CORRECTION,
    ],
    annotations: ['brackets', 'label'],
    code(a, ctx) {
      const fixed = (a.fixed || []).filter(Boolean);
      const random = (a.random || []).filter(Boolean);
      if (!a.y) throw new Error('Choose the column with the values (Y).');
      if (!fixed.length) throw new Error('Choose at least one fixed effect.');
      if (!random.length) throw new Error('Choose at least one random effect (e.g. subject).');
      const o = { interaction: true, compare: 'pairs', correction: 'tukey', ...(a.options || {}) };
      const all = [...new Set([a.y, ...fixed, ...random])];
      const factors = [...new Set([...fixed, ...random])];
      const lines = [`d <- ${ctx.rnameOf(a.dataset)} |>\n    ${filterNA(all)} |>\n    mutate(${factors.map((f) => `${rsym(f)} = ag_factor(${rsym(f)})`).join(', ')})`];
      const nlme = ctx.mixedEngine === 'nlme';
      let y = a.y;
      if (nlme) {
        const pn = plainNames(all);
        if (pn.line) lines.push(pn.line);
        y = pn.to(y);
        fixed.splice(0, fixed.length, ...fixed.map(pn.to));
        random.splice(0, random.length, ...random.map(pn.to));
        o.slope = pn.to(o.slope);
        o.by = pn.to(o.by);
      }
      const fx = fixed.map(rsym).join(o.interaction ? ' * ' : ' + ');
      if (nlme) {
        // nlme nests several random effects in the order given (e.g. litter / mouse).
        lines.push(`fit <- nlme::lme(${formula(y, fx)}, random = ~ ${o.slope ? `1 + ${rsym(o.slope)}` : '1'} | ${random.map(rsym).join(' / ')}, data = d)`);
      } else {
        const re = random.map((r, i) => `(${i === 0 && o.slope ? `1 + ${rsym(o.slope)}` : '1'} | ${rsym(r)})`).join(' + ');
        lines.push(`fit <- lmerTest::lmer(${formula(a.y, `${fx} + ${re}`)}, data = d)`);
      }
      const target = fixed[0];
      const by = o.by && o.by !== target && fixed.includes(o.by) ? ` | ${rsym(o.by)}` : '';
      const e = emmLines('fit', `~ ${rsym(target)}${by}`, o, nlme ? '' : ', lmer.df = "satterthwaite"', target);
      lines.push(...e.lines);
      lines.push(`ag_result_mixed(fit, ${e.mc}, d, ${rstr(y)}, ${rstr(target)}${e.name ? `, posthoc = ${rstr(e.name)}` : ''})`);
      return lines;
    },
  },

  correlation: {
    label: 'Correlation', category: 'Relationships',
    short: 'How strongly two measurements move together.',
    explain: "How strongly two measurements go up (or down) together.\n\nPearson's r measures a straight-line relationship and assumes both variables are roughly normal. Spearman's rho uses ranks: it captures any steadily increasing or decreasing relationship and resists outliers. Kendall's tau is also rank-based and behaves better with small samples and many ties.",
    inputs: { layout: false, x: true, y: true },
    options: [{ key: 'method', label: 'Method', type: 'select', def: 'pearson', options: [['pearson', "Pearson's r"], ['spearman', "Spearman's rho"], ['kendall', "Kendall's tau"]] },
      { ...ALTERNATIVE, options: [['two.sided', 'Two-tailed'], ['greater', 'One-tailed: positive'], ['less', 'One-tailed: negative']] }],
    annotations: ['label'],
    code(a, ctx) {
      if (!a.x || !a.y) throw new Error('Choose the X and Y columns.');
      const o = a.options || {};
      const m = o.method || 'pearson';
      return [`d <- ${ctx.rnameOf(a.dataset)} |>\n    ${filterNA([a.x, a.y])}`,
        `test <- cor.test(d$${rsym(a.x)}, d$${rsym(a.y)}, method = ${rstr(m)}${m !== 'pearson' ? ', exact = FALSE' : ''}, alternative = ${rstr(o.alternative || 'two.sided')})`,
        `ag_result_cor(test, d, ${rstr(a.x)}, ${rstr(a.y)}, ${rstr(m)})`];
    },
  },
  cormatrix: {
    label: 'Correlation matrix', category: 'Relationships',
    short: 'Every number column against every other.',
    explain: "Correlates each chosen column with every other one: a table of r values, their P values and the number of rows each pair uses, plus a list of every pair with its 95% confidence interval (Pearson).\n\nPearson's r measures straight-line relationships; Spearman's rho and Kendall's tau use ranks, so they capture any steadily rising or falling relationship and resist outliers.\n\nWith many columns there are many pairs, and some will look significant by chance: adjusting the P values for the number of pairs (Holm, or the false discovery rate) guards against that.\n\nFor a picture, make a heatmap: each cell coloured by r, from blue (-1) through white (0) to red (+1).",
    inputs: { layout: false, numbers: true },
    options: [{ key: 'method', label: 'Method', type: 'select', def: 'pearson', options: [['pearson', "Pearson's r"], ['spearman', "Spearman's rho"], ['kendall', "Kendall's tau"]] },
      { key: 'adjust', label: 'Adjust P values for the number of pairs', type: 'select', def: 'none', options: [['none', 'No adjustment'], ...P_ADJUST.filter(([v]) => v !== 'none')] }],
    annotations: [],
    code(a, ctx) {
      const o = a.options || {};
      const cols = (a.columns || []).filter(Boolean);
      if (cols.length === 1) throw new Error('Choose at least two columns (or none, for every number column).');
      const args = [ctx.rnameOf(a.dataset), cols.length ? rvec(cols.map(rstr), '  ') : 'NULL'];
      if ((o.method || 'pearson') !== 'pearson') args.push(`method = ${rstr(o.method)}`);
      if (o.adjust && o.adjust !== 'none') args.push(`adjust = ${rstr(o.adjust)}`);
      return [`ag_result_cormatrix(${args.join(', ')})`];
    },
  },
  regression: {
    label: 'Regression / curve fit', category: 'Relationships',
    short: 'Fit a line or curve (incl. dose-response, EC50).',
    explain: 'Fits a line or curve to Y as a function of X and reports the best-fit values.\n\n• Straight line: Y = intercept + slope × X.\n• Polynomial: gentle curves.\n• Logarithmic, exponential and power: common growth or decay shapes.\n• Dose-response (4PL): a sigmoid from bottom to top with an EC50 and Hill slope; X is the concentration (or its log).\n• Michaelis-Menten: enzyme kinetics, gives Vmax and Km.\n• One-phase decay / association: approaches a plateau with rate K and half-life.\n\nAdd it to a graph to draw the fitted curve.',
    inputs: { layout: false, x: true, y: true },
    options: [
      { key: 'model', label: 'Model', type: 'select', def: 'linear', options: [
        ['linear', 'Straight line'], ['origin', 'Straight line through the origin'], ['poly2', 'Quadratic (2nd-order polynomial)'],
        ['poly3', 'Cubic (3rd-order polynomial)'], ['log', 'Logarithmic: Y = a + b ln(X)'], ['exp', 'Exponential: Y = a e^(bX)'],
        ['power', 'Power: Y = a X^b'], ['4pl', 'Dose-response, 4 parameters (sigmoid)'], ['mm', 'Michaelis-Menten'],
        ['decay', 'One-phase decay / association (plateau)']] },
      { key: 'logx', label: 'X values are already log10(concentration)', type: 'bool', def: false, showIf: (o) => o.model === '4pl' },
    ],
    annotations: ['curve', 'label'],
    code(a, ctx) {
      if (!a.x || !a.y) throw new Error('Choose the X and Y columns.');
      const o = a.options || {};
      const m = o.model || 'linear';
      const X = rsym(a.x); const Y = rsym(a.y);
      const needPos = ['log', 'power'].includes(m) || (m === '4pl' && !o.logx);
      const lines = [`d <- ${ctx.rnameOf(a.dataset)} |>\n    ${filterNA([a.x, a.y])}${needPos ? ` |>\n    filter(${X} > 0)` : ''}${m === 'power' ? ` |>\n    filter(${Y} > 0)` : ''}`];
      const lm = (rhs, model) => [`fit <- lm(${Y} ~ ${rhs}, data = d)`, `ag_result_lm(fit, d, ${rstr(a.x)}, ${rstr(a.y)}, model = ${rstr(model)})`];
      const nls = (fit, model) => [fit, `ag_result_nls(fit, d, ${rstr(a.x)}, ${rstr(a.y)}, model = ${rstr(model)})`];
      switch (m) {
        case 'linear': return [...lines, ...lm(X, 'linear')];
        case 'origin': return [...lines, ...lm(`0 + ${X}`, 'origin')];
        case 'poly2': return [...lines, ...lm(`poly(${X}, 2, raw = TRUE)`, 'poly2')];
        case 'poly3': return [...lines, ...lm(`poly(${X}, 3, raw = TRUE)`, 'poly3')];
        case 'log': return [...lines, ...lm(`log(${X})`, 'log')];
        case 'exp': return [...lines,
          `start <- coef(lm(log(${Y}) ~ ${X}, data = d[d$${Y} > 0, ]))`,
          ...nls(`fit <- nls(${Y} ~ a * exp(b * ${X}), data = d, start = list(a = exp(start[[1]]), b = start[[2]]))`, 'exp')];
        case 'power': return [...lines,
          `start <- coef(lm(log(${Y}) ~ log(${X}), data = d))`,
          ...nls(`fit <- nls(${Y} ~ a * ${X}^b, data = d, start = list(a = exp(start[[1]]), b = start[[2]]))`, 'power')];
        case '4pl': return [...lines,
          ...nls(`fit <- nls(${Y} ~ SSfpl(${o.logx ? X : `log10(${X})`}, bottom, top, logEC50, scal), data = d)`, '4pl')];
        case 'mm': return [...lines, ...nls(`fit <- nls(${Y} ~ SSmicmen(${X}, Vmax, Km), data = d)`, 'mm')];
        case 'decay': return [...lines, ...nls(`fit <- nls(${Y} ~ SSasymp(${X}, plateau, y0, log_k), data = d)`, 'decay')];
        default: throw new Error(`Unknown model ${m}`);
      }
    },
  },
};

export const TEST_CATEGORIES = ['Describe', 'Compare two groups', 'Compare three or more groups', 'Two or more factors', 'Relationships'];

export function testDefaults(key) {
  const out = {};
  for (const o of TESTS[key].options) if (o.def !== undefined) out[o.key] = o.def;
  return out;
}

export function analysisCode(a, ctx) {
  const t = TESTS[a.test];
  if (!t) throw new Error(`Unknown test ${a.test}`);
  if (!a.dataset) throw new Error('Choose a dataset.');
  const body = t.code(a, ctx);
  return `${a.rname} <- local({\n${body.map((l) => '  ' + l.replace(/\n/g, '\n  ')).join('\n')}\n})`;
}

// Mixed models use lme4 + lmerTest, or nlme where lme4 is not available.
export function analysisPackages(a, { mixedEngine = 'lme4' } = {}) {
  const t = TESTS[a.test];
  if (t?.mixed) return mixedEngine === 'nlme' ? ['emmeans', 'nlme'] : ['emmeans', 'lme4', 'lmerTest'];
  return t?.packages || [];
}

export function usesMixedModel(a) {
  return !!TESTS[a.test]?.mixed;
}
