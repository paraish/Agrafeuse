// The assistant: a pane on the right of every screen. It talks to a language
// model (in this browser through WebLLM, which the user opts into, or any
// OpenAI-compatible server such as LM Studio) and turns requests into actions
// the user reviews and applies; a batch of actions is one undo step.
import { h, fill, icon, rebuild } from './dom.js';
import { button, iconButton, select, input, checkbox, messageBox, toast } from './widgets.js';
import { WEBLLM_MODELS, API_PRESETS, WebLLMBackend, OpenAIBackend, webgpuStatus, isLocalUrl } from '../copilot/llm.js';
import { parseReply, describeAction, applyActions, checkActions } from '../copilot/actions.js';
import { buildMessages, previewTarget, repairRequest } from '../copilot/prompt.js';
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
    // assistant
    const plan = m.actions?.length ? h('div.cp-plan',
      h('div.cp-plan-head', m.status === 'applied' ? 'Done:' : m.status === 'undone' ? 'Undone:' : m.status === 'dismissed' ? 'Not applied:' : `Proposed ${m.actions.length === 1 ? 'step' : 'steps'}:`),
      h('ol', m.actions.map((a, j) => {
        const r = m.results?.[j];
        const off = m.skip?.has(j);
        return h('li', { class: [r ? (r.ok ? 'ok' : 'bad') : '', off ? 'off' : ''].join(' ') },
          m.status === 'proposed' ? h('input', { type: 'checkbox', checked: !off, 'aria-label': 'Include this step', 'data-k': `cp-step-${i}-${j}`, onchange: (e) => { m.skip = m.skip || new Set(); if (e.target.checked) m.skip.delete(j); else m.skip.add(j); } })
            : r ? icon(r.ok ? 'check' : 'alert', 14) : null,
          h('span', describeAction(a), r?.note ? h('span.cp-note', ` ${r.note}`) : null,
            m.status === 'proposed' && m.checks?.[j] && !m.checks[j].ok ? h('span.cp-note.cp-wont', ` Won't work: ${m.checks[j].note}`) : null,
            m.status === 'proposed' && m.checks?.[j]?.ok && m.checks[j].note ? h('span.cp-note', ` ${m.checks[j].note}`) : null));
      })),
      m.status === 'proposed' ? h('div.cp-row',
        button('Apply', () => this.apply(m), { kind: 'primary', iconName: 'check', k: `cp-apply-${i}` }),
        button('Dismiss', () => { m.status = 'dismissed'; this.render(); }, { k: `cp-dismiss-${i}` })) : null,
      m.status === 'applied' ? h('div.cp-row', button('Undo', () => { this.app.store.undo(); m.status = 'undone'; this.render(); }, { iconName: 'undo', k: `cp-undo-${i}` })) : null) : null;
    return h('div.cp-msg.cp-bot', m.reply ? h('div.cp-reply', m.reply) : null, plan,
      m.raw ? h('details.cp-raw', h('summary', 'What the model wrote'), h('pre', m.raw)) : null);
  }

  // What was said before, for context (actions as the model wrote them).
  history() {
    const out = [];
    for (const m of this.messages) {
      if (m.role === 'user') out.push({ role: 'user', content: m.text });
      else if (m.role === 'assistant') out.push({ role: 'assistant', content: JSON.stringify({ reply: m.reply, actions: m.actions || [] }) });
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
    try {
      await this.ensureBackend(pending);
      pending.text = 'Thinking…';
      const engine = this.app.engine;
      // Every dataset's columns, so the model sees them (transforms are known only once they have run).
      if (engine.state === 'ready') {
        await Promise.all(datasets(this.app.store.project).filter((d) => !engine.schemaOf(d.id)).map((d) => engine.ensure(d.id).catch(() => null)));
      }
      let preview = null;
      const ds = this.share ? previewTarget(this.app) : null;
      if (ds && engine.state === 'ready') {
        const res = await engine.preview(ds, 15).catch(() => null);
        if (res?.ok) preview = { name: getItem(this.app.store.project, ds)?.name, table: res.table };
      }
      const budget = this.backend.kind === 'webllm' ? 2900 : 24000;
      const messages = buildMessages(this.app, history, text, { shareValues: this.share, preview, budget });
      const raw = await this.backend.chat(messages, { signal: this.abort.signal });
      let parsed = parseReply(raw);
      let checks = checkActions(this.app, parsed.actions);
      // Steps that would not work go back to the model once, with the reasons.
      const failing = (c) => c.filter((x) => !x.ok).length;
      if (failing(checks)) {
        pending.text = 'Checking its plan…';
        this.render();
        const problems = checks.map((c, index) => ({ ...c, index, do: parsed.actions[index].do, why: c.note })).filter((c) => !c.ok);
        const retry = [messages[0], { role: 'user', content: text }, { role: 'assistant', content: raw }, { role: 'user', content: repairRequest(problems) }];
        try {
          const raw2 = await this.backend.chat(retry, { signal: this.abort.signal });
          const p2 = parseReply(raw2);
          const c2 = checkActions(this.app, p2.actions);
          if (p2.actions.length && failing(c2) < failing(checks)) { parsed = p2; checks = c2; }
        } catch (e) {
          if (e.name === 'AbortError') throw e;
        }
      }
      this.messages.splice(this.messages.indexOf(pending), 1);
      // Steps that still would not work are shown, unticked, with the reason.
      const skip = new Set(checks.map((c, j) => (c.ok ? -1 : j)).filter((j) => j >= 0));
      this.messages.push({
        role: 'assistant', reply: parsed.reply || (parsed.actions.length ? '' : '(no answer)'), actions: parsed.actions,
        checks, skip, status: parsed.actions.length ? 'proposed' : null, raw,
      });
    } catch (e) {
      this.messages.splice(this.messages.indexOf(pending), 1);
      this.messages.push(e.name === 'AbortError' ? { role: 'error', text: 'Stopped.' } : { role: 'error', text: e.message || String(e), retry: text });
    } finally {
      clearInterval(tick);
      this.busy = false;
      this.abort = null;
      this.render();
      this.el.querySelector('.cp-input')?.focus();
    }
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
