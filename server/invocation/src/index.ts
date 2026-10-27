// Single-call state, control and delivery. Structure assembly belongs to Runtime.
export { Invocation, type InvocationOptions, type InvocationStarted } from './invocation/invocation.js';
export { InvocationContext, type InvocationControls, type ContextState } from './context/context.js';
export { CallableContext } from './context/callable.js';
export type { InvocationWork, InvocationProcess } from './invocation/work.js';
export type { InvocationResult } from './invocation/result.js';
export { failureFact, type InvocationFailure, type InvocationPhase } from './invocation/failure.js';
export { Clock } from './clock.js';

// Direct relationships and their independent returned/reception facts.
export { InvocationChildren, type ParentInvocation, type InvocationChildBaseline } from './invocation/children.js';
export { InvocationRelation, type InvocationRelationOptions, type InvocationTarget, type InvocationRelationReception, type InvocationRelationBaseline, type InvocationRelationOwner, type InvocationRelationSetup } from './invocation/relation.js';
export type { InvocationReceptionBinding } from './invocation/reception.js';
export { invocationContextView, type InvocationContextView, type CallableContextView, type ContextViewOf, type ContextViewResources, type ContextFactsOf } from './context/view.js';
export { invocationView, childInvocationView, type InvocationView, type ChildInvocationView, type InvocationRelationView, type InvocationViewSource } from './invocation/view.js';

// Resource windows and operation failure ownership, over fixed supplies.
export { InvocationResources, type InvocationResourceOwner } from './invocation/resource-access.js';
export { attachInvocationResources, invocationResourceFailures } from './invocation/resources.js';
export { InvocationCancelled, isInvocationCancelled, requireNotCancelled } from './invocation/cancellation.js';
export { ExceptionContract, DeclaredException } from './exception/contract.js';
export { ChildCallFailure, inspectChildCallFailure, type InvocationExceptionOrigin, type InvocationExceptionChild } from './invocation/provenance.js';

// Output and synchronous live observation. Consumers and installations are host choices.
export { combineOutputReceivers } from './output/delivery.js';
export { InvocationChangeEmitter } from './invocation/changes.js';
export type { InvocationProgress } from './invocation/progress.js';
export { invocationProgress } from './invocation/facts.js';
export type { InvocationFact, InvocationChange, InvocationDescription, InvocationIdentity, InvocationRelationIdentity, InvocationRelationChange, ResourceObservation, BusinessObservation, BusinessEvent } from './observation/facts.js';
export type { InvocationObserver, EventConsumer } from './observation/observer.js';
export { InvocationObservation } from './observation/invocation.js';
export { ObserverSession, publishSessions } from './observation/session.js';
export { ObservationError } from './observation/error.js';

// Live checkpoint adaptation; immutable images and stores come from @capix/checkpoint.
export type { CheckpointInstallation, CheckpointRestoration, CheckpointWriter, CheckpointFact } from './checkpoint/contract.js';
export type { InvocationCheckpointWork, CheckpointBinding, CheckpointChildBinding, CheckpointReferenceSlot } from './checkpoint/work.js';
export { prepareCheckpointRestoration } from './checkpoint/restoration.js';
export { captureCheckpointContinuation, restoreCheckpointContinuation, type CheckpointContinuationFact } from './checkpoint/continuation.js';
export { checkpointChildBinding, checkpointReceptionBinding, decodeCheckpointReception, decodeCheckpointHandledReception, checkCheckpointReferences, decodeCheckpointFrame, decodeCheckpointDiagnostic, type DecodedCheckpointReception, type DecodedCheckpointHandledReception, type DecodedCheckpointChild, type DecodedCheckpointFrame } from './checkpoint/facts.js';

// Shared diagnostic implementations retain object identity across package entrypoints.
export { RuntimeError } from '@capix/contracts';
export { PersistenceError } from '@capix/diagnostics';
export { RuntimeErrorHelper } from '@capix/diagnostics';
export { isNonEmptyArray, hasUniqueItems } from './value/array.js';
export { isObjectLike, isObject } from './value/object.js';
export { nonBlankStringPattern, isNonBlankString } from './value/string.js';
