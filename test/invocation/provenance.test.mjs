import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ExceptionContract, DeclaredException } from '@capix/server-runtime';
import { Invocation, InvocationContext } from '@capix/server-runtime/construction';
import { observeCall } from '../fixtures/observation.mjs';

const rejected = new ExceptionContract('PRECISE_REJECTION');
const make = (work, options = {}) => new Invocation({ context: new InvocationContext('initial'), signal: new AbortController().signal, work: { maxRounds: 1, ...work }, ...options });
const handler = (handle) => ({ accepts: [rejected], handle });
const failing = (owner, exception) =>
  make(
    {
      raises: [rejected],
      execute: () => {
        throw exception;
      },
    },
    { parent: { invocation: owner } },
  );

test('simultaneous identical exceptions retain the selected delivery source without key lookup', async () => {
  for (const selected of [0, 1]) {
    const exception = rejected.create('shared error', {});
    const children = [];
    let seen;
    const parent = make({
      async execute(_context, owner) {
        children.push(failing(owner, exception), failing(owner, exception));
        const results = await Promise.allSettled(children.map((child) => child.run()));
        assert.notEqual(results[0].reason, results[1].reason);
        assert.equal(results[selected].reason.exception, exception);
        assert.equal(results[selected].reason instanceof DeclaredException, false);
        throw results[selected].reason;
      },
      exceptions: handler((_context, actual, owner) => {
        assert.equal(actual, exception);
        seen = owner.exceptionOrigin;
        return { kind: 'return', output: 'handled' };
      }),
    });
    assert.equal(await parent.run(), 'handled');
    assert.deepEqual(seen, { kind: 'child-return', child: { parentContextId: parent.context.id, childContextId: children[selected].context.id, parentRound: 1, order: selected } });
    for (const relation of parent.children.values()) assert.equal(relation.returned.error, exception);
  }
});

test('original delivery rethrow preserves source; unwrapping and replacement are local throws', async () => {
  for (const mode of ['rethrow', 'unwrap', 'replace', 'swallow']) {
    const exception = rejected.create('child', {});
    let actual;
    let origin;
    const parent = make({
      raises: [rejected],
      async execute(_context, owner) {
        try {
          await failing(owner, exception).run();
        } catch (error) {
          if (mode === 'rethrow') throw error;
          if (mode === 'unwrap') throw error.exception;
          if (mode === 'replace') throw rejected.create('parent', {});
        }
        return 'swallowed';
      },
      exceptions: handler((_context, error, owner) => {
        actual = error;
        origin = owner.exceptionOrigin;
        return { kind: 'return', output: 'handled' };
      }),
    });
    assert.equal(await parent.run(), mode === 'swallow' ? 'swallowed' : 'handled');
    if (mode === 'rethrow') assert.equal(origin.kind, 'child-return');
    if (mode === 'unwrap' || mode === 'replace') assert.deepEqual(origin, { kind: 'self', phase: 'execute' });
    if (mode === 'unwrap') assert.equal(actual, exception);
    if (mode === 'replace') assert.notEqual(actual, exception);
    if (mode === 'swallow') assert.equal(origin, undefined);
  }
  const parent = make({
    async execute(_context, owner) {
      try {
        await failing(owner, rejected.create('child', {})).run();
      } catch (error) {
        throw error.exception;
      }
    },
    exceptions: handler(() => assert.fail('unwrapped local exception lacks raises')),
  });
  await assert.rejects(parent.run(), (error) => error.code === 'UNDECLARED_EXCEPTION');
});

test('nested child return preserves origin while recording the outer failed reception separately', async () => {
  const exception = rejected.create('nested child', {});
  let nested;
  let outer;
  let origin;
  const parent = make({
    async execute(_context, owner) {
      outer = make({ execute: () => 'outer result' }, { parent: { invocation: owner } });
      await outer.run();
      return owner.children.get(outer).accept(async () => {
        nested = failing(owner, exception);
        return nested.run();
      });
    },
    exceptions: handler((_context, error, owner) => {
      assert.equal(error, exception);
      origin = owner.exceptionOrigin;
      return { kind: 'return', output: 'handled' };
    }),
  });
  assert.equal(await parent.run(), 'handled');
  assert.equal(origin.kind, 'child-return');
  assert.equal(origin.child.childContextId, nested.context.id);
  const reception = parent.children.get(outer).reception;
  assert.equal(reception.status, 'failed');
  assert.equal(reception.error, exception);
  assert.deepEqual(reception.failure.origin, origin);
  assert.equal(parent.children.get(outer).returned.output, 'outer result');
});

test('a parent reception callback owns its declared exception and exact child-reception origin', async () => {
  const exception = rejected.create('parent rejects', {});
  let child;
  let source;
  const parent = make({
    raises: [rejected],
    async execute(_context, owner) {
      child = make({ execute: () => 'valid child' }, { parent: { invocation: owner, declarationPosition: 7 } });
      await child.run();
      return owner.children.get(child).accept(() => {
        throw exception;
      });
    },
    exceptions: handler((_context, error, owner) => {
      assert.equal(error, exception);
      source = owner.exceptionOrigin;
      return { kind: 'return', output: 'handled' };
    }),
  });
  assert.equal(await parent.run(), 'handled');
  assert.equal(source.kind, 'child-reception');
  assert.equal(source.child.childContextId, child.context.id);
  assert.equal(parent.children.get(child).declarationPosition, 7);
  assert.equal(parent.children.get(child).reception.failure.contextId, parent.context.id);
});

test('delivery credentials cannot cross parents, phases, or local rounds', async () => {
  let saved;
  const first = make({
    async execute(_context, owner) {
      try {
        await failing(owner, rejected.create('old', {})).run();
      } catch (error) {
        saved = error;
      }
      return 'done';
    },
  });
  await first.run();
  const wrongParent = make({
    raises: [rejected],
    execute: () => {
      throw saved;
    },
    exceptions: handler(() => assert.fail('foreign delivery')),
  });
  await assert.rejects(wrongParent.run(), (error) => error.code === 'INVALID_EXCEPTION_DELIVERY');
  for (const phase of ['receive', 'round']) {
    let previous;
    const parent = make({
      maxRounds: 2,
      raises: [rejected],
      async execute(context, owner) {
        if (context.progress.round === 2) throw previous;
        try {
          await failing(owner, rejected.create('prior', {})).run();
        } catch (error) {
          previous = error;
        }
        return 'done';
      },
      accept(context) {
        if (phase === 'receive') throw previous;
        return context.continueWith('next', 'advance');
      },
      exceptions: handler(() => assert.fail('stale delivery')),
    });
    await assert.rejects(parent.run(), (error) => error.code === 'INVALID_EXCEPTION_DELIVERY');
    assert.equal(parent.context.progress.round, phase === 'receive' ? 1 : 2);
  }
});

test('catching a structural reception failure cannot make the parent successful', async () => {
  const fault = new Error('callback bug');
  const parent = make({
    async execute(_context, owner) {
      const child = make({ execute: () => 'output' }, { parent: { invocation: owner } });
      await child.run();
      try {
        await owner.children.get(child).accept(() => {
          throw fault;
        });
      } catch {}
      return 'pretend success';
    },
  });
  await assert.rejects(parent.run(), (error) => error === fault);
});

test('continuation proposal is not a fact; cancellation, limit and handler error do not install it', async () => {
  for (const reason of ['cancel', 'limit', 'handler']) {
    const control = new AbortController();
    let proposed;
    const parent = make(
      {
        maxRounds: reason === 'limit' ? 1 : 2,
        raises: [rejected],
        execute() {
          throw rejected.create('retry', {});
        },
        exceptions: handler((context) => {
          proposed = { kind: 'continue', input: 'next', reason: 'retry once' };
          assert.equal(context.continuation, undefined);
          if (reason === 'cancel') control.abort();
          if (reason === 'handler') throw new Error('handler failed after proposing');
          return proposed;
        }),
      },
      { signal: control.signal },
    );
    await assert.rejects(parent.run());
    assert.equal(proposed.input, 'next');
    assert.equal(parent.context.progress.round, 1);
    assert.equal(parent.context.currentInput, 'initial');
    assert.equal(parent.context.continuation, undefined);
  }
});

test('next-round input and accepted continuation exist before the continue notification', async () => {
  let parent;
  let executions = 0;
  const observerFailure = new Error('continue consumer failed');
  parent = make(
    {
      maxRounds: 2,
      execute: () => ++executions,
      accept: (context) => context.continueWith('next', 'advance once'),
    },
    {
      observation: observeCall((fact) => {
        if (fact.kind !== 'process' || fact.process.type !== 'continue') return;
        assert.equal(fact.round, 1);
        assert.equal(parent.context.progress.round, 2);
        assert.equal(parent.context.currentInput, 'next');
        assert.deepEqual(parent.context.continuation, { fromRound: 1, stage: 'accept', reason: 'advance once' });
        throw observerFailure;
      }),
    },
  );
  await assert.rejects(parent.run(), (error) => error.code === 'OBSERVATION_FAILED' && error.cause === observerFailure);
  assert.equal(parent.context.progress.round, 2);
  assert.equal(parent.context.continuation.reason, 'advance once');
  assert.equal(executions, 1);
});

test('handled continuation records exact origin and keeps the original initial input', async () => {
  let child;
  const parent = make({
    maxRounds: 2,
    async execute(context, owner) {
      if (context.progress.round === 2) {
        assert.equal(context.input, 'initial');
        assert.equal(context.currentInput, 'corrected');
        assert.equal(context.continuation.origin.child.childContextId, child.context.id);
        return 'done';
      }
      child = failing(owner, rejected.create('correct', {}));
      return child.run();
    },
    exceptions: handler(() => ({ kind: 'continue', input: 'corrected', reason: 'second attempt' })),
  });
  assert.equal(await parent.run(), 'done');
  assert.equal(parent.context.continuation.stage, 'handling');
  assert.equal(parent.context.continuation.origin.kind, 'child-return');
});
