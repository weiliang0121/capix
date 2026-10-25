import type { CallableKind } from '@capix/protocol';
import type { ChildCalls, ChildContract, ChildContractsOf, ResumeChildCalls } from './children.js';
import type { AuthorCheckpointWriter, ContinuationFact } from './checkpoint.js';
import type { BusinessEvent } from '../observation/facts.js';

/** Business processing sees its input and current controlled operation endpoints. */
export interface Work<Input, Resources extends object> {
  readonly input: Input;
  readonly resources: Readonly<Resources>;
  readonly signal: AbortSignal;
  observation(event: BusinessEvent): void;
}

export interface CompositeWork<Allowed extends ChildContract = ChildContract, Restoring extends boolean = false> {
  readonly children: Restoring extends true ? ResumeChildCalls<Allowed> : ChildCalls<Allowed>;
}
type Children<Kind extends CallableKind, Allowed extends ChildContractsOf<Kind>, Restoring extends boolean> = Kind extends 'node' ? object : CompositeWork<Allowed, Restoring>;
type OutputPort<Delta> = [Delta] extends [never] ? object : { readonly output: { emit(delta: Delta): void } };

export type CallableWork<Kind extends CallableKind, Input, Output, Resources extends object = Record<string, never>, Allowed extends ChildContractsOf<Kind> = ChildContractsOf<Kind>, Delta = never> = Work<Input, Resources> & Children<Kind, Allowed, false> & OutputPort<Delta> & { readonly checkpoint?: AuthorCheckpointWriter<Kind, Input, Output, Delta> };

/** Historical progress belongs to restored facts, not to ordinary processing. */
export type ResumeWork<Kind extends CallableKind, Input, Output, Resources extends object = Record<string, never>, Allowed extends ChildContractsOf<Kind> = ChildContractsOf<Kind>, Delta = never> = Work<Input, Resources> &
  Children<Kind, Allowed, true> &
  OutputPort<Delta> & {
    readonly initialInput: Input;
    readonly round: 1 | 2;
    readonly continuation?: ContinuationFact;
    readonly checkpoint?: AuthorCheckpointWriter<Kind, Input, Output, Delta>;
  };

export type SceneWork<Input, Output, Resources extends object = Record<string, never>, Allowed extends ChildContract = ChildContract, Delta = never> = CallableWork<'scene', Input, Output, Resources, Allowed, Delta>;
export type GroupWork<Input, Output, Resources extends object = Record<string, never>, Allowed extends ChildContract = ChildContract, Delta = never> = CallableWork<'group', Input, Output, Resources, Allowed, Delta>;
export type NodeWork<Input, Output, Resources extends object = Record<string, never>, Delta = never> = CallableWork<'node', Input, Output, Resources, never, Delta>;
