// Compile with TypeScript in strict NodeNext mode against the installed tarballs.
import { stableValue, type Stable, type CallableInput, type CallableOutput, type CheckpointCodec } from '@weiliang0121/capix-contracts';
import { Resource, ResourceOffer, type ResourceOperation } from '@weiliang0121/capix-resources';
import { receiveOperation, type OperationOptions } from '@weiliang0121/capix-resources/operation';
import { Scene, Group, defineNode, checkpointPoint } from '@weiliang0121/capix-structure';
import { assertStructureConfigurable } from '@weiliang0121/capix-structure/construction';
import { Runner, Resources, type RunnerOutputEvent } from '@weiliang0121/capix-runtime';
import { CallableBuilder, type InvocationCapabilities } from '@weiliang0121/capix-runtime/construction';
import { invocationRecording } from '@weiliang0121/capix-runtime/recording';
import { z } from 'zod';
import { Tool, type ToolMember } from '@weiliang0121/capix-tool';
import { MemoryCheckpointStore } from '@weiliang0121/capix-checkpoint';

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
