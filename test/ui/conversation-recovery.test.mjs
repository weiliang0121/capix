import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { ConversationSession, SubmissionUnavailableError } from '@capix/client-runtime';
import { ConversationApplication, canInspectRecoveries } from '../../apps/observer/.test-dist/conversation/binding.js';
import { ConversationRecoveryNotice } from '../../apps/observer/.test-dist/conversation/App.js';
import { installFrames } from '../web/frames.mjs';

const requireApp = createRequire(new URL('../../apps/observer/package.json', import.meta.url));
const { createElement } = requireApp('react');
const { renderToStaticMarkup } = requireApp('react-dom/server');
const identity = { conversationId: 'conversation', transcriptId: 'transcript' };
const info = { ...identity, mode: 'demo', model: 'fixture', admission: { ...identity, status: 'ready' } };
const transcript = { snapshot: { id: 'transcript', revision: 0, start: 0, end: 0, starts: [0], messages: [] }, sync: { status: 'live' } };
const ready = { status: 'ready', info, transcript, canSend: true, canForget: false };
const candidate = { contextId: 'unfinished', point: 'answerWaiting', available: true };
const inspection = { transcriptId: 'transcript', memories: { id: 'memories', sequence: 0, items: [] }, view: { revision: 0, sources: {}, members: [] }, recording: { recorderId: 'recorder', revision: 0, integrity: 'intact', calls: [], omitted: 0 } };
const deferred = () => Promise.withResolvers();

function setup(t, receive = async () => [candidate]) {
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
      this.emit({ ...ready, status: 'connecting', canSend: false });
    },
    stop() {},
    emit(snapshot) {
      this.snapshot = snapshot;
      for (const listener of listeners) listener();
    },
  };
  const reads = [];
  let inspectionValue = inspection;
  let inspections = 0;
  const application = new ConversationApplication(session, {
    inspection: async () => {
      inspections++;
      return inspectionValue;
    },
    call: async () => assert.fail('no detail without a selected call'),
    recoveries: (signal) => {
      reads.push(signal);
      return receive(signal);
    },
  });
  disconnect = application.connect();
  return {
    application,
    session,
    reads,
    frames,
    disconnect,
    setInspection(value) {
      inspectionValue = value;
    },
    get inspections() {
      return inspections;
    },
  };
}

test('recovery discovery waits for initialization and happens once, independently from inspection and preview refresh', async (t) => {
  const f = setup(t);
  await f.frames.flush();
  assert.equal(f.reads.length, 0, 'receiving service identity before initialization is not discovery');
  assert.equal(f.application.snapshot().recoveryStatus, 'idle');
  f.session.emit(ready);
  await f.frames.flush();
  assert.equal(f.reads.length, 1);
  assert.equal(f.application.snapshot().recoveryStatus, 'ready');
  assert.deepEqual(f.application.snapshot().recoveries, [candidate]);
  for (let i = 0; i < 20; i++) f.session.emit({ ...ready });
  await f.application.refresh();
  await f.frames.flush();
  assert.ok(f.inspections >= 2, 'normal inspection remains refreshable');
  assert.equal(f.reads.length, 1, 'inspection and unchanged ready publications do not scan checkpoints');
});

for (const changed of ['memory', 'view']) {
  test(`inspection reveals ${changed} changes and expires recovery candidates without scanning checkpoints`, async (t) => {
    const f = setup(t);
    f.session.emit(ready);
    await f.frames.flush();
    assert.equal(f.application.snapshot().recoveryStatus, 'ready');
    f.setInspection(changed === 'memory' ? { ...inspection, memories: { ...inspection.memories, sequence: 1 } } : { ...inspection, view: { ...inspection.view, revision: 1 } });
    await f.application.refresh();
    assert.equal(f.application.snapshot().recoveryStatus, 'stale');
    assert.equal(f.application.snapshot().recoveries, undefined);
    assert.equal(f.reads.length, 1, 'content inspection can invalidate but never revalidate CP eligibility');
    await f.application.refreshRecoveries();
    assert.equal(f.reads.length, 2);
    assert.equal(f.application.snapshot().recoveryStatus, 'ready');
  });
}

for (const status of ['completed', 'failed', 'cancelled']) {
  test(`a ${status} submission invalidates earlier recovery results without scanning again`, async (t) => {
    const f = setup(t);
    f.session.emit(ready);
    await f.frames.flush();
    const submitting = { ...ready, canSend: false, submission: { id: 'new', feedback: { status: 'following' } } };
    f.session.emit(submitting);
    assert.equal(f.application.snapshot().recoveryStatus, 'stale');
    for (let i = 0; i < 20; i++) f.session.emit({ ...submitting, submission: { ...submitting.submission, preview: { snapshot: { text: String(i) } } } });
    f.session.emit({ ...ready, submission: { id: 'new', remote: { result: { status } } } });
    await f.frames.flush();
    assert.equal(f.reads.length, 1);
    assert.equal(f.application.snapshot().recoveryStatus, 'stale');
    await f.application.refreshRecoveries();
    assert.equal(f.reads.length, 2, 'an explicit check still refreshes the result');
    assert.equal(f.application.snapshot().recoveryStatus, 'ready');
  });
}

test('busy initialization follows current work instead of querying recovery or scheduling a scan at settlement', async (t) => {
  const f = setup(t);
  const busy = { ...ready, info: { ...info, admission: { ...info.admission, status: 'busy' }, active: { submission: { submissionId: 'active' } } }, canSend: false, submission: { id: 'active', feedback: { status: 'following' } } };
  f.session.emit(busy);
  await f.frames.flush();
  assert.equal(f.reads.length, 0);
  await f.application.refreshRecoveries();
  assert.equal(f.reads.length, 0, 'known busy is not sent even by a local explicit check');
  f.session.emit({ ...ready, submission: { id: 'active', remote: { result: { status: 'completed' } } } });
  await f.frames.flush();
  assert.equal(f.reads.length, 0, 'settlement is not a second initialization');
  await f.application.refreshRecoveries();
  assert.equal(f.reads.length, 1);
});

for (const status of ['idle', 'connecting', 'following']) {
  test(`local submission ${status} blocks recovery queries even when the earlier host snapshot is ready`, async (t) => {
    const f = setup(t);
    const current = { ...ready, canSend: false, submission: { id: 'local', feedback: { status } } };
    f.session.emit(current);
    await f.frames.flush();
    assert.equal(canInspectRecoveries(current), false);
    assert.equal(f.reads.length, 0);
    await f.application.refreshRecoveries();
    assert.equal(f.reads.length, 0, 'local send/resume must not scan before host activity is reflected in info');
    const html = renderToStaticMarkup(createElement(ConversationRecoveryNotice, { application: f.application, state: f.application.snapshot() }));
    assert.match(html, /disabled=""[^>]*>检查可恢复处理/);
  });
}

test('initial local tracking that enters following consumes discovery eligibility before settlement', async (t) => {
  const f = setup(t);
  const current = { ...ready, canSend: false, submission: { id: 'tracked', feedback: { status: 'connecting' } } };
  f.session.emit(current);
  await f.frames.flush();
  assert.equal(f.reads.length, 0);
  f.session.emit({ ...current, submission: { ...current.submission, feedback: { status: 'following' } } });
  await f.frames.flush();
  assert.equal(f.reads.length, 0, 'follow the original submission instead of discovering old checkpoints');
  f.session.emit({ ...ready, submission: { id: 'tracked', remote: { result: { status: 'completed' } } } });
  await f.frames.flush();
  assert.equal(f.reads.length, 0, 'a followed submission settling is not a new opening');
  await f.application.refreshRecoveries();
  assert.equal(f.reads.length, 1, 'explicit inspection remains possible after the followed work settles');
});

test('resuming local follow invalidates an unknown-tracking recovery check without changing submission identity', async (t) => {
  const f = setup(t);
  const unknown = { ...ready, canSend: false, canForget: true, submission: { id: 'tracked', feedback: { status: 'unavailable' } } };
  f.session.emit(unknown);
  await f.frames.flush();
  assert.equal(f.reads.length, 1);
  assert.equal(f.application.snapshot().recoveryStatus, 'ready');
  f.session.emit({ ...unknown, canForget: false, submission: { ...unknown.submission, feedback: { status: 'following' } } });
  await f.frames.flush();
  assert.equal(f.application.snapshot().recoveryStatus, 'stale');
  assert.equal(f.application.snapshot().recoveries, undefined);
  await f.application.refreshRecoveries();
  assert.equal(f.reads.length, 1, 'same-ID live tracking closes the read-only inspection window');
});

test('same-identity reconnection discovers once and late replies from the prior connection cannot overwrite it', async (t) => {
  const requests = [];
  const f = setup(t, () => {
    const request = deferred();
    requests.push(request);
    return request.promise;
  });
  f.session.emit(ready);
  assert.equal(requests.length, 1);
  f.session.emit({ ...ready, status: 'connecting', canSend: false });
  assert.equal(f.reads[0].aborted, true);
  f.session.emit(ready);
  assert.equal(requests.length, 2);
  requests[1].resolve([{ ...candidate, contextId: 'new-process' }]);
  await f.frames.flush();
  requests[0].resolve([{ ...candidate, contextId: 'old-process' }]);
  await f.frames.flush();
  assert.equal(f.application.snapshot().recoveryStatus, 'ready');
  assert.equal(f.application.snapshot().recoveries[0].contextId, 'new-process');
});

for (const changed of ['submission', 'transcript']) {
  test(`a ${changed} change invalidates an in-flight discovery without starting another query`, async (t) => {
    const response = deferred();
    const f = setup(t, () => response.promise);
    f.session.emit(ready);
    assert.equal(f.reads.length, 1);
    const state = changed === 'submission' ? { ...ready, canSend: false, submission: { id: 'new', feedback: { status: 'following' } } } : { ...ready, transcript: { ...transcript, snapshot: { ...transcript.snapshot, revision: 1, end: 1, messages: [{ role: 'user', content: 'new formal content' }] } } };
    f.session.emit(state);
    assert.equal(f.reads[0].aborted, true);
    response.resolve([candidate]);
    await f.frames.flush();
    assert.equal(f.reads.length, 1);
    assert.equal(f.application.snapshot().recoveryStatus, 'stale');
    assert.notDeepEqual(f.application.snapshot().recoveries, [candidate]);
  });
}

test('recovery loading coalesces repeated checks and a failed check is distinct from an empty result', async (t) => {
  const response = deferred();
  let fail = true;
  const f = setup(t, () => (fail ? response.promise : Promise.resolve([])));
  f.session.emit(ready);
  assert.equal(f.application.snapshot().recoveryStatus, 'loading');
  const repeated = f.application.refreshRecoveries();
  assert.equal(f.reads.length, 1);
  response.reject(new Error('recovery service unavailable'));
  await repeated;
  await f.frames.flush();
  assert.equal(f.application.snapshot().recoveryStatus, 'failed');
  assert.match(f.application.snapshot().recoveryError, /recovery service unavailable/);
  assert.equal(f.application.snapshot().recoveries, undefined);
  fail = false;
  await f.application.refreshRecoveries();
  assert.equal(f.reads.length, 2);
  assert.equal(f.application.snapshot().recoveryStatus, 'ready');
  assert.deepEqual(f.application.snapshot().recoveries, []);
  assert.equal(f.application.snapshot().recoveryError, undefined);
});

test('unmount aborts recovery consumption and ignores its late failure', async (t) => {
  const response = deferred();
  const f = setup(t, () => response.promise);
  f.session.emit(ready);
  f.disconnect();
  assert.equal(f.reads[0].aborted, true);
  const closed = f.application.snapshot();
  response.reject(new Error('late failure'));
  await f.frames.flush();
  assert.equal(f.application.snapshot(), closed);
});

test('actual session unknown tracking permits read-only discovery but not checkpoint resume', async (t) => {
  let disconnect;
  t.after(() => disconnect?.());
  const frames = installFrames(t);
  const baseline = deferred();
  const tracked = deferred();
  let discovered = 0;
  let resumes = 0;
  let locator = { ...identity, submissionId: 'old-submission' };
  const transport = {
    session: async () => info,
    observeTranscript: async (_id, receive, signal) => {
      await baseline.promise;
      if (signal.aborted) return;
      receive({ type: 'baseline', snapshot: transcript.snapshot });
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    },
    read: () => tracked.promise,
    follow: async () => assert.fail('unknown submission cannot be followed'),
    resume: async () => {
      resumes++;
    },
    inspection: async () => inspection,
    recoveries: async () => {
      discovered++;
      return [candidate];
    },
  };
  const session = new ConversationSession(transport, {
    tracking: {
      load: () => locator,
      save: (value) => {
        locator = value;
      },
    },
  });
  const application = new ConversationApplication(session, transport);
  disconnect = application.connect();
  await frames.flush();
  assert.equal(session.snapshot.status, 'connecting');
  assert.equal(discovered, 0, 'service identity alone is insufficient');
  baseline.resolve();
  await frames.flush();
  assert.equal(session.snapshot.status, 'ready');
  assert.equal(session.snapshot.submission.feedback.status, 'connecting');
  assert.equal(session.snapshot.canSend, false);
  assert.equal(session.snapshot.canForget, false);
  assert.equal(discovered, 0, 'ready session waits until tracked submission discovery has a result');
  await application.refreshRecoveries();
  assert.equal(discovered, 0, 'manual recovery inspection also waits for unresolved tracking');
  tracked.reject(new SubmissionUnavailableError('process no longer retains the old submission'));
  await frames.flush();
  assert.equal(session.snapshot.submission.feedback.status, 'unavailable');
  assert.equal(session.snapshot.canSend, false);
  assert.equal(session.snapshot.canForget, true);
  assert.equal(discovered, 1);
  assert.equal(application.snapshot().recoveryStatus, 'ready');
  await frames.flush();
  assert.equal(discovered, 1, 'unavailable tracking opens read-only discovery just once');
  assert.equal(locator.submissionId, 'old-submission');
  await assert.rejects(session.resume(candidate.contextId), /尚不可恢复/);
  assert.equal(resumes, 0);
});

test('recovery presentation keeps stale candidates non-actionable and distinguishes unchecked from checked-empty', () => {
  const session = { ...ready };
  const application = { session: {}, transport: { recoveries() {} } };
  const render = (state) => renderToStaticMarkup(createElement(ConversationRecoveryNotice, { application, state: { session, inspectionStatus: 'idle', detailStatus: 'idle', ...state } }));
  const unchecked = render({ recoveryStatus: 'idle' });
  const empty = render({ recoveryStatus: 'ready', recoveries: [] });
  const stale = render({ recoveryStatus: 'stale', recoveries: [candidate] });
  assert.notEqual(unchecked, empty);
  assert.match(unchecked, /检查/);
  assert.doesNotMatch(stale, />继续上次处理</);
  assert.match(stale, /过期|变化|重新检查/);
  assert.equal(renderToStaticMarkup(createElement(ConversationRecoveryNotice, { application: { ...application, transport: {} }, state: { session, recoveryStatus: 'idle' } })), '');
});
