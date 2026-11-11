import type { CheckpointInstallation, Clock } from '@weiliang0121/capix-invocation';
import type { InvocationEvent } from '@weiliang0121/capix-invocation/events';
import type { ChangeCapture } from '@weiliang0121/capix-changes';
import type { ObservationInstallation } from '../binding/observation.js';

/** Stable capabilities supplied at assembly, never threaded through business call arguments. */
export interface InvocationCapabilities {
  readonly clock?: Clock;
  readonly checkpoints?: CheckpointInstallation;
  readonly observations?: readonly ObservationInstallation[];
  readonly changes?: ChangeCapture<InvocationEvent>;
}

/** Keep mechanism selections fixed while their providers retain their own state and receivers. */
export function snapshotInvocationCapabilities(options: InvocationCapabilities): InvocationCapabilities {
  const observation = options.checkpoints?.observation;
  const feedback = options.checkpoints?.feedback;
  return Object.freeze({
    ...options,
    observations: options.observations ? Object.freeze([...options.observations]) : undefined,
    checkpoints: options.checkpoints
      ? Object.freeze({
          store: options.checkpoints.store,
          observation: observation ? Object.freeze({ observe: observation.observe.bind(observation), failure: observation.failure }) : undefined,
          feedback: feedback ? Object.freeze({ receive: feedback.receive.bind(feedback), failed: feedback.failed?.bind(feedback) }) : undefined,
        })
      : undefined,
  });
}
