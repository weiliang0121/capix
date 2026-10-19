import type { ExecutionInvocationCallbacks, InvocationContext, InvocationStarted } from '@capix/server-runtime';

export const asyncStarted: InvocationStarted<string, number, InvocationContext<string, number>> = async () => {};

export const returnedValue: InvocationStarted<string, number, InvocationContext<string, number>> = () => 1;

export const callbacks: ExecutionInvocationCallbacks<string, number, Record<string, never>> = {
  started: async () => {},
};
