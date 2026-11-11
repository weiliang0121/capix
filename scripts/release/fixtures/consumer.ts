// Compile with TypeScript in strict NodeNext mode against the installed tarballs.
import { stableValue, type Stable, type CallableInput, type CallableOutput, type CheckpointCodec, type InvocationRelationIdentity as ContractRelationIdentity } from '@weiliang0121/capix-contracts';
import { invocationProcessStages as rootProcessStages, type InvocationRelationIdentity } from '@weiliang0121/capix-invocation';
import { invocationProcessStages, type InvocationEvent, type InvocationProcessStage } from '@weiliang0121/capix-invocation/events';
import { Transcript, type Message, type TranscriptSnapshot } from '@weiliang0121/capix-transcript';
import { readOutput, validateExecutionRecordSnapshot, type CallableRecord, type ExecutionRecordSnapshot, type RelationChangeRecord } from '@weiliang0121/capix-records/data';
import * as protocol from '@weiliang0121/capix-protocol';
import { Resource, ResourceOffer, type ResourceOperation } from '@weiliang0121/capix-resources';
import { receiveOperation, type OperationOptions } from '@weiliang0121/capix-resources/operation';
import { Scene, Group, defineNode, checkpointPoint } from '@weiliang0121/capix-structure';
import { assertStructureConfigurable } from '@weiliang0121/capix-structure/construction';
import { Runner, Resources, type RunnerOutputEvent } from '@weiliang0121/capix-runtime';
import { CallableBuilder, type InvocationCapabilities } from '@weiliang0121/capix-runtime/construction';
import { invocationRecording } from '@weiliang0121/capix-runtime/recording';
import { z } from 'zod';
import { Tool, type ToolMember } from '@weiliang0121/capix-tool';
import { FactType } from '@weiliang0121/capix-changes';
import type { ResourceEventConsumer } from '@weiliang0121/capix-resources';
import { MemoryCheckpointStore } from '@weiliang0121/capix-checkpoint';
import * as memory from '@weiliang0121/capix-memory';

const dictionary = new ResourceOffer({
  methods: {
    translate(origin: { prefix: string }, word: string, operation: ResourceOperation<string>) {
      operation.emit(word);
      return `${origin.prefix}${word}`;
    },
  },
});
const leaf = defineNode<string, string>()({
  deps: { dictionary: dictionary.request() },
  output: { result: String, delta: String },
  run(work) {
    return work.resources.dictionary.translate(work.input, { delta: (part) => work.output.emit(part) });
  },
});
const group = new Group<string, string>().add({ translate: leaf });
group.run = (work) => work.children.translate.invoke(work.input);
const scene = new Scene<string, string>().add({ group });
scene.run = (work) => work.children.group.invoke(work.input);
const resources = new Resources().register(new Resource({ prefix: 'typed:' }), dictionary);
const runner = new Runner(scene, resources).build();
const input: CallableInput<typeof scene> = 'hello';
const result: Promise<Stable<CallableOutput<typeof scene>>> = runner.run(input);
runner.output.subscribe({
  receive(event: RunnerOutputEvent<string, never>) {
    if (event.kind === 'completed') event.result satisfies string;
  },
});

const textCodec: CheckpointCodec<string> = {
  encode: (value) => value,
  decode(value) {
    if (typeof value !== 'string') throw new Error('Expected text');
    return value;
  },
};
const point = checkpointPoint<'scene', string, string>()({ name: 'saved', state: textCodec, references: {}, resume: { run: (work, state) => `${work.input}:${state}` } });
const checkpointScene = new Scene<string, string>({
  checkpoint: { key: 'release.typed', version: 1, input: textCodec, output: textCodec, points: [point] },
  run(work) {
    if (!work.checkpoint) throw new Error('Checkpoint capability required');
    work.checkpoint({ point, state: work.input, refs: {} });
    return work.input;
  },
});
const store = new MemoryCheckpointStore();
const capabilities: InvocationCapabilities = { checkpoints: { store } };
assertStructureConfigurable(checkpointScene);
const builder = new CallableBuilder(capabilities);
const recording = invocationRecording<string, string>({ role: 'consumer' });
const options: OperationOptions<number, unknown, string> = { result: { succeeded: (value) => String(value) } };
const received: Promise<string> = receiveOperation({ status: 'succeeded', value: 1 }, { result: { succeeded: (value: number) => String(value) } });
const fixed: Stable<{ values: string[] }> = stableValue({ values: ['fixed'] });

// These errors must be detected through published declarations, even when a
// consumer does not compile any of the framework's source files.
if (false) {
  // @ts-expect-error run input remains string through the packaged declarations
  runner.run(42);
  // @ts-expect-error structure instances cannot accept a Scene as a child
  group.add(scene);
  // @ts-expect-error Stable arrays are readonly
  fixed.values.push('mutate');
}
void [result, builder, recording, options, received];

// Public preset declarations retain each member's input and readonly output.
const inlineLookup = defineNode<{ key: string }, { values: string[] }>()({ run: (work) => ({ values: [work.input.key] }) });
const inlineTool = new Tool({
  policyVersion: 'release.inline.v1',
  tools: {
    lookup: {
      node: inlineLookup,
      description: 'Read local values',
      input: z.strictObject({ key: z.string() }),
      result: {
        succeeded: (value) => {
          const text: string = value.values[0]!;
          // @ts-expect-error Tool mapping receives deeply readonly Stable output
          value.values.push('mutate');
          return { status: 'ok', content: [{ kind: 'text', text }] };
        },
      },
    },
  },
});
const hoistedLookup = defineNode<{ key: string }, { text: string }>()({ run: (work) => ({ text: work.input.key }) });
const hoistedMember = {
  node: hoistedLookup,
  description: 'Read a local word',
  input: z.strictObject({ key: z.string() }),
  result: { succeeded: (value) => ({ status: 'ok', content: [{ kind: 'text', text: value.text }] }) },
} satisfies ToolMember<typeof hoistedLookup>;
const hoistedTool = new Tool({ policyVersion: 'release.hoisted.v1', tools: { lookup: hoistedMember } });
const toolScene = new Scene<CallableInput<typeof inlineTool>, string>().add({ tool: inlineTool });
toolScene.run = (work) => work.children.tool.invoke(work.input);
const toolResult: Promise<string> = new Runner(toolScene, new Resources()).build().run({ request: { messages: [{ role: 'user', content: 'hello' }] } });
if (false) {
  // @ts-expect-error Tool input schema must match its registered Node input
  new Tool({ policyVersion: 'invalid', tools: { lookup: { ...hoistedMember, input: z.number() } } });
  // @ts-expect-error Tool mapping output must use the native ToolResult contract
  new Tool({ policyVersion: 'invalid', tools: { lookup: { ...hoistedMember, result: { succeeded: () => 'raw' } } } });
  // @ts-expect-error Tool remains a Group and cannot replace Runner's Scene
  new Runner(hoistedTool, new Resources());
}
void [hoistedTool, toolResult];

const counterFacts = new FactType<{ count: number }>('counter');
declare const factOperation: ResourceOperation;
const counterPublisher = factOperation.facts(counterFacts);
counterPublisher?.publish({ count: 1 });
counterFacts.match(counterFacts.create({ count: 2 }), (event) => {
  const count: number = event.count;
  // @ts-expect-error domain fact bodies are stable values
  event.count = 3;
  void count;
});
if (false) {
  // @ts-expect-error exact fact type cannot publish a different body
  counterPublisher?.publish({ text: 'wrong' });
  // @ts-expect-error typed publishers cannot be widened to bypass the fact type
  const widened: ResourceEventConsumer<{ count: number } | { text: string }> | undefined = counterPublisher;
  void widened;
}

// Standalone memory metadata remains typed through installed entity/resource declarations.
type MemoryMetadata = { label: string; tags: string[] };
const memoryCollection = new memory.Memories<MemoryMetadata>({ contentContract: { key: 'release.memory', version: 1 } });
const memoryOffers = memory.memoryResources<MemoryMetadata>();
const memoryNode = defineNode<string, string>()({
  deps: { read: memoryOffers.read.request(), write: memoryOffers.apply.request() },
  run(work) {
    const application = work.resources.write.apply([{ action: 'create', value: { content: work.input, metadata: { label: 'typed', tags: ['installed'] } } }], work.resources.read.snapshot().basis);
    const item = work.resources.read.read(application.changed[0]!.id)!;
    const label: string = item.value.metadata!.label;
    return `${label}:${item.value.content}`;
  },
});
const memoryScene = new Scene<string, string>().add({ memory: memoryNode });
memoryScene.run = (work) => work.children.memory.invoke(work.input);
const memoryResources = new Resources().register(new Resource(memoryCollection), memoryOffers.read).register(new Resource(memoryCollection), memoryOffers.apply);
const memoryResult: Promise<string> = new Runner(memoryScene, memoryResources).build().run('summary');
const memorySource = new memory.MemoryViewSource(memoryCollection);
const memorySnapshot = memorySource.read([], memorySource.index().stamp);
if (false) {
  // @ts-expect-error removed live item API is not exported
  memory.Memory;
  // @ts-expect-error removed singleton offers cannot erase the metadata contract
  memory.MemoryResource;
  // @ts-expect-error author metadata must match its declared contract
  memoryCollection.apply([{ action: 'create', value: { content: 'summary', metadata: { label: 42, tags: [] } } }]);
  // @ts-expect-error an untyped offer cannot erase a typed collection's metadata
  new Resources().register(new Resource(memoryCollection), memory.memoryResources().read);
  // @ts-expect-error fixed View metadata is deeply readonly
  memorySnapshot.entries[0]!.value.value.metadata!.tags.push('change');
  const event = {} as memory.MemoryEvent<MemoryMetadata>;
  // @ts-expect-error domain event metadata is deeply readonly
  event.change.value.metadata!.tags.push('change');
}
void memoryResult;

const exactMemoryRequest: memory.MemoryFixedApply<MemoryMetadata> = {
  contract: { key: 'memories.apply', version: 2 },
  contentContract: memoryCollection.contentContract,
  memoriesId: memoryCollection.id,
  operation: { contextId: 'installed-consumer' },
  command: { position: 'typed', changes: [] },
};
if (false) memoryCollection.confirmFixed(exactMemoryRequest);

// Entity declarations, record data, live events, and wire frames retain their separate owners.
const domainMessage: Message = { role: 'assistant', content: 'typed transcript' };
const wireMessage: protocol.TranscriptWireMessage = domainMessage;
const transcript = new Transcript([domainMessage]);
const domainSnapshot: TranscriptSnapshot = { id: transcript.id, revision: transcript.revision, start: 0, end: transcript.length, starts: transcript.segments().map((range) => range.start), messages: transcript.snapshot() };
const wireFrame: protocol.TranscriptFrame = { type: 'baseline', snapshot: domainSnapshot };
const wireUpdate: Stable<protocol.TranscriptUpdate> = protocol.acceptTranscriptUpdate(JSON.parse(JSON.stringify(wireFrame)));
const stage: InvocationProcessStage = invocationProcessStages[0];
const rootStages: typeof invocationProcessStages = rootProcessStages;
const sharedIdentity: ContractRelationIdentity = { parentContextId: 'parent', childContextId: 'child', parentRound: 1, key: 'member' };
const liveIdentity: InvocationRelationIdentity = sharedIdentity;
const relation: RelationChangeRecord = { identity: liveIdentity, eventSequence: 1, occurredAt: '2026-11-11T00:00:00.000Z', offsetMs: 0, change: { kind: 'attached' } };
const event: InvocationEvent = { type: 'invocation', contextId: sharedIdentity.parentContextId, kind: 'scene', sequence: 1, occurredAt: relation.occurredAt, change: { kind: 'relation', identity: relation.identity, phase: 'attached' } };
type RelationEvent = Extract<InvocationEvent['change'], { kind: 'relation' }>;
type Equal<Left, Right> = (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2 ? true : false;
const sharedRelationIdentity: Equal<ContractRelationIdentity, InvocationRelationIdentity> = true;
const recordedRelationIdentity: Equal<ContractRelationIdentity, RelationChangeRecord['identity']> = true;
const eventRelationIdentity: Equal<ContractRelationIdentity, RelationEvent['identity']> = true;
declare const recordedCall: CallableRecord<string, string>;
declare const recordedSnapshot: ExecutionRecordSnapshot;
const recordedOutput: string | undefined = readOutput(recordedCall.value);
validateExecutionRecordSnapshot(recordedSnapshot);
if (false) {
  // @ts-expect-error entity Message is no longer a protocol-owned domain type
  type ProtocolMessage = protocol.Message;
  // @ts-expect-error record data is owned by records/data, not protocol
  type ProtocolRecord = protocol.RecordEntry;
  // @ts-expect-error service conversation DTOs are no longer framework wire exports
  type ProtocolConversation = protocol.ConversationDescriptor;
  // @ts-expect-error record output rules are provided by records/data
  protocol.readOutput(recordedCall.value);
}
void [wireMessage, wireUpdate, stage, rootStages, event, sharedRelationIdentity, recordedRelationIdentity, eventRelationIdentity, recordedOutput];
