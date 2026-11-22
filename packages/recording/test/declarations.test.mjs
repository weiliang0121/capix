import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Recorder, RecordBook, CallableRecordHelper } from '@weiliang0121/capix-records';
import { validateExecutionRecordSnapshot, readOutput } from '@weiliang0121/capix-records/data';
import { Group, Node, Scene, Runner, Resources, callableHooks } from '@weiliang0121/capix-runtime';
import { bindRecording } from '@weiliang0121/capix-recording';

function assemble(main, recording, hooks = []) {
  return new Runner(new Scene(main), new Resources(), { hooks, observations: recording ? [recording] : [] }).build();
}

test('host recording maps recorded IO without changing business values', async () => {
  const input = { hidden: 'source', public: 2 };
  const output = { hidden: 'result', public: 3 };
  let descriptions = 0;
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
  assert.deepEqual(await assemble(create()).run(input), output);
  assert.equal(descriptions, 0);
  const recorder = new Recorder(new RecordBook());
  const main = create();
  const recording = bindRecording(recorder, { failure: 'propagate' }).describe(main, description);
  let context;
  const hooks = [
    callableHooks(main, {
      started: () => (current) => {
        context = current;
      },
    }),
  ];
  assert.deepEqual(await assemble(main, recording, hooks).run(input), output);
  assert.deepEqual(context.state.output, output);
  const call = [...recorder.book.values()].find((entry) => entry.structureId === main.id);
  const snapshot = CallableRecordHelper.snapshot(recorder, call.id);
  validateExecutionRecordSnapshot(snapshot);
  assert.deepEqual(snapshot.execution.value.input, { public: 2 });
  assert.deepEqual(readOutput(snapshot.execution.value), { public: 3 });
  assert.ok(descriptions > 0);
});

test('host recording covers every registered ancestor without business observation fields', async () => {
  const child = new Node({ run: () => 'done' });
  const main = new Group({ run: (work) => work.children.invoke(child, null) }).add(child);
  const recorder = new Recorder(new RecordBook());
  const recording = bindRecording(recorder, { failure: 'propagate' });
  assert.equal(await assemble(main, recording).run(null, {}), 'done');
  const calls = [...recorder.book.values()].filter((record) => record.kind === 'invocation');
  assert.equal(calls.length, 3);
  const records = new Map([...recorder.book.values()].map((record) => [record.id, record]));
  for (const call of calls) assert.ok(records.has(call.parentId));
  for (const structure of [main, child]) assert.equal('observation' in structure, false);
});
