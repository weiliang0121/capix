import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FactType, publishFact } from '@weiliang0121/capix-changes';
import { MemoryCheckpointStore } from '@weiliang0121/capix-checkpoint';
import { Memories, MemoryViewSource, memoryResources } from '@weiliang0121/capix-memory';
import { BaseRecord, RecordBook, Recorder, recordContentFact } from '@weiliang0121/capix-records';
import { Resource, ResourceAccessClosed, ResourceOffer } from '@weiliang0121/capix-resources';
import { Node, Scene, checkpointPoint } from '@weiliang0121/capix-structure';
import { Resources, Runner, bindRecording } from '@weiliang0121/capix-runtime';
import { View, createViewSource, openView } from '@weiliang0121/capix-view';

// This fixture deliberately uses JSON values only. It does not claim that JSON
// preserves every Stable value or provides an entity persistence implementation.
const codec = { encode: structuredClone, decode: structuredClone };
const taskChanged = new FactType('entity-chain.task');
const journalAppended = new FactType('entity-chain.journal');
class BusinessRecord extends BaseRecord {}

function fixture() {
  const counts = { taskKeys: 0, taskInspect: 0, taskRead: 0, journalKeys: 0, journalInspect: 0, journalRead: 0, memoryRead: 0, memoryInspect: 0, memoryWrites: 0, writes: 0 };
  const task = { version: 0, items: new Map([['selected', { priority: 1, details: { note: 'original' } }]]) };
  const journal = { version: 0, items: new Map([[0, { text: 'original entry', tags: ['business'] }]]) };
  // A selected read must never touch these unselected bodies, even as the source
  // grows. Full-directory enumeration remains an explicit, separately counted call.
  Object.defineProperty(task, 'unselected', { get: () => assert.fail('unselected task body was visited') });
  Object.defineProperty(journal, 'unselected', { get: () => assert.fail('unselected journal body was visited') });
  task.items.set('unselected', task);
  journal.items.set(1, journal);
  const tasks = createViewSource({
    id: 'business-tasks',
    scope: 'whole',
    version: () => String(task.version),
    keys: () => {
      counts.taskKeys++;
      return [...task.items.keys()];
    },
    inspect: (key) => {
      counts.taskInspect++;
      assert.equal(key, 'selected');
      return { priority: task.items.get(key).priority };
    },
    read: (key) => {
      counts.taskRead++;
      assert.equal(key, 'selected');
      return task.items.get(key);
    },
  });
  const entries = createViewSource({
    id: 'business-journal',
    scope: 'whole',
    version: () => String(journal.version),
    keys: () => {
      counts.journalKeys++;
      return [...journal.items.keys()];
    },
    inspect: (key) => {
      counts.journalInspect++;
      assert.equal(key, 0);
      return { label: journal.items.get(key).text };
    },
    read: (key) => {
      counts.journalRead++;
      assert.equal(key, 0);
      return journal.items.get(key);
    },
  });
  const memories = new Memories({
    persistence: {
      commit() {
        counts.memoryWrites++;
      },
    },
  });
  const memoryId = memories.apply([{ action: 'create', value: { content: 'original memory', metadata: { category: 'business' } } }]).changed[0].id;
  const memorySource = new MemoryViewSource(memories);
  const sources = {
    tasks,
    entries,
    memories: {
      index: () => memorySource.index(),
      inspect(keys) {
        counts.memoryInspect++;
        return memorySource.inspect(keys);
      },
      read(keys, expected) {
        counts.memoryRead++;
        return memorySource.read(keys, expected);
      },
      check: (expected) => memorySource.check(expected),
    },
  };
  const view = new View({
    revision: 0,
    sources: { tasks: { id: tasks.id, scope: tasks.scope }, entries: { id: entries.id, scope: entries.scope }, memories: { id: memories.id, scope: 'whole' } },
    members: [
      { source: 'tasks', key: 'selected' },
      { source: 'entries', key: 0 },
      { source: 'memories', key: memoryId },
    ],
  });
  const read = new ResourceOffer({ expose: (origin, activity) => openView(origin.view, origin.sources, activity) });
  const change = new ResourceOffer({
    methods: {
      revise(origin, note, operation) {
        counts.writes++;
        origin.items.get('selected').details.note = note;
        origin.version++;
        publishFact({ note }, undefined, operation.facts(taskChanged));
        return origin.version;
      },
    },
  });
  const append = new ResourceOffer({
    methods: {
      append(origin, text, operation) {
        counts.writes++;
        const key = origin.items.size;
        origin.items.set(key, { text, tags: ['later'] });
        origin.version++;
        publishFact({ key, text }, undefined, operation.facts(journalAppended));
        return key;
      },
    },
  });
  const memoryOffers = memoryResources();
  const resources = new Resources().register(new Resource({ view, sources }), read).register(new Resource(task), change).register(new Resource(journal), append).register(new Resource(memories), memoryOffers.apply);
  return { task, journal, memories, memoryId, sources, view, counts, resources, read, change, append, memoryOffers };
}

function assemble(content, { checkpoint = false, recording = false, store = new MemoryCheckpointStore(), cold = false } = {}) {
  const recorder = recording ? new Recorder(new RecordBook()) : undefined;
  let bodies = 0;
  let resumes = 0;
  let endpoint;
  let lastIndex;
  const observations = recorder
    ? [
        bindRecording(recorder, {
          failure: 'propagate',
          fact(fact, source, writer) {
            recordContentFact(fact, source, writer);
            for (const token of [taskChanged, journalAppended]) token.match(fact.fact, (value) => writer.add(new BusinessRecord({ value, contextId: source.contextId, operationId: fact.operationId, supplyId: fact.supplyId, offerId: fact.offerId }, source.callId)));
          },
        }),
      ]
    : [];
  const point = checkpointPoint()({
    name: 'materials',
    state: codec,
    references: {},
    resume: {
      deps: {},
      run(work, state) {
        resumes++;
        assert.deepEqual(Object.keys(work.resources), []);
        return state;
      },
    },
  });
  const node = new Node({
    deps: { view: content.read.request(), task: content.change.request(), journal: content.append.request(), memories: content.memoryOffers.apply.request() },
    ...(checkpoint ? { checkpoint: { key: 'entity-chain.reader', version: 1, input: codec, output: codec, points: [] } } : {}),
    async run(work) {
      assert.equal(cold, false, 'cold resume must not execute the original node');
      bodies++;
      endpoint = work.resources.view;
      const index = await endpoint.index();
      lastIndex = index;
      const material = await endpoint.capture(index);
      await work.resources.task.revise(work.input.note);
      await work.resources.journal.append(work.input.text);
      work.resources.memories.apply([{ action: 'update', memoryId: content.memoryId, value: { content: work.input.memory, metadata: { category: 'updated' } } }]);
      return { input: work.input, material };
    },
  });
  const scene = new Scene({
    ...(checkpoint ? { checkpoint: { key: 'entity-chain.scene', version: 1, input: codec, output: codec, points: [point] } } : {}),
    async run(work) {
      assert.equal(cold, false);
      const state = await work.children.invoke(node, work.input);
      if (checkpoint) work.checkpoint({ point, state });
      return state;
    },
  }).add(node);
  const runner = new Runner(scene, content.resources, undefined, { observations, ...(checkpoint ? { checkpoints: { store } } : {}) }).build();
  return { runner, recorder, bodies: () => bodies, resumes: () => resumes, endpoint: () => endpoint, index: () => lastIndex };
}

for (const checkpoint of [false, true])
  for (const recording of [false, true]) {
    test(`business state, append-only entries and Memory share resources/View (CP ${checkpoint}, recording ${recording})`, async () => {
      const content = fixture();
      const memory = new MemoryCheckpointStore();
      let saved;
      const store = {
        read: (id) => memory.read(id),
        save(commit, revision) {
          const receipt = memory.save(commit, revision);
          if (commit.contract.key === 'entity-chain.scene') saved = JSON.parse(JSON.stringify(memory.read(receipt.contextId).image));
          return receipt;
        },
        finish: (...args) => memory.finish(...args),
      };
      const assembly = assemble(content, { checkpoint, recording, store });
      const input = { note: 'updated', text: 'later entry', memory: 'later memory' };
      const delivered = await assembly.runner.run(input);
      assert.deepEqual(delivered.input, input);
      const oldValues = delivered.material.entries.map((entry) => entry.value);
      assert.deepEqual(oldValues[0], { priority: 1, details: { note: 'original' } });
      assert.deepEqual(oldValues[1], { text: 'original entry', tags: ['business'] });
      assert.equal(oldValues[2].value.content, 'original memory');
      assert.ok(Object.isFrozen(oldValues[0].details));
      assert.throws(() => {
        oldValues[0].details.note = 'rewritten';
      }, TypeError);
      await assert.rejects(assembly.endpoint().index(), ResourceAccessClosed);
      await assert.rejects(content.view.capture(content.sources, assembly.index()), (error) => error.code === 'VIEW_CONFLICT');
      const current = await content.view.capture(content.sources);
      assert.equal(current.entries[0].value.details.note, 'updated');
      assert.deepEqual(current.entries[1].value, oldValues[1]);
      assert.equal(current.entries[2].value.value.content, 'later memory');
      assert.equal(content.journal.items.size, 3);
      assert.equal(content.counts.taskKeys, 0);
      assert.equal(content.counts.journalKeys, 0);
      assert.equal(content.counts.taskRead, 2);
      assert.equal(content.counts.journalRead, 2);
      if (recording) {
        const records = [...assembly.recorder.book.values()];
        const business = records.filter((record) => record instanceof BusinessRecord);
        assert.equal(business.length, 2);
        for (const record of business) {
          const call = assembly.recorder.book.get(record.parentId);
          assert.equal(call.structureKind, 'node');
          assert.equal(record.value.contextId, call.contextId);
          const started = records.find((candidate) => candidate.kind === 'resource' && candidate.phase === 'started' && candidate.interactionId === record.value.operationId);
          assert.ok(started);
          assert.equal(started.parentId, call.id);
          assert.equal(started.supplyId, record.value.supplyId);
          assert.equal(record.value.offerId, record.value.value.note ? content.change.id : content.append.id);
        }
        assert.equal(records.filter((record) => record.kind === 'memory').length, 1);
      }
      if (checkpoint) {
        assert.deepEqual(saved.state, delivered);
        const before = { ...content.counts };
        const memoryState = content.memories.exportState();
        const coldStore = new MemoryCheckpointStore();
        coldStore.save(saved, 0);
        const cold = assemble(content, { checkpoint, recording, store: coldStore, cold: true });
        const restored = await cold.runner.resume(saved.frame.owner.contextId);
        assert.deepEqual(restored, delivered);
        assert.notEqual(restored, delivered);
        assert.deepEqual(content.counts, before);
        assert.deepEqual(content.memories.exportState(), memoryState);
        assert.equal(content.task.items.get('selected').details.note, 'updated');
        assert.equal(content.task.version, 1);
        assert.equal(content.journal.version, 1);
        assert.equal(content.journal.items.size, 3);
        assert.equal(cold.bodies(), 0);
        assert.equal(cold.resumes(), 1);
        if (recording) assert.equal([...cold.recorder.book.values()].filter((record) => record instanceof BusinessRecord || record.kind === 'memory').length, 0, 'saved material does not replay historical entity changes');
      }
      assert.equal(assembly.bodies(), 1);
      assert.equal(delivered.material.entries[0].value.details.note, 'original');
      assert.equal(delivered.material.entries[2].value.value.content, 'original memory');
    });
  }
