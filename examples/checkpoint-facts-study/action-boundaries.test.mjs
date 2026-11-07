import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemoryCheckpointStore } from '@capix/checkpoint';
import { isInvocationCancelled } from '@capix/invocation';
import { Scene, Node, Resources, Runner } from '@capix/server-runtime';
import { StableValues } from './stable.mjs';
import { createBoundaryCall } from './action-boundaries.mjs';
import { lifecycleBinding, lifecycleReception } from './invocation-lifecycle.mjs';

// StableValues is explicitly used by this fixture at data handoffs. Production
// Context/Relation still preserve aliases; passing these tests is not migration.
for (const enabled of [false, true]) {
  test(`private concurrent drafts are absent from CP; mixed accepted/receiving cut is valid (CP=${enabled})`, async () => {
    const fixed = new StableValues();
    const memory = new MemoryCheckpointStore();
    const store = enabled ? memory : undefined;
    const childBinding = lifecycleBinding('study.action.child');
    const reception = lifecycleReception();
    const parentBinding = lifecycleBinding('study.action.parent', { children: [{ kind: 'node', binding: childBinding }], receptions: [reception] });
    const ready = [Promise.withResolvers(), Promise.withResolvers()];
    const release = [Promise.withResolvers(), Promise.withResolvers()];
    const drafts = [];
    const relations = [];
    const images = [];
    const shared = fixed.own({ text: 'same stable child delivery' });
    let draftInspections = 0;
    const root = createBoundaryCall({
      input: fixed.own({ query: 'work' }),
      binding: parentBinding,
      store,
      async execute(_context, invocation) {
        const children = [0, 1].map((index) =>
          createBoundaryCall({
            parent: invocation,
            input: fixed.own({ index }),
            binding: childBinding,
            store,
            execute(_childContext, childInvocation) {
              if (enabled) childInvocation.checkpointWriter.save('checkpoint', { position: 'before-return' });
              return shared;
            },
          }),
        );
        await Promise.all(children.map((child) => child.run()));
        const accepting = children.map((child, index) => {
          const relation = invocation.children.get(child);
          relations.push(relation);
          return relation.accept(async (value) => {
            // Deliberately not a valid CP value. No CP promises to traverse or
            // persist this private activity-local object, nor its closure.
            const draft = new Proxy(
              { text: value.text, edits: 0, local: () => index },
              {
                ownKeys(target) {
                  draftInspections++;
                  return Reflect.ownKeys(target);
                },
              },
            );
            drafts.push(draft);
            ready[index].resolve();
            await release[index].promise;
            return fixed.own({ text: draft.text });
          }, reception);
        });
        await Promise.all(ready.map((entry) => entry.promise));
        const save = (label) => {
          if (enabled) images.push(invocation.checkpointWriter.save('checkpoint', { label }));
        };
        save('both-receiving');
        drafts[0].text = 'A';
        drafts[1].text = 'B';
        release[0].resolve();
        const first = await accepting[0];
        save('A-accepted-B-receiving');
        for (let index = 0; index < 1000; index++) drafts[1].edits++;
        save('B-still-receiving');
        assert.equal(relations[0].reception.output, first);
        assert.equal(relations[1].reception.status, 'receiving');
        assert.equal('output' in relations[1].reception, false);
        drafts[0].text = 'producer edits after publication';
        assert.equal(first.text, 'A');
        release[1].resolve();
        const second = await accepting[1];
        save('both-accepted');
        return fixed.own([first, second]);
      },
    });
    assert.deepEqual(await root.run(), [{ text: 'A' }, { text: 'B' }]);
    assert.equal(draftInspections, 0);
    assert.equal(relations[0].returned.output, shared);
    assert.equal(relations[1].returned.output, shared);
    assert.notEqual(relations[0].invocation.context.id, relations[1].invocation.context.id);
    if (enabled) {
      assert.deepEqual(
        images.map((image) => image.frame.children.map((child) => child.state.reception.kind)),
        [
          ['receiving', 'receiving'],
          ['accepted', 'receiving'],
          ['accepted', 'receiving'],
          ['accepted', 'accepted'],
        ],
      );
      assert.deepEqual(images[1].frame, images[2].frame, 'Private edits do not change the call facts');
      assert.equal(JSON.stringify(images).includes('producer edits'), false);
      assert.equal(JSON.stringify(images).includes('edits'), false);
      assert.equal(memory.read(root.context.id).delivery.status, 'succeeded');
    } else assert.equal(memory.read(root.context.id), undefined);
  });
}

for (const guarded of [false, true]) {
  test(`cancellation during an already-entered receiver: current behavior vs proposed publication guard (${guarded})`, async () => {
    const fixed = new StableValues();
    const control = new AbortController();
    const ready = Promise.withResolvers();
    const release = Promise.withResolvers();
    let relation;
    let candidate;
    const root = createBoundaryCall({
      signal: control.signal,
      async execute(_context, invocation) {
        const child = createBoundaryCall({ parent: invocation, signal: control.signal, execute: () => fixed.own({ text: 'child' }) });
        await child.run();
        relation = invocation.children.get(child);
        return relation.accept(async (value) => {
          const draft = { text: value.text };
          ready.resolve();
          await release.promise;
          draft.text += ' accepted';
          candidate = fixed.own(draft);
          // Experimental guard only. This is not installed in production.
          if (guarded) invocation.requireActive();
          return candidate;
        });
      },
    });
    const failed = assert.rejects(root.run(), (error) => isInvocationCancelled(error, control.signal));
    await ready.promise;
    assert.equal(relation.reception.status, 'receiving');
    control.abort(new Error('stop during mapping'));
    release.resolve();
    await failed;
    assert.equal(root.context.status, 'failed');
    assert.equal(relation.returned.status, 'succeeded');
    assert.ok(Object.isFrozen(candidate));
    assert.equal(relation.reception.status, guarded ? 'failed' : 'accepted');
    if (!guarded) assert.equal(relation.reception.output, candidate);
  });
}

test('public Runner has the same late-acceptance boundary; final cancellation does not roll back acceptance', async () => {
  const ready = Promise.withResolvers();
  const release = Promise.withResolvers();
  const child = new Node({ run: () => ({ value: 1 }) });
  const scene = new Scene().add({ child });
  scene.run = (work) =>
    work.children.child.invoke(work.input, {
      result: {
        async succeeded(value) {
          ready.resolve();
          await release.promise;
          return value;
        },
      },
    });
  const runner = new Runner(scene, new Resources()).build();
  const relations = [];
  runner.observation.subscribe({
    receive(event) {
      if (event.source === 'invocation' && event.fact.kind === 'relation') relations.push(event.fact.phase);
    },
  });
  const failure = assert.rejects(runner.run(null));
  await ready.promise;
  assert.equal(runner.cancel('stop while reception is suspended'), true);
  release.resolve();
  await failure;
  assert.ok(relations.includes('receiving'));
  assert.ok(relations.includes('accepted'));
  assert.equal(runner.isRunning, false);
});

test('a callback-end guard is not a kernel publication guard: reception check can synchronously cancel', async () => {
  const control = new AbortController();
  let relation;
  const root = createBoundaryCall({
    signal: control.signal,
    async execute(_context, invocation) {
      const child = createBoundaryCall({ parent: invocation, signal: control.signal, execute: () => 42 });
      await child.run();
      relation = invocation.children.get(child);
      const contract = {
        ...lifecycleReception(),
        check() {
          control.abort('cancel inside synchronous reception check');
        },
      };
      return relation.accept((value) => {
        invocation.requireActive();
        return value;
      }, contract);
    },
  });
  await assert.rejects(root.run(), (error) => isInvocationCancelled(error, control.signal));
  assert.equal(relation.reception.status, 'accepted');
  assert.equal(relation.reception.output, 42);
  assert.equal(root.context.status, 'failed');
});

test('equal stable content does not coalesce two distinct accepted relations', async () => {
  const fixed = new StableValues();
  const value = fixed.own({ answer: 42 });
  const store = new MemoryCheckpointStore();
  const childBinding = lifecycleBinding('study.equal.child');
  const reception = lifecycleReception();
  const binding = lifecycleBinding('study.equal.parent', { children: [{ kind: 'node', binding: childBinding }], receptions: [reception] });
  let image;
  const root = createBoundaryCall({
    store,
    binding,
    async execute(_context, invocation) {
      for (let index = 0; index < 2; index++) {
        const child = createBoundaryCall({ parent: invocation, input: index, store, binding: childBinding, execute: () => value });
        await child.run();
        assert.equal(await invocation.children.get(child).accept((output) => fixed.own(output), reception), value);
      }
      image = invocation.checkpointWriter.save('checkpoint', { complete: true });
      return value;
    },
  });
  assert.equal(await root.run(), value);
  assert.equal(image.frame.children.length, 2);
  assert.notEqual(image.frame.children[0].identity.contextId, image.frame.children[1].identity.contextId);
  assert.deepEqual(
    image.frame.children.map((child) => child.order),
    [0, 1],
  );
  assert.deepEqual(
    image.frame.children.map((child) => child.state.reception.kind),
    ['accepted', 'accepted'],
  );
});
