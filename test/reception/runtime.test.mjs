import { installCallable } from '../fixtures/driver.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ChildCallFailure, ExceptionContract, Group, defineNode, defineGroup, defineScene, reception } from '@weiliang0121/capix-runtime';
import { Transcript, TranscriptResource } from '@weiliang0121/capix-transcript';

const metadata = { name: 'reception-fixture', label: 'Reception fixture', source: 'test' };
const issue = new ExceptionContract('RECEPTION_FIXTURE');
const codec = { encode: (value) => value, decode: (value) => value };
const checkpoint = (receptions) => ({ key: 'fixture.reception', version: 1, input: codec, output: codec, points: [], receptions });

function runtime(operation, providers = []) {
  const execution = defineGroup()({
    members: [operation],
    async run(work) {
      const call = work.children.create(operation, work.input);
      await call.run();
      return call.accept();
    },
  });
  const root = defineScene()({
    members: [execution],
    async run(work) {
      const call = work.children.create(execution, work.input);
      await call.run();
      return call.accept();
    },
  });
  return installCallable(root, { providers, source: { capture: () => null } });
}

function leaf(execute = (work) => work.input) {
  return defineNode()({ ...metadata, run: execute });
}

function checked(check = (value) => value) {
  return {
    check,
    encode() {
      throw new Error('Normal acceptance must not encode');
    },
    decode() {
      throw new Error('Normal acceptance must not decode');
    },
  };
}

function parent(child, contracts, execute, options = {}) {
  return defineGroup()({ ...metadata, members: [child], checkpoint: checkpoint(contracts), run: execute, ...options });
}

test('R, E and O each register and consume their own direct-child reception', async () => {
  const attempt = leaf(() => 7);
  const operationValue = reception(attempt, checked());
  const operation = parent(attempt, [operationValue], async (work) => {
    const call = work.children.create(attempt, null);
    await call.run();
    await call.accept(operationValue, (value) => `number:${value}`);
    return work.children.facts.accepted(call.ref, operationValue);
  });
  const executionValue = reception(operation, checked());
  const execution = defineGroup()({
    members: [operation],
    checkpoint: checkpoint([executionValue]),
    async run(work) {
      const call = work.children.create(operation, null);
      await call.run();
      await call.accept(executionValue, (value) => ({ summary: value }));
      return work.children.facts.accepted(call.ref, executionValue);
    },
  });
  const runtimeValue = reception(execution, checked());
  const root = defineScene()({
    members: [execution],
    checkpoint: checkpoint([runtimeValue]),
    async run(work) {
      const call = work.children.create(execution, null);
      await call.run();
      await call.accept(runtimeValue, (value) => [value.summary]);
      return work.children.facts.accepted(call.ref, runtimeValue);
    },
  });
  const installed = installCallable(root, { providers: [], source: { capture: () => null } });
  assert.deepEqual(await installed.run(null, {}), ['number:7']);
});

test('equivalent children have independent parent Accepted values in factory and named declarations', async () => {
  const child = leaf();
  const text = reception(
    child,
    checked((value) => {
      assert.equal(typeof value, 'string');
      return value;
    }),
  );
  const namedChild = leaf();
  const count = reception(
    namedChild,
    checked((value) => {
      assert.equal(typeof value, 'number');
      return value;
    }),
  );
  const factoryParent = parent(child, [text], async (work) => {
    const call = work.children.create(child, 'hello');
    await call.run();
    const accepted = await call.accept(text, (result) => `text:${result}`);
    assert.equal(work.children.facts.accepted(call.ref, text), accepted);
    assert.equal(work.children.facts.get(call.ref).returned.output, 'hello');
    return accepted;
  });
  class NamedParent extends Group {
    name = metadata.name;
    label = metadata.label;
    source = metadata.source;
    constructor() {
      super();
      this.add(namedChild);
    }
    checkpoint = checkpoint([count]);
    deps = {};
    run = async function (work) {
      const call = work.children.create(namedChild, 'hello');
      await call.run();
      await call.accept(count, (result) => result.length);
      return work.children.facts.accepted(call.ref, count);
    };
  }
  assert.equal(await runtime(factoryParent).run(null, {}), 'text:hello');
  assert.equal(await runtime(new NamedParent()).run(null, {}), 5);
});

test('normal checking validates fixed callback data once and never calls persistence codecs', async () => {
  const child = leaf();
  const original = { committed: true };
  let checks = 0;
  const contract = reception(
    child,
    checked((value) => {
      checks++;
      assert.deepEqual(value, original);
      return { committed: true };
    }),
  );
  const definition = parent(child, [contract], async (work) => {
    const call = work.children.create(child, 'candidate');
    await call.run();
    assert.deepEqual(await call.accept(contract, () => original), original);
    assert.deepEqual(work.children.facts.accepted(call.ref, contract), original);
    assert.deepEqual(work.children.facts.get(call.ref).reception.value, original);
    return original;
  });
  assert.deepEqual(await runtime(definition).run(null, {}), original);
  assert.equal(checks, 1, 'reading an accepted fact does not execute check again');
});

test('accepted undefined is a successful value rather than a missing fact', async () => {
  const child = leaf();
  const contract = reception(
    child,
    checked((value) => {
      assert.equal(value, undefined);
      return undefined;
    }),
  );
  const definition = parent(child, [contract], async (work) => {
    const call = work.children.create(child, 'candidate');
    await call.run();
    assert.equal(await call.accept(contract, () => undefined), undefined);
    assert.equal(work.children.facts.get(call.ref).reception.status, 'accepted');
    assert.equal(work.children.facts.accepted(call.ref, contract), undefined);
    return 'done';
  });
  assert.equal(await runtime(definition).run(null, {}), 'done');
});

test('concurrent same-key calls are read by their exact references', async () => {
  const child = leaf();
  const contract = reception(child, checked());
  const definition = parent(child, [contract], async (work) => {
    const first = work.children.create(child, 'first', { key: 'repeat' });
    const second = work.children.create(child, 'second', { key: 'repeat' });
    await Promise.all([first.run(), second.run()]);
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    const one = first.accept(contract, async (result) => {
      entered.resolve();
      await release.promise;
      return { result, ordinal: 1 };
    });
    await entered.promise;
    const two = await second.accept(contract, (result) => ({ result, ordinal: 2 }));
    release.resolve();
    const acceptedOne = await one;
    assert.equal(work.children.facts.accepted(first.ref, contract), acceptedOne);
    assert.equal(work.children.facts.accepted(second.ref, contract), two);
    assert.notEqual(first.ref, second.ref);
    assert.deepEqual(
      work.children.facts.list(child).map((fact) => fact.key),
      ['repeat', 'repeat'],
    );
    return [acceptedOne.result, two.result];
  });
  assert.deepEqual(await runtime(definition).run(null, {}), ['first', 'second']);
});

test('accepted facts remain readable after the async business operation', async () => {
  const child = leaf();
  const contract = reception(child, checked());
  const definition = parent(child, [contract], async (work) => {
    const call = work.children.create(child, 'candidate');
    await call.invoke({ reception: contract, result: { succeeded: () => 'accepted' } });
    await Promise.resolve();
    return work.children.facts.accepted(call.ref, contract);
  });
  assert.equal(await runtime(definition).run(null, {}), 'accepted');
});

for (const mode of ['unregistered', 'different-child']) {
  test(`accept rejects a ${mode} contract before running the callback`, async () => {
    const child = leaf();
    const otherChild = leaf();
    const valid = reception(child, checked());
    const invalid = reception(mode === 'different-child' ? otherChild : child, checked());
    let called = 0;
    let checkedRejection = false;
    const definition = parent(
      child,
      mode === 'different-child' ? [valid, invalid] : [valid],
      async (work) => {
        const call = work.children.create(child, 'candidate');
        await call.run();
        await assert.rejects(call.accept(invalid, () => ++called));
        checkedRejection = true;
        return 'cannot swallow a contract violation';
      },
      { members: [child, otherChild] },
    );
    await assert.rejects(runtime(definition).run(null, {}));
    assert.equal(checkedRejection, true);
    assert.equal(called, 0);
  });
}

test('a parent cannot register a reception whose child is outside its children', () => {
  const child = leaf();
  const foreign = leaf();
  const contract = reception(foreign, checked());
  assert.throws(() => runtime(parent(child, [contract], () => 'unused')));
});

test('binding rejects duplicate parent reception registration before work', () => {
  const child = leaf();
  const contract = reception(child, checked());
  let calls = 0;
  assert.throws(() => runtime(parent(child, [contract, contract], () => ++calls)), /Duplicate parent reception contract/);
  assert.equal(calls, 0);
});

test('binding fixes the reception checker while preserving its original method receiver', async () => {
  const child = leaf();
  let checks = 0;
  const valueContract = {
    ...checked(),
    expected: 'accepted',
    check(value) {
      assert.equal(this, valueContract);
      assert.equal(value, this.expected);
      checks++;
      return value;
    },
  };
  const contract = reception(child, valueContract);
  const definition = parent(child, [contract], async (work) => {
    const call = work.children.create(child, 'candidate');
    await call.run();
    await call.accept(contract, () => 'accepted');
    return work.children.facts.accepted(call.ref, contract);
  });
  const installed = runtime(definition);
  valueContract.check = () => {
    throw new Error('late replacement must not run');
  };
  assert.equal(await installed.run(null, {}), 'accepted');
  assert.equal(checks, 1);
  assert.equal(Object.isFrozen(valueContract), false);
});

for (const mode of ['before-return', 'returned-not-accepted', 'wrong-contract', 'raw', 'raw-callback']) {
  test(`typed fact lookup rejects ${mode} without inventing a reception label`, async () => {
    const child = leaf();
    const contract = reception(child, checked());
    const sameShape = reception(child, checked());
    let checkedRejection = false;
    const definition = parent(child, [contract, sameShape], async (work) => {
      const call = work.children.create(child, 'candidate');
      if (mode !== 'before-return') await call.run();
      if (mode === 'wrong-contract') await call.accept(contract, () => 'accepted');
      if (mode === 'raw') assert.equal(await call.accept(), 'candidate');
      if (mode === 'raw-callback') assert.equal(await call.accept(() => 'mapped'), 'mapped');
      assert.throws(() => work.children.facts.accepted(call.ref, mode === 'wrong-contract' ? sameShape : contract));
      checkedRejection = true;
      return 'cannot swallow a fact mismatch';
    });
    await assert.rejects(runtime(definition).run(null, {}));
    assert.equal(checkedRejection, true);
  });
}

test('accepted lookup rejects an authentic reference issued to another parent invocation', async () => {
  const child = leaf();
  const contract = reception(child, checked());
  let previous;
  let checkedRejection = false;
  const definition = parent(child, [contract], async (work) => {
    if (previous) {
      assert.throws(() => work.children.facts.accepted(previous, contract));
      checkedRejection = true;
      return 'cannot read the other parent';
    }
    const call = work.children.create(child, 'candidate');
    await call.run();
    await call.accept(contract, () => 'accepted');
    previous = call.ref;
    return 'first';
  });
  const installed = runtime(definition);
  assert.equal(await installed.run(null, {}), 'first');
  await assert.rejects(installed.run(null, {}));
  assert.equal(checkedRejection, true);
});

test('a retained handle cannot begin typed reception after its parent exits', async () => {
  const child = leaf();
  const contract = reception(child, checked());
  let captured;
  let callbacks = 0;
  const definition = parent(child, [contract], async (work) => {
    captured = work.children.create(child, 'candidate');
    await captured.run();
    return 'delivered';
  });
  assert.equal(await runtime(definition).run(null, {}), 'delivered');
  await assert.rejects(captured.accept(contract, () => ++callbacks));
  assert.equal(callbacks, 0);
});

test('opening a reference in the same business run permits its first reception', async () => {
  const child = leaf();
  const contract = reception(child, checked());
  const definition = parent(child, [contract], async (work) => {
    const call = work.children.create(child, 'candidate');
    await call.run();
    await Promise.resolve();
    await work.children.open(call.ref).accept(contract, () => 'accepted later');
    return work.children.facts.accepted(call.ref, contract);
  });
  assert.equal(await runtime(definition).run(null, {}), 'accepted later');
});

test('a successful typed reception cannot be repeated even with the same contract', async () => {
  const child = leaf();
  const contract = reception(child, checked());
  let callbacks = 0;
  let checkedRejection = false;
  const definition = parent(child, [contract], async (work) => {
    const call = work.children.create(child, 'candidate');
    await call.run();
    await call.accept(contract, () => ++callbacks);
    await assert.rejects(call.accept(contract, () => ++callbacks));
    assert.equal(work.children.facts.accepted(call.ref, contract), 1);
    checkedRejection = true;
    return 'cannot swallow duplicate acceptance';
  });
  await assert.rejects(runtime(definition).run(null, {}));
  assert.equal(checkedRejection, true);
  assert.equal(callbacks, 1);
});

for (const mode of ['technical', 'declared']) {
  test(`a ${mode} check failure retains entity effects and cannot authorize another acceptance`, async () => {
    const child = leaf();
    const transcript = new Transcript();
    const failure = mode === 'technical' ? new Error('invalid receipt') : issue.create('invalid receipt', {});
    const contract = reception(
      child,
      checked(() => {
        throw failure;
      }),
    );
    let effects = 0;
    let checkedRejection = false;
    const execute = async (work) => {
      const call = work.children.create(child, 'candidate');
      await call.run();
      const apply = () => {
        effects++;
        return work.resources.messages.applyFixed({ position: 'answer', messages: [{ role: 'assistant', content: 'already committed' }] });
      };
      await assert.rejects(call.accept(contract, apply));
      assert.equal(work.children.facts.get(call.ref).reception.status, 'failed');
      await assert.rejects(call.accept(contract, apply));
      checkedRejection = true;
      return 'cannot undo the committed effect';
    };
    const definition = parent(child, [contract], execute, {
      deps: { messages: TranscriptResource.append.request() },
      run: execute,
    });
    await assert.rejects(runtime(definition, [TranscriptResource.append.provide(() => transcript)]).run(null, {}));
    assert.equal(checkedRejection, true);
    assert.equal(effects, 1);
    assert.equal(transcript.length, 1);
    assert.deepEqual(transcript.get(0), { role: 'assistant', content: 'already committed' });
  });
}

for (const mode of ['fulfilled-promise', 'rejected-promise', 'rejecting-thenable']) {
  test(`a ${mode} checker cannot complete a synchronous reception or leak its rejection`, async () => {
    const child = leaf();
    const contract = reception(
      child,
      checked((value) => {
        if (mode === 'fulfilled-promise') return Promise.resolve(value);
        if (mode === 'rejected-promise') return Promise.reject(new Error('late checker failure'));
        return {
          then(_resolve, reject) {
            queueMicrotask(() => reject(new Error('late thenable failure')));
          },
        };
      }),
    );
    let effects = 0;
    let checkedRejection = false;
    const definition = parent(child, [contract], async (work) => {
      const call = work.children.create(child, 'candidate');
      await call.run();
      await assert.rejects(call.accept(contract, () => ++effects));
      assert.equal(work.children.facts.get(call.ref).reception.status, 'failed');
      checkedRejection = true;
      return 'a thenable check is not a valid acceptance';
    });
    await assert.rejects(runtime(definition).run(null, {}));
    // node:test reports any unhandled rejection, including one arriving after
    // the rejection above. Give the erroneous checker time to settle.
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(checkedRejection, true);
    assert.equal(effects, 1);
  });
}

for (const mode of ['declared', 'technical']) {
  test(`a ${mode} callback failure retains its reception provenance`, async () => {
    const child = leaf();
    const contract = reception(child, checked());
    const failure = mode === 'declared' ? issue.create('business rejection', {}) : new Error('callback failure');
    let reference;
    let parentWork;
    const definition = parent(child, [contract], async (work) => {
      parentWork = work;
      const call = work.children.create(child, 'candidate');
      reference = call.ref;
      return call.invoke({
        reception: contract,
        result: {
          succeeded() {
            throw failure;
          },
        },
      });
    });
    await assert.rejects(runtime(definition).run(null, {}));
    assert.equal(parentWork.children.facts.get(reference).reception.status, 'failed');
  });
}

test('a concurrent second reception cannot replace the first registered contract', async () => {
  const child = leaf();
  let firstChecks = 0;
  let secondChecks = 0;
  let secondCallbacks = 0;
  let checkedRejection = false;
  const first = reception(
    child,
    checked((value) => {
      firstChecks++;
      return value;
    }),
  );
  const second = reception(
    child,
    checked((value) => {
      secondChecks++;
      return value;
    }),
  );
  const definition = parent(child, [first, second], async (work) => {
    const call = work.children.create(child, 'candidate');
    await call.run();
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    const active = call.accept(first, async () => {
      entered.resolve();
      await release.promise;
      return 'first value';
    });
    await entered.promise;
    assert.equal(work.children.facts.get(call.ref).reception.status, 'receiving');
    try {
      await assert.rejects(call.accept(second, () => ++secondCallbacks));
    } finally {
      release.resolve();
    }
    assert.equal(await active, 'first value');
    assert.equal(work.children.facts.accepted(call.ref, first), 'first value');
    checkedRejection = true;
    return 'the duplicate violation still fails the parent';
  });
  await assert.rejects(runtime(definition).run(null, {}));
  assert.equal(checkedRejection, true);
  assert.equal(firstChecks, 1);
  assert.equal(secondChecks, 0);
  assert.equal(secondCallbacks, 0);
});
