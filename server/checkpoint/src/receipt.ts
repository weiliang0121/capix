import type { CheckpointImage, CheckpointDelivery, CheckpointSaveReceipt, CheckpointFinishReceipt } from './contract.js';
import { cloneCheckpointImage, cloneCheckpointDelivery, checkpointImageDigest, checkpointDeliveryDigest } from './value.js';

/** The store returns this only after committing this exact fixed image. */
export function checkpointSaveReceipt(image: CheckpointImage, revision: number): CheckpointSaveReceipt {
  requireRevision(revision);
  const fixed = cloneCheckpointImage(image);
  return Object.freeze({ kind: 'saved', contextId: fixed.frame.owner.contextId, checkpointId: fixed.id, revision, digest: checkpointImageDigest(fixed) });
}

/** The final delivery and last image identity are independently bound to the write. */
export function checkpointFinishReceipt(contextId: string, checkpointId: string, delivery: CheckpointDelivery, revision: number): CheckpointFinishReceipt {
  requireRevision(revision);
  if (typeof contextId !== 'string' || !contextId.length || typeof checkpointId !== 'string' || !checkpointId.length) throw new Error('Checkpoint receipt requires context and image identity');
  const fixed = cloneCheckpointDelivery(delivery);
  return Object.freeze({ kind: 'finished', contextId, checkpointId, revision, status: fixed.status, digest: checkpointDeliveryDigest(fixed) });
}

export function checkCheckpointSaveReceipt(value: unknown, image: CheckpointImage, expectedRevision: number): CheckpointSaveReceipt {
  const expected = checkpointSaveReceipt(image, nextRevision(expectedRevision));
  checkReceipt(value, expected);
  return expected;
}

export function checkCheckpointFinishReceipt(value: unknown, contextId: string, checkpointId: string, delivery: CheckpointDelivery, expectedRevision: number): CheckpointFinishReceipt {
  const expected = checkpointFinishReceipt(contextId, checkpointId, delivery, nextRevision(expectedRevision));
  checkReceipt(value, expected);
  return expected;
}

function checkReceipt(value: unknown, expected: CheckpointSaveReceipt | CheckpointFinishReceipt): void {
  if (!value || typeof value !== 'object' || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) throw new Error('Invalid checkpoint commit receipt');
  const properties = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(properties).length !== Object.keys(expected).length) throw new Error('Invalid checkpoint commit receipt fields');
  for (const [key, entry] of Object.entries(expected)) {
    const property = properties[key];
    if (!property || !('value' in property) || !property.enumerable || property.value !== entry) throw new Error(`Checkpoint commit receipt differs from request: ${key}`);
  }
}

function requireRevision(revision: number): void {
  if (!Number.isSafeInteger(revision) || revision < 1) throw new Error('Invalid checkpoint receipt revision');
}

function nextRevision(expected: number): number {
  if (!Number.isSafeInteger(expected) || expected < 0 || expected >= Number.MAX_SAFE_INTEGER) throw new Error('Invalid checkpoint expected revision');
  return expected + 1;
}
