import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stableValue } from '@weiliang0121/capix-contracts';
import { MemoryCheckpointStore } from '@weiliang0121/capix-checkpoint';
import { Memories, memoryResources } from '@weiliang0121/capix-memory';
import { Resource, ResourceOffer } from '@weiliang0121/capix-resources';
import { Node, Scene, checkpointPoint } from '@weiliang0121/capix-structure';
import { Resources, Runner } from '@weiliang0121/capix-runtime';

/** @typedef {{ absent: undefined, signed: number, detail: { label: string } }} ExampleMetadata */

function content(text) {
  const detail = Object.assign(Object.create(null), { label: 'business detail' });
  /** @type {import('@weiliang0121/capix-memory').MemoryContent<ExampleMetadata>} */
  const value = { content: text, metadata: { absent: undefined, signed: -0, detail } };
  return value;
}

// This codec covers this business schema only. In particular, JSON alone cannot
// represent its undefined field, negative zero, or null-prototype detail record.
const contentCodec = {
  encode(value) {
    assert.ok(Object.hasOwn(value.metadata, 'absent'));
    assert.equal(value.metadata.absent, undefined);
    assert.ok(Object.is(value.metadata.signed, -0));
    assert.equal(Object.getPrototypeOf(value.metadata.detail), null);
    return { content: value.content, metadata: { absent: 'undefined', signed: 'negative-zero', detail: { prototype: 'null', label: value.metadata.detail.label } } };
  },
  decode(value) {
    assert.equal(value.metadata.absent, 'undefined');
    assert.equal(value.metadata.signed, 'negative-zero');
    assert.equal(value.metadata.detail.prototype, 'null');
    return { content: value.content, metadata: { absent: undefined, signed: -0, detail: Object.assign(Object.create(null), { label: value.metadata.detail.label }) } };
  },
};
const materialCodec = {
  encode: (value) => ({ ...value, value: contentCodec.encode(value.value) }),
  decode: (value) => stableValue({ ...value, value: contentCodec.decode(value.value) }),
};
const requestCodec = {
  encode: (value) => ({ ...value, command: { ...value.command, changes: value.command.changes.map((change) => ({ ...change, value: contentCodec.encode(change.value) })) } }),
  decode: (value) => stableValue({ ...value, command: { ...value.command, changes: value.command.changes.map((change) => ({ ...change, value: contentCodec.decode(change.value) })) } }),
};
const savedCodec = {
  encode: (value) => ({ ...value, material: materialCodec.encode(value.material), request: requestCodec.encode(value.request) }),
  decode: (value) => ({ ...value, material: materialCodec.decode(value.material), request: requestCodec.decode(value.request) }),
};
const identity = { encode: (value) => value, decode: (value) => value };
const jsonRoundtrip = (value) => JSON.parse(JSON.stringify(value));

function assertMetadata(value) {
  assert.ok(Object.hasOwn(value.metadata, 'absent'));
  assert.equal(value.metadata.absent, undefined);
  assert.ok(Object.is(value.metadata.signed, -0));
  assert.equal(Object.getPrototypeOf(value.metadata.detail), null);
  assert.equal(value.metadata.detail.label, 'business detail');
  assert.ok(Object.isFrozen(value.metadata.detail));
}

test('memory resources and Node delivery preserve typed metadata with checkpoints enabled or disabled', async () => {
  const memories = new Memories();
  const id = memories.apply([{ action: 'create', value: content('original') }]).changed[0].id;
  const delivered = [];
  for (const enabled of [false, true]) {
    const offers = memoryResources();
    const resources = new Resources().register(new Resource(memories), offers.read);
    const checkpoint = enabled ? { key: 'example.memory-reader', version: 1, input: identity, output: materialCodec, points: [] } : undefined;
    const node = new Node({ deps: { memories: offers.read.request() }, checkpoint, run: (work) => work.resources.memories.read(work.input) });
    const scene = new Scene({ run: (work) => work.children.invoke(node, work.input) }).add(node);
    const capabilities = enabled ? { checkpoints: { store: new MemoryCheckpointStore() } } : {};
    const result = await new Runner(scene, resources, undefined, capabilities).build().run(id);
    assert.equal(result.id, id);
    assert.deepEqual(result.basis, { memoriesId: memories.id, sequence: 1 });
    assertMetadata(result.value);
    assert.ok(Object.isFrozen(result));
    delivered.push(result);
  }
  assert.deepEqual(delivered[0], delivered[1]);
  memories.apply([{ action: 'update', memoryId: id, value: content('later') }]);
  assert.equal(memories.read(id).value.content, 'later');
  for (const result of delivered) {
    assert.equal(result.value.content, 'original');
    assertMetadata(result.value);
  }
  const lost = jsonRoundtrip(delivered[0]);
  assert.equal(Object.hasOwn(lost.value.metadata, 'absent'), false);
  assert.equal(Object.is(lost.value.metadata.signed, -0), false);
  assert.equal(Object.getPrototypeOf(lost.value.metadata.detail), Object.prototype);
  assert.notDeepEqual(lost, delivered[0]);
  assert.deepEqual(materialCodec.decode(jsonRoundtrip(materialCodec.encode(delivered[0]))), delivered[0]);
});

test('cold checkpoint material and exact fixed request confirm the original effect without writing again', async () => {
  let commits = 0;
  let fixed;
  const memories = new Memories({
    persistence: {
      commit(change) {
        commits++;
        if (change.fixed) fixed = change.fixed;
      },
    },
  });
  const id = memories.apply([{ action: 'create', value: content('original') }]).changed[0].id;
  const store = new MemoryCheckpointStore();
  let saved;
  const capturing = {
    read: (key) => store.read(key),
    save(commit, revision) {
      const receipt = store.save(commit, revision);
      saved = jsonRoundtrip(store.read(receipt.contextId).image);
      return receipt;
    },
    finish: (...args) => store.finish(...args),
  };
  let bodies = 0;
  let resumes = 0;
  const proof = new ResourceOffer({
    name: 'example.memory-confirmation',
    expose: (origin, activity) => ({
      request: () => activity.runSync('request', {}, () => origin.request()),
      confirm: (request) => activity.runSync('confirm', {}, () => origin.confirm(request)),
    }),
  });
  function assemble(entity, checkpointStore, cold = false) {
    const offers = memoryResources();
    const host = { request: () => fixed.request, confirm: (request) => entity.confirmFixed(request) };
    const resources = new Resources().register(new Resource(entity), offers.read).register(new Resource(entity), offers.apply).register(new Resource(host), proof);
    const point = checkpointPoint()({
      name: 'effect-and-material',
      state: savedCodec,
      references: {},
      resume: {
        deps: { confirmation: proof.request() },
        run(work, state) {
          resumes++;
          assert.deepEqual(Object.keys(work.resources), ['confirmation']);
          assert.deepEqual(work.resources.confirmation.confirm(state.request), state.receipt);
          assertMetadata(state.material.value);
          assertMetadata(state.request.command.changes[0].value);
          return state;
        },
      },
    });
    const node = new Node({
      deps: { memories: offers.read.request(), apply: offers.apply.request(), confirmation: proof.request() },
      checkpoint: { key: 'example.memory-effect-node', version: 1, input: identity, output: savedCodec, points: [] },
      run(work) {
        assert.equal(cold, false, 'cold recovery must not rerun the applying Node');
        bodies++;
        const material = work.resources.memories.read(id);
        const receipt = work.resources.apply.applyFixed({ position: 'remember', changes: [{ action: 'update', memoryId: id, value: content('written'), reason: 'business update' }] }, material.basis);
        return { material, request: work.resources.confirmation.request(), receipt };
      },
    });
    const scene = new Scene({
      checkpoint: { key: 'example.memory-effect-scene', version: 1, input: identity, output: savedCodec, points: [point] },
      async run(work) {
        assert.equal(cold, false);
        const state = await work.children.invoke(node, null);
        work.checkpoint({ point, state });
        return state;
      },
    }).add(node);
    return new Runner(scene, resources, undefined, { checkpoints: { store: checkpointStore } }).build();
  }
  const first = await assemble(memories, capturing).run(null);
  assert.equal(first.material.value.content, 'original');
  assert.deepEqual(first.request.expected, first.material.basis);
  assert.equal(first.request.command.position, 'remember');
  assert.ok(first.request.operation.contextId);
  assert.equal(memories.read(id).value.content, 'written');
  memories.apply([{ action: 'update', memoryId: id, value: content('later') }]);
  assert.equal(commits, 3);
  // The authoritative host snapshot has its own explicit, schema-specific codec.
  const state = memories.exportState();
  const encodedState = { ...state, items: state.items.map(materialCodec.encode), applies: state.applies.map((entry) => ({ ...entry, request: requestCodec.encode(entry.request) })) };
  const serialized = jsonRoundtrip(encodedState);
  const decodedState = { ...serialized, items: serialized.items.map(materialCodec.decode), applies: serialized.applies.map((entry) => ({ ...entry, request: requestCodec.decode(entry.request) })) };
  let coldWrites = 0;
  const coldEntity = Memories.restore(decodedState, {
    persistence: {
      commit() {
        coldWrites++;
      },
    },
  });
  const coldStore = new MemoryCheckpointStore();
  coldStore.save(saved, 0);
  const restored = await assemble(coldEntity, coldStore, true).resume(saved.frame.owner.contextId);
  assert.deepEqual(restored, first);
  assert.notEqual(restored, first);
  assertMetadata(restored.material.value);
  assertMetadata(restored.request.command.changes[0].value);
  assert.equal(restored.material.value.content, 'original');
  assert.equal(coldEntity.read(id).value.content, 'later');
  assert.equal(coldEntity.sequence, 3);
  assert.equal(coldWrites, 0);
  assert.equal(commits, 3);
  assert.equal(bodies, 1);
  assert.equal(resumes, 1);
});
