import type { CallableKind, ChildContract } from '@capix/contracts';
import type { CallableStructure } from '../callable.js';
import type { Composite } from './composition.js';
import type { ChildKind } from './kind.js';

// Registration requires complete reusable structures, not only callable signatures.
export type ChildCallable = (CallableStructure<'group'> & Composite) | (CallableStructure<'node'> & { readonly members?: never });
export type ChildrenOf<Kind extends CallableKind> = [ChildKind<Kind>] extends [never] ? never : ChildCallable;
export type ChildContractsOf<Kind extends CallableKind> = [ChildKind<Kind>] extends [never] ? never : ChildContract;
