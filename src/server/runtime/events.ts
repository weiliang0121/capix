import type { RecordEvent } from '../../shared/records.js';
import type { Clock } from './clock.js';

/** Existing event history and timing origin only; no records, indexes or active-state copy. */
export interface ExecutionEvents {
  readonly start: number;
  readonly events: RecordEvent[];
}

export function createExecutionEvents(clock: Clock): ExecutionEvents {
  return { start: clock.tick(), events: [] };
}

export function appendRecordEvent(history: ExecutionEvents, clock: Clock, callId: string, type: RecordEvent['type']): void {
  history.events.push({
    sequence: history.events.length + 1,
    callId,
    type,
    offsetMs: clock.tick() - history.start,
  });
}
