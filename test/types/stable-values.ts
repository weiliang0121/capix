import { stableValue } from '@capix/contracts';
import type { Stable } from '@capix/contracts';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;
type UnknownRemainsUnknown = Assert<Equal<Stable<unknown>, unknown>>;
// Explicit any remains an erased author type; runtime validation is unchanged.
type ExplicitAnyRemainsErased = Assert<Equal<Stable<any>, any>>;
type Tuple = Assert<Equal<Stable<[string, { count: number }]>, readonly [string, { readonly count: number }]>>;
type Union = Assert<Equal<Stable<{ kind: 'one'; value: number[] } | { kind: 'two'; value: string }>, { readonly kind: 'one'; readonly value: readonly number[] } | { readonly kind: 'two'; readonly value: string }>>;

const source = { nested: { count: 1 }, items: [{ text: 'hello' }], optional: undefined as { value: number } | undefined };
const fixed = stableValue(source);
const count: number = fixed.nested.count;
const items: readonly { readonly text: string }[] = fixed.items;
const again: Stable<typeof source> = stableValue<typeof source>(fixed);
const inferredAgain: Stable<typeof source> = stableValue(fixed);
const originalAccepted: Stable<typeof source> = stableValue<typeof source>(source);
// @ts-expect-error stable child records cannot be edited.
fixed.nested.count = 2;
// @ts-expect-error stable arrays cannot append mutable values.
fixed.items.push({ text: 'changed' });
// @ts-expect-error stable nested array values cannot be edited.
fixed.items[0]!.text = 'changed';
// @ts-expect-error stable output cannot promise a mutable array.
const mutableItems: { text: string }[] = fixed.items;
if (fixed.optional) {
  // @ts-expect-error optional branches remain deeply readonly.
  fixed.optional.value = 2;
}
const tuple = stableValue<[string, { count: number }]>(['a', { count: 1 }]);
// @ts-expect-error tuple position cannot be replaced.
tuple[0] = 'b';
// @ts-expect-error tuple nested values remain readonly.
tuple[1].count = 2;
const method = stableValue({
  run() {
    return 1;
  },
});
// @ts-expect-error unsupported function leaf cannot be consumed as a capability.
method.run();
declare const unknown: unknown;
const checked: unknown = stableValue(unknown);
// @ts-expect-error unknown data is not turned into an invented record shape.
const fabricated: { count: number } = stableValue(unknown);

// Stable facts cross public call boundaries, while capability endpoints retain
// their own operational contracts. These functions are compile-only fixtures.
import { Node, Scene, Group, Sequence, Dynamic, checkpointPoint, reception, childReference } from '@capix/structure';
import { Runner, Resources } from '@capix/server-runtime';
import { ResourceOffer } from '@capix/resources';
import type { CheckpointCodec } from '@capix/contracts';
import type { ModelRequest } from '@capix/model-provider';

type Payload = { items: { text: string }[] };
const payloadCodec: CheckpointCodec<Payload> = {
  encode(value) {
    // @ts-expect-error codec consumes an already stable fact.
    value.items.push({ text: 'changed' });
    return { items: value.items.map((item) => ({ text: item.text })) };
  },
  decode() {
    return { items: [] };
  },
};
const leaf = new Node<Payload, Payload>({
  run(work) {
    // @ts-expect-error author input is deeply readonly.
    work.input.items.push({ text: 'changed' });
    return work.input;
  },
});
const intake = reception(leaf, { ...payloadCodec, check: (_value: unknown): Payload => ({ items: [] }) });
const point = checkpointPoint<'group', Payload, Payload>()({
  name: 'accepted',
  state: payloadCodec,
  references: { child: childReference(leaf) },
  check(state, facts) {
    // @ts-expect-error point state is a stable saved value.
    state.items[0]!.text = 'changed';
    // @ts-expect-error historical input remains stable.
    facts.references.child.input.items.push({ text: 'changed' });
    const accepted = facts.children.accepted(facts.references.child.ref, intake);
    // @ts-expect-error a reception contract does not return mutable aliases.
    accepted.items.push({ text: 'changed' });
  },
  resume: { run: (_work, state) => state },
});
const branch = new Group<Payload, Payload>().add({ leaf });
branch.run = async (work) => {
  const call = work.children.create(leaf, work.input);
  const returned = await call.run();
  // @ts-expect-error raw child run delivery is stable before reception.
  returned.items[0]!.text = 'changed';
  const accepted = await call.accept(intake, (value) => value);
  // @ts-expect-error explicit reception delivery remains stable.
  accepted.items.push({ text: 'changed' });
  const selected = await work.children.leaf.invoke(work.input, {
    result: {
      succeeded(value) {
        // @ts-expect-error reception callback consumes a stable child delivery.
        value.items.push({ text: 'changed' });
        return { values: value.items };
      },
    },
  });
  // @ts-expect-error a newly mapped result is stable as well.
  selected.values.push({ text: 'changed' });
  work.checkpoint?.({ point, state: accepted, refs: { child: call.ref } });
  return accepted;
};
const scene = new Scene(branch);
const runner = new Runner(scene, new Resources());
async function consume() {
  const result = await runner.run({ items: [] });
  // @ts-expect-error root delivery is deeply readonly.
  result.items.push({ text: 'changed' });
  const resumed = await runner.resume('context');
  // @ts-expect-error resumed delivery has the same stable contract.
  resumed.items[0]!.text = 'changed';
}
const originOffer = new ResourceOffer({
  methods: {
    take(origin: { count: number }) {
      origin.count++;
      return { mutable: [origin.count] };
    },
  },
});
const resourceConsumer = new Node<void, number, { counter: ReturnType<typeof originOffer.request> extends import('@capix/resources').ResourceRequest<infer Endpoint> ? Endpoint : never }>({
  deps: { counter: originOffer.request() },
  async run(work) {
    const operation = await work.resources.counter.take();
    operation.mutable.push(2); // Resource operations are not automatically stable call facts.
    return operation.mutable.length;
  },
});
// Recursive protocol data remains assignable to its already-readonly contract.
declare const fixedModelRequest: Stable<ModelRequest>;
const modelRequest: ModelRequest = fixedModelRequest;

const sequenceLeaf = new Node<Payload, Payload>({ run: (work) => work.input });
const nextSequenceLeaf = new Node<Payload, Payload>({ run: (work) => work.input });
const sequence = new Sequence([sequenceLeaf, nextSequenceLeaf]);
const sequenceRunner = new Runner(new Scene(sequence), new Resources());
const decision = new Node<Payload, { kind: 'finish'; value: Payload }>({ run: (work) => ({ kind: 'finish', value: { items: [...work.input.items] } }) });
const dynamic = new Dynamic({ options: {}, decide: decision });
const dynamicRunner = new Runner(new Scene(dynamic), new Resources());
async function consumePresets() {
  const sequenced = await sequenceRunner.run({ items: [] });
  // @ts-expect-error Sequence preserves stable composed outputs.
  sequenced.items.push({ text: 'changed' });
  const selected = await dynamicRunner.run({ items: [] });
  // @ts-expect-error Dynamic preserves stable selected outputs.
  selected.items[0]!.text = 'changed';
}

type ReceiptOutcome = { kind: 'kept'; value: Payload } | { kind: 'fallback'; reason: string };
declare const unionReceipt: import('@capix/contracts').ReceptionDefinition<typeof leaf, ReceiptOutcome>;
async function consumeUnion(call: import('@capix/contracts').ChildCall<typeof leaf>) {
  const result = await call.invoke({
    reception: unionReceipt,
    result: {
      succeeded: (value): ReceiptOutcome => ({ kind: 'kept', value: { items: [...value.items] } }),
      failed: (): ReceiptOutcome => ({ kind: 'fallback', reason: 'failed' }),
    },
  });
  if (result.kind === 'kept') {
    const text: string = result.value.items[0]!.text;
    // @ts-expect-error a discriminated reception retains deeply readonly members.
    result.value.items.push({ text: 'changed' });
  } else {
    const reason: string = result.reason;
  }
}

const capturedResources = new Resources();
capturedResources.capture(leaf, (input) => {
  // @ts-expect-error capture observes the fixed input before exposing supplies.
  input.items.push({ text: 'changed' });
  return input;
});
