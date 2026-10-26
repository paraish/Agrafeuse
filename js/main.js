// Start-up: restore the last project, start R in the background, draw the app.
import { Store } from './store.js';
import { Engine } from './engine.js';
import { App } from './ui/app.js';

const store = new Store();
const engine = new Engine(() => store.project);
const app = new App(document.getElementById('app'), store, engine);
store.restore();
engine.start().catch(() => { /* shown in the status pill */ });

// Handy for debugging in the browser console.
window.plotbench = { store, engine, app };
