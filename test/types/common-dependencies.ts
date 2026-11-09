import { ResourceOffer } from '@weiliang0121/capix-resources';
import { withDependencies, checkpointPoint, Node, type CallableInput, type CallableOutput, type CallableDelta } from '@weiliang0121/capix-structure';

declare function expectType<Value>(value: Value): void;
const flow = new ResourceOffer({
  methods: {
    read(origin: { value: number }) {
      return origin.value;
    },
  },
});
const files = new ResourceOffer({
  methods: {
    read(origin: Map<string, string>, path: string) {
      return origin.get(path) ?? '';
    },
  },
});
const scoped = withDependencies({ flow: flow.request() });
const child = scoped.node<string, string>()({
  deps: { file: files.request() },
  output: { result: String, delta: (value: unknown) => String(value) },
  async run(work) {
    expectType<string>(work.input);
    expectType<number>(await work.resources.flow.read());
    expectType<string>(await work.resources.file.read(work.input));
    work.output.emit('preview');
    // @ts-expect-error common resources preserve their actual output type
    expectType<string>(await work.resources.flow.read());
    // @ts-expect-error local resource arguments retain their input type
    work.resources.file.read(123);
    // @ts-expect-error undeclared resources do not appear in Work
    work.resources.other.read();
    // @ts-expect-error output delta remains anchored to the declaration
    work.output.emit(123);
    return work.resources.file.read(work.input);
  },
});
expectType<string>(null! as CallableInput<typeof child>);
expectType<string>(null! as CallableOutput<typeof child>);
expectType<string>(null! as CallableDelta<typeof child>);

const group = scoped.group<string, string>()({
  members: [child],
  async run(work) {
    expectType<number>(await work.resources.flow.read());
    work.children.create(child, work.input);
    // @ts-expect-error member input is preserved through the scoped factory
    work.children.create(child, 123);
    // @ts-expect-error a child's local resource is not granted to its parent
    work.resources.file.read('path');
    return work.children.invoke(child, work.input, {
      delta: (value) => {
        expectType<string>(value);
      },
    });
  },
});
scoped.scene<string, string>()({ members: [group], run: (work) => work.children.create(group, work.input).invoke() });
scoped.node<void, number>()({ run: (work) => work.resources.flow.read() });
scoped.node<void, number>()({
  // @ts-expect-error common aliases may not be declared again, even with the same offer
  deps: { flow: flow.request() },
  run: () => 1,
});
const duplicate = { flow: flow.request(), file: files.request() };
scoped.node<void, number>()({
  // @ts-expect-error duplicate rejection also applies to a previously assigned dependencies object
  deps: duplicate,
  run: () => 1,
});
scoped.node<void, number>()({
  // @ts-expect-error node configuration cannot register children
  members: [child],
  run: () => 1,
});
const outsider = new Node<string, string>();
scoped.group<string, string>()({
  members: [child],
  run(work) {
    // @ts-expect-error a structurally different unregistered child cannot be inferred into the allowed set
    return work.children.create(new Node<number, number>(), 1).invoke();
  },
});
void outsider;

const point = checkpointPoint<'node', string, number>()({
  name: 'saved',
  state: { encode: (value: number) => value, decode: (value: unknown) => Number(value) },
  references: {},
  resume: {
    run(work, state) {
      // @ts-expect-error common normal-run requests do not implicitly authorize a checkpoint resume window
      work.resources.flow.read();
      return state;
    },
  },
});
scoped.node<string, number>()({
  checkpoint: { key: 'common-deps-test', version: 1, input: { encode: String, decode: String }, output: { encode: Number, decode: Number }, points: [point] },
  run: (work) => work.resources.flow.read(),
});
