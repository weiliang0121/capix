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
  return {
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
