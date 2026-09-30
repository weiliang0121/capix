import { pick } from 'es-toolkit/object';
import type { EventRecord as EventData, EventValue } from '@capix-observer/protocol';
import { BaseRecord } from '../record.js';

export type EventDefinition = Omit<EventData, 'id' | 'value' | 'parentId'>;

/** An immutable boundary record. It has no live Context or running/ended state. */
export class EventRecord extends BaseRecord<EventValue> implements EventData {
  readonly executionId: string;
  readonly callId: string;
  readonly sequence: number;
  readonly occurredAt: string;
  readonly offsetMs: number;

  constructor(definition: EventDefinition, value: EventValue) {
    super(Object.freeze({ type: value.type }), definition.callId);
    this.executionId = definition.executionId;
    this.callId = definition.callId;
    this.sequence = definition.sequence;
    this.occurredAt = definition.occurredAt;
    this.offsetMs = definition.offsetMs;
    Object.freeze(this);
  }

  override toJSON(): EventData {
    return { ...super.toJSON(), ...pick(this, ['executionId', 'callId', 'sequence', 'occurredAt', 'offsetMs']) };
  }
}
