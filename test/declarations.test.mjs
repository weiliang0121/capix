import { runtimeDefinition, recordDefinitions, recordedCall } from './fixtures/declarations.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ExceptionContract, ExecutionDefinition, OperationDefinition, InvocationEntry, ResourceOffer, Recorder, RecordBook, assembleRuntime, ExecutionRecordHelper, bindRecording, invocationRecording } from '@capix/server-runtime';
import { validateExecutionRecordSnapshot, readOutput } from '@capix/protocol';

const rejected = new ExceptionContract('test.rejected');

function assemble(execution, providers = [], recorder) {
  const definition = runtimeDefinition(execution);
  const observations = recorder ? [bindRecording(recorder, { failure: 'propagate' })] : undefined;
  if (observations) recordDefinitions(definition);
  return assembleRuntime(definition, { providers, observations, source: { entry: () => null, capture: () => null, callbacks: (_definition, options) => options.execution } });
}

test('peer declarations share fixed supplies but have separate aliases and phase endpoints', async () => {
  let captures = 0;
  let late = 0;
  const shared = new ResourceOffer('test.shared', (source, activity) => ({ read: () => activity.runSync('read', {}, () => source) }), 'binding');
  const recovery = new ResourceOffer('test.recovery', (source, activity) => ({ read: () => activity.runSync('read', {}, () => source) }), 'access');
  const recorder = new Recorder(new RecordBook());
  let call;
  class Main extends ExecutionDefinition {
    raises = [rejected];
    run = {
      requires: { value: shared.request() },
      execute(context) {
        assert.deepEqual(Object.keys(context.resources.values), ['value']);
        assert.equal(context.resources.values.value.read(), 7);
        if (context.progress.round === 1) {
          assert.equal(late, 0);
          throw rejected.create('expected', { at: 1 });
        }
        return context.currentInput;
      },
    };
    maxRounds = 2;
    exceptions = {
      requires: { recovered: shared.request(), late: recovery.request() },
      accepts: [rejected],
      handle(context, exception) {
        assert.equal(exception.contract, rejected);
        assert.deepEqual(Object.keys(context.resources.values), ['recovered', 'late']);
        assert.equal(context.resources.values.recovered.read(), 7);
        assert.equal(context.resources.values.late.read(), 9);
        return { kind: 'continue', input: context.currentInput + 1, reason: 'resolved' };
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
  const snapshot = ExecutionRecordHelper.snapshot(recorder, recordedCall(recorder, call).id);
  validateExecutionRecordSnapshot(snapshot);
  assert.equal(snapshot.resources.filter((fact) => fact.access === 'test.shared' && fact.phase === 'bound').length, 1);
  assert.equal(snapshot.resources.filter((fact) => fact.access === 'test.shared' && fact.phase === 'available').length, 1);
});

test('handler-only lazy resources are not obtained on the success path', async () => {
  const unused = new ResourceOffer('test.unused', (value) => value, 'access');
  class Main extends ExecutionDefinition {
    run = { requires: {}, execute: () => 'done' };
    exceptions = { requires: { unused: unused.request() }, accepts: [rejected], handle: () => assert.fail('not entered') };
  }
  const runtime = assemble(new Main(), [unused.provide(() => assert.fail('handler resource must remain lazy'))]);
  assert.equal(await runtime.run(null, {}), 'done');
});

test('a caught child error blocks later child entry admission and reception work', async () => {
  const failure = new Error('child failed');
  let entryEffects = 0;
  let receptionEffects = 0;
  class Good extends OperationDefinition {
    name = 'good';
    label = 'good';
    source = 'test';
    run = { requires: {}, execute: () => 'done' };
  }
  class Bad extends OperationDefinition {
    name = 'bad';
    label = 'bad';
    source = 'test';
    run = {
      requires: {},
      execute: () => {
        throw failure;
      },
    };
  }
  const good = new Good();
  const bad = new Bad();
  const entry = new InvocationEntry(good, (_parent, input) => {
    entryEffects++;
    return input;
  });
  class Main extends ExecutionDefinition {
    children = [good, bad];
    run = {
      requires: {},
      async execute(_context, invocation, children) {
        const completed = children.get(good).create(invocation, null);
        assert.equal(await completed.run(), 'done');
        await assert.rejects(children.get(bad).call(invocation, null), (error) => error === failure);
        assert.throws(
          () => children.entry(entry).create(invocation, null),
          (error) => error === failure,
        );
        await assert.rejects(
          children.accept(completed, () => {
            receptionEffects++;
            return 'accepted';
          }),
          (error) => error === failure,
        );
        return 'caught';
      },
    };
  }
  await assert.rejects(assemble(new Main()).run(null, {}), (error) => error === failure);
  assert.equal(entryEffects, 0);
  assert.equal(receptionEffects, 0);
});

test('retained work endpoints cannot be used during exception handling even if its error is caught', async () => {
  const resource = new ResourceOffer('test.phase', (value, activity) => ({ read: () => activity.runSync('read', {}, () => value) }));
  let saved;
  class Main extends ExecutionDefinition {
    raises = [rejected];
    run = {
      requires: { value: resource.request() },
      execute(context) {
        saved = context.resources.values.value;
        throw rejected.create('expected', null);
      },
    };
    exceptions = {
      requires: {},
      accepts: [rejected],
      handle() {
        assert.throws(() => saved.read(), /inactive declaration phase/);
        return { kind: 'return', output: 'not allowed' };
      },
    };
  }
  const runtime = assemble(new Main(), [resource.provide(() => 1)]);
  await assert.rejects(runtime.run(null, {}), /inactive declaration phase/);
});

test('child use grants are separate for run and handler, and invalid ownership fails at assembly', async () => {
  class Work extends OperationDefinition {
    name = 'work';
    label = 'work';
    source = 'test';
    run = { requires: {}, execute: () => 'child' };
  }
  const child = new Work();
  class Main extends ExecutionDefinition {
    children = [child];
    raises = [rejected];
    run = {
      requires: {},
      uses: [child],
      execute: () => {
        throw rejected.create('expected', null);
      },
    };
    exceptions = {
      requires: {},
      accepts: [rejected],
      handle(_context, _exception, _invocation, children) {
        children.get(child);
        return { kind: 'return', output: 'not allowed' };
      },
    };
  }
  await assert.rejects(assemble(new Main()).run(null, {}), /not declared/);
  const invalid = new Main();
  invalid.exceptions = { ...invalid.exceptions, uses: [new Work()] };
  assert.throws(() => assemble(invalid), /outside its owner/);
});

test('observation maps recorded IO only, and is dormant without a recorder', async () => {
  const input = { hidden: 'source', public: 2 };
  const output = { hidden: 'result', public: 3 };
  let descriptions = 0;
  let call;
  class Main extends ExecutionDefinition {
    run = {
      requires: {},
      execute(context) {
        assert.equal(context.currentInput, input);
        return output;
      },
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
  const snapshot = ExecutionRecordHelper.snapshot(recorder, recordedCall(recorder, call).id);
  validateExecutionRecordSnapshot(snapshot);
  assert.deepEqual(snapshot.execution.value.input, { public: 2 });
  assert.deepEqual(readOutput(snapshot.execution.value), { public: 3 });
  assert.ok(descriptions > 0);
});

test('exception content can perform declared child work using only its granted resources', async () => {
  const resource = new ResourceOffer('test.repair', (value) => value, 'access');
  let resolved = 0;
  class Repair extends OperationDefinition {
    name = 'repair';
    label = 'repair';
    source = 'test';
    run = { requires: { value: resource.request() }, execute: (context) => context.resources.values.value };
  }
  const child = new Repair();
  class Main extends ExecutionDefinition {
    raises = [rejected];
    children = [child];
    run = {
      requires: {},
      uses: [],
      execute: () => {
        throw rejected.create('needs repair', null);
      },
    };
    exceptions = {
      requires: { repair: resource.request() },
      uses: [child],
      accepts: [rejected],
      async handle(_context, _exception, invocation, children) {
        return { kind: 'return', output: await children.get(child).call(invocation, null) };
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
  const resource = new ResourceOffer('test.failed-repair', (value) => value, 'access');
  const failure = new Error('repair unavailable');
  let executions = 0;
  let handlings = 0;
  let acquisition = 0;
  let call;
  class Main extends ExecutionDefinition {
    raises = [rejected];
    maxRounds = 2;
    run = {
      requires: {},
      execute: () => {
        executions++;
        throw rejected.create('expected', null);
      },
    };
    exceptions = {
      requires: { repair: resource.request() },
      accepts: [rejected],
      handle(context) {
        handlings++;
        context.resources.values.repair;
        return { kind: 'continue', input: null, reason: 'impossible' };
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
    const resource = new ResourceOffer(
      'test.binding-failure',
      () => {
        if (position === 'expose') throw failure;
        return 1;
      },
      'access',
    );
    class Main extends ExecutionDefinition {
      raises = [rejected];
      run = { requires: { value: resource.request() }, execute: (context) => context.resources.values.value };
      exceptions = {
        requires: {},
        accepts: [rejected],
        handle: () => {
          handled++;
          return { kind: 'return', output: 'incorrect' };
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
    class Child extends OperationDefinition {
      name = 'child';
      label = 'child';
      source = 'test';
      run = { requires: {}, execute: () => 'done' };
      observation = [invocationRecording()];
    }
    const child = new Child();
    class Main extends ExecutionDefinition {
      children = [child];
      run = { requires: {}, execute: () => 'done' };
      observation = gap === 'runtime' ? [invocationRecording()] : undefined;
    }
    const execution = new Main();
    const definition = runtimeDefinition(execution);
    if (gap === 'execution') definition.observation = [invocationRecording()];
    const installation = bindRecording(new Recorder(new RecordBook()));
    assert.throws(() => assembleRuntime(definition, { observations: [installation], providers: [], source: { entry: () => null, capture: () => null } }), /recording declaration on its direct parent/);
    assert.doesNotThrow(() => assembleRuntime(definition, { providers: [], source: { entry: () => null, capture: () => null } }));
  });
}
