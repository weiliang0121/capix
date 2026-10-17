import test from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeDefinition, ExecutionDefinition, ExceptionContract, ResourceOffer, assembleRuntime } from '@capix/server-runtime';

class TestExecutionDefinition extends ExecutionDefinition {
  constructor(execute, entry) {
    super();
    this.run = { requires: {}, execute };
    this.entry = entry;
  }
}

class Main extends RuntimeDefinition {
  constructor(children, execute) {
    super();
    this.children = children;
    this.run = { requires: {}, uses: children, execute };
  }
}

function forward(definition, onRuntime) {
  return async (work) => {
    onRuntime?.(work);
    const child = work.children.create(definition, work.input, { key: 'chosen' });
    await child.run();
    return child.accept();
  };
}

function assemble(definition, options = {}) {
  return assembleRuntime(definition, { providers: [], source: { entry: () => undefined, capture: () => undefined }, ...options });
}

function probe() {
  const facts = [];
  return { facts, installation: { bindInvocation: () => ({ observe: (fact) => facts.push(fact) }) } };
}

test('R calls have independent contexts and ordinary E child relationships', async () => {
  const parents = [];
  const execution = new TestExecutionDefinition((work) => work.input * 2);
  const main = new Main(
    [execution],
    forward(execution, (work) => {
      parents.push(work);
      assert.equal('context' in work, false);
      assert.equal('execution' in work, false);
    }),
  );
  const observation = probe();
  const runtime = assemble(main, { observations: [observation.installation] });
  assert.equal(await runtime.run(2, {}), 4);
  assert.equal(await runtime.run(3, {}), 6);
  assert.notEqual(parents[0], parents[1]);
  const starts = observation.facts.filter((fact) => fact.kind === 'started' && fact.identity.level === 'runtime');
  const finishes = observation.facts.filter((fact) => fact.kind === 'finished' && fact.identity.level === 'runtime');
  assert.notEqual(starts[0].identity.contextId, starts[1].identity.contextId);
  assert.deepEqual(
    finishes.map((fact) => fact.state.status),
    ['succeeded', 'succeeded'],
  );
  assert.equal(runtime.running, false);
  for (const [index, parent] of parents.entries()) {
    const [relation] = parent.children.facts.values();
    assert.equal(relation.key, 'chosen');
    assert.equal(relation.parentRound, 1);
    assert.equal(relation.returned.status, 'succeeded');
    assert.equal(relation.reception.status, 'accepted');
    const childStart = observation.facts.find((fact) => fact.kind === 'started' && fact.identity.level === 'execution' && fact.identity.parentContextId === starts[index].identity.contextId);
    assert.ok(childStart);
  }
});

test('one Runtime rejects overlapping submissions and releases occupancy after failure', async () => {
  let release;
  const waiting = new Promise((resolve) => {
    release = resolve;
  });
  let entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const execution = new TestExecutionDefinition(async (work) => {
    if (work.input === 'wait') {
      entered();
      await waiting;
      throw new Error('work failed');
    }
    return work.input;
  });
  const runtime = assemble(new Main([execution], forward(execution)));
  const first = runtime.run('wait', {});
  await started;
  assert.equal(runtime.running, true);
  await assert.rejects(runtime.run('overlap', {}), { code: 'RUNTIME_BUSY' });
  release();
  await assert.rejects(first, /work failed/);
  assert.equal(runtime.running, false);
  assert.equal(await runtime.run('next', {}), 'next');
});

test('R chooses from declared E nodes without entering the unused E', async () => {
  const chosen = [];
  const first = new TestExecutionDefinition(() => 'first', {
    requires: {},
    accept: (input) => {
      chosen.push('first');
      return input;
    },
  });
  const second = new TestExecutionDefinition(() => 'second', {
    requires: {},
    accept: (input) => {
      chosen.push('second');
      return input;
    },
  });
  const runtime = assemble(
    new Main([first, second], async (work) => {
      const selected = work.input === 1 ? first : second;
      const child = work.children.create(selected, work.input);
      const output = await child.run();
      return child.accept(() => output);
    }),
  );
  assert.equal(await runtime.run(2, {}), 'second');
  assert.deepEqual(chosen, ['second']);
  assert.equal(await runtime.run(1, {}), 'first');
  assert.deepEqual(chosen, ['second', 'first']);
});

test('an undeclared E is a structural error even when R work catches it', async () => {
  const allowed = new TestExecutionDefinition(() => 'allowed');
  const hidden = new TestExecutionDefinition(() => assert.fail('must not execute'));
  const runtime = assemble(
    new Main([allowed], async (work) => {
      try {
        work.children.create(hidden, null);
      } catch {}
      return 'ignored';
    }),
  );
  await assert.rejects(runtime.run(null, {}), /not declared/);
  assert.equal(runtime.running, false);
});

test('E admission failure belongs to R before any E context or relation exists', async () => {
  let parent;
  const execution = new TestExecutionDefinition(() => assert.fail('must not execute'), {
    requires: {},
    accept: () => {
      throw new Error('bad input');
    },
  });
  const observation = probe();
  const runtime = assemble(
    new Main(
      [execution],
      forward(execution, (work) => {
        parent = work;
      }),
    ),
    { observations: [observation.installation] },
  );
  await assert.rejects(runtime.run(null, {}), /bad input/);
  assert.equal(observation.facts.find((fact) => fact.kind === 'finished' && fact.identity.level === 'runtime').state.status, 'failed');
  assert.equal(parent.children.facts.values().length, 0);
  assert.equal(
    observation.facts.some((fact) => fact.identity.level === 'execution'),
    false,
  );
  assert.equal(runtime.running, false);
});

test('E admission and capture retain their order inside the R call', async () => {
  const order = [];
  const messages = [];
  const execution = new TestExecutionDefinition(
    (work) => {
      order.push('execute');
      return work.input;
    },
    {
      requires: {},
      accept: (input) => {
        order.push('accept');
        messages.push(input);
        return { content: input };
      },
      admit: () => {
        order.push('admit');
      },
    },
  );
  const runtime = assemble(
    new Main(
      [execution],
      forward(execution, () => order.push('R')),
    ),
    {
      source: {
        entry: () => {
          order.push('entry');
          return undefined;
        },
        capture: () => {
          order.push('capture');
          assert.deepEqual(messages, ['input']);
          return undefined;
        },
        callbacks: () => ({ accepted: () => order.push('accepted'), started: () => order.push('started') }),
      },
    },
  );
  assert.deepEqual(await runtime.run('input', {}), { content: 'input' });
  assert.deepEqual(order, ['R', 'entry', 'accept', 'accepted', 'admit', 'capture', 'started', 'execute']);
});

test('cancellation before R work does not enter E admission or append input', async () => {
  let accepted = 0;
  const execution = new TestExecutionDefinition(() => assert.fail('must not execute'), {
    requires: {},
    accept: (input) => {
      accepted++;
      return input;
    },
  });
  const runtime = assemble(new Main([execution], forward(execution)));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(runtime.run('input', { signal: controller.signal }));
  assert.equal(accepted, 0);
  assert.equal(runtime.running, false);
});

test('cancellation after E admission retains accepted input without running E work', async () => {
  const messages = [];
  const controller = new AbortController();
  const execution = new TestExecutionDefinition(() => assert.fail('must not execute'), {
    requires: {},
    accept: (input) => {
      messages.push(input);
      controller.abort();
      return input;
    },
    admit: () => assert.fail('cancelled admission must not segment'),
  });
  const runtime = assemble(new Main([execution], forward(execution)));
  await assert.rejects(runtime.run('input', { signal: controller.signal }));
  assert.deepEqual(messages, ['input']);
  assert.equal(runtime.running, false);
});

test('E supplies are fulfilled without exposing them to R work', async () => {
  const secret = new ResourceOffer('test.secret', (source) => source);
  const execution = new TestExecutionDefinition((work) => work.resources.secret);
  execution.run.requires = { secret: secret.request() };
  const runtime = assemble(
    new Main(
      [execution],
      forward(execution, (work) => assert.deepEqual(Object.keys(work.resources), [])),
    ),
    {
      providers: [secret.provide((source) => source)],
      source: { entry: () => 'value', capture: () => 'value' },
    },
  );
  assert.equal(await runtime.run(null, {}), 'value');
});

test('R acceptance failure preserves the completed E outcome', async () => {
  let relation;
  const observation = probe();
  const execution = new TestExecutionDefinition(() => 2);
  const runtime = assemble(
    new Main([execution], async (work) => {
      const child = work.children.create(execution, null);
      await child.run();
      relation = () => work.children.facts.get(child.ref);
      return child.accept(() => {
        throw new Error('parent acceptance');
      });
    }),
    { observations: [observation.installation] },
  );
  await assert.rejects(runtime.run(null, {}), /parent acceptance/);
  assert.equal(relation().returned.status, 'succeeded');
  assert.equal(relation().returned.output, 2);
  assert.equal(observation.facts.find((fact) => fact.kind === 'finished' && fact.identity.level === 'execution').state.status, 'succeeded');
  assert.equal(relation().reception.status, 'failed');
});

test('R handles a declared E exception through the ordinary child relationship', async () => {
  const rejected = new ExceptionContract('EXECUTION_REJECTED');
  let parent;
  const execution = new TestExecutionDefinition(() => {
    throw rejected.create('unavailable', { reason: 'expected' });
  });
  execution.raises = [rejected];
  const definition = new Main(
    [execution],
    forward(execution, (work) => {
      parent = work;
    }),
  );
  definition.exceptions = {
    requires: {},
    accepts: [rejected],
    handle: (work) => {
      const [relation] = work.children.facts.values();
      assert.equal(relation.returned.failure.kind, 'exception');
      assert.equal(relation.returned.diagnostic.message, work.exception.message);
      assert.equal(relation.reception.status, 'pending');
      assert.equal(work.origin.kind, 'child-return');
      assert.equal(work.origin.child, relation.ref);
      return work.return('handled');
    },
  };
  const runtime = assemble(definition);
  assert.equal(await runtime.run(null, {}), 'handled');
  assert.equal(parent.children.facts.values()[0].returned.status, 'failed');
});

test('R reports actual terminal observation failure while preserving successful work', async () => {
  let parent;
  let fail = true;
  let finished;
  const execution = new TestExecutionDefinition(() => 'output');
  const installation = {
    failure: 'propagate',
    bindInvocation: () => ({
      observe(fact) {
        if (fail && fact.identity.level === 'runtime' && fact.kind === 'finished') {
          finished = fact.state;
          fail = false;
          throw new Error('terminal observation');
        }
      },
    }),
  };
  const runtime = assemble(
    new Main(
      [execution],
      forward(execution, (work) => {
        parent = work;
      }),
    ),
    { observations: [installation] },
  );
  await assert.rejects(runtime.run(null, {}), { code: 'OBSERVATION_FAILED' });
  assert.equal(finished.status, 'succeeded');
  assert.equal(parent.children.facts.values()[0].reception.status, 'accepted');
  assert.equal(runtime.running, false);
  assert.equal(await runtime.run(null, {}), 'output');
});

test('E entry failures cannot masquerade as a declared E work exception', async () => {
  const rejected = new ExceptionContract('ENTRY_REJECTED');
  const execution = new TestExecutionDefinition(() => assert.fail('must not execute'), {
    requires: {},
    accept: () => {
      throw rejected.create('invalid', {});
    },
  });
  execution.raises = [rejected];
  const definition = new Main([execution], forward(execution));
  definition.exceptions = { requires: {}, accepts: [rejected], handle: () => assert.fail('entry errors are structural') };
  const runtime = assemble(definition);
  await assert.rejects(runtime.run(null, {}), { code: 'INVOCATION_FAILED' });
  assert.equal(runtime.running, false);
});

test('omitted observation installation leaves declarations and their dependencies dormant', async () => {
  const onlyObservation = new ResourceOffer('test.observation-only', (value) => value);
  let observed = 0;
  const execution = new TestExecutionDefinition(() => 'done');
  execution.observation = [
    {
      requires: { extra: onlyObservation.request() },
      observe() {
        observed++;
      },
    },
  ];
  const definition = new Main([execution], forward(execution));
  assert.equal(await assemble(definition).run(null, {}), 'done');
  assert.equal(observed, 0);
  assert.throws(() => assemble(definition, { observations: [] }), /Expected one resource provider/);
});

test('an explicit empty observation installation enables resource-free declarations', async () => {
  const events = [];
  const execution = new TestExecutionDefinition(() => 'done');
  execution.observation = [
    {
      requires: {},
      observe(event) {
        events.push(event.kind);
      },
    },
  ];
  const definition = new Main([execution], forward(execution));
  assert.equal(await assemble(definition).run(null, {}), 'done');
  assert.deepEqual(events, []);
  assert.equal(await assemble(definition, { observations: [] }).run(null, {}), 'done');
  assert.equal(events[0], 'started');
  assert.equal(events.at(-1), 'finished');
});

test('observation installations cannot satisfy work or exception-handler resource requests', () => {
  const installed = new ResourceOffer('test.installed', (value) => value);
  const installation = { provides: { local: installed.request() }, bindInvocation: () => ({ observe() {} }) };
  for (const phase of ['run', 'exceptions']) {
    const execution = new TestExecutionDefinition(() => 'done');
    if (phase === 'run') execution.run.requires = { forbidden: installed.request() };
    else execution.exceptions = { requires: { forbidden: installed.request() }, accepts: [], handle: () => assert.fail('not reached') };
    assert.throws(() => assemble(new Main([execution], forward(execution)), { observations: [installation] }), /Expected one resource provider/);
  }
});

test('E entry stages publish parent-owned facts before E context creation', async () => {
  const observed = probe();
  const changes = [];
  const execution = new TestExecutionDefinition((work) => work.input, { requires: {}, accept: (input) => input + 1, admit() {} });
  const runtime = assemble(new Main([execution], forward(execution)), {
    observations: [observed.installation],
    changes: {
      capture: (event) => {
        changes.push(event);
      },
    },
    source: { entry: () => undefined, capture: () => undefined, callbacks: () => ({ accepted() {} }) },
  });
  assert.equal(await runtime.run(1, {}), 2);
  const entries = observed.facts.filter((fact) => fact.kind === 'entry');
  assert.deepEqual(
    entries.map((fact) => [fact.stage, fact.status]),
    [
      ['accept', 'accepted'],
      ['notification', 'accepted'],
      ['admit', 'accepted'],
      ['capture', 'accepted'],
    ],
  );
  assert.equal(new Set(entries.map((fact) => fact.instanceId)).size, 1);
  const eStarted = observed.facts.find((fact) => fact.kind === 'started' && fact.identity.level === 'execution');
  for (const fact of entries) {
    assert.equal(fact.identity.contextId, eStarted.identity.parentContextId);
    assert.equal(fact.identity.level, 'runtime');
    assert.equal(fact.key, 'chosen');
    assert.equal(fact.instanceId, eStarted.description.id);
    assert.equal('input' in fact, false);
  }
  assert.equal(changes.filter((event) => event.change.kind === 'entry').length, 4);
  assert.equal(
    changes.filter((event) => event.level === 'runtime').every((event, index, values) => index === 0 || event.sequence === values[index - 1].sequence + 1),
    true,
  );
});

for (const stage of ['accept', 'notification', 'admit', 'capture']) {
  test(`E ${stage} failure reports that stage without inventing an E invocation`, async () => {
    const observed = probe();
    const failure = new Error(`${stage} failed`);
    const fail = () => {
      throw failure;
    };
    const execution = new TestExecutionDefinition(() => assert.fail('unreachable'), { requires: {}, accept: stage === 'accept' ? fail : (input) => input, admit: stage === 'admit' ? fail : () => undefined });
    const runtime = assemble(new Main([execution], forward(execution)), {
      observations: [observed.installation],
      source: { entry: () => undefined, capture: stage === 'capture' ? fail : () => undefined, callbacks: () => ({ accepted: stage === 'notification' ? fail : () => undefined }) },
    });
    await assert.rejects(runtime.run(null, {}), (error) => error === failure);
    const entries = observed.facts.filter((fact) => fact.kind === 'entry');
    assert.equal(entries.at(-1).stage, stage);
    assert.equal(entries.at(-1).status, 'failed');
    assert.equal(entries.at(-1).error, failure);
    assert.equal(
      observed.facts.some((fact) => fact.kind === 'started' && fact.identity.level === 'execution'),
      false,
    );
    assert.equal(
      observed.facts.some((fact) => fact.kind === 'relation'),
      false,
    );
    if (stage === 'notification') assert.equal(entries[0].status, 'accepted');
  });
}

test('entry observation propagation preserves accepted fact and does not publish a false entry failure', async () => {
  let notifications = 0;
  const observed = probe();
  const failure = new Error('observer failed');
  const execution = new TestExecutionDefinition(() => assert.fail('unreachable'));
  const runtime = assemble(new Main([execution], forward(execution)), {
    observations: [
      {
        failure: 'propagate',
        bindInvocation: () => ({
          observe: (fact) => {
            if (fact.kind === 'entry') throw failure;
          },
        }),
      },
      observed.installation,
    ],
    source: {
      entry: () => undefined,
      capture: () => undefined,
      callbacks: () => ({
        accepted: () => {
          notifications++;
        },
      }),
    },
  });
  await assert.rejects(runtime.run(null, {}), (error) => error.cause === failure);
  assert.equal(notifications, 0);
  assert.deepEqual(
    observed.facts.filter((fact) => fact.kind === 'entry').map((fact) => fact.status),
    ['accepted'],
  );
  assert.equal(observed.facts.find((fact) => fact.kind === 'finished').state.status, 'failed');
});

test('enabled observation installations check actual static parent declarations', () => {
  const checked = [];
  const execution = new TestExecutionDefinition(() => 'done');
  const definition = new Main([execution], forward(execution));
  const installation = {
    check(scope, parent) {
      checked.push([scope.level, parent?.level]);
    },
    bindInvocation: () => ({ observe() {} }),
  };
  assemble(definition, { observations: [installation] });
  assert.deepEqual(checked, [
    ['runtime', undefined],
    ['execution', 'runtime'],
  ]);
});

test('parent retains child failure and returned-observation failure without replacing child delivery', async () => {
  const original = new Error('child work failed');
  const reporting = new Error('parent returned observation failed');
  let relation;
  let childError;
  const execution = new TestExecutionDefinition(() => {
    throw original;
  });
  const definition = new Main([execution], async (work) => {
    const child = work.children.create(execution, work.input);
    try {
      await child.run();
    } catch (error) {
      childError = error;
      relation = () => work.children.facts.get(child.ref);
      throw error;
    }
  });
  const runtime = assemble(definition, {
    observations: [
      {
        failure: 'propagate',
        bindInvocation: () => ({
          observe(fact) {
            if (fact.kind === 'relation' && fact.change.kind === 'returned' && fact.change.result.status === 'failed') throw reporting;
          },
        }),
      },
    ],
  });
  await assert.rejects(runtime.run(null, {}), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors[0], original);
    assert.equal(error.errors[1].cause, reporting);
    return true;
  });
  assert.equal(childError, original);
  assert.equal(relation().returned.status, 'failed');
  assert.equal(relation().returned.diagnostic.message, original.message);
  assert.equal(relation().reception.status, 'pending');
  assert.equal(runtime.running, false);
});
