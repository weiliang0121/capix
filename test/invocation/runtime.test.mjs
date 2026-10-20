import { installCallable } from '../fixtures/driver.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Scene, Group, ExceptionContract, ResourceOffer } from '@capix/server-runtime';

class TestExecutionDefinition extends Group {
  constructor(execute) {
    super();
    this.run = { requires: {}, execute };
  }
}

class Main extends Scene {
  constructor(children, execute) {
    super();
    this.members = children;
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
  const { memberSource, ...installation } = options;
  const bindings = memberSource
    ? definition.members.map((member) => ({
        definition: member,
        capture: memberSource.capture ? (input, options) => memberSource.capture(input, options, member) : undefined,
        started: memberSource.callbacks ? (options) => memberSource.callbacks(options)?.started : undefined,
      }))
    : [];
  return installCallable(definition, { providers: [], source: { capture: () => undefined }, bindings, ...installation });
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
  const starts = observation.facts.filter((fact) => fact.kind === 'started' && fact.identity.kind === 'scene');
  const finishes = observation.facts.filter((fact) => fact.kind === 'finished' && fact.identity.kind === 'scene');
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
    const childStart = observation.facts.find((fact) => fact.kind === 'started' && fact.identity.kind === 'group' && fact.identity.parentContextId === starts[index].identity.contextId);
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

test('R chooses from declared E nodes without capturing unused E supplies', async () => {
  const chosen = [];
  const first = new TestExecutionDefinition(() => 'first');
  const second = new TestExecutionDefinition(() => 'second');
  const runtime = assemble(
    new Main([first, second], async (work) => {
      const selected = work.input === 1 ? first : second;
      const child = work.children.create(selected, work.input);
      await child.run();
      return child.accept();
    }),
    { memberSource: { capture: (_input, _options, definition) => chosen.push(definition === first ? 'first' : 'second') } },
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

test('R input preparation failure belongs to R before any E context or relation exists', async () => {
  let parent;
  const execution = new TestExecutionDefinition(() => assert.fail('must not execute'));
  const observation = probe();
  const runtime = assemble(
    new Main([execution], (work) => {
      parent = work;
      throw new Error('bad input');
    }),
    { observations: [observation.installation] },
  );
  await assert.rejects(runtime.run(null, {}), /bad input/);
  assert.equal(observation.facts.find((fact) => fact.kind === 'finished' && fact.identity.kind === 'scene').state.status, 'failed');
  assert.equal(parent.children.facts.values().length, 0);
  assert.equal(
    observation.facts.some((fact) => fact.identity.kind === 'group'),
    false,
  );
  assert.equal(runtime.running, false);
});

test('R prepares ordinary E input before E capture and construction', async () => {
  const order = [];
  const messages = [];
  const execution = new TestExecutionDefinition((work) => {
    order.push('execute');
    return work.input;
  });
  const runtime = assemble(
    new Main([execution], async (work) => {
      order.push('R');
      messages.push(work.input);
      order.push('append');
      const child = work.children.create(execution, { content: work.input });
      await child.run();
      return child.accept();
    }),
    {
      memberSource: {
        capture: (input) => {
          order.push('capture');
          assert.deepEqual(messages, ['input']);
          assert.deepEqual(input, { content: 'input' });
        },
        callbacks: () => ({
          started: () => {
            order.push('started');
          },
        }),
      },
    },
  );
  assert.deepEqual(await runtime.run('input', {}), { content: 'input' });
  assert.deepEqual(order, ['R', 'append', 'capture', 'started', 'execute']);
});

test('cancellation before R work does not prepare or append input', async () => {
  let prepared = 0;
  const execution = new TestExecutionDefinition(() => assert.fail('must not execute'));
  const runtime = assemble(
    new Main([execution], (work) => {
      prepared++;
      return forward(execution)(work);
    }),
  );
  await assert.rejects(runtime.run('input', { signal: AbortSignal.abort() }));
  assert.equal(prepared, 0);
  assert.equal(runtime.running, false);
});

test('cancellation after R content preparation retains content without creating E', async () => {
  const messages = [];
  const controller = new AbortController();
  const execution = new TestExecutionDefinition(() => assert.fail('must not execute'));
  const observed = probe();
  const runtime = assemble(
    new Main([execution], (work) => {
      messages.push(work.input);
      controller.abort();
      return forward(execution)(work);
    }),
    { observations: [observed.installation], memberSource: { capture: () => assert.fail('cancelled parent cannot capture E') } },
  );
  await assert.rejects(runtime.run('input', { signal: controller.signal }));
  assert.deepEqual(messages, ['input']);
  assert.equal(
    observed.facts.some((fact) => fact.identity.kind === 'group'),
    false,
  );
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
      memberSource: { capture: () => 'value' },
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
  assert.equal(observation.facts.find((fact) => fact.kind === 'finished' && fact.identity.kind === 'group').state.status, 'succeeded');
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
        if (fail && fact.identity.kind === 'scene' && fact.kind === 'finished') {
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

test('E capture failures cannot masquerade as a declared E work exception', async () => {
  const rejected = new ExceptionContract('CAPTURE_REJECTED');
  const execution = new TestExecutionDefinition(() => assert.fail('must not execute'));
  execution.raises = [rejected];
  const definition = new Main([execution], forward(execution));
  definition.exceptions = { requires: {}, accepts: [rejected], handle: () => assert.fail('capture errors are structural') };
  const runtime = assemble(definition, {
    memberSource: {
      capture: () => {
        throw rejected.create('invalid', {});
      },
    },
  });
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

test('ordinary R input preparation creates only real R/E invocation facts', async () => {
  const observed = probe();
  const changes = [];
  const execution = new TestExecutionDefinition((work) => work.input);
  const runtime = assemble(
    new Main([execution], async (work) => {
      const child = work.children.create(execution, work.input + 1);
      await child.run();
      return child.accept();
    }),
    { observations: [observed.installation], changes: { capture: (event) => changes.push(event) } },
  );
  assert.equal(await runtime.run(1, {}), 2);
  assert.equal(
    observed.facts.some((fact) => fact.kind === 'entry'),
    false,
  );
  const eStarted = observed.facts.find((fact) => fact.kind === 'started' && fact.identity.kind === 'group');
  assert.equal(eStarted.input, 2);
  assert.equal(
    changes.some((event) => event.change.kind === 'entry'),
    false,
  );
  assert.equal(
    changes.filter((event) => event.kind === 'scene').every((event, index, values) => index === 0 || event.sequence === values[index - 1].sequence + 1),
    true,
  );
});

test('capture failure records R failure without inventing an E invocation', async () => {
  const observed = probe();
  const failure = new Error('capture failed');
  const execution = new TestExecutionDefinition(() => assert.fail('unreachable'));
  const runtime = assemble(new Main([execution], forward(execution)), {
    observations: [observed.installation],
    memberSource: {
      capture: () => {
        throw failure;
      },
    },
  });
  await assert.rejects(runtime.run(null, {}), (error) => error === failure);
  assert.equal(
    observed.facts.some((fact) => fact.kind === 'started' && fact.identity.kind === 'group'),
    false,
  );
  assert.equal(
    observed.facts.some((fact) => fact.kind === 'relation'),
    false,
  );
  assert.equal(observed.facts.find((fact) => fact.kind === 'finished').state.error, failure);
});

test('R prepares content once and calls several E with ordinary independent inputs', async () => {
  const appended = [];
  const captured = [];
  const execution = new TestExecutionDefinition((work) => work.input.value);
  const runtime = assemble(
    new Main([execution], async (work) => {
      appended.push(work.input);
      const first = work.children.create(execution, { value: work.input + 1 });
      await first.run();
      const accepted = await first.accept();
      const second = work.children.create(execution, { value: accepted + 1 });
      await second.run();
      return second.accept();
    }),
    { memberSource: { capture: (input) => captured.push(input) } },
  );
  assert.equal(await runtime.run(1, {}), 3);
  assert.deepEqual(appended, [1]);
  assert.deepEqual(captured, [{ value: 2 }, { value: 3 }]);
});

test('enabled observation installations check actual static parent declarations', () => {
  const checked = [];
  const execution = new TestExecutionDefinition(() => 'done');
  const definition = new Main([execution], forward(execution));
  const installation = {
    check(scope, parent) {
      checked.push([scope.kind, parent?.kind]);
    },
    bindInvocation: () => ({ observe() {} }),
  };
  assemble(definition, { observations: [installation] });
  assert.deepEqual(checked, [
    ['scene', undefined],
    ['group', 'scene'],
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
