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
