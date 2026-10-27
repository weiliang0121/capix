import { randomUUID } from 'node:crypto';
import type { CheckpointFact, CheckpointInstallation, CheckpointRestoration } from './contract.js';
import type { CheckpointContract } from '@capix/contracts';
import type { InvocationIdentity } from '@capix/contracts';
import { cloneCheckpointHead } from '@capix/checkpoint';
import { ObserverSession } from '../observation/session.js';
import { ProgressChannel } from '@capix/changes';

/** Read, validate and optionally construct within one observed restoration-preparation boundary. */
export function prepareCheckpointRestoration<Value = never>(installation: CheckpointInstallation | undefined, contract: CheckpointContract | undefined, contextId: string, owner: Omit<InvocationIdentity, 'contextId'>, construct?: (restoration: CheckpointRestoration) => Value): Value | CheckpointRestoration {
  try {
    const restoration = readCheckpoint(installation, contract, contextId, owner);
    return construct ? construct(restoration) : restoration;
  } catch (error) {
    const observation = installation?.observation;
    const feedback = installation?.feedback;
    if (observation || feedback) {
      const fact: CheckpointFact = Object.freeze({ kind: 'failed', stage: 'restore' as const, contextId, owner: Object.freeze({ ...owner, contextId }), recovering: true, activityId: randomUUID(), sequence: 1, occurredAt: new Date().toISOString(), error });
      if (feedback) new ProgressChannel(feedback).publish(fact);
      const session = observation ? new ObserverSession({ observe: (fact: CheckpointFact) => observation.observe(fact), available: () => true }, observation.failure ?? 'isolate') : undefined;
      const fault = session?.publish((observer) => observer.observe(fact));
      if (fault !== undefined) throw new AggregateError([error, fault], 'Checkpoint construction and its observation both failed', { cause: error });
    }
    throw error;
  }
}

/** Select an immutable saved work; never infer a replacement input, owner or terminal state. */
function readCheckpoint(installation: CheckpointInstallation | undefined, contract: CheckpointContract | undefined, contextId: string, owner: Omit<InvocationIdentity, 'contextId'>): CheckpointRestoration {
  if (!installation) throw new Error('Checkpoint persistence is not installed');
  if (!contract) throw new Error('This declaration does not support checkpoints');
  const saved = installation.store.read(contextId);
  if (!saved) throw new Error('Checkpoint work is unavailable');
  const head = cloneCheckpointHead(saved);
  const image = head.image;
  if (image.contract.key !== contract.key || image.contract.version !== contract.version) throw new Error('Checkpoint declaration is incompatible');
  if (image.frame.owner.contextId !== contextId || image.frame.owner.kind !== owner.kind || image.frame.owner.parentContextId !== owner.parentContextId) throw new Error('Checkpoint work belongs to another scope');
  if (head.delivery) throw new Error('A terminal checkpoint work cannot execute again');
  if (image.frame.round !== 1 || image.frame.continuation !== undefined) throw new Error('Checkpoint belongs to the retired multi-round execution model');
  return Object.freeze({ head });
}
