import { isUndefined } from 'es-toolkit/predicate';
import type { InvocationOrigin } from '@weiliang0121/capix-contracts';
import type { EventConsumer } from './consumer.js';
import { combineFaults } from './error.js';
import type { ChangeCapture } from './capture.js';
import { ChangeCaptureError } from './error.js';
/** The producer calls this only after the represented change is formally applied. */
export function captureChange<Event>(capture: ChangeCapture<Event> | undefined, event: Event): void {
  try {
    capture?.capture(event);
  } catch (cause) {
    throw new ChangeCaptureError(event, cause);
  }
}

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
