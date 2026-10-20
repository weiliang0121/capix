import { installCallable } from '../fixtures/driver.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ExceptionContract, MemoryCheckpointStore, checkpointPoint, childReference, defineChildEntry, defineGroup, defineScene } from '@capix/server-runtime';
import { InvocationContext } from '@capix/server-runtime/construction';

const codec = { encode: (value) => structuredClone(value), decode: (value) => structuredClone(value) };
const rejected = new ExceptionContract('AUTHOR_CONTROL_FIXTURE');

function runtime(definition, store) {
  return installCallable(definition, { providers: [], source: { capture: () => null }, ...(store ? { checkpoints: { store } } : {}) });
}

// The construction entry can produce the real mechanism control value. It is not
// evidence that the current author Work issued a continuation proposal.
function mechanismContinuation() {
  return new InvocationContext('outside-author-work').continueWith('forged-next', 'not issued by the current Work');
}

function businessValue() {
  return { kind: 'continue', input: 'business-input', reason: 'ordinary result data' };
}

for (const boundary of ['execute', 'accept', 'handler-return']) {
  for (const forged of [true, false]) {
    test(`author ${boundary} ${forged ? 'rejects a mechanism Continuation' : 'preserves ordinary continue-tagged output'}`, async () => {
      const value = forged ? mechanismContinuation() : businessValue();
      let executions = 0;
      let acceptances = 0;
      const definition = defineScene()({
        maxRounds: 2,
        ...(boundary === 'handler-return' ? { raises: [rejected] } : {}),
        run: {
          execute(work) {
            executions++;
            assert.equal(work.round, 1, 'a raw mechanism value cannot initiate another author round');
            if (boundary === 'handler-return') throw rejected.create('enter the handler', {});
            return boundary === 'execute' ? value : 'candidate';
          },
          accept(work) {
            acceptances++;
            return boundary === 'accept' ? value : work.delivered;
          },
        },
        ...(boundary === 'handler-return'
          ? {
              exceptions: {
                accepts: [rejected],
                handle(work) {
                  return work.return(value);
                },
              },
            }
          : {}),
      });

      if (forged) await assert.rejects(runtime(definition).run('initial', {}), /control must be issued by the current author phase/);
      else assert.equal(await runtime(definition).run('initial', {}), value, 'business output retains its identity');
      assert.equal(executions, 1);
      assert.equal(acceptances, boundary === 'handler-return' || (boundary === 'execute' && forged) ? 0 : 1);
    });
  }
}

for (const forged of [true, false]) {
  test(`author checkpoint resume ${forged ? 'rejects a mechanism Continuation' : 'preserves ordinary continue-tagged output'}`, async () => {
    const value = forged ? mechanismContinuation() : businessValue();
    let resumed = 0;
    let normalExecutions = 0;
    let acceptances = 0;
    const point = checkpointPoint()({
      name: 'prepared',
      state: codec,
      references: {},
      resume: {
        execute(work, state) {
          resumed++;
          assert.equal(work.round, 1);
          assert.deepEqual(state, { ready: true });
          return value;
        },
      },
    });
    const definition = defineScene()({
      maxRounds: 2,
      checkpoint: { key: 'author.control.resume', version: 1, input: codec, output: codec, points: [point] },
      run: {
        execute(work) {
          normalExecutions++;
          work.checkpoint.save(point, { ready: true }, {});
          return 'initial result';
        },
        accept(work) {
          acceptances++;
          return work.delivered;
        },
      },
    });
    let saved;
    class CapturingStore extends MemoryCheckpointStore {
      save(image, revision) {
        const head = super.save(image, revision);
        saved = image;
        return head;
      }
    }
    assert.equal(await runtime(definition, new CapturingStore()).run('initial', {}), 'initial result');
    assert.ok(saved, 'the first invocation reached the durable author boundary');
    // Restore only the captured image, as if the process ended at save. A final
    // delivery from the completed fixture invocation is deliberately excluded.
    const restoredStore = new MemoryCheckpointStore();
    restoredStore.save(saved, 0);
    const restored = runtime(definition, restoredStore);
    if (forged) await assert.rejects(restored.resume(saved.frame.owner.contextId, {}), /control must be issued by the current author phase/);
    else assert.equal(await restored.resume(saved.frame.owner.contextId, {}), value);
    assert.equal(resumed, 1);
    assert.equal(normalExecutions, 1, 'resume does not replay ordinary execute');
    assert.equal(acceptances, forged ? 1 : 2, 'a rejected resume result does not enter author acceptance');
  });
}

test('ChildEntry admission cannot change the already selected child definition', async () => {
  let originalCalls = 0;
  let replacementCalls = 0;
  const original = defineGroup()({
    run: {
      execute(work) {
        originalCalls++;
        return `original:${work.input}`;
      },
    },
  });
  const replacement = defineGroup()({
    run: {
      execute(work) {
        replacementCalls++;
        return `replacement:${work.input}`;
      },
    },
  });
  const entry = defineChildEntry(original, {
    accept({ input }) {
      // Both definitions are permitted. This checks target identity, not merely
      // the uses gate. Reflect.set also works when entry identity is immutable.
      Reflect.set(entry, 'definition', replacement);
      return `${input}:admitted`;
    },
  });
  const root = defineScene()({
    members: [original, replacement],
    run: {
      async execute(work) {
        const child = work.children.entry(entry, work.input);
        await child.run();
        const accepted = await child.accept();
        const fact = work.children.facts.require(original, child.ref);
        assert.equal(fact.input, 'request:admitted');
        assert.equal(fact.reception.value, accepted);
        return accepted;
      },
    },
  });

  assert.equal(await runtime(root).run('request', {}), 'original:request:admitted');
  assert.equal(originalCalls, 1);
  assert.equal(replacementCalls, 0);
});

test('lazy child checkpoint layout retains the resolved level after original declaration mutation', async () => {
  const operation = defineGroup()({ name: 'fixture', label: 'fixture', source: 'test', run: { execute: () => 'delivered' } });
  const point = checkpointPoint()({ name: 'accepted', state: codec, references: { child: childReference(operation) }, resume: { execute: () => 'resumed' } });
  const execution = defineGroup()({
    members: [operation],
    checkpoint: { key: 'author.layout.execution', version: 1, input: codec, output: codec, points: [point] },
    run: {
      async execute(work) {
        const child = work.children.create(operation, work.input);
        await child.run();
        const output = await child.accept();
        work.checkpoint.save(point, {}, { child: child.ref });
        return output;
      },
    },
  });
  const root = defineScene()({
    members: [execution],
    run: {
      async execute(work) {
        const child = work.children.create(execution, work.input);
        await child.run();
        return child.accept();
      },
    },
  });
  const installed = runtime(root, new MemoryCheckpointStore());
  // The author object remains mutable for business use. Already resolved kernel
  // fields must not be read from it again while lazily creating the E structure.
  operation.kind = 'attempt';
  assert.equal(await installed.run('input', {}), 'delivered');
});
