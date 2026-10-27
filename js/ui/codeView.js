// The whole project as one R script.
import { h, fill, download, safeFilename } from './dom.js';
import { button, checkbox, codeBlock, toast } from './widgets.js';
import { projectScript } from '../codegen/script.js';

export class CodeView {
  constructor(app) {
    this.app = app;
    this.includeHelpers = true;
    this.el = h('div.view.code-view');
    this.render();
  }

  destroy() {}

  onChange() { this.render(); }

  script() {
    return projectScript(this.app.store.project, { helpers: this.app.engine.helpers || '# (helpers load when R starts)', schemaOf: this.app.engine.schemaOf, includeHelpers: this.includeHelpers, mixedEngine: this.app.engine.mixedChoice || 'lme4', versions: this.app.engine.versions });
  }

  render() {
    const code = this.script();
    fill(this.el, 
      h('div.item-head', h('div.kind', 'R code'), h('h2.title', 'The whole project as an R script'), h('div.head-actions',
        button('Copy', () => navigator.clipboard.writeText(this.script()).then(() => toast('Copied the script.')), { iconName: 'copy' }),
        button('Download .R', () => download(this.script(), safeFilename(this.app.store.project.name, 'R'), 'text/plain'), { iconName: 'download', kind: 'primary' }))),
      h('p.lead', 'Run this in R or RStudio to recreate every table, analysis and graph. It is the same code Agrafeuse runs in your browser, so results match.'),
      h('div.toolbar', checkbox(this.includeHelpers, 'Include the Agrafeuse helper functions (ag_…) so the script runs on its own', (v) => { this.includeHelpers = v; this.render(); })),
      codeBlock(code));
  }
}
