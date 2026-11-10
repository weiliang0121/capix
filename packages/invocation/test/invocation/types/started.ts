import type { InvocationContext, InvocationStarted } from '@weiliang0121/capix-invocation';

export const started: InvocationStarted<string, number, InvocationContext<string, number>> = (context, invocation) => {
  const input: string = context.input;
  const contextId: string = invocation.identity.contextId;
  void input;
  void contextId;
};
