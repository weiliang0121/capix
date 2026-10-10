import { isUndefined } from 'es-toolkit/predicate';
import type { InvocationOrigin } from '@capix/protocol';
import type { ChangeCapture } from '../changes/capture.js';
import { captureChange } from '../changes/publish.js';
import type { EventConsumer } from './observer.js';
import { combineFaults } from './error.js';

export interface ChangeProvenance<Event> {
  readonly origin?: InvocationOrigin;
  readonly observation?: EventConsumer<Event>;
}

/** A committed source fact reaches required capture and optional consumption independently. */
export function publishFact<Event>(event: Event, capture?: ChangeCapture<Event>, observer?: EventConsumer<Event>): void {
  const faults: unknown[] = [];
  try {
    captureChange(capture, event);
  } catch (error) {
    faults.push(error);
  }
  try {
    const error = observer?.publish(event);
    if (!isUndefined(error)) faults.push(error);
  } catch (error) {
    faults.push(error);
  }
  const error = combineFaults(faults);
  if (!isUndefined(error)) throw error;
}
