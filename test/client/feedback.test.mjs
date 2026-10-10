import test from 'node:test';
import assert from 'node:assert/strict';
import { ClientSubmission, SubmissionContractError } from '@capix/client-runtime';
import { client, deferred, submissionSnapshot, transport } from './fixtures.mjs';

const range = { transcriptId: 'fixture-transcript', start: 0, end: 1 };
const reception = (changed = () => undefined) => ({ transcriptId: range.transcriptId, changed });

test('a submission reconnect owns feedback independently of late frames and errors from its former connection', async () => {
  const submission = new ClientSubmission('question');
  const old = deferred();
  const current = deferred();
  let oldReceive;
  let oldSignal;
  let currentReceive;
  let changes = 0;
  const notify = reception(() => changes++);
  const original = submission.connect(async (receive, signal) => {
    oldReceive = receive;
    oldSignal = signal;
    receive(submissionSnapshot(submission.id, { revision: 1, input: range }));
    await old.promise;
  }, notify);
  const following = submission.connect(async (receive) => {
    currentReceive = receive;
    receive(submissionSnapshot(submission.id, { revision: 2, input: range, executions: [{ contextId: 'current' }] }));
    await current.promise;
  }, notify);
  assert.equal(oldSignal.aborted, true);
  const before = submission.snapshot;
  const notifications = changes;
  oldReceive(submissionSnapshot(submission.id, { revision: 3, input: range, result: { status: 'failed', error: { code: 'STALE', message: 'old connection' } } }));
  old.reject(new Error('late connection failure'));
  await original;
  assert.equal(submission.snapshot, before);
  assert.equal(changes, notifications);
  currentReceive(submissionSnapshot(submission.id, { revision: 3, input: range, executions: [{ contextId: 'current' }], result: { status: 'completed' } }));
  current.resolve();
  await following;
  assert.equal(submission.snapshot.remote.result.status, 'completed');
  assert.equal(submission.snapshot.feedback.status, 'ended');
});

test('stopping feedback during its initial change does not open the connection or announce a remote outcome', async () => {
  const submission = new ClientSubmission('question');
  let connections = 0;
  let changes = 0;
  await submission.connect(
    async () => connections++,
    reception(() => {
      changes++;
      submission.stopFollowing();
    }),
  );
  assert.equal(connections, 0);
  assert.equal(changes, 1, 'stop is coordinated by the caller and does not recursively notify');
  assert.equal(submission.snapshot.feedback.status, 'ended');
  assert.equal(submission.snapshot.remote, undefined);
});

test('reconnecting from the initial change starts only the replacement connection', async () => {
  const submission = new ClientSubmission('question');
  let originalConnections = 0;
  let replacementConnections = 0;
  let replacement;
  await submission.connect(
    async () => originalConnections++,
    reception(() => {
      replacement = submission.connect(async (receive) => {
        replacementConnections++;
        receive(submissionSnapshot(submission.id, { revision: 1, input: range, result: { status: 'completed' } }));
      }, reception());
    }),
  );
  await replacement;
  assert.equal(originalConnections, 0);
  assert.equal(replacementConnections, 1);
  assert.equal(submission.snapshot.feedback.status, 'ended');
  assert.equal(submission.snapshot.remote.result.status, 'completed');
});

test('reconnecting during frame acceptance isolates the remainder of the old synchronous producer', async () => {
  const submission = new ClientSubmission('question');
  let replacement;
  let oldSignal;
  let didReconnect = false;
  await submission.connect(
    async (receive, signal) => {
      oldSignal = signal;
      receive(submissionSnapshot(submission.id, { revision: 1, input: range }));
      receive(submissionSnapshot(submission.id, { revision: 20, input: range, result: { status: 'failed', error: { code: 'STALE', message: 'superseded' } } }));
      throw new Error('superseded producer failed');
    },
    reception(() => {
      if (!submission.snapshot.remote?.input || didReconnect) return;
      didReconnect = true;
      replacement = submission.connect(async (receive) => {
        receive(submissionSnapshot(submission.id, { revision: 2, input: range, result: { status: 'completed' } }));
      }, reception());
    }),
  );
  await replacement;
  assert.equal(oldSignal.aborted, true);
  assert.equal(submission.snapshot.remote.revision, 2);
  assert.equal(submission.snapshot.remote.result.status, 'completed');
  assert.equal(submission.snapshot.feedback.status, 'ended');
});

test('a synchronous connection failure interrupts feedback without producing a business failure', async () => {
  const cause = new TypeError('connection could not open');
  const submission = new ClientSubmission('question');
  const changes = [];
  await submission.connect(
    () => {
      throw cause;
    },
    reception(() => changes.push(submission.snapshot)),
  );
  assert.deepEqual(
    changes.map((state) => state.feedback.status),
    ['connecting', 'interrupted'],
  );
  assert.equal(submission.snapshot.feedback.error, cause);
  assert.equal(submission.snapshot.remote, undefined);
});

test('connection completion requires a known result or explicit source incompleteness', async () => {
  for (const patch of [{}, { revision: 1, input: range }]) {
    const submission = new ClientSubmission('question');
    await submission.connect(async (receive) => receive(submissionSnapshot(submission.id, patch)), reception());
    assert.equal(submission.snapshot.feedback.status, 'interrupted');
    assert.match(submission.snapshot.feedback.error.message, /远端结果仍未确认/);
    assert.equal(submission.snapshot.remote.result, undefined);
  }
  const incomplete = new ClientSubmission('question');
  await incomplete.connect(async (receive) => receive(submissionSnapshot(incomplete.id, { revision: 1, input: range, integrity: { status: 'incomplete', error: { code: 'PROGRESS_INCOMPLETE', message: 'source lost facts' } } })), reception());
  assert.equal(incomplete.snapshot.feedback.status, 'ended');
  assert.equal(incomplete.snapshot.remote.integrity.status, 'incomplete');
  assert.equal(incomplete.snapshot.remote.result, undefined);
});

test('foreign transcript input interrupts feedback while preserving previously accepted facts', async () => {
  const submission = new ClientSubmission('question');
  await submission.connect(async (receive) => {
    receive(submissionSnapshot(submission.id, { revision: 1, input: range, executions: [{ contextId: 'known' }] }));
    receive(submissionSnapshot(submission.id, { revision: 2, input: { ...range, transcriptId: 'foreign' }, executions: [{ contextId: 'known' }], result: { status: 'completed' } }));
  }, reception());
  assert.equal(submission.snapshot.feedback.status, 'interrupted');
  assert.ok(submission.snapshot.feedback.error instanceof SubmissionContractError);
  assert.equal(submission.snapshot.remote.revision, 1);
  assert.deepEqual(submission.snapshot.remote.input, range);
  assert.equal(submission.snapshot.remote.executions[0].contextId, 'known');
  assert.equal(submission.snapshot.remote.result, undefined);
});

test('stopping local feedback preserves accepted facts and leaves once acceptance notification to publication', async () => {
  const completion = deferred();
  let receive;
  let signal;
  let changes = 0;
  let acceptances = 0;
  const submission = new ClientSubmission('question', () => {
    acceptances++;
  });
  const work = submission.connect(
    async (accept, connectionSignal) => {
      receive = accept;
      signal = connectionSignal;
      accept(submissionSnapshot(submission.id, { revision: 1, input: range }));
      await completion.promise;
    },
    reception(() => changes++),
  );
  const known = submission.snapshot.remote;
  const notifications = changes;
  assert.equal(acceptances, 0);
  assert.equal(submission.acceptancePending, true);
  submission.stopFollowing();
  assert.equal(signal.aborted, true);
  assert.equal(changes, notifications);
  assert.equal(submission.snapshot.remote, known);
  assert.equal(submission.snapshot.remote.result, undefined);
  assert.equal(submission.snapshot.feedback.status, 'ended');
  receive(submissionSnapshot(submission.id, { revision: 2, input: range, result: { status: 'completed' } }));
  completion.resolve();
  await work;
  assert.equal(submission.snapshot.remote, known, 'stopped consumption cannot claim later remote completion');
  assert.equal(changes, notifications);
  submission.publishAcceptance(submission.snapshot);
  submission.publishAcceptance(submission.snapshot);
  assert.equal(acceptances, 1);
});

test('a new runtime submission closes the former feedback connection even when the former result arrived before EOF', async (t) => {
  let posts = 0;
  let firstSignal;
  const io = transport({
    submit: async (request, receive, signal) => {
      posts++;
      receive(submissionSnapshot(request.submissionId, { revision: 1, input: range, result: { status: 'completed' } }));
      if (posts !== 1) return;
      firstSignal = signal;
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    },
  });
  const runtime = client({ conversation: io });
  t.after(() => {
    runtime.releaseSubmission();
    runtime.stopTranscript();
  });
  await runtime.initialize();
  const input = { messages: [{ role: 'user', content: 'question' }] };
  const first = runtime.submit(input);
  const firstId = runtime.getSnapshot().submission.id;
  await runtime.submit(input);
  assert.equal(firstSignal.aborted, true);
  await first;
  assert.equal(posts, 2);
  assert.notEqual(runtime.getSnapshot().submission.id, firstId);
  assert.equal(runtime.getSnapshot().submission.remote.result.status, 'completed');
});

test('stopping feedback cannot overwrite a connection synchronously opened by its abort listener', async () => {
  const submission = new ClientSubmission('question');
  const current = deferred();
  let following;
  let currentReceive;
  const original = submission.connect(async (_receive, signal) => {
    await new Promise((resolve) =>
      signal.addEventListener(
        'abort',
        () => {
          following = submission.connect(async (receive) => {
            currentReceive = receive;
            receive(submissionSnapshot(submission.id, { revision: 1, input: range }));
            await current.promise;
          }, reception());
          resolve();
        },
        { once: true },
      ),
    );
  }, reception());
  submission.stopFollowing();
  await original;
  assert.equal(submission.snapshot.feedback.status, 'following');
  assert.equal(submission.snapshot.remote.revision, 1);
  currentReceive(submissionSnapshot(submission.id, { revision: 2, input: range, result: { status: 'completed' } }));
  current.resolve();
  await following;
  assert.equal(submission.snapshot.feedback.status, 'ended');
});

test('a connection opened from an abort listener supersedes the outer reconnect request', async () => {
  const submission = new ClientSubmission('question');
  let nested;
  let outerConnections = 0;
  const original = submission.connect(async (_receive, signal) => {
    await new Promise((resolve) =>
      signal.addEventListener(
        'abort',
        () => {
          nested = submission.connect(async (receive) => {
            receive(submissionSnapshot(submission.id, { revision: 1, input: range, result: { status: 'completed' } }));
          }, reception());
          resolve();
        },
        { once: true },
      ),
    );
  }, reception());
  await submission.connect(async () => outerConnections++, reception());
  await nested;
  await original;
  assert.equal(outerConnections, 0);
  assert.equal(submission.snapshot.remote.result.status, 'completed');
  assert.equal(submission.snapshot.feedback.status, 'ended');
});

test('releasing a runtime submission cannot clear a replacement synchronously submitted by its abort listener', async (t) => {
  const input = { messages: [{ role: 'user', content: 'question' }] };
  let posts = 0;
  let replacement;
  let replacementId;
  const io = transport({
    submit: async (request, receive, signal) => {
      posts++;
      receive(submissionSnapshot(request.submissionId, { revision: 1, input: range, result: { status: 'completed' } }));
      if (posts !== 1) {
        replacementId = request.submissionId;
        return;
      }
      await new Promise((resolve) =>
        signal.addEventListener(
          'abort',
          () => {
            replacement = runtime.submit(input);
            resolve();
          },
          { once: true },
        ),
      );
    },
  });
  const runtime = client({ conversation: io });
  t.after(() => {
    runtime.releaseSubmission();
    runtime.stopTranscript();
  });
  await runtime.initialize();
  const original = runtime.submit(input);
  const firstId = runtime.getSnapshot().submission.id;
  runtime.releaseSubmission();
  await original;
  await replacement;
  assert.equal(posts, 2);
  assert.notEqual(replacementId, firstId);
  assert.equal(runtime.getSnapshot().submission.id, replacementId);
  assert.equal(runtime.getSnapshot().submission.remote.result.status, 'completed');
});
