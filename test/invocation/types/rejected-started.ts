import type { CallableInvocationCallbacks } from '@capix/server-runtime';
import type { InvocationContext, InvocationStarted } from '@capix/invocation';

export const asyncStarted: InvocationStarted<string, number, InvocationContext<string, number>> = async () => {};

export const returnedValue: InvocationStarted<string, number, InvocationContext<string, number>> = () => 1;

export const callbacks: CallableInvocationCallbacks<string, number, Record<string, never>> = {
  started: async () => {},
};
