import { Sequence, InvocationEntry, type OperationDefinition, type AttemptDefinition, type Invocation, type ExecutionContext, type OperationContext, type BoundChildren, type Runtime, type ExecutionDefinition } from '@capix-observer/runtime';

declare const length: OperationDefinition<string, number>;
declare const format: OperationDefinition<number, string>;
declare const leaf: AttemptDefinition<string, string>;
declare const parent: Invocation<unknown, unknown, ExecutionContext>;
declare const operation: Invocation<unknown, unknown, OperationContext>;
declare const bindings: BoundChildren;

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
declare const runtime: Runtime;
declare const execution: ExecutionDefinition<string, number>;
const root = runtime.bind({ providers: [], executions: { main: execution } });
const entry = root.execution('main', { capture: (_input, _options: { signal?: AbortSignal }) => ({ source: null }) });
const rootOutput: Promise<number> = entry.call('input', {});
void rootOutput;
// @ts-expect-error only declared E names are available
root.execution('other', { capture: () => ({ source: null }) });
// @ts-expect-error E input remains typed through R binding
entry.call(42, {});
// @ts-expect-error R cannot register A as an E
runtime.bind({ providers: [], executions: { wrong: leaf } });
