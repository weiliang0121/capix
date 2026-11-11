import { pick } from 'es-toolkit/object';
import type { InvocationBoundaryRecord as BoundaryData, InvocationBoundaryValue } from '../../data/index.js';
import { BaseRecord } from '../../record.js';

export type InvocationBoundaryRecordOptions = Omit<BoundaryData, 'id' | 'value' | 'parentId' | 'scopeId'> & { readonly scopeId?: string };

/** An immutable boundary record. It has no live Context or running/ended state. */
export class InvocationBoundaryRecord extends BaseRecord<InvocationBoundaryValue> implements BoundaryData {
  override readonly kind = 'invocation-boundary' as const;
  readonly scopeId: string;
  readonly executionId?: string;
  readonly callId: string;
  readonly sequence: number;
  readonly occurredAt: string;
  readonly offsetMs: number;

  constructor(options: InvocationBoundaryRecordOptions, value: Pick<InvocationBoundaryValue, 'type'>) {
    super(Object.freeze({ type: value.type, scope: 'work' as const }), options.callId);
    this.scopeId = options.scopeId ?? options.executionId ?? options.callId;
    this.executionId = options.executionId;
    this.callId = options.callId;
    this.sequence = options.sequence;
    this.occurredAt = options.occurredAt;
    this.offsetMs = options.offsetMs;
    Object.freeze(this);
  }

  override toJSON(): BoundaryData {
    return { ...super.toJSON(), ...pick(this, ['scopeId', 'callId', 'sequence', 'occurredAt', 'offsetMs']), ...(this.executionId ? { executionId: this.executionId } : {}) };
  }
}
