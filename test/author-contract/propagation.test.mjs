import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ExceptionContract, ChildCallFailure, Scene, Group, Node, Runner, Resources } from '@capix/server-runtime';
import { inspectChildCallFailure } from '@capix/server-runtime/construction';

const rejected = new ExceptionContract('AUTHOR_REJECTION');
const runtime = (operation) => new Runner(new Scene({ run: (work) => work.children.invoke(operation, work.input) }).add(operation), new Resources()).build();

for (const selected of [0, 1]) {
  test(`the selected concurrent child ${selected} carries its own authenticated delivery`, async () => {
    const exception = rejected.create('same error', {});
    const child = new Node({
      run() {
        throw exception;
      },
    });
    let failure;
    const operation = new Group({
      async run(work) {
        const calls = [work.children.create(child, 'first', { key: 'same' }), work.children.create(child, 'second', { key: 'same' })];
        const outcomes = await Promise.allSettled(calls.map((call) => call.run()));
        assert.ok(outcomes[selected].reason instanceof ChildCallFailure);
        assert.equal(outcomes[selected].reason.exception, exception);
        assert.notEqual(outcomes[0].reason, outcomes[1].reason);
        failure = inspectChildCallFailure(outcomes[selected].reason);
        assert.equal(failure.origin.child.order, selected);
        assert.equal(work.children.facts.require(child, calls[selected].ref).input, selected ? 'second' : 'first');
        throw outcomes[selected].reason;
      },
    }).add(child);
    await assert.rejects(runtime(operation).run('initial'), (error) => error === exception);
  });
}

for (const mode of ['rethrow', 'unwrap', 'replace']) {
  test(`author catch ${mode} preserves an explicit error without node-level handlers`, async () => {
    const original = rejected.create('child', {});
    const child = new Node({
      run() {
        throw original;
      },
    });
    const operation = new Group({
      async run(work) {
        try {
          await work.children.create(child, 'input').run();
        } catch (error) {
          assert.ok(error instanceof ChildCallFailure);
          if (mode === 'rethrow') throw error;
          if (mode === 'unwrap') throw error.exception;
          throw rejected.create('local', {});
        }
      },
    }).add(child);
    await assert.rejects(runtime(operation).run('initial'), (error) => (mode === 'replace' ? error.message === 'local' : error === original));
  });
}

test('nested reception failure preserves the outer successful return and inner failed delivery', async () => {
  const exception = rejected.create('nested', {});
  const value = { content: 'candidate' };
  const outer = new Node({ run: () => value });
  const inner = new Node({
    run() {
      throw exception;
    },
  });
  let facts;
  const operation = new Group({
    async run(work) {
      try {
        await work.children.invoke(outer, null, { result: { succeeded: () => work.children.invoke(inner, null) } });
      } finally {
        facts = work.children.facts.values();
      }
    },
  }).add(outer, inner);
  await assert.rejects(runtime(operation).run(null), (error) => error === exception);
  assert.equal(facts[0].returned.output, value);
  assert.equal(facts[0].reception.status, 'failed');
  assert.equal(facts[1].returned.status, 'failed');
});

test('repair is a registered operation with independent facts, not an exception phase', async () => {
  const original = new Error('repair needed');
  const failing = new Node({
    run() {
      throw original;
    },
  });
  const repair = new Node({ run: () => 'fixed' });
  let facts;
  let runs = 0;
  const operation = new Group({
    async run(work) {
      runs++;
      const value = await work.children.invoke(failing, work.input, {
        result: {
          failed: (error) => {
            assert.equal(error, original);
            return work.children.invoke(repair, 'repair');
          },
        },
      });
      facts = work.children.facts.values();
      return value;
    },
  }).add(failing, repair);
  assert.equal(await runtime(operation).run('initial'), 'fixed');
  assert.equal(runs, 1);
  assert.deepEqual(
    facts.map((fact) => [fact.returned.status, fact.reception.status]),
    [
      ['failed', 'handled'],
      ['succeeded', 'accepted'],
    ],
  );
});

test('a caller can explicitly preserve the first failure when a repair also fails', async () => {
  const original = new Error('original');
  const secondary = new Error('repair');
  const first = new Node({
    run() {
      throw original;
    },
  });
  const repair = new Node({
    run() {
      throw secondary;
    },
  });
  const operation = new Group({
    run(work) {
      return work.children.invoke(first, null, {
        result: {
          async failed(error) {
            await work.children.invoke(repair, null, {
              result: {
                failed(repairError) {
                  assert.equal(repairError, secondary);
                  return undefined;
                },
              },
            });
            throw error;
          },
        },
      });
    },
  }).add(first, repair);
  await assert.rejects(runtime(operation).run(null), (error) => error === original);
});
