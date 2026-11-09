import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ChatCompletionsProvider, ProviderError } from '@weiliang0121/capix-model-provider';
import { createSession } from '../examples/shared-provider/assembly.mjs';
import { createControlledProvider } from '../examples/shared-provider/transport.mjs';

function observe(t, runner) {
  const events = [];
  const deltas = [];
  const waiting = new Set();
  t.after(
    runner.output.subscribe({
      receive(event) {
        events.push(event);
        if (event.kind !== 'delta') return;
        deltas.push(event.delta);
        for (const waiter of waiting) {
          if (deltas.length < waiter.count) continue;
          waiting.delete(waiter);
          waiter.resolve();
        }
      },
    }),
  );
  return {
    events,
    deltas,
    received(count) {
      if (deltas.length >= count) return Promise.resolve();
      const gate = Promise.withResolvers();
      waiting.add({ count, resolve: gate.resolve });
      return gate.promise;
    },
  };
}

function pair(t) {
  const { model, transport } = createControlledProvider();
  assert.ok(model instanceof ChatCompletionsProvider, 'exercise the real HTTP/SSE adapter, not a completion stub');
  const a = createSession({ model, label: 'A' });
  const b = createSession({ model, label: 'B' });
  const pending = [];
  t.after(async () => {
    a.runner.cancel();
    b.runner.cancel();
    transport.close();
    await Promise.all(pending);
  });
  assert.notEqual(a.runner, b.runner);
  assert.notEqual(a.runner.scene, b.runner.scene);
  assert.notEqual(a.resources, b.resources);
  for (const entity of ['transcript', 'memories', 'view']) assert.notEqual(a.content[entity], b.content[entity]);
  assert.equal(transport.requests.length, 0, 'building two runners cannot send model requests');
  return {
    a,
    b,
    transport,
    outputA: observe(t, a.runner),
    outputB: observe(t, b.runner),
    run(session, input) {
      // Attach both continuations immediately: intentional cancellation/failure
      // must not become an unhandled rejection while the peer is still running.
      const settled = session.runner.run(input).then(
        (value) => ({ status: 'fulfilled', value }),
        (reason) => ({ status: 'rejected', reason }),
      );
      pending.push(settled);
      return settled;
    },
  };
}

function assertPrivateInput(request, session, label, peer, query) {
  const input = JSON.parse(request.body.messages.at(-1).content);
  assert.equal(input.query.content, query);
  assert.equal(input.query.transcriptId, session.content.transcript.id);
  assert.equal(input.materials.basis.sources.messages.id, session.content.transcript.id);
  assert.equal(input.materials.basis.sources.memories.id, session.content.memories.id);
  const materials = JSON.stringify(input.materials.entries);
  assert.ok(materials.includes(`${label}:private-history`));
  assert.ok(materials.includes(`${label}:private-memory`));
  assert.ok(!JSON.stringify(request.body).includes(`${peer}:`), 'the shared provider receives only this conversation material');
}

function assertReaderReleased(request) {
  assert.equal(request.cancelled, 1, 'the actual SSE reader releases its own body');
  assert.equal(request.stream.locked, false);
}

test('a shared provider isolates concurrent direct conversation requests, cancellation and subsequent reuse', { timeout: 5000 }, async (t) => {
  const f = pair(t);
  const firstA = f.run(f.a, 'A:question');
  const requestA = await f.transport.waitFor(0);
  const firstB = f.run(f.b, 'B:question');
  const requestB = await f.transport.waitFor(1);
  assertPrivateInput(requestA, f.a, 'A', 'B', 'A:question');
  assertPrivateInput(requestB, f.b, 'B', 'A', 'B:question');
  assert.notEqual(requestA.signal, requestB.signal);
  assert.notEqual(requestA.stream, requestB.stream);
  assert.equal(f.a.runner.isRunning, true);
  assert.equal(f.b.runner.isRunning, true);

  requestB.chunk('B:preview');
  await f.outputB.received(1);
  requestA.chunk('A:preview');
  await f.outputA.received(1);
  const stop = new Error('Stop only conversation A');
  assert.equal(f.a.runner.cancel(stop), true);
  const cancelled = await firstA;
  assert.equal(cancelled.status, 'rejected');
  assert.equal(cancelled.reason.code, 'INVOCATION_CANCELLED');
  assert.equal(requestA.signal.aborted, true);
  assertReaderReleased(requestA);
  assert.equal(requestB.signal.aborted, false);
  assert.equal(requestB.cancelled, 0);
  assert.equal(f.a.runner.isRunning, false);
  assert.equal(f.b.runner.isRunning, true, 'cancelling A cannot release B occupancy');
  assert.equal(f.b.content.transcript.snapshot().filter((message) => message.role === 'assistant').length, 0);

  requestB.finish(' B:final');
  assert.deepEqual(await firstB, { status: 'fulfilled', value: 'B:preview B:final' });
  assert.equal(f.b.runner.isRunning, false);
  assert.equal(requestB.signal.aborted, false, 'normal reader cleanup is not cancellation');
  assertReaderReleased(requestB);
  assert.deepEqual(f.outputA.deltas, ['A:preview']);
  assert.deepEqual(f.outputB.deltas, ['B:preview', ' B:final']);
  assert.deepEqual(f.a.content.transcript.snapshot(), [
    { role: 'user', content: 'A:private-history' },
    { role: 'user', content: 'A:question' },
  ]);
  assert.deepEqual(f.b.content.transcript.snapshot(), [
    { role: 'user', content: 'B:private-history' },
    { role: 'user', content: 'B:question' },
    { role: 'assistant', content: 'B:preview B:final' },
  ]);
  assert.deepEqual(
    f.a.content.view
      .members()
      .filter((member) => member.source === 'messages')
      .map((member) => member.key),
    [0, 1],
    'accepted input remains included after cancellation',
  );
  assert.deepEqual(
    f.b.content.view
      .members()
      .filter((member) => member.source === 'messages')
      .map((member) => member.key),
    [0, 1, 2],
  );

  const nextA = f.run(f.a, 'A:next-question');
  const requestNextA = await f.transport.waitFor(2);
  assertPrivateInput(requestNextA, f.a, 'A', 'B', 'A:next-question');
  assert.notEqual(requestNextA.signal, requestA.signal);
  assert.equal(requestNextA.signal.aborted, false);
  requestNextA.finish('A:next-answer');
  assert.deepEqual(await nextA, { status: 'fulfilled', value: 'A:next-answer' });
  assertReaderReleased(requestNextA);
  assert.equal(f.a.content.transcript.snapshot().at(-1).content, 'A:next-answer');
  assert.deepEqual(f.outputA.deltas, ['A:preview', 'A:next-answer']);
  assert.equal(new Set(f.outputA.events.map((event) => event.entryId)).size, 2, 'a new call obtains a new output identity');
  assert.equal(f.transport.requests.length, 3, 'cancellation causes no hidden resend');
  assert.deepEqual(f.outputB.deltas, ['B:preview', ' B:final']);
});

test('one malformed SSE response fails only its conversation and leaves the shared provider reusable', { timeout: 5000 }, async (t) => {
  const f = pair(t);
  const firstA = f.run(f.a, 'A:invalid-stream');
  const requestA = await f.transport.waitFor(0);
  const firstB = f.run(f.b, 'B:valid-stream');
  const requestB = await f.transport.waitFor(1);
  requestA.chunk('A:unaccepted-preview');
  requestB.chunk('B:valid-preview');
  await Promise.all([f.outputA.received(1), f.outputB.received(1)]);
  requestA.malformed();
  const failed = await firstA;
  assert.equal(failed.status, 'rejected');
  assert.ok(failed.reason instanceof ProviderError);
  assert.equal(failed.reason.code, 'ENVELOPE');
  assertReaderReleased(requestA);
  assert.equal(requestA.signal.aborted, false, 'parser failure is not a cancellation request');
  assert.equal(requestB.signal.aborted, false);
  assert.equal(requestB.cancelled, 0);
  assert.equal(f.b.runner.isRunning, true);
  requestB.finish(' B:complete');
  assert.deepEqual(await firstB, { status: 'fulfilled', value: 'B:valid-preview B:complete' });
  assertReaderReleased(requestB);
  assert.equal(
    f.a.content.transcript.snapshot().some((message) => message.role === 'assistant'),
    false,
  );
  assert.equal(f.b.content.transcript.snapshot().at(-1).content, 'B:valid-preview B:complete');
  assert.deepEqual(f.outputA.deltas, ['A:unaccepted-preview']);
  assert.deepEqual(f.outputB.deltas, ['B:valid-preview', ' B:complete']);

  const nextA = f.run(f.a, 'A:after-failure');
  const nextRequest = await f.transport.waitFor(2);
  assertPrivateInput(nextRequest, f.a, 'A', 'B', 'A:after-failure');
  nextRequest.finish('A:recovered-by-new-request');
  assert.deepEqual(await nextA, { status: 'fulfilled', value: 'A:recovered-by-new-request' });
  assertReaderReleased(nextRequest);
  assert.equal(f.transport.requests.length, 3, 'new explicit input sends once; malformed feedback is not retried');
});

test('one conversation output subscriber failure cannot stop either request or another subscriber', { timeout: 5000 }, async (t) => {
  const f = pair(t);
  const failure = new Error('A display receiver failed');
  const failures = [];
  let deliveries = 0;
  t.after(
    f.a.runner.output.subscribe({
      receive(event) {
        if (event.kind !== 'delta') return;
        deliveries++;
        throw failure;
      },
      failed(error) {
        failures.push(error);
      },
    }),
  );
  const firstA = f.run(f.a, 'A:subscriber-failure');
  const requestA = await f.transport.waitFor(0);
  const firstB = f.run(f.b, 'B:unaffected');
  const requestB = await f.transport.waitFor(1);
  requestA.chunk('A:preview');
  requestB.chunk('B:preview');
  await Promise.all([f.outputA.received(1), f.outputB.received(1)]);
  requestB.finish(' B:done');
  requestA.finish(' A:done');
  assert.deepEqual(await firstA, { status: 'fulfilled', value: 'A:preview A:done' });
  assert.deepEqual(await firstB, { status: 'fulfilled', value: 'B:preview B:done' });
  assert.equal(deliveries, 1);
  assert.deepEqual(failures, [failure]);
  assert.deepEqual(f.outputA.deltas, ['A:preview', ' A:done']);
  assert.deepEqual(f.outputB.deltas, ['B:preview', ' B:done']);
  assert.equal(f.a.content.transcript.snapshot().at(-1).content, 'A:preview A:done');
  assert.equal(f.b.content.transcript.snapshot().at(-1).content, 'B:preview B:done');
  assert.equal(requestA.signal.aborted, false);
  assert.equal(requestB.signal.aborted, false);
  assertReaderReleased(requestA);
  assertReaderReleased(requestB);
  assert.equal(f.transport.requests.length, 2);
});
