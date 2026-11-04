import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { ConversationApplication } from '../../apps/observer/.test-dist/conversation/binding.js';
import { ConversationMessages } from '../../apps/observer/.test-dist/conversation/messages.js';
import { ConversationCalls } from '../../apps/observer/.test-dist/conversation/calls.js';
import { ConversationRecoveryNotice } from '../../apps/observer/.test-dist/conversation/App.js';
import { installFrames } from '../web/frames.mjs';

const requireApp = createRequire(new URL('../../apps/observer/package.json', import.meta.url));
const { createElement } = requireApp('react');
const { renderToStaticMarkup } = requireApp('react-dom/server');
const render = (component, props) => renderToStaticMarkup(createElement(component, props));
const info = { conversationId: 'conversation', transcriptId: 'transcript', mode: 'demo', model: 'fixture', admission: { conversationId: 'conversation', transcriptId: 'transcript', status: 'ready' } };
const initial = { status: 'ready', info, canSend: true };

test('recovery notice distinguishes an eligible continuation from unavailable evidence and respects session admission', () => {
  const state = {
    session: { ...initial, canSend: false, canForget: true },
    recoveryStatus: 'ready',
    recoveries: [
      { contextId: 'eligible', point: 'answerWaiting', available: true },
      { contextId: 'changed', point: 'afterWaiting', available: false, reason: '内容已变化' },
    ],
    inspectionStatus: 'idle',
    detailStatus: 'idle',
  };
  const application = { snapshot: () => state, subscribe: () => () => {}, session: {}, transport: { recoveries: async () => [] } };
  const html = render(ConversationRecoveryNotice, { application, state });
  assert.match(html, /发现未完成的处理记录/);
  assert.match(html, /继续上次处理/);
  assert.match(html, /内容已变化/);
  assert.match(html, /请先结束旧提交的本地跟踪/);
  assert.match(html, /disabled=""[^>]*>继续上次处理/);
});
const inspection = (recorderId = 'recorder', calls = []) => ({ transcriptId: 'transcript', memories: { id: 'memories', sequence: 0, items: [] }, view: { revision: 0, sources: { messages: { id: 'transcript', scope: 'all' }, memories: { id: 'memories', scope: 'all' } }, members: [] }, recording: { recorderId, revision: 0, integrity: 'intact', calls, omitted: 0 } });
const call = (id, changes = []) => ({ id, contextId: `context-${id}`, structureKind: 'scene', status: 'succeeded', childIds: [], value: { input: 'input', output: 'output', processes: [], relationChanges: changes } });
const detail = (id, recorderId = 'recorder') => ({ recorderId, revision: 1, integrity: 'intact', root: call(id), calls: [], resources: [], transcripts: [], memories: [], boundaries: [], truncated: false });
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
function sessionFixture() {
  const listeners = new Set();
  return {
    snapshot: initial,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async initialize() {
      this.emit(this.snapshot);
    },
    stop() {},
    emit(snapshot) {
      this.snapshot = snapshot;
      for (const listener of listeners) listener();
    },
  };
}

test('conversation inspection is demand loaded, not reloaded for every preview delta', async (t) => {
  const frames = installFrames(t);
  const session = sessionFixture();
  let reads = 0;
  const application = new ConversationApplication(session, {
    inspection: async () => {
      reads++;
      return inspection();
    },
    call: async () => assert.fail('no detail request without a selection'),
  });
  const disconnect = application.connect();
  t.after(disconnect);
  await frames.flush();
  assert.equal(reads, 1);
  for (let i = 0; i < 40; i++) session.emit({ ...initial, submission: { id: 'submission', preview: { snapshot: { text: `text-${i}` } } } });
  await frames.flush();
  assert.equal(reads, 1);
  session.emit({ ...initial, submission: { id: 'submission', remote: { result: { status: 'completed' } } } });
  await frames.flush();
  assert.equal(reads, 2);
  session.emit(session.snapshot);
  await frames.flush();
  assert.equal(reads, 2);
});

test('obsolete inspection and selected call requests cannot overwrite current ownership', async (t) => {
  installFrames(t);
  const session = sessionFixture();
  const inspections = [];
  const details = [];
  const application = new ConversationApplication(session, {
    inspection(signal) {
      const request = { ...deferred(), signal };
      inspections.push(request);
      return request.promise;
    },
    call(id, signal) {
      const request = { ...deferred(), id, signal };
      details.push(request);
      return request.promise;
    },
  });
  const first = application.refresh();
  const second = application.refresh();
  assert.equal(inspections[0].signal.aborted, true);
  inspections[1].resolve(inspection('recorder', [{ id: 'a' }, { id: 'b' }]));
  await second;
  inspections[0].resolve(inspection('stale'));
  await first;
  assert.equal(application.snapshot().inspection.recording.recorderId, 'recorder');
  const a = application.selectCall('a');
  const b = application.selectCall('b');
  assert.equal(details[0].signal.aborted, true);
  details[1].resolve(detail('b'));
  await b;
  details[0].resolve(detail('a'));
  await a;
  assert.equal(application.snapshot().detail.root.id, 'b');
  const restarted = application.refresh();
  inspections[2].resolve(inspection('new-process'));
  await restarted;
  assert.equal(application.snapshot().detail, undefined);
  assert.equal(application.snapshot().selectedCall, undefined);
  assert.equal(details[1].signal.aborted, true);
});

test('unmount aborts inspection and ignores initialization failure from the previous connection', async (t) => {
  const frames = installFrames(t);
  const session = sessionFixture();
  const initialization = deferred();
  session.initialize = () => initialization.promise;
  const pending = deferred();
  let signal;
  const application = new ConversationApplication(session, {
    inspection: async (received) => {
      signal = received;
      return pending.promise;
    },
  });
  const disconnect = application.connect();
  session.emit(initial);
  disconnect();
  assert.equal(signal.aborted, true);
  initialization.reject(new Error('old connection'));
  pending.resolve(inspection());
  await frames.flush();
  assert.equal(application.snapshot().inspection, undefined);
  assert.equal(application.snapshot().actionError, undefined);
});

test('formal message identity replaces preview even when final text differs', () => {
  const submission = { id: 'submission', feedback: { status: 'following' }, preview: { status: 'live', snapshot: { text: '候选正文', state: 'streaming' } }, remote: { answer: { transcriptId: 'transcript', index: 1 } } };
  const before = { ...initial, transcript: { snapshot: { id: 'transcript', messages: [{ role: 'user', content: '问题' }] } }, submission };
  assert.match(render(ConversationMessages, { session: before }), /候选正文/);
  const after = { ...before, transcript: { snapshot: { id: 'transcript', messages: [...before.transcript.snapshot.messages, { role: 'assistant', content: '正式回答' }] } } };
  const html = render(ConversationMessages, { session: after });
  assert.match(html, /正式回答/);
  assert.doesNotMatch(html, /候选正文/);
  assert.doesNotMatch(html, /生成中 · 预览/);
  const discarded = { ...before, submission: { ...submission, preview: { ...submission.preview, snapshot: { text: '候选正文', state: 'discarded' } } } };
  assert.doesNotMatch(render(ConversationMessages, { session: discarded }), /候选正文/);
});

test('pending input disappears only once its formal input range is present', () => {
  const submission = { id: 'submission', pending: '问题', feedback: { status: 'following' }, remote: { input: { transcriptId: 'transcript', start: 0, end: 1 } } };
  assert.match(render(ConversationMessages, { session: { ...initial, submission } }), /等待正式接纳/);
  const html = render(ConversationMessages, { session: { ...initial, submission, transcript: { snapshot: { id: 'transcript', messages: [{ role: 'user', content: '问题' }] } } } });
  assert.doesNotMatch(html, /等待正式接纳/);
  assert.equal((html.match(/conversation-message user/g) ?? []).length, 1);
});

test('actual scene tree distinguishes a failed child from a handled parent reception', () => {
  const selected = detail('root');
  const failure = { code: 'model', message: 'model failure' };
  selected.root = {
    ...call('root', [
      { childId: 'child', identity: { childContextId: 'context-child' }, change: { kind: 'returned', result: { status: 'failed', error: failure } } },
      { childId: 'child', identity: { childContextId: 'context-child' }, change: { kind: 'handled', output: 'fallback' } },
    ]),
    childIds: ['child'],
  };
  selected.calls = [{ ...call('child'), parentId: 'root', structureKind: 'node', status: 'failed', name: '模型候选' }];
  const html = render(ConversationCalls, { detail: selected });
  assert.match(html, /模型候选/);
  assert.match(html, /失败/);
  assert.match(html, /异常已处理/);
  assert.match(html, /子层返回/);
  assert.doesNotMatch(html, /QA|Task/);
});
