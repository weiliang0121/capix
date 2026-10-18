import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ExceptionContract, ResourceOffer, assembleRuntime, defineExecution, defineRuntime, isInvocationCancelled } from '@capix/server-runtime';
import { createInvocationBuilders } from '@capix/server-runtime/construction';

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
  return builders.runtime.create('initial', { description: { id: 'invocation-control-fixture' }, controls, work: { maxRounds: 1, ...work } });
}

test('a normal parent waits for a started child and its finally without implicitly accepting the result', { timeout: 2000 }, async (t) => {
  const builders = createInvocationBuilders();
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
      child = builders.execution.create(owner, 'child input', {
        work: {
          maxRounds: 1,
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
  const builders = createInvocationBuilders();
  let child;
  const parent = root(builders, {
    execute(_context, owner) {
      child = builders.execution.create(owner, 'unused', { work: { maxRounds: 1, execute: () => assert.fail('unused child must not execute') } });
      return 'complete';
    },
  });
  assert.equal(await parent.run(), 'complete');
  assert.equal(parent.children.get(child).returned, undefined);
  assert.equal(parent.children.get(child).reception.status, 'pending');
  await assert.rejects(child.run(), /ended|closed|closing/i);
});

test('an already entered reception finishes with its original Work before the parent changes phase', { timeout: 2000 }, async (t) => {
  const entered = deferred();
  const release = deferred();
  t.after(() => release.resolve());
  const writes = [];
  const writer = new ResourceOffer('test.control.reception-write', (_source, activity) => ({ append: (value) => activity.runSync('append', {}, () => writes.push(value)) }));
  const child = defineExecution()({ run: { execute: () => 'child output' } });
  let reception;
  let parentAccepted = false;
  let childFacts;
  const definition = defineRuntime()({
    children: [child],
    run: {
      requires: { writer: writer.request() },
      uses: [child],
      async execute(work) {
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
      accept(work) {
        parentAccepted = true;
        assert.deepEqual(writes, ['child output']);
        return work.delivered;
      },
    },
  });
  const runtime = assembleRuntime(definition, { providers: [writer.provide(() => null)], source: { runtime: () => null, capture: () => null } });
  const parentRun = track(runtime.run(null));
  await entered.promise;
  await assertPending(parentRun, 'an asynchronous reception belongs to the parent work');
  assert.equal(parentAccepted, false, 'parent acceptance cannot overtake an entered execute-stage reception');
  assert.equal(childFacts().reception.status, 'receiving');
  release.resolve();
  assert.deepEqual(await reception.result, { status: 'fulfilled', value: 'accepted child' });
  assert.deepEqual(await parentRun.result, { status: 'fulfilled', value: 'parent output' });
  assert.equal(childFacts().reception.status, 'accepted');
});

for (const failureKind of ['declared', 'fault']) {
  test(`a parent ${failureKind} failure waits for started child work without invalidating its local acceptance`, { timeout: 2000 }, async (t) => {
    const builders = createInvocationBuilders();
    const release = deferred();
    t.after(() => release.resolve());
    const rejected = new ExceptionContract('CONTROL_PARENT_FAILURE');
    const failure = failureKind === 'declared' ? rejected.create('parent cannot continue', {}) : new Error('parent implementation failed');
    let child;
    let childRun;
    let accepted = 0;
    const parent = root(builders, {
      raises: failureKind === 'declared' ? [rejected] : [],
      execute(_context, owner) {
        child = builders.execution.create(owner, 'independent child', {
          work: {
            maxRounds: 1,
            async execute() {
              await release.promise;
              return 'child output';
            },
            accept(_context, output) {
              accepted++;
              return output;
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

for (const transition of ['receive', 'next-round']) {
  test(`a started child survives its parent's ordinary ${transition} transition`, { timeout: 2000 }, async (t) => {
    const builders = createInvocationBuilders();
    const entered = deferred();
    const release = deferred();
    t.after(() => release.resolve());
    let child;
    let childRun;
    let accepted = 0;
    const parent = root(builders, {
      maxRounds: transition === 'next-round' ? 2 : 1,
      execute(context, owner) {
        if (context.progress.round === 2) {
          entered.resolve();
          return 'parent output';
        }
        child = builders.execution.create(owner, 'child input', {
          work: {
            maxRounds: 1,
            async execute() {
              await release.promise;
              return 'child output';
            },
            accept(_context, output) {
              accepted++;
              return output;
            },
          },
        });
        childRun = track(child.run());
        return 'parent output';
      },
      accept(context, output) {
        if (transition === 'next-round' && context.progress.round === 1) return context.continueWith('next', 'continue independently of the started child');
        if (transition === 'receive') entered.resolve();
        return output;
      },
    });
    const parentRun = track(parent.run());
    await entered.promise;
    await assertPending(parentRun, 'the parent may advance locally while still owning started child work');
    release.resolve();
    assert.deepEqual(await childRun.result, { status: 'fulfilled', value: 'child output' });
    assert.deepEqual(await parentRun.result, { status: 'fulfilled', value: 'parent output' });
    assert.equal(accepted, 1);
    assert.equal(parent.children.get(child).round, 1, 'the relationship keeps its original entrance round');
    assert.equal(parent.context.progress.round, transition === 'next-round' ? 2 : 1);
    assert.equal(parent.children.get(child).reception.status, 'pending');
  });
}

test('cancellation waits for real child exit and preserves effects established before the request', { timeout: 2000 }, async (t) => {
  const builders = createInvocationBuilders();
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
        const child = builders.execution.create(owner, null, {
          work: {
            maxRounds: 1,
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
            accept: () => assert.fail('cancelled child must not begin normal acceptance'),
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
  const builders = createInvocationBuilders();
  const release = deferred();
  const caught = deferred();
  t.after(() => release.resolve());
  const failure = new Error('child implementation fault');
  let siblingRun;
  const parent = root(builders, {
    async execute(_context, owner) {
      const sibling = builders.execution.create(owner, null, {
        work: {
          maxRounds: 1,
          async execute() {
            await release.promise;
            return 'sibling output';
          },
        },
      });
      siblingRun = track(sibling.run());
      const failed = builders.execution.create(owner, null, {
        work: {
          maxRounds: 1,
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
  const builders = createInvocationBuilders();
  const release = deferred();
  const entered = deferred();
  t.after(() => release.resolve());
  const rejected = new ExceptionContract('CONTROL_RECEPTION_DIAGNOSTIC');
  const original = rejected.create('parent cannot continue', {});
  const diagnostic = rejected.create('reception rejects another result', {});
  let reception;
  let child;
  const parent = root(builders, {
    raises: [rejected],
    async execute(_context, owner) {
      child = builders.execution.create(owner, null, { work: { maxRounds: 1, execute: () => 'child output' } });
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
  const child = defineExecution()({
    run: {
      execute() {
        throw failure;
      },
    },
  });
  const definition = defineRuntime()({
    children: [child],
    run: {
      uses: [child],
      execute(work) {
        work.children.create(child, null).run();
        return 'parent candidate';
      },
    },
  });
  const runtime = assembleRuntime(definition, { providers: [], source: { capture: () => null } });
  await assert.rejects(runtime.run(null), (error) => error === failure);
  // Let Node report an unhandled wrapper Promise, if a public handle created one.
  await new Promise((resolve) => setImmediate(resolve));
});

test('an unawaited child declared failure keeps its original delivery without automatically rethrowing in the later parent phase', { timeout: 2000 }, async (t) => {
  const release = deferred();
  t.after(() => release.resolve());
  const rejected = new ExceptionContract('CONTROL_UNOBSERVED_CHILD');
  const exception = rejected.create('child declined', {});
  const child = defineExecution()({
    raises: [rejected],
    run: {
      async execute() {
        await release.promise;
        throw exception;
      },
    },
  });
  let childFacts;
  const definition = defineRuntime()({
    children: [child],
    run: {
      uses: [child],
      execute(work) {
        const call = work.children.create(child, null);
        call.run();
        childFacts = () => work.children.facts.get(call.ref);
        return 'parent candidate';
      },
    },
  });
  const runtime = assembleRuntime(definition, { providers: [], source: { capture: () => null } });
  const parentRun = track(runtime.run(null));
  await assertPending(parentRun, 'the parent still joins the delayed child');
  release.resolve();
  assert.deepEqual(await parentRun.result, { status: 'fulfilled', value: 'parent candidate' });
  assert.equal(childFacts().returned.status, 'failed');
  assert.equal(childFacts().returned.failure.kind, 'exception');
  assert.equal(childFacts().reception.status, 'pending');
  await new Promise((resolve) => setImmediate(resolve));
});
