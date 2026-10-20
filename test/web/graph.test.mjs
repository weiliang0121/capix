import test from 'node:test';
import assert from 'node:assert/strict';
import { projectCallGraph } from '../../apps/observer/.test-dist/binding/graph.js';
import { createObservationProjection } from '../../apps/observer/.test-dist/binding/observation.js';
import { snapshot } from '../client/fixtures.mjs';

function call(id, parentId, name = id, extra = {}) {
  return { id, contextId: `${id}-context`, recordType: 'group', parentId, name, label: name, source: '', status: 'succeeded', offsetMs: 0, durationMs: 1, ...extra };
}

function round(calls) {
  return { id: 'e', calls };
}

function detail(calls, relations = {}) {
  return {
    id: 'e',
    calls: new Map(calls.map((entry) => [entry.id, { ...entry, operation: entry.name, status: entry.status === 'succeeded' ? 'passed' : entry.status, processes: [], resources: [], memory: { incoming: [], changes: [] }, children: [], relationEntries: relations[entry.id] ?? [] }])),
  };
}

function relation(child, eventSequence, change = { kind: 'attached' }) {
  return { childId: child.id, identity: { parentContextId: `${child.parentId}-context`, childContextId: child.contextId, parentRound: 1 }, eventSequence, occurredAt: '2026-10-11T00:00:00Z', offsetMs: 0, change };
}

test('summary graph preserves supplied sibling order and readable identity independently of duration', () => {
  const e = call('e');
  const a = call('a', 'e', 'answer', { offsetMs: 90, durationMs: 1000 });
  const b = call('b', 'e', 'checkFileTask', { offsetMs: 0, durationMs: 0.01 });
  const graph = projectCallGraph(round([e, a, b]));
  assert.equal(graph.summaryOnly, true);
  assert.equal(graph.incomplete, false);
  assert.deepEqual(
    graph.roots[0].children.map((node) => node.id),
    ['a', 'b'],
  );
  assert.equal(graph.roots[0].children[1].durationMs, 0.01);
  assert.equal(graph.roots[0].children[1].order, undefined);
  assert.equal(graph.roots[0].children[1].summary, undefined);
  assert.equal(graph.roots[0].children[1].reception, undefined);
});

test('detail graph derives each local sequence from parent attachment facts and exposes R as an upstream link', () => {
  const r = call('r', undefined, 'runtime', { recordType: 'scene' });
  const e = call('e', 'r');
  const a = call('a', 'e');
  const b = call('b', 'e');
  const child = call('child', 'a', 'answer.invokeModel', { recordType: 'node' });
  const relations = { r: [relation(e, 1)], e: [relation(a, 8), relation(b, 3)], a: [relation(child, 2)] };
  const graph = projectCallGraph(round([e, a, child, b]), detail([r, e, a, child, b], relations));
  assert.equal(graph.summaryOnly, false);
  assert.equal(graph.incomplete, false);
  assert.equal(graph.runtimeId, 'r');
  assert.deepEqual(
    graph.roots.map((node) => node.id),
    ['e'],
  );
  assert.deepEqual(
    graph.roots[0].children.map((node) => [node.id, node.order]),
    [
      ['b', 1],
      ['a', 2],
    ],
  );
  assert.equal(graph.roots[0].children[1].children[0].order, 1);
});

test('successful child return remains distinct from parent acceptance and parent handling failure', () => {
  const e = call('e');
  const returned = call('returned', 'e');
  const accepted = call('accepted', 'e');
  const failed = call('failed', 'e');
  const calls = [e, returned, accepted, failed];
  const entries = [relation(returned, 1), relation(returned, 2, { kind: 'returned', result: { status: 'succeeded', output: {} } }), relation(accepted, 3), relation(accepted, 4, { kind: 'accepted', output: {} }), relation(failed, 5), relation(failed, 6, { kind: 'failed', source: 'work', error: { message: 'rejected' } })];
  const nodes = projectCallGraph(round(calls), detail(calls, { e: entries })).roots[0].children;
  assert.equal(nodes[0].reception.label, '已返回，待父层接纳');
  assert.equal(nodes[1].reception.label, '父层已接纳');
  assert.equal(nodes[2].reception.label, '父层接纳失败');
  assert.equal(nodes[2].status, 'succeeded', 'A parent handling failure does not rewrite a successful child call');
});

test('decision interpretation distinguishes a proposal from parent-requested revision without inventing reasons', () => {
  const e = call('e');
  const decision = call('decision', 'e', 'conversationDecision', { output: { kind: 'invoke', capability: 'save', arguments: {} } });
  const calls = [e, decision];
  const first = detail(calls, { e: [relation(decision, 1), relation(decision, 2, { kind: 'returned', result: { status: 'succeeded', output: decision.output } })] });
  assert.equal(projectCallGraph(round(calls), first).roots[0].children[0].summary, '提议：保存结果文件');
  const second = detail(calls, { e: [relation(decision, 1), relation(decision, 3, { kind: 'accepted', output: { kind: 'revise', feedback: { code: 'INVALID_DECISION', message: '保存前需要取得回答' } } })] });
  assert.equal(projectCallGraph(round(calls), second).roots[0].children[0].summary, '父层要求修正：保存前需要取得回答');
});

test('file preflight, generated content and a real receipt have separate summaries', () => {
  const e = call('e');
  const preflight = call('preflight', 'e', 'checkFileTask', { output: { kind: 'ready', task: { output: { path: 'a.md' } }, instruction: 'write' } });
  const answer = call('answer', 'e', 'answer', { output: { kind: 'answer', content: 'hello' } });
  const save = call('save', 'e', 'saveResult', { output: { path: 'a.md', bytes: 5, digest: 'digest' } });
  const unknown = call('unknown', 'e', 'thirdParty', { output: { path: 'a.md', bytes: 5, digest: 'digest' } });
  const calls = [e, preflight, answer, save, unknown];
  const entries = calls.slice(1).map((child, index) => relation(child, index + 1));
  const nodes = projectCallGraph(round(calls), detail(calls, { e: entries })).roots[0].children;
  assert.equal(nodes[0].summary, '预检通过 · 目标 a.md');
  assert.equal(nodes[1].summary, '已生成 5 字符');
  assert.equal(nodes[2].summary, '已创建 a.md · 5 字节');
  assert.equal(nodes[3].summary, undefined, 'Unknown business contracts remain generic');
});

test('missing parents, absent relation entries and cycles remain visible as incomplete data', () => {
  const e = call('e');
  const present = call('present', 'e');
  const absent = call('absent', 'e');
  const orphan = call('orphan', 'missing');
  const child = call('child', 'orphan');
  const cyclic = call('cycle', 'cycle');
  const calls = [e, present, absent, orphan, child, cyclic];
  const graph = projectCallGraph(round(calls), detail(calls, { e: [relation(present, 1)], orphan: [relation(child, 1)] }));
  assert.equal(graph.incomplete, true);
  assert.deepEqual(
    graph.roots[0].children.map((node) => node.id),
    ['present', 'absent'],
  );
  assert.equal(
    graph.roots[0].children.every((node) => node.order === undefined),
    true,
    'Partial sibling relation data does not claim a complete order',
  );
  assert.equal(graph.roots[0].children[1].incomplete, true);
  assert.deepEqual(
    graph.detached.map((node) => node.id),
    ['orphan', 'cycle'],
  );
  assert.deepEqual(
    graph.detached[0].children.map((node) => node.id),
    ['child'],
  );
  assert.equal(graph.detached[1].children.length, 0);
});

test('detail from another QA is not used and a missing E is not synthesized', () => {
  const orphan = call('o', 'e');
  const other = { ...detail([orphan]), id: 'other' };
  const graph = projectCallGraph(round([orphan]), other);
  assert.equal(graph.summaryOnly, true);
  assert.equal(graph.incomplete, true);
  assert.equal(graph.roots.length, 0);
  assert.equal(graph.detached[0].id, 'o');
});

test('a proposed clarification remains a proposal before the parent accepts and publishes it', () => {
  const e = call('e');
  const decision = call('decision', 'e', 'conversationDecision', { output: { kind: 'finish', conclusion: { kind: 'clarify', question: '保存到哪个文件？' } } });
  const calls = [e, decision];
  const graph = projectCallGraph(round(calls), detail(calls, { e: [relation(decision, 1), relation(decision, 2, { kind: 'returned', result: { status: 'succeeded', output: decision.output } })] }));
  assert.equal(graph.roots[0].children[0].summary, '提议补充：保存到哪个文件？');
  assert.equal(graph.roots[0].children[0].reception.status, 'returned');
});

function observedRound(calls) {
  return { id: 'e', startedAt: '2026-10-11T00:00:00Z', status: 'succeeded', inputIndex: 0, calls, selections: [], memoryChanges: [], availableMemoryIds: [] };
}

function observation(execution) {
  return { overview: { transcriptId: 'transcript', executions: [execution], messages: [] }, updates: new Map(), records: new Map(), memory: { items: [] }, transcriptRecords: [], loading: false };
}

test('unrelated feedback and transcript changes preserve graph map identity; call changes replace only affected graphs', () => {
  const project = createObservationProjection();
  const e = call('e');
  const original = observedRound([e]);
  const state = observation(original);
  const transcripts = new Map();
  const first = project(state, transcripts);
  const loading = project({ ...state, loading: true }, transcripts);
  assert.equal(loading.graphs, first.graphs, 'Connection state alone must not invalidate the graph selector');
  const content = project(state, new Map([['transcript', { snapshot: { messages: [{ role: 'user', content: '追加的正式原文' }] }, sync: { status: 'live' } }]]));
  assert.equal(content.graphs, first.graphs, 'Text availability changes a round summary, not the call graph');
  const next = project({ ...state, overview: { ...state.overview, executions: [{ ...original, calls: [e, call('child', 'e')] }] } }, transcripts);
  assert.notEqual(next.graphs, first.graphs);
  assert.equal(next.graphs.get('e').roots[0].children.length, 1);
  assert.equal(first.graphs.get('e').roots[0].children.length, 0, 'Published graph maps must not be mutated');
  const removed = project({ ...state, overview: { ...state.overview, executions: [] } }, transcripts);
  assert.equal(removed.graphs.size, 0);
  assert.equal(next.graphs.size, 1);
});

test('formal assistant append locates a clarification response without an answer operation', () => {
  const project = createObservationProjection();
  const recorded = snapshot('succeeded', 'e');
  recorded.execution.value.output = { kind: 'needs-info', content: '保存到哪个文件？' };
  const state = observation(observedRound([call('e')]));
  const transcript = {
    snapshot: {
      messages: [
        { role: 'user', content: '保存下来' },
        { role: 'assistant', content: '保存到哪个文件？' },
      ],
    },
    sync: { status: 'live' },
  };
  const transcripts = new Map([['transcript', transcript]]);
  const append = { id: 'append', transcriptId: 'transcript', callId: 'e', revision: 2, occurredAt: recorded.execution.value.startedAt, value: { action: 'append', start: 1, end: 2 } };
  const live = { ...state, updates: new Map([['e', recorded]]), transcriptRecords: [append] };
  const result = project(live, transcripts);
  assert.equal(recorded.calls.length, 1);
  assert.deepEqual(result.rounds[0].response, { index: 1, content: '保存到哪个文件？' });
  const noEvidence = createObservationProjection()({ ...live, transcriptRecords: [] }, transcripts);
  assert.equal(noEvidence.rounds[0].response, undefined, 'An E output or similar message text does not prove formal message ownership');
});
