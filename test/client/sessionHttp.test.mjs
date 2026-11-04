import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionHttpTransport, HttpTransportError } from '@capix/client-http';
import { ConversationSession, SessionConnectionError, SubmissionUnavailableError } from '@capix/client-runtime';
import { createConversationWebHost } from '@capix/conversation-service/web';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { snapshot } from './fixtures.mjs';

const identity = { conversationId: 'conversation', transcriptId: 'transcript' };
const info = { ...identity, mode: 'demo', model: 'offline', admission: { ...identity, status: 'ready' } };
const baseline = { type: 'baseline', submission: { conversationId: identity.conversationId, submissionId: 'submission', revision: 1, executions: [], integrity: { status: 'complete' } } };
const signal = () => new AbortController().signal;
const stream = (frames) => new Response(frames.map((frame) => JSON.stringify(frame)).join('\n'));

test('recording HTTP controls validate capture identities and state-specific results', async () => {
  const calls = [];
  let state = { status: 'recording', recorderId: 'capture' };
  const transport = new SessionHttpTransport('', async (path, init) => {
    calls.push({ path, init });
    return Response.json(state);
  });
  assert.deepEqual(await transport.recording(), state);
  assert.deepEqual(await transport.startRecording(), state);
  state = { status: 'stopping', recorderId: 'capture' };
  assert.deepEqual(await transport.stopRecording('capture'), state);
  state = { status: 'idle' };
  assert.deepEqual(await transport.clearRecording('capture'), state);
  assert.deepEqual(
    calls.map(({ path }) => path),
    ['/api/recording', '/api/recording/start', '/api/recording/stop', '/api/recording/clear'],
  );
  assert.deepEqual(
    calls.slice(1).map(({ init }) => JSON.parse(init.body)),
    [{}, { recorderId: 'capture' }, { recorderId: 'capture' }],
  );
  for (const invalid of [{ status: 'idle', recorderId: 'capture' }, { status: 'stopped' }, { status: 'stopping', recorderId: '' }, { status: 'unexpected' }, { status: 'recording', recorderId: 'capture', extra: true }]) {
    await assert.rejects(new SessionHttpTransport('', async () => Response.json(invalid)).recording(), HttpTransportError);
  }
  for (const invalid of [{ status: 'stopped', recorderId: 'other' }, { status: 'recording', recorderId: 'capture' }, { status: 'idle' }]) {
    await assert.rejects(new SessionHttpTransport('', async () => Response.json(invalid)).stopRecording('capture'), HttpTransportError);
  }
  await assert.rejects(new SessionHttpTransport('', async () => Response.json({ status: 'stopped', recorderId: 'capture' })).startRecording(), HttpTransportError);
  await assert.rejects(new SessionHttpTransport('', async () => Response.json({ status: 'recording', recorderId: 'capture' })).clearRecording('capture'), HttpTransportError);
});

test('recovery HTTP validates candidates and uses the normal submission feedback receiver', async () => {
  const candidates = [{ contextId: 'context', point: 'answerWaiting', available: true }];
  const calls = [];
  const request = { conversationId: identity.conversationId, submissionId: 'submission', contextId: 'context' };
  const terminal = { ...baseline, submission: { ...baseline.submission, result: { status: 'rejected', error: { code: 'RECOVERY_UNAVAILABLE', message: 'changed' } } } };
  const transport = new SessionHttpTransport('', async (path, init) => {
    calls.push({ path, init });
    return path === '/api/recoveries' ? Response.json(candidates) : stream([terminal]);
  });
  assert.deepEqual(await transport.recoveries(), candidates);
  const frames = [];
  await transport.resume(request, (frame) => frames.push(frame), signal());
  assert.equal(calls[1].path, '/api/resume');
  assert.deepEqual(JSON.parse(calls[1].init.body), request);
  assert.equal(frames[0].submission.result.status, 'rejected');
  for (const invalid of [[...candidates, ...candidates], [{ ...candidates[0], available: 'yes' }], [{ ...candidates[0], reason: 'contradictory' }]]) {
    await assert.rejects(new SessionHttpTransport('', async () => Response.json(invalid)).recoveries(), HttpTransportError);
  }
});

test('session HTTP checks service identity and active submission instead of loading old configuration', async () => {
  const paths = [];
  const transport = new SessionHttpTransport('http://local.test', async (url) => {
    paths.push(url);
    return Response.json(info);
  });
  assert.deepEqual(await transport.session(), info);
  assert.deepEqual(paths, ['http://local.test/api/session']);
  for (const value of [
    { ...info, admission: { ...info.admission, transcriptId: 'wrong' } },
    { ...info, active: { ...baseline, submission: { ...baseline.submission, conversationId: 'other' } } },
    { ...info, active: { ...baseline, submission: { ...baseline.submission, result: { status: 'cancelled' } } } },
  ]) {
    await assert.rejects(new SessionHttpTransport('', async () => Response.json(value)).session(), HttpTransportError);
  }
});

test('submission HTTP distinguishes recoverable disconnection, unknown identity, and invalid wire data', async () => {
  const eof = new SessionHttpTransport('', async () => stream([baseline]));
  await assert.rejects(
    eof.follow('submission', () => {}, signal()),
    SessionConnectionError,
  );
  const lost = new SessionHttpTransport('', async () => {
    throw new TypeError('connection lost');
  });
  await assert.rejects(lost.read('submission'), SessionConnectionError);
  const unknown = new SessionHttpTransport('', async () => Response.json({ code: 'SUBMISSION_UNAVAILABLE', error: 'not retained' }, { status: 404 }));
  await assert.rejects(unknown.read('submission'), SubmissionUnavailableError);
  await assert.rejects(
    unknown.follow('submission', () => {}, signal()),
    SubmissionUnavailableError,
  );
  for (const response of [() => new Response('{'), () => stream([{ type: 'submission', conversationId: 'conversation', submissionId: 'submission', fromRevision: 0, revision: 1, change: {} }]), () => stream([{ ...baseline, submission: { ...baseline.submission, submissionId: 'wrong' } }])]) {
    const malformed = new SessionHttpTransport('', async () => response());
    await assert.rejects(
      malformed.follow('submission', () => {}, signal()),
      (error) => error instanceof HttpTransportError && !(error instanceof SessionConnectionError),
    );
  }
  const delivery = new SessionHttpTransport('', async () => stream([baseline]));
  await assert.rejects(
    delivery.follow(
      'submission',
      () => {
        throw new TypeError('UI delivery bug');
      },
      signal(),
    ),
    (error) => error instanceof HttpTransportError && error.kind === 'delivery',
  );
});

test('inspection checks entity sources and full call detail preserves the real Scene topology', async () => {
  const inspection = { transcriptId: 'transcript', memories: { id: 'memories', sequence: 0, items: [] }, view: { revision: 0, sources: { messages: { id: 'transcript', scope: 'original' }, memories: { id: 'memories', scope: 'original' } }, members: [] }, recording: { status: 'recording', recorderId: 'recorder', revision: 0, integrity: 'intact', calls: [], omitted: 0 } };
  assert.deepEqual(await new SessionHttpTransport('', async () => Response.json(inspection)).inspection(), inspection);
  const idle = { status: 'idle', revision: 0, integrity: 'intact', calls: [], omitted: 0 };
  assert.deepEqual((await new SessionHttpTransport('', async () => Response.json({ ...inspection, recording: idle })).inspection()).recording, idle);
  for (const recording of [
    { ...idle, recorderId: 'fabricated' },
    { ...idle, revision: 1 },
    { ...idle, integrity: 'incomplete' },
    { ...idle, omitted: 1 },
    { ...inspection.recording, recorderId: undefined },
  ]) {
    await assert.rejects(new SessionHttpTransport('', async () => Response.json({ ...inspection, recording })).inspection(), HttpTransportError);
  }
  await assert.rejects(new SessionHttpTransport('', async () => Response.json({ ...inspection, view: { ...inspection.view, members: [{ source: 'memories', key: 'missing' }] } })).inspection(), HttpTransportError);
  const source = snapshot();
  const detail = { recorderId: 'recorder', revision: 10, integrity: 'intact', root: source.rootCall, calls: source.calls, resources: source.resources, transcripts: source.transcripts, memories: source.memories, boundaries: source.boundaries, truncated: false };
  const transport = new SessionHttpTransport('', async () => Response.json(detail));
  assert.deepEqual(await transport.call(detail.root.id), detail);
  await assert.rejects(transport.call('other'), HttpTransportError);
  const damaged = { ...detail, boundaries: [] };
  await assert.rejects(new SessionHttpTransport('', async () => Response.json(damaged)).call(detail.root.id), HttpTransportError);
  const incomplete = { ...damaged, integrity: 'incomplete' };
  assert.deepEqual(await new SessionHttpTransport('', async () => Response.json(incomplete)).call(detail.root.id), incomplete);
  await assert.rejects(new SessionHttpTransport('', async () => Response.json({ ...incomplete, calls: [{ ...detail.calls[0], value: { input: null } }] })).call(detail.root.id), HttpTransportError);
});

test('real offline web host is consumed by the session and its inspected Scene records pass wire acceptance', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'capix-session-http-'));
  const requests = [];
  const model = {
    async complete(input, controls = {}) {
      requests.push(input);
      if (input.responseFormat === 'json_object') return { id: 'maintenance', model: 'fixture', text: '{"changes":[]}', finishReason: 'stop', usage: null };
      controls.emit?.('candidate');
      return { id: 'answer', model: 'fixture', text: '正式回答', finishReason: 'stop', usage: null };
    },
  };
  const host = createConversationWebHost({ database: join(directory, 'session.sqlite'), model, mode: 'demo', modelName: 'fixture' });
  let session;
  t.after(async () => {
    session?.stop();
    await host.close();
    await rm(directory, { recursive: true, force: true });
  });
  await new Promise((resolve) => host.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${host.server.address().port}`;
  const transport = new SessionHttpTransport(origin, (url, options) => fetch(url, { ...options, headers: { ...options?.headers, Origin: origin } }));
  session = new ConversationSession(transport);
  await session.initialize();
  assert.deepEqual(await transport.recording(), { status: 'idle' });
  await transport.startRecording();
  await session.send('你好');
  assert.equal(session.snapshot.submission.remote.result.status, 'completed');
  for (let attempt = 0; attempt < 30 && !session.snapshot.canSend; attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(session.snapshot.transcript.snapshot.messages, [
    { role: 'user', content: '你好' },
    { role: 'assistant', content: '正式回答' },
  ]);
  assert.equal(session.snapshot.canSend, true);
  const inspection = await transport.inspection();
  assert.equal(inspection.recording.calls.length, 1);
  const detail = await transport.call(inspection.recording.calls[0].id);
  assert.equal(detail.root.structureKind, 'scene');
  assert.equal(detail.root.status, 'succeeded');
  assert.ok(detail.calls.length > 0);
  assert.equal(requests.length, 2);
});

test('a new session reconnects to a live HTTP submission after the original consumer leaves', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'capix-session-follow-'));
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  let requests = 0;
  const host = createConversationWebHost({
    database: join(directory, 'session.sqlite'),
    mode: 'demo',
    modelName: 'fixture',
    model: {
      async complete(input) {
        requests++;
        if (input.responseFormat !== 'json_object') {
          started.resolve();
          await release.promise;
        }
        return { id: `response-${requests}`, model: 'fixture', text: input.responseFormat === 'json_object' ? '{"changes":[]}' : 'late answer', finishReason: 'stop', usage: null };
      },
    },
  });
  const sessions = [];
  t.after(async () => {
    release.resolve();
    for (const session of sessions) session.stop();
    await host.close();
    await rm(directory, { recursive: true, force: true });
  });
  await new Promise((resolve) => host.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${host.server.address().port}`;
  let posts = 0;
  const transport = new SessionHttpTransport(origin, (url, options) => {
    if (options?.method === 'POST' && new URL(url).pathname === '/api/run') posts++;
    return fetch(url, { ...options, headers: { ...options?.headers, Origin: origin } });
  });
  let locator;
  const tracking = {
    load: () => locator,
    save: (value) => {
      locator = value;
    },
  };
  const first = new ConversationSession(transport, { tracking });
  sessions.push(first);
  await first.initialize();
  const sending = first.send('keep running');
  await started.promise;
  const submissionId = locator.submissionId;
  first.stop();
  await sending;
  const second = new ConversationSession(transport, { tracking });
  sessions.push(second);
  await second.initialize();
  for (let attempt = 0; attempt < 30 && second.snapshot.submission?.feedback.status !== 'following'; attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(second.snapshot.submission.id, submissionId);
  assert.equal(second.snapshot.submission.feedback.status, 'following');
  assert.equal(posts, 1);
  assert.equal(requests, 1);
  release.resolve();
  for (let attempt = 0; attempt < 50 && !second.snapshot.submission?.remote?.result; attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(second.snapshot.submission.remote.result.status, 'completed');
  assert.equal(posts, 1);
  assert.equal(requests, 2, 'only the original answer and subsequent maintenance call exist');
});
