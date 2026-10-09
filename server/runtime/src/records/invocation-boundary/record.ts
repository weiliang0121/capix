import { pick } from 'es-toolkit/object';
import type { InvocationBoundaryRecord as BoundaryData, InvocationBoundaryValue } from '@capix-observer/protocol';
import { BaseRecord } from '../record.js';

export type InvocationBoundaryDefinition = Omit<BoundaryData, 'id' | 'value' | 'parentId' | 'scopeId'> & { readonly scopeId?: string };

/** An immutable boundary record. It has no live Context or running/ended state. */
export class InvocationBoundaryRecord extends BaseRecord<InvocationBoundaryValue> implements BoundaryData {
  override readonly kind = 'invocation-boundary' as const;
  readonly scopeId: string;
  readonly executionId?: string;
  readonly callId: string;
  readonly sequence: number;
  readonly occurredAt: string;
  readonly offsetMs: number;

  constructor(definition: InvocationBoundaryDefinition, value: Pick<InvocationBoundaryValue, 'type'>) {
    super(Object.freeze({ type: value.type, scope: 'work' as const }), definition.callId);
    this.scopeId = definition.scopeId ?? definition.executionId ?? definition.callId;
    this.executionId = definition.executionId;
    this.callId = definition.callId;
    this.sequence = definition.sequence;
    this.occurredAt = definition.occurredAt;
    this.offsetMs = definition.offsetMs;
    Object.freeze(this);
  }

  override toJSON(): BoundaryData {
    return { ...super.toJSON(), ...pick(this, ['scopeId', 'callId', 'sequence', 'occurredAt', 'offsetMs']), ...(this.executionId ? { executionId: this.executionId } : {}) };
  }
}
