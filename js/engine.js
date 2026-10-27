// Runs the generated R code. Two backends share one small interface:
//   webR   - R compiled to WebAssembly, running inside this browser tab (default)
//   bridge - a native R process behind dev/r-bridge.mjs (development and testing)
// The engine runs items in dependency order and re-runs an item only when its
// code (or something it depends on) has changed.
import { config } from './config.js';
import { rstr, rstrvec } from './rcode.js';
import { getItem, depsOf, itemCode, itemPackages, topoOrder } from './model.js';
import { usesMixedModel } from './codegen/stats.js';
import { dataSchema } from './codegen/data.js';
import { pipePlan } from './codegen/transform.js';
import { BASE_PACKAGES } from './codegen/script.js';

const TMP = '/tmp/agrafeuse';

class WebRBackend {
  name = 'webR';

  label() { return config.webrVersion ? `webR ${config.webrVersion}` : 'webR'; }

  async init(status) {
    status('Downloading R (about 30 MB the first time, then cached)…');
    let lastError;
    for (const src of config.webrSources) {
      try {
        const base = new URL(src.base, location.href).href;
        const { WebR } = await import(base + src.module);
        this.webR = new WebR({ baseUrl: base, repoUrl: config.repoUrl });
        await this.webR.init();
        return;
      } catch (e) {
        console.warn(`webR from ${src.base} failed:`, e);
        lastError = e;
      }
    }
    throw new Error(`Could not download R (webR). Check your internet connection. (${lastError?.message || lastError})`);
  }

  async install(pkgs) {
    await this.webR.installPackages(pkgs, { quiet: true });
  }

  evalString(code) {
    return this.webR.evalRString(code);
  }

  readFile(path) {
    return this.webR.FS.readFile(path);
  }

  writeFile(path, bytes) {
    return this.webR.FS.writeFile(path, bytes);
  }
}

class BridgeBackend {
  name = 'native R (bridge)';

  label() { return 'your own R, through the bridge'; }

  async init(status) {
    status('Connecting to local R…');
    await this.evalString('"ok"');
  }

  async install(pkgs) {
    throw new Error(`Install these R packages in your local R: install.packages(c(${pkgs.map((p) => `"${p}"`).join(', ')}))`);
  }

  async evalString(code) {
    const r = await fetch('/__r/eval', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'X-Agrafeuse-Token': config.bridgeToken },
      body: code,
    });
    const text = await r.text();
    if (!r.ok) throw new Error(text || `R bridge error ${r.status}`);
    return text;
  }

  async readFile(path) {
    const b64 = await this.evalString(`gsub("[\\r\\n]", "", jsonlite::base64_enc(readBin(${rstr(path)}, "raw", file.size(${rstr(path)}))))`);
    const bin = atob(b64.trim());
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  async writeFile(path, bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    await this.evalString(`writeBin(jsonlite::base64_dec(${rstr(btoa(bin))}), ${rstr(path)}); "ok"`);
  }
}

// FNV-1a: a cheap fingerprint of code, to know when something must re-run.
function hash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

export class Engine extends EventTarget {
  constructor(getProject) {
    super();
    this.getProject = getProject;
    this.backend = config.engine === 'bridge' ? new BridgeBackend() : new WebRBackend();
    this.state = 'off';
    this.statusText = 'R is not running';
    this.results = new Map(); // id -> { ok, error, warnings, version, schema | result }
    this.renders = new Map(); // graph id -> { key, ok, svg, error, warnings }
    this.installed = new Set();
    this.queue = Promise.resolve();
    this.pending = new Map();
    this.dataSchemas = new Map();
    this.helpers = '';
    this.versions = null; // { r, runtime, packages: { name: version } }
  }

  setStatus(state, text) {
    this.state = state;
    this.statusText = text;
    this.dispatchEvent(new CustomEvent('status', { detail: { state, text } }));
  }

  // Serialise everything that talks to R. A task with a key that is already
  // waiting in the queue is not added twice; the caller shares its result.
  enqueue(fn, key = null) {
    if (key && this.pending.has(key)) return this.pending.get(key);
    const p = this.queue.then(async () => {
      if (key) this.pending.delete(key);
      await this.start();
      this.setStatus('busy', 'Running R…');
      try {
        return await fn();
      } finally {
        if (this.state === 'busy') this.setStatus('ready', `R ready (${this.backend.name})`);
      }
    });
    this.queue = p.catch(() => {});
    if (key) this.pending.set(key, p);
    return p;
  }

  // Start R, install the base packages and load the helpers. If this fails
  // (e.g. no internet for the first package download) it can be retried.
  start() {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      try {
        this.setStatus('starting', 'Starting R…');
        if (!this.helpers) this.helpers = await (await fetch(new URL('../R/helpers.R', import.meta.url))).text();
        if (!this.backendReady) this.backendReady = this.backend.init((t) => this.setStatus('starting', t));
        await this.backendReady.catch((e) => { this.backendReady = null; throw e; });
        await this.ensurePackages([...BASE_PACKAGES, 'jsonlite'], true);
        await this.backend.evalString(`suppressPackageStartupMessages({ ${BASE_PACKAGES.map((p) => `library(${p})`).join('; ')} }); dir.create(${rstr(TMP)}, showWarnings = FALSE, recursive = TRUE); "ok"`);
        await this.backend.evalString(`local({ exprs <- parse(text = ${rstr(this.helpers)}); for (e in exprs) eval(e, globalenv()) }); "ok"`);
        await this.updateVersions();
        this.setStatus('ready', `R ready (${this.backend.name})`);
      } catch (e) {
        console.error(e);
        this.ready = null;
        this.setStatus('error', `R could not start: ${e.message || e} (click to try again)`);
        throw e;
      }
    })();
    return this.ready;
  }

  async ensurePackages(pkgs, starting = false) {
    const need = pkgs.filter((p) => !this.installed.has(p));
    if (!need.length) return;
    const check = async () => {
      const out = await this.backend.evalString(`paste(Filter(function(p) !requireNamespace(p, quietly = TRUE), ${rstrvec(need)}), collapse = ",")`);
      return out ? out.split(',') : [];
    };
    let missing = await check();
    if (missing.length) {
      this.setStatus(starting ? 'starting' : 'busy', `Downloading R packages: ${missing.join(', ')} (first time only)…`);
      try {
        await this.backend.install(missing);
      } catch (e) {
        throw new Error(`Could not install R package(s) ${missing.join(', ')}. ${e.message || ''}`);
      }
      missing = await check();
      if (missing.length) {
        throw new Error(`Could not load R package(s) ${missing.join(', ')}. Packages are downloaded from ${config.repoUrl} the first time; check your internet connection.`);
      }
    }
    need.forEach((p) => this.installed.add(p));
    if (!starting) await this.updateVersions();
  }

  // Versions of R and of every package loaded so far (the footer lists them).
  async updateVersions() {
    try {
      const v = JSON.parse(await this.backend.evalString(`ag_versions(${rstrvec([...this.installed, 'scales'])})`));
      this.versions = { r: v.r, runtime: this.backend.label(), packages: v.packages || {} };
      this.dispatchEvent(new CustomEvent('versions', { detail: this.versions }));
    } catch (e) {
      console.warn('Could not read package versions:', e);
    }
  }

  // Run code; returns { ok, error, warnings, messages, value }.
  async run(code) {
    const out = await this.backend.evalString(`ag_eval_json(${rstr(code)})`);
    const res = JSON.parse(out);
    res.warnings = [].concat(res.warnings || []);
    res.messages = [].concat(res.messages || []);
    return res;
  }

  // ---- schemas (column names / types) ----------------------------------------------------

  schemaOf = (id) => {
    const it = getItem(this.getProject(), id);
    if (!it) return null;
    if (it.kind === 'data') {
      const cached = this.dataSchemas.get(id);
      if (cached && cached.rev === it.rev) return cached.schema;
      const schema = dataSchema(it);
      this.dataSchemas.set(id, { rev: it.rev, schema });
      return schema;
    }
    return this.results.get(id)?.schema || null;
  };

  result(id) {
    return this.results.get(id) || null;
  }

  // ---- running items -----------------------------------------------------------------------

  // Bring an item (and everything it depends on) up to date. Call inside enqueue().
  async ensureNow(id) {
    const project = this.getProject();
    const item = getItem(project, id);
    if (!item) return { ok: false, error: 'This item no longer exists.' };
    const depVersions = [];
    for (const d of depsOf(item)) {
      const dep = getItem(project, d);
      if (!dep) return this.store(id, { ok: false, error: 'Something this uses was deleted. Choose another dataset or analysis.' });
      const r = await this.ensureNow(d);
      if (!r.ok) return this.store(id, { ok: false, upstream: true, error: `"${dep.name}" has a problem: ${r.error}` });
      depVersions.push(r.version);
    }
    const opts = {};
    if (item.kind === 'analysis' && usesMixedModel(item)) opts.mixedEngine = await this.mixedEngine();
    let code;
    try {
      code = itemCode(project, item, this.schemaOf, opts);
    } catch (e) {
      return this.store(id, { ok: false, incomplete: true, error: e.message, version: null });
    }
    const version = hash(`${item.rname}\n${code}\n${depVersions.join(',')}`);
    const prev = this.results.get(id);
    if (prev && prev.version === version) return prev;

    try {
      await this.ensurePackages(itemPackages(item, opts));
    } catch (e) {
      return this.store(id, { ok: false, error: e.message, version: null });
    }
    const post = item.kind === 'analysis' ? `\nag_result_json(${item.rname})`
      : item.kind === 'graph' ? '\n"ok"' : `\nag_describe(${item.rname})`;
    const res = await this.run(code + post);
    const out = { ok: res.ok, error: res.error, warnings: res.warnings, messages: res.messages, version: res.ok ? version : null, code };
    if (res.ok && item.kind === 'analysis') out.result = JSON.parse(res.value);
    else if (res.ok && item.kind !== 'graph') out.schema = JSON.parse(res.value);
    return this.store(id, out);
  }

  // lme4 + lmerTest if they can be loaded, otherwise nlme (decided once).
  async mixedEngine() {
    if (!this.mixedChoice) {
      try {
        await this.ensurePackages(['lme4', 'lmerTest']);
        this.mixedChoice = 'lme4';
      } catch (e) {
        console.warn('lme4 unavailable, using nlme for mixed models:', e);
        this.mixedChoice = 'nlme';
      }
    }
    return this.mixedChoice;
  }

  store(id, res) {
    this.results.set(id, res);
    this.dispatchEvent(new CustomEvent('result', { detail: { id, res } }));
    return res;
  }

  ensure(id) {
    return this.enqueue(() => this.ensureNow(id));
  }

  // Preview rows of a dataset (data table or transform output).
  preview(id, n = 200) {
    return this.enqueue(async () => {
      const r = await this.ensureNow(id);
      if (!r.ok) return { ok: false, error: r.error };
      const item = getItem(this.getProject(), id);
      const res = await this.run(`ag_preview(${item.rname}, ${n})`);
      return res.ok ? { ok: true, table: JSON.parse(res.value), warnings: r.warnings } : res;
    });
  }

  // Run a data table's own pipeline (item.pipe.steps) one step at a time.
  // Returns { ok, plan, input, table, failed, error }: plan has one entry per
  // step with its state (run / off / incomplete / error / skipped) and the
  // columns after it; table is the first rows of the result (every row if full).
  pipe(id, { full = false } = {}) {
    return this.enqueue(async () => {
      const r = await this.ensureNow(id);
      if (!r.ok) return { ok: false, error: r.error };
      const item = getItem(this.getProject(), id);
      const plan = pipePlan(item.pipe?.steps || [], this.schemaOf(id));
      const run = plan.filter((p) => p.state === 'run');
      const res = await this.run(`ag_pipe_eval(${item.rname}, ${rstrvec(run.map((p) => p.code))}, ${full ? 'Inf, 15' : '200, 6'})`);
      if (!res.ok) return { ok: false, error: res.error, plan };
      const out = JSON.parse(res.value);
      run.forEach((p, j) => {
        if (out.failed && j + 1 > out.failed) p.state = 'skipped';
        else if (out.failed === j + 1) { p.state = 'error'; p.error = out.error; } else p.stage = out.stages[j];
      });
      return {
        ok: true, plan, input: out.input, table: out.table, warnings: res.warnings,
        failed: out.failed ? run[out.failed - 1].index : null, error: out.error,
      };
    }, full ? null : `pipe:${id}`);
  }

  // Draw a graph as SVG for the on-screen preview. Repeated requests for the
  // same graph while one is waiting collapse into a single render.
  render(id) {
    return this.enqueue(async () => {
      const r = await this.ensureNow(id);
      const g = getItem(this.getProject(), id);
      if (!g) return { ok: false, error: 'This graph no longer exists.' };
      if (!r.ok) {
        const out = { ok: false, error: r.error, incomplete: r.incomplete };
        this.renders.set(id, out);
        return out;
      }
      const s = g.size || {};
      const key = `${r.version}:${s.width}:${s.height}`;
      const prev = this.renders.get(id);
      if (prev && prev.key === key && prev.ok) return prev;
      const res = JSON.parse(await this.backend.evalString(
        `ag_draw(${g.rname}, ${rstr(`${TMP}/preview.svg`)}, "svg", ${Number(s.width) || 5}, ${Number(s.height) || 4}, inline = TRUE, geometry = TRUE)`));
      const out = { ok: res.ok, error: res.error, svg: res.svg, geometry: res.geometry || null, warnings: [...(r.warnings || []), ...[].concat(res.warnings || [])], key };
      this.renders.set(id, out);
      return out;
    }, `render:${id}`);
  }

  // A graph file: svg, pdf, png or tiff. Returns bytes.
  exportGraph(id, format, { width, height, dpi = 300 } = {}) {
    return this.enqueue(async () => {
      const r = await this.ensureNow(id);
      if (!r.ok) throw new Error(r.error);
      const g = getItem(this.getProject(), id);
      const file = `${TMP}/export.${format}`;
      const res = JSON.parse(await this.backend.evalString(
        `ag_draw(${g.rname}, ${rstr(file)}, ${rstr(format)}, ${Number(width) || 5}, ${Number(height) || 4}, dpi = ${Number(dpi) || 300})`));
      if (!res.ok) throw new Error(res.error);
      return this.backend.readFile(file);
    });
  }

  // Everything up to date, then one .RData with all objects + the project itself.
  saveRData() {
    return this.enqueue(async () => {
      const project = this.getProject();
      const names = [];
      for (const it of topoOrder(project)) {
        const r = await this.ensureNow(it.id);
        if (r.ok) names.push(it.rname);
      }
      const file = `${TMP}/project.RData`;
      const res = await this.run(`ag_save_rdata(${rstr(file)}, ${rstrvec(names)}, ${rstr(JSON.stringify(project))}); "ok"`);
      if (!res.ok) throw new Error(res.error);
      return this.backend.readFile(file);
    });
  }

  // Read an .RData file: returns { project (object or null), frames: { name: table } }.
  loadRData(bytes) {
    return this.enqueue(async () => {
      const file = `${TMP}/upload.RData`;
      await this.backend.writeFile(file, bytes);
      const res = await this.run(`ag_load_rdata(${rstr(file)})`);
      if (!res.ok) throw new Error(`This file could not be read as .RData: ${res.error}`);
      const out = JSON.parse(res.value);
      return { project: out.project ? JSON.parse(out.project) : null, frames: out.frames || {}, objects: out.objects || [] };
    });
  }

  // A data frame that ships with R (iris, mtcars, ToothGrowth…) as grid rows.
  rDataset(name) {
    return this.enqueue(async () => {
      const res = await this.run(`ag_table_json(get(${rstr(name)}, envir = as.environment("package:datasets")))`);
      if (!res.ok) throw new Error(res.error);
      return JSON.parse(res.value);
    });
  }

  // Check that user-typed R code at least parses.
  checkCode(code) {
    return this.enqueue(async () => JSON.parse(await this.backend.evalString(`ag_check_code(${rstr(code)})`)));
  }

  // Forget cached results (e.g. after loading a different project).
  reset() {
    this.results.clear();
    this.renders.clear();
    this.dataSchemas.clear();
  }
}
