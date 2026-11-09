import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemoryCheckpointStore } from '@weiliang0121/capix-checkpoint';
import { isInvocationCancelled, invocationResourceFailures } from '@weiliang0121/capix-invocation';
import { Resource, ResourceOffer, Resources } from '@weiliang0121/capix-resources';
import { StableValues } from './stable.mjs';
import { createBoundaryCall } from './action-boundaries.mjs';
import { lifecycleBinding, lifecycleReception } from './invocation-lifecycle.mjs';

// Experiment-only handoff, explicitly inserted into the receiver. It does not
// patch Relation or install automatic stability in production. Fixing failure
// is reported through the existing protected endpoint, including thrown
// undefined; an ordinary callback throw alone would not supply that guarantee.
function fixedReceiver(invocation, stable, callback) {
  return async (delivered) => {
    const candidate = await callback(delivered);
    try {
      return stable.own(candidate);
    } catch (cause) {
      const error = new Error('Study stable reception rejected', { cause });
      invocation.reject(error);
      throw error;
    }
  };
}

function bindings(reception) {
  const child = lifecycleBinding('study.reception-establishment.child');
  const parent = lifecycleBinding('study.reception-establishment.parent', { children: [{ kind: 'node', binding: child }], receptions: [reception] });
  return { child, parent };
}

async function returnedChild(invocation, { kind, binding, store, stable, signal }) {
  const failure = new Error('business child failure');
  const child = createBoundaryCall({
    parent: invocation,
    input: stable.own({ input: 'fixed child input' }),
    binding,
    store,
    signal,
    execute(_context, current) {
      current.checkpointWriter?.save('checkpoint', { step: 'before-return' });
      if (kind === 'handled') throw failure;
      return stable.own({ text: 'child output' });
    },
  });
  const relation = invocation.children.get(child);
  if (kind === 'handled') {
    relation.receiveFailures();
    await assert.rejects(child.run(), (error) => error === failure);
  } else await child.run();
  return { child, relation, failure };
}

for (const enabled of [false, true]) {
  for (const kind of ['accepted', 'handled']) {
    test(`stable ${kind} value is checked before installation with unchanged contract (CP=${enabled})`, async () => {
      const stable = new StableValues();
      const memory = new MemoryCheckpointStore();
      const store = enabled ? memory : undefined;
      const draft = { text: 'formal value', nested: { count: 1 } };
      let relation;
      let child;
      let saved;
      let fixingComplete = false;
      let saving = false;
      let establishmentChecks = 0;
      let saveChecks = 0;
      const reception = {
        ...lifecycleReception(),
        check(value) {
          if (saving) saveChecks++;
          else {
            establishmentChecks++;
            assert.equal(fixingComplete, true);
            assert.equal(relation.reception.status, 'receiving');
            assert.equal(Object.hasOwn(relation.reception, 'output'), false);
            assert.ok(Object.isFrozen(value));
            assert.ok(Object.isFrozen(value.nested));
            assert.notEqual(value, draft);
          }
          assert.deepEqual(value, { text: 'formal value', nested: { count: 1 } });
          // A validator's return value is not a replacement or transformation.
          return { ignored: true };
        },
      };
      const declared = bindings(reception);
      const root = createBoundaryCall({
        binding: declared.parent,
        store,
        async execute(_context, invocation) {
          const returned = await returnedChild(invocation, { kind, binding: declared.child, store, stable });
          relation = returned.relation;
          child = returned.child;
          const receive = fixedReceiver(invocation, stable, (delivered) => {
            assert.equal(delivered, kind === 'handled' ? returned.failure : relation.returned.output);
            return draft;
          });
          const callback = async (delivered) => {
            const value = await receive(delivered);
            fixingComplete = true;
            return value;
          };
          const accepted = await relation[kind === 'handled' ? 'handle' : 'accept'](callback, reception);
          draft.text = 'producer edits original after acceptance';
          draft.nested.count = 999;
          assert.deepEqual(accepted, { text: 'formal value', nested: { count: 1 } });
          assert.equal(relation.reception.output, accepted);
          if (enabled) {
            saving = true;
            try {
              saved = invocation.checkpointWriter.save('checkpoint', { phase: kind });
            } finally {
              saving = false;
            }
          }
          return accepted;
        },
      });
      assert.deepEqual(await root.run(), { text: 'formal value', nested: { count: 1 } });
      assert.equal(establishmentChecks, 1, 'The same declared contract runs without a CP writer');
      assert.equal(saveChecks, enabled ? 1 : 0, 'The actual v5 path still checks during save');
      assert.equal(relation.reception.status, kind);
      assert.equal(relation.reception.contract, reception);
      assert.equal(child.context.status, kind === 'handled' ? 'failed' : 'succeeded');
      assert.equal(relation.returned.status, kind === 'handled' ? 'failed' : 'succeeded');
      assert.equal(Object.isFrozen(draft), false);
      if (enabled) {
        assert.equal(saved.frame.children[0].state.reception.kind, kind);
        assert.deepEqual(saved.frame.children[0].state.reception.output, { text: 'formal value', nested: { count: 1 } });
        assert.equal(memory.read(root.context.id).delivery.status, 'succeeded');
      } else assert.equal(memory.read(root.context.id), undefined);
    });

    test(`invalid fixed ${kind} material is not installed; catching the check cannot authorize success (CP=${enabled})`, async () => {
      const stable = new StableValues();
      const memory = new MemoryCheckpointStore();
      const store = enabled ? memory : undefined;
      let relation;
      let checks = 0;
      let rejection;
      const reception = {
        ...lifecycleReception(),
        check(value) {
          checks++;
          assert.ok(Object.isFrozen(value));
          assert.equal(relation.reception.status, 'receiving');
          throw undefined;
        },
      };
      const declared = bindings(reception);
      const root = createBoundaryCall({
        binding: declared.parent,
        store,
        async execute(_context, invocation) {
          relation = (await returnedChild(invocation, { kind, binding: declared.child, store, stable })).relation;
          await assert.rejects(
            relation[kind === 'handled' ? 'handle' : 'accept'](
              fixedReceiver(invocation, stable, () => ({ invalid: true })),
              reception,
            ),
            (error) => {
              rejection = error;
              return error instanceof Error && error.message === 'Parent reception value violates its contract' && Object.hasOwn(error, 'cause') && error.cause === undefined;
            },
          );
          assert.equal(relation.reception.status, 'failed');
          assert.equal(Object.hasOwn(relation.reception, 'output'), false);
          return 'catch must not turn rejection into a successful parent';
        },
      });
      await assert.rejects(root.run(), (error) => error === rejection);
      assert.equal(checks, 1);
      assert.equal(root.context.status, 'failed');
      assert.equal(relation.reception.status, 'failed');
    });
  }
}

for (const enabled of [false, true]) {
  for (const broken of ['unsupported-value', 'proxy-throws-undefined']) {
    test(`fixing rejection remains protected across an ancestor receiver (${broken}, CP=${enabled})`, async () => {
      const stable = new StableValues();
      const memory = new MemoryCheckpointStore();
      const store = enabled ? memory : undefined;
      let relation;
      let outerRelation;
      let checks = 0;
      let fallbackRuns = 0;
      let fixingFailure;
      const reception = { ...lifecycleReception(), check: () => checks++ };
      const declared = bindings(reception);
      const root = createBoundaryCall({
        async execute(_context, invocation) {
          const middle = createBoundaryCall({
            parent: invocation,
            binding: declared.parent,
            store,
            async execute(_middleContext, current) {
              relation = (await returnedChild(current, { kind: 'accepted', binding: declared.child, store, stable })).relation;
              const candidate =
                broken === 'unsupported-value'
                  ? { callback() {} }
                  : new Proxy(
                      {},
                      {
                        ownKeys() {
                          throw undefined;
                        },
                      },
                    );
              try {
                return await relation.accept(
                  fixedReceiver(current, stable, () => candidate),
                  reception,
                );
              } catch (error) {
                fixingFailure = error;
                throw error;
              }
            },
          });
          outerRelation = invocation.children.get(middle);
          outerRelation.receiveFailures();
          await assert.rejects(middle.run(), (error) => error === fixingFailure);
          assert.equal(outerRelation.returned.failure.receptionAllowed, false);
          await assert.rejects(
            outerRelation.handle(() => {
              fallbackRuns++;
              return 'masked';
            }),
            /no receivable failed delivery/,
          );
          return 'masked parent';
        },
      });
      await assert.rejects(root.run(), (error) => error === fixingFailure);
      assert.equal(fixingFailure.message, 'Study stable reception rejected');
      assert.equal(Object.hasOwn(fixingFailure, 'cause'), true);
      if (broken === 'proxy-throws-undefined') assert.equal(fixingFailure.cause, undefined);
      assert.equal(checks, 0, 'Fixing failed before fixed-contract validation');
      assert.equal(fallbackRuns, 0);
      assert.equal(relation.reception.status, 'failed');
      assert.equal(Object.hasOwn(relation.reception, 'output'), false);
      assert.equal(outerRelation.reception.status, 'pending');
    });
  }
}

test('the stable handoff does not reclassify a business callback failure as a fixing failure', async () => {
  const stable = new StableValues();
  const failure = new Error('business declined this child result');
  let innerRelation;
  let outerRelation;
  let checks = 0;
  let fallbackRuns = 0;
  const reception = { ...lifecycleReception(), check: () => checks++ };
  const root = createBoundaryCall({
    async execute(_context, invocation) {
      const middle = createBoundaryCall({
        parent: invocation,
        async execute(_middleContext, current) {
          innerRelation = (await returnedChild(current, { kind: 'accepted', stable })).relation;
          return innerRelation.accept(
            fixedReceiver(current, stable, () => {
              throw failure;
            }),
            reception,
          );
        },
      });
      outerRelation = invocation.children.get(middle);
      outerRelation.receiveFailures();
      await assert.rejects(middle.run(), (error) => error === failure);
      assert.equal(outerRelation.returned.failure.receptionAllowed, true);
      return outerRelation.handle((error) => {
        fallbackRuns++;
        assert.equal(error, failure);
        return stable.own({ fallback: true });
      });
    },
  });
  assert.deepEqual(await root.run(), { fallback: true });
  assert.equal(innerRelation.reception.status, 'failed');
  assert.equal(outerRelation.reception.status, 'handled');
  assert.equal(checks, 0);
  assert.equal(fallbackRuns, 1);
});

for (const useResource of [false, true]) {
  test(`fixed reception keeps existing cancellation semantics; resource access=${useResource}`, async () => {
    const stable = new StableValues();
    const controller = new AbortController();
    const ready = Promise.withResolvers();
    const release = Promise.withResolvers();
    const origin = { reads: 0 };
    const offer = new ResourceOffer({
      methods: {
        read(source) {
          source.reads++;
          return 'resource value';
        },
      },
    });
    const resource = new Resources().register(new Resource(origin), offer).bind({ source: offer.request() });
    let access;
    let relation;
    let checks = 0;
    const reception = {
      ...lifecycleReception(),
      check(value) {
        checks++;
        assert.ok(Object.isFrozen(value));
      },
    };
    const root = createBoundaryCall({
      signal: controller.signal,
      async execute(_context, invocation) {
        access = resource.open({ contextId: invocation.context.id, failures: invocationResourceFailures, signal: controller.signal, validate: () => invocation.requireActive(), error: (error, allowed) => invocation.reject(error, allowed) });
        relation = (await returnedChild(invocation, { kind: 'accepted', stable, signal: controller.signal })).relation;
        return relation.accept(
          fixedReceiver(invocation, stable, async () => {
            ready.resolve();
            await release.promise;
            return { text: useResource ? await access.endpoints.source.read() : 'local completion' };
          }),
          reception,
        );
      },
    });
    try {
      const failed = assert.rejects(root.run(), (error) => isInvocationCancelled(error, controller.signal));
      await ready.promise;
      assert.equal(relation.reception.status, 'receiving');
      controller.abort('stop while receiver is waiting');
      release.resolve();
      await failed;
      assert.equal(root.context.status, 'failed');
      assert.equal(relation.returned.status, 'succeeded');
      assert.equal(relation.reception.status, useResource ? 'failed' : 'accepted');
      assert.equal(checks, useResource ? 0 : 1);
      assert.equal(origin.reads, 0, 'Cancellation never restores permission to use a resource');
      if (!useResource) assert.deepEqual(relation.reception.output, { text: 'local completion' });
    } finally {
      access?.close();
    }
  });
}
