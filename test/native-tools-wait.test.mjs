import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ModelReplyPending } from '@capix/conversation-service';
import { ResourceOffer } from '@capix/resources';
import { Node, Scene } from '@capix/structure';
import { Resources, Runner } from '@capix/server-runtime';
import { createHarness } from '../examples/native-tools/assembly.mjs';
import { ModelContract } from '../examples/native-tools/structure.mjs';
import { finalReply } from '../examples/native-tools/fixtures.mjs';
import { acceptReply } from '../examples/native-tools/protocol.mjs';
import { waitToolFeedback } from '../examples/native-tools/wait.mjs';

test('native tool local timeout leaves terminal checkpoints; a new read consumes the late reply without resending', { timeout: 10_000 }, async () => {
  const gate = Promise.withResolvers();
  const expected = finalReply('late final reply');
  const harness = createHarness({ waitMs: 5, model: () => gate.promise });
  let pending;
  try {
    await assert.rejects(harness.runner.run(harness.input()), (error) => {
      pending = error;
      return error instanceof ModelReplyPending;
    });
    assert.ok(Object.isFrozen(pending.reference));
    assert.equal(pending.reference.contract, ModelContract.key);
    assert.equal(harness.requests.length, 1);
    const root = harness.checkpoints.writes.find((item) => item.image?.frame.owner.parentContextId === undefined && item.image)?.image.frame.owner.contextId;
    assert.ok(root);
    const model = harness.checkpoints.writes.find((item) => item.image?.contract.key === 'example.native-tools.completion').image.frame.owner.contextId;
    assert.equal(harness.checkpoints.read(root).delivery.status, 'failed');
    assert.equal(harness.checkpoints.read(model).delivery.status, 'failed');
    await assert.rejects(harness.runner.resume(root), /terminal checkpoint/);

    gate.resolve(expected);
    await harness.interactions.settled();
    assert.deepEqual(harness.persistence.read(pending.reference.id).feedback.payload, acceptReply(expected));

    // This new invocation has read permission only. It neither resumes the old
    // loop nor accepts its business result or dispatches any tool operation.
    const feedback = new ResourceOffer({ methods: { read: (channel, reference, operation) => waitToolFeedback(channel, reference, operation, 0) } });
    const read = new Node({ deps: { feedback: feedback.request() }, run: (work) => work.resources.feedback.read(work.input) });
    const resources = new Resources().registerInteraction(feedback, ModelContract);
    const reader = new Runner(new Scene(read), resources, harness.interactions).build();
    assert.deepEqual(await reader.run(pending.reference), acceptReply(expected));
    assert.equal(harness.requests.length, 1);
    assert.equal(harness.exchanges.snapshot().entries.length, 0, 'reading feedback does not create a model exchange reception');
    await assert.rejects(harness.runner.resume(root), /terminal checkpoint/);
  } finally {
    gate.resolve(expected);
    await harness.close();
  }
});

test('native tool wait rejects invalid local durations before acquiring an operation or sending', async () => {
  const unused = () => assert.fail('invalid duration cannot access a channel or operation');
  for (const waitMs of [-1, 0.1, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648]) {
    await assert.rejects(waitToolFeedback({ wait: unused }, { id: 'ref', contract: ModelContract.key }, { onClose: unused }, waitMs), RangeError);
  }
});
