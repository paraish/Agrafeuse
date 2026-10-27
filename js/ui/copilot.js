// The assistant: a pane on the right of every screen. It talks to a language
// model (in this browser through WebLLM, which the user opts into, or any
// OpenAI-compatible server such as LM Studio) and turns requests into actions
// the user reviews and applies; a batch of actions is one undo step.
import { h, fill, icon, rebuild } from './dom.js';
import { button, iconButton, select, input, checkbox, messageBox, toast } from './widgets.js';
import { WEBLLM_MODELS, API_PRESETS, PLAN_SCHEMA, WebLLMBackend, OpenAIBackend, webgpuStatus, isLocalUrl } from '../copilot/llm.js';
import { parseReply, parsePlan, describeAction, applyActions, rehearsal, rehearse } from '../copilot/actions.js';
import { planMessages, stepMessages, previewTarget, repairRequest } from '../copilot/prompt.js';
import { getItem, datasets } from '../model.js';

const SETTINGS_KEY = 'agrafeuse:assistant';
const KEY_KEY = 'agrafeuse:assistant-key';

const SUGGESTIONS = [
  'Which test should I use for this data?',
  'Make a bar graph with the individual points and compare the groups.',
  'Add the mean, SD and n of each group to the pipeline.',
  'Explain the result of my analysis in plain words.',
];

function loadSettings() {
  try {
    return { open: false, backend: '', webllmModel: WEBLLM_MODELS[0].id, api: { preset: 'lmstudio', base: API_PRESETS.lmstudio.base, model: '' }, share: null, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') };
  } catch {
    return { open: false, backend: '', webllmModel: WEBLLM_MODELS[0].id, api: { preset: 'lmstudio', base: API_PRESETS.lmstudio.base, model: '' }, share: null };
  }
}

export class Copilot {
  constructor(app) {
    this.app = app;
    this.settings = loadSettings();
    this.key = '';
    try { this.key = localStorage.getItem(KEY_KEY) || ''; } catch { /* storage blocked */ }
    this.rememberKey = !!this.key;
    this.messages = []; // { role: 'user' | 'assistant' | 'error' | 'status', … }
    this.backend = null;
    this.setup = !this.settings.backend;
    this.el = h('aside.copilot', { 'aria-label': 'Assistant' });
    this.render();
  }

  save() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings)); } catch { /* storage blocked */ }
  }

  get open() { return !!this.settings.open; }

  toggle(open = !this.open) {
    this.settings.open = open;
    this.save();
    this.render();
    if (open) this.el.querySelector('textarea, select, button.primary')?.focus();
  }

  // Data values and results go to the model only with permission. By default
  // they do when the model runs here (browser or a server on this computer).
  get local() {
    if (this.settings.backend === 'webllm') return true;
    return this.settings.backend === 'api' && isLocalUrl(this.settings.api.base);
  }

  get share() { return this.settings.share ?? this.local; }

  render() {
    this.el.classList.toggle('collapsed', !this.open);
    this.app.root.classList.toggle('copilot-open', this.open);
    rebuild(this.el, () => (this.open ? this.pane() : this.strip()));
    const log = this.el.querySelector('.cp-log');
    if (log) log.scrollTop = log.scrollHeight;
  }

  strip() {
    return h('button.cp-strip', { type: 'button', 'data-k': 'cp-open', onclick: () => this.toggle(true), title: 'Ask the assistant to do things for you, or to explain' },
      icon('spark'), h('span.cp-strip-label', 'Assistant'));
  }

  pane() {
    const b = this.backend;
    const status = b ? b.label : this.settings.backend === 'webllm' ? 'In this browser (starts on first question)'
      : this.settings.backend === 'api' ? this.settings.api.model || 'API' : 'Not set up';
    return h('div.cp-inner',
      h('div.cp-head',
        icon('spark'), h('span.cp-title', 'Assistant'), h('span.cp-status', { title: status }, status),
        h('span.grow'),
        this.messages.length ? iconButton('trash', 'Clear the conversation', () => { this.messages = []; this.render(); }, { k: 'cp-clear' }) : null,
        iconButton('settings', 'Choose the model', () => { this.setup = !this.setup; this.render(); }, { k: 'cp-settings' }),
        iconButton('arrowRight', 'Hide the assistant', () => this.toggle(false), { k: 'cp-close' })),
      this.setup ? this.setupView() : this.chatView());
  }

  // ---- choosing a model ------------------------------------------------------------------------

  setupView() {
    const s = this.settings;
    const choice = this.draftBackend || s.backend || 'webllm';
    const pick = (v) => { this.draftBackend = v; this.render(); };
    const card = (value, title, desc) => h('label.cp-choice', { class: choice === value ? 'on' : '' },
      h('input', { type: 'radio', name: 'cp-backend', value, checked: choice === value, 'data-k': `cp-backend-${value}`, onchange: () => pick(value) }),
      h('span', h('b', title), h('span.muted', desc)));
    return h('div.cp-setup', { 'data-scroll': 'cp-setup' },
      h('p.cp-intro', 'Ask in plain words, e.g. "compare weight between the groups and show it on a bar graph". The assistant proposes steps; you check them and apply them, and Ctrl+Z undoes them.'),
      card('webllm', 'A model in this browser', 'Free and private: nothing leaves this computer. Downloads a model once (2–6 GB), then works offline. Needs a recent Chrome or Edge and a reasonable graphics card.'),
      card('api', 'LM Studio, Ollama or an online API', 'Any OpenAI-compatible server: a model on this computer (LM Studio, Ollama), or OpenAI, OpenRouter, Gemini… with your own key.'),
      choice === 'webllm' ? this.webllmSetup() : this.apiSetup());
  }

  webllmSetup() {
    const s = this.settings;
    const model = WEBLLM_MODELS.find((m) => m.id === s.webllmModel) || WEBLLM_MODELS[0];
    const msg = h('div.cp-gpu');
    webgpuStatus().then((st) => { if (!st.ok) fill(msg, messageBox('info', st.why)); });
    const progress = this.loading ? h('div.cp-progress',
      h('div.cp-bar', h('span', { style: { width: `${Math.round((this.loading.p || 0) * 100)}%` } })),
      h('div.muted', this.loading.text || 'Starting…')) : null;
    return h('div.cp-form',
      h('label.cp-label', 'Model'),
      select(model.id, WEBLLM_MODELS.map((m) => [m.id, `${m.label} · ${m.gb} GB · ${m.license}`]), (v) => { s.webllmModel = v; this.save(); this.render(); }, { k: 'cp-model' }),
      h('div.hint', 'The download happens once; the browser keeps the model for next time. Answers take a few seconds to a minute, depending on the graphics card.'),
      h('div.hint', 'Bigger models understand requests much better. If your graphics card has 8 GB or more, choose Qwen3 8B; for the best results, run a 8–14B model in LM Studio or Ollama (the other option above).'),
      msg,
      progress,
      button(this.backend?.kind === 'webllm' && this.backend.modelId === model.id ? 'Running' : 'Download and start', () => this.startWebLLM(), {
        kind: 'primary', iconName: 'download', k: 'cp-start', disabled: !!this.loading,
      }));
  }

  async startWebLLM() {
    const s = this.settings;
    const st = await webgpuStatus();
    if (!st.ok) { toast(st.why, 'error', 8000); return; }
    await this.backend?.unload();
    this.backend = null;
    const b = new WebLLMBackend(s.webllmModel);
    this.loading = { p: 0, text: 'Getting the model…' };
    this.render();
    try {
      await b.load((p, text) => {
        this.loading = { p, text };
        const bar = this.el.querySelector('.cp-bar span');
        const t = this.el.querySelector('.cp-progress .muted');
        if (bar) bar.style.width = `${Math.round(p * 100)}%`;
        if (t) t.textContent = text;
      });
      this.backend = b;
      s.backend = 'webllm';
      this.save();
      this.setup = false;
      toast(`${b.label} is ready.`);
    } catch (e) {
      toast(`Could not start the model: ${e.message}`, 'error', 10000);
    } finally {
      this.loading = null;
      this.render();
    }
  }

  apiSetup() {
    const s = this.settings;
    const api = s.api;
    const preset = API_PRESETS[api.preset] || API_PRESETS.custom;
    const list = h('datalist', { id: 'cp-models' }, (this.modelList || []).map((m) => h('option', { value: m })));
    // Whether data leaves this computer, updated as the address is typed.
    const privacy = h('div.cp-privacy');
    const showPrivacy = () => fill(privacy, isLocalUrl(api.base)
      ? h('div.hint.cp-private', icon('info', 14), ' This server is on this computer: your data stays here.')
      : h('div.message.info.cp-warn', icon('alert'), h('div', `What you ask, the names of your items and columns${this.share ? ', and data values and results' : ''} are sent to ${hostOf(api.base)}. Its rules on storing and using them apply.`)));
    showPrivacy();
    return h('div.cp-form',
      h('label.cp-label', 'Server'),
      select(api.preset, Object.entries(API_PRESETS).map(([k, p]) => [k, p.label]), (v) => {
        api.preset = v;
        api.base = API_PRESETS[v].base;
        this.modelList = null;
        this.render();
      }, { k: 'cp-preset' }),
      h('div.hint', preset.help),
      h('label.cp-label', 'Address'),
      input(api.base, (v) => { api.base = v.trim(); showPrivacy(); }, { k: 'cp-base', placeholder: 'https://…/v1' }),
      h('label.cp-label', preset.key ? 'API key' : 'API key (only if the server asks for one)'),
      input(this.key, (v) => { this.key = v.trim(); }, { k: 'cp-key', type: 'password', placeholder: preset.key ? 'Paste your key' : '(none)' }),
      checkbox(this.rememberKey, 'Remember the key in this browser', (v) => { this.rememberKey = v; }, { k: 'cp-remember', title: 'Kept only in this browser (not in your project files). Leave this off on a shared computer.' }),
      h('label.cp-label', 'Model'),
      h('div.hint', 'Instruction-tuned models of 7B or more work best (e.g. Qwen3 8B or 14B, Gemma 3 12B, Llama 3.1 8B); very small models often pick the wrong columns.'),
      h('div.cp-row',
        h('input', { 'data-k': 'cp-api-model', list: 'cp-models', value: api.model, placeholder: 'e.g. qwen3-8b', oninput: (e) => { api.model = e.target.value.trim(); } }),
        button('List models', () => this.listModels(), { k: 'cp-list' })),
      list,
      privacy,
      button('Connect', () => this.connectAPI(), { kind: 'primary', k: 'cp-connect' }));
  }

  apiBackend() {
    return new OpenAIBackend({ ...this.settings.api, key: this.key });
  }

  async listModels() {
    try {
      this.modelList = await this.apiBackend().models();
      if (!this.settings.api.model && this.modelList.length) this.settings.api.model = this.modelList[0];
      toast(`${this.modelList.length} models found.`);
    } catch (e) {
      toast(e.message, 'error', 10000);
    }
    this.render();
  }

  connectAPI() {
    const api = this.settings.api;
    if (!api.base) { toast('Type the server address.', 'error'); return; }
    if (!api.model) { toast('Choose a model (List models shows what the server has).', 'error'); return; }
    if (API_PRESETS[api.preset]?.key && !this.key) { toast('This server needs an API key.', 'error'); return; }
    try {
      if (this.rememberKey && this.key) localStorage.setItem(KEY_KEY, this.key);
      else localStorage.removeItem(KEY_KEY);
    } catch { /* storage blocked */ }
    this.backend?.unload();
    this.backend = this.apiBackend();
    this.settings.backend = 'api';
    this.save();
    this.setup = false;
    this.render();
  }

  // ---- the conversation ----------------------------------------------------------------------

  chatView() {
    const share = checkbox(this.share, 'Let it see data values and results', (v) => { this.settings.share = v; this.save(); this.render(); }, {
      k: 'cp-share',
      title: this.local ? 'The model runs on this computer, so nothing leaves it either way.' : `Off: only item names, column names, types and group names are sent to ${hostOf(this.settings.api.base)}.`,
    });
    const ta = h('textarea.cp-input', { rows: 3, 'data-k': 'cp-input', placeholder: 'Ask, or tell it what to do…', disabled: !!this.busy });
    ta.value = this.draft || '';
    ta.addEventListener('input', () => { this.draft = ta.value; });
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.send(ta.value); }
    });
    return h('div.cp-chat',
      h('div.cp-log', { 'data-scroll': 'cp-log', 'aria-live': 'polite' },
        this.messages.length ? this.messages.map((m, i) => this.messageView(m, i))
          : h('div.cp-empty', h('p.muted', 'Try:'), SUGGESTIONS.map((t) => h('button.cp-suggest', { type: 'button', onclick: () => this.send(t) }, t)))),
      h('div.cp-compose',
        ta,
        h('div.cp-row',
          share,
          h('span.grow'),
          this.busy ? button('Stop', () => this.abort?.abort(), { iconName: 'stop', k: 'cp-stop' })
            : button('Send', () => this.send(ta.value), { iconName: 'send', kind: 'primary', k: 'cp-send' }))));
  }

  messageView(m, i) {
    if (m.role === 'user') return h('div.cp-msg.cp-user', m.text);
    if (m.role === 'status') return h('div.cp-msg.cp-pending', h('span.cp-dots'), m.text);
    if (m.role === 'error') {
      return h('div.cp-msg.cp-error', icon('alert'), h('div', m.text,
        m.retry ? h('div', button('Try again', () => { this.messages.splice(i - 1, 2); this.ask(m.retry); }, { k: `cp-retry-${i}` })) : null));
    }
    // assistant: its thinking, then the plan (steps, each with its actions) or a list of actions
    const head = {
      working: `Working on step ${(m.steps || []).findIndex((st) => ['working', 'fixing'].includes(st.status)) + 1} of ${m.steps?.length}…`,
      applied: 'Done:', undone: 'Undone:', dismissed: 'Not applied:',
    }[m.status] || (m.steps ? `Plan (${m.steps.length} ${m.steps.length === 1 ? 'step' : 'steps'}):` : `Proposed ${m.actions?.length === 1 ? 'step' : 'steps'}:`);
    const body = m.steps ? this.stepsView(m, i) : m.actions?.length ? h('ol', m.actions.map((_, j) => this.actionItem(m, i, j))) : null;
    const plan = body ? h('div.cp-plan',
      h('div.cp-plan-head', head),
      body,
      m.status === 'proposed' && m.actions.length ? h('div.cp-row',
        button(`Apply${m.actions.length > 1 ? ` ${m.actions.length - (m.skip?.size || 0)} actions` : ''}`, () => this.apply(m), { kind: 'primary', iconName: 'check', k: `cp-apply-${i}` }),
        button('Dismiss', () => { m.status = 'dismissed'; this.render(); }, { k: `cp-dismiss-${i}` })) : null,
      m.status === 'applied' ? h('div.cp-row', button('Undo', () => { this.app.store.undo(); m.status = 'undone'; this.render(); }, { iconName: 'undo', k: `cp-undo-${i}` })) : null) : null;
    return h('div.cp-msg.cp-bot',
      m.thinking ? h('div.cp-thinking', h('b', 'Thinking: '), m.thinking) : null,
      m.reply ? h('div.cp-reply', m.reply) : null,
      plan,
      m.raw ? h('details.cp-raw', h('summary', 'What the model wrote'), h('pre', m.raw)) : null);
  }

  // The plan, step by step, with each step's actions under it.
  stepsView(m, i) {
    const mark = (st) => ({
      waiting: h('span.cp-st-wait'), working: h('span.cp-dots'), fixing: h('span.cp-dots'),
      done: icon('check', 14), partly: icon('alert', 14), empty: icon('info', 14), failed: icon('alert', 14), stopped: icon('stop', 14),
    }[st.status]);
    const note = (st) => ({
      fixing: ' (fixing what would not work…)', empty: ' (nothing to do for this step)', stopped: ' (stopped)',
    }[st.status] || '');
    return h('ol.cp-steps', m.steps.map((st, k) => h('li.cp-step', { class: st.status },
      h('div.cp-step-head', mark(st), h('span', h('b', `${k + 1}. `), st.text, h('span.cp-note', note(st)),
        st.error ? h('span.cp-note.cp-wont', ` ${st.error}`) : null)),
      h('ul.cp-acts', m.actions.map((_, j) => (m.stepOf[j] === k ? this.actionItem(m, i, j) : null))))));
  }

  // One action: a tick box while proposed, then whether it worked.
  actionItem(m, i, j) {
    const a = m.actions[j];
    const r = m.results?.[j];
    const off = m.skip?.has(j);
    const check = m.checks?.[j];
    return h('li', { class: [r ? (r.ok ? 'ok' : 'bad') : '', off ? 'off' : ''].join(' ') },
      m.status === 'proposed' ? h('input', {
        type: 'checkbox', checked: !off, 'aria-label': 'Include this action', 'data-k': `cp-step-${i}-${j}`,
        onchange: (e) => { m.skip = m.skip || new Set(); if (e.target.checked) m.skip.delete(j); else m.skip.add(j); this.render(); },
      }) : r ? icon(r.ok ? 'check' : 'alert', 14) : null,
      h('span', describeAction(a), r?.note ? h('span.cp-note', ` ${r.note}`) : null,
        m.status === 'proposed' && check && !check.ok ? h('span.cp-note.cp-wont', ` Won't work: ${check.note}`) : null,
        m.status === 'proposed' && check?.ok && check.note ? h('span.cp-note', ` ${check.note}`) : null));
  }

  // What was said before, for context (actions as the model wrote them).
  history() {
    const out = [];
    for (const m of this.messages) {
      if (m.role === 'user') out.push({ role: 'user', content: m.text });
      else if (m.role === 'assistant') out.push({ role: 'assistant', content: JSON.stringify({ reply: m.reply, ...(m.steps ? { plan: m.steps.map((st) => st.text) } : {}), actions: m.actions || [] }) });
    }
    return out;
  }

  send(text) {
    text = String(text || '').trim();
    if (!text || this.busy) return;
    if (!this.settings.backend) { this.setup = true; this.render(); return; }
    this.draft = '';
    this.ask(text);
  }

  // Asking: the model first thinks and breaks the request into steps; then, step
  // by step, it gives the actions for each one, which are tried on a working
  // copy of the project (so later steps can use what earlier ones make). A
  // question gets an answer straight away.
  async ask(text) {
    const history = this.history();
    this.messages.push({ role: 'user', text });
    const pending = { role: 'status', text: 'Thinking…' };
    this.messages.push(pending);
    this.busy = true;
    this.abort = new AbortController();
    this.render();
    const started = Date.now();
    const tick = setInterval(() => {
      const el = this.el.querySelector('.cp-pending');
      if (el) el.lastChild.textContent = `${pending.text} ${Math.round((Date.now() - started) / 1000)} s`;
    }, 1000);
    let m = null;
    try {
      await this.ensureBackend(pending);
      pending.text = 'Thinking…';
      const opts = await this.context();
      const signal = this.abort.signal;
      const planRaw = await this.backend.chat(planMessages(this.app, history, text, opts), { signal, schema: PLAN_SCHEMA });
      const planned = parsePlan(planRaw);
      this.messages.splice(this.messages.indexOf(pending), 1);
      if (!planned) {
        // Not a plan: perhaps the model went straight to actions.
        const parsed = parseReply(planRaw);
        m = { role: 'assistant', reply: parsed.reply || (parsed.actions.length ? '' : '(no answer)'), actions: parsed.actions, raw: planRaw };
        if (parsed.actions.length) {
          const tried = rehearse(this.app, rehearsal(this.app), parsed.actions);
          Object.assign(m, { checks: tried.results, status: 'proposed' });
          m.skip = new Set(m.checks.map((c, j) => (c.ok ? -1 : j)).filter((j) => j >= 0));
        }
        this.messages.push(m);
        return;
      }
      m = {
        role: 'assistant', reply: planned.reply, thinking: planned.thinking, raw: planRaw,
        steps: planned.plan.map((t) => ({ text: t, status: 'waiting' })), actions: [], stepOf: [], checks: [],
        status: planned.plan.length ? 'working' : null,
      };
      if (!planned.plan.length) {
        if (!m.reply) m.reply = '(no answer)';
        delete m.steps;
        this.messages.push(m);
        return;
      }
      this.messages.push(m);
      this.render();
      let state = rehearsal(this.app);
      const done = [];
      const failing = (rs) => rs.filter((r) => !r.ok).length;
      for (let k = 0; k < m.steps.length; k++) {
        const step = m.steps[k];
        step.status = 'working';
        this.render();
        let raw;
        let parsed;
        let tried;
        try {
          const msgs = stepMessages(this.app, text, planned.plan, k, done, { ...opts, preview: null, project: state.p });
          raw = await this.backend.chat(msgs, { signal });
          parsed = parseReply(raw);
          tried = rehearse(this.app, state, parsed.actions);
          if (failing(tried.results)) {
            // What would not work goes back to the model once, with the reasons.
            step.status = 'fixing';
            this.render();
            const problems = tried.results.map((r, index) => ({ ...r, index, do: parsed.actions[index].do, why: r.note })).filter((r) => !r.ok);
            const raw2 = await this.backend.chat([...msgs, { role: 'assistant', content: raw }, { role: 'user', content: repairRequest(problems) }], { signal });
            const p2 = parseReply(raw2);
            const t2 = rehearse(this.app, state, p2.actions);
            if (p2.actions.length && failing(t2.results) < failing(tried.results)) { parsed = p2; tried = t2; raw = raw2; }
          }
        } catch (e) {
          if (e.name === 'AbortError') throw e;
          step.status = 'failed';
          step.error = e.message || String(e);
          this.render();
          continue;
        }
        const made = tried.state.p.items.filter((it) => !state.p.items.some((o) => o.id === it.id));
        state = tried.state;
        parsed.actions.forEach((a, j) => { m.actions.push(a); m.stepOf.push(k); m.checks.push(tried.results[j]); });
        step.status = !parsed.actions.length ? 'empty' : failing(tried.results) ? 'partly' : 'done';
        m.raw += `\n\n— step ${k + 1} —\n${raw}`;
        done.push(`Step ${k + 1}: ${parsed.actions.map(describeAction).join('; ') || 'nothing'}${made.length ? ` (made ${made.map((it) => `the ${it.kind === 'transform' ? 'dataset' : it.kind} "${it.name}"`).join(', ')})` : ''}.`);
        this.render();
      }
      this.finishPlan(m);
    } catch (e) {
      const i = this.messages.indexOf(pending);
      if (i >= 0) this.messages.splice(i, 1);
      if (e.name === 'AbortError' && m?.steps) {
        // Keep what was planned so far.
        m.steps.forEach((st) => { if (['waiting', 'working', 'fixing'].includes(st.status)) st.status = 'stopped'; });
        this.finishPlan(m);
      } else if (!m || !m.steps) {
        this.messages.push(e.name === 'AbortError' ? { role: 'error', text: 'Stopped.' } : { role: 'error', text: e.message || String(e), retry: text });
      }
    } finally {
      clearInterval(tick);
      this.busy = false;
      this.abort = null;
      this.render();
      this.el.querySelector('.cp-input')?.focus();
    }
  }

  finishPlan(m) {
    m.skip = new Set(m.checks.map((c, j) => (c.ok ? -1 : j)).filter((j) => j >= 0));
    m.status = m.actions.length ? 'proposed' : null;
  }

  // What the model is told about the project: every dataset's columns (transforms
  // are run first), and with permission, the first rows of the dataset in view.
  async context() {
    const engine = this.app.engine;
    if (engine.state === 'ready') {
      await Promise.all(datasets(this.app.store.project).filter((d) => !engine.schemaOf(d.id)).map((d) => engine.ensure(d.id).catch(() => null)));
    }
    let preview = null;
    const ds = this.share ? previewTarget(this.app) : null;
    if (ds && engine.state === 'ready') {
      const res = await engine.preview(ds, 15).catch(() => null);
      if (res?.ok) preview = { name: getItem(this.app.store.project, ds)?.name, table: res.table };
    }
    return { shareValues: this.share, preview, budget: this.backend.kind === 'webllm' ? 2900 : 24000 };
  }

  // The model, started on first use (an in-browser model the user already downloaded loads from the cache).
  async ensureBackend(pending) {
    if (this.backend) return;
    const s = this.settings;
    if (s.backend === 'api') {
      if (API_PRESETS[s.api.preset]?.key && !this.key) {
        this.setup = true;
        throw new Error('Paste your API key again (it was not kept in this browser).');
      }
      this.backend = this.apiBackend();
      return;
    }
    const st = await webgpuStatus();
    if (!st.ok) throw new Error(st.why);
    const b = new WebLLMBackend(s.webllmModel);
    pending.text = `Starting ${b.label}…`;
    this.render();
    await b.load((p, text) => {
      const el = this.el.querySelector('.cp-pending');
      if (el) el.lastChild.textContent = `${text} (${Math.round(p * 100)}%)`;
    });
    this.backend = b;
  }

  apply(m) {
    const chosen = m.actions.filter((_, j) => !m.skip?.has(j));
    const results = applyActions(this.app, chosen);
    // Line results up with all proposed actions (skipped ones have none).
    let k = 0;
    m.results = m.actions.map((_, j) => (m.skip?.has(j) ? { ok: false, note: '(left out)' } : results[k++]));
    m.status = 'applied';
    this.render();
    const failed = results.filter((r) => !r.ok).length;
    if (failed) toast(`${failed} of ${results.length} steps could not be done; see the assistant.`, 'error', 6000);
  }
}

function hostOf(url) {
  try { return new URL(url).host; } catch { return 'that server'; }
}
