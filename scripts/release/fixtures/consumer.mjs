// Run from an independent directory containing the installed npm tarballs.
import assert from 'node:assert/strict';
import * as contracts from '@weiliang0121/capix-contracts';
import * as diagnostics from '@weiliang0121/capix-diagnostics';
import * as invocation from '@weiliang0121/capix-invocation';
import * as invocationEvents from '@weiliang0121/capix-invocation/events';
import * as protocol from '@weiliang0121/capix-protocol';
import * as structure from '@weiliang0121/capix-structure';
import * as structureConstruction from '@weiliang0121/capix-structure/construction';
import * as runtime from '@weiliang0121/capix-runtime';
import * as construction from '@weiliang0121/capix-runtime/construction';
import * as recording from '@weiliang0121/capix-runtime/recording';
import { Resource, ResourceOffer, ResourceAccessClosed } from '@weiliang0121/capix-resources';
import { receiveOperation } from '@weiliang0121/capix-resources/operation';
import { FactType, publishFact } from '@weiliang0121/capix-changes';
import { Transcript, TranscriptFacts, TranscriptResource } from '@weiliang0121/capix-transcript';
import { CallableRecordHelper, RecordBook, Recorder } from '@weiliang0121/capix-records';
import { readOutput, validateExecutionRecordSnapshot, validateInvocationRecordValue } from '@weiliang0121/capix-records/data';
import { z } from 'zod';
import { Tool, ToolModelResource } from '@weiliang0121/capix-tool';
import { ModelExchanges, ModelExchangeResource } from '@weiliang0121/capix-model-exchanges';
import { requireModelRequest, requireModelReply } from '@weiliang0121/capix-model-provider';
import { MemoryCheckpointStore, cloneCheckpointHead } from '@weiliang0121/capix-checkpoint';
import { Memories, MemoryViewSource, memoryResources } from '@weiliang0121/capix-memory';
import { View, createViewSource, openView } from '@weiliang0121/capix-view';

const { Scene, Group, Node, Runner, Resources, checkpointPoint } = runtime;
const { RuntimeError, StableValueError, stableValue } = contracts;
const { PersistenceError } = diagnostics;

// Separate minified entry points must retain shared class and declaration identity.
for (const entry of [diagnostics, invocation, runtime]) assert.equal(entry.RuntimeError, RuntimeError);
for (const entry of [invocation, runtime]) assert.equal(entry.PersistenceError, PersistenceError);
for (const name of ['Scene', 'Group', 'Node', 'Callable']) assert.equal(runtime[name], structure[name]);
for (const entry of [construction, recording]) {
  assert.ok(Object.keys(entry).length > 0);
  for (const [name, value] of Object.entries(entry)) assert.equal(runtime[name], value, `runtime/${name} identity`);
}
assert.equal(construction.Invocation, invocation.Invocation);
assert.equal(invocation.invocationProcessStages, invocationEvents.invocationProcessStages);
assert.equal(invocation.invocationProcessActions, invocationEvents.invocationProcessActions);
assert.deepEqual(invocationEvents.invocationProcessStages, ['execute', 'receive', 'handling', 'control']);
assert.deepEqual(Object.keys(protocol), ['acceptTranscriptUpdate']);
assert.equal(typeof structureConstruction.assertStructureConfigurable, 'function');
const configurable = new Scene({ run: () => null });
structureConstruction.assertStructureConfigurable(configurable);
new Runner(configurable, new Resources()).build();
assert.throws(() => structureConstruction.assertStructureConfigurable(configurable));
assert.equal(await receiveOperation({ status: 'succeeded', value: 2 }, { result: { succeeded: (value) => value * 3 } }), 6);
assert.equal(new RuntimeError('SMOKE', 'runtime error').name, 'RuntimeError');
assert.equal(new PersistenceError('smoke.commit', new Error('cause')).name, 'PersistenceError');
assert.ok(new PersistenceError('smoke.commit', null) instanceof RuntimeError);
assert.throws(() => stableValue(new Date()), StableValueError);
assert.throws(() => new invocation.InvocationContext(new Date()), StableValueError);

const offer = new ResourceOffer({
  name: 'release.dictionary',
  methods: {
    translate(origin, word, operation) {
      operation.emit(`lookup:${word}`);
      return `${origin.prefix}${word}`;
    },
  },
});
let retainedEndpoint;
const node = new Node({
  deps: { dictionary: offer.request() },
  output: { result: String, delta: String },
  run(work) {
    retainedEndpoint = work.resources.dictionary;
    return retainedEndpoint.translate(work.input, { delta: (part) => work.output.emit(part) });
  },
});
const group = new Group({ output: { result: String, delta: String } }).add({ node });
group.run = (work) => work.children.node.invoke(work.input, { delta: (part) => work.output.emit(part) });
const scene = new Scene({ output: { result: String, delta: String } }).add({ group });
scene.run = (work) => work.children.group.invoke(work.input, { delta: (part) => work.output.emit(part) });
const resources = new Resources().register(new Resource({ prefix: 'translated:' }), offer);
const runner = new Runner(scene, resources).build();
const events = [];
const unsubscribe = runner.output.subscribe({ receive: (event) => void events.push(event) });
assert.equal(await runner.run('hello'), 'translated:hello');
assert.deepEqual(
  events.map((event) => event.kind),
  ['started', 'delta', 'sealed', 'completed'],
);
assert.equal(events[1].delta, 'lookup:hello');
assert.equal(events.at(-1).result, 'translated:hello');
assert.equal(runner.isRunning, false);
unsubscribe();
await assert.rejects(retainedEndpoint.translate('late'), ResourceAccessClosed);

// The invocation's classifier must recognize errors imported by an external host.
for (const failure of [new Error('ordinary'), new PersistenceError('smoke.commit', new Error('disk')), new StableValueError('UNSUPPORTED_VALUE')]) {
  let handled = 0;
  const failingOffer = new ResourceOffer({
    methods: {
      fail() {
        throw failure;
      },
    },
  });
  const failingScene = new Scene({
    deps: { resource: failingOffer.request() },
    run: (work) =>
      work.resources.resource.fail(undefined, {
        result: {
          failed(error) {
            assert.equal(error, failure);
            handled++;
            return 'handled';
          },
        },
      }),
  });
  const failingRunner = new Runner(failingScene, new Resources().register(new Resource(null), failingOffer)).build();
  if (failure instanceof PersistenceError || failure instanceof StableValueError) {
    await assert.rejects(failingRunner.run(null), (error) => error === failure);
    assert.equal(handled, 0);
  } else {
    assert.equal(await failingRunner.run(null), 'handled');
    assert.equal(handled, 1);
  }
  assert.equal(failingRunner.isRunning, false);
}

// Capture a real save boundary before final delivery. Restore only persisted pure
// values into a fresh Store and construct an entirely new Scene and Runner.
const codec = { encode: structuredClone, decode: structuredClone };
let saved;
let bodyRuns = 0;
let resumeRuns = 0;
class CaptureStore extends MemoryCheckpointStore {
  save(image, revision) {
    const receipt = super.save(image, revision);
    saved = cloneCheckpointHead(this.read(receipt.contextId));
    return receipt;
  }
}
function checkpointRunner(store) {
  const point = checkpointPoint()({
    name: 'prepared',
    state: codec,
    references: {},
    resume: {
      run(work, state) {
        resumeRuns++;
        assert.equal(work.input.label, state.label);
        return { answer: state.answer };
      },
    },
  });
  const root = new Scene({
    checkpoint: { key: 'release.consumer', version: 1, input: codec, output: codec, points: [point] },
    run(work) {
      bodyRuns++;
      const answer = `saved:${work.input.label}`;
      work.checkpoint({ point, state: { label: work.input.label, answer }, refs: {} });
      return { answer };
    },
  });
  return new Runner(root, new Resources(), undefined, { checkpoints: { store } }).build();
}
const originalStore = new CaptureStore();
const original = checkpointRunner(originalStore);
assert.deepEqual(await original.run({ label: 'hello' }), { answer: 'saved:hello' });
assert.ok(saved);
assert.equal(saved.delivery, undefined);
assert.equal(originalStore.read(saved.image.frame.owner.contextId).delivery.status, 'succeeded');
const coldStore = new MemoryCheckpointStore();
const coldImage = cloneCheckpointHead(structuredClone(saved)).image;
coldStore.save(coldImage, 0);
const restored = checkpointRunner(coldStore);
const restoredEvents = [];
restored.output.subscribe({ receive: (event) => void restoredEvents.push(event) });
assert.deepEqual(await restored.resume(coldImage.frame.owner.contextId), { answer: 'saved:hello' });
assert.equal(bodyRuns, 1);
assert.equal(resumeRuns, 1);
assert.ok(restoredEvents.every((event) => event.contextId === coldImage.frame.owner.contextId));
assert.equal(coldStore.read(coldImage.frame.owner.contextId).delivery.status, 'succeeded');
// Exercise the distributed Tool preset with host-owned plain entity/channel resources.
const modelContract = { key: 'release.tool.model.v1', request: requireModelRequest, reply: requireModelReply };
const modelRequests = [];
const modelReply = (id, output) => ({ formatVersion: 1, id, model: 'offline-consumer', output, termination: { kind: 'completed', reason: output.some((item) => item.kind === 'tool-call') ? 'tool_calls' : 'stop' }, usage: null, native: { format: 'chat-completions', version: 1 } });
const exchanges = new ModelExchanges();
const interactions = new runtime.Interactions().register(modelContract, {
  send(request) {
    modelRequests.push(structuredClone(request));
    return request.exchanges.length === 0 ? modelReply('lookup-request', [{ kind: 'tool-call', id: 'lookup-1', name: 'lookup', arguments: { encoding: 'json-text', text: '{"key":"hello"}' } }]) : modelReply('final-answer', [{ kind: 'text', text: 'translated:hello' }]);
  },
});
let toolExecutions = 0;
const lookup = new Node({
  run(work) {
    toolExecutions++;
    return { text: `translated:${work.input.key}` };
  },
});
const tool = new Tool({
  policyVersion: 'release.consumer.v1',
  tools: { lookup: { node: lookup, description: 'Look up a local word', input: z.strictObject({ key: z.string() }), result: { succeeded: (value) => ({ status: 'ok', content: [{ kind: 'text', text: value.text }] }) } } },
});
assert.ok(tool instanceof Group, 'Tool shares distributed structure class identity');
const toolScene = new Scene().add({ tool });
toolScene.run = (work) => work.children.tool.invoke(work.input);
const toolResources = new Resources().register(new Resource(exchanges), ModelExchangeResource).register(new Resource({ exchanges, channel: interactions.bind(modelContract) }), ToolModelResource);
const toolRunner = new Runner(toolScene, toolResources, interactions).build();
assert.equal(exchanges.sequence, 0);
assert.equal(modelRequests.length, 0);
assert.equal(await toolRunner.run({ request: { messages: [{ role: 'user', content: 'Translate hello' }] } }), 'translated:hello');
assert.equal(toolExecutions, 1);
assert.equal(modelRequests.length, 2);
assert.deepEqual(
  modelRequests[0].tools.map((item) => item.name),
  ['lookup'],
);
assert.deepEqual(modelRequests[1].exchanges[0].feedback, [{ toolCallId: 'lookup-1', status: 'ok', content: [{ kind: 'text', text: 'translated:hello' }] }]);
assert.equal(exchanges.snapshot().origins.length, 1);
assert.equal(exchanges.snapshot().entries.length, 2);
await interactions.settled();
interactions.close();
// Typed domain facts cross the installed resource/invocation boundary without a domain union.
const sampleFacts = new FactType('sample');
const delivered = [];
const sample = new ResourceOffer({
  methods: {
    read(_origin, input, operation) {
      publishFact({ input }, undefined, operation.facts(sampleFacts));
      return input;
    },
  },
});
const sampleScene = new Scene({ deps: { sample: sample.request() }, run: (work) => work.resources.sample.read(work.input) });
const sampleRunner = new Runner(sampleScene, new Resources().register(new Resource(null), sample), undefined, {
  observations: [
    {
      failure: 'propagate',
      bindInvocation: () => ({
        observe() {},
        fact(envelope) {
          sampleFacts.match(envelope.fact, (body) => delivered.push(body.input));
        },
      }),
    },
  ],
}).build();
assert.equal(await sampleRunner.run('typed-fact'), 'typed-fact');
assert.deepEqual(delivered, ['typed-fact']);

// Default content recording uses the same producer token as the standalone entity package.
const transcript = new Transcript();
const recorder = new Recorder(new RecordBook());
const transcriptScene = new Scene({ deps: { messages: TranscriptResource.append.request() }, run: (work) => work.resources.messages.append([{ role: 'user', content: work.input }]) });
const transcriptRunner = new Runner(transcriptScene, new Resources().register(new Resource(transcript), TranscriptResource.append), undefined, { observations: [runtime.bindRecording(recorder, { failure: 'propagate' })] }).build();
const transcriptResult = await transcriptRunner.run('recorded');
assert.ok([...recorder.book.values()].some((record) => record.kind === 'transcript' && record.contextId));
// Read and validate actual recorded output through the independent data entry.
const transcriptCall = [...recorder.book.values()].find((record) => record.kind === 'invocation' && record.structureKind === 'scene');
assert.ok(transcriptCall);
const recordedSnapshot = JSON.parse(JSON.stringify(CallableRecordHelper.snapshot(recorder, transcriptCall.id)));
validateExecutionRecordSnapshot(recordedSnapshot);
validateInvocationRecordValue(recordedSnapshot.execution.value, transcriptCall.contextId);
assert.ok(Object.hasOwn(recordedSnapshot.execution.value, 'resultOf'));
assert.deepEqual(readOutput(recordedSnapshot.execution.value), transcriptResult);
// The transport admits explicit JSON frames projected from the actual entity.
const transcriptBaseline = { type: 'baseline', snapshot: { id: transcript.id, revision: transcript.revision, start: 0, end: transcript.length, starts: transcript.segments().map((range) => range.start), messages: transcript.snapshot() } };
const admittedTranscript = protocol.acceptTranscriptUpdate(JSON.parse(JSON.stringify(transcriptBaseline)));
assert.deepEqual(admittedTranscript, transcriptBaseline);
assert.ok(Object.isFrozen(admittedTranscript.snapshot.messages[0]));
assert.throws(() => protocol.acceptTranscriptUpdate(recordedSnapshot), TypeError);
assert.equal(
  TranscriptFacts.match(sampleFacts.create({ input: 'other' }), () => assert.fail('wrong producer')),
  false,
);
// Memory is independent of Transcript and preserves author content through installed offers.
const memoryContract = { key: 'release.memory', version: 1 };
const memories = new Memories({ contentContract: memoryContract });
const memoryOffers = memoryResources();
let retainedMemoryReader;
const memoryNode = new Node({
  deps: { read: memoryOffers.read.request(), write: memoryOffers.apply.request() },
  run(work) {
    retainedMemoryReader = work.resources.read;
    const expected = retainedMemoryReader.snapshot().basis;
    const input = { position: 'installed', changes: [{ action: 'create', value: { content: work.input, metadata: { label: 'consumer', tags: ['installed'] } } }] };
    const receipt = work.resources.write.applyFixed(input, expected);
    assert.equal(work.resources.write.applyFixed(input, expected), receipt);
    const item = retainedMemoryReader.read(receipt.changes[0].memoryId);
    assert.equal(item.basis.sequence, 1);
    assert.ok(Object.isFrozen(item.value.metadata.tags));
    return { id: item.id, value: item.value };
  },
});
const memoryScene = new Scene().add({ memory: memoryNode });
memoryScene.run = (work) => work.children.memory.invoke(work.input);
const memorySupply = new Resources().register(new Resource(memories), memoryOffers.read).register(new Resource(memories), memoryOffers.apply);
const memoryRunner = new Runner(memoryScene, memorySupply).build();
const memoryItem = await memoryRunner.run('installed summary');
assert.deepEqual(memoryItem.value, { content: 'installed summary', metadata: { label: 'consumer', tags: ['installed'] } });
assert.equal(memories.sequence, 1);
const savedMemory = memories.exportState();
assert.deepEqual(savedMemory.applies[0].request.command, { position: 'installed', changes: [{ action: 'create', value: memoryItem.value }] });
assert.deepEqual(Object.keys(savedMemory.applies[0].request.operation), ['contextId']);
assert.throws(() => Memories.restore(savedMemory), /content contract/);
assert.deepEqual(Memories.restore(savedMemory, { contentContract: memoryContract }).confirmFixed(savedMemory.applies[0].request), savedMemory.applies[0].receipt);
assert.throws(() => retainedMemoryReader.read(memoryItem.id), ResourceAccessClosed);
const memorySource = new MemoryViewSource(memories, [memoryItem.id]);
const memoryDirectory = memorySource.index();
assert.deepEqual(memoryDirectory.entries, [{ key: memoryItem.id, summary: undefined }]);
assert.deepEqual(memorySource.read([memoryItem.id], memoryDirectory.stamp).entries, [{ key: memoryItem.id, value: memoryItem }]);

// Business update rules stay local; the public adapter supplies the View protocol.
const settings = { version: 0, value: { locale: 'zh', preferences: { tags: ['original'] } } };
const notes = {
  version: 1,
  values: new Map([
    [0, { text: 'first note' }],
    [1, { text: 'unselected note' }],
  ]),
};
let noteReads = 0;
const settingsSource = createViewSource({
  id: 'release.settings',
  scope: 'whole',
  version: () => String(settings.version),
  keys: () => ['settings'],
  inspect(key) {
    if (key !== 'settings') throw new RangeError('Unknown settings key');
    return { locale: settings.value.locale };
  },
  read(key) {
    if (key !== 'settings') throw new RangeError('Unknown settings key');
    return settings.value;
  },
});
const notesSource = createViewSource({
  id: 'release.notes',
  scope: 'whole',
  version: () => String(notes.version),
  keys: () => [...notes.values.keys()],
  inspect(key) {
    if (!notes.values.has(key)) throw new RangeError('Unknown note');
    return { label: `note ${key}` };
  },
  read(key) {
    if (!notes.values.has(key)) throw new RangeError('Unknown note');
    noteReads++;
    return notes.values.get(key);
  },
});
const entitySources = { settings: settingsSource, notes: notesSource, memories: memorySource };
const entityView = new View({
  revision: 0,
  sources: Object.fromEntries(Object.entries(entitySources).map(([slot, source]) => [slot, { id: source.id, scope: source.scope }])),
  members: [
    { source: 'settings', key: 'settings' },
    { source: 'notes', key: 0 },
    { source: 'memories', key: memoryItem.id },
  ],
});
const entityIndex = entityView.indexSync(entitySources);
assert.equal(noteReads, 0, 'indexing selected summaries does not read note bodies');
const entityOffer = new ResourceOffer({ name: 'release.entities', expose: (origin, activity) => openView(origin.view, origin.sources, activity) });
const entityScene = new Scene({ deps: { materials: entityOffer.request() }, run: (work) => work.resources.materials.capture() });
const entityRunner = new Runner(entityScene, new Resources().register(new Resource({ view: entityView, sources: entitySources }), entityOffer)).build();
const entityMaterials = await entityRunner.run(null);
assert.equal(noteReads, 1, 'one selected key does not read all append-only history');
assert.deepEqual(
  entityMaterials.entries.map((entry) => entry.source),
  ['settings', 'notes', 'memories'],
);
assert.deepEqual(entityMaterials.entries[0].value, settings.value);
assert.deepEqual(entityMaterials.entries[1].value, { text: 'first note' });
assert.deepEqual(entityMaterials.entries[2].value, memoryItem);
settings.value.preferences.tags.push('later');
settings.version++;
notes.values.set(2, { text: 'appended later' });
notes.version++;
memories.apply([{ action: 'update', memoryId: memoryItem.id, value: { content: 'updated summary' } }]);
assert.equal(settingsSource.check(entityIndex.basis.sources.settings), false);
assert.equal(notesSource.check(entityIndex.basis.sources.notes), false);
assert.throws(() => settingsSource.read(['settings'], entityIndex.basis.sources.settings), RuntimeError);
await assert.rejects(entityView.capture(entitySources, entityIndex), RuntimeError);
assert.deepEqual(entityMaterials.entries[0].value.preferences.tags, ['original']);
assert.equal(entityMaterials.entries[1].value.text, 'first note');
assert.deepEqual(entityMaterials.entries[2].value, memoryItem);
assert.throws(() => entityMaterials.entries[0].value.preferences.tags.push('rewrite'), TypeError);
const currentEntities = await entityRunner.run(null);
assert.deepEqual(currentEntities.entries[0].value.preferences.tags, ['original', 'later']);
assert.equal(currentEntities.entries[2].value.value.content, 'updated summary');
assert.equal(currentEntities.entries.length, 3, 'appending content does not change View membership');
console.log('CAPiX installed consumer smoke passed (identity, resources, typed facts, invocation events, record data, transcript wire, cold checkpoint restore, offline Tool, standalone Memory, business View adapters)');
