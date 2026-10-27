// Runs the in-browser language model (WebLLM) off the main thread, so the app
// stays responsive while it thinks. Loaded only after the user opts in.
import { WebWorkerMLCEngineHandler } from 'https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@0.2.85/+esm';

const handler = new WebWorkerMLCEngineHandler();
self.onmessage = (msg) => handler.onmessage(msg);
