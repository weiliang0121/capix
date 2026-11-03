import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ChangeCaptureError } from '@capix/changes';
import { RuntimeError } from '@capix/contracts';
import { PersistenceError } from '@capix/diagnostics';
import { Memories, MemoryResource } from '@capix/memory';
import { Resource, ResourceOffer } from '@capix/resources';
import { Group, Node, Resources, Runner, Scene } from '@capix/server-runtime';
import { Transcript, TranscriptResource } from '@capix/transcript';

const entities = [
  {
    name: 'Transcript',
    operation: 'transcript.commit',
    create: (options) => new Transcript([], options),
    offer: TranscriptResource.append,
    write: (endpoint, input) => endpoint.append(input),
    direct: (entity, input) => entity.appendFrom(input),
    input: [{ role: 'assistant', content: 'accepted answer' }],
    invalid: [{ role: 'assistant', content: '' }],
    version: (entity) => entity.revision,
  },
  {
    name: 'Memories',
    operation: 'memories.commit',
    create: (options) => new Memories(new Transcript([{ role: 'user', content: 'original evidence' }]), options),
    offer: MemoryResource.apply,
    write: (endpoint, input) => endpoint.apply(input),
    direct: (entity, input) => entity.apply(input),
    input: [{ action: 'create', memoryId: null, change: 'remember evidence', sourceIndexes: [0], result: { topic: 'evidence', content: 'accepted memory', sourceIndexes: [0] } }],
    invalid: [{ action: 'create', memoryId: null, change: '', sourceIndexes: [0], result: { topic: 'evidence', content: 'accepted memory', sourceIndexes: [0] } }],
    version: (entity) => entity.sequence,
  },
];

function entityFixture(spec, commit = () => undefined, capture = () => undefined) {
  const commits = [];
  const events = [];
  const entity = spec.create({
    persistence: {
      commit(change) {
        commits.push(change);
        return commit(change);
      },
    },
    changes: {
      capture(event) {
        events.push(event);
        capture(event);
      },
    },
  });
  return { entity, commits, events, before: entity.exportState() };
}

function childWriter(spec, fixture) {
  const failures = [];
  const child = new Node({
    deps: { content: spec.offer.request() },
    run(work) {
      spec.write(work.resources.content, work.input);
      return 'saved';
    },
  });
  const parent = new Group().add({ child });
  parent.run = (work) =>
    work.children.child.invoke(work.input, {
      result: {
        failed(error) {
          failures.push(error);
          return 'business fallback';
        },
      },
    });
  const resources = new Resources().register(new Resource(fixture.entity), spec.offer);
  return { runner: new Runner(new Scene(parent), resources).build(), failures };
}

function assertUninstalled(fixture, attempts = 1) {
  assert.equal(fixture.commits.length, attempts);
  assert.deepEqual(fixture.entity.exportState(), fixture.before);
  assert.deepEqual(fixture.events, []);
}

test('entity commit failures are protected across Node and Group reception regardless of adapter error type', async () => {
  for (const spec of entities) {
    for (const cause of [new Error(`${spec.name} storage unavailable`), new PersistenceError('adapter.write', new Error('disk failure')), new RuntimeError('PERSISTENCE_UNAVAILABLE', 'storage unavailable')]) {
      const fixture = entityFixture(spec, () => {
        throw cause;
      });
      const { runner, failures } = childWriter(spec, fixture);
      await assert.rejects(runner.run(spec.input), (error) => {
        assert.ok(error instanceof PersistenceError);
        if (cause instanceof PersistenceError) assert.equal(error, cause, 'already classified adapter failures retain their exact identity and operation');
        else {
          assert.equal(error.operation, spec.operation);
          assert.equal(error.cause, cause, 'a diagnostic code does not replace the real persistence boundary');
        }
        return true;
      });
      assert.deepEqual(failures, []);
      assertUninstalled(fixture);
      assert.equal(runner.isRunning, false);
    }
  }
});

test('entity persistence rejects non-undefined and Promise returns as protected synchronous contract failures', async () => {
  for (const spec of entities) {
    for (const commit of [() => null, () => 1, () => Promise.resolve(), () => Promise.reject(new Error('late asynchronous rejection'))]) {
      const fixture = entityFixture(spec, commit);
      const { runner, failures } = childWriter(spec, fixture);
      await assert.rejects(runner.run(spec.input), (error) => error instanceof PersistenceError && error.operation === spec.operation && error.cause instanceof TypeError && /synchronously and return undefined/.test(error.cause.message));
      assert.deepEqual(failures, []);
      assertUninstalled(fixture);
      assert.equal(runner.isRunning, false);
    }
  }
});

test('entity input validation remains a receivable business failure before persistence', async () => {
  for (const spec of entities) {
    const fixture = entityFixture(spec);
    const { runner, failures } = childWriter(spec, fixture);
    assert.equal(await runner.run(spec.invalid), 'business fallback');
    assert.equal(failures.length, 1);
    assert.ok(failures[0] instanceof TypeError);
    assert.equal(failures[0] instanceof PersistenceError, false);
    assertUninstalled(fixture, 0);
    assert.equal(runner.isRunning, false);
  }
});

test('a persistence failure in successful child reception cannot reenter the same failed callback', async () => {
  for (const spec of entities) {
    const cause = new Error(`${spec.name} reception write failed`);
    const fixture = entityFixture(spec, () => {
      throw cause;
    });
    let succeeded = 0;
    let failed = 0;
    const child = new Node({ run: (work) => work.input });
    const parent = new Group({ deps: { content: spec.offer.request() } }).add({ child });
    parent.run = (work) =>
      work.children.child.invoke(work.input, {
        result: {
          succeeded(value) {
            succeeded++;
            assert.equal(value, work.input);
            spec.write(work.resources.content, value);
            return 'saved';
          },
          failed() {
            failed++;
            return 'business fallback';
          },
        },
      });
    const runner = new Runner(new Scene(parent), new Resources().register(new Resource(fixture.entity), spec.offer)).build();
    await assert.rejects(runner.run(spec.input), (error) => error instanceof PersistenceError && error.operation === spec.operation && error.cause === cause);
    assert.equal(succeeded, 1);
    assert.equal(failed, 0);
    assertUninstalled(fixture);
    assert.equal(runner.isRunning, false);
  }
});

test('post-commit change capture failure stays a capture failure and preserves installed content', async () => {
  for (const spec of entities) {
    const cause = new Error(`${spec.name} capture unavailable`);
    const fixture = entityFixture(spec, undefined, () => {
      throw cause;
    });
    const { runner, failures } = childWriter(spec, fixture);
    await assert.rejects(runner.run(spec.input), (error) => {
      assert.ok(error instanceof ChangeCaptureError);
      assert.equal(error instanceof PersistenceError, false);
      assert.equal(error.cause, cause);
      assert.equal(error.event, fixture.events[0]);
      return true;
    });
    assert.deepEqual(failures, []);
    assert.equal(fixture.commits.length, 1);
    assert.equal(fixture.events.length, 1);
    assert.equal(spec.version(fixture.entity), 1);
    const saved = fixture.entity.snapshot();
    assert.equal(saved.length, 1);
    assert.equal(saved[0].content, spec.name === 'Transcript' ? spec.input[0].content : spec.input[0].result.content);
    assert.equal(runner.isRunning, false);
  }
});

test('entity persistence is also protected from a direct methods resource failed receiver without child calls', async () => {
  for (const spec of entities) {
    const cause = new Error(`${spec.name} direct write failed`);
    const fixture = entityFixture(spec, () => {
      throw cause;
    });
    const offer = new ResourceOffer({
      methods: {
        write(entity, input) {
          spec.direct(entity, input);
          return 'saved';
        },
      },
    });
    const failures = [];
    const scene = new Scene({
      deps: { content: offer.request() },
      run: (work) =>
        work.resources.content.write(work.input, {
          result: {
            failed(error) {
              failures.push(error);
              return 'resource fallback';
            },
          },
        }),
    });
    const runner = new Runner(scene, new Resources().register(new Resource(fixture.entity), offer)).build();
    await assert.rejects(runner.run(spec.input), (error) => error instanceof PersistenceError && error.operation === spec.operation && error.cause === cause);
    assert.deepEqual(failures, []);
    assertUninstalled(fixture);
    assert.equal(runner.isRunning, false);
  }
});

test('classifying a lost commit acknowledgement does not imply that storage stayed unchanged', async () => {
  for (const spec of entities) {
    let saved;
    const cause = new Error('commit acknowledgement lost');
    const fixture = entityFixture(spec, (change) => {
      // 模拟权威存储已经提交，再丢失返回确认；不假设抛错就代表写入没发生。
      saved = spec.name === 'Transcript' ? { ...saved, revision: change.revision, messages: [...saved.messages, ...structuredClone(change.messages)] } : { ...saved, sequence: change.sequence, items: structuredClone(change.upserts) };
      throw cause;
    });
    saved = structuredClone(fixture.before);
    const { runner, failures } = childWriter(spec, fixture);
    await assert.rejects(runner.run(spec.input), (error) => error instanceof PersistenceError && error.operation === spec.operation && error.cause === cause);
    assert.deepEqual(failures, []);
    assertUninstalled(fixture);
    const restored = spec.name === 'Transcript' ? Transcript.restore(saved) : Memories.restore(saved, fixture.entity.transcript);
    assert.equal(spec.version(restored), 1);
    assert.equal(restored.snapshot().length, 1, 'only the authoritative saved state confirms the effect');
    assert.equal(fixture.commits.length, 1, 'classification does not schedule another commit');
  }
});
