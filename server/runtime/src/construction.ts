/** Low-level callable construction. New hosts normally use Runner with Scene and Resources. */
export type { BuiltCallable, AnyBuiltCallable, BuiltOptions } from './structure/construction.js';
export { callableConstruction } from './structure/construction.js';
export * from './structure/builder.js';
export * from './invocation/builders/structure.js';
export * from './binding/children/bound.js';
export * from './binding/children/builder.js';
export * from './binding/receptions.js';
export * from './binding/callable.js';
export * from './binding/calls.js';
export * from './binding/sources.js';
export * from './binding/contract.js';
export * from './binding/declarations.js';
export * from './binding/work.js';
export { InvocationContext, CallableContext, Invocation } from '@capix/invocation';
export type { InvocationControls, ContextState, InvocationStarted, InvocationOptions } from '@capix/invocation';
export * from './invocation/builders/callable.js';
export { InvocationChildren, InvocationRelation } from '@capix/invocation';
export type { ParentInvocation, InvocationChildBaseline, InvocationRelationOptions, InvocationTarget, InvocationRelationReception, InvocationRelationBaseline, InvocationRelationOwner, InvocationRelationSetup, InvocationReceptionBinding } from '@capix/invocation';
export type { InvocationCapabilities } from './invocation/capabilities.js';
export { invocationResourceFailures } from '@capix/invocation';

export type { CheckpointChildBinding, CheckpointReferenceSlot, InvocationCheckpointWork, CheckpointBinding, DecodedCheckpointReception, DecodedCheckpointHandledReception, DecodedCheckpointChild, DecodedCheckpointFrame, CheckpointContinuationFact } from '@capix/invocation';
export { checkpointChildBinding, checkpointReceptionBinding, decodeCheckpointReception, decodeCheckpointHandledReception, checkCheckpointReferences, decodeCheckpointFrame, decodeCheckpointDiagnostic, captureCheckpointContinuation, restoreCheckpointContinuation, inspectChildCallFailure } from '@capix/invocation';

export { savedCheckpointFacts } from './binding/checkpoint.js';

export { InvocationResources, type InvocationResourceOwner } from '@capix/invocation';
