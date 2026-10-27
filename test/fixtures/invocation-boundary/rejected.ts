import { Invocation, InvocationContext, type InvocationStarted } from '@capix/invocation';

new Invocation<number, string>({
  context: new InvocationContext('wrong input'),
  signal: new AbortController().signal,
  work: { execute: () => 'output' },
});

new Invocation<number, string>({
  context: new InvocationContext<number, string>(1),
  signal: new AbortController().signal,
  work: { execute: () => 42 },
});

export const asynchronousStarted: InvocationStarted<number, string, InvocationContext<number, string>> = async () => {};
