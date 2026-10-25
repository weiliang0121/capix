import { Sequence, InvocationEntry, defineGroup, defineScene, Group, type Node, type ChildCalls, type GroupWork, type SceneWork, Driver, Scene } from '@capix/server-runtime';
import { bindChildResources } from '@capix/server-runtime';
import { type ResourceRefinement } from '@capix/resources';

const bounded = new ResourceOffer<{ readonly allowed: readonly string[] }, readonly string[], string>({ name: 'bounded', expose: (source) => source.allowed, timing: 'access', refine: (source, selected) => ({ allowed: source.allowed.filter((value) => value === selected) }) });
declare const fileOperation: Group<{ readonly path: string }, string>;
bindChildResources(fileOperation, [bounded.refine<{ readonly path: string }>((input) => input.path)]);
// @ts-expect-error only a resource offer can issue the nominal refinement contract
const forgedRefinement: ResourceRefinement<{ readonly path: string }> = { offer: bounded.request().offer };
void forgedRefinement;
const issuedRefinement = bounded.refine<{ readonly path: string }>((input) => input.path);
// @ts-expect-error resource validation cannot be replaced with arbitrary capture logic
issuedRefinement.apply = () => ({ allowed: ['outside'] });
// @ts-expect-error binding input must match the selected definition's input
bindChildResources(fileOperation, [bounded.refine<number>((input) => String(input))]);
// @ts-expect-error selection must use the contract defined by the resource
bounded.refine<{ readonly path: string }>(() => 42);
declare const fileExecution: Group<{ readonly path: string }, string>;
// Any member binding can explicitly refine its subtree supply.
bindChildResources(fileExecution, [bounded.refine<{ readonly path: string }>((input) => input.path)]);

declare const length: Group<string, number>;
declare const format: Group<number, string>;
declare const leaf: Node<string, string>;
declare const execution: Group<string, number>;
declare const parent: GroupWork<string, number, {}, typeof length | typeof format>;
declare const operation: GroupWork<string, string, {}, typeof leaf>;
declare const runtimeWork: SceneWork<string, number, {}, typeof execution>;
declare const children: ChildCalls;

const sequence = new Sequence<string>().step('length', { use: length, input: ({ input }) => input }).step('format', { use: format, input: ({ outputs }) => outputs.length, result: { succeeded: (value, _scope) => ({ text: value }) } });
const result: Promise<Readonly<{ length: number; format: { text: string } }>> = sequence.run('hello', children);
void result;
new Sequence<string>().step('bad', {
  use: length,
  // @ts-expect-error input must match the declared input
  input: () => 123,
});
new Sequence<string>().step('first', {
  use: length,
  // @ts-expect-error a later output is unavailable before its step
  input: ({ outputs }) => outputs.future,
});
// @ts-expect-error composition positions must be unique
sequence.step('length', { use: length, input: () => 'again' });
// @ts-expect-error A cannot be a direct child of this E grant
parent.children.create(leaf, 'hello');
// @ts-expect-error a definition has no runtime call entry
length.create(parent, 'hello');
// @ts-expect-error the selected declaration retains its input
children.create(length, 123);
const alternative = new InvocationEntry(leaf, ({ input }: { input: number }) => String(input));
const alternativeOutput: Promise<string> = operation.children.entry(alternative, 1).run();
void alternativeOutput;
// @ts-expect-error alternative entry enforces its own input contract
operation.children.entry(alternative, 'wrong');

const lengthCall = children.create(length, 'hello');
const acceptedLength: Promise<{ text: string }> = lengthCall.accept((delivered) => ({ text: delivered.toFixed() }));
void acceptedLength;
// @ts-expect-error the child's output determines the delivered type, not the callback
lengthCall.accept((delivered: string) => delivered.length);
lengthCall.accept((delivered) => {
  // @ts-expect-error successful length delivery is a number
  const text: string = delivered;
  return text;
});
// @ts-expect-error an author Work is not a child reference
children.open(parent);
const acceptedAlternative: Promise<number> = operation.children.entry(alternative, 1).accept((delivered) => delivered.length);
void acceptedAlternative;

// @ts-expect-error raw object syntax has no checked declaration signature; use the factory or a named class
const rawDefinition: Group<string, number> = { kind: 'group', name: 'raw', label: 'raw', source: 'test', members: [], deps: {}, run: (work) => work.input.length };
void rawDefinition;
const objectDefinition: Group<string, number> = defineGroup<string, number>()({
  name: 'length',
  label: 'length',
  source: 'test',
  members: [],

  deps: {},
  run: (work) => work.input.length,
});
const objectOutput: Promise<Readonly<{ length: number }>> = new Sequence<string>().step('length', { use: objectDefinition, input: ({ input }) => input }).run('hello', children);
void objectOutput;
const runtimeDefinition: Scene<string, number> = defineScene<string, number>()({
  members: [execution],

  deps: {},
  async run(work) {
    const child = work.children.create(execution, work.input);
    await child.run();
    return child.accept();
  },
});
const driver = new Driver();
const bound = driver.build(runtimeDefinition, { providers: [], source: { capture: (_input, _options: { signal?: AbortSignal }) => null } });
const rootOutput: Promise<number> = driver.run(bound, 'input', {});
void rootOutput;
// @ts-expect-error R input retains its own declared contract
driver.run(bound, 42, {});
// A Scene can directly register a Node.
const leafScene = new Scene<string, number>({ run: (work) => work.input.length });
leafScene.add(leaf);
driver.build(leafScene, { providers: [], source: { capture: () => null } });
// Structurally equal signatures are permitted; binding still checks exact identity.
runtimeWork.children.create(length, 'input');
// @ts-expect-error E cannot be a direct child of O
operation.children.create(execution, 'input');
// @ts-expect-error E input retains its concrete type
runtimeWork.children.create(execution, 42);
// @ts-expect-error content cannot mutate its lifecycle
parent.complete('done');
// @ts-expect-error child facts do not publish reception mutation
parent.children.facts.values()[0]?.accept(() => null);

import { type CallableRun } from '@capix/server-runtime';
import { ResourceOffer } from '@capix/resources';
const workValue = new ResourceOffer({ name: 'work-value', expose: (value: number) => value });
const run: CallableRun<string, string, 'group', { value: number }> = (work) => {
  const value: number = work.resources.value;
  // @ts-expect-error only this node dependencies exist in its Work
  work.resources.repair;
  // @ts-expect-error ordinary work has no local continuation interpreter
  work.continue('retry');
  return String(value);
};
const composed = new Group<string, string, { value: number }>({ deps: { value: workValue.request() }, run });
const composedResult: Promise<string> = children.invoke(composed, 'input');
void composedResult;
const fallback = new Sequence<string>().step('length', { use: length, input: ({ input }) => input, result: { failed: () => 'unavailable' as const } });
const fallbackResult: Promise<Readonly<{ length: number | 'unavailable' }>> = fallback.run('input', children);
void fallbackResult;
// @ts-expect-error success still returns the untransformed child result
const lostSuccess: Promise<Readonly<{ length: 'unavailable' }>> = fallback.run('input', children);
void lostSuccess;
const alternatives = new Sequence<string>().step('length', {
  use: length,
  input: ({ input }) => input,
  result: { succeeded: (value) => value.toFixed(), failed: (failure) => ({ failure }) },
});
const alternativesResult: Promise<Readonly<{ length: string | { failure: unknown } }>> = alternatives.run('input', children);
void alternativesResult;
// @ts-expect-error a handled failure does not share the success result type
const lostFailure: Promise<Readonly<{ length: string }>> = alternatives.run('input', children);
void lostFailure;
const childFact = operation.children.facts.get(operation.children.create(leaf, 'input').ref);
// @ts-expect-error child facts do not grant its resources to the parent
childFact.resources;

import { defineObservation, type InvocationFact, type DriverFact, type ObservationDefinition, type ObservationDeclaration } from '@capix/server-runtime';
const counter = new ResourceOffer({ name: 'counter', expose: (value: { increment(): void }) => value });
const callProbe: ObservationDeclaration<InvocationFact> = defineObservation<InvocationFact, { counter: { increment(): void } }>({
  deps: { counter: counter.request() },
  observe(fact, ports) {
    if (fact.kind === 'started') ports.counter.increment();
    // @ts-expect-error an observer receives only its requested resource aliases
    ports.history;
    // @ts-expect-error observation ports are a readonly view of the requested resources
    ports.counter = { increment() {} };
    // @ts-expect-error invocation observations retain their fact contract
    fact.runtimeId;
    return undefined;
  },
});
// @ts-expect-error structure facts and per-call facts are different observation contracts
const structureProbe: ObservationDeclaration<DriverFact> = callProbe;
// @ts-expect-error declarations do not own per-invocation resource binding
callProbe.bind;
const wrongPortProbe: ObservationDefinition<InvocationFact, { counter: { increment(): void } }> = {
  deps: {
    // @ts-expect-error each requested resource must supply its declared port type
    counter: workValue.request(),
  },
  observe: () => undefined,
};
const asynchronousProbe: ObservationDefinition<InvocationFact, Record<string, never>> = {
  deps: {},
  // @ts-expect-error asynchronous observation cannot retain the synchronous resource window
  observe: async () => undefined,
};
void structureProbe;
void asynchronousProbe;
void wrongPortProbe;
