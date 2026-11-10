import { deferred } from '../../../testing/support/deferred.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Driver, Resources, Runner, Scene } from '@weiliang0121/capix-runtime';

function observation(observe, failure = 'propagate') {
  return { failure, bindDriver: () => ({ observe }), bindInvocation: () => ({ observe() {} }) };
}

function host(kind, run, { observations = [], validate } = {}) {
  const scene = new Scene({ run });
  if (kind === 'Runner') {
    const runner = new Runner(scene, new Resources(), undefined, { observations, validate }).build();
    return { run: (input, options = {}) => runner.run(input, options), running: () => runner.isRunning };
  }
  const driver = new Driver({ observations });
  const built = driver.build(scene, { providers: [], source: { capture: () => null, validate } });
  return { run: (input, options = {}) => driver.run(built, input, options), running: () => driver.isRunning(built) };
}

for (const kind of ['Runner', 'Driver']) {
  test(`${kind} reserves before acquired callbacks and releases before reentrant entry`, async () => {
    const secondExit = deferred();
    const secondEntered = deferred();
    const facts = [];
    const inputs = [];
    let entry;
    let duplicate;
    let second;
    let acquired = 0;
    let released = 0;
    entry = host(
      kind,
      async (work) => {
        inputs.push(work.input);
        if (work.input === 'second') {
          secondEntered.resolve();
          return secondExit.promise;
        }
        return work.input;
      },
      {
        observations: [
          observation((fact) => {
            facts.push(fact.kind);
            if (fact.kind === 'acquired' && ++acquired === 1) {
              assert.equal(entry.running(), true);
              duplicate = entry.run('duplicate').then(
                () => assert.fail('reentrant acquired entry must be busy'),
                (error) => error,
              );
            }
            if (fact.kind === 'released' && ++released === 1) {
              assert.equal(entry.running(), false);
              second = entry.run('second');
              assert.equal(entry.running(), true);
            }
          }),
        ],
      },
    );

    assert.equal(await entry.run('first'), 'first');
    assert.equal((await duplicate).code, 'RUNTIME_BUSY');
    await secondEntered.promise;
    assert.deepEqual(inputs, ['first', 'second']);
    assert.equal(entry.running(), true, 'the previous release must not clear the newly acquired entry');
    secondExit.resolve('finished');
    assert.equal(await second, 'finished');
    assert.equal(entry.running(), false);
    assert.deepEqual(facts, ['established', 'acquired', 'rejected', 'released', 'acquired', 'released']);
  });

  test(`${kind} preserves busy rejection and observation failure without releasing the active call`, async () => {
    const entered = deferred();
    const exit = deferred();
    const observationFailure = new Error('busy observer failed');
    const facts = [];
    let executions = 0;
    const entry = host(
      kind,
      () => {
        executions++;
        entered.resolve();
        return exit.promise;
      },
      {
        observations: [
          observation((fact) => {
            facts.push(fact.kind);
          }),
          observation((fact) => {
            if (fact.kind === 'rejected') throw observationFailure;
          }),
        ],
      },
    );
    const active = entry.run(null);
    await entered.promise;
    await assert.rejects(entry.run(null), (error) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors.length, 2);
      assert.equal(error.errors[0].code, 'RUNTIME_BUSY');
      assert.equal(error.errors[1].cause, observationFailure);
      assert.equal(error.cause, error.errors[0]);
      return true;
    });
    assert.equal(executions, 1);
    assert.equal(entry.running(), true);
    assert.deepEqual(facts, ['established', 'acquired', 'rejected']);
    exit.resolve('complete');
    assert.equal(await active, 'complete');
    assert.equal(entry.running(), false);
    assert.deepEqual(facts, ['established', 'acquired', 'rejected', 'released']);
  });

  test(`${kind} keeps acquired observation failure separate from construction, and still releases`, async () => {
    const acquiredFailure = new Error('acquired observer failed');
    const releaseFailure = new Error('released observer failed');
    const facts = [];
    let validations = 0;
    let executions = 0;
    const entry = host(kind, () => ++executions, {
      validate() {
        validations++;
      },
      observations: [
        observation((fact) => {
          facts.push(fact.kind);
        }),
        observation((fact) => {
          if (fact.kind === 'acquired') throw acquiredFailure;
        }),
        observation((fact) => {
          if (fact.kind === 'released') throw releaseFailure;
        }),
      ],
    });
    await assert.rejects(entry.run(null), (error) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors[0].cause, acquiredFailure);
      assert.equal(error.errors[1].cause, releaseFailure);
      assert.equal(error.cause, error.errors[0]);
      return true;
    });
    assert.equal(validations, 0);
    assert.equal(executions, 0);
    assert.equal(entry.running(), false);
    assert.deepEqual(facts, ['established', 'acquired', 'released'], 'no construction or entry-failed fact has occurred');
    assert.equal(await entry.run(null), 1, 'failed observers stay disabled and entry can be used again');
    assert.equal(validations, 1);
  });

  test(`${kind} retains construction, entry-failed observation and release observation failures`, async () => {
    const constructionFailure = new Error('validation failed');
    const entryFailure = new Error('entry observer failed');
    const releaseFailure = new Error('release observer failed');
    const facts = [];
    const entry = host(kind, () => assert.fail('failed construction cannot execute'), {
      validate() {
        throw constructionFailure;
      },
      observations: [
        observation((fact) => {
          facts.push(fact.kind);
        }),
        observation((fact) => {
          if (fact.kind === 'entry-failed') throw entryFailure;
        }),
        observation((fact) => {
          if (fact.kind === 'released') throw releaseFailure;
        }),
      ],
    });
    await assert.rejects(entry.run(null), (error) => {
      assert.ok(error instanceof AggregateError);
      const construction = error.errors[0];
      assert.ok(construction instanceof AggregateError);
      assert.equal(construction.errors[0], constructionFailure);
      assert.equal(construction.errors[1].cause, entryFailure);
      assert.equal(construction.cause, constructionFailure);
      assert.equal(error.errors[1].cause, releaseFailure);
      assert.equal(error.cause, construction);
      return true;
    });
    assert.equal(entry.running(), false);
    assert.deepEqual(facts, ['established', 'acquired', 'entry-failed', 'released']);
  });
}

test('shared entry preserves Runner options snapshots and legacy Driver options identity', async () => {
  for (const kind of ['Runner', 'Driver']) {
    const entity = {};
    const options = { tenant: 'original', entity };
    let received;
    let tenant;
    const entry = host(kind, (work) => work.input, {
      observations: [
        observation((fact) => {
          if (fact.kind === 'acquired') options.tenant = 'changed';
        }),
      ],
      validate(value) {
        received = value;
        tenant = value.tenant;
      },
    });
    assert.equal(await entry.run('result', options), 'result');
    assert.equal(received.entity, entity);
    if (kind === 'Runner') {
      assert.notEqual(received, options);
      assert.equal(Object.isFrozen(received), true);
      assert.equal(tenant, 'original');
    } else {
      assert.equal(received, options);
      assert.equal(Object.isFrozen(received), false);
      assert.equal(tenant, 'changed');
    }
  }
});

test('legacy source validation remains distinct from Runner synchronous admission contract', async () => {
  for (const kind of ['Runner', 'Driver']) {
    let executions = 0;
    const entry = host(kind, () => ++executions, { validate: () => 'ignored by legacy source' });
    if (kind === 'Runner') {
      await assert.rejects(entry.run(null), /validation must return undefined synchronously/);
      assert.equal(executions, 0);
    } else {
      assert.equal(await entry.run(null), 1);
    }
    assert.equal(entry.running(), false);
  }
});
