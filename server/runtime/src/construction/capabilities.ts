import type { CheckpointInstallation, Clock } from '@capix/invocation';
import type { InvocationEvent } from '@capix/protocol';
import type { ChangeCapture } from '@capix/changes';
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
