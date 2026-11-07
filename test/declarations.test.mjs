import { installCallable } from './fixtures/driver.mjs';
import { runtimeDefinition, recordedCall } from './fixtures/declarations.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ExceptionContract, Group, Node, bindCallSource, bindRecording, checkpointPoint } from '@capix/server-runtime';
import { Recorder, RecordBook, CallableRecordHelper } from '@capix/records';
import { ResourceOffer } from '@capix/resources';
import { validateExecutionRecordSnapshot, readOutput } from '@capix/protocol';

const rejected = new ExceptionContract('test.rejected');
const codec = { encode: (value) => value, decode: (value) => value };

function assemble(execution, providers = [], recording) {
  return installCallable(runtimeDefinition(execution), {
    providers,
    observations: recording ? [recording] : undefined,
    source: { capture: () => null },
    bindings: [bindCallSource(execution, { started: (options) => options.execution?.started })],
  });
}

test('members share fixed supplies while aliases and resource windows stay local', async () => {
  let captures = 0;
  let late = 0;
  const shared = new ResourceOffer({ name: 'test.shared', expose: (source, activity) => ({ read: () => activity.runSync('read', {}, () => source) }), timing: 'binding' });
  const repair = new ResourceOffer({ name: 'test.repair', expose: (source) => source, timing: 'access' });
  const failed = new Node({
    run: () => {
      throw new Error('expected');
    },
  });
  const recovery = new Node({
    deps: { value: shared.request(), extra: repair.request() },
    run(work) {
      assert.deepEqual(Object.keys(work.resources), ['value', 'extra']);
      assert.equal(work.resources.value.read(), 7);
      assert.equal(work.resources.extra, 9);
      return work.input + 1;
    },
  });
  const main = new Group({
    deps: { original: shared.request() },
    run(work) {
      assert.deepEqual(Object.keys(work.resources), ['original']);
      assert.equal(work.resources.original.read(), 7);
      assert.equal(late, 0);
      return work.children.invoke(failed, work.input, { result: { failed: () => work.children.invoke(recovery, work.input) } });
    },
  }).add(failed, recovery);
  const runtime = assemble(main, [
    shared.provide(() => {
      captures++;
      return 7;
    }),
    repair.provide(() => {
      late++;
      return 9;
    }),
  ]);
  assert.equal(await runtime.run(1, {}), 2);
  assert.equal(captures, 1);
  assert.equal(late, 1);
});

test('checkpoint-only resource requirements remain lazy on the normal path', async () => {
  const unused = new ResourceOffer({ name: 'test.resume-only', expose: (value) => value, timing: 'access' });
  const point = checkpointPoint()({ name: 'saved', state: codec, references: {}, resume: { deps: { unused: unused.request() }, run: (work) => work.resources.unused } });
  const main = new Group({ run: () => 'done', checkpoint: { key: 'test.resume-only', version: 1, input: codec, output: codec, points: [point] } });
  const definition = runtimeDefinition(main);
  assert.throws(() => installCallable(definition, { providers: [], source: { capture: () => null } }), /Expected one resource provider/);
  const runtime = installCallable(definition, { providers: [unused.provide(() => assert.fail('resume resource must remain lazy'))], source: { capture: () => null } });
  assert.equal(await runtime.run(null, {}), 'done');
});

test('a caught child error blocks later child creation and reception work', async () => {
  const failure = new Error('child failed');
  let executions = 0;
  let receptionEffects = 0;
  class Good extends Group {
    name = 'good';
    label = 'good';
    source = 'test';
    deps = {};
    run = () => {
      executions++;
      return 'done';
    };
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
        () => work.children.create(good, null),
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
  assert.equal(executions, 1);
  assert.equal(receptionEffects, 0);
});

test('retained resource endpoints expire when their invocation finishes', async () => {
  const resource = new ResourceOffer({ name: 'test.phase', expose: (value, activity) => ({ read: () => activity.runSync('read', {}, () => value) }) });
  let saved;
  const main = new Group({
    deps: { value: resource.request() },
    run(work) {
      saved = work.resources.value;
      return saved.read();
    },
  });
  assert.equal(await assemble(main, [resource.provide(() => 1)]).run(null, {}), 1);
  assert.throws(() => saved.read(), /inactive|ended|closed|finished/);
});

test('checkpoint action grants reject structures outside the registered member set', () => {
  const foreign = new Node({ run: () => 'foreign' });
  const point = checkpointPoint()({ name: 'saved', state: codec, references: {}, resume: { uses: [foreign], run: (work) => work.children.invoke(foreign, null) } });
  const main = new Group({ run: () => 'done', checkpoint: { key: 'test.bad-members', version: 1, input: codec, output: codec, points: [point] } });
  assert.throws(() => assemble(main), /outside its owner|not declared/);
});

test('host recording maps recorded IO without changing business values', async () => {
  const input = { hidden: 'source', public: 2 };
  const output = { hidden: 'result', public: 3 };
  let descriptions = 0;
  let call;
  const create = () =>
    new Group({
      run(work) {
        assert.deepEqual(work.input, input);
        return output;
      },
    });
  const description = {
    input(value) {
      descriptions++;
      return { public: value.public };
    },
    output(value) {
      descriptions++;
      return { public: value.public };
    },
  };
  assert.deepEqual(await assemble(create()).run(input, {}), output);
  assert.equal(descriptions, 0);
  const recorder = new Recorder(new RecordBook());
  const main = create();
  const recording = bindRecording(recorder, { failure: 'propagate' }).describe(main, description);
  const runtime = assemble(main, [], recording);
  assert.deepEqual(
    await runtime.run(input, {
      execution: {
        started: (_context, invocation) => {
          call = invocation;
        },
      },
    }),
    output,
  );
  assert.deepEqual(call.context.state.output, output);
  const snapshot = CallableRecordHelper.snapshot(recorder, recordedCall(recorder, call).id);
  validateExecutionRecordSnapshot(snapshot);
  assert.deepEqual(snapshot.execution.value.input, { public: 2 });
  assert.deepEqual(readOutput(snapshot.execution.value), { public: 3 });
  assert.ok(descriptions > 0);
});

test('fallback invokes a registered member with its own resources and records handled failure', async () => {
  const resource = new ResourceOffer({ name: 'test.repair', expose: (value) => value, timing: 'access' });
  let resolved = 0;
  let facts;
  const failed = new Node({
    run: () => {
      throw rejected.create('needs repair', null);
    },
  });
  const repair = new Node({ deps: { value: resource.request() }, run: (work) => work.resources.value });
  const main = new Group({
    async run(work) {
      assert.deepEqual(Object.keys(work.resources), []);
      const answer = await work.children.invoke(failed, null, { result: { failed: () => work.children.invoke(repair, null) } });
      facts = work.children.facts.values();
      return answer;
    },
  }).add(failed, repair);
  const runtime = assemble(main, [
    resource.provide(() => {
      resolved++;
      return 'repaired';
    }),
  ]);
  assert.equal(await runtime.run(null, {}), 'repaired');
  assert.equal(resolved, 1);
  assert.deepEqual(
    facts.map((fact) => [fact.returned.status, fact.reception.status]),
    [
      ['failed', 'handled'],
      ['succeeded', 'accepted'],
    ],
  );
});

test('fallback resource capture failure cannot repeat the original call or enter another result handler', async () => {
  const resource = new ResourceOffer({ name: 'test.failed-repair', expose: (value) => value, timing: 'access' });
  const failure = new Error('repair unavailable');
  let executions = 0;
  let handlings = 0;
  let acquisitions = 0;
  let forbidden = 0;
  const failed = new Node({
    run: () => {
      executions++;
      throw new Error('expected');
    },
  });
  const repair = new Node({ deps: { repair: resource.request() }, run: (work) => work.resources.repair });
  const main = new Group({
    run(work) {
      return work.children.invoke(failed, null, {
        result: {
          failed: () => {
            handlings++;
            return work.children.invoke(repair, null, {
              result: {
                failed: () => {
                  forbidden++;
                  return 'must not hide capture failure';
                },
              },
            });
          },
        },
      });
    },
  }).add(failed, repair);
  const runtime = assemble(main, [
    resource.provide(() => {
      acquisitions++;
      throw failure;
    }),
  ]);
  await assert.rejects(runtime.run(null, {}), (error) => error === failure);
  assert.deepEqual([executions, handlings, acquisitions, forbidden], [1, 1, 1, 0]);
  assert.equal(runtime.running, false);
});

for (const position of ['capture', 'expose']) {
  test(`declared exceptions thrown by resource ${position} stay technical and bypass ordinary fallback`, async () => {
    let handled = 0;
    const failure = rejected.create('not a business rejection', null);
    const resource = new ResourceOffer({
      name: 'test.binding-failure',
      timing: 'access',
      expose: () => {
        if (position === 'expose') throw failure;
        return 1;
      },
    });
    const child = new Node({ deps: { value: resource.request() }, run: (work) => work.resources.value });
    const main = new Group({
      run: (work) =>
        work.children.invoke(child, null, {
          result: {
            failed: () => {
              handled++;
              return 'incorrect';
            },
          },
        }),
    }).add(child);
    const runtime = assemble(main, [
      resource.provide(() => {
        if (position === 'capture') throw failure;
        return 1;
      }),
    ]);
    await assert.rejects(runtime.run(null, {}), (error) => error.cause === failure);
    assert.equal(handled, 0);
  });
}

test('host recording covers every registered ancestor without business observation fields', async () => {
  const child = new Node({ run: () => 'done' });
  const main = new Group({ run: (work) => work.children.invoke(child, null) }).add(child);
  const recorder = new Recorder(new RecordBook());
  const recording = bindRecording(recorder, { failure: 'propagate' });
  assert.equal(await assemble(main, [], recording).run(null, {}), 'done');
  const calls = [...recorder.book.values()].filter((record) => record.kind === 'invocation');
  assert.equal(calls.length, 3);
  const records = new Map([...recorder.book.values()].map((record) => [record.id, record]));
  for (const call of calls) assert.ok(records.has(call.parentId));
  for (const structure of [main, child]) assert.equal('observation' in structure, false);
});
