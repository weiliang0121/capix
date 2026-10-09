import type { Clock } from '../runtime/clock.js';
import type { InvocationEvent } from '@capix-observer/protocol';
import type { ChangeCapture } from '../changes/capture.js';
import type { ObservationInstallation } from '../observation/binding.js';

/** Stable capabilities supplied at assembly, never threaded through business call arguments. */
export interface InvocationCapabilities {
  readonly clock?: Clock;
  readonly observations?: readonly ObservationInstallation[];
  readonly changes?: ChangeCapture<InvocationEvent>;
}
