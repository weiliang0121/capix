import { Sequence, type Operation, type Attempt, type Invocation, type ExecutionContext } from '@capix-observer/runtime';

declare const length: Operation<string, number>;
declare const format: Operation<number, string>;
declare const leaf: Attempt<string, string>;
declare const parent: Invocation<unknown, unknown, ExecutionContext>;

const sequence = new Sequence<string, typeof parent>().step('length', { use: length, input: ({ input }) => input }).step('format', { use: format, input: ({ outputs }) => outputs.length, accept: (_scope, value) => ({ text: value }) });
const result: Promise<Readonly<{ length: number; format: { text: string } }>> = sequence.run(parent, 'hello');
void result;

new Sequence<string, typeof parent>().step('bad', {
  use: length,
  // @ts-expect-error input must match the child's declared input
  input: () => 123,
});
new Sequence<string, typeof parent>().step('first', {
  use: length,
  // @ts-expect-error a later output is unavailable before its step
  input: ({ outputs }) => outputs.future,
});
// @ts-expect-error composition keys identify distinct work positions
sequence.step('length', { use: length, input: () => 'again' });
// @ts-expect-error attempts cannot be direct children of an execution
new Sequence<string, typeof parent>().step('leaf', { use: leaf, input: ({ input }) => input });
