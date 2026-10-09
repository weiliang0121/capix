import { Runtime, type RuntimeBinding } from './runtime.js';
import type { InvocationCapabilities } from '../invocation/capabilities.js';
import type { RuntimeCallOptions } from '../context/runtime.js';

export interface RuntimeCreationOptions extends InvocationCapabilities {}

/** Establish the reusable R structure; each run creates its own call state. */
export function createRuntime<I = unknown, O = unknown, P extends RuntimeCallOptions = RuntimeCallOptions, R extends object = object>(options: RuntimeCreationOptions = {}, assemble?: (runtime: Runtime<I, O, P, R>) => RuntimeBinding<I, O, P, R>): Runtime<I, O, P, R> {
  return new Runtime(options, assemble);
}
