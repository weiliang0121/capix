import type { CallableKind, Work, CompositeWork, ChildContract, AuthorCheckpointWriter, ContinuationFact, OutputWork } from '@weiliang0121/capix-contracts';
import type { ChildContractsOf } from './children.js';

type Children<Kind extends CallableKind, Allowed extends ChildContractsOf<Kind>, Restoring extends boolean> = Kind extends 'node' ? object : CompositeWork<Allowed, Restoring>;
export type CallableWork<Kind extends CallableKind, Input, Output, Resources extends object = Record<string, never>, Allowed extends ChildContractsOf<Kind> = ChildContractsOf<Kind>, Delta = never> = Work<Input, Resources> & Children<Kind, Allowed, false> & OutputWork<Delta> & { readonly checkpoint?: AuthorCheckpointWriter<Kind, Input, Output, Delta> };

/** Historical progress belongs to restored facts, not to ordinary processing. */
export type ResumeWork<Kind extends CallableKind, Input, Output, Resources extends object = Record<string, never>, Allowed extends ChildContractsOf<Kind> = ChildContractsOf<Kind>, Delta = never> = Work<Input, Resources> &
  Children<Kind, Allowed, true> &
  OutputWork<Delta> & {
    readonly initialInput: Input;
    readonly round: 1 | 2;
    readonly continuation?: ContinuationFact;
    readonly checkpoint?: AuthorCheckpointWriter<Kind, Input, Output, Delta>;
  };

export type SceneWork<Input, Output, Resources extends object = Record<string, never>, Allowed extends ChildContract = ChildContract, Delta = never> = CallableWork<'scene', Input, Output, Resources, Allowed, Delta>;
export type GroupWork<Input, Output, Resources extends object = Record<string, never>, Allowed extends ChildContract = ChildContract, Delta = never> = CallableWork<'group', Input, Output, Resources, Allowed, Delta>;
export type NodeWork<Input, Output, Resources extends object = Record<string, never>, Delta = never> = CallableWork<'node', Input, Output, Resources, never, Delta>;
