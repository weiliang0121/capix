import { installCallable } from './fixtures/driver.mjs';

import assert from 'node:assert/strict';

import { test } from 'node:test';

import { defineGroup, defineScene } from '@weiliang0121/capix-runtime';

import { ExceptionContract, isInvocationCancelled } from '@weiliang0121/capix-invocation';

import { ResourceOffer } from '@weiliang0121/capix-resources';

import { CallableInvocationBuilder } from '@weiliang0121/capix-runtime/construction';

function deferred() {
  return Promise.withResolvers();
}

function track(promise) {
  let settled = false;
  const result = promise.then(
    (value) => {
      settled = true;
      return { status: 'fulfilled', value };
    },
    (reason) => {
      settled = true;
      return { status: 'rejected', reason };
    },
  );
  return {
    result,
    get settled() {
      return settled;
    },
  };
}

async function assertPending(call, message) {
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(call.settled, false, message);
}

function root(builders, work, controls = {}) {
  return builders.create('initial', { kind: 'scene', description: { id: 'invocation-control-fixture' }, controls, work: { ...work } });
}

test('a normal parent waits for a started child and its finally without implicitly accepting the result', { timeout: 2000 }, async (t) => {
  const builders = new CallableInvocationBuilder();
  const body = deferred();
  const cleanup = deferred();
  const cleanupStarted = deferred();
  t.after(() => {
    body.resolve();
    cleanup.resolve();
  });
  let child;
  let childRun;
  const parent = root(builders, {
    execute(_context, owner) {
      child = builders.create('child input', {
        kind: 'group',
        parent: owner,
        work: {
          async execute() {
            try {
              await body.promise;
              return 'child output';
            } finally {
              cleanupStarted.resolve();
              await cleanup.promise;
            }
          },
        },
      });
      childRun = track(child.run());
      return 'parent output';
    },
  });
  const parentRun = track(parent.run());
  await assertPending(parentRun, 'returning from parent work does not finish the parent invocation');
  body.resolve();
  await cleanupStarted.promise;
  await assertPending(parentRun, 'a child in finally is still owned, unfinished work');
  assert.equal(childRun.settled, false);
  cleanup.resolve();
  assert.deepEqual(await childRun.result, { status: 'fulfilled', value: 'child output' });
  assert.deepEqual(await parentRun.result, { status: 'fulfilled', value: 'parent output' });
  assert.equal(parent.children.get(child).returned.output, 'child output');
  assert.equal(parent.children.get(child).reception.status, 'pending', 'waiting for exit does not accept a child result');
});

test('a created but unstarted child does not block parent completion or acquire an invented return', { timeout: 2000 }, async () => {
  const builders = new CallableInvocationBuilder();
  let child;
  const parent = root(builders, {
    execute(_context, owner) {
      child = builders.create('unused', { kind: 'group', parent: owner, work: { execute: () => assert.fail('unused child must not execute') } });
      return 'complete';
    },
  });
  assert.equal(await parent.run(), 'complete');
  assert.equal(parent.children.get(child).returned, undefined);
  assert.equal(parent.children.get(child).reception.status, 'pending');
  await assert.rejects(child.run(), /ended|closed|closing/i);
});

test('an already entered reception finishes with its original Work before the parent completes', { timeout: 2000 }, async (t) => {
  const entered = deferred();
  const release = deferred();
  t.after(() => release.resolve());
  const writes = [];
  const writer = new ResourceOffer({ name: 'test.control.reception-write', expose: (_source, activity) => ({ append: (value) => activity.runSync('append', {}, () => writes.push(value)) }) });
  const child = defineGroup()({ run: () => 'child output' });
  let reception;
  let childFacts;
  const definition = defineScene()({
    members: [child],
    deps: { writer: writer.request() },
    async run(work) {
      const call = work.children.create(child, null);
      await call.run();
      reception = track(
        call.accept(async (output) => {
          entered.resolve();
          await release.promise;
          work.resources.writer.append(output);
          assert.equal(work.children.open(call.ref).ref, call.ref, 'the original execute Work stays valid until its reception exits');
          return 'accepted child';
        }),
      );
      childFacts = () => work.children.facts.get(call.ref);
      return 'parent output';
    },
  });
  const runtime = installCallable(definition, { providers: [writer.provide(() => null)], source: { runtime: () => null, capture: () => null } });
  const parentRun = track(runtime.run(null));
  await entered.promise;
  await assertPending(parentRun, 'an asynchronous reception belongs to the parent work');
  assert.equal(childFacts().reception.status, 'receiving');
  release.resolve();
  assert.deepEqual(await reception.result, { status: 'fulfilled', value: 'accepted child' });
  assert.deepEqual(await parentRun.result, { status: 'fulfilled', value: 'parent output' });
  assert.equal(childFacts().reception.status, 'accepted');
});

for (const failureKind of ['declared', 'fault']) {
  test(`a parent ${failureKind} failure waits for started child work without invalidating its local acceptance`, { timeout: 2000 }, async (t) => {
    const builders = new CallableInvocationBuilder();
    const release = deferred();
    t.after(() => release.resolve());
    const rejected = new ExceptionContract('CONTROL_PARENT_FAILURE');
    const failure = failureKind === 'declared' ? rejected.create('parent cannot continue', {}) : new Error('parent implementation failed');
    let child;
    let childRun;
    let accepted = 0;
    const parent = root(builders, {
      execute(_context, owner) {
        child = builders.create('independent child', {
          kind: 'group',
          parent: owner,
          work: {
            async execute() {
              await release.promise;
              return 'child output';
            },
            output: {
              result(output) {
                accepted++;
                return output;
              },
            },
          },
        });
        childRun = track(child.run());
        throw failure;
      },
    });
    const parentRun = track(parent.run());
    await assertPending(parentRun, 'a failing parent still waits for actual child exit');
    release.resolve();
    assert.deepEqual(await childRun.result, { status: 'fulfilled', value: 'child output' });
    const result = await parentRun.result;
    assert.equal(result.status, 'rejected');
    assert.equal(result.reason, failure);
    assert.equal(accepted, 1);
    assert.equal(child.context.status, 'succeeded');
    assert.equal(parent.children.get(child).reception.status, 'pending');
  });
}

test('an in-flight child survives subsequent business steps in its parent run', { timeout: 2000 }, async (t) => {
  const builders = new CallableInvocationBuilder();
  const release = deferred();
  const advanced = deferred();
  t.after(() => release.resolve());
  let child;
  let childRun;
  const parent = root(builders, {
    async execute(_context, owner) {
      child = builders.create('child input', {
        kind: 'group',
        parent: owner,
        work: {
          async execute() {
            await release.promise;
            return 'child output';
          },
        },
      });
      childRun = track(child.run());
      await Promise.resolve();
      advanced.resolve();
      return 'parent output';
    },
  });
  const completion = track(parent.run());
  await advanced.promise;
  await assertPending(completion, 'subsequent local steps do not cancel the in-flight child');
  release.resolve();
  assert.deepEqual(await childRun.result, { status: 'fulfilled', value: 'child output' });
  assert.deepEqual(await completion.result, { status: 'fulfilled', value: 'parent output' });
  assert.equal(parent.context.progress.round, 1);
  assert.equal(parent.children.get(child).reception.status, 'pending');
});

test('cancellation waits for real child exit and preserves effects established before the request', { timeout: 2000 }, async (t) => {
  const builders = new CallableInvocationBuilder();
  const controller = new AbortController();
  const body = deferred();
  const cleanup = deferred();
  const cleanupStarted = deferred();
  t.after(() => {
    body.resolve();
    cleanup.resolve();
  });
  const effects = [];
  let childRun;
  const parent = root(
    builders,
    {
      execute(_context, owner) {
        const child = builders.create(null, {
          kind: 'group',
          parent: owner,
          work: {
            async execute() {
              effects.push('established');
              try {
                await body.promise;
                return 'candidate';
              } finally {
                cleanupStarted.resolve();
                await cleanup.promise;
              }
            },
            output: { result: () => assert.fail('cancelled child must not validate final output') },
          },
        });
        childRun = track(child.run());
        return 'parent candidate';
      },
    },
    { signal: controller.signal },
  );
  const parentRun = track(parent.run());
  controller.abort(new Error('stop requested'));
  await assertPending(parentRun, 'a stop request is not actual execution exit');
  body.resolve();
  await cleanupStarted.promise;
  await assertPending(parentRun, 'cancellation does not race past child cleanup');
  cleanup.resolve();
  const childResult = await childRun.result;
  const parentResult = await parentRun.result;
  assert.equal(childResult.status, 'rejected');
  assert.equal(parentResult.status, 'rejected');
  assert.equal(isInvocationCancelled(childResult.reason, controller.signal), true);
  assert.equal(isInvocationCancelled(parentResult.reason, controller.signal), true);
  assert.deepEqual(effects, ['established']);
});

test('catching an owned child fault cannot clear it or skip another started child during parent closing', { timeout: 2000 }, async (t) => {
  const builders = new CallableInvocationBuilder();
  const release = deferred();
  const caught = deferred();
  t.after(() => release.resolve());
  const failure = new Error('child implementation fault');
  let siblingRun;
  const parent = root(builders, {
    async execute(_context, owner) {
      const sibling = builders.create(null, {
        kind: 'group',
        parent: owner,
        work: {
          async execute() {
            await release.promise;
            return 'sibling output';
          },
        },
      });
      siblingRun = track(sibling.run());
      const failed = builders.create(null, {
        kind: 'group',
        parent: owner,
        work: {
          execute: () => {
            throw failure;
          },
        },
      });
      try {
        await failed.run();
      } catch (error) {
        assert.equal(error, failure);
        caught.resolve();
      }
      return 'pretend success';
    },
  });
  const parentRun = track(parent.run());
  await caught.promise;
  await assertPending(parentRun, 'the sticky fault does not bypass the other child exit');
  release.resolve();
  assert.deepEqual(await siblingRun.result, { status: 'fulfilled', value: 'sibling output' });
  const result = await parentRun.result;
  assert.equal(result.status, 'rejected');
  assert.equal(result.reason, failure);
  assert.equal(parent.context.state.error, failure);
});

test('a later reception diagnostic does not replace an unhandled parent declared exception during closing', { timeout: 2000 }, async (t) => {
  const builders = new CallableInvocationBuilder();
  const release = deferred();
  const entered = deferred();
  t.after(() => release.resolve());
  const rejected = new ExceptionContract('CONTROL_RECEPTION_DIAGNOSTIC');
  const original = rejected.create('parent cannot continue', {});
  const diagnostic = rejected.create('reception rejects another result', {});
  let reception;
  let child;
  const parent = root(builders, {
    async execute(_context, owner) {
      child = builders.create(null, { kind: 'group', parent: owner, work: { execute: () => 'child output' } });
      await child.run();
      reception = track(
        owner.children.get(child).accept(async () => {
          entered.resolve();
          await release.promise;
          throw diagnostic;
        }),
      );
      throw original;
    },
  });
  const parentRun = track(parent.run());
  await entered.promise;
  await assertPending(parentRun, 'the original failure still waits for the entered reception to exit');
  release.resolve();
  assert.equal((await reception.result).status, 'rejected');
  const result = await parentRun.result;
  assert.equal(result.status, 'rejected');
  assert.equal(result.reason, original, 'a later declared diagnostic must not turn the original declared exception into a structural fault');
  assert.equal(parent.failure.kind, 'exception');
  assert.equal(parent.context.state.error, original);
  assert.equal(parent.children.get(child).reception.error, diagnostic);
});

test('an unawaited author child fault is owned by the parent without a second unhandled Promise rejection', { timeout: 2000 }, async () => {
  const failure = new Error('unawaited author child fault');
  const child = defineGroup()({
    run() {
      throw failure;
    },
  });
  const definition = defineScene()({
    members: [child],
    run(work) {
      work.children.create(child, null).run();
      return 'parent candidate';
    },
  });
  const runtime = installCallable(definition, { providers: [], source: { capture: () => null } });
  await assert.rejects(runtime.run(null), (error) => error === failure);
  // Let Node report an unhandled wrapper Promise, if a public handle created one.
  await new Promise((resolve) => setImmediate(resolve));
});

test('an unawaited child declared failure keeps its original delivery without automatically rethrowing in the later parent phase', { timeout: 2000 }, async (t) => {
  const release = deferred();
  t.after(() => release.resolve());
  const rejected = new ExceptionContract('CONTROL_UNOBSERVED_CHILD');
  const exception = rejected.create('child declined', {});
  const child = defineGroup()({
    async run() {
      await release.promise;
      throw exception;
    },
  });
  let childFacts;
  const definition = defineScene()({
    members: [child],
    run(work) {
      const call = work.children.create(child, null);
      call.run();
      childFacts = () => work.children.facts.get(call.ref);
      return 'parent candidate';
    },
  });
  const runtime = installCallable(definition, { providers: [], source: { capture: () => null } });
  const parentRun = track(runtime.run(null));
  await assertPending(parentRun, 'the parent still joins the delayed child');
  release.resolve();
  assert.deepEqual(await parentRun.result, { status: 'fulfilled', value: 'parent candidate' });
  assert.equal(childFacts().returned.status, 'failed');
  assert.equal(childFacts().returned.failure.kind, 'exception');
  assert.equal(childFacts().reception.status, 'pending');
  await new Promise((resolve) => setImmediate(resolve));
});
