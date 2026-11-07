import assert from 'node:assert/strict';
import { stableValue } from '@capix/contracts';
import { test } from 'node:test';
import { ConversationRecording } from '@capix/conversation-service/recording';
import { RecordBook } from '@capix/records';
import { Transcript } from '@capix/transcript';
import { Memories } from '@capix/memory';
import { View } from '@capix/view';
import { Group, Node, Scene, checkpointPoint } from '@capix/structure';
import { MemoryCheckpointStore } from '@capix/checkpoint';
import { Resources, Runner } from '@capix/server-runtime';

function content() {
  const transcript = new Transcript();
  const memories = new Memories(transcript);
  const view = new View({ revision: 0, sources: { messages: { id: transcript.id, scope: 'whole' }, memories: { id: memories.id, scope: 'whole' } }, members: [] });
  return { transcript, memories, view };
}

function fixture(scene) {
  const entities = content();
  const recording = new ConversationRecording(scene);
  const runner = new Runner(scene, new Resources(), undefined, { observations: [recording] }).build();
  return { entities, recording, runner, inspect: () => recording.inspect(entities).recording };
}

function gatedScene() {
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const gate = new Node({
    name: 'gate',
    run: async (work) => {
      entered.resolve();
      await release.promise;
      return work.input;
    },
  });
  const tail = new Node({ name: 'tail', run: (work) => work.input });
  const group = new Group().add({ gate, tail });
  group.run = async (work) => work.children.tail.invoke(await work.children.gate.invoke(work.input));
  return { scene: new Scene(group), entered, release };
}

test('disabled recording creates no entries or business summaries, including calls after stop', async (t) => {
  let added = 0;
  const add = RecordBook.prototype.add;
  t.mock.method(RecordBook.prototype, 'add', function (record) {
    added++;
    return add.call(this, record);
  });
  let described = 0;
  const input = stableValue({ text: 'hello' });
  const keys = Object.keys;
  t.mock.method(Object, 'keys', (value) => {
    if (value === input) described++;
    return keys(value);
  });
  const f = fixture(new Scene({ run: () => 'answer' }));
  assert.deepEqual(f.recording.state(), { status: 'idle' });
  assert.equal(await f.runner.run(input), 'answer');
  assert.equal(added, 0);
  assert.equal(described, 0);
  assert.deepEqual(f.inspect(), { status: 'idle', revision: 0, integrity: 'intact', calls: [], omitted: 0 });

  const first = f.recording.start();
  assert.deepEqual(f.recording.start(), first);
  assert.equal(await f.runner.run(input), 'answer');
  assert.ok(added > 0);
  assert.ok(described > 0);
  const before = { added, described };
  f.recording.stop();
  assert.equal(await f.runner.run(input), 'answer');
  assert.deepEqual({ added, described }, before);
  assert.equal(f.inspect().calls.length, 1);
  assert.throws(() => f.recording.start(), /Clear/);
  f.recording.clear();
  assert.deepEqual(f.recording.state(), { status: 'idle' });
  assert.notEqual(f.recording.start().recorderId, first.recorderId);
});

test('starting during an unrecorded Scene never captures its later children', async () => {
  const gate = gatedScene();
  const f = fixture(gate.scene);
  const running = f.runner.run('first');
  await gate.entered.promise;
  f.recording.start();
  gate.release.resolve();
  assert.equal(await running, 'first');
  assert.equal(f.inspect().calls.length, 0);
  assert.equal(f.inspect().integrity, 'intact');
  assert.equal(await f.runner.run('second'), 'second');
  assert.equal(f.inspect().calls.length, 1);
  const detail = f.recording.call(f.inspect().calls[0].id);
  assert.deepEqual(
    detail.calls.map((call) => call.name),
    [undefined, 'gate', 'tail'],
  );
  assert.ok(detail.calls.every((call) => call.status === 'succeeded'));
});

test('acquired feedback can configure capture before the Scene context is created', async () => {
  const f = fixture(new Scene({ run: (work) => work.input }));
  let next = 'start';
  const unsubscribe = f.runner.observation.subscribe({
    receive(event) {
      if (event.source !== 'entry' || event.fact.kind !== 'acquired') return;
      // Entry feedback precedes the installation's acquired fact and Context
      // construction. This is configuration for the upcoming Scene, not a
      // request to attach recording midway through an already running body.
      if (next === 'start') f.recording.start();
      else f.recording.stop();
    },
  });
  try {
    assert.equal(await f.runner.run('included'), 'included');
    assert.equal(f.inspect().calls.length, 1);
    next = 'stop';
    assert.equal(await f.runner.run('excluded'), 'excluded');
    assert.equal(f.recording.state().status, 'stopped');
    assert.equal(f.inspect().calls.length, 1);
    assert.equal(f.inspect().integrity, 'intact');
  } finally {
    unsubscribe();
  }
});

test('stop drains the entire selected Scene, including children created after stop and their acceptance', async () => {
  const gate = gatedScene();
  const f = fixture(gate.scene);
  f.recording.start();
  const running = f.runner.run('first');
  await gate.entered.promise;
  assert.equal(f.recording.stop().status, 'stopping');
  assert.equal(f.recording.stop().status, 'stopping');
  assert.throws(() => f.recording.clear(), /wait/);
  assert.throws(() => f.recording.start(), /Clear/);
  gate.release.resolve();
  assert.equal(await running, 'first');
  const inspected = f.inspect();
  assert.equal(inspected.status, 'stopped');
  assert.equal(inspected.integrity, 'intact');
  const detail = f.recording.call(inspected.calls[0].id);
  assert.equal(detail.root.status, 'succeeded');
  assert.equal(detail.calls.length, 3);
  const tail = detail.calls.find((call) => call.name === 'tail');
  const parent = detail.calls.find((call) => call.id === tail.parentId);
  assert.deepEqual(
    parent.value.relationChanges.filter((relation) => relation.childId === tail.id).map((relation) => relation.change.kind),
    ['returned', 'receiving', 'accepted'],
  );
  assert.ok(detail.boundaries.some((boundary) => boundary.value.type === 'return'));
  assert.equal(await f.runner.run('unrecorded'), 'unrecorded');
  assert.deepEqual(f.recording.call(inspected.calls[0].id), detail);
  f.recording.clear();
  assert.equal(f.recording.call(inspected.calls[0].id), undefined);
});

for (const outcome of ['failed', 'cancelled']) {
  test(`stop completes after a captured ${outcome} call without falsely marking recording incomplete`, async () => {
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    const failure = new Error('business failure');
    const child = new Node({
      run: async () => {
        entered.resolve();
        await release.promise;
        if (outcome === 'failed') throw failure;
        return 'done';
      },
    });
    const f = fixture(new Scene(child));
    f.recording.start();
    const running = f.runner.run('input');
    const rejected = assert.rejects(running);
    await entered.promise;
    if (outcome === 'cancelled') f.runner.cancel();
    f.recording.stop();
    assert.equal(f.recording.state().status, 'stopping');
    release.resolve();
    await rejected;
    assert.equal(f.recording.state().status, 'stopped');
    assert.equal(f.inspect().integrity, 'intact');
    assert.equal(f.inspect().calls[0].status, 'failed');
  });
}

test('released feedback reentry cannot transfer the old capture to a newly started call', async () => {
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const scene = new Scene({
    run: async (work) => {
      if (work.input === 'second') {
        entered.resolve();
        await release.promise;
      }
      return work.input;
    },
  });
  const f = fixture(scene);
  f.recording.start();
  let next;
  const unsubscribe = f.runner.observation.subscribe({
    receive(event) {
      if (event.source !== 'entry' || event.fact.kind !== 'released' || next) return;
      assert.equal(f.recording.stop().status, 'stopping');
      next = f.runner.run('second');
    },
  });
  assert.equal(await f.runner.run('first'), 'first');
  await entered.promise;
  assert.equal(f.recording.state().status, 'stopped');
  assert.equal(f.inspect().calls.length, 1);
  const previous = f.recording.state().recorderId;
  f.recording.clear();
  f.recording.start();
  assert.notEqual(f.recording.state().recorderId, previous);
  unsubscribe();
  release.resolve();
  assert.equal(await next, 'second');
  assert.equal(f.inspect().calls.length, 0, 'the old unrecorded entry must not bind to a replacement capture');
  assert.equal(await f.runner.run('third'), 'third');
  assert.equal(f.inspect().calls.length, 1);
});

test('recording projection failure stays isolated and leaves its capture explicitly incomplete', async (t) => {
  const input = stableValue({});
  const keys = Object.keys;
  t.mock.method(Object, 'keys', (value) => {
    if (value === input) throw new Error('projection fault');
    return keys(value);
  });
  const f = fixture(new Scene({ run: () => 'business completed' }));
  f.recording.start();
  assert.equal(await f.runner.run(input), 'business completed');
  f.recording.stop();
  assert.equal(f.inspect().status, 'stopped');
  assert.equal(f.inspect().integrity, 'incomplete');
  f.recording.clear();
  f.recording.start();
  await f.runner.run('healthy');
  assert.equal(f.inspect().integrity, 'intact');
});

test('one recording controller cannot be rebound to another Runner', () => {
  const scene = new Scene({ run: () => 'done' });
  const recording = new ConversationRecording(scene);
  new Runner(scene, new Resources(), undefined, { observations: [recording] });
  assert.throws(() => new Runner(scene, new Resources(), undefined, { observations: [recording] }), /one Runner/);
});

test('a recording controller cannot silently bind to a different Scene', () => {
  const recording = new ConversationRecording(new Scene({ run: () => 'expected' }));
  const runner = new Runner(new Scene({ run: () => 'other' }), new Resources(), undefined, { observations: [recording] });
  assert.throws(() => runner.build(), /configured Scene/);
});

test('recording a checkpoint continuation does not invent historical call records or change its result', async () => {
  const codec = { encode: (value) => value, decode: (value) => value };
  const create = () => {
    const point = checkpointPoint()({ name: 'saved', state: codec, references: {}, resume: { run: (_work, state) => state } });
    return new Scene({
      checkpoint: { key: 'recording-resume', version: 1, input: codec, output: codec, points: [point] },
      run(work) {
        work.checkpoint({ point, state: 'saved result' });
        return 'saved result';
      },
    });
  };
  let image;
  const journal = new MemoryCheckpointStore();
  const port = {
    read: (id) => journal.read(id),
    save(value, revision) {
      image = value;
      return journal.save(value, revision);
    },
    finish: (...args) => journal.finish(...args),
  };
  await new Runner(create(), new Resources(), undefined, { checkpoints: { store: port } }).build().run('original');
  const store = new MemoryCheckpointStore();
  store.save(image, 0);
  const scene = create();
  const recording = new ConversationRecording(scene);
  const runner = new Runner(scene, new Resources(), undefined, { observations: [recording], checkpoints: { store } }).build();
  recording.start();
  assert.equal(await runner.resume(image.frame.owner.contextId), 'saved result');
  recording.stop();
  assert.equal(store.read(image.frame.owner.contextId).delivery.status, 'succeeded');
  assert.equal(recording.state().status, 'stopped');
  assert.deepEqual(recording.inspect(content()).recording.calls, [], 'restored invocation does not publish a fresh started fact');
  // Resume does not attach the ordinary invocation recorder at all. This is an
  // empty capture, not a reconstructed historical tree or an observed data loss.
  assert.equal(recording.inspect(content()).recording.integrity, 'intact');
});
