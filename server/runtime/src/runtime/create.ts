import { BoundRuntime, type BoundRuntimeBinding } from './runtime.js';
import type { InvocationCapabilities } from '../invocation/capabilities.js';
import type { InvocationControls } from '../context/context.js';

export interface BoundRuntimeOptions extends InvocationCapabilities {}

/** Establish the reusable R structure; each run creates its own call state. */
export function createBoundRuntime<Input = unknown, Output = unknown, Options extends InvocationControls = InvocationControls, Resources extends object = object>(options: BoundRuntimeOptions = {}, assemble?: (runtime: BoundRuntime<Input, Output, Options, Resources>) => BoundRuntimeBinding<Input, Output, Options, Resources>): BoundRuntime<Input, Output, Options, Resources> {
  return new BoundRuntime(options, assemble);
}
