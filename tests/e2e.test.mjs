// End-to-end test of the UI with Playwright, against the native-R bridge.
//   R_SCRIPT=/path/to/Rscript node tests/e2e.test.mjs
// (starts dev/r-bridge.mjs itself; needs R with ggplot2, dplyr, tidyr, jsonlite, emmeans)
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch {
  ({ chromium } = createRequire(join(execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim(), 'x'))('playwright'));
}

const PORT = 8799;
const TOKEN = 'e2e-token';
const root = new URL('..', import.meta.url).pathname;
const tmp = mkdtempSync(join(tmpdir(), 'pb-e2e-'));
const server = spawn('node', ['dev/r-bridge.mjs'], { cwd: root, env: { ...process.env, PORT: String(PORT), PLOTBENCH_TOKEN: TOKEN }, stdio: ['ignore', 'pipe', 'inherit'] });
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
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
const ready = () => page.waitForFunction(() => document.querySelector('.rstatus')?.classList.contains('ready'), null, { timeout: 120000 });
const settle = async () => { await page.waitForTimeout(500); await ready(); await page.waitForTimeout(300); };
const nav = (name) => page.click(`.nav-item:has-text("${name}")`);

try {
  await page.goto(`http://127.0.0.1:${PORT}/?engine=bridge&token=${TOKEN}`);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await ready();
  check(await page.locator('.nav-item').count() >= 10, 'example project loads');

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
  // Rename a column by typing on its header.
  await page.click('.sheet th[data-r="-1"][data-c="1"]');
  await page.keyboard.type('Drug X');
  await page.keyboard.press('Enter');
  check((await page.textContent('.sheet th[data-c="1"] .colname')) === 'Drug X', 'renamed a column from the header');

  // --- wide → long -------------------------------------------------------------------------
  await page.click('button:has-text("Wide → long")');
  await settle();
  const resultHead = await page.textContent('.out-head');
  check(/12 rows × 2 columns/.test(resultHead), `wide → long transform (${resultHead.trim()})`);

  // --- new graph from the gallery --------------------------------------------------------
  await page.click('[data-k="new-graph"]');
  await page.click('[data-k="tpl-bar_points"]');
  await page.click('[data-k="create-graph"]');
  await settle();
  await page.waitForFunction(() => document.querySelector('img.plot')?.getAttribute('src'), null, { timeout: 30000 });
  check(await page.locator('.preview-status .message.error').count() === 0, 'bar graph renders');
  const graphName = await page.inputValue('[data-k="item-name"]');

  // Add a layer and turn it into a box plot with a fixed colour.
  await page.click('[data-k="add-layer"]');
  const lastGeom = page.locator('.layer').last().locator('.card-head select');
  await lastGeom.selectOption('boxplot');
  await page.locator('.layer').last().locator('[data-k$="aes-colour-mode:const"]').click();
  await settle();
  check(await page.locator('.preview-status .message.error').count() === 0, 'added a box plot layer with a fixed colour');
  const code = await page.evaluate(() => window.plotbench.engine.result(window.plotbench.store.selected).code);
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
  const gcode = await page.evaluate(() => window.plotbench.engine.result(window.plotbench.store.selected).code);
  check(gcode.includes('pb_brackets('), 'analysis added to the graph as brackets');
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

  // --- code view ------------------------------------------------------------------------------------
  await page.click('.nav-item:has-text("Whole project as R code")');
  const script = await page.textContent('pre.code');
  check(script.includes('library(ggplot2)') && script.includes('pb_brackets('), 'whole-project script');

  // --- export -----------------------------------------------------------------------------------------
  await nav(graphName);
  await settle();
  for (const fmt of ['pdf', 'png']) {
    await page.selectOption('[data-k="fmt"]', fmt);
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('[data-k="export"]')]);
    const path = join(tmp, dl.suggestedFilename());
    await dl.saveAs(path);
    const head = readFileSync(path).subarray(0, 4).toString('latin1');
    check(fmt === 'pdf' ? head === '%PDF' : head.includes('PNG'), `export ${fmt} (${dl.suggestedFilename()})`);
  }

  // --- save .RData and open it again -------------------------------------------------------------
  const before = await page.$$eval('.nav-item .name', (els) => els.map((e) => e.textContent));
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('button:has-text("Save .RData")')]);
  const saved = join(tmp, 'saved.RData');
  await dl.saveAs(saved);
  const rcheck = execFileSync(process.env.R_SCRIPT || 'Rscript', ['-e', `e <- new.env(); load("${saved}", envir = e); cat(sort(ls(e, all.names = TRUE)), sep = ",")`], { encoding: 'utf8' });
  check(rcheck.includes('.plotbench_project') && rcheck.includes('one_way_anova') && rcheck.includes('plant_growth'), `RData contains objects (${rcheck.split(',').length} objects)`);
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

  check(errors.length === 0, `no errors in the browser console${errors.length ? ': ' + errors.join(' | ') : ''}`);
} catch (e) {
  console.error(e);
  failures++;
  await page.screenshot({ path: join(tmp, 'failure.png') });
  console.error('screenshot:', join(tmp, 'failure.png'));
} finally {
  await browser.close();
  server.kill();
}
console.log(failures ? `\n${failures} failure(s)` : '\nall passed');
process.exit(failures ? 1 : 0);
