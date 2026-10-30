// End-to-end test of the UI with Playwright, against the native-R bridge.
//   R_SCRIPT=/path/to/Rscript node tests/e2e.test.mjs
// (starts dev/r-bridge.mjs itself; needs R with ggplot2, dplyr, tidyr, jsonlite, emmeans)
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { startMock } from './mock-llm.mjs';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch {
  ({ chromium } = createRequire(join(execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim(), 'x'))('playwright'));
}

const PORT = 8799;
const TOKEN = 'e2e-token';
const root = new URL('..', import.meta.url).pathname;
const tmp = mkdtempSync(join(tmpdir(), 'ag-e2e-'));
const mock = startMock(8798); // an OpenAI-compatible server for the assistant
const server = spawn('node', ['dev/r-bridge.mjs'], { cwd: root, env: { ...process.env, PORT: String(PORT), AGRAFEUSE_TOKEN: TOKEN }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((res) => server.stdout.on('data', (d) => { if (String(d).includes('http')) res(); }));

let failures = 0;
const check = (cond, label) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}`);
  if (!cond) failures++;
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, acceptDownloads: true });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
// (The mock model server turns down structured output with a 400 on purpose; the browser logs that.)
page.on('console', (m) => { if (m.type() === 'error' && !/status of 400/.test(m.text())) errors.push(m.text()); });
const ready = () => page.waitForFunction(() => document.querySelector('.rstatus')?.classList.contains('ready'), null, { timeout: 120000 });
const settle = async () => { await page.waitForTimeout(500); await ready(); await page.waitForTimeout(300); };
const nav = (name) => page.click(`.nav-item:has-text("${name}")`);

try {
  await page.goto(`http://127.0.0.1:${PORT}/?engine=bridge&token=${TOKEN}`);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await ready();
  check(await page.locator('.nav li[data-id]').count() === 4, 'example project loads (one dataset, transform, analysis, graph)');

  // --- type and paste data into a new column table -----------------------------------
  await page.click('[data-k="new-data"]');
  await page.click('button.choice:has-text("Column table")');
  await page.waitForSelector('.grid');
  await page.click('.sheet td[data-r="0"][data-c="0"]');
  for (const v of ['10', '12', '11', '13']) { await page.keyboard.type(v); await page.keyboard.press('Enter'); }
  await page.click('.sheet td[data-r="0"][data-c="1"]');
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData('text/plain', '15\t20\n16\t22\n14\t21\n17\t19\n');
    document.querySelector('.grid').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }));
  });
  await page.waitForTimeout(200);
  const info = await page.textContent('.data-info');
  check(info.includes('4 rows × 3 columns'), `typed + pasted data (${info.split('Control')[0].trim()})`);
  check(await page.textContent('.sheet td[data-r="3"][data-c="2"]') === '19', 'paste filled the third column');
  // Row names: type one, and paste a block that starts in the row-names column.
  await page.click('.sheet td[data-r="0"][data-c="-1"]');
  await page.keyboard.type('Mouse A');
  await page.keyboard.press('Enter');
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData('text/plain', 'Mouse B\t12\nMouse C\t11\n');
    document.querySelector('.grid').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }));
  });
  await page.waitForTimeout(200);
  const rn = await page.$$eval('.sheet td.rowname', (els) => els.slice(0, 3).map((e) => e.textContent));
  check(rn.join('|') === 'Mouse A|Mouse B|Mouse C', `row names typed and pasted (${rn.join(', ')})`);
  check(await page.textContent('.sheet td[data-r="1"][data-c="0"]') === '12', 'paste from the row-names column fills the next column too');
  const dcode = await page.evaluate(async () => {
    const { dataCode } = await import('./js/codegen/data.js');
    return dataCode(window.agrafeuse.store.item());
  });
  check(dcode.includes('row_name = factor(c("Mouse A", "Mouse B", "Mouse C"'), 'row names become a row_name column in R');

  // Rename a column: one click on its name opens it for editing, with the old name selected.
  const oldName = await page.textContent('.sheet th[data-c="1"] .colname');
  await page.click('.sheet th[data-r="-1"][data-c="1"] .colname');
  check(await page.isVisible('.cell-editor') && await page.inputValue('.cell-editor') === oldName,
    'one click on a column name opens it for renaming');
  await page.keyboard.type('Drug X');
  await page.keyboard.press('Enter');
  check((await page.textContent('.sheet th[data-c="1"] .colname')) === 'Drug X', 'renamed a column from the header');

  // Move columns: drag "Group C" by its grip to the front, then back with the button and the keyboard.
  const heads = () => page.$$eval('.sheet th.colhead:not(.ghost):not(.rowname-head) .colname', (els) => els.map((e) => e.textContent).join(','));
  const order0 = await heads();
  await page.hover('.sheet th[data-c="2"]');
  const colGrip = await page.locator('.sheet th[data-c="2"] .col-grip').boundingBox();
  const front = await page.locator('.sheet th[data-c="0"]').boundingBox();
  await page.mouse.move(colGrip.x + colGrip.width / 2, colGrip.y + colGrip.height / 2);
  await page.mouse.down();
  await page.mouse.move(front.x + 8, front.y + 10, { steps: 6 });
  await page.mouse.up();
  check(await heads() === 'Group C,Control,Drug X' && (await page.textContent('.sheet td[data-r="3"][data-c="0"]')) === '19',
    `drag a column by its grip to move it, values and all (${await heads()})`);
  await page.click('[data-k="col-right"]');
  check(await heads() === 'Control,Group C,Drug X', 'move the selected column right with the button');
  await page.focus('.grid');
  await page.keyboard.press('Control+Shift+ArrowRight');
  check(await heads() === order0, `and with Ctrl+Shift+arrow (${await heads()})`);

  // --- wide → long -------------------------------------------------------------------------
  await page.click('button:has-text("Wide → long")');
  await settle();
  const resultHead = await page.textContent('.out-head');
  check(/12 rows × 3 columns/.test(resultHead) && (await page.textContent('table.results thead')).includes('row_name'),
    `wide → long keeps the row names as an ID column (${resultHead.trim()})`);

  // --- new graph from the gallery --------------------------------------------------------
  await page.click('[data-k="new-graph"]');
  await page.click('[data-k="tpl-bar_points"]');
  await page.click('[data-k="create-graph"]');
  await settle();
  await page.waitForFunction(() => document.querySelector('img.plot')?.getAttribute('src'), null, { timeout: 30000 });
  check(await page.locator('.preview-status .message.error').count() === 0, 'bar graph renders');
  const graphName = await page.inputValue('[data-k="item-name"]');

  // Resize by dragging the graph's corner.
  const w0 = Number(await page.inputValue('[data-k="size-width"]'));
  const frame = await page.locator('.plot-frame').boundingBox();
  await page.mouse.move(frame.x + frame.width / 2, frame.y + frame.height / 2);
  const corner = await page.locator('.rh-se').boundingBox();
  await page.mouse.move(corner.x + corner.width / 2, corner.y + corner.height / 2);
  await page.mouse.down();
  await page.mouse.move(corner.x + 100, corner.y + corner.height / 2, { steps: 6 });
  await page.mouse.up();
  await settle();
  const w1 = Number(await page.inputValue('[data-k="size-width"]'));
  check(w1 > w0, `dragging the corner resizes the graph (${w0} → ${w1} in)`);

  // Formatting from the panel under the graph.
  await page.click('[data-k="y-title-underline"]');
  await page.click('[data-k="x-angle:45"]');
  await settle();
  const styled = await page.evaluate(() => window.agrafeuse.engine.result(window.agrafeuse.store.selected).code);
  check(styled.includes('quote(underline(') && styled.includes('angle = 45'), 'underlined Y title and angled X labels');
  check(await page.locator('.preview-status .message.error').count() === 0, 'formatted graph renders');

  // Stretch the Y axis by dragging it, then reset it with a double-click.
  await page.waitForFunction(() => !document.querySelector('.axis-zone-v')?.hidden, null, { timeout: 30000 });
  await page.locator('.plot-frame').scrollIntoViewIfNeeded();
  const zone = await page.locator('.axis-zone-v').boundingBox();
  await page.mouse.move(zone.x + zone.width / 2, zone.y + zone.height * 0.15);
  await page.mouse.down();
  await page.mouse.move(zone.x + zone.width / 2, zone.y + zone.height * 0.45, { steps: 8 });
  await page.mouse.up();
  await settle();
  const ys = await page.evaluate(() => window.agrafeuse.store.item().y_scale);
  const ycode = await page.evaluate(() => window.agrafeuse.engine.result(window.agrafeuse.store.selected).code);
  check(Number(ys.max) > 0 && ycode.includes('coord_cartesian(ylim = c('), `dragging the Y axis sets its range (${ys.min} to ${ys.max})`);
  await page.dblclick('.axis-zone-v');
  await settle();
  check((await page.evaluate(() => window.agrafeuse.store.item().y_scale.max)) === '', 'double-clicking the axis resets its range');

  // Add a layer and turn it into a box plot with a fixed colour.
  await page.click('[data-k="add-layer"]');
  const lastGeom = page.locator('.layer').last().locator('.card-head select');
  await lastGeom.selectOption('boxplot');
  await page.locator('.layer').last().locator('[data-k$="aes-colour-mode:const"]').click();
  await settle();
  check(await page.locator('.preview-status .message.error').count() === 0, 'added a box plot layer with a fixed colour');
  const code = await page.evaluate(() => window.agrafeuse.engine.result(window.agrafeuse.store.selected).code);
  check(code.includes('geom_boxplot(') && code.includes('colour = "#000000"'), 'graph code has the new layer');

  // --- analysis, then onto the graph ----------------------------------------------------------
  await page.click('[data-k="new-analysis"]');
  await page.click('.test-list button.choice:has-text("One-way ANOVA")');
  await settle();
  await page.waitForSelector('.summary');
  const summary = await page.textContent('.summary');
  check(/One-way ANOVA: F\(2, 9\)/.test(summary), `one-way ANOVA result (${summary.trim()})`);
  await page.click('[data-k="to-graph"]');
  await page.click(`.choice-list button:has-text("${graphName}")`);
  await settle();
  const gcode = await page.evaluate(() => window.agrafeuse.engine.result(window.agrafeuse.store.selected).code);
  check(gcode.includes('ag_brackets('), 'analysis added to the graph as brackets');
  check(await page.locator('.preview-status .message.error').count() === 0, 'graph with brackets renders');

  // --- every test type in the dialog runs on suitable example data ----------------------------
  await nav('One-way ANOVA');
  await settle();
  for (const test of ['welch_anova', 'kruskal', 'anova1']) {
    await page.selectOption('[data-k="test"]', test);
    await settle();
    await page.waitForSelector('.summary, .message.error');
    check(await page.locator('.output .message.error').count() === 0, `switch test to ${test}`);
  }

  // --- correlation matrix, its heatmap, and a scatterplot matrix --------------------------------
  await page.click('.nav-item:has(.name:text-is("Plant growth"))');
  await page.click('[data-k="new-analysis"]');
  await page.click('.test-list button.choice:has-text("Correlation matrix")');
  await settle();
  await page.waitForSelector('.summary');
  check(/Pearson's r between 3 columns \(3 pairs\)/.test(await page.textContent('.summary')) && await page.locator('.result-table h4:has-text("P values")').count() === 1,
    'correlation matrix of every number column');
  await page.click('[data-k="to-heatmap"]');
  await settle();
  await page.waitForFunction(() => document.querySelector('img.plot')?.getAttribute('src'), null, { timeout: 30000 });
  const heatCode = () => page.evaluate(() => window.agrafeuse.engine.result(window.agrafeuse.store.selected)?.code || '');
  check((await heatCode()).includes('ag_cor_heatmap(plant_growth, columns = c("Control", "Treatment 1", "Treatment 2"))') && (await heatCode()).includes('scale_fill_viridis_c(limits = c(-1, 1), oob = scales::squish)'),
    `heatmap from the analysis: viridis, from -1 to 1 (${(await heatCode()).split('\n').slice(0, 4).join(' / ')})`);
  await page.selectOption('[data-k="l0-p-label"]', 'r_p');
  await page.click('[data-k="fmt-tab-legend"]');
  await page.selectOption('[data-k="pal-option"]', 'magma');
  await settle();
  check((await heatCode()).includes('label = "r_p"') && (await heatCode()).includes('option = "magma"') && await page.locator('.preview-status .message.error').count() === 0,
    'heatmap text with "p =" and another colour scheme');
  await page.click('[data-k="new-graph"]');
  await page.click('[data-k="tpl-scatter_matrix"]');
  await page.click('[data-k="create-graph"]');
  await settle();
  await page.uncheck('[data-k="l0-p-intercept"]');
  await page.selectOption('[data-k="l0-p-line_type"]', 'dashed');
  await settle();
  const smCode = await heatCode();
  check(smCode.includes('ag_scatter_matrix(plant_growth, intercept = FALSE, line_type = "dashed")') && await page.locator('.preview-status .message.error').count() === 0,
    'scatterplot matrix with a dashed line through the origin');

  // --- dplyr pipeline stapled to a data table ------------------------------------------------------
  await page.click('.nav-item:has(.name:text-is("Plant growth"))');
  await page.click('.pipe-strip');
  check(await page.isVisible('.pipe [data-k="pipe-add"]'), 'pipeline panel opens from the strip on the right');
  const addStep = async (verb) => { await page.click('[data-k="pipe-add"]'); await page.click(`.verb-menu [data-verb="${verb}"]`); await settle(); };
  const verbs = () => page.$$eval('.pipe-verb', (els) => els.map((e) => e.textContent).join(' '));
  await addStep('pivot_longer');
  await addStep('filter');
  await page.selectOption('[data-k="s1-col"]', 'value');
  await page.selectOption('[data-k="s1-op"]', '>');
  await page.fill('[data-k="s1-val"]', '4.5');
  await settle();
  await addStep('summarise');
  await page.selectOption('[data-k="s2-col"]', 'value');
  await page.check('[data-k="s2-group_by:group"]');
  await settle();
  check(await verbs() === 'pivot_longer filter summarise', 'three steps added from the + menu');
  check((await page.textContent('.pipe-step[data-step="1"] .pipe-dims')) === '23 × 2', 'each step shows rows × columns after it');
  check(await page.isVisible('.pipe-result') && /3 rows × 5 columns/.test(await page.textContent('.pipe-result .out-head')), 'pipeline result shows in the main pane');
  check(!(await page.isVisible('.grid-host')), 'grid is hidden while the result shows');
  await page.click('[data-k="tab-data"]');
  check(await page.isVisible('.grid-host') && !(await page.isVisible('.pipe-result')), '"Data table" tab shows the grid again');
  // Drag summarise to the top: it cannot work there, and the problem is pinned to it.
  await page.dragAndDrop('.pipe-step[data-step="2"] .pipe-row', '.pipe-step[data-step="0"] .pipe-row', { targetPosition: { x: 40, y: 4 } });
  await settle();
  check(await verbs() === 'summarise pivot_longer filter', 'drag a step to reorder');
  check(await page.locator('.pipe-step.error[data-step="0"]').count() === 1 && /Step 1 \(summarise\)/.test(await page.textContent('.pipe-result')), 'a failing step is flagged');
  const navBefore = await page.locator('.nav-item').count();
  await page.click('[data-k="pipe-to-table"]');
  await page.waitForSelector('.toast.error');
  check(await page.locator('.nav-item').count() === navBefore, 'no new table while a step fails');
  check(await page.locator('.pipe-step.open[data-step="0"]').count() === 1, 'the step being edited stays open when moved');
  await page.click('[data-k="s0-down"]');
  await page.click('[data-k="s1-down"]');
  await settle();
  check(await verbs() === 'pivot_longer filter summarise', 'move buttons reorder too');
  await page.click('.pipe-step[data-step="1"] .pipe-row');
  await page.click('[data-k="s1-onoff"]');
  await settle();
  const ns = await page.$$eval('.pipe-result table.results tbody tr', (trs) => trs.map((tr) => tr.lastChild.textContent));
  check(ns.join(',') === '10,10,10', `a step can be turned off (n = ${ns.join(', ')})`);
  await page.click('[data-k="s1-onoff"]');
  await settle();
  await page.click('[data-k="pipe-to-table"]');
  await settle();
  check(await page.inputValue('.title-input') === 'Plant growth (result)' && (await page.textContent('.data-info')).includes('3 rows × 5 columns'),
    'pipeline result became a new data table');
  await page.click('.nav-item:has(.name:text-is("Plant growth"))');
  await page.waitForSelector('.pipe-step');
  check(await verbs() === 'pivot_longer filter summarise', 'the pipeline stays with its table');
  await page.click('[data-k="pipe-to-transform"]');
  await settle();
  check(await page.inputValue('.title-input') === 'Plant growth (pipeline)' && /3 rows × 5 columns/.test(await page.textContent('.out-head')),
    'pipeline became a linked transform');

  // group_by: the steps after it work per group (shown nested under it).
  await page.click('.nav-item:has(.name:text-is("Plant growth"))');
  await page.waitForSelector('.pipe-step');
  await addStep('group_by');
  await page.check('[data-k="s3-columns:group"]');
  await page.click('[data-k="s3-up"]');
  await page.click('[data-k="s2-up"]');
  await settle();
  check(await verbs() === 'pivot_longer group_by filter summarise' && await page.locator('.pipe-step.in-group').count() === 2,
    'group_by: later steps are nested under it');
  const pcode = await page.textContent('.pipe-result pre.code');
  check(pcode.includes('group_by(group)') && pcode.includes('.groups = "drop"') && /3 rows × 5 columns/.test(await page.textContent('.pipe-result .out-head')),
    'grouped summarise gives one row per group');

  // --- plot-wide data and aesthetics ------------------------------------------------------------
  await nav(graphName);
  await settle();
  const plotCode = () => page.evaluate(() => window.agrafeuse.engine.result(window.agrafeuse.store.selected)?.code || '');
  check(/ggplot\(\w+, aes\(x = group, y = value\)\)/.test(await plotCode()), 'graph data and X / Y are plot-wide');
  await page.selectOption('[data-k="base-colour"]', 'group');
  await page.selectOption('[data-k="base-group"]', 'row_name');
  await settle();
  check(/ggplot\(\w+, aes\(x = group, y = value, colour = group, group = row_name\)\)/.test(await plotCode()), 'plot-wide colour and group go into ggplot()');
  await page.click('[data-k="l0-aes-colour-mode:none"]');
  await page.selectOption('[data-k="l0-aes-group-col"]', '__none');
  await settle();
  check(/stat_summary\(aes\(colour = NULL, group = NULL\)/.test(await plotCode()), 'a layer can switch plot-wide mappings off');
  await page.waitForFunction(() => !document.querySelector('.preview-pane .stage.busy'), null, { timeout: 30000 }).catch(() => {});
  check(await page.locator('.preview-status .message.error').count() === 0, 'graph with plot-wide mappings renders');

  // --- compare groups right on the graph (no analysis needed) --------------------------------------
  await page.click('[data-k="add-compare"]');
  await settle();
  check(/ag_stat_compare\(\w+, x = "group", y = "value"\)/.test(await plotCode()), 'compare groups adds ag_stat_compare()');
  await page.selectOption('[data-k="ann1-method"]', 'wilcox.test');
  await page.selectOption('[data-k="ann1-cmp"]', 'control');
  await page.selectOption('[data-k="ann1-fmt"]', 'p');
  await settle();
  check((await plotCode()).includes('method = "wilcox.test", comparisons = "control", format = "p"'), 'compare groups: test, control and p values');
  check(await page.locator('.preview-status .message.error').count() === 0, 'graph with compared groups renders');

  // --- text boxes, dragged into place ----------------------------------------------------------
  await page.click('[data-k="add-note"]');
  await page.fill('[data-k="note0-text"]', 'n = 4 per group');
  await page.click('[data-k="note0-bold"]');
  await settle();
  check((await plotCode()).includes('ag_text_box("n = 4 per group", x = 0.5, y = 0.9, face = "bold")'), 'text box added');
  await page.locator('.plot-frame').scrollIntoViewIfNeeded();
  await page.hover('.plot-frame');
  const grip = await page.locator('.note-grip').boundingBox();
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(grip.x - 80, grip.y + 60, { steps: 5 });
  await page.mouse.up();
  await settle();
  const moved = /ag_text_box\("n = 4 per group", x = ([\d.]+), y = ([\d.]+)/.exec(await plotCode());
  check(moved && Number(moved[1]) < 0.5 && Number(moved[2]) < 0.9, `text box dragged on the graph (x = ${moved?.[1]}, y = ${moved?.[2]})`);
  check(await page.locator('.preview-status .message.error').count() === 0, 'graph with a text box renders');

  // --- the versions R and the packages run with are in the footer ---------------------------------
  const versions = await page.textContent('.site-foot .versions');
  check(/R \d+\.\d+\.\d+ \(your own R, through the bridge\)/.test(versions) && /ggplot2 \d/.test(versions) && /dplyr \d/.test(versions) && /emmeans \d/.test(versions),
    `footer lists versions (${versions.slice(0, 90)}…)`);

  // --- code view ------------------------------------------------------------------------------------
  await page.click('.nav-item:has-text("Whole project as R code")');
  const script = await page.textContent('pre.code');
  check(script.includes('library(ggplot2)') && script.includes('ag_brackets('), 'whole-project script');

  // --- export -----------------------------------------------------------------------------------------
  await nav(graphName);
  await settle();
  const exportAs = async (fmt) => {
    await page.click(`[data-k="fmt:${fmt}"]`);
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('[data-k="export"]')]);
    const path = join(tmp, dl.suggestedFilename());
    await dl.saveAs(path);
    return { name: dl.suggestedFilename(), bytes: readFileSync(path) };
  };
  for (const fmt of ['pdf', 'png']) {
    const { name, bytes } = await exportAs(fmt);
    const head = bytes.subarray(0, 4).toString('latin1');
    check(fmt === 'pdf' ? head === '%PDF' : head.includes('PNG'), `export ${fmt} (${name})`);
  }
  const svgText = (await exportAs('svg')).bytes.toString('utf8');
  check(svgText.includes('<svg') && /<text[ >]/.test(svgText), 'export SVG with editable text (svglite)');
  await page.uncheck('[data-k="svg-text"]');
  const svgOutlined = (await exportAs('svg')).bytes.toString('utf8');
  check(svgOutlined.includes('<svg') && !/<text[ >]/.test(svgOutlined), 'export SVG with text as outlines');

  // --- save .RData and open it again -------------------------------------------------------------
  const before = await page.$$eval('.nav-item .name', (els) => els.map((e) => e.textContent));
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('button:has-text("Save .RData")')]);
  const saved = join(tmp, 'saved.RData');
  await dl.saveAs(saved);
  const rcheck = execFileSync(process.env.R_SCRIPT || 'Rscript', ['-e', `e <- new.env(); load("${saved}", envir = e); cat(sort(ls(e, all.names = TRUE)), sep = ",")`], { encoding: 'utf8' });
  check(rcheck.includes('.agrafeuse_project') && rcheck.includes('one_way_anova') && rcheck.includes('plant_growth'), `RData contains objects (${rcheck.split(',').length} objects)`);
  await page.click('button:has-text("New")');
  await page.click('.modal-actions button:has-text("Blank project")');
  check(await page.locator('.nav-item:not(:has-text("Whole project"))').count() === 0, 'blank project');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('button:has-text("Open")')]);
  await chooser.setFiles(saved);
  await settle();
  const after = await page.$$eval('.nav-item .name', (els) => els.map((e) => e.textContent));
  check(JSON.stringify(before) === JSON.stringify(after), 'reopened .RData restores the project');

  // --- a plain .RData from R becomes data tables ------------------------------------------------
  const plain = join(tmp, 'plain.RData');
  execFileSync(process.env.R_SCRIPT || 'Rscript', ['-e', `cells <- data.frame(cond = c("a","b"), count = c(3, 5)); m <- 1:3; save(cells, m, file = "${plain}")`]);
  const [ch2] = await Promise.all([page.waitForEvent('filechooser'), page.click('button:has-text("Open")')]);
  await ch2.setFiles(plain);
  await settle();
  check(await page.locator('.nav-item:has-text("cells")').count() === 1, 'plain .RData data frame opened as a table');

  // --- CSV import ------------------------------------------------------------------------------
  const csv = join(tmp, 'measurements.csv');
  writeFileSync(csv, 'sample,"dose, mg",response\nA,1,0.5\nB,10,"1,2"\n');
  const [ch3] = await Promise.all([page.waitForEvent('filechooser'), page.click('button:has-text("Open")')]);
  await ch3.setFiles(csv);
  await page.waitForTimeout(400);
  check(await page.textContent('.sheet th[data-c="1"] .colname') === 'dose, mg', 'CSV with quoted fields imported');

  // --- undo ----------------------------------------------------------------------------------------
  const count = await page.locator('.nav li[data-id]').count();
  await page.locator('.nav li[data-id]').first().hover();
  await page.locator('.nav li[data-id]').first().locator('.item-menu').click();
  await page.click('.popover button:has-text("Delete")');
  await page.click('.modal-actions button:has-text("Delete")');
  check(await page.locator('.nav li[data-id]').count() === count - 1, 'deleted an item');
  await page.waitForTimeout(700);
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(300);
  check(await page.locator('.nav li[data-id]').count() === count, 'undo brings it back');

  // --- the assistant ---------------------------------------------------------------------------
  await page.click('[data-k="cp-open"]');
  check(await page.isVisible('[data-k="cp-start"]') && mock.state.count === 0, 'assistant opens on its setup; nothing is downloaded until asked');
  await page.click('[data-k="cp-start"]');
  await page.waitForSelector('.toast.error');
  check(/WebGPU|graphics card/.test(await page.textContent('.toast.error')), 'in-browser model: a clear message where WebGPU is missing');
  await page.click('[data-k="cp-backend-api"]');
  await page.selectOption('[data-k="cp-preset"]', 'custom');
  await page.fill('[data-k="cp-base"]', 'http://127.0.0.1:8798/v1');
  await page.click('[data-k="cp-list"]');
  await page.waitForFunction(() => document.querySelector('[data-k="cp-api-model"]')?.value === 'mock-model');
  await page.click('[data-k="cp-connect"]');
  await page.fill('[data-k="cp-input"]', 'Which test should I use?');
  await page.press('[data-k="cp-input"]', 'Enter');
  await page.waitForSelector('.cp-bot');
  check(/one-way ANOVA/.test(await page.textContent('.cp-bot')), 'assistant answers a question (OpenAI-compatible server)');
  const sys = mock.state.last.messages[0].content;
  check(sys.includes('"Plant growth (long)"') && sys.includes('weight (number)') && sys.includes('break the request into an ordered list'), 'a question is planned with the project in view, and answered directly');
  check(sys.includes('First rows of'), 'with permission (a server on this computer), it also sees data values');
  const navBefore2 = await page.locator('.nav li[data-id]').count();
  await page.fill('[data-k="cp-input"]', 'Make a bar graph of weight and compare the groups');
  await page.press('[data-k="cp-input"]', 'Enter');
  await page.waitForSelector('.cp-plan button:has-text("Apply")');
  check(await page.locator('.cp-acts li').count() === 4 && await page.locator('.nav li[data-id]').count() === navBefore2, 'the assistant proposes steps and changes nothing yet');
  check(mock.state.last.messages[0].content.includes('"do":"new_graph"') && /Now give the actions for step 1 only/.test(mock.state.last.messages[1].content),
    'each step of the plan is asked for with the actions it can use');
  await page.click('.cp-plan button:has-text("Apply")');
  await settle();
  const made = await page.evaluate(() => window.agrafeuse.engine.result(window.agrafeuse.store.selected)?.code || '');
  check(await page.inputValue('.title-input') === 'Weight bars' && made.includes('method = "wilcox.test"') && made.includes('labs(y = "Dry weight (g)")'),
    'applied: a new graph with compared groups and a Y title');
  check(await page.locator('.cp-plan li.ok').count() === 3 && await page.locator('.cp-plan li.bad').count() === 1, 'a step the app cannot do is skipped and explained');
  await page.click('.cp-plan button:has-text("Undo")');
  await page.waitForTimeout(300);
  check(await page.locator('.nav li[data-id]').count() === navBefore2, 'one undo takes back everything the assistant did');
  // Sloppy answers are understood; a table with one column per group just works; impossible steps go back to the model.
  const askAndApply = async (q) => {
    const before = await page.locator('.cp-bot').count();
    await page.fill('[data-k="cp-input"]', q);
    await page.press('[data-k="cp-input"]', 'Enter');
    await page.waitForFunction((n) => document.querySelectorAll('.cp-bot').length > n, before);
    const plan = page.locator('.cp-bot').last();
    const wont = await plan.locator('.cp-wont').count();
    await plan.locator('button:has-text("Apply")').click();
    await settle();
    return { wont, ok: await plan.locator('li.ok').count(), bad: await plan.locator('li.bad').count() };
  };
  let r = await askAndApply('sloppy: box plot of weight by group with Mann-Whitney');
  const sloppy = await page.evaluate(() => window.agrafeuse.engine.result(window.agrafeuse.store.selected)?.code || '');
  check(r.wont === 0 && r.ok === 3 && sloppy.includes('method = "wilcox.test"') && sloppy.includes('labs(y = "Weight (g)")') && sloppy.includes('geom_boxplot'),
    `paraphrased actions are understood (${r.ok} done, ${r.bad} skipped)`);
  r = await askAndApply('wide: compare the groups of Plant growth');
  const wideCode = await page.evaluate(() => window.agrafeuse.engine.result(window.agrafeuse.store.selected)?.code || '');
  const wideAnalysis = await page.evaluate(() => window.agrafeuse.store.project.items.filter((x) => x.kind === 'analysis').pop());
  check(r.ok === 3 && wideAnalysis.layout === 'columns' && wideAnalysis.test === 'kruskal' && wideCode.includes('x = "group", y = "value"'),
    'a table with one column per group is analysed and graphed without reshaping by hand');
  const calls = mock.state.count;
  r = await askAndApply('ANOVA of mass by group');
  check(mock.state.count === calls + 3 && r.wont === 0 && r.ok === 1, 'a step that cannot work goes back to the model, which fixes it');

  // A request with several parts: thought through, broken into steps, each step done in order on a working copy.
  const calls2 = mock.state.count;
  const navBefore3 = await page.locator('.nav li[data-id]').count();
  await page.fill('[data-k="cp-input"]', 'multi: reshape Plant growth, test it, graph it with the p values and a title');
  await page.press('[data-k="cp-input"]', 'Enter');
  await page.waitForFunction(() => document.querySelector('.cp-bot:last-of-type button')?.textContent.includes('Apply')
    || [...document.querySelectorAll('.cp-bot')].pop()?.querySelector('button')?.textContent.includes('Apply'));
  const multi = page.locator('.cp-bot').last();
  check(await multi.locator('.cp-thinking').count() === 1 && await multi.locator('.cp-step').count() === 5
    && await multi.locator('.cp-step.done').count() === 4 && await multi.locator('.cp-step.empty').count() === 1,
  'a request is thought through and broken into steps');
  check(mock.state.count - calls2 === 6, `one call to plan, then one per step (${mock.state.count - calls2} calls)`);
  const step3 = mock.state.log.find((j) => /step 3 only/.test(j.messages[1]?.content || ''));
  check(step3 && step3.messages[0].content.includes('"Plants long"') && step3.messages[0].content.includes('mass (number)')
    && step3.messages[0].content.includes('treatment (groups: Control, Treatment 1, Treatment 2)') && /Step 1: Make a new dataset "Plants long"/.test(step3.messages[1].content),
  'later steps see what earlier steps made, with its columns');
  check(await multi.locator('.cp-wont').count() === 0 && await page.locator('.nav li[data-id]').count() === navBefore3, 'the whole plan checks out, and nothing is changed yet');
  await multi.locator('button:has-text("Apply")').click();
  await settle();
  const multiCode = await page.evaluate(() => window.agrafeuse.engine.result(window.agrafeuse.store.selected)?.code || '');
  check(await page.inputValue('.title-input') === 'Mass box plot' && multiCode.includes('ag_brackets(mass_test, plants_long, x = "treatment", y = "mass")')
    && multiCode.includes('labs(title = "Plant mass")') && await page.locator('.nav li[data-id]').count() === navBefore3 + 3,
  'applied in order: a new dataset, a test on it, a graph with its p values and a title');
  await multi.locator('button:has-text("Undo")').click();
  await page.waitForTimeout(300);
  check(await page.locator('.nav li[data-id]').count() === navBefore3, 'one undo takes back the whole plan');
  await page.uncheck('[data-k="cp-share"]');
  await page.fill('[data-k="cp-input"]', 'Which test should I use?');
  await page.press('[data-k="cp-input"]', 'Enter');
  await page.waitForFunction((n) => document.querySelectorAll('.cp-bot').length >= n, 3);
  check(!mock.state.last.messages[0].content.includes('First rows of'), 'without permission, no data values are sent');

  check(errors.length === 0, `no errors in the browser console${errors.length ? ': ' + errors.join(' | ') : ''}`);
} catch (e) {
  console.error(e);
  failures++;
  await page.screenshot({ path: join(tmp, 'failure.png') });
  console.error('screenshot:', join(tmp, 'failure.png'));
} finally {
  await browser.close();
  server.kill();
  mock.close();
}
console.log(failures ? `\n${failures} failure(s)` : '\nall passed');
process.exit(failures ? 1 : 0);
