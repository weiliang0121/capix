import { Runner, Resources, type BuiltCallable } from '@weiliang0121/capix-runtime';
import { Group, Node, Scene, checkpointPoint, childReference, reception, type ChildReference, type CallableInput, type CallableOutput, type CallableDelta, type CheckpointCodec } from '@weiliang0121/capix-structure';
declare function expectType<Value>(value: Value): void;
interface Input {
  readonly path: string;
}
interface Result {
  readonly text: string;
}
const read = new Node<Input, Result>();
const group = new Group<Input, Result>().add({ read });
const scene = new Scene<Input, Result>().add({ group });
declare const numberCodec: CheckpointCodec<number>;
const value = reception(read, {
  check(candidate: unknown): number {
    if (typeof candidate !== 'number') throw new Error('number');
    return candidate;
  },
  encode: (candidate) => candidate,
  decode(candidate) {
    if (typeof candidate !== 'number') throw new Error('number');
    return candidate;
  },
});
const streamed = new Node<Input, Result, {}, string>();
const runner = new Runner(scene, new Resources());
expectType<Promise<Result>>(runner.run({ path: 'notes.md' }));
// @ts-expect-error root caller input remains exact
runner.run(123);
// @ts-expect-error root output cannot be widened by expected result
const wrong: Promise<number> = runner.run({ path: 'notes.md' });
// The installed facet keeps the same structure's signature.
declare const builtRead: BuiltCallable<typeof read, { tenantId: string }>;
declare const originalRef: ChildReference<typeof read>;
declare const builtRef: ChildReference<typeof builtRead>;
expectType<typeof read>(builtRead);
expectType<Input>({ path: 'notes.md' } satisfies CallableInput<typeof builtRead>);
expectType<Result>({ text: 'read' } satisfies CallableOutput<typeof builtRead>);
group.run = async (work) => {
  const fromOriginal = work.children.create(read, work.input);
  const fromBuilt = work.children.create(builtRead, work.input);
  expectType<number>(await fromOriginal.invoke({ reception: value, result: { succeeded: (result) => result.text.length } }));
  expectType<number>(await fromBuilt.invoke({ reception: value, result: { succeeded: (result) => result.text.length } }));
  expectType<number>(work.children.facts.accepted(originalRef, value));
  expectType<number>(work.children.facts.accepted(builtRef, value));
  // @ts-expect-error build facet does not weaken reception contract
  fromBuilt.invoke({ reception: value, result: { succeeded: (result) => result.text } });
  // @ts-expect-error build facet does not change input
  work.children.create(builtRead, { path: 42 });
  return { text: '' };
};
const differentInput = new Node<number, Result>();
const narrowerInput = new Node<{ path: 'exact.md' }, Result>();
const differentOutput = new Node<Input, number>();
const differentKind = new Group<Input, Result>();
const differentDelta = new Node<Input, Result, {}, string>();
checkpointPoint<'group', Input, Result>()({
  name: 'boundary',
  state: numberCodec,
  references: { input: childReference(differentInput), narrow: childReference(narrowerInput), output: childReference(differentOutput), kind: childReference(differentKind), delta: childReference(differentDelta) },
  resume: {
    uses: [builtRead],
    run(work, _state, saved) {
      // @ts-expect-error input mismatch
      work.children.resume(saved.input);
      // @ts-expect-error narrower input cannot substitute
      work.children.resume(saved.narrow);
      // @ts-expect-error output mismatch
      work.children.resume(saved.output);
      // @ts-expect-error kind mismatch
      work.children.resume(saved.kind);
      // @ts-expect-error delta mismatch
      work.children.resume(saved.delta);
      return { text: '' };
    },
  },
});
declare const builtStreamed: BuiltCallable<typeof streamed, { tenantId: string }>;
const streamingOwner = new Group<Input, Result, {}, string>().add({ streamed });
streamingOwner.run = (work) =>
  work.children.streamed.invoke(work.input, {
    delta(value) {
      expectType<CallableDelta<typeof builtStreamed>>(value);
      work.output.emit(value);
      // @ts-expect-error streamed delta cannot be number
      expectType<number>(value);
    },
  });
void wrong;
