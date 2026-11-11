// Declarations and business composition.
export * from '@weiliang0121/capix-structure';
export { ChildCallFailure, ExceptionContract, DeclaredException } from '@weiliang0121/capix-invocation';
export * from './definition/observation.js';

export * from './legacy/driver.js';
export * from './runner.js';
export { callableHooks, type CallableHookDeclaration, type CallableHookBinding } from './binding/hooks.js';

// Application assembly and independent resource supplies.
export * from './binding/callable.js';
export * from './binding/observation.js';
export * from './binding/resources.js';
export { Resources, CapturedResources } from './resource/resources.js';
export * from './initializer.js';

// Independent external interactions; waiting invocations do not own delivery or retained feedback.
export * from '@weiliang0121/capix-interaction';

// Business-facing context and invocation views, results and shared time.
export { invocationContextView, invocationView, childInvocationView, Clock, InvocationCancelled, isInvocationCancelled } from '@weiliang0121/capix-invocation';
export type { InvocationContextView, CallableContextView, ContextViewOf, ContextViewResources, ContextFactsOf, InvocationRelationView, InvocationView, ChildInvocationView, InvocationViewSource, InvocationProgress, InvocationResult, InvocationFailure, InvocationPhase } from '@weiliang0121/capix-invocation';
export type { InvocationIdentity } from '@weiliang0121/capix-contracts';

// Live facts and observation installations, independent of the recording preset.
export { InvocationChangeEmitter, InvocationObservation, ObservationError } from '@weiliang0121/capix-invocation';
export type { InvocationRelationIdentity, InvocationDescription, InvocationRelationChange, InvocationChange, InvocationFact, ResourceObservation, ResourceFact, BusinessEvent, BusinessObservation, InvocationObserver } from '@weiliang0121/capix-invocation';
export type { EventConsumer } from '@weiliang0121/capix-changes';
export type { DriverFact, DriverObserver } from './observation/driver.js';

// Explicit public subpaths also remain available from the grouped root surface.
export * from './construction.js';
export * from './recording.js';

// Shared diagnostics and runtime error conversion.
export { RuntimeError } from '@weiliang0121/capix-contracts';
export { PersistenceError, RuntimeErrorHelper } from '@weiliang0121/capix-diagnostics';
export { isNonEmptyArray, hasUniqueItems, isObject, isObjectLike, isNonBlankString, nonBlankStringPattern } from '@weiliang0121/capix-invocation';

// Optional checkpoint installation and runtime recovery facts.
export type { CheckpointFact, CheckpointInstallation, CheckpointWriter, CheckpointRestoration } from '@weiliang0121/capix-invocation';
