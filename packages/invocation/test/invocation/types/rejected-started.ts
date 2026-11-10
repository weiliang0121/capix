import type { InvocationContext, InvocationStarted } from '@weiliang0121/capix-invocation';

export const asyncStarted: InvocationStarted<string, number, InvocationContext<string, number>> = async () => {};

export const returnedValue: InvocationStarted<string, number, InvocationContext<string, number>> = () => 1;
