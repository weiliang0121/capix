import type { InvocationIdentity } from '@capix/contracts';
import type { InvocationProcess } from './work.js';
import type { InvocationRelationIdentity, InvocationRelationChange } from '../observation/facts.js';

/** Passive metadata of established work facts. No IO, borrowed entities or diagnostics. */
export type InvocationProgress = Readonly<
  {
    identity: InvocationIdentity;
    /** Ordered within the producing invocation, not across its subtree or a transport. */
    eventSequence: number;
    occurredAt: string;
    description?: Readonly<{ id?: string; name?: string; label?: string }>;
  } & ({ kind: 'started' } | { kind: 'process'; processSequence: number; round: number; stage: InvocationProcess['stage']; action: InvocationProcess['type'] } | { kind: 'relation'; relation: InvocationRelationIdentity; phase: Exclude<InvocationRelationChange['kind'], 'returned'> } | { kind: 'relation'; relation: InvocationRelationIdentity; phase: 'returned'; status: 'succeeded' | 'failed' | 'cancelled' } | { kind: 'finished'; status: 'succeeded' | 'failed' | 'cancelled' })
>;
