// A stand-in for LM Studio / OpenAI in the tests: canned answers, and it keeps the last request.
import { createServer } from 'node:http';
export function startMock(port) {
  const state = { last: null, count: 0 };
  const reply = (text) => {
    if (/bar graph/i.test(text)) return { reply: 'A bar graph of weight by group, with Mann-Whitney comparisons (small groups).', actions: [
      { do: 'new_graph', template: 'bar_points', dataset: 'Plant growth (long)', x: 'group', y: 'weight', name: 'Weight bars' },
      { do: 'compare_groups', method: 'wilcox.test', comparisons: 'control', ref: 'Control' },
      { do: 'labels', y: 'Dry weight (g)' },
      { do: 'add_layer', geom: 'no_such_geom' },
    ] };
    if (/mean/i.test(text)) return { reply: 'Added to the pipeline of Plant growth.', actions: [
      { do: 'pipeline_step', table: 'Plant growth', step: { type: 'pivot_longer', cols: ['Control', 'Treatment 1', 'Treatment 2'] } },
      { do: 'pipeline_step', table: 'Plant growth', step: { type: 'group_by', columns: ['group'] } },
      { do: 'pipeline_step', table: 'Plant growth', step: { type: 'summarise', column: 'value', stats: ['mean', 'sd', 'n'] } },
    ] };
    return { reply: 'Use a one-way ANOVA: three independent groups of about normal values.', actions: [] };
  };
  const server = createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    if (req.url.endsWith('/models')) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ data: [{ id: 'mock-model' }, { id: 'other-model' }] })); return; }
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const j = JSON.parse(body || '{}');
      state.last = j; state.count++;
      const user = j.messages?.[j.messages.length - 1]?.content || '';
      const content = '```json\n' + JSON.stringify(reply(user)) + '\n```';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }));
    });
  });
  server.listen(port, '127.0.0.1');
  return { state, close: () => server.close() };
}
