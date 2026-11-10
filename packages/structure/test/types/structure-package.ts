import { Scene, Group, Node, defineNode, checkpointPoint, childReference, reception, type CheckpointCodec, type ChildReference, type CallableInput, type CallableOutput, type InvocationOutputReceiver, type BusinessEvent } from '@weiliang0121/capix-structure';
import { ResourceOffer, type ResourceOperation } from '@weiliang0121/capix-resources';

declare function expectType<Value>(value: Value): void;
declare const textCodec: CheckpointCodec<string>;
declare const numberCodec: CheckpointCodec<number>;
const dictionary = new ResourceOffer({
  methods: {
    translate(origin: Map<string, string>, word: string, operation: ResourceOperation<string>) {
      operation.emit(word);
      return origin.get(word) ?? word;
    },
  },
});
const leaf = defineNode<string, string>()({
  deps: { dictionary: dictionary.request() },
  output: { result: (value: unknown) => String(value), delta: (value: unknown) => String(value) },
  run(work) {
    expectType<string>(work.input);
    // @ts-expect-error only explicitly requested resources are visible
    work.resources.other;
    // @ts-expect-error resource argument remains string
    work.resources.dictionary.translate(1);
    // @ts-expect-error leaf has no child operations
    work.children;
    const event: BusinessEvent = { event: 'translation', word: work.input };
    work.observation(event);
    return work.resources.dictionary.translate(work.input, { delta: (part) => work.output.emit(part) });
  },
});
const group = new Group<string, string, {}, string>().add({ translate: leaf });
group.run = (work) => {
  // @ts-expect-error registration does not make child deps accessible to the parent
  work.resources.dictionary;
  // @ts-expect-error named child input keeps its declared type
  work.children.translate.invoke(42);
  // @ts-expect-error no undeclared named child
  work.children.unknown;
  return work.children.translate.invoke(work.input, {
    delta: (part) => {
      expectType<string>(part);
      work.output.emit(part);
    },
  });
};
const scene = new Scene<string, string>().add({ group });
scene.run = (work) => work.children.group.invoke(work.input);
expectType<string>('hello' satisfies CallableInput<typeof scene>);
expectType<string>('你好' satisfies CallableOutput<typeof scene>);
// @ts-expect-error Scene cannot become a child
group.add(scene);
// @ts-expect-error Node has no member registration operation
leaf.add(group);
// @ts-expect-error the node's Delta is string
leaf.output = { result: String, delta: () => 1 };
const receiver: InvocationOutputReceiver<string, string> = {
  receive(event) {
    if (event.kind === 'delta') expectType<string>(event.delta);
    if (event.kind === 'completed') expectType<string>(event.result);
    return undefined;
  },
};
void receiver;

const length = reception(leaf, {
  check(value: unknown): number {
    if (typeof value !== 'number') throw new Error('number required');
    return value;
  },
  encode: (value) => value,
  decode: (value) => {
    if (typeof value !== 'number') throw new Error('number required');
    return value;
  },
});
const wrongLeaf = new Node<number, string>();
declare const wrongRef: ChildReference<typeof wrongLeaf>;
const waiting = checkpointPoint<'group', string, string, string>()({
  name: 'waiting',
  state: numberCodec,
  references: { pending: childReference(leaf) },
  resume: {
    uses: [leaf],
    deps: { dictionary: dictionary.request() },
    run(work, state, saved) {
      expectType<number>(state);
      expectType<ChildReference<typeof leaf>>(saved.pending);
      expectType<Promise<string>>(work.resources.dictionary.translate(work.input));
      // @ts-expect-error resume must respect the registered child's signature
      work.children.resume(wrongRef);
      return work.children.resume(saved.pending).invoke();
    },
  },
});
group.checkpoint = { key: 'structure-package', version: 1, input: textCodec, output: textCodec, points: [waiting], receptions: [length] };
group.run = async (work) => {
  const call = work.children.create(leaf, work.input);
  work.checkpoint?.({ point: waiting, state: 1, refs: { pending: call.ref } });
  // @ts-expect-error checkpoint state does not widen from the provided value
  work.checkpoint?.({ point: waiting, state: 'wrong', refs: { pending: call.ref } });
  // @ts-expect-error saved child reference must keep its signature
  work.checkpoint?.({ point: waiting, state: 1, refs: { pending: wrongRef } });
  const result = await call.invoke({ reception: length, result: { succeeded: (value) => value.length } });
  expectType<number>(result);
  // @ts-expect-error reception fixes the callback's accepted value
  call.invoke({ reception: length, result: { succeeded: (value) => value } });
  return String(result);
};
// @ts-expect-error checkpoint owner position remains exact across package exports
scene.checkpoint = { key: 'wrong-owner', version: 1, input: textCodec, output: textCodec, points: [waiting] };
