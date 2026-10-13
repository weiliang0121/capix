import { ClientRuntime } from '@capix/client-runtime';
export function snapshot(status = 'succeeded', id = 'execution-1') {
  const failed = status === 'failed';
  const runtimeId = `runtime-call-${id}`;
  const startedAt = '2026-09-25T00:00:00.000Z';
  const endedAt = '2026-09-25T00:00:00.010Z';
  const result = status === 'running' ? {} : failed ? { error: { code: 'TEST', message: '测试失败' } } : { output: { kind: 'answer', content: '这是中文回答' } };
  const runtimeEvents = [{ id: `call-${runtimeId}`, parentId: runtimeId, scopeId: runtimeId, callId: runtimeId, sequence: 1, occurredAt: startedAt, offsetMs: 0, value: { type: 'call', scope: 'work' } }, ...(status === 'running' ? [] : [{ id: `end-${runtimeId}`, parentId: runtimeId, scopeId: runtimeId, callId: runtimeId, sequence: 2, occurredAt: endedAt, offsetMs: 12, value: { type: failed ? 'throw' : 'return', scope: 'work' } }])];
  const events = [{ id: `call-${id}`, parentId: id, scopeId: id, executionId: id, callId: id, sequence: 1, occurredAt: startedAt, offsetMs: 0, value: { type: 'call', scope: 'work' } }, ...(status === 'running' ? [] : [{ id: `end-${id}`, parentId: id, scopeId: id, executionId: id, callId: id, sequence: 2, occurredAt: endedAt, offsetMs: 10, value: { type: failed ? 'throw' : 'return', scope: 'work' } }])];
  return {
    runtimeCall: { id: runtimeId, parentId: 'runtime-root', contextId: `context-${runtimeId}`, runtimeInstanceId: 'runtime-instance', status, childIds: [runtimeEvents[0].id, id, ...runtimeEvents.slice(1).map((event) => event.id)], value: { startedAt, input: null, processes: [], relationChanges: [], ...result } },
    runtimeEvents,
    execution: { id, parentId: runtimeId, contextId: `context-${id}`, status, childIds: events.map((event) => event.id), value: { startedAt, input: { role: 'user', content: '你好，查看北京' }, processes: [], relationChanges: [], ...result } },
    operations: [],
    attempts: [],
    resources: [],
    events,
  };
}

export const conversationDescriptor = (id = 'fixture-conversation', transcriptId = 'fixture-transcript') => ({ id, title: '测试对话', transcriptId, createdAt: 1, updatedAt: 1 });
export const client = (options) => new ClientRuntime({ transcripts: options.conversation, ...options });
export const transcriptSnapshot = (messages = [], id = 'fixture-transcript', revision = messages.length) => ({ id, revision, start: 0, end: messages.length, starts: [0], messages });

export function transport(overrides = {}) {
  const io = {
    conversations: async () => ({ conversations: [conversationDescriptor()], defaultConversationId: 'fixture-conversation' }),
    conversation: async () => conversationDescriptor(),
    activeSubmission: async () => ({ conversationId: 'fixture-conversation', transcriptId: 'fixture-transcript' }),
    createConversation: async () => conversationDescriptor(),
    config: async () => ({ configured: true, model: 'fixture', contextBudget: 32768 }),
    admission: async () => ({ conversationId: 'fixture-conversation', transcriptId: 'fixture-transcript', status: 'ready' }),
    overview: async () => ({ transcriptId: 'fixture-transcript', executions: [], messages: [] }),
    transcript: async () => transcriptSnapshot(),
    memory: async () => ({ items: [] }),
    execution: async (_conversationId, id) => snapshot('succeeded', id),
    source: async (path) => ({ path, content: 'fixture source' }),
    observe: async (_accept, signal) => {
      if (signal.aborted) return;
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    },
    submit: async () => {
      throw new Error('Unexpected submission');
    },
    follow: async () => {
      throw new Error('Unexpected follow');
    },
    ...overrides,
  };
  const readTranscript = io.transcript;
  const transcriptListeners = new Set();
  let entity = transcriptSnapshot();
  io.transcript = async () => {
    const value = await readTranscript();
    const next = value.id ? value : transcriptSnapshot(value.messages);
    if (next.revision >= entity.revision) entity = next;
    return entity;
  };
  io.observeTranscript ??= async (id, accept, signal) => {
    const initial = await io.transcript();
    if (signal.aborted) return;
    accept({ type: 'baseline', snapshot: initial });
    transcriptListeners.add(accept);
    await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    transcriptListeners.delete(accept);
  };
  const append = (messages) => {
    const start = entity.end;
    entity = { ...entity, revision: entity.revision + 1, end: start + messages.length, messages: [...entity.messages, ...messages] };
    for (const accept of transcriptListeners) accept({ type: 'delta', event: { type: 'transcript', transcriptId: entity.id, revision: entity.revision, occurredAt: '2026-10-09T00:00:00Z', change: { kind: 'messages-appended', start, messages } } });
  };
  io.appendMessages = append;
  io.delivery = (request, receive) => submissionDelivery(request, receive, { append, transcript: () => entity });
  const watch = io.observe;
  io.observe = async (_conversationId, accept, signal) => {
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
    const initial = overrides.baseline ?? baseline({ overview: await io.overview(), memory: await io.memory(), transcript: { id: entity.id, revision: entity.revision, starts: entity.starts } });
    if (signal.aborted) return;
    accept(initial);
    ready = true;
    for (const value of queued) accept(convert(value));
    const error = await completion;
    if (error) throw error;
  };
  for (const name of ['submit', 'follow']) {
    const produce = io[name];
    io[name] = (request, receive, signal) => produce(request, (value) => receive(value.type ? value : { type: 'baseline', submission: value }), signal);
  }
  for (const name of ['read', 'cancel']) {
    const read = io[name];
    if (read)
      io[name] = async (...args) => {
        const value = await read(...args);
        return value.type ? value : { type: 'baseline', submission: value };
      };
  }
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

export function submissionSnapshot(id, patch = {}) {
  return { conversationId: 'fixture-conversation', submissionId: id, revision: 0, executions: [], integrity: { status: 'complete' }, ...patch };
}

/** Explicit test producer of submission changes, independent of optional entity delivery. */
export function submissionDelivery(request, receive, options = {}) {
  let current = submissionSnapshot(request.submissionId, { conversationId: request.conversationId });
  const publish = (patch, change = patch) => {
    const fromRevision = current.revision;
    current = { ...current, ...patch, revision: current.revision + 1 };
    receive(fromRevision === 0 ? { type: 'baseline', submission: current } : { type: 'submission', conversationId: current.conversationId, submissionId: current.submissionId, fromRevision, revision: current.revision, change });
    return current;
  };
  return {
    get snapshot() {
      return current;
    },
    input(range) {
      const entity = options.transcript?.() ?? transcriptSnapshot();
      options.append?.(request.input.messages);
      return publish({ input: range ?? { transcriptId: entity.id, start: entity.end, end: entity.end + request.input.messages.length } });
    },
    execution(contextId = 'context-execution-1') {
      return publish({ executions: [...current.executions, { contextId }] }, { executions: [{ contextId }] });
    },
    answer(content = '这是中文回答', index) {
      const entity = options.transcript?.();
      const position = index ?? entity?.end ?? current.input.end;
      options.append?.([{ role: 'assistant', content }]);
      return publish({ answer: { transcriptId: current.input.transcriptId, index: position } });
    },
    complete() {
      return publish({ result: { status: 'completed' }, admission: { conversationId: request.conversationId, transcriptId: current.input?.transcriptId ?? 'fixture-transcript', status: 'ready' } });
    },
    fail(code = 'TEST', message = '测试失败') {
      return publish({ result: { status: 'failed', error: { code, message } }, admission: { conversationId: request.conversationId, transcriptId: current.input?.transcriptId ?? 'fixture-transcript', status: 'ready' } });
    },
  };
}

export function entriesOf(value) {
  const snapshot = JSON.parse(JSON.stringify(value));
  return [{ kind: 'runtime-call', data: snapshot.runtimeCall }, ...snapshot.runtimeEvents.map((data) => ({ kind: 'invocation-boundary', data })), { kind: 'execution', data: snapshot.execution }, ...snapshot.operations.map((data) => ({ kind: 'operation', data })), ...snapshot.attempts.map((data) => ({ kind: 'attempt', data })), ...snapshot.events.map((data) => ({ kind: 'invocation-boundary', data })), ...snapshot.resources.map((data) => ({ kind: 'resource', data }))];
}
export function baseline(options = {}) {
  return { type: 'baseline', scopeId: 'fixture-scope', sequence: 0, overview: { transcriptId: 'fixture-transcript', messages: [], executions: [] }, memory: { items: [] }, transcript: { id: 'fixture-transcript', revision: 0, starts: [0] }, memories: { id: 'fixture-memories', sequence: 0 }, recorder: { id: 'fixture-recorder', revision: 0 }, entries: [], invocations: [], ...options };
}
