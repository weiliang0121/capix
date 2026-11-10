import type { CallableInvocationCallbacks } from '@weiliang0121/capix-runtime';

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
