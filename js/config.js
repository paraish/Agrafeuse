// Where R comes from. Edit these to self-host webR (see README, "Running offline").
const params = new URLSearchParams(location.search);

// Overrides from the URL are only accepted as same-site paths (e.g. ?webr=/vendor/webr/),
// so a link can never make the app load code from another website.
function sameSite(value) {
  return value && /^\.?\/(?!\/)/.test(value) && !value.includes('..') ? value : null;
}

const override = sameSite(params.get('webr'));
const WEBR_VERSION = '0.6.0';

export const config = {
  // webR builds to try, in order: the official CDN, then the same release on jsDelivr.
  // `module` is the browser ES module inside `base`.
  webrSources: override
    ? [{ base: override, module: params.get('webr_module') === 'webr.js' ? 'webr.js' : 'webr.mjs' }]
    : [
      { base: `https://webr.r-wasm.org/v${WEBR_VERSION}/`, module: 'webr.mjs' },
      { base: `https://cdn.jsdelivr.net/npm/webr@${WEBR_VERSION}/dist/`, module: 'webr.js' },
    ],
  // Shown with the R version (unknown when self-hosted from ?webr=).
  webrVersion: override ? '' : WEBR_VERSION,
  // Repository of R packages compiled for webR.
  repoUrl: 'https://repo.r-wasm.org/',
  // 'webr' (default) or 'bridge' (native R through dev/r-bridge.mjs).
  engine: params.get('engine') === 'bridge' ? 'bridge' : 'webr',
  bridgeToken: params.get('token') || '',
};
