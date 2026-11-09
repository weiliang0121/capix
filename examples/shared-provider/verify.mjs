import { modelReplyText } from '@weiliang0121/capix-model-provider';
import assert from 'node:assert/strict';
import { createSession, createFeedbackReader } from './assembly.mjs';
import { createControlledProvider } from './transport.mjs';

// Timeouts only bound a broken experiment; ordering is established by real fetch
// arrival and delivered deltas, never by sleeping for an estimated model duration.
async function bounded(pending) {
  let timer;
  try {
    return await Promise.race([
      pending,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Shared-provider experiment did not reach its next boundary')), 3000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function watch(runner) {
  const events = [];
  const waiting = new Set();
  const unsubscribe = runner.output.subscribe({
    receive(event) {
      events.push(event);
      for (const waiter of waiting) {
        if (event.kind !== 'delta' || event.delta !== waiter.text) continue;
        waiting.delete(waiter);
        waiter.resolve();
      }
    },
  });
  return {
    events,
    deltas: () => events.filter((event) => event.kind === 'delta').map((event) => event.delta),
    async delta(text) {
      if (events.some((event) => event.kind === 'delta' && event.delta === text)) return;
      const waiter = { ...Promise.withResolvers(), text };
      waiting.add(waiter);
      try {
        await bounded(waiter.promise);
      } finally {
        waiting.delete(waiter);
      }
    },
    close: unsubscribe,
  };
}

/** Two real provider requests share configuration, never a conversation or ref. */
export async function verifySharedCancellation(mode, persistence = {}) {
  const { model, transport } = createControlledProvider();
  const a = createSession({ model, label: 'A', mode, persistence: persistence.A });
  const b = createSession({ model, label: 'B', mode, persistence: persistence.B });
  const aOutput = watch(a.runner);
  const bOutput = watch(b.runner);
  const runners = [a.runner, b.runner];
  const watched = [aOutput, bOutput];
  const pending = [];
  const start = (runner, input) => {
    const outcome = runner.run(input).then(
      (value) => ({ status: 'succeeded', value }),
      (error) => ({ status: 'failed', error }),
    );
    pending.push(outcome);
    return outcome;
  };
  try {
    assert.notEqual(a.resources, b.resources);
    assert.notEqual(a.runner.scene, b.runner.scene);
    assert.notEqual(a.content.transcript.id, b.content.transcript.id);
    const aRun = start(a.runner, 'A:question');
    const bRun = start(b.runner, 'B:question');
    const requests = await bounded(Promise.all([transport.waitFor(0), transport.waitFor(1)]));
    const inputOf = (request) => JSON.parse(request.body.messages[1].content);
    const aRequest = requests.find((request) => inputOf(request).query.content === 'A:question');
    const bRequest = requests.find((request) => inputOf(request).query.content === 'B:question');
    assert.ok(aRequest && bRequest);
    assert.notEqual(aRequest.signal, bRequest.signal);
    for (const [session, request, own, other] of [
      [a, aRequest, 'A', 'B'],
      [b, bRequest, 'B', 'A'],
    ]) {
      const input = inputOf(request);
      assert.equal(input.query.transcriptId, session.content.transcript.id);
      assert.equal(input.materials.basis.sources.messages.id, session.content.transcript.id);
      assert.equal(input.materials.basis.sources.memories.id, session.content.memories.id);
      assert.ok(JSON.stringify(input).includes(`${own}:private-history`));
      assert.ok(JSON.stringify(input).includes(`${own}:private-memory`));
      assert.ok(!JSON.stringify(input).includes(`${other}:`));
      assert.equal(session.runner.isRunning, true);
    }
    aRequest.chunk('A:preview');
    await aOutput.delta('A:preview');
    bRequest.chunk('B:preview');
    await bOutput.delta('B:preview');
    const reason = new Error('Only stop conversation A');
    assert.equal(a.runner.cancel(reason), true);
    const cancelled = await bounded(aRun);
    assert.equal(cancelled.status, 'failed');
    assert.equal(cancelled.error.code, 'INVOCATION_CANCELLED');
    assert.equal(a.runner.isRunning, false);
    assert.equal(b.runner.isRunning, true);
    assert.equal(bRequest.signal.aborted, false);
    assert.equal(aRequest.signal.aborted, mode === 'direct');
    if (mode === 'direct') assert.equal(aRequest.signal.reason, reason);
    else {
      assert.equal(a.interactions.active, true);
      assert.equal(a.references.length, 1, 'send result was handed to the host resource before waiting');
      assert.notEqual(a.references[0].id, b.references[0].id);
      assert.throws(() => a.interactions.close(), { code: 'INTERACTIONS_ACTIVE' });
    }

    bRequest.finish(':final');
    assert.deepEqual(await bounded(bRun), { status: 'succeeded', value: 'B:preview:final' });
    assert.equal(
      a.content.transcript.snapshot().some((message) => message.role === 'assistant'),
      false,
    );
    assert.equal(b.content.transcript.snapshot().at(-1).content, 'B:preview:final');
    const aBeforeRead = a.content.transcript.exportState();
    let lateReply;
    if (mode === 'interaction') {
      // A private registry with a private read port cannot load B's exchange.
      const reader = createFeedbackReader(a.interactions);
      runners.push(reader);
      const readerOutput = watch(reader);
      watched.push(readerOutput);
      const wrong = await bounded(start(reader, b.references[0]));
      assert.equal(wrong.error?.code, 'INTERACTION_UNKNOWN');
      assert.deepEqual(readerOutput.deltas(), []);
      assert.equal(transport.requests.length, 2);

      await bounded(b.interactions.settled());
      b.interactions.close();
      assert.equal(a.interactions.active, true, 'closing B does not close the shared provider or A sender');
      assert.equal(aRequest.signal.aborted, false);
      aRequest.finish(':late');
      await bounded(a.interactions.settled());
      const result = await bounded(start(reader, a.references[0]));
      assert.equal(result.status, 'succeeded');
      lateReply = result.value;
      assert.equal(lateReply.id, `reply-${aRequest.index}`);
      assert.equal(lateReply.model, 'shared-fixture-model');
      assert.equal(lateReply.termination.reason, 'stop');
      assert.equal(modelReplyText(lateReply), 'A:preview:late');
      assert.deepEqual(readerOutput.deltas(), ['A:preview', ':late']);
      assert.deepEqual(a.content.transcript.exportState(), aBeforeRead, 'reading late feedback does not accept an assistant message');
      assert.equal(transport.requests.length, 2, 're-reading feedback never dispatches again');
    }
    assert.deepEqual(aOutput.deltas(), ['A:preview'], 'the old access window cannot receive late output');
    assert.deepEqual(bOutput.deltas(), ['B:preview', ':final']);
    assert.equal(
      bOutput.events.some((event) => event.kind === 'completed'),
      true,
    );
    assert.equal(
      aOutput.events.some((event) => event.kind === 'completed'),
      false,
    );
    assert.notEqual(aOutput.events[0].entryId, bOutput.events[0].entryId);
    assert.equal(aRequest.stream.locked, false);
    assert.equal(bRequest.stream.locked, false);

    // Same provider and same A Runner can serve a new call after the failure.
    const next = start(a.runner, 'A:next-question');
    const nextRequest = await bounded(transport.waitFor(2));
    assert.equal(inputOf(nextRequest).query.content, 'A:next-question');
    assert.ok(!JSON.stringify(nextRequest.body).includes('B:'));
    nextRequest.finish('A:next-answer');
    assert.deepEqual(await bounded(next), { status: 'succeeded', value: 'A:next-answer' });
    assert.equal(nextRequest.signal.aborted, false);
    assert.equal(a.content.transcript.snapshot().at(-1).content, 'A:next-answer');
    assert.equal(b.content.transcript.snapshot().at(-1).content, 'B:preview:final');
    return {
      mode,
      sends: transport.requests.length,
      cancelledRequestAborted: aRequest.signal.aborted,
      peerRequestAborted: bRequest.signal.aborted,
      lateFeedback: lateReply ? modelReplyText(lateReply) : undefined,
      references: { A: a.references, B: b.references },
      assistantMessages: {
        A: a.content.transcript
          .snapshot()
          .filter((message) => message.role === 'assistant')
          .map((message) => message.content),
        B: b.content.transcript
          .snapshot()
          .filter((message) => message.role === 'assistant')
          .map((message) => message.content),
      },
    };
  } finally {
    for (const runner of runners) runner.cancel();
    transport.close();
    for (const output of watched) output.close();
    await bounded(Promise.all([...pending, a.interactions?.settled(), b.interactions?.settled()]));
    for (const session of [a, b]) {
      session.interactions?.close();
    }
  }
}
