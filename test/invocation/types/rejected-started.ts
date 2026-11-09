import type { CallableInvocationCallbacks } from '@weiliang0121/capix-runtime';
import type { InvocationContext, InvocationStarted } from '@weiliang0121/capix-invocation';

export const asyncStarted: InvocationStarted<string, number, InvocationContext<string, number>> = async () => {};

export const returnedValue: InvocationStarted<string, number, InvocationContext<string, number>> = () => 1;

export const callbacks: CallableInvocationCallbacks<string, number, Record<string, never>> = {
  started: async () => {},
};
