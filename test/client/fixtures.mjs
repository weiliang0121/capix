import { observeTranscript } from '@capix-observer/runtime';
export function snapshot(status = 'succeeded', id = 'execution-1') {
  const failed = status === 'failed';
  return {
    execution: { id, contextId: `context-${id}`, status, value: { startedAt: '2026-09-25T00:00:00.000Z', settings: {}, input: { role: 'user', content: '你好，查看北京' }, processes: [], ...(status === 'running' ? {} : failed ? { error: { code: 'TEST', message: '测试失败' } } : { output: { kind: 'answer', content: '这是中文回答' } }) } },
    operations: [],
    attempts: [],
    events: [{ id: `call-${id}`, executionId: id, callId: id, sequence: 1, occurredAt: '2026-09-25T00:00:00.000Z', offsetMs: 0, value: { type: 'call' } }, ...(status === 'running' ? [] : [{ id: `end-${id}`, executionId: id, callId: id, sequence: 2, occurredAt: '2026-09-25T00:00:00.010Z', offsetMs: 10, value: { type: failed ? 'throw' : 'return' } }])],
  };
}

export function transport(overrides = {}) {
  const io = {
    config: async () => ({ configured: true, model: 'fixture', contextBudget: 32768 }),
    overview: async () => ({ executions: [], messages: [] }),
    transcript: async () => ({ messages: [] }),
    memory: async () => ({ items: [] }),
    execution: async (id) => snapshot('succeeded', id),
    source: async (path) => ({ path, content: 'fixture source' }),
    observe: async (_accept, signal) => {
      if (signal.aborted) return;
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    },
    run: async () => {
      throw new Error('Unexpected submission');
    },
    ...overrides,
  };
  const watch = io.observe;
  io.observe = async (accept, signal) => {
    let ready = false;
    const queued = [];
    const emit = (value) => {
      if (ready) accept(convert(value));
      else queued.push(value);
    };
    let sequence = 0;
    let revision = 0;
    const convert = (value) => {
      if (value.type) return value;
      const entries = entriesOf(value);
      return { type: 'delta', scopeId: 'fixture-scope', sequence: ++sequence, changes: entries.map((entry) => ({ type: 'record', recorderId: 'fixture-recorder', revision: ++revision, occurredAt: '2026-09-30T00:00:00Z', change: { kind: 'replaced', entry } })) };
    };
    const work = watch(emit, signal);
    // Attach a rejection handler while the independently loaded baseline is pending.
    const completion = work.then(
      () => undefined,
      (error) => error,
    );
    const initial = overrides.baseline ?? baseline({ overview: await io.overview(), memory: await io.memory() });
    if (signal.aborted) return;
    accept(initial);
    ready = true;
    for (const value of queued) accept(convert(value));
    const error = await completion;
    if (error) throw error;
  };
  return io;
}
export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

export function deliverAnswer(receive, inputIndex = 0, contextId = 'context-execution-1', content = '这是中文回答') {
  receive({ type: 'started', contextId, inputIndex });
  receive({ type: 'answer', contextId, index: inputIndex + 1, output: { kind: 'answer', content } });
  receive({ type: 'completed', contextId });
}

export function entriesOf(value) {
  const snapshot = JSON.parse(JSON.stringify(value, observeTranscript));
  return [{ kind: 'execution', data: snapshot.execution }, ...snapshot.operations.map((data) => ({ kind: 'operation', data })), ...snapshot.attempts.map((data) => ({ kind: 'attempt', data })), ...snapshot.events.map((data) => ({ kind: 'invocation-boundary', data }))];
}
export function baseline(options = {}) {
  return { type: 'baseline', scopeId: 'fixture-scope', sequence: 0, overview: { messages: [], executions: [] }, memory: { items: [] }, transcript: { id: 'fixture-transcript', revision: 0, starts: [0] }, memories: { id: 'fixture-memories', sequence: 0 }, recorder: { id: 'fixture-recorder', revision: 0 }, entries: [], invocations: [], ...options };
}
