import { Dynamic, Group, Node, Scene, Sequence, type CallableContract, type CallableDelta, type CallableInput, type CallableOutput } from '@capix/structure';
import { ResourceOffer } from '@capix/resources';
import { Resources, Runner } from '@capix/server-runtime';

declare function expectType<Value>(value: Value): void;

const child = new Node<string, { length: number }>({ run: (work) => ({ length: work.input.length }) });
const scene = new Scene(child);
expectType<Scene<string, { length: number }>>(scene);
expectType<string>(null! as CallableInput<typeof scene>);
expectType<{ length: number }>(null! as CallableOutput<typeof scene>);
expectType<Promise<{ length: number }>>(new Runner(scene, new Resources()).build().run('hello'));
// @ts-expect-error inferred input is precise, not any or unknown
new Runner(scene, new Resources()).build().run(123);
// @ts-expect-error inferred final output remains the child output
expectType<string>(null! as CallableOutput<typeof scene>);
scene.run = (work) => ({ length: work.input.length + 1 });
// @ts-expect-error replacement processing must preserve the established result contract
scene.run = () => 123;

const other = new Node<number, boolean>();
scene.add({ other });
expectType<Scene<string, { length: number }>>(scene);
const configured = new Scene({ run: () => 42 });
expectType<Scene<unknown, number>>(configured);
const configuredExplicitly = new Scene<string, number>({ run: (work) => work.input.length });
expectType<Scene<string, number>>(configuredExplicitly);
expectType<Scene<unknown, unknown>>(new Scene());

const group = new Group<{ id: number }, boolean>();
expectType<Scene<{ id: number }, boolean>>(new Scene(group));
const pipeline = new Sequence([new Node<string, number>(), new Node<number, boolean>()]);
expectType<Scene<string, boolean>>(new Scene(pipeline));
const dynamic = new Dynamic({ options: {}, decide: new Node<{ query: string }, { kind: 'finish'; value: number }>() });
expectType<Scene<{ query: string }, number>>(new Scene(dynamic));

const offer = new ResourceOffer({ methods: { read: (origin: string) => origin } });
const resourceChild = new Node<string, string, { dictionary: { read(): Promise<string> } }, string>({ deps: { dictionary: offer.request() }, output: { result: String, delta: String }, run: (work) => work.resources.dictionary.read() });
const plainRoot = new Scene(resourceChild);
expectType<never>(null! as CallableDelta<typeof plainRoot>);
plainRoot.run = (work) => {
  // @ts-expect-error a child's deps do not grant the delegating root resource access
  work.resources.dictionary;
  // @ts-expect-error a child's Delta is not promoted to the delegating root
  work.output;
  return work.children.invoke(resourceChild, work.input);
};

declare const ambiguous: Node<string, string> | Node<number, string>;
// @ts-expect-error one root input cannot guess an unresolved heterogeneous child's input
new Scene(ambiguous);
declare const sameInput: Node<string, number> | Group<string, number>;
expectType<Scene<string, number>>(new Scene(sameInput));
// A heterogeneous output union can state its common boundary explicitly.
declare const differentOutput: Node<string, number> | Group<string, boolean>;
expectType<Scene<string, number | boolean>>(new Scene<string, number | boolean>(differentOutput));
// @ts-expect-error a Scene cannot be delegated to as a child
new Scene(new Scene<string, number>());
declare const contractOnly: CallableContract<'node', string, number>;
// @ts-expect-error registering requires the real reusable structure, not a signature-only object
new Scene(contractOnly);
// @ts-expect-error an explicit root input cannot contradict its delegate
new Scene<number, { length: number }>(child);
// @ts-expect-error an explicit root output cannot contradict its delegate
new Scene<string, boolean>(child);
