import type { AuthorCheckpointWriter, CallableContract, CallableInput, CallableOutput, CheckpointCodec, CheckpointPointOwner, ChildCalls, ChildFacts, ChildReference, ChildReferenceSlot, OperationResult, ReceptionDefinition, Work } from '@weiliang0121/capix-contracts';
import type { CallableContract as StructureContract, ChildReference as StructureReference, CheckpointCodec as StructureCodec } from '@weiliang0121/capix-structure';
import type { OperationResult as ResourceOperationResult } from '@weiliang0121/capix-resources/operation';
import type { InvocationFailureFact } from '@weiliang0121/capix-contracts';
import type { InvocationEvent } from '@weiliang0121/capix-invocation/events';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<Value extends true> = Value;
type StructureIdentity = Assert<Equal<CallableContract<'node', string, number>, StructureContract<'node', string, number>>>;
type ReferenceIdentity = Assert<Equal<ChildReference<CallableContract<'node', string, number>>, StructureReference<CallableContract<'node', string, number>>>>;
type CodecIdentity = Assert<Equal<CheckpointCodec<string>, StructureCodec<string>>>;
type ReceptionIdentity = Assert<Equal<OperationResult<string, { result: { failed: () => number } }>, ResourceOperationResult<string, { result: { failed: () => number } }>>>;
type EventFailureIdentity = Assert<Equal<NonNullable<Extract<InvocationEvent['change'], { kind: 'relation' }>['failure']>, InvocationFailureFact>>;
type OptionalFailure = Assert<Equal<OperationResult<string, { result: { failed: () => number } }>, string | number>>;
type ReplacedSuccess = Assert<Equal<OperationResult<string, { result: { succeeded: () => Promise<number> } }>, number>>;
type OptionalReception = Assert<Equal<OperationResult<string, { result?: { succeeded: () => number } }>, string | number>>;
type OptionalSuccess = Assert<Equal<OperationResult<string, { result: { succeeded?: () => Promise<number> } }>, string | number>>;
type PossiblyAbsentSuccess = Assert<Equal<OperationResult<string, { result: { succeeded: (() => number) | undefined } }>, string | number>>;
type PossiblyAbsentReception = Assert<Equal<OperationResult<string, { result: { succeeded: () => number } | undefined }>, string | number>>;
type OptionalBothBranches = Assert<Equal<OperationResult<string, { result?: { succeeded: () => Promise<number>; failed?: () => Promise<boolean> } }>, string | number | boolean>>;
type OptionalFailureOnly = Assert<Equal<OperationResult<string, { result?: { failed?: () => boolean } }>, string | boolean>>;
type OptionsUnion = Assert<Equal<OperationResult<string, { result: { succeeded: () => number } } | { result: { failed: () => boolean } }>, string | number | boolean>>;
type MissingOptionsBranch = Assert<Equal<OperationResult<string, { result: { succeeded: () => number } } | {} | undefined>, string | number>>;
type HandlerUnion = Assert<Equal<OperationResult<string, { result: { succeeded: () => number } | { failed: () => boolean } }>, string | number | boolean>>;
type BothRequiredBranches = Assert<Equal<OperationResult<string, { result: { succeeded: () => number; failed: () => boolean } }>, number | boolean>>;
type ThrowingFailure = Assert<Equal<OperationResult<string, { result: { succeeded: () => number; failed: () => never } }>, number>>;
type ExplicitUndefinedSuccess = Assert<Equal<OperationResult<string, { result: { succeeded: () => undefined } }>, undefined>>;

declare const optionalReception: OperationResult<string, { result?: { succeeded: () => number } }>;
const originalOrReceived: string | number = optionalReception;
// @ts-expect-error the whole result object may be absent, retaining the original string.
const receivedOnly: number = optionalReception;
declare const optionalSuccess: OperationResult<string, { result: { succeeded?: () => number } }>;
// @ts-expect-error an absent success handler retains the original string.
const convertedOnly: number = optionalSuccess;
declare const handledFailure: OperationResult<string, { result: { succeeded: () => number; failed?: () => boolean } }>;
// @ts-expect-error a present failure handler can return its own boolean result.
const ignoresFailure: number = handledFailure;
declare const replacedSuccess: OperationResult<string, { result: { succeeded: () => number; failed: () => never } }>;
// @ts-expect-error a required success conversion does not retain the original string.
const originalOnly: string = replacedSuccess;

declare const child: CallableContract<'node', { text: string }, string, string>;
declare const literalChild: CallableContract<'node', { text: 'only' }, string, string>;
// @ts-expect-error input is supplied and read from facts, so narrowing is unsafe.
const unsafeNarrowing: typeof literalChild = child;
// @ts-expect-error input is supplied and read from facts, so widening is unsafe.
const unsafeWidening: typeof child = literalChild;
type Input = Assert<Equal<CallableInput<typeof child>, { text: string }>>;
type Output = Assert<Equal<CallableOutput<typeof child>, string>>;

declare const calls: ChildCalls<typeof child>;
declare const length: ReceptionDefinition<typeof child, number>;
const text: Promise<string> = calls.invoke(child, { text: 'hello' });
const received: Promise<number> = calls.invoke(child, { text: 'hello' }, { reception: length, result: { succeeded: (value) => value.length } });
// @ts-expect-error each call preserves the registered child's exact input.
calls.invoke(child, { text: 42 });
// @ts-expect-error a non-assignable registered reception requires the success conversion.
calls.invoke(child, { text: 'hello' }, { reception: length });
const handle = calls.create(child, { text: 'hello' }, { key: 'saved' });
// @ts-expect-error output routing was fixed when the saved handle was created.
handle.invoke({ delta: (delta: string) => delta.length });

declare const facts: ChildFacts;
declare const ref: ChildReference<typeof child>;
declare const otherRef: ChildReference<CallableContract<'node', { id: number }, string>>;
const accepted: number = facts.accepted(ref, length);
// @ts-expect-error reception and reference belong to different child contracts.
facts.accepted(otherRef, length);

declare const point: CheckpointPointOwner<'group', { text: string }, number, never> & {
  readonly state: CheckpointCodec<{ position: number }>;
  readonly references: { readonly child: ChildReferenceSlot<typeof child, false> };
};
declare const save: AuthorCheckpointWriter<'group', { text: string }, number>;
save({ point, state: { position: 1 }, refs: { child: ref } });
// @ts-expect-error saved state is derived from the exact point's codec.
save({ point, state: { position: 'one' }, refs: { child: ref } });
// @ts-expect-error required references cannot be omitted.
save({ point, state: { position: 1 } });
// @ts-expect-error saved references preserve their child signatures.
save({ point, state: { position: 1 }, refs: { child: otherRef } });

declare const work: Work<string, { dictionary: { translate(word: string): string } }>;
const translated: string = work.resources.dictionary.translate(work.input);
work.observation({ event: 'translated', text: translated });
// @ts-expect-error a Work cannot replace its fixed resource endpoint.
work.resources.dictionary = { translate: (word) => word };
