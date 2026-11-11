import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RuntimeError, stableValue } from '@weiliang0121/capix-contracts';
import { MemoryCheckpointStore } from '@weiliang0121/capix-checkpoint';
import { Resource, ResourceOffer } from '@weiliang0121/capix-resources';
import { Node, Scene, checkpointPoint } from '@weiliang0121/capix-structure';
import { Resources, Runner } from '@weiliang0121/capix-runtime';
import { Transcript, TranscriptViewSource } from '@weiliang0121/capix-transcript';
import { View, openView } from '@weiliang0121/capix-view';

const codec = { encode: structuredClone, decode: structuredClone };

function fixture() {
  // An ordinary business object owns its update rules and reading basis. No core
  // entity superclass, common revision model or public material wrapper is needed.
  const order = {
    id: 'order-42',
    version: 0,
    reads: 0,
    value: { status: 'draft', details: { note: 'original request' } },
    stamp() {
      return { id: this.id, scope: 'whole', version: String(this.version) };
    },
    readMaterial() {
      this.reads++;
      return stableValue({ basis: this.stamp(), value: this.value });
    },
    revise() {
      this.value.status = 'approved';
      this.value.details.note = 'revised request';
      this.version++;
    },
  };
  // This is the existing ViewSource contract, implemented by the consumer.
  const orders = {
    index() {
      return this.inspect([order.id]);
    },
    inspect(keys) {
      if (!Array.isArray(keys) || new Set(keys).size !== keys.length || keys.some((key) => key !== order.id)) throw new RangeError('Unknown or duplicate order key');
      return stableValue({ stamp: order.stamp(), entries: keys.map((key) => ({ key, summary: { status: order.value.status } })) });
    },
    check(expected) {
      const current = order.stamp();
      return expected.id === current.id && expected.scope === current.scope && expected.version === current.version;
    },
    read(keys, expected) {
      if (!this.check(expected)) throw new RuntimeError('VIEW_SOURCE_CONFLICT', 'Order changed');
      this.inspect(keys);
      const material = order.readMaterial();
      return stableValue({ stamp: material.basis, entries: keys.map((key) => ({ key, value: material.value })) });
    },
  };
  const transcript = new Transcript([{ role: 'user', content: 'original message' }]);
  const messages = new TranscriptViewSource(transcript);
  const sources = { orders, messages };
  const view = new View({
    revision: 0,
    sources: { orders: { id: order.id, scope: 'whole' }, messages: { id: transcript.id, scope: 'whole' } },
    members: [
      { source: 'orders', key: order.id },
      { source: 'messages', key: 0 },
    ],
  });
  const readOrder = new ResourceOffer({
    name: 'example.order.read',
    expose: (origin, activity) => ({ read: () => activity.runSync('read', {}, () => origin.readMaterial()) }),
  });
  const readView = new ResourceOffer({ name: 'example.materials.read', expose: (origin, activity) => openView(origin.view, origin.sources, activity) });
  const resources = new Resources().register(new Resource(order), readOrder).register(new Resource({ view, sources }), readView);
  const deps = { order: readOrder.request(), view: readView.request() };
  let reads = 0;
  async function readMaterials(work) {
    reads++;
    const order = work.resources.order.read();
    const selected = await work.resources.view.capture();
    return { order, selected: stableValue({ basis: selected.basis, value: selected.entries }) };
  }
  function update() {
    order.revise();
    transcript.append({ role: 'assistant', content: 'later message' });
    view.includeSync(sources, [{ source: 'messages', key: 1 }]);
  }
  return { order, orders, transcript, messages, view, resources, deps, readMaterials, update, readCount: () => reads };
}

function assertOriginal(material, content) {
  assert.deepEqual(material.order, { basis: { id: content.order.id, scope: 'whole', version: '0' }, value: { status: 'draft', details: { note: 'original request' } } });
  assert.equal(material.selected.basis.viewRevision, 0);
  assert.equal(material.selected.basis.sources.orders.version, '0');
  assert.equal(material.selected.basis.sources.messages.id, content.transcript.id);
  assert.equal(material.selected.basis.sources.messages.version, '1');
  assert.deepEqual(material.selected.value, [
    { source: 'orders', key: content.order.id, value: material.order.value },
    { source: 'messages', key: 0, value: { role: 'user', content: 'original message' } },
  ]);
  assert.ok(Object.isFrozen(material.order.value.details));
  assert.ok(Object.isFrozen(material.selected.value));
}

test('ordinary business material and Transcript share View and resources without rewriting delivered values', async () => {
  const content = fixture();
  const node = new Node({ deps: content.deps, run: content.readMaterials });
  const scene = new Scene({ run: (work) => work.children.invoke(node, null) }).add(node);
  const runner = new Runner(scene, content.resources).build();
  const delivered = await runner.run(null);
  assertOriginal(delivered, content);
  assert.equal(content.order.reads, 2, 'the direct resource and the View each read the business entity');
  content.update();
  assert.equal(content.orders.check(delivered.order.basis), false);
  assert.equal(content.messages.check(delivered.selected.basis.sources.messages), false);
  assertOriginal(delivered, content);
  assert.throws(() => {
    delivered.order.value.details.note = 'rewrite history';
  }, TypeError);
  const current = await runner.run(null);
  assert.equal(current.order.value.status, 'approved');
  assert.equal(current.order.value.details.note, 'revised request');
  assert.equal(current.selected.basis.sources.orders.version, '1');
  assert.equal(current.selected.basis.sources.messages.version, '2');
  assert.equal(current.selected.value.length, 3);
  assert.deepEqual(current.selected.value[2], { source: 'messages', key: 1, value: { role: 'assistant', content: 'later message' } });
  assertOriginal(delivered, content);
});

test('explicit checkpoint resume returns saved material without rereading or restoring current entities', async () => {
  const content = fixture();
  const memory = new MemoryCheckpointStore();
  let saved;
  const capturingStore = {
    read: (id) => memory.read(id),
    save(commit, revision) {
      const receipt = memory.save(commit, revision);
      // Keep the active save boundary before the original run finishes. A new
      // store below receives only serialized CP data, never a live entity.
      saved = JSON.parse(JSON.stringify(memory.read(receipt.contextId).image));
      return receipt;
    },
    finish: (id, revision, delivery) => memory.finish(id, revision, delivery),
  };
  let resumed = 0;
  function assemble(store) {
    const point = checkpointPoint()({
      name: 'materials-read',
      state: codec,
      references: {},
      resume: {
        deps: {},
        run(work, state) {
          resumed++;
          assert.deepEqual(Object.keys(work.resources), []);
          return state;
        },
      },
    });
    const scene = new Scene({
      deps: content.deps,
      checkpoint: { key: 'example.fixed-material', version: 1, input: codec, output: codec, points: [point] },
      async run(work) {
        const material = await content.readMaterials(work);
        work.checkpoint({ point, state: material });
        return material;
      },
    });
    return new Runner(scene, content.resources, undefined, { checkpoints: { store } }).build();
  }
  const first = assemble(capturingStore);
  const delivered = await first.run(null);
  assertOriginal(delivered, content);
  assert.deepEqual(saved.state, delivered);
  content.update();
  const reads = content.readCount();
  const entityReads = content.order.reads;
  const coldStore = new MemoryCheckpointStore();
  coldStore.save(saved, 0);
  const second = assemble(coldStore);
  assert.notEqual(first, second);
  const restored = await second.resume(saved.frame.owner.contextId);
  assert.equal(resumed, 1);
  assert.deepEqual(restored, delivered);
  assert.notEqual(restored, delivered);
  assertOriginal(restored, content);
  assert.equal(content.readCount(), reads);
  assert.equal(content.order.reads, entityReads);
  assert.equal(content.order.version, 1);
  assert.equal(content.order.value.details.note, 'revised request');
  assert.equal(content.transcript.revision, 2);
  assert.equal(content.transcript.length, 2);
  assert.equal(content.view.members().length, 3);
});
