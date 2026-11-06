import { modelReplyText } from '@capix/model-provider';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CompletionInteraction } from '@capix/conversation-service';
import { createConversationInteractions } from '@capix/conversation-service/assembly';
import { Interactions } from '@capix/interaction';
import { ProviderError } from '@capix/model-provider';
import { createSession, createFeedbackReader } from '../examples/shared-provider/assembly.mjs';
import { createControlledProvider } from '../examples/shared-provider/transport.mjs';
import { verifySharedCancellation } from '../examples/shared-provider/verify.mjs';

// A shared storage backend with host-selected scope. This is a test fixture, not
// authentication: production must derive the owner from a trusted host boundary.
function sharedStorage() {
  const rows = new Map();
  return {
    readUnscoped: (id) => rows.get(id)?.state,
    scope(owner) {
      return {
        create(state) {
          assert.equal(rows.has(state.id), false);
          rows.set(state.id, { owner, state: structuredClone(state) });
        },
        commit({ expectedRevision, state }) {
          const row = rows.get(state.id);
          assert.equal(row?.owner, owner);
          assert.equal(row.state.revision, expectedRevision);
          rows.set(state.id, { owner, state: structuredClone(state) });
        },
        read(id) {
          const row = rows.get(id);
          return row?.owner === owner ? structuredClone(row.state) : undefined;
        },
      };
    },
  };
}

test('shared provider exchanges outlive only their local reader and remain isolated across host closure', { timeout: 5000 }, async () => {
  const result = await verifySharedCancellation('interaction');
  assert.equal(result.cancelledRequestAborted, false);
  assert.equal(result.peerRequestAborted, false);
  assert.equal(result.lateFeedback, 'A:preview:late');
  assert.equal(result.sends, 3, 'two original requests plus a new explicit A input');
  assert.deepEqual(result.assistantMessages, { A: ['A:next-answer'], B: ['B:preview:final'] });
});

test('saved feedback respects the host read scope; separate Interactions and UUIDs alone do not authorize access', { timeout: 5000 }, async (t) => {
  const store = sharedStorage();
  const persistence = { A: store.scope('A'), B: store.scope('B') };
  const result = await verifySharedCancellation('interaction', persistence);
  const referenceA = result.references.A[0];
  const referenceB = result.references.B[0];
  const savedA = persistence.A.read(referenceA.id);
  const savedB = persistence.B.read(referenceB.id);
  assert.equal(modelReplyText(savedA.feedback.payload), 'A:preview:late');
  assert.equal(modelReplyText(savedB.feedback.payload), 'B:preview:final');
  assert.equal(persistence.A.read(referenceB.id), undefined);
  assert.equal(persistence.B.read(referenceA.id), undefined);
  const { model, transport } = createControlledProvider();
  const a = createConversationInteractions(model, persistence.A);
  const b = createConversationInteractions(model, persistence.B);
  const readerA = createFeedbackReader(a);
  const readerB = createFeedbackReader(b);
  const outputs = [];
  t.after(readerA.output.subscribe({ receive: (event) => void outputs.push(event) }));
  t.after(async () => {
    readerA.cancel();
    readerB.cancel();
    transport.close();
    await Promise.all([a.settled(), b.settled()]);
    a.close();
    b.close();
  });
  assert.deepEqual(await readerA.run(referenceA), savedA.feedback.payload);
  assert.deepEqual(await readerB.run(referenceB), savedB.feedback.payload);
  await assert.rejects(readerA.run(referenceB), { code: 'INTERACTION_UNKNOWN' });
  await assert.rejects(readerB.run(referenceA), { code: 'INTERACTION_UNKNOWN' });
  assert.equal(transport.requests.length, 0, 'restored readers and wrong-owner queries cannot dispatch');
  assert.equal(
    outputs.some((event) => event.kind === 'delta'),
    false,
    'persisted replies do not recreate process-local previews',
  );

  // Counterexample: when the host grants a global read port, a fresh manager can
  // read B's reference. No tenant claim exists in the generic reference contract.
  const unscoped = new Interactions().register(CompletionInteraction, {
    send() {
      assert.fail('read cannot send');
    },
    persistence: {
      create() {
        assert.fail('read cannot create');
      },
      commit() {
        assert.fail('read cannot commit');
      },
      read: store.readUnscoped,
    },
  });
  t.after(() => unscoped.close());
  assert.deepEqual(await createFeedbackReader(unscoped).run(referenceB), savedB.feedback.payload);
});

test('malformed feedback on one independently sent request does not fail or resend its peer', { timeout: 5000 }, async (t) => {
  const { model, transport } = createControlledProvider();
  const a = createSession({ model, label: 'A', mode: 'interaction' });
  const b = createSession({ model, label: 'B', mode: 'interaction' });
  const pending = [];
  const start = (session, input) => {
    const outcome = session.runner.run(input).then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    pending.push(outcome);
    return outcome;
  };
  t.after(async () => {
    a.runner.cancel();
    b.runner.cancel();
    transport.close();
    await Promise.all(pending);
    await Promise.all([a.interactions.settled(), b.interactions.settled()]);
    a.interactions.close();
    b.interactions.close();
  });
  const firstA = start(a, 'A:malformed');
  const requestA = await transport.waitFor(0);
  const firstB = start(b, 'B:normal');
  const requestB = await transport.waitFor(1);
  requestA.malformed();
  const failed = await firstA;
  assert.ok(failed.error instanceof ProviderError);
  assert.equal(failed.error.code, 'ENVELOPE');
  assert.equal(requestA.signal.aborted, false);
  assert.equal(b.runner.isRunning, true);
  assert.equal(requestB.signal.aborted, false);
  assert.equal(requestB.cancelled, 0);
  requestB.finish('B:answer');
  assert.deepEqual(await firstB, { value: 'B:answer' });
  assert.equal(
    a.content.transcript.snapshot().some((message) => message.role === 'assistant'),
    false,
  );
  assert.equal(b.content.transcript.snapshot().at(-1).content, 'B:answer');
  const oldRef = a.references[0];
  const failedReader = createFeedbackReader(a.interactions);
  await assert.rejects(failedReader.run(oldRef), (error) => error === failed.error);
  assert.equal(transport.requests.length, 2, 're-reading the same failure must not resend');
  const nextA = start(a, 'A:new-request');
  const nextRequest = await transport.waitFor(2);
  nextRequest.finish('A:answer');
  assert.deepEqual(await nextA, { value: 'A:answer' });
  assert.notEqual(a.references[1].id, oldRef.id, 'only a new explicit request creates a new exchange');
  assert.equal(transport.requests.length, 3);
  for (const request of transport.requests) assert.equal(request.stream.locked, false);
});
