import { ResourceBindings, bindResources } from '../fixtures/resources.mjs';
import { invocationResourceFailures } from '@weiliang0121/capix-runtime/construction';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Invocation, InvocationContext, InvocationChangeEmitter, bindInvocationObservation, defineObservation, Driver, defineNode } from '@weiliang0121/capix-runtime';
import { Transcript } from '@weiliang0121/capix-transcript';
import { ResourceAccessClosed, ResourceOffer } from '@weiliang0121/capix-resources';

function call({ observe, failure, work, parent, declarations, resources, capture, installations = [] } = {}) {
  const context = new InvocationContext({ value: [] });
  const identity = { contextId: context.id, kind: 'node', ...(parent ? { parentContextId: parent.context.id } : {}) };
  return new Invocation({ context, identity, parent: parent ? { invocation: parent } : undefined, signal: new AbortController().signal, work: { execute: () => 'output', ...work }, observation: bindInvocationObservation({ identity, resources: resources ?? new ResourceBindings({}), declarations: declarations ?? [defineObservation({ deps: {}, observe: observe ?? (() => undefined) }, { failure })] }, installations, parent?.observation), changes: capture ? new InvocationChangeEmitter(identity, capture) : undefined });
}

function observer(observe, failure) {
  return defineObservation({ deps: {}, observe }, { failure });
}

test('isolated observer stops once while a healthy observer receives all actual call facts', async () => {
  let broken = 0;
  const healthy = [];
  const run = call({
    declarations: [
      observer(() => {
        broken++;
        throw new Error('sink');
      }),
      observer((fact) => {
        healthy.push(fact);
      }),
    ],
  });
  assert.equal(await run.run(), 'output');
  assert.equal(broken, 1);
  assert.deepEqual(
    healthy.map((fact) => fact.eventSequence),
    [1, 2, 3, 4],
  );
  assert.equal(healthy.at(-1).state.status, 'succeeded');
});

test('propagation still dispatches the same fact to healthy peers before stopping work', async () => {
  let effects = 0;
  const healthy = [];
  const run = call({
    declarations: [
      observer(() => {
        throw new Error('sink');
      }, 'propagate'),
      observer((fact) => {
        healthy.push(fact.kind);
      }),
    ],
    work: {
      execute() {
        effects++;
      },
    },
  });
  await assert.rejects(run.run(), { code: 'OBSERVATION_FAILED' });
  assert.equal(effects, 0);
  assert.deepEqual(healthy, ['started', 'finished']);
});

test('required capture and optional observers consume the committed fact independently', async () => {
  const seen = [];
  const run = call({
    capture: {
      capture() {
        throw new Error('buffer');
      },
    },
    observe(fact) {
      seen.push(fact.kind);
    },
  });
  await assert.rejects(run.run());
  assert.deepEqual(seen, ['started', 'finished']);
});

test('parent returned observation failure never becomes a second child return', async () => {
  let child;
  let childValue;
  const facts = [];
  const parent = call({
    declarations: [
      observer((fact) => {
        if (fact.kind === 'relation' && fact.change.kind === 'returned') throw new Error('parent observer');
      }, 'propagate'),
      observer((fact) => {
        facts.push(fact);
      }),
    ],
    work: {
      async execute(_context, owner) {
        child = call({ parent: owner });
        childValue = await child.run();
        return childValue;
      },
    },
  });
  await assert.rejects(parent.run(), { code: 'OBSERVATION_FAILED' });
  assert.equal(childValue, 'output');
  assert.equal(child.context.status, 'succeeded');
  assert.equal(child.failure, undefined);
  assert.equal(parent.children.get(child).returned.status, 'succeeded');
  assert.equal(facts.filter((fact) => fact.kind === 'relation' && fact.change.kind === 'returned').length, 1);
});

for (const phase of ['receiving', 'accepted']) {
  test(`parent ${phase} failure keeps the actual reception state`, async () => {
    let child;
    let effects = 0;
    const parent = call({
      observe(fact) {
        if (fact.kind === 'relation' && fact.change.kind === phase) throw new Error(phase);
      },
      failure: 'propagate',
      work: {
        async execute(_context, owner) {
          child = call({ parent: owner });
          await child.run();
          return owner.children.get(child).accept(() => {
            effects++;
            return 'accepted output';
          });
        },
      },
    });
    await assert.rejects(parent.run(), { code: 'OBSERVATION_FAILED' });
    assert.equal(child.context.status, 'succeeded');
    assert.equal(effects, phase === 'accepted' ? 1 : 0);
    assert.equal(parent.children.get(child).reception.status, phase === 'accepted' ? 'accepted' : 'failed');
  });
}

test('work failure and failing observation preserve both causes without entering business handling', async () => {
  const original = new Error('work');
  const observed = new Error('observer');
  const run = call({
    work: {
      execute() {
        throw original;
      },
    },
    observe(fact) {
      if (fact.kind === 'process' && fact.process.type === 'throw') throw observed;
    },
    failure: 'propagate',
  });
  await assert.rejects(run.run(), (error) => error instanceof AggregateError && error.errors[0] === original && error.errors[1].cause === observed);
  assert.equal(run.failure.kind, 'error');
});

test('formal observation ports expire after each synchronous callback; asynchronous declarations are rejected', async () => {
  let retained;
  let writes = 0;
  const offer = new ResourceOffer({
    name: 'test.observation-writer',
    expose: (_value, activity) => ({
      write() {
        activity.validate();
        writes++;
      },
    }),
  });
  const requirements = { writer: offer.request() };
  const resources = bindResources(requirements, [offer.provide(() => null)])(undefined);
  const run = call({
    resources,
    declarations: [
      defineObservation({
        deps: requirements,
        observe(_fact, ports) {
          retained = ports.writer;
          retained.write();
        },
      }),
    ],
  });
  await run.run();
  assert.equal(writes, 4);
  assert.throws(() => retained.write(), ResourceAccessClosed);
  const asyncRun = call({ observe: async () => {}, failure: 'propagate' });
  await assert.rejects(asyncRun.run(), (error) => error.cause?.message === 'Observation must complete synchronously');
});

test('each observation callback gets a new synchronous window and never reactivates earlier endpoints', async () => {
  let exposed = 0;
  const retained = new Map();
  const observed = new Map();
  const offer = new ResourceOffer({
    name: 'test.reused-observation',
    expose: (value, activity) => {
      exposed++;
      return {
        read() {
          activity.validate();
          return value;
        },
      };
    },
    timing: 'binding',
  });
  const deps = { reader: offer.request() };
  const resources = bindResources(deps, [offer.provide(() => 'shared supply')])(undefined);
  const declaration = defineObservation(
    {
      deps,
      observe(fact, ports) {
        const contextId = fact.identity.contextId;
        for (const endpoint of retained.values()) {
          assert.throws(() => endpoint.read(), ResourceAccessClosed);
        }
        const previous = retained.get(contextId);
        if (previous) assert.notEqual(ports.reader, previous);
        retained.set(contextId, ports.reader);
        observed.set(contextId, (observed.get(contextId) ?? 0) + 1);
        assert.equal(ports.reader.read(), 'shared supply');
      },
    },
    { failure: 'propagate' },
  );
  const first = call({ resources, declarations: [declaration] });
  const second = call({ resources, declarations: [declaration] });
  assert.equal(exposed, 0);
  assert.deepEqual(await Promise.all([first.run(), second.run()]), ['output', 'output']);
  assert.equal(exposed, 8);
  assert.equal(observed.get(first.context.id), 4);
  assert.equal(observed.get(second.context.id), 4);
  assert.notEqual(retained.get(first.context.id), retained.get(second.context.id));
  for (const endpoint of retained.values()) assert.throws(() => endpoint.read(), ResourceAccessClosed);
});

test('observation declaration fixes its requested resource aliases before binding', async () => {
  const approved = new ResourceOffer({
    name: 'test.approved-observation',
    expose: (value, activity) => ({
      read() {
        activity.validate();
        return value;
      },
    }),
  });
  const replacement = new ResourceOffer({ name: 'test.replacement-observation', expose: () => assert.fail('replacement must not be exposed') });
  const deps = { reader: approved.request() };
  const request = deps.reader;
  let retained;
  let observed = 0;
  const definition = {
    deps,
    observe(_fact, ports) {
      retained = ports.reader;
      observed++;
      assert.equal(retained.read(), 'approved');
      assert.deepEqual(Object.keys(ports), ['reader']);
    },
  };
  const declaration = defineObservation(definition, { failure: 'propagate' });
  deps.reader = replacement.request();
  deps.extra = replacement.request();
  definition.deps = { replacement: replacement.request() };
  assert.ok(Object.isFrozen(declaration));
  assert.ok(Object.isFrozen(declaration.deps));
  assert.notEqual(declaration.deps, deps);
  assert.deepEqual(declaration.deps, { reader: request });
  const resources = bindResources({ approved: approved.request(), replacement: replacement.request() }, [approved.provide(() => 'approved'), replacement.provide(() => null)])(undefined);
  assert.equal(await call({ resources, declarations: [declaration] }).run(), 'output');
  assert.equal(observed, 4);
  assert.throws(() => retained.read(), ResourceAccessClosed);
});

test('failed installed observation is skipped with its dependent declarations in children and recovers in a later root call', async () => {
  const events = [];
  const supplied = [];
  const inherited = [];
  let failNext = true;
  const writer = new ResourceOffer({
    name: 'test.installed-observation-writer',
    expose: (contextId, activity) => ({
      write() {
        activity.validate();
        events.push(`${contextId}:dependent`);
      },
    }),
  });
  const installation = {
    provides: { writer: writer.request() },
    bindInvocation(setup) {
      supplied.push(setup.identity.contextId);
      return {
        resources: bindResources(this.provides, [writer.provide(() => setup.identity.contextId)])(undefined),
        observe(fact) {
          if (fact.kind !== 'started') return;
          events.push(`${fact.identity.contextId}:installed`);
          if (failNext) {
            failNext = false;
            throw new Error('first root consumer failed');
          }
        },
      };
    },
  };
  const healthy = {
    bindInvocation(setup, parent) {
      inherited.push({ contextId: setup.identity.contextId, parent });
      return {
        observe(fact) {
          if (fact.kind === 'started') events.push(`${fact.identity.contextId}:healthy`);
        },
      };
    },
  };
  const declarations = [
    defineObservation({
      deps: { writer: writer.request() },
      observe(fact, ports) {
        if (fact.kind === 'started') ports.writer.write();
      },
    }),
    observer((fact) => {
      if (fact.kind === 'started') events.push(`${fact.identity.contextId}:independent`);
    }),
  ];
  const installations = [installation, healthy];
  let child;
  const first = call({
    declarations,
    installations,
    work: {
      execute(_context, parent) {
        child = call({ declarations, installations, parent });
        return child.run();
      },
    },
  });
  assert.equal(await first.run(), 'output');
  const next = call({ declarations, installations });
  assert.equal(await next.run(), 'output');
  assert.deepEqual(supplied, [first.context.id, next.context.id]);
  assert.equal(inherited.length, 3);
  assert.equal(inherited[0].parent, undefined);
  assert.ok(inherited[1].parent);
  assert.equal(inherited[2].parent, undefined);
  assert.deepEqual(events, [`${first.context.id}:installed`, `${first.context.id}:healthy`, `${first.context.id}:independent`, `${child.context.id}:healthy`, `${child.context.id}:independent`, `${next.context.id}:installed`, `${next.context.id}:healthy`, `${next.context.id}:dependent`, `${next.context.id}:independent`]);
});

test('a committed Transcript fact reaches observation even when capture fails; reentrant writes are rejected', () => {
  let transcript;
  const seen = [];
  transcript = new Transcript([], {
    changes: {
      capture() {
        throw new Error('buffer');
      },
    },
    observation: {
      publish(event) {
        seen.push(event);
        assert.throws(() => transcript.append({ role: 'user', content: 'nested' }), /reenter/);
      },
    },
  });
  assert.throws(() => transcript.append({ role: 'user', content: 'committed' }));
  assert.equal(transcript.length, 1);
  assert.equal(transcript.revision, 1);
  assert.equal(seen.length, 1);
});

test('Runtime structure facts have their own order and failed acquisition reporting still releases occupancy', async () => {
  const facts = [];
  const driver = new Driver({
    observations: [
      {
        failure: 'propagate',
        bindInvocation() {
          return { observe() {} };
        },
        bindDriver(identity) {
          return {
            observe(fact) {
              facts.push(fact);
              assert.equal(fact.driverId, identity.driverId);
              if (fact.kind === 'acquired') throw new Error('acquire observer');
            },
          };
        },
      },
    ],
  });
  let calls = 0;
  const bound = driver.build(
    defineNode()({
      run: () => {
        calls++;
        return 'next';
      },
    }),
    { providers: [], source: { capture: () => null } },
  );
  await assert.rejects(driver.run(bound, null, {}), { code: 'OBSERVATION_FAILED' });
  assert.equal(calls, 0);
  assert.equal(driver.isRunning(bound), false);
  assert.equal(await driver.run(bound, null, {}), 'next');
  assert.equal(calls, 1);
  assert.equal(facts[1].boundId, bound.id);
  assert.deepEqual(
    facts.map((fact) => fact.kind),
    ['established', 'acquired'],
  );
  assert.deepEqual(
    facts.map((fact) => fact.sequence),
    [1, 2],
  );
});

test('an availability check failure follows the observer isolation policy', async () => {
  const seen = [];
  let invalidated = 0;
  const context = new InvocationContext(null);
  const identity = { contextId: context.id, kind: 'node' };
  const observation = bindInvocationObservation({ identity, resources: new ResourceBindings({}) }, [
    {
      bindInvocation() {
        return {
          available() {
            throw new Error('availability');
          },
          observe() {
            assert.fail('disabled');
          },
        };
      },
      invalidate() {
        invalidated++;
      },
    },
    {
      bindInvocation() {
        return {
          observe(fact) {
            seen.push(fact);
          },
        };
      },
    },
  ]);
  const invocation = new Invocation({ context, identity, observation, signal: new AbortController().signal, work: { execute: () => 'done' } });
  assert.equal(await invocation.run(), 'done');
  assert.equal(invalidated, 1);
  assert.equal(seen.at(-1).kind, 'finished');
});

test('resource construction and its observation failure retain both causes', () => {
  const original = new Error('capture');
  const observed = new Error('unavailable observer');
  const offer = new ResourceOffer({ name: 'test.capture-fails', expose: () => ({}) });
  const resources = bindResources({ value: offer.request() }, [
    offer.provide(() => {
      throw original;
    }),
  ])(undefined);
  resources.attach({
    failures: invocationResourceFailures,
    contextId: 'call',
    validate() {},
    observation: {
      publish(fact) {
        if (fact.phase === 'unavailable') return observed;
      },
    },
  });
  resources.start();
  assert.throws(
    () => resources.values.value,
    (error) => error instanceof AggregateError && error.errors[0] === original && error.errors[1] === observed,
  );
});

test('the invocation error channel preserves a resource fault and its reporting fault together', async () => {
  const original = new Error('resource construction');
  const observed = new Error('resource report');
  const offer = new ResourceOffer({ name: 'test.resource-double-fault', expose: () => ({}) });
  const resources = bindResources({ value: offer.request() }, [
    offer.provide(() => {
      throw original;
    }),
  ])(undefined);
  const context = new InvocationContext(null);
  const invocation = new Invocation({
    context,
    signal: new AbortController().signal,
    work: {
      execute() {
        return resources.values.value;
      },
    },
  });
  resources.attach({
    failures: invocationResourceFailures,
    contextId: context.id,
    validate() {},
    error: (error) => invocation.reject(error),
    observation: {
      publish(fact) {
        if (fact.phase === 'unavailable') return observed;
      },
    },
  });
  resources.start();
  await assert.rejects(invocation.run(), (error) => error instanceof AggregateError && error.errors[0] === original && error.errors[1] === observed);
  assert.equal(invocation.failure.kind, 'error');
});
