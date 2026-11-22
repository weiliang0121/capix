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

// Identify the complete former host surface without reading any member or importing the host package.
const interactionHostMembers = ['register', 'bind', 'active', 'pendingCount', 'settled', 'close'] as const;

export function checkBuildArguments(args: IArguments, signature: string): void {
  const options: unknown = args[2];
  const optionObject = (options !== null && typeof options === 'object') || typeof options === 'function';
  if (args.length <= 3 && (options === undefined || (optionObject && !Array.isArray(options) && !interactionHostMembers.every((member) => member in options)))) return;
  throw new TypeError(`Use ${signature}. To migrate an old call, remove the Interactions argument and pass any options directly after resources. Keep existing resource supplies. Replace former registerInteraction registrations with resources.registerBinding(offer, () => interactions.bind(contract)).`);
}

/** Keep mechanism selections fixed while their providers retain their own state and receivers. */
export function snapshotInvocationCapabilities(options: InvocationCapabilities, clock = options.clock): InvocationCapabilities {
  const checkpoints = options.checkpoints;
  const observations = options.observations;
  const observation = checkpoints?.observation;
  const feedback = checkpoints?.feedback;
  return Object.freeze({
    clock,
    changes: options.changes,
    observations: observations ? Object.freeze([...observations]) : undefined,
    checkpoints: checkpoints
      ? Object.freeze({
          store: checkpoints.store,
          observation: observation ? Object.freeze({ observe: observation.observe.bind(observation), failure: observation.failure }) : undefined,
          feedback: feedback ? Object.freeze({ receive: feedback.receive.bind(feedback), failed: feedback.failed?.bind(feedback) }) : undefined,
        })
      : undefined,
  });
}
