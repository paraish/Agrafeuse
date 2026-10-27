// The assistant's language model: in this browser (WebLLM, opt-in download),
// or any server that speaks the OpenAI chat API (LM Studio, Ollama, OpenAI,
// OpenRouter, Gemini…). Both take OpenAI-style messages and return text.

export const WEBLLM_URL = 'https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@0.2.85/+esm';

// Small models that run well in a browser. gb = GPU memory they need (from WebLLM's catalogue).
export const WEBLLM_MODELS = [
  { id: 'Qwen3-4B-q4f16_1-MLC', label: 'Qwen3 4B (recommended)', gb: 3.4, license: 'Apache-2.0' },
  { id: 'Qwen3-1.7B-q4f16_1-MLC', label: 'Qwen3 1.7B (smaller and faster, less accurate)', gb: 2.0, license: 'Apache-2.0' },
  { id: 'Phi-4-mini-instruct-q4f16_1-MLC', label: 'Phi-4 mini', gb: 3.4, license: 'MIT' },
  { id: 'Qwen3-8B-q4f16_1-MLC', label: 'Qwen3 8B (best; needs a strong graphics card)', gb: 5.7, license: 'Apache-2.0' },
];

export const API_PRESETS = {
  lmstudio: {
    label: 'LM Studio (on this computer)', base: 'http://localhost:1234/v1', key: false, local: true,
    help: 'In LM Studio, open the Developer tab, load a model, start the server and turn on "Enable CORS". Your browser may ask to let this site reach apps on this computer: allow it.',
  },
  ollama: {
    label: 'Ollama (on this computer)', base: 'http://localhost:11434/v1', key: false, local: true,
    help: 'Start Ollama so that this site may call it, e.g. OLLAMA_ORIGINS="https://paraish.github.io" ollama serve, and pull a model (ollama pull qwen3:8b). Your browser may ask to let this site reach apps on this computer: allow it.',
  },
  openai: { label: 'OpenAI', base: 'https://api.openai.com/v1', key: true, help: 'An API key from platform.openai.com. Paid.' },
  openrouter: { label: 'OpenRouter (has free models)', base: 'https://openrouter.ai/api/v1', key: true, help: 'A key from openrouter.ai. Models whose name ends in ":free" cost nothing (with daily limits).' },
  gemini: { label: 'Google Gemini (free tier)', base: 'https://generativelanguage.googleapis.com/v1beta/openai', key: true, help: 'A key from aistudio.google.com. The free tier has daily limits, and Google may use what is sent to improve its products.' },
  custom: { label: 'Another OpenAI-compatible server', base: '', key: false, help: 'Any server with an OpenAI-style /chat/completions endpoint (add a key if it needs one).' },
};

// Whether a server address is on this computer (data then stays here).
export function isLocalUrl(url) {
  try {
    const host = new URL(url).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host.endsWith('.localhost');
  } catch {
    return false;
  }
}

// ---- in the browser ---------------------------------------------------------------------------

// Can this browser run a model on the graphics card (WebGPU)?
export async function webgpuStatus() {
  if (!globalThis.navigator?.gpu) return { ok: false, why: 'This browser has no WebGPU, which in-browser models need. Recent Chrome and Edge have it (Safari and Firefox are catching up). You can connect to LM Studio or another API instead.' };
  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return { ok: false, why: 'WebGPU is there, but no usable graphics card was found. You can connect to LM Studio or another API instead.' };
    return { ok: true };
  } catch (e) {
    return { ok: false, why: `WebGPU failed: ${e.message}` };
  }
}

export class WebLLMBackend {
  constructor(modelId) {
    this.modelId = modelId;
    this.kind = 'webllm';
    this.label = WEBLLM_MODELS.find((m) => m.id === modelId)?.label.replace(/ \(.*\)$/, '') || modelId;
  }

  // Downloads the model the first time (then the browser keeps it), and loads it.
  async load(onProgress) {
    const webllm = await import(WEBLLM_URL);
    const worker = new Worker(new URL('./webllm-worker.js', import.meta.url), { type: 'module' });
    this.engine = await webllm.CreateWebWorkerMLCEngine(worker, this.modelId, {
      initProgressCallback: (r) => onProgress?.(r.progress, r.text),
    });
  }

  async chat(messages, { signal, schema = REPLY_SCHEMA } = {}) {
    if (!this.engine) throw new Error('The model is not loaded.');
    const stop = () => this.engine.interruptGenerate();
    signal?.addEventListener('abort', stop);
    try {
      const res = await this.engine.chat.completions.create({
        messages,
        temperature: 0.2,
        max_tokens: 900,
        // Constrain the answer to the JSON shape the app reads.
        response_format: { type: 'json_object', schema: JSON.stringify(schema) },
        // Qwen3 models "think" at length first unless told not to.
        ...(this.modelId.startsWith('Qwen3') ? { extra_body: { enable_thinking: false } } : {}),
      });
      return res.choices?.[0]?.message?.content || '';
    } finally {
      signal?.removeEventListener('abort', stop);
    }
  }

  async unload() {
    try { await this.engine?.unload(); } catch { /* already gone */ }
    this.engine = null;
  }
}

// The shapes of the model's answers: actions for one step, or a plan.
export const REPLY_SCHEMA = {
  type: 'object',
  properties: {
    reply: { type: 'string' },
    actions: { type: 'array', items: { type: 'object' } },
  },
  required: ['reply', 'actions'],
};

// "thinking" comes first so the model reasons before it lists the steps.
export const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    thinking: { type: 'string' },
    plan: { type: 'array', items: { type: 'string' } },
    reply: { type: 'string' },
  },
  required: ['thinking', 'plan', 'reply'],
};

// ---- OpenAI-compatible servers --------------------------------------------------------------

export class OpenAIBackend {
  constructor({ base, key, model, preset }) {
    this.base = String(base || '').replace(/\/+$/, '');
    this.key = key || '';
    this.model = model || '';
    this.preset = preset;
    this.kind = 'api';
    this.label = `${this.model || 'model'} · ${API_PRESETS[preset]?.label.replace(/ \(.*\)$/, '') || new URL(this.base).host}`;
  }

  headers() {
    const h = { 'Content-Type': 'application/json' };
    if (this.key) h.Authorization = `Bearer ${this.key}`;
    return h;
  }

  // A clearer message than "Failed to fetch" when the server cannot be reached.
  unreachable(e) {
    if (e.name === 'AbortError') return e;
    const hint = API_PRESETS[this.preset]?.local
      ? ` Is the server running, with this site allowed (CORS)? ${API_PRESETS[this.preset].help}`
      : ' Check the address and your internet connection.';
    return new Error(`Could not reach ${this.base}.${hint}`);
  }

  async models() {
    let res;
    try {
      res = await fetch(`${this.base}/models`, { headers: this.headers() });
    } catch (e) {
      throw this.unreachable(e);
    }
    if (!res.ok) throw new Error(`${res.status}: ${(await res.text()).slice(0, 200)}`);
    const j = await res.json();
    return (j.data || j.models || []).map((m) => m.id || m.name).filter(Boolean).sort();
  }

  async chat(messages, { signal, schema = REPLY_SCHEMA } = {}) {
    const body = { model: this.model, messages, temperature: 0.2, max_tokens: 1500 };
    // Ask for JSON in the reply's shape where the server can enforce it (LM Studio,
    // Ollama, OpenAI…); servers that cannot are asked again without it.
    if (!this.noSchema) body.response_format = { type: 'json_schema', json_schema: { name: schema === PLAN_SCHEMA ? 'agrafeuse_plan' : 'agrafeuse_reply', schema } };
    let res;
    try {
      res = await fetch(`${this.base}/chat/completions`, { method: 'POST', headers: this.headers(), signal, body: JSON.stringify(body) });
    } catch (e) {
      throw this.unreachable(e);
    }
    const text = await res.text();
    if (!res.ok && body.response_format && res.status >= 400 && res.status < 500 && res.status !== 401 && res.status !== 403 && res.status !== 429) {
      this.noSchema = true;
      return this.chat(messages, { signal, schema });
    }
    if (!res.ok) {
      let msg = text;
      try { msg = JSON.parse(text).error?.message || JSON.parse(text)[0]?.error?.message || text; } catch { /* plain text */ }
      throw new Error(`The server answered ${res.status}: ${String(msg).slice(0, 300)}`);
    }
    const j = JSON.parse(text);
    return j.choices?.[0]?.message?.content || '';
  }

  async unload() {}
}
