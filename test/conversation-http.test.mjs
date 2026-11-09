import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { createConversationWebHost } from '@capix/conversation-service/web';
import { ClientSubmission, ConversationSession } from '@capix/client-runtime';
import { SessionHttpTransport } from '@capix/client-http';
import { PersistenceError } from '@weiliang0121/capix-diagnostics';

const reply = (text) => ({ id: 'web-offline', model: 'fixture', formatVersion: 1, output: [{ kind: 'text', text: text }], native: { format: 'chat-completions', version: 1 }, termination: { kind: 'completed', reason: 'stop' }, usage: null });
function modelFixture({ answer, propose } = {}) {
  const requests = [];
  return {
    requests,
    async complete(request, controls = {}) {
      requests.push(request);
      const input = JSON.parse(request.messages.find((message) => message.role === 'user').content);
      if (request.responseFormat === 'text') {
        if (answer) return answer(input, controls);
        controls.emit?.('preview only');
        return reply(`Saved: ${input.query.content}`);
      }
      return propose ? propose(input, controls) : reply('{"changes":[]}');
    },
  };
}

async function fixture(t, model = modelFixture(), extra = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'capix-http-'));
  const database = join(directory, 'conversation.sqlite');
  const assets = join(directory, 'assets');
  await mkdir(assets);
  await writeFile(join(assets, 'conversation.html'), '<!doctype html><h1>Conversation</h1>');
  const host = createConversationWebHost({ database, model, modelName: 'fixture', mode: 'demo', assetsDirectory: assets, ...extra });
  host.server.listen(0, '127.0.0.1');
  await once(host.server, 'listening');
  const origin = `http://127.0.0.1:${host.server.address().port}`;
  const session = await (await fetch(origin + '/api/session')).json();
  t.after(async () => {
    await host.close();
    await rm(directory, { recursive: true, force: true });
  });
  const send = (path, body, options = {}) => fetch(origin + path, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body), ...options });
  const request = (input = 'hello', id = crypto.randomUUID()) => ({ conversationId: session.conversationId, submissionId: id, input: { messages: [{ role: 'user', content: input }] } });
  return { host, directory, database, origin, model, session, send, request, get: async (path) => (await fetch(origin + path)).json() };
}

async function frames(response) {
  assert.equal(response.status, 200);
  return (await response.text()).trim().split('\n').filter(Boolean).map(JSON.parse);
}
function validateFrames(session, request, received) {
  const client = ClientSubmission.attach({ conversationId: session.conversationId, submissionId: request.submissionId }, session.transcriptId);
  for (const frame of received) client.receiveFrame(frame);
  assert.notEqual(client.snapshot.preview?.status, 'failed');
  return client.snapshot;
}

function createGate(t) {
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  t.after(() => release.resolve());
  return { entered, release };
}

function browserSession(t, current, tracking) {
  const transport = new SessionHttpTransport(current.origin, (url, init) => fetch(url, { ...init, headers: { ...init?.headers, Origin: current.origin } }));
  const session = new ConversationSession(transport, tracking ? { tracking } : undefined);
  t.after(() => session.stop());
  return session;
}

function waitSession(session, predicate) {
  if (predicate(session.snapshot)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error('Session did not reach the expected state'));
    }, 5000);
    const unsubscribe = session.subscribe(() => {
      if (!predicate(session.snapshot)) return;
      clearTimeout(timer);
      unsubscribe();
      resolve();
    });
  });
}

test('browser host streams real content and exposes Scene records without replaying previews as messages', async (t) => {
  const gate = createGate(t);
  const model = modelFixture({
    answer: async (input, controls) => {
      gate.entered.resolve();
      await gate.release.promise;
      controls.emit('first');
      controls.emit(' second');
      return reply(`Saved: ${input.query.content}`);
    },
  });
  const current = await fixture(t, model);
  assert.equal((await current.send('/api/recording/start', {})).status, 200);
  const request = current.request();
  const response = await current.send('/api/run', request);
  await gate.entered.promise;
  const active = await current.get('/api/session');
  assert.equal(active.admission.status, 'busy');
  assert.equal(active.active.submission.submissionId, request.submissionId);
  gate.release.resolve();
  const received = await frames(response);
  assert.equal(received[0].type, 'baseline');
  const state = validateFrames(current.session, request, received);
  assert.equal(state.remote.result.status, 'completed');
  assert.equal(state.remote.input.start, 0);
  assert.equal(state.remote.answer.index, 1);
  assert.equal(state.preview.snapshot.state, 'committed');
  assert.equal(state.preview.snapshot.consistency, 'mismatch');
  const appended = received.filter((frame) => frame.type === 'answer' && frame.change.kind === 'appended');
  assert.deepEqual(
    appended.map((frame) => frame.change.text),
    ['first', ' second'],
  );
  assert.ok(
    appended.every((frame) => !('submission' in frame)),
    'each token carries a delta, not the accumulated call state',
  );
  const transcript = await current.get(`/api/transcript?id=${current.session.transcriptId}`);
  assert.deepEqual(transcript.messages, [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'Saved: hello' },
  ]);
  const inspection = await current.get('/api/inspection');
  assert.equal(inspection.recording.calls.length, 1);
  const root = inspection.recording.calls[0];
  const detail = await current.get(`/api/calls/${root.id}`);
  assert.equal(detail.root.structureKind, 'scene');
  assert.ok(detail.calls.some((call) => call.name === 'interaction-completion'));
  assert.ok(detail.transcripts.length >= 2);
  assert.ok(!JSON.stringify(detail).includes('first second'));
  assert.equal((await current.get('/api/session')).admission.status, 'ready');
});

test('disconnect, refresh and duplicate transport delivery follow one execution and never re-send the model', async (t) => {
  const gate = createGate(t);
  const current = await fixture(
    t,
    modelFixture({
      answer: async (_input, controls) => {
        gate.entered.resolve();
        controls.emit('before reconnect');
        await gate.release.promise;
        controls.emit(' after reconnect');
        return reply('one answer');
      },
    }),
  );
  const request = current.request();
  const controller = new AbortController();
  const response = await current.send('/api/run', request, { signal: controller.signal });
  await gate.entered.promise;
  controller.abort();
  await response.body.cancel().catch(() => {});
  const discovered = await current.get('/api/session');
  assert.equal(discovered.active.submission.submissionId, request.submissionId);
  assert.equal(discovered.active.preview.text, 'before reconnect');
  const duplicate = await current.send('/api/run', request);
  const reconnected = await fetch(current.origin + `/api/submissions/${request.submissionId}/follow`);
  gate.release.resolve();
  const received = await frames(reconnected);
  validateFrames(current.session, request, received);
  assert.equal(received[0].preview.text, 'before reconnect');
  assert.equal((await frames(duplicate)).at(-1).change.result.status, 'completed');
  assert.equal(current.model.requests.filter((request) => request.responseFormat === 'text').length, 1);
  assert.equal((await current.get(`/api/transcript?id=${current.session.transcriptId}`)).messages.length, 2);
  const conflict = await current.send('/api/run', current.request('different', request.submissionId));
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).code, 'SUBMISSION_EXISTS');
});

test('busy admission is a definite rejected submission, not an unknown disconnected request', async (t) => {
  const gate = createGate(t);
  const current = await fixture(
    t,
    modelFixture({
      answer: async () => {
        gate.entered.resolve();
        await gate.release.promise;
        return reply('done');
      },
    }),
  );
  const first = current.request();
  const response = await current.send('/api/run', first);
  await gate.entered.promise;
  const next = current.request('must not append');
  const rejected = await frames(await current.send('/api/run', next));
  const state = validateFrames(current.session, next, rejected);
  assert.equal(state.remote.result.status, 'rejected');
  assert.equal(state.remote.result.retry, 'admission');
  assert.equal(state.remote.input, undefined);
  assert.equal((await current.get(`/api/transcript?id=${current.session.transcriptId}`)).messages.length, 1);
  gate.release.resolve();
  await frames(response);
  assert.equal((await frames(await current.send('/api/run', next)))[0].submission.result.status, 'rejected');
});

test('explicit cancellation ends local delivery while late external feedback survives without appending an answer', async (t) => {
  const gate = createGate(t);
  const current = await fixture(
    t,
    modelFixture({
      answer: async (_input, controls) => {
        gate.entered.resolve();
        await gate.release.promise;
        controls.emit('late preview');
        return reply('late answer');
      },
    }),
  );
  assert.equal((await current.send('/api/recording/start', {})).status, 200);
  const request = current.request();
  const response = await current.send('/api/run', request);
  await gate.entered.promise;
  const cancellation = await current.send(`/api/submissions/${request.submissionId}/cancel`, {});
  assert.equal(cancellation.status, 200);
  assert.equal((await cancellation.json()).submission.cancelRequested, true);
  const received = await frames(response);
  const state = validateFrames(current.session, request, received);
  assert.equal(state.remote.result.status, 'cancelled');
  assert.equal(state.remote.answer, undefined);
  const before = await current.get('/api/inspection');
  gate.release.resolve();
  await current.host.close();
  assert.equal(current.model.requests.length, 1);
  // Reopen real persisted content without restoring any old submission or invocation.
  const reopened = createConversationWebHost({ database: current.database, model: modelFixture(), modelName: 'fixture', mode: 'demo' });
  reopened.server.listen(0, '127.0.0.1');
  await once(reopened.server, 'listening');
  const base = `http://127.0.0.1:${reopened.server.address().port}`;
  try {
    const snapshot = await (await fetch(base + `/api/transcript?id=${current.session.transcriptId}`)).json();
    assert.equal(snapshot.messages.length, 1);
    const unavailable = await fetch(base + `/api/submissions/${request.submissionId}`);
    assert.equal(unavailable.status, 404);
    assert.equal((await unavailable.json()).code, 'SUBMISSION_UNAVAILABLE');
    assert.equal(before.recording.calls.length, 1);
  } finally {
    await reopened.close();
  }
});

test('a required failure after answer append keeps the formal answer distinct from the failed submission', async (t) => {
  const current = await fixture(
    t,
    modelFixture({
      propose: () => {
        throw new PersistenceError('test.required', new Error('unavailable'));
      },
    }),
  );
  const request = current.request();
  const state = validateFrames(current.session, request, await frames(await current.send('/api/run', request)));
  assert.equal(state.remote.result.status, 'failed');
  assert.equal(state.remote.answer.index, 1);
  assert.equal(state.preview.snapshot.state, 'committed');
  const transcript = await current.get(`/api/transcript?id=${current.session.transcriptId}`);
  assert.equal(transcript.messages[1].content, 'Saved: hello');
  assert.equal((await current.get('/api/session')).admission.status, 'ready');
});

test('preview overflow is explicit and bounded while the full formal answer remains available', async (t) => {
  const current = await fixture(
    t,
    modelFixture({
      answer: (_input, controls) => {
        controls.emit('small');
        controls.emit('x'.repeat(300_000));
        return reply('actual answer');
      },
    }),
  );
  const request = current.request();
  const state = validateFrames(current.session, request, await frames(await current.send('/api/run', request)));
  assert.equal(state.remote.result.status, 'completed');
  assert.equal(state.preview.snapshot.state, 'discarded');
  assert.ok(state.preview.snapshot.text.length < 300_000);
  assert.equal((await current.get(`/api/transcript?id=${current.session.transcriptId}`)).messages[1].content, 'actual answer');
});

test('large preview deliveries remain coherent when stream backpressure replaces deltas with a baseline', async (t) => {
  const text = 'x'.repeat(64 * 1024);
  const current = await fixture(
    t,
    modelFixture({
      answer: (_input, controls) => {
        controls.emit(text);
        controls.emit(text);
        controls.emit(text);
        return reply(text.repeat(3));
      },
    }),
  );
  const request = current.request();
  const received = await frames(await current.send('/api/run', request));
  const state = validateFrames(current.session, request, received);
  assert.ok(received.filter((frame) => frame.type === 'baseline').length > 1, 'backpressure must exercise the authoritative baseline path');
  assert.equal(state.remote.result.status, 'completed');
  assert.equal(state.preview.snapshot.text, text.repeat(3));
  assert.equal(state.preview.snapshot.consistency, 'complete');
  assert.equal((await current.get(`/api/transcript?id=${current.session.transcriptId}`)).messages[1].content, text.repeat(3));
});

test('the message feed starts from a baseline, carries formal appends and releases its long connection on host shutdown', async (t) => {
  const current = await fixture(t);
  const response = await fetch(current.origin + `/api/transcript/observe?id=${current.session.transcriptId}`);
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  async function nextFrame() {
    for (;;) {
      const end = pending.indexOf('\n');
      if (end >= 0) {
        const line = pending.slice(0, end);
        pending = pending.slice(end + 1);
        return JSON.parse(line);
      }
      const part = await reader.read();
      assert.equal(part.done, false, 'feed must remain connected until the host closes');
      pending += decoder.decode(part.value, { stream: true });
    }
  }
  const baseline = await nextFrame();
  assert.equal(baseline.type, 'baseline');
  assert.equal(baseline.snapshot.messages.length, 0);
  await frames(await current.send('/api/run', current.request()));
  const user = await nextFrame();
  const assistant = await nextFrame();
  assert.equal(user.type, 'delta');
  assert.equal(user.event.change.messages[0].role, 'user');
  assert.equal(assistant.event.change.messages[0].content, 'Saved: hello');
  assert.equal(assistant.event.revision, user.event.revision + 1);
  await current.host.close();
  const closed = await reader.read().then(
    ({ done }) => done,
    () => true,
  );
  assert.equal(closed, true);
});

test('Transcript backpressure ends the connection and the real session reconnects without accepting a second baseline', async (t) => {
  const current = await fixture(t);
  let blockedResponse;
  const observed = [];
  current.host.server.prependListener('request', (request, response) => {
    if (!request.url?.startsWith('/api/transcript/observe')) return;
    const sent = [];
    observed.push(sent);
    const write = response.write.bind(response);
    response.write = (chunk, ...args) => {
      sent.push(JSON.parse(String(chunk)));
      const accepted = write(chunk, ...args);
      if (observed.length === 1) {
        // Hold the first writer's drain at the HTTP boundary, while using real
        // transport, TranscriptReceiver, Scene appends and persisted content.
        blockedResponse = response;
        return false;
      }
      return accepted;
    };
  });
  const transport = new SessionHttpTransport(current.origin, (url, init) => fetch(url, { ...init, headers: { ...init?.headers, Origin: current.origin } }));
  const session = new ConversationSession(transport);
  t.after(() => session.stop());
  await session.initialize();
  await session.send('hello');
  assert.equal(session.snapshot.submission.remote.result.status, 'completed');
  assert.equal(session.snapshot.transcript.snapshot.messages.length, 0);
  assert.equal(session.snapshot.canSend, false, 'formal answer body has not arrived on the blocked feed');
  assert.ok(blockedResponse);
  blockedResponse.emit('drain');
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error('Transcript did not reconnect from backpressure'));
    }, 5000);
    const unsubscribe = session.subscribe(() => {
      if (session.snapshot.transcript?.sync.status !== 'live' || session.snapshot.transcript.snapshot.messages.length !== 2) return;
      clearTimeout(timer);
      unsubscribe();
      resolve();
    });
  });
  assert.equal(session.snapshot.canSend, true);
  assert.equal(observed.length, 2);
  assert.deepEqual(
    observed[0].map((frame) => frame.type),
    ['baseline'],
  );
  assert.equal(observed[1][0].snapshot.messages.length, 2);
  assert.equal(current.model.requests.filter((request) => request.responseFormat === 'text').length, 1);
});

test('multiple real sessions recover busy rejection and stale tracking, then cancel only the discovered active submission', async (t) => {
  const gate = createGate(t);
  const current = await fixture(
    t,
    modelFixture({
      answer: async (input) => {
        if (input.query.content !== 'running') return reply('seed answer');
        gate.entered.resolve();
        await gate.release.promise;
        return reply('late answer');
      },
    }),
  );
  assert.equal((await current.send('/api/recording/start', {})).status, 200);
  const seed = current.request('seed');
  await frames(await current.send('/api/run', seed));
  const first = browserSession(t, current);
  const second = browserSession(t, current);
  await Promise.all([first.initialize(), second.initialize()]);
  const running = second.send('running');
  await gate.entered.promise;
  const activeId = second.snapshot.submission.id;
  await assert.rejects(first.send('must be rejected while busy'), /正在处理/);
  await waitSession(first, (state) => state.submission?.id === activeId);
  assert.equal(first.snapshot.canSend, false);
  let remembered = { conversationId: current.session.conversationId, transcriptId: current.session.transcriptId, submissionId: seed.submissionId };
  const restored = browserSession(t, current, {
    load: () => remembered,
    save: (value) => {
      remembered = value;
    },
  });
  await restored.initialize();
  await waitSession(restored, (state) => state.submission?.id === activeId);
  assert.equal(restored.snapshot.info.admission.status, 'busy');
  assert.equal(restored.snapshot.canSend, false);
  assert.equal(remembered.submissionId, activeId);
  await restored.cancel();
  await running;
  await Promise.all([first, second, restored].map((session) => waitSession(session, (state) => state.canSend)));
  for (const session of [first, second, restored]) {
    assert.equal(session.snapshot.submission.id, activeId);
    assert.equal(session.snapshot.submission.remote.result.status, 'cancelled');
    assert.equal(session.snapshot.transcript.snapshot.messages.length, 3);
  }
  const completed = await current.get(`/api/submissions/${seed.submissionId}`);
  assert.equal(completed.submission.result.status, 'completed', 'the old tracked result must not receive cancellation');
  assert.equal((await current.get('/api/inspection')).recording.calls.length, 2);
  assert.equal(current.model.requests.filter((request) => request.responseFormat === 'text').length, 2, 'busy rejection and reattachment never re-send');
  gate.release.resolve();
});

test('same-origin input and identity checks reject unsupported operations before model or content changes', async (t) => {
  const current = await fixture(t);
  for (const input of [{ messages: [{ role: 'user', content: 'x' }], contextBudget: 100 }, { messages: [{ role: 'assistant', content: 'x' }] }, { messages: [{ role: 'user', content: 'x' }], fileTask: {} }]) {
    const response = await current.send('/api/run', { ...current.request(), input });
    assert.equal(response.status, 400);
  }
  assert.equal((await current.send('/api/run', { ...current.request(), conversationId: 'wrong' })).status, 400);
  const remote = await current.send('/api/run', current.request(), { headers: { Origin: 'http://unrelated.test', 'Content-Type': 'application/json' } });
  assert.equal(remote.status, 403);
  assert.equal((await fetch(current.origin + '/api/conversation/admission?conversationId=wrong')).status, 404);
  assert.equal((await current.send('/api/run', current.request('x'.repeat(150_000)))).status, 413);
  assert.equal((await fetch(current.origin + '/')).status, 200);
  assert.equal((await fetch(current.origin + '/.env')).status, 404);
  assert.equal((await fetch(current.origin + '/assets/..%2F..%2F.env')).status, 404);
  assert.equal(current.model.requests.length, 0);
  assert.equal((await current.get(`/api/transcript?id=${current.session.transcriptId}`)).messages.length, 0);
});
