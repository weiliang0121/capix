import { randomUUID } from 'node:crypto';
import type { CheckpointContract, CheckpointFact, CheckpointInstallation, CheckpointRestoration } from '../checkpoint/contract.js';
import type { InvocationIdentity } from '../invocation/identity.js';
import { cloneCheckpointHead } from '../checkpoint/value.js';
import { ObserverSession } from '../observation/session.js';

/** Read, validate and optionally construct within one observed restoration-preparation boundary. */
export function prepareCheckpointRestoration<Value = never>(installation: CheckpointInstallation | undefined, contract: CheckpointContract | undefined, contextId: string, owner: Omit<InvocationIdentity, 'contextId'>, construct?: (restoration: CheckpointRestoration) => Value): Value | CheckpointRestoration {
  try {
    const restoration = readCheckpoint(installation, contract, contextId, owner);
    return construct ? construct(restoration) : restoration;
  } catch (error) {
    const observation = installation?.observation;
    if (observation) {
      const session = new ObserverSession({ observe: (fact: CheckpointFact) => observation.observe(fact), available: () => true }, observation.failure ?? 'isolate');
      const fact: CheckpointFact = Object.freeze({ kind: 'failed', stage: 'restore' as const, contextId, owner: Object.freeze({ ...owner, contextId }), recovering: true, activityId: randomUUID(), sequence: 1, occurredAt: new Date().toISOString(), error });
      const fault = session.publish((observer) => observer.observe(fact));
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
  if (image.frame.owner.contextId !== contextId || image.frame.owner.level !== owner.level || image.frame.owner.parentContextId !== owner.parentContextId) throw new Error('Checkpoint work belongs to another scope');
  if (head.delivery) throw new Error('A terminal checkpoint work cannot execute again');
  return Object.freeze({ head });
}
