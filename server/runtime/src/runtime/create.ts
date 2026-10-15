import { BoundRuntime } from './runtime.js';
import type { InvocationCapabilities } from '../invocation/capabilities.js';
import type { InvocationControls } from '../context/context.js';
import { RuntimeContextBuilder } from '../context/runtime/builder.js';
import { RuntimeInvocationBuilder } from '../invocation/runtime/builder.js';

/** Establish a bare R structure for low-level use; application declarations use RuntimeBinder. */
export function createBoundRuntime<Input = unknown, Output = unknown, Options extends InvocationControls = InvocationControls, Resources extends object = object>(options: InvocationCapabilities = {}): BoundRuntime<Input, Output, Options, Resources> {
  const contexts = new RuntimeContextBuilder();
  const invocations = new RuntimeInvocationBuilder(contexts, options);
  return new BoundRuntime(invocations, undefined, options);
}
