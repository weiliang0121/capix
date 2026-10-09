import { Sequence, InvocationEntry, type OperationDefinition, type AttemptDefinition, type InvocationView, type ExecutionScope, type OperationScope, type ChildBindings, assembleRuntime, type ExecutionDefinition } from '@capix-observer/runtime';

declare const length: OperationDefinition<string, number>;
declare const format: OperationDefinition<number, string>;
declare const leaf: AttemptDefinition<string, string>;
declare const parent: InvocationView<unknown, unknown, ExecutionScope>;
declare const operation: InvocationView<unknown, unknown, OperationScope>;
declare const bindings: ChildBindings;

const sequence = new Sequence<string, typeof parent>().step('length', { use: length, input: ({ input }) => input }).step('format', { use: format, input: ({ outputs }) => outputs.length, accept: (_scope, value) => ({ text: value }) });
const result: Promise<Readonly<{ length: number; format: { text: string } }>> = sequence.run(parent, 'hello', bindings);
void result;
new Sequence<string, typeof parent>().step('bad', {
  use: length,
  // @ts-expect-error input must match the declared input
  input: () => 123,
});
new Sequence<string, typeof parent>().step('first', {
  use: length,
  // @ts-expect-error a later output is unavailable before its step
  input: ({ outputs }) => outputs.future,
});
// @ts-expect-error composition positions must be unique
sequence.step('length', { use: length, input: () => 'again' });
// @ts-expect-error A cannot be a direct child of E
new Sequence<string, typeof parent>().step('leaf', { use: leaf, input: ({ input }) => input });
// @ts-expect-error a definition has no runtime call entry
length.create(parent, 'hello');
// @ts-expect-error the bound entry retains its concrete input
bindings.get(length).create(parent, 123);
// @ts-expect-error a bound A still requires an O parent
bindings.get(leaf).create(parent, 'hello');
const alternative = new InvocationEntry(leaf, (_parent, value: number) => String(value));
const alternativeOutput: Promise<string> = bindings.entry(alternative).create(operation, 1).run();
void alternativeOutput;
// @ts-expect-error alternative entry enforces its own input contract
bindings.entry(alternative).create(operation, 'wrong');

// Contracts also support typed objects; no inheritance or synthetic identity is required.
const objectDefinition: OperationDefinition<string, number> = {
  level: 'operation',
  name: 'length',
  label: 'length',
  source: 'test',
  requires: {},
  children: [],
  maxRounds: 1,
  execute: (context) => context.currentInput.length,
};
const objectOutput: Promise<Readonly<{ length: number }>> = new Sequence<string, typeof parent>().step('length', { use: objectDefinition, input: ({ input }) => input }).run(parent, 'hello', bindings);
void objectOutput;
declare const execution: ExecutionDefinition<string, number>;
const runtime = assembleRuntime({ execution }, { providers: [], source: { entry: () => null, capture: (_input: string, _options: { signal?: AbortSignal }) => null } });
const rootOutput: Promise<number> = runtime.run('input', {});
void rootOutput;
// @ts-expect-error E input remains typed through R binding
runtime.run(42, {});
// @ts-expect-error R cannot register A as an E
assembleRuntime({ execution: leaf }, { providers: [], source: { entry: () => null, capture: () => null } });
// @ts-expect-error content cannot mutate its lifecycle
parent.context.complete('done');
// @ts-expect-error child relations do not publish reception mutation
parent.children.values()[0].accept(() => null);
