import { pick } from 'es-toolkit/object';
import type { InvocationBoundaryRecord as BoundaryData, InvocationBoundaryValue } from '@capix-observer/protocol';
import { BaseRecord } from '../record.js';

export type InvocationBoundaryDefinition = Omit<BoundaryData, 'id' | 'value' | 'parentId'>;

/** An immutable boundary record. It has no live Context or running/ended state. */
export class InvocationBoundaryRecord extends BaseRecord<InvocationBoundaryValue> implements BoundaryData {
  override readonly kind = 'invocation-boundary' as const;
  readonly executionId: string;
  readonly callId: string;
  readonly sequence: number;
  readonly occurredAt: string;
  readonly offsetMs: number;

  constructor(definition: InvocationBoundaryDefinition, value: InvocationBoundaryValue) {
    super(Object.freeze({ type: value.type }), definition.callId);
    this.executionId = definition.executionId;
    this.callId = definition.callId;
    this.sequence = definition.sequence;
    this.occurredAt = definition.occurredAt;
    this.offsetMs = definition.offsetMs;
    Object.freeze(this);
  }

  override toJSON(): BoundaryData {
    return { ...super.toJSON(), ...pick(this, ['executionId', 'callId', 'sequence', 'occurredAt', 'offsetMs']) };
  }
}
