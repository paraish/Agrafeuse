#!/usr/bin/env node
// Serve Plotbench locally and run its R code in your own R installation
// instead of webR. Useful for development, automated tests, or big datasets.
//
//   node dev/r-bridge.mjs            (needs R with ggplot2, dplyr, tidyr, jsonlite;
//                                      emmeans, lme4, lmerTest for some analyses)
//
// Options (environment variables): PORT (default 8787), R_SCRIPT (path to Rscript).
// Only listens on 127.0.0.1, and every request must carry the random token
// printed at start-up, so other websites cannot run code through it.
import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, stat, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, extname, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PORT = Number(process.env.PORT || 8787);
const TOKEN = process.env.PLOTBENCH_TOKEN || randomBytes(16).toString('hex');
const RSCRIPT = process.env.R_SCRIPT || 'Rscript';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.R': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.wasm': 'application/wasm',
  '.data': 'application/octet-stream', '.gz': 'application/octet-stream', '.so': 'application/octet-stream',
  '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
};

// ---- the R process ----------------------------------------------------------------------
const LOOP = `
con <- file("stdin", open = "r")
repeat {
  line <- readLines(con, n = 1, warn = FALSE)
  if (!length(line)) break
  code <- rawToChar(jsonlite::base64_dec(line))
  Encoding(code) <- "UTF-8"
  out <- tryCatch({
    v <- eval(parse(text = code, keep.source = FALSE, encoding = "UTF-8"), globalenv())
    if (is.character(v)) paste(v, collapse = "") else paste(utils::capture.output(print(v)), collapse = "\\n")
  }, error = function(e) paste0("\\u0001", conditionMessage(e)))
  cat("\\u0002", gsub("[\\r\\n]", "", jsonlite::base64_enc(charToRaw(enc2utf8(out)))), "\\u0003\\n", sep = "")
  flush(stdout())
}
`;

const dir = await mkdtemp(join(tmpdir(), 'plotbench-bridge-'));
await writeFile(join(dir, 'loop.R'), LOOP);
const R = spawn(RSCRIPT, ['--vanilla', join(dir, 'loop.R')], {
  stdio: ['pipe', 'pipe', 'inherit'],
  env: { ...process.env, LANG: process.env.LANG?.includes('UTF-8') ? process.env.LANG : 'C.UTF-8', LC_ALL: 'C.UTF-8' },
});
R.on('exit', (code) => { console.error(`R exited (${code})`); process.exit(1); });

let buffer = '';
let waiting = [];
R.stdout.setEncoding('utf8');
R.stdout.on('data', (chunk) => {
  buffer += chunk;
  let m;
  while ((m = /\u0002([A-Za-z0-9+/=\r\n]*)\u0003/.exec(buffer))) {
    buffer = buffer.slice(m.index + m[0].length);
    const text = Buffer.from(m[1], 'base64').toString('utf8');
    const next = waiting.shift();
    if (next) next(text);
  }
});

let chain = Promise.resolve();
function evalR(code) {
  const p = chain.then(() => new Promise((res) => {
    waiting.push(res);
    R.stdin.write(Buffer.from(code, 'utf8').toString('base64') + '\n');
  }));
  chain = p.catch(() => {});
  return p;
}

// ---- the web server ---------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    if (url.pathname === '/__r/eval') {
      const origin = req.headers.origin;
      if (req.method !== 'POST' || req.headers['x-plotbench-token'] !== TOKEN
        || (origin && origin !== `http://127.0.0.1:${PORT}` && origin !== `http://localhost:${PORT}`)) {
        res.writeHead(403); res.end('Forbidden'); return;
      }
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const out = await evalR(Buffer.concat(chunks).toString('utf8'));
      if (out.startsWith('\u0001')) { res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(out.slice(1)); return; }
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(out);
      return;
    }
    let path = decodeURIComponent(url.pathname);
    if (path.endsWith('/')) path += 'index.html';
    const file = resolve(ROOT, '.' + path);
    if (!file.startsWith(ROOT + sep)) { res.writeHead(403); res.end(); return; }
    const info = await stat(file).catch(() => null);
    if (!info || !info.isFile()) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(await readFile(file));
  } catch (e) {
    res.writeHead(500); res.end(String(e?.message || e));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Plotbench with native R: http://127.0.0.1:${PORT}/?engine=bridge&token=${TOKEN}`);
});
