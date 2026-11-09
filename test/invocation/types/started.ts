import type { CallableInvocationCallbacks } from '@weiliang0121/capix-runtime';
import type { InvocationContext, InvocationStarted } from '@weiliang0121/capix-invocation';

export const started: InvocationStarted<string, number, InvocationContext<string, number>> = (context, invocation) => {
  const input: string = context.input;
  const contextId: string = invocation.identity.contextId;
  void input;
  void contextId;
};

export const callbacks: CallableInvocationCallbacks<string, number, Record<string, never>> = {
  started(context, invocation) {
    const input: string = context.input;
    const kind: 'scene' | 'group' | 'node' = context.kind;
    const contextId: string = invocation.identity.contextId;
    void input;
    void kind;
    void contextId;
    return undefined;
  },
};
