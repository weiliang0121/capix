import { installCallable } from '../fixtures/driver.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ExceptionContract, checkpointPoint, childReference, defineGroup, defineScene } from '@weiliang0121/capix-runtime';
import { MemoryCheckpointStore } from '@weiliang0121/capix-checkpoint';
import { InvocationContext } from '@weiliang0121/capix-runtime/construction';

const codec = { encode: (value) => structuredClone(value), decode: (value) => structuredClone(value) };
const rejected = new ExceptionContract('AUTHOR_CONTROL_FIXTURE');

function runtime(definition, store) {
  return installCallable(definition, { providers: [], source: { capture: () => null }, ...(store ? { checkpoints: { store } } : {}) });
}

test('ordinary control-shaped return data never changes invocation execution', async () => {
  const value = { kind: 'continue', input: 'business-input', reason: 'ordinary data' };
  let executions = 0;
  const definition = defineScene()({
    run(work) {
      executions++;
      assert.equal('continue' in work, false);
      assert.equal('round' in work, false);
      return value;
    },
  });
  assert.deepEqual(await runtime(definition).run('initial', {}), value);
  assert.equal(executions, 1);
  assert.equal('continueWith' in new InvocationContext(null), false);
});

test('checkpoint resumes a declared point without replaying run or interpreting return data', async () => {
  const value = { kind: 'continue', input: 'business-input', reason: 'ordinary data' };
  let normal = 0;
  let resumed = 0;
  function definition() {
    const point = checkpointPoint()({
      name: 'prepared',
      state: codec,
      references: {},
      resume: {
        run(work, state) {
          resumed++;
          assert.equal(work.round, 1);
          assert.deepEqual(state, { ready: true });
          return value;
        },
      },
    });
    return defineScene()({
      checkpoint: { key: 'author.control.resume', version: 2, input: codec, output: codec, points: [point] },
      run(work) {
        normal++;
        work.checkpoint({ point, state: { ready: true } });
        return 'original';
      },
    });
  }
  let image;
  class Capture extends MemoryCheckpointStore {
    save(value, revision) {
      image = value;
      return super.save(value, revision);
    }
  }
  assert.equal(await runtime(definition(), new Capture()).run('initial', {}), 'original');
  const restored = new MemoryCheckpointStore();
  restored.save(image, 0);
  assert.deepEqual(await runtime(definition(), restored).resume(image.frame.owner.contextId, {}), value);
  assert.equal(normal, 1);
  assert.equal(resumed, 1);
});

test('ordinary input adaptation retains the explicitly selected child identity and records its actual input', async () => {
  let originalCalls = 0;
  let replacementCalls = 0;
  const original = defineGroup()({
    run(work) {
      originalCalls++;
      return `original:${work.input}`;
    },
  });
  const replacement = defineGroup()({
    run(work) {
      replacementCalls++;
      return `replacement:${work.input}`;
    },
  });
  const prepare = (input) => `${input}:prepared`;
  const root = defineScene()({
    members: [original, replacement],
    async run(work) {
      const child = work.children.create(original, prepare(work.input));
      await child.run();
      const accepted = await child.accept();
      const fact = work.children.facts.require(original, child.ref);
      assert.equal(fact.input, 'request:prepared');
      assert.equal(fact.reception.value, accepted);
      return accepted;
    },
  });

  assert.equal(await runtime(root).run('request', {}), 'original:request:prepared');
  assert.equal(originalCalls, 1);
  assert.equal(replacementCalls, 0);
});

test('built child checkpoint layout and processing reject later structure mutation', async () => {
  const operation = defineGroup()({ name: 'fixture', label: 'fixture', source: 'test', run: () => 'delivered' });
  const point = checkpointPoint()({ name: 'accepted', state: codec, references: { child: childReference(operation) }, resume: { run: () => 'resumed' } });
  const execution = defineGroup()({
    members: [operation],
    checkpoint: { key: 'author.layout.execution', version: 1, input: codec, output: codec, points: [point] },
    async run(work) {
      const child = work.children.create(operation, work.input);
      await child.run();
      const output = await child.accept();
      work.checkpoint({ point: point, state: {}, refs: { child: child.ref } });
      return output;
    },
  });
  const root = defineScene()({
    members: [execution],
    async run(work) {
      const child = work.children.create(execution, work.input);
      await child.run();
      return child.accept();
    },
  });
  const installed = runtime(root, new MemoryCheckpointStore());
  // Kind is fixed at construction. Building also fixes the business
  // configuration used by later calls and the saved checkpoint layout.
  assert.throws(() => {
    operation.kind = 'node';
  }, /read only/);
  assert.throws(() => {
    operation.run = () => 'changed after build';
  }, /read only|locked/);
  assert.equal(await installed.run('input', {}), 'delivered');
});
