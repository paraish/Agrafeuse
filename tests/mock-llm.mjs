// A stand-in for LM Studio / OpenAI in the tests: canned answers, and it keeps the requests.
// It plans like the real assistant is asked to: first a plan (one step per
// request, or several for "multi…"), then the actions for each step.
import { createServer } from 'node:http';

export function startMock(port) {
  const state = { last: null, count: 0, log: [] };

  // The actions for one step (or one simple request).
  const act = (text) => {
    // Asked to fix its actions: fixes a wrong column; otherwise answers as before (a stubborn model).
    if (/^Some of your actions cannot be done/.test(text)) {
      if (!/mass/.test(text)) return act(state.step);
      return { reply: 'Fixed: the values are in weight.', actions: [
        { do: 'new_analysis', test: 'anova1', dataset: 'Plant growth (long)', y: 'weight', group: 'group' },
      ] };
    }
    state.step = text;
    // The multi-step plan below.
    if (/long version of Plant growth/.test(text)) return { reply: '', actions: [
      { do: 'new_transform', from: 'Plant growth', name: 'Plants long', steps: [{ type: 'pivot_longer', cols: ['Control', 'Treatment 1', 'Treatment 2'], names_to: 'treatment', values_to: 'mass' }] },
    ] };
    if (/Kruskal-Wallis test of mass/.test(text)) return { reply: '', actions: [
      { do: 'new_analysis', test: 'kruskal', dataset: 'Plants long', y: 'mass', group: 'treatment', name: 'Mass test' },
    ] };
    if (/box plot of mass/.test(text)) return { reply: '', actions: [
      { do: 'new_graph', template: 'box', dataset: 'Plants long', x: 'treatment', y: 'mass', name: 'Mass box plot' },
      { do: 'show_analysis', analysis: 'Mass test' },
    ] };
    if (/title to Plant mass/.test(text)) return { reply: '', actions: [{ do: 'labels', title: 'Plant mass' }] };
    if (/nothing to do here/.test(text)) return { reply: 'Nothing to do.', actions: [] };
    // Single requests.
    if (/ANOVA of mass/i.test(text)) return { reply: 'One-way ANOVA of mass.', actions: [
      { do: 'new_analysis', test: 'anova1', dataset: 'Plant growth (long)', y: 'mass', group: 'group' },
    ] };
    if (/sloppy/i.test(text)) return { reply: 'Box plot with Mann-Whitney.', actions: [
      { action: 'create_graph', data: 'plant growth long', type: 'box plot', x: 'Group', y: 'Weight' },
      { compare: { test: 'Mann Whitney' } },
      { do: 'set_labels', ylab: 'Weight (g)' },
    ] };
    if (/wide/i.test(text)) return { reply: 'Each column is a group.', actions: [
      { do: 'new_analysis', test: 'Kruskal-Wallis', dataset: 'Plant growth' },
      { do: 'new_graph', template: 'scatter_dot', dataset: 'Plant growth' },
      { do: 'compare_groups', method: 'wilcox.test' },
    ] };
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

  // The plan for a request.
  const plan = (text) => {
    if (/^multi/i.test(text)) return {
      thinking: 'The table has one column per treatment; the test and the box plot need it long, then the p values go on the graph.',
      plan: ['Make a long version of Plant growth with columns treatment and mass', 'Run a Kruskal-Wallis test of mass by treatment, named Mass test',
        'Make a box plot of mass by treatment with the Mass test p values', 'Set the graph title to Plant mass', 'Check: nothing to do here'],
      reply: 'Four steps: reshape, test, graph, title.',
    };
    if (/which test/i.test(text)) return { thinking: 'A question.', plan: [], reply: 'Use a one-way ANOVA: three independent groups of about normal values.' };
    return { thinking: 'One step.', plan: [text], reply: '' };
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
      // Like an older server: no structured output (the app must ask again without it).
      if (j.response_format) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: "'response_format.type' is not supported" } })); return; }
      state.last = j; state.count++; state.log.push(j);
      const system = j.messages?.[0]?.content || '';
      const user = j.messages?.[j.messages.length - 1]?.content || '';
      const step = /Now give the actions for step \d+ only: "([^"]*)"/.exec(user);
      const answer = /break the request into an ordered list/.test(system) ? plan(user) : act(step ? step[1] : user);
      const content = '```json\n' + JSON.stringify(answer) + '\n```';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }));
    });
  });
  server.listen(port, '127.0.0.1');
  return { state, close: () => server.close() };
}
