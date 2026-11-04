import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { ConversationApplication } from '../../apps/observer/.test-dist/conversation/binding.js';
import { ConversationRecordingControls } from '../../apps/observer/.test-dist/conversation/Inspector.js';
import { installFrames } from '../web/frames.mjs';

const requireApp = createRequire(new URL('../../apps/observer/package.json', import.meta.url));
const { createElement } = requireApp('react');
const { renderToStaticMarkup } = requireApp('react-dom/server');
const info = { conversationId: 'conversation', transcriptId: 'transcript', mode: 'demo', model: 'fixture', admission: { conversationId: 'conversation', transcriptId: 'transcript', status: 'ready' } };
const ready = { status: 'ready', info, canSend: true, canForget: false };
const idle = { status: 'idle' };
const capture = (status = 'recording', recorderId = 'capture') => ({ status, recorderId });
const inspection = (recording = idle, calls = []) => ({ transcriptId: 'transcript', memories: { id: 'memories', sequence: 0, items: [] }, view: { revision: 0, sources: { messages: { id: 'transcript', scope: 'all' }, memories: { id: 'memories', scope: 'all' } }, members: [] }, recording: { ...recording, revision: 0, integrity: 'intact', calls, omitted: 0 } });
const detail = (id, recorderId = 'capture') => ({ recorderId, revision: 0, integrity: 'intact', root: { id, contextId: `context-${id}`, structureKind: 'scene', status: 'succeeded', childIds: [], value: { input: 'input', output: 'output', processes: [], relationChanges: [] } }, calls: [], resources: [], transcripts: [], memories: [], boundaries: [], truncated: false });

function setup(t, initial = idle, overrides = {}) {
  let disconnect;
  t.after(() => disconnect?.());
  const frames = installFrames(t);
  const listeners = new Set();
  const session = {
    snapshot: { status: 'idle', canSend: false, canForget: false },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async initialize() {
      this.emit(ready);
    },
    stop() {},
    emit(value) {
      this.snapshot = value;
      for (const listener of listeners) listener();
    },
  };
  let current = initial;
  const counts = { inspection: 0, recovery: 0, start: 0, stop: 0, clear: 0, call: 0 };
  const transport = {
    async inspection() {
      counts.inspection++;
      return inspection(current);
    },
    async recoveries() {
      counts.recovery++;
      return [];
    },
    async call() {
      counts.call++;
      assert.fail('no selected detail expected');
    },
    async startRecording() {
      counts.start++;
      current = capture();
      return current;
    },
    async stopRecording(id) {
      counts.stop++;
      assert.equal(id, current.recorderId);
      current = capture('stopped', id);
      return current;
    },
    async clearRecording(id) {
      counts.clear++;
      assert.equal(id, current.recorderId);
      current = idle;
      return current;
    },
    ...overrides,
  };
  const application = new ConversationApplication(session, transport);
  disconnect = application.connect();
  return {
    application,
    session,
    transport,
    frames,
    counts,
    disconnect,
    setRecording(value) {
      current = value;
    },
  };
}

function controls(state) {
  const application = { transport: { startRecording() {}, stopRecording() {}, clearRecording() {} } };
  return renderToStaticMarkup(createElement(ConversationRecordingControls, { application, state: { session: ready, ...state } }));
}
function enabled(html, label) {
  const button = [...html.matchAll(/<button([^>]*)>(.*?)<\/button>/gu)].find((match) => match[2] === label);
  assert.ok(button, `button ${label} exists`);
  return !button[1].includes('disabled');
}

test('recording controls expose only commands valid for the actual capture state', () => {
  for (const [recording, expected] of [
    [idle, [true, false, false]],
    [capture(), [false, true, false]],
    [capture('stopping'), [false, false, false]],
    [capture('stopped'), [false, false, true]],
  ]) {
    const html = controls({ recording });
    assert.deepEqual(
      ['开始记录', '停止记录', '清空记录'].map((label) => enabled(html, label)),
      expected,
    );
  }
  assert.match(controls({ recording: capture('stopping') }), /等待已纳入的调用收尾/);
  assert.match(controls({ recording: capture('stopped') }), /清空后可以开始新的采集/);
  const disconnected = controls({ recording: idle, session: { ...ready, status: 'connecting' } });
  assert.equal(enabled(disconnected, '开始记录'), false);
  const unknown = controls({ recording: undefined });
  assert.equal(enabled(unknown, '开始记录'), false);
});

test('recording commands are deliberate, coalesced and target the observed capture identity', async (t) => {
  const started = Promise.withResolvers();
  let starts = 0;
  const f = setup(t, idle, {
    startRecording: async () => {
      starts++;
      return started.promise;
    },
  });
  await f.frames.flush();
  assert.equal(starts, 0);
  const command = f.application.changeRecording('start');
  await f.application.changeRecording('start');
  await f.application.changeRecording('stop');
  assert.equal(starts, 1);
  assert.equal(f.application.snapshot().recordingPending, 'start');
  f.setRecording(capture());
  started.resolve(capture());
  await command;
  assert.equal(f.application.snapshot().recording.status, 'recording');
  await f.application.changeRecording('clear');
  assert.equal(f.counts.clear, 0, 'active capture cannot be cleared');
  await f.application.changeRecording('stop');
  assert.equal(f.counts.stop, 1);
  await f.application.changeRecording('clear');
  assert.equal(f.counts.clear, 1);
  assert.equal(f.application.snapshot().recording.status, 'idle');
  assert.equal(f.application.snapshot().recording.recorderId, undefined);
  assert.equal(f.counts.recovery, 1, 'recording control never queries CP');
});

test('stop keeps draining capture non-clearable until actual completion refresh', async (t) => {
  const f = setup(t, capture(), {
    stopRecording: async (id) => {
      assert.equal(id, 'capture');
      f.setRecording(capture('stopping'));
      return capture('stopping');
    },
  });
  await f.frames.flush();
  f.session.emit({ ...ready, canSend: false, submission: { id: 'active', feedback: { status: 'following' } } });
  await f.application.changeRecording('stop');
  assert.equal(f.application.snapshot().recording.status, 'stopping');
  await f.application.changeRecording('clear');
  await f.application.changeRecording('start');
  assert.equal(f.counts.clear, 0);
  assert.equal(f.counts.start, 0);
  f.setRecording(capture('stopped'));
  f.session.emit({ ...ready, submission: { id: 'active', feedback: { status: 'ended' }, remote: { result: { status: 'completed' } } } });
  await f.frames.flush();
  assert.equal(f.application.snapshot().recording.status, 'stopped');
  assert.equal(f.counts.recovery, 1);
});

test('ordinary submission completion refreshes analysis without enabling recording or scanning CP', async (t) => {
  const f = setup(t);
  await f.frames.flush();
  const initialReads = f.counts.inspection;
  f.session.emit({ ...ready, canSend: false, submission: { id: 'next', feedback: { status: 'following' } } });
  f.session.emit({ ...ready, submission: { id: 'next', feedback: { status: 'ended' }, remote: { result: { status: 'completed' } } } });
  await f.frames.flush();
  assert.equal(f.counts.inspection, initialReads + 1);
  assert.equal(f.counts.recovery, 1);
  assert.equal(f.counts.start, 0);
  assert.equal(f.application.snapshot().recording.status, 'idle');
});

test('clear prevents pre-command inspection and detail replies from reinstalling retained records', async (t) => {
  const oldInspection = Promise.withResolvers();
  const oldDetail = Promise.withResolvers();
  let inspectionSignal;
  let detailSignal;
  const f = setup(t, capture('stopped'));
  await f.frames.flush();
  f.transport.inspection = (signal) => {
    inspectionSignal = signal;
    return oldInspection.promise;
  };
  f.transport.call = (_id, signal) => {
    detailSignal = signal;
    return oldDetail.promise;
  };
  const previousInspection = f.application.refresh();
  const previousDetail = f.application.selectCall('old-call');
  f.transport.inspection = async () => inspection();
  await f.application.changeRecording('clear');
  assert.equal(inspectionSignal.aborted, true);
  assert.equal(detailSignal.aborted, true);
  oldInspection.resolve(inspection(capture('stopped'), [{ id: 'old-call' }]));
  oldDetail.resolve(detail('old-call'));
  await Promise.all([previousInspection, previousDetail]);
  assert.equal(f.application.snapshot().recording.status, 'idle');
  assert.deepEqual(f.application.snapshot().inspection.recording.calls, []);
  assert.equal(f.application.snapshot().detail, undefined);
  assert.equal(f.application.snapshot().selectedCall, undefined);
});

test('an in-flight clear does not permit new detail reads from the old capture', async (t) => {
  const cleared = Promise.withResolvers();
  const f = setup(t, capture('stopped'), { clearRecording: () => cleared.promise });
  await f.frames.flush();
  const clear = f.application.changeRecording('clear');
  await f.application.selectCall('old-call');
  assert.equal(f.counts.call, 0);
  f.setRecording(idle);
  cleared.resolve(idle);
  await clear;
  assert.equal(f.application.snapshot().detail, undefined);
});

test('lost control response refreshes actual state without retrying the mutation', async (t) => {
  let writes = 0;
  const f = setup(t, idle, {
    async startRecording() {
      writes++;
      f.setRecording(capture());
      throw new Error('response connection lost');
    },
  });
  await f.frames.flush();
  await f.application.changeRecording('start');
  assert.equal(writes, 1);
  assert.equal(f.application.snapshot().recording.status, 'recording', 'server read confirms the command may already have applied');
  assert.match(f.application.snapshot().recordingError, /response connection lost/);
  assert.equal(f.application.snapshot().recordingPending, undefined);
  await f.application.refresh();
  assert.equal(writes, 1);
});

test('same-identity reconnect discards pending command feedback and refreshes capture state', async (t) => {
  const oldCommand = Promise.withResolvers();
  let signal;
  const f = setup(t, idle, {
    startRecording: (value) => {
      signal = value;
      return oldCommand.promise;
    },
  });
  await f.frames.flush();
  const start = f.application.changeRecording('start');
  const before = f.counts.inspection;
  f.session.emit({ ...ready, status: 'connecting', canSend: false });
  assert.equal(signal.aborted, true);
  assert.equal(f.application.snapshot().recording, undefined);
  f.setRecording(capture('stopped', 'new-capture'));
  f.session.emit(ready);
  await f.frames.flush();
  assert.equal(f.counts.inspection, before + 1);
  oldCommand.resolve(capture('recording', 'obsolete-capture'));
  await start;
  assert.equal(f.application.snapshot().recording.recorderId, 'new-capture');
  assert.equal(f.application.snapshot().recordingPending, undefined);
});

test('unmount releases only local control consumption and ignores the late server reply', async (t) => {
  const pending = Promise.withResolvers();
  let signal;
  const f = setup(t, idle, {
    startRecording: (value) => {
      signal = value;
      return pending.promise;
    },
  });
  await f.frames.flush();
  const command = f.application.changeRecording('start');
  f.disconnect();
  const state = f.application.snapshot();
  assert.equal(signal.aborted, true);
  pending.resolve(capture());
  await command;
  await f.frames.flush();
  assert.equal(f.application.snapshot(), state);
});
