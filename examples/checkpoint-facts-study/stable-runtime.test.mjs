import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Invocation, InvocationContext, isInvocationCancelled } from '@weiliang0121/capix-invocation';
import { MemoryCheckpointStore } from '@weiliang0121/capix-checkpoint';
import { StableValues } from './stable.mjs';

// Real public Invocation paths, with explicit experimental ownership at producer
// boundaries. These tests do NOT install a new kernel policy, convert arbitrary
// business values, or exercise production restore/host recovery eligibility.
const codec = { encode: (value) => value, decode: (value) => value };

test('real three-level delivery: fixed input, return and acceptance agree with CP on/off', async () => {
  async function run(checkpointsEnabled) {
    const fixed = new StableValues();
    const store = new MemoryCheckpointStore();
    const inputRaw = { query: { text: 'hello' } };
    const outputRaw = { detail: { text: 'child result' } };
    const acceptanceRaw = { detail: { text: 'parent result' } };
    const input = fixed.own(inputRaw);
    const rootContext = new InvocationContext(input);
    const signal = new AbortController().signal;
    const snapshots = [];
    const contexts = [rootContext];
    const leafBinding = { key: 'study.stable.child', version: 1, input: codec, output: codec, points: {} };
    const parentBinding = {
      key: 'study.stable.parent',
      version: 1,
      input: codec,
      output: codec,
      children: [{ kind: 'node', binding: leafBinding }],
      points: { accepted: { state: codec, execute: () => assert.fail('unexpected restore') } },
    };
    let childRelation;
    let parentRelation;
    let fixedChild;
    let fixedAccepted;
    const root = new Invocation({
      context: rootContext,
      signal,
      identity: { contextId: rootContext.id, kind: 'scene' },
      work: {
        async execute(_context, invocation) {
          inputRaw.query.text = 'caller changed its original';
          assert.equal(invocation.context.input.query.text, 'hello');
          assert.throws(() => {
            invocation.context.input.query.text = 'consumer changed the input';
          }, TypeError);
          const parentContext = new InvocationContext(fixed.own(input));
          contexts.push(parentContext);
          const parent = new Invocation({
            context: parentContext,
            signal,
            identity: { contextId: parentContext.id, parentContextId: rootContext.id, kind: 'group' },
            parent: { invocation, declarationPosition: 0 },
            ...(checkpointsEnabled ? { checkpoints: { store } } : {}),
            work: {
              checkpoint: parentBinding,
              async execute(_parentContext, parentInvocation) {
                const childContext = new InvocationContext(fixed.own(input));
                contexts.push(childContext);
                const child = new Invocation({
                  context: childContext,
                  signal,
                  identity: { contextId: childContext.id, parentContextId: parentContext.id, kind: 'node' },
                  parent: { invocation: parentInvocation, declarationPosition: 0 },
                  ...(checkpointsEnabled ? { checkpoints: { store } } : {}),
                  work: {
                    checkpoint: leafBinding,
                    execute() {
                      fixedChild = fixed.own(outputRaw);
                      return fixedChild;
                    },
                  },
                });
                assert.equal(await child.run(), fixedChild);
                childRelation = parentInvocation.children.get(child);
                outputRaw.detail.text = 'producer changed after delivery';
                assert.equal(childRelation.returned.output.detail.text, 'child result');
                assert.throws(() => {
                  childRelation.returned.output.detail.text = 'parent mutates child';
                }, TypeError);
                fixedAccepted = await childRelation.accept((delivered) => {
                  assert.equal(delivered, fixedChild);
                  return fixed.own(acceptanceRaw);
                });
                assert.notEqual(fixedAccepted, fixedChild);
                if (checkpointsEnabled) snapshots.push(parentInvocation.checkpointWriter.save('accepted', null));
                acceptanceRaw.detail.text = 'mapper changed after acceptance';
                assert.throws(() => {
                  fixedAccepted.detail.text = 'consumer changed acceptance';
                }, TypeError);
                if (checkpointsEnabled) snapshots.push(parentInvocation.checkpointWriter.save('accepted', null));
                assert.equal(childRelation.reception.output, fixedAccepted);
                const visits = fixed.visits;
                assert.equal(fixed.own(fixedAccepted), fixedAccepted);
                assert.equal(fixed.visits, visits, 'Trusted forwarding should not revisit the body');
                return fixedAccepted;
              },
            },
          });
          assert.equal(await parent.run(), fixedAccepted);
          parentRelation = invocation.children.get(parent);
          return parentRelation.accept((delivered) => {
            assert.equal(delivered, fixedAccepted);
            const visits = fixed.visits;
            const forwarded = fixed.own(delivered);
            assert.equal(fixed.visits, visits);
            return forwarded;
          });
        },
      },
    });
    const result = await root.run();
    assert.equal(result, fixedAccepted);
    assert.equal(parentRelation.returned.output, fixedAccepted);
    assert.equal(parentRelation.reception.output, fixedAccepted);
    assert.equal(childRelation.returned.output, fixedChild);
    assert.notEqual(childRelation, parentRelation);
    assert.equal(new Set(contexts.map((context) => context.id)).size, 3);
    assert.ok(contexts.every((context) => context.input === input));
    assert.equal(snapshots.length, checkpointsEnabled ? 2 : 0);
    assert.equal(store.read(contexts[1].id)?.delivery?.status, checkpointsEnabled ? 'succeeded' : undefined);
    for (const image of snapshots) {
      assert.deepEqual(image.frame.input, input);
      assert.deepEqual(image.frame.children[0].state.output, fixedChild);
      assert.deepEqual(image.frame.children[0].state.reception.output, fixedAccepted);
    }
    return { input, returned: fixedChild, accepted: fixedAccepted, result };
  }
  assert.deepEqual(await run(false), await run(true));
});

test('real Work close failure: a fixed candidate does not become a successful child delivery', async () => {
  const fixed = new StableValues();
  const raw = { text: 'body candidate' };
  const closeError = new Error('required close failed');
  const signal = new AbortController().signal;
  const rootContext = new InvocationContext(null);
  let relation;
  let candidate;
  let accepted = false;
  const root = new Invocation({
    context: rootContext,
    signal,
    identity: { contextId: rootContext.id, kind: 'group' },
    work: {
      async execute(_context, invocation) {
        const childContext = new InvocationContext(null);
        const child = new Invocation({
          context: childContext,
          signal,
          identity: { contextId: childContext.id, parentContextId: rootContext.id, kind: 'node' },
          parent: { invocation, declarationPosition: 0 },
          work: {
            execute() {
              candidate = fixed.own(raw);
              return candidate;
            },
            close() {
              return { status: 'failed', failure: closeError };
            },
          },
        });
        relation = invocation.children.get(child);
        await child.run();
        accepted = true;
        return relation.accept((value) => value);
      },
    },
  });
  await assert.rejects(root.run(), (error) => error === closeError);
  raw.text = 'changed after failure';
  assert.equal(candidate.text, 'body candidate');
  assert.equal(accepted, false);
  assert.equal(relation.returned.status, 'failed');
  assert.equal(relation.returned.error, closeError);
  assert.equal(relation.reception.status, 'pending');
  // Preserve live catch identity; the candidate diagnostic is separate data.
  // This models the desired diagnostic boundary, not a production formatter change.
  const diagnostic = fixed.own({ name: closeError.name, message: closeError.message });
  closeError.message = 'changed live error';
  assert.equal(relation.returned.error, closeError);
  assert.equal(diagnostic.message, 'required close failed');
});

test('real cancellation after fixing: candidate stability does not authorize delivery', async () => {
  const fixed = new StableValues();
  const controller = new AbortController();
  const ready = Promise.withResolvers();
  const release = Promise.withResolvers();
  const raw = { text: 'candidate before cancellation' };
  const rootContext = new InvocationContext(null);
  let relation;
  let candidate;
  const root = new Invocation({
    context: rootContext,
    signal: controller.signal,
    identity: { contextId: rootContext.id, kind: 'group' },
    work: {
      async execute(_context, invocation) {
        const childContext = new InvocationContext(null);
        const child = new Invocation({
          context: childContext,
          signal: controller.signal,
          identity: { contextId: childContext.id, parentContextId: rootContext.id, kind: 'node' },
          parent: { invocation, declarationPosition: 0 },
          work: {
            async execute() {
              candidate = fixed.own(raw);
              ready.resolve();
              await release.promise;
              return candidate;
            },
          },
        });
        relation = invocation.children.get(child);
        return child.run();
      },
    },
  });
  const running = root.run();
  const rejected = assert.rejects(running, (error) => isInvocationCancelled(error, controller.signal));
  await ready.promise;
  controller.abort(new Error('caller cancelled'));
  raw.text = 'late producer mutation';
  release.resolve();
  await rejected;
  assert.equal(candidate.text, 'candidate before cancellation');
  assert.equal(relation.returned.status, 'failed');
  assert.ok(isInvocationCancelled(relation.returned.error, controller.signal));
  assert.equal(relation.reception.status, 'pending');
});

test('real reception: mutating a stable child value fails acceptance without rewriting its returned fact', async () => {
  const fixed = new StableValues();
  const value = fixed.own({ text: 'child text' });
  const signal = new AbortController().signal;
  const rootContext = new InvocationContext(null);
  let relation;
  let mutationError;
  const root = new Invocation({
    context: rootContext,
    signal,
    identity: { contextId: rootContext.id, kind: 'group' },
    work: {
      async execute(_context, invocation) {
        const childContext = new InvocationContext(null);
        const child = new Invocation({
          context: childContext,
          signal,
          identity: { contextId: childContext.id, parentContextId: rootContext.id, kind: 'node' },
          parent: { invocation, declarationPosition: 0 },
          work: { execute: () => value },
        });
        await child.run();
        relation = invocation.children.get(child);
        return relation.accept((delivered) => {
          try {
            delivered.text = 'parent rewrites child';
          } catch (error) {
            mutationError = error;
            throw error;
          }
          return delivered;
        });
      },
    },
  });
  await assert.rejects(root.run(), (error) => error instanceof TypeError && error === mutationError);
  assert.equal(relation.returned.status, 'succeeded');
  assert.equal(relation.returned.output, value);
  assert.equal(value.text, 'child text');
  assert.equal(relation.reception.status, 'failed');
  assert.equal(relation.reception.error, mutationError);
  assert.equal(Object.hasOwn(relation.reception, 'output'), false);
});

test('real required CP finish failure: stable body result does not authorize successful parent delivery or a retry', async () => {
  for (const committedBeforeThrow of [false, true]) {
    const fixed = new StableValues();
    const memory = new MemoryCheckpointStore();
    const finishError = new Error('finish acknowledgement unavailable');
    const raw = { text: 'stable body result' };
    const counters = { execute: 0, save: 0, finish: 0, accepted: 0 };
    let savedHead;
    let submittedDelivery;
    const store = {
      read: (id) => memory.read(id),
      save(image, revision) {
        counters.save++;
        const receipt = memory.save(image, revision);
        savedHead = memory.read(image.frame.owner.contextId);
        return receipt;
      },
      finish(id, revision, delivery) {
        counters.finish++;
        submittedDelivery = delivery;
        if (committedBeforeThrow) memory.finish(id, revision, delivery);
        raw.text = 'producer alias changed during failing finish';
        throw finishError;
      },
    };
    const signal = new AbortController().signal;
    const rootContext = new InvocationContext(null);
    let childContext;
    let relation;
    let candidate;
    const root = new Invocation({
      context: rootContext,
      signal,
      identity: { contextId: rootContext.id, kind: 'group' },
      work: {
        async execute(_context, invocation) {
          childContext = new InvocationContext(fixed.own({ query: 'work' }));
          const child = new Invocation({
            context: childContext,
            signal,
            identity: { contextId: childContext.id, parentContextId: rootContext.id, kind: 'node' },
            parent: { invocation, declarationPosition: 0 },
            checkpoints: { store },
            work: {
              checkpoint: {
                key: 'study.stable.finish-failure',
                version: 1,
                input: codec,
                output: codec,
                points: { prepared: { state: codec, execute: () => assert.fail('unexpected restore') } },
              },
              execute(_childContext, childInvocation) {
                counters.execute++;
                candidate = fixed.own(raw);
                childInvocation.checkpointWriter.save('prepared', { candidate });
                return candidate;
              },
            },
          });
          relation = invocation.children.get(child);
          await child.run();
          counters.accepted++;
          return relation.accept((value) => value);
        },
      },
    });
    await assert.rejects(root.run(), /finish acknowledgement unavailable/);
    assert.deepEqual(counters, { execute: 1, save: 1, finish: 1, accepted: 0 });
    assert.equal(candidate.text, 'stable body result');
    assert.equal(childContext.status, 'succeeded', 'Body completion is distinct from final delivery');
    assert.equal(childContext.state.output, candidate);
    assert.equal(relation.returned.status, 'failed');
    assert.equal(relation.returned.failure.receptionAllowed, false);
    assert.equal(relation.reception.status, 'pending');
    assert.deepEqual(submittedDelivery.output, candidate);
    assert.deepEqual(savedHead.image.state.candidate, candidate);
    assert.equal(savedHead.revision, 1);
    assert.equal(savedHead.delivery, undefined);
    const currentHead = memory.read(childContext.id);
    assert.equal(currentHead.image, savedHead.image, 'Finishing cannot rewrite the established checkpoint image');
    assert.equal(currentHead.revision, committedBeforeThrow ? 2 : 1);
    assert.equal(currentHead.delivery?.status, committedBeforeThrow ? 'succeeded' : undefined);
    // A throwing finish is intentionally ambiguous to the caller. The kernel
    // must not retry the write, rerun the body, or replace a possible committed
    // success with a fabricated failed delivery in the Store.
  }
});
