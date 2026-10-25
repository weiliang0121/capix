import { installCallable } from './fixtures/driver.mjs';
import { runtimeDefinition, recordDefinitions, recordedCall } from './fixtures/declarations.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ExceptionContract, Group, InvocationEntry, ResourceOffer, Recorder, RecordBook, bindCallSource, CallableRecordHelper, bindRecording, invocationRecording } from '@capix/server-runtime';
import { validateExecutionRecordSnapshot, readOutput } from '@capix/protocol';

const rejected = new ExceptionContract('test.rejected');

function assemble(execution, providers = [], recorder) {
  const definition = runtimeDefinition(execution);
  const observations = recorder ? [bindRecording(recorder, { failure: 'propagate' })] : undefined;
  if (observations) recordDefinitions(definition);
  return installCallable(definition, { providers, observations, source: { capture: () => null }, bindings: [bindCallSource(execution, { started: (options) => options.execution?.started })] });
}

test('peer declarations share fixed supplies but have separate aliases and phase endpoints', async () => {
  let captures = 0;
  let late = 0;
  const shared = new ResourceOffer({ name: 'test.shared', expose: (source, activity) => ({ read: () => activity.runSync('read', {}, () => source) }), timing: 'binding' });
  const recovery = new ResourceOffer({ name: 'test.recovery', expose: (source, activity) => ({ read: () => activity.runSync('read', {}, () => source) }), timing: 'access' });
  const recorder = new Recorder(new RecordBook());
  let call;
  class Main extends Group {
    raises = [rejected];
    deps = { value: shared.request() };
    run = function (work) {
      assert.deepEqual(Object.keys(work.resources), ['value']);
      assert.equal(work.resources.value.read(), 7);
      if (work.round === 1) {
        assert.equal(late, 0);
        throw rejected.create('expected', { at: 1 });
      }
      return work.input;
    };
    maxRounds = 2;
    exceptions = {
      deps: { recovered: shared.request(), late: recovery.request() },
      accepts: [rejected],
      handle(work) {
        assert.equal(work.exception.contract, rejected);
        assert.deepEqual(Object.keys(work.resources), ['recovered', 'late']);
        assert.equal(work.resources.recovered.read(), 7);
        assert.equal(work.resources.late.read(), 9);
        return work.continue(work.input + 1, 'resolved');
      },
    };
  }
  const runtime = assemble(
    new Main(),
    [
      shared.provide(() => {
        captures++;
        return 7;
      }),
      recovery.provide(() => {
        late++;
        return 9;
      }),
    ],
    recorder,
  );
  assert.equal(
    await runtime.run(1, {
      execution: {
        started: (_context, invocation) => {
          call = invocation;
        },
      },
    }),
    2,
  );
  assert.equal(captures, 1);
  assert.equal(late, 1);
  const snapshot = CallableRecordHelper.snapshot(recorder, recordedCall(recorder, call).id);
  validateExecutionRecordSnapshot(snapshot);
  assert.equal(snapshot.resources.filter((fact) => fact.access === 'test.shared' && fact.phase === 'bound').length, 1);
  assert.equal(snapshot.resources.filter((fact) => fact.access === 'test.shared' && fact.phase === 'available').length, 1);
});

test('handler-only lazy resources are not obtained on the success path', async () => {
  const unused = new ResourceOffer({ name: 'test.unused', expose: (value) => value, timing: 'access' });
  class Main extends Group {
    deps = {};
    run = () => 'done';
    exceptions = { deps: { unused: unused.request() }, accepts: [rejected], handle: () => assert.fail('not entered') };
  }
  const runtime = assemble(new Main(), [unused.provide(() => assert.fail('handler resource must remain lazy'))]);
  assert.equal(await runtime.run(null, {}), 'done');
});

test('a caught child error blocks later child entry admission and reception work', async () => {
  const failure = new Error('child failed');
  let entryEffects = 0;
  let receptionEffects = 0;
  class Good extends Group {
    name = 'good';
    label = 'good';
    source = 'test';
    deps = {};
    run = () => 'done';
  }
  class Bad extends Group {
    name = 'bad';
    label = 'bad';
    source = 'test';
    deps = {};
    run = () => {
      throw failure;
    };
  }
  const good = new Good();
  const bad = new Bad();
  const entry = new InvocationEntry(good, ({ input }) => {
    entryEffects++;
    return input;
  });
  class Main extends Group {
    constructor() {
      super();
      this.add(good, bad);
    }
    deps = {};
    run = async function (work) {
      const completed = work.children.create(good, null);
      assert.equal(await completed.run(), 'done');
      await assert.rejects(work.children.create(bad, null).run(), (error) => error === failure);
      assert.throws(
        () => work.children.entry(entry, null),
        (error) => error === failure,
      );
      await assert.rejects(
        completed.accept(() => {
          receptionEffects++;
          return 'accepted';
        }),
        (error) => error === failure,
      );
      return 'caught';
    };
  }
  await assert.rejects(assemble(new Main()).run(null, {}), (error) => error === failure);
  assert.equal(entryEffects, 0);
  assert.equal(receptionEffects, 0);
});

test('retained work endpoints cannot be used during exception handling even if its error is caught', async () => {
  const resource = new ResourceOffer({ name: 'test.phase', expose: (value, activity) => ({ read: () => activity.runSync('read', {}, () => value) }) });
  let saved;
  class Main extends Group {
    raises = [rejected];
    deps = { value: resource.request() };
    run = function (work) {
      saved = work.resources.value;
      throw rejected.create('expected', null);
    };
    exceptions = {
      deps: {},
      accepts: [rejected],
      handle(work) {
        assert.throws(() => saved.read(), /inactive declaration phase/);
        return work.return('not allowed');
      },
    };
  }
  const runtime = assemble(new Main(), [resource.provide(() => 1)]);
  await assert.rejects(runtime.run(null, {}), /inactive declaration phase/);
});

test('child use grants are separate for run and handler, and invalid ownership fails at assembly', async () => {
  class Work extends Group {
    name = 'work';
    label = 'work';
    source = 'test';
    deps = {};
    run = () => 'child';
  }
  const child = new Work();
  class Main extends Group {
    constructor() {
      super();
      this.add(child);
    }
    raises = [rejected];
    deps = {};
    uses = [child];
    run = () => {
      throw rejected.create('expected', null);
    };
    exceptions = {
      deps: {},
      accepts: [rejected],
      handle(work) {
        work.children.create(child, null);
        return work.return('not allowed');
      },
    };
  }
  await assert.rejects(assemble(new Main()).run(null, {}), /not declared/);
  const invalid = new Group({
    deps: {},
    run: () => 'done',
    exceptions: {
      deps: {},
      uses: [new Work()],
      accepts: [rejected],
      handle(work) {
        return work.return('done');
      },
    },
  });
  assert.throws(() => assemble(invalid), /outside its owner/);
});

test('observation maps recorded IO only, and is dormant without a recorder', async () => {
  const input = { hidden: 'source', public: 2 };
  const output = { hidden: 'result', public: 3 };
  let descriptions = 0;
  let call;
  class Main extends Group {
    deps = {};
    run = function (work) {
      assert.equal(work.input, input);
      return output;
    };
    observation = [
      invocationRecording(
        {
          input(value) {
            descriptions++;
            return { public: value.public };
          },
          output(value) {
            descriptions++;
            return { public: value.public };
          },
        },
        { failure: 'propagate' },
      ),
    ];
  }
  assert.equal(await assemble(new Main()).run(input, {}), output);
  assert.equal(descriptions, 0);
  const recorder = new Recorder(new RecordBook());
  const runtime = assemble(new Main(), [], recorder);
  assert.equal(
    await runtime.run(input, {
      execution: {
        started: (_context, invocation) => {
          call = invocation;
        },
      },
    }),
    output,
  );
  assert.equal(call.context.state.output, output);
  const snapshot = CallableRecordHelper.snapshot(recorder, recordedCall(recorder, call).id);
  validateExecutionRecordSnapshot(snapshot);
  assert.deepEqual(snapshot.execution.value.input, { public: 2 });
  assert.deepEqual(readOutput(snapshot.execution.value), { public: 3 });
  assert.ok(descriptions > 0);
});

test('exception content can perform declared child work using only its granted resources', async () => {
  const resource = new ResourceOffer({ name: 'test.repair', expose: (value) => value, timing: 'access' });
  let resolved = 0;
  class Repair extends Group {
    name = 'repair';
    label = 'repair';
    source = 'test';
    deps = { value: resource.request() };
    run = (work) => work.resources.value;
  }
  const child = new Repair();
  class Main extends Group {
    raises = [rejected];
    constructor() {
      super();
      this.add(child);
    }
    deps = {};
    uses = [];
    run = () => {
      throw rejected.create('needs repair', null);
    };
    exceptions = {
      deps: { repair: resource.request() },
      uses: [child],
      accepts: [rejected],
      async handle(work) {
        const call = work.children.create(child, null);
        await call.run();
        return work.return(await call.accept());
      },
    };
  }
  const runtime = assemble(new Main(), [
    resource.provide(() => {
      resolved++;
      return 'repaired';
    }),
  ]);
  assert.equal(await runtime.run(null, {}), 'repaired');
  assert.equal(resolved, 1);
});

test('handler resource failure exits as an error without repeating work or handling', async () => {
  const resource = new ResourceOffer({ name: 'test.failed-repair', expose: (value) => value, timing: 'access' });
  const failure = new Error('repair unavailable');
  let executions = 0;
  let handlings = 0;
  let acquisition = 0;
  let call;
  class Main extends Group {
    raises = [rejected];
    maxRounds = 2;
    deps = {};
    run = () => {
      executions++;
      throw rejected.create('expected', null);
    };
    exceptions = {
      deps: { repair: resource.request() },
      accepts: [rejected],
      handle(work) {
        handlings++;
        work.resources.repair;
        return work.continue(null, 'impossible');
      },
    };
  }
  const runtime = assemble(new Main(), [
    resource.provide(() => {
      acquisition++;
      throw failure;
    }),
  ]);
  await assert.rejects(
    runtime.run(null, {
      execution: {
        started: (_context, invocation) => {
          call = invocation;
        },
      },
    }),
    (error) => error === failure,
  );
  assert.deepEqual([executions, handlings, acquisition], [1, 1, 1]);
  assert.equal(call.failure.kind, 'error');
  assert.equal(runtime.running, false);
});

for (const position of ['capture', 'expose']) {
  test(`a declared exception thrown by resource ${position} remains a binding error`, async () => {
    let handled = 0;
    const failure = rejected.create('not a business rejection', null);
    const resource = new ResourceOffer({
      name: 'test.binding-failure',
      expose: () => {
        if (position === 'expose') throw failure;
        return 1;
      },
      timing: 'access',
    });
    class Main extends Group {
      raises = [rejected];
      deps = { value: resource.request() };
      run = (work) => work.resources.value;
      exceptions = {
        deps: {},
        accepts: [rejected],
        handle: (work) => {
          handled++;
          return work.return('incorrect');
        },
      };
    }
    const runtime = assemble(new Main(), [
      resource.provide(() => {
        if (position === 'capture') throw failure;
        return 1;
      }),
    ]);
    await assert.rejects(runtime.run(null, {}), (error) => error.cause === failure);
    assert.equal(handled, 0);
  });
}

for (const gap of ['runtime', 'execution']) {
  test(`recording declarations reject a static ${gap} parent gap`, () => {
    class Child extends Group {
      name = 'child';
      label = 'child';
      source = 'test';
      deps = {};
      run = () => 'done';
      observation = [invocationRecording()];
    }
    const child = new Child();
    class Main extends Group {
      constructor() {
        super();
        this.add(child);
      }
      deps = {};
      run = () => 'done';
      observation = gap === 'runtime' ? [invocationRecording()] : undefined;
    }
    const execution = new Main();
    const definition = runtimeDefinition(execution);
    if (gap === 'execution') definition.observation = [invocationRecording()];
    const installation = bindRecording(new Recorder(new RecordBook()));
    assert.throws(() => installCallable(definition, { observations: [installation], providers: [], source: { entry: () => null, capture: () => null } }), /recording declaration on its direct parent/);
    assert.doesNotThrow(() => installCallable(definition, { providers: [], source: { entry: () => null, capture: () => null } }));
  });
}
