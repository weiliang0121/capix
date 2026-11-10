/** Low-level callable construction. New hosts normally use Runner with Scene and Resources. */
export type { BuiltCallable, AnyBuiltCallable, BuiltOptions } from './structure/construction.js';
export { callableConstruction } from './structure/construction.js';
export * from './structure/builder.js';
export * from './construction/calls.js';
export * from './binding/children/bound.js';
export * from './binding/children/builder.js';
export * from './binding/receptions.js';
export * from './binding/callable.js';
export * from './binding/calls.js';
// Source-based construction is retained only as an explicit legacy adapter.
export * from './legacy/sources.js';
export { buildCallableFromSource, type CallableBindingOptions } from './legacy/binding.js';
export * from './binding/contract.js';
export * from './binding/declarations.js';
export * from './binding/work.js';
export { InvocationContext, CallableContext, Invocation } from '@weiliang0121/capix-invocation';
export type { InvocationControls, ContextState, InvocationStarted, InvocationOptions } from '@weiliang0121/capix-invocation';
export * from './construction/invocation.js';
export { InvocationChildren, InvocationRelation } from '@weiliang0121/capix-invocation';
export type { ParentInvocation, InvocationChildBaseline, InvocationRelationOptions, InvocationTarget, InvocationRelationReception, InvocationRelationBaseline, InvocationRelationOwner, InvocationRelationSetup, InvocationReceptionBinding } from '@weiliang0121/capix-invocation';
export type { InvocationCapabilities } from './construction/capabilities.js';
export { invocationResourceFailures } from '@weiliang0121/capix-invocation';

export type { CheckpointChildBinding, CheckpointReferenceSlot, InvocationCheckpointWork, CheckpointBinding, DecodedCheckpointReception, DecodedCheckpointHandledReception, DecodedCheckpointChild, DecodedCheckpointFrame, CheckpointContinuationFact } from '@weiliang0121/capix-invocation';
export { checkpointChildBinding, checkpointReceptionBinding, decodeCheckpointReception, decodeCheckpointHandledReception, checkCheckpointReferences, decodeCheckpointFrame, decodeCheckpointDiagnostic, captureCheckpointContinuation, restoreCheckpointContinuation, inspectChildCallFailure } from '@weiliang0121/capix-invocation';

export { savedCheckpointFacts } from './binding/checkpoint.js';

export { InvocationResources, type InvocationResourceOwner } from '@weiliang0121/capix-invocation';
