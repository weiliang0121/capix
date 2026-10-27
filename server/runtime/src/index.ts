// Declarations and business composition.
export * from '@capix/structure';
export { ChildCallFailure, ExceptionContract, DeclaredException } from '@capix/invocation';
export * from './definition/observation.js';

export * from './driver.js';
export * from './runner.js';
export { callableHooks, type CallableHookDeclaration, type CallableHookBinding } from './binding/hooks.js';

// Application assembly and independent resource supplies.
export * from './binding/callable.js';
export * from './binding/observation.js';
export * from './binding/resources.js';
export { Resources, CapturedResources } from './resource/resources.js';
export * from './initializer.js';

// Independent external interactions; waiting invocations do not own delivery or retained feedback.
export * from './interaction/contract.js';
export * from './interaction/interaction.js';
export * from './interaction/interactions.js';

// Business-facing context and invocation views, results and shared time.
export { invocationContextView, invocationView, childInvocationView, Clock, InvocationCancelled, isInvocationCancelled } from '@capix/invocation';
export type { InvocationContextView, CallableContextView, ContextViewOf, ContextViewResources, ContextFactsOf, InvocationRelationView, InvocationView, ChildInvocationView, InvocationViewSource, InvocationProgress, InvocationResult, InvocationFailure, InvocationPhase } from '@capix/invocation';
export type { InvocationIdentity } from '@capix/contracts';

// Live facts and observation installations, independent of the recording preset.
export { InvocationChangeEmitter, InvocationObservation, ObservationError } from '@capix/invocation';
export type { InvocationRelationIdentity, InvocationDescription, InvocationRelationChange, InvocationChange, InvocationFact, ResourceObservation, BusinessEvent, BusinessObservation, InvocationObserver } from '@capix/invocation';
export type { EventConsumer } from '@capix/changes';
export type { DriverFact, DriverObserver } from './observation/driver.js';

// Explicit public subpaths also remain available from the grouped root surface.
export * from './construction.js';
export * from './recording.js';

// Shared diagnostics and runtime error conversion.
export { RuntimeError } from '@capix/contracts';
export { PersistenceError, RuntimeErrorHelper, isNonEmptyArray, hasUniqueItems, isObject, isObjectLike, isNonBlankString, nonBlankStringPattern } from '@capix/invocation';

// Optional checkpoint installation and runtime recovery facts.
export type { CheckpointFact, CheckpointInstallation, CheckpointWriter, CheckpointRestoration } from '@capix/invocation';
