import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Node, Scene, Resources, Runner, InvocationCancelled, callableHooks } from '@capix/server-runtime';

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function setup(scene, capabilities = {}) {
  return new Runner(scene, new Resources(), undefined, capabilities).build();
}
function observation(facts, businesses = []) {
  return {
    bindInvocation() {
      return {
        observe(fact) {
          facts.push(fact);
        },
        business(fact) {
          businesses.push(fact);
        },
      };
    },
  };
}

test('invoke preserves successful references and establishes one parent acceptance', async () => {
  const value = { text: 'unchanged' };
  const child = new Node({ run: () => value });
  let fact;
  const scene = new Scene({
    async run(work) {
      const result = await work.children.invoke(child, null);
      fact = work.children.facts.requireUnique(child, { parentRound: 1 });
      return result;
    },
  }).add(child);
  assert.equal(await setup(scene).run(null), value);
  assert.equal(fact.returned.output, value);
  assert.equal(fact.reception.value, value);
  assert.equal(fact.reception.status, 'accepted');
});

test('fallback preserves the primary failure and accepts the independently invoked backup', async () => {
  const failure = new Error('missing source');
  const primary = new Node({
    run() {
      throw failure;
    },
  });
  const backup = new Node({ run: () => 'backup' });
  let facts;
  const scene = new Scene({
    async run(work) {
      const result = await work.children.invoke(primary, null, {
        result: {
          failed(error) {
            assert.equal(error, failure);
            return work.children.invoke(backup, null);
          },
        },
      });
      facts = work.children.facts.values();
      return result;
    },
  }).add(primary, backup);
  assert.equal(await setup(scene).run(null), 'backup');
  assert.equal(facts[0].returned.status, 'failed');
  assert.equal(facts[0].reception.status, 'handled');
  assert.equal(facts[1].returned.status, 'succeeded');
  assert.equal(facts[1].reception.status, 'accepted');
});

for (const branch of ['succeeded', 'failed'])
  test(`${branch} receiver errors are new reception failures and never reenter failed`, async () => {
    const rejection = new Error('receiver broke');
    let failures = 0;
    const child = new Node({
      run() {
        if (branch === 'failed') throw new Error('source broke');
        return 'source';
      },
    });
    const scene = new Scene({
      run(work) {
        return work.children.invoke(child, null, {
          result: {
            succeeded() {
              throw rejection;
            },
            failed() {
              failures++;
              throw rejection;
            },
          },
        });
      },
    }).add(child);
    await assert.rejects(setup(scene).run(null), (error) => error === rejection);
    assert.equal(failures, branch === 'failed' ? 1 : 0);
  });

test('concurrent failures using the same Error keep their own relation and receiver', async () => {
  const shared = new Error('shared');
  const child = new Node({
    async run() {
      await Promise.resolve();
      throw shared;
    },
  });
  let facts;
  const scene = new Scene({
    async run(work) {
      const values = await Promise.all(
        [1, 2].map((input) =>
          work.children.invoke(child, input, {
            result: {
              failed(error) {
                assert.equal(error, shared);
                return input * 10;
              },
            },
          }),
        ),
      );
      facts = work.children.facts.values();
      return values;
    },
  }).add(child);
  assert.deepEqual(await setup(scene).run(null), [10, 20]);
  assert.deepEqual(
    facts.map((f) => [f.input, f.reception.value]),
    [
      [1, 10],
      [2, 20],
    ],
  );
});

test('in-flight receiver configuration is fixed at operation start', async () => {
  const gate = deferred();
  const child = new Node({
    async run() {
      await gate.promise;
      throw new Error('source');
    },
  });
  const scene = new Scene({
    run(work) {
      const options = { result: { failed: () => 'original' } };
      const result = work.children.invoke(child, null, options);
      options.result.failed = () => 'replacement';
      gate.resolve();
      return result;
    },
  }).add(child);
  assert.equal(await setup(scene).run(null), 'original');
});

test('parent joins a started invoke including its receiver even when its returned promise is not awaited', async () => {
  const gate = deferred();
  const started = deferred();
  let received = false;
  const child = new Node({
    async run() {
      started.resolve();
      await gate.promise;
      return 'child';
    },
  });
  const scene = new Scene({
    run(work) {
      void work.children.invoke(child, null, {
        result: {
          succeeded(value) {
            received = true;
            return value;
          },
        },
      });
      return 'parent';
    },
  }).add(child);
  const runner = setup(scene);
  const result = runner.run(null);
  await started.promise;
  assert.equal(runner.isRunning, true);
  assert.equal(received, false);
  gate.resolve();
  assert.equal(await result, 'parent');
  assert.equal(received, true);
});

test('a child setup failure is not a business fallback opportunity', async () => {
  let handled = false;
  const child = new Node({ run: () => 'never' });
  const scene = new Scene({
    run(work) {
      return work.children.invoke(child, null, {
        result: {
          failed() {
            handled = true;
            return 'incorrect';
          },
        },
      });
    },
  }).add(child);
  const failure = new Error('required setup observation');
  const runner = setup(scene, {
    observations: [
      {
        failure: 'propagate',
        bindInvocation() {
          return {
            observe(fact) {
              if (fact.kind === 'started' && fact.identity.kind === 'node') throw failure;
            },
          };
        },
      },
    ],
  });
  await assert.rejects(runner.run(null));
  assert.equal(handled, false);
});

test('cancellation closes the parent operation without consuming failed as a fallback', async () => {
  const gate = deferred();
  const started = deferred();
  const controller = new AbortController();
  let handled = false;
  const child = new Node({
    async run() {
      started.resolve();
      await gate.promise;
      return 'late';
    },
  });
  const scene = new Scene({
    run(work) {
      return work.children.invoke(child, null, {
        result: {
          failed() {
            handled = true;
            return 'wrong';
          },
        },
      });
    },
  }).add(child);
  const runner = setup(scene);
  const pending = runner.run(null, { signal: controller.signal });
  await started.promise;
  controller.abort();
  gate.resolve();
  await assert.rejects(pending, (error) => error instanceof InvocationCancelled);
  assert.equal(handled, false);
});

test('business annotations have trusted call identity and cannot forge lifecycle facts', async () => {
  const facts = [];
  const businesses = [];
  let retained;
  const scene = new Scene({
    run(work) {
      retained = work;
      work.observation({ event: 'fallback', kind: 'finished', identity: 'not an identity', reason: 'test' });
      return 'done';
    },
  });
  assert.equal(await setup(scene, { observations: [observation(facts, businesses)] }).run(null), 'done');
  assert.equal(facts.filter((f) => f.kind === 'finished').length, 1);
  assert.equal(businesses.length, 1);
  assert.equal(businesses[0].identity.contextId, facts[0].identity.contextId);
  assert.equal(businesses[0].event.kind, 'finished');
  assert.throws(() => retained.observation({ event: 'late' }), /closed|running|active|ended/);
});

test('optional business observation failure disables its consumer without changing the result', async () => {
  let count = 0;
  const scene = new Scene({
    run(work) {
      work.observation({ event: 'one' });
      work.observation({ event: 'two' });
      return 'ok';
    },
  });
  const runner = setup(scene, {
    observations: [
      {
        bindInvocation() {
          return {
            observe() {},
            business() {
              count++;
              throw new Error('consumer failed');
            },
          };
        },
      },
    ],
  });
  assert.equal(await runner.run(null), 'ok');
  assert.equal(count, 1);
});

test('source deltas, parent replacement and final result stay distinct during fallback', async () => {
  const events = [];
  const textOutput = { result: (value) => value, delta: (value) => value };
  const primary = new Node({
    output: textOutput,
    run(work) {
      work.output.emit('old');
      throw new Error('primary');
    },
  });
  const backup = new Node({
    output: textOutput,
    run(work) {
      work.output.emit('new');
      return 'FINAL';
    },
  });
  const scene = new Scene({
    output: textOutput,
    run(work) {
      return work.children.invoke(primary, null, {
        delta: (text) => work.output.emit({ kind: 'append', text }),
        result: {
          failed() {
            work.output.emit({ kind: 'replace', text: '' });
            return work.children.invoke(backup, null, { delta: (text) => work.output.emit({ kind: 'append', text }) });
          },
        },
      });
    },
  }).add(primary, backup);
  const resources = new Resources();
  const runner = new Runner(scene, resources, undefined, {
    hooks: [
      callableHooks(scene, {
        output: () => ({
          receive(event) {
            events.push(event);
          },
        }),
      }),
    ],
  }).build();
  // Host output delivery observes the parent stream; child deltas are explicitly forwarded.
  const result = await runner.run(null);
  assert.equal(result, 'FINAL');
  assert.deepEqual(
    events.filter((event) => event.kind === 'delta').map((event) => event.delta),
    [
      { kind: 'append', text: 'old' },
      { kind: 'replace', text: '' },
      { kind: 'append', text: 'new' },
    ],
  );
  assert.equal(events.at(-1).kind, 'completed');
  assert.equal(events.at(-1).result, 'FINAL');
});
