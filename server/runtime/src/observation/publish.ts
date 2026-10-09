import { isUndefined } from 'es-toolkit/predicate';
import type { ChangeCapture } from '../changes/capture.js';
import { captureChange } from '../changes/publish.js';
import type { EventConsumer } from './binding.js';
import { combineFaults } from './error.js';

export interface ChangeProvenance<E> {
  readonly origin?: { readonly contextId: string };
  readonly observation?: EventConsumer<E>;
}

/** A committed source fact reaches required capture and optional consumption independently. */
export function publishFact<E>(event: E, capture?: ChangeCapture<E>, observer?: EventConsumer<E>): void {
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
