import type { EventRecord as EventData, EventValue } from '../../../shared/records.js';
import { RuntimeRecord } from '../record.js';

export type EventDefinition = Omit<EventData, 'id' | 'value'>;

/** An immutable boundary record. It has no live Context or running/ended state. */
export class EventRecord extends RuntimeRecord<EventValue> implements EventData {
  readonly executionId: string;
  readonly callId: string;
  readonly sequence: number;
  readonly occurredAt: string;
  readonly offsetMs: number;

  constructor(definition: EventDefinition, value: EventValue) {
    super(Object.freeze({ type: value.type }));
    this.executionId = definition.executionId;
    this.callId = definition.callId;
    this.sequence = definition.sequence;
    this.occurredAt = definition.occurredAt;
    this.offsetMs = definition.offsetMs;
    Object.freeze(this);
  }

  override toJSON(): EventData {
    return { ...super.toJSON(), executionId: this.executionId, callId: this.callId, sequence: this.sequence, occurredAt: this.occurredAt, offsetMs: this.offsetMs };
  }
}
