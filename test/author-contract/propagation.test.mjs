import { installCallable } from '../fixtures/driver.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ExceptionContract, ChildCallFailure, defineScene, defineGroup, defineNode } from '@capix/server-runtime';

const rejected = new ExceptionContract('AUTHOR_REJECTION');
const metadata = { name: 'fixture', label: 'fixture', source: 'test' };
function runtime(operation) {
  const execution = defineGroup()({
    members: [operation],
    async run(work) {
      const child = work.children.create(operation, work.input);
      await child.run();
      return child.accept();
    },
  });
  const root = defineScene()({
    members: [execution],
    async run(work) {
      const child = work.children.create(execution, work.input);
      await child.run();
      return child.accept();
    },
  });
  return installCallable(root, { providers: [], source: { capture: () => null } });
}
const attempt = (execute, raises = []) => defineNode()({ ...metadata, callee: 'fixture', raises, run: execute });

for (const selected of [0, 1]) {
  test(`author Work identifies selected child ${selected} when one declaration throws the same exception concurrently`, async () => {
    const exception = rejected.create('same exception object', {});
    const child = attempt(() => {
      throw exception;
    }, [rejected]);
    let refs;
    const operation = defineGroup()({
      ...metadata,
      members: [child],
      async run(work) {
        const calls = [work.children.create(child, 'first', { key: 'same' }), work.children.create(child, 'second', { key: 'same' })];
        refs = calls.map((call) => call.ref);
        const outcomes = await Promise.allSettled(calls.map((call) => call.run()));
        assert.ok(outcomes[selected].reason instanceof ChildCallFailure);
        assert.equal(outcomes[selected].reason.exception, exception);
        assert.notEqual(outcomes[0].reason, outcomes[1].reason);
        throw outcomes[selected].reason;
      },
      exceptions: {
        accepts: [rejected],
        handle(work) {
          assert.equal(work.exception, exception);
          assert.deepEqual(work.origin, { kind: 'child-return', child: refs[selected] });
          assert.equal(work.children.facts.require(child, work.origin.child).input, selected === 0 ? 'first' : 'second');
          assert.equal(work.children.facts.list(child).length, 2);
          return work.return('handled');
        },
      },
    });
    assert.equal(await runtime(operation).run('initial', {}), 'handled');
  });
}

for (const mode of ['rethrow', 'unwrap', 'replace', 'swallow']) {
  test(`author catch ${mode} retains explicit origin semantics`, async () => {
    const original = rejected.create('child', {});
    const child = attempt(() => {
      throw original;
    }, [rejected]);
    let ref;
    const operation = defineGroup()({
      ...metadata,
      raises: [rejected],
      members: [child],
      async run(work) {
        const call = work.children.create(child, 'input');
        ref = call.ref;
        try {
          await call.run();
        } catch (error) {
          assert.ok(error instanceof ChildCallFailure);
          if (mode === 'rethrow') throw error;
          if (mode === 'unwrap') throw error.exception;
          if (mode === 'replace') throw rejected.create('local', {});
        }
        return 'swallowed';
      },
      exceptions: {
        accepts: [rejected],
        handle(work) {
          assert.deepEqual(work.origin, mode === 'rethrow' ? { kind: 'child-return', child: ref } : { kind: 'self', phase: 'execute' });
          assert.equal(work.exception === original, mode !== 'replace');
          return work.return('handled');
        },
      },
    });
    assert.equal(await runtime(operation).run('initial', {}), mode === 'swallow' ? 'swallowed' : 'handled');
  });
}

test('author nested run preserves inner source and independent outer failed reception', async () => {
  const exception = rejected.create('nested', {});
  const value = { content: 'accepted candidate' };
  const outer = attempt(() => value);
  const inner = attempt(() => {
    throw exception;
  }, [rejected]);
  let outerRef;
  let innerRef;
  const operation = defineGroup()({
    ...metadata,
    members: [outer, inner],
    async run(work) {
      const first = work.children.create(outer, 'outer');
      outerRef = first.ref;
      const second = work.children.create(inner, 'inner');
      innerRef = second.ref;
      assert.equal(await first.run(), value);
      return first.accept(async (delivered) => {
        assert.equal(delivered, value);
        return second.run();
      });
    },
    exceptions: {
      accepts: [rejected],
      handle(work) {
        assert.equal(work.exception, exception);
        assert.deepEqual(work.origin, { kind: 'child-return', child: innerRef });
        const outerFact = work.children.facts.require(outer, outerRef);
        assert.equal(outerFact.returned.output, value);
        assert.equal(outerFact.reception.status, 'failed');
        assert.equal(work.children.facts.require(inner, innerRef).reception.status, 'pending');
        return work.return('handled');
      },
    },
  });
  assert.equal(await runtime(operation).run('input', {}), 'handled');
});

test('accepted continuation exposes previous precise source and enables a separately declared repair child', async () => {
  const exception = rejected.create('repair needed', {});
  const failing = attempt(() => {
    throw exception;
  }, [rejected]);
  const repair = attempt(() => 'fixed');
  let source;
  let repaired;
  const operation = defineGroup()({
    ...metadata,
    maxRounds: 2,
    members: [failing, repair],
    uses: [failing],
    async run(work) {
      if (work.round === 2) {
        assert.equal(work.initialInput, 'initial');
        assert.equal(work.input, 'next');
        assert.deepEqual(work.continuation, { fromRound: 1, stage: 'handling', reason: 'repaired', origin: { kind: 'child-return', child: source } });
        assert.equal(work.children.facts.require(failing, source).returned.status, 'failed');
        assert.equal(work.children.facts.require(repair, repaired).reception.value, 'fixed');
        return 'done';
      }
      const child = work.children.create(failing, work.input);
      source = child.ref;
      return child.run();
    },
    exceptions: {
      accepts: [rejected],
      uses: [repair],
      async handle(work) {
        assert.equal(work.exception, exception);
        const child = work.children.create(repair, 'repair');
        repaired = child.ref;
        await child.run();
        await child.accept();
        return work.continue('next', 'repaired');
      },
    },
  });
  assert.equal(await runtime(operation).run('initial', {}), 'done');
});

test('declining after a caught repair rejection preserves the original unhandled exception', async () => {
  const original = rejected.create('original', {});
  const secondary = rejected.create('repair failed', {});
  const first = attempt(() => {
    throw original;
  }, [rejected]);
  const repair = attempt(() => {
    throw secondary;
  }, [rejected]);
  const operation = defineGroup()({
    ...metadata,
    members: [first, repair],
    uses: [first],
    run(work) {
      return work.children.create(first, 'initial').run();
    },
    exceptions: {
      accepts: [rejected],
      uses: [repair],
      async handle(work) {
        const origin = work.origin;
        try {
          await work.children.create(repair, 'repair').run();
        } catch (failure) {
          assert.equal(failure.exception, secondary);
        }
        assert.equal(work.exception, original);
        assert.equal(work.origin, origin);
        return work.unhandled;
      },
    },
  });
  await assert.rejects(runtime(operation).run('input', {}), (error) => error.code === 'UNHANDLED_EXCEPTION' && error.cause === original);
});
