import type { ExecutionInvocationCallbacks, InvocationContext, InvocationStarted } from '@capix/server-runtime';

export const started: InvocationStarted<string, number, InvocationContext<string, number>> = (context, invocation) => {
  const input: string = context.input;
  const contextId: string = invocation.identity.contextId;
  void input;
  void contextId;
};

export const callbacks: ExecutionInvocationCallbacks<string, number, Record<string, never>> = {
  started(context, invocation) {
    const input: string = context.input;
    const level: 'execution' = context.level;
    const contextId: string = invocation.identity.contextId;
    void input;
    void level;
    void contextId;
    return undefined;
  },
};
