import { RuntimeError, type CallableInput, type CallableOutput, type Stable } from '@capix/contracts';
import { requireNotCancelled, type InvocationControls } from '@capix/invocation';
import type { AnyBuiltCallable, BuiltCallable, BuiltOptions } from './structure/construction.js';
import type { AnyCallable } from './binding/declarations.js';
import { createRootInvocation, restoreRootInvocation, type RootInvocationOptions } from './construction/calls.js';
import { ProgressChannel } from '@capix/changes';

/** Occupancy belongs to its host; this operation does not create another runtime owner. */
export interface EntryState {
  running: boolean;
}

export type EntryChange = { kind: 'established' } | ({ boundId: string } & ({ kind: 'acquired' | 'released' } | { kind: 'rejected'; reason: 'busy'; error: unknown } | { kind: 'entry-failed'; error: unknown }));

/** Run one root call, preserving construction failure and release failure independently. */
export function runEntry<Structure extends AnyCallable, Options>(entry: EntryState, structure: BuiltCallable<Structure, Options>, request: { input: NoInfer<CallableInput<Structure> | Stable<CallableInput<Structure>>> } | { contextId: string }, options: NoInfer<Options> & InvocationControls, publish: (change: EntryChange) => void, execution?: RootInvocationOptions<CallableOutput<Structure>>): Promise<Stable<CallableOutput<Structure>>>;
export function runEntry<Structure extends AnyBuiltCallable>(entry: EntryState, structure: Structure, request: { input: NoInfer<CallableInput<Structure> | Stable<CallableInput<Structure>>> } | { contextId: string }, options: NoInfer<BuiltOptions<Structure>> & InvocationControls, publish: (change: EntryChange) => void, execution?: RootInvocationOptions<CallableOutput<Structure>>): Promise<Stable<CallableOutput<Structure>>>;
export async function runEntry<Structure extends AnyBuiltCallable>(entry: EntryState, structure: Structure, request: { input: CallableInput<Structure> | Stable<CallableInput<Structure>> } | { contextId: string }, options: BuiltOptions<Structure> & InvocationControls, publish: (change: EntryChange) => void, execution?: RootInvocationOptions<CallableOutput<Structure>>): Promise<Stable<CallableOutput<Structure>>> {
  const boundId = structure.id;
  if (entry.running) {
    const error = new RuntimeError('RUNTIME_BUSY', '当前环境正在执行，请等待本次调用结束。');
    try {
      publish({ kind: 'rejected', boundId, reason: 'busy', error });
    } catch (observation) {
      throw new AggregateError([error, observation], 'Entry rejection and observation both failed', { cause: error });
    }
    throw error;
  }

  entry.running = true;
  let failed = false;
  let failure: unknown;
  try {
    publish({ kind: 'acquired', boundId });
    let invocation;
    try {
      const controls = execution ?? { signal: options?.signal };
      if (controls.signal) requireNotCancelled(controls.signal);
      invocation = 'contextId' in request ? restoreRootInvocation(structure, request.contextId, options, controls) : createRootInvocation(structure, request.input, options, controls);
    } catch (error) {
      try {
        publish({ kind: 'entry-failed', boundId, error });
      } catch (observation) {
        throw new AggregateError([error, observation], 'Call construction and observation both failed', { cause: error });
      }
      throw error;
    }
    if (execution?.created) new ProgressChannel(execution.created).publish(invocation.identity);
    const signal = execution?.signal ?? options?.signal;
    if (signal) requireNotCancelled(signal);
    return await invocation.run();
  } catch (error) {
    failed = true;
    failure = error;
    throw error;
  } finally {
    entry.running = false;
    try {
      publish({ kind: 'released', boundId });
    } catch (observation) {
      if (failed) throw new AggregateError([failure, observation], 'Call delivery and release observation both failed', { cause: failure });
      throw observation;
    }
  }
}
