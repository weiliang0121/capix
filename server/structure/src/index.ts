// Reusable structure and member composition.
export * from './callable.js';
export * from './scene.js';
export * from './group.js';
export * from './node.js';
export * from './definition/composition.js';
export type { ChildKind } from './definition/kind.js';

// Author configuration and the operation ports implemented by a running host.
export * from './definition/callable.js';
export * from './definition/scene.js';
export * from './definition/group.js';
export * from './definition/node.js';
export * from './definition/factory.js';
export * from './definition/work.js';
export * from './definition/children.js';

// Explicit business recovery contracts; frame, store and restoration stay with execution.
export * from './definition/checkpoint.js';
export * from './definition/reception.js';
export * from './composition/sequence.js';

// Shared author/host contracts retain their original identity across package entry points.
export type { AuthorCheckpointWriter, BusinessEvent, CallableContract, CallableDelta, CallableInput, CallableKind, CallableOutput, CallableShape, CheckpointCodec, CheckpointContract, CheckpointFacts, CheckpointPointOwner, CheckpointReferenceSlots, CheckpointValue, ChildCall, ChildCalls, ChildContract, ChildFact, ChildFacts, ChildInvocationOptions, ChildInvocationReceptionOptions, ChildOperationOptions, ChildOptions, ChildReceptionOptions, ChildReference, ChildReferenceSlot, ChildReturnFact, CompositeWork, ContinuationFact, ExceptionOrigin, InvocationOutputEvent, InvocationOutputReceiver, InvocationOutputWriter, InvocationSignature, OutputDeclaration, ProgressReceiver, ReceptionDefinition, ReceptionRegistration, ReceptionValue, ResumeChildCalls, SavedReferenceFacts, SavedReferences, Work, invocationSignature } from '@capix/contracts';
export * from './composition/dynamic.js';
