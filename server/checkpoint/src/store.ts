import { isEqual } from 'es-toolkit';
import { RuntimeError } from '@capix/contracts';
import type { CheckpointStore, CheckpointImage, CheckpointHead, CheckpointDelivery, CheckpointSaveReceipt, CheckpointFinishReceipt } from './contract.js';
import { cloneCheckpointImage, cloneCheckpointDelivery } from './value.js';
import { checkpointSaveReceipt, checkpointFinishReceipt } from './receipt.js';

/** Deterministic local installation; it provides no guarantee across process loss. */
export class MemoryCheckpointStore implements CheckpointStore {
  readonly #heads = new Map<string, CheckpointHead>();
  readonly #images = new Map<string, CheckpointImage>();

  read(contextId: string): CheckpointHead | undefined {
    requireContext(contextId);
    return this.#heads.get(contextId);
  }

  save(image: CheckpointImage, expectedRevision: number): CheckpointSaveReceipt {
    const fixed = cloneCheckpointImage(image);
    requireRevision(expectedRevision);
    const contextId = fixed.frame.owner.contextId;
    const current = this.#heads.get(contextId);
    requireCurrent(current, expectedRevision);
    if (current && (!isEqual(current.image.frame.owner, fixed.frame.owner) || !isEqual(current.image.contract, fixed.contract) || !isEqual(current.image.frame.input, fixed.frame.input))) throw conflict('Checkpoint owner, contract and original input cannot change');
    if (this.#images.has(fixed.id)) throw conflict('Checkpoint identity has already been saved');
    const head = Object.freeze({ revision: expectedRevision + 1, image: fixed });
    this.#images.set(fixed.id, fixed);
    this.#heads.set(contextId, head);
    return checkpointSaveReceipt(fixed, head.revision);
  }

  finish(contextId: string, expectedRevision: number, delivery: CheckpointDelivery): CheckpointFinishReceipt {
    requireContext(contextId);
    requireRevision(expectedRevision);
    const fixed = cloneCheckpointDelivery(delivery);
    const current = this.#heads.get(contextId);
    if (!current) throw conflict('Cannot finish a checkpoint scope without a saved image');
    requireCurrent(current, expectedRevision);
    const head = Object.freeze({ revision: expectedRevision + 1, image: current.image, delivery: fixed });
    this.#heads.set(contextId, head);
    return checkpointFinishReceipt(contextId, current.image.id, fixed, head.revision);
  }
}

function requireCurrent(current: CheckpointHead | undefined, expectedRevision: number): void {
  if ((current?.revision ?? 0) !== expectedRevision) throw conflict('Checkpoint head revision does not match');
  if (current?.delivery) throw conflict('Final checkpoint delivery cannot advance');
}

function requireRevision(revision: number): void {
  if (!Number.isSafeInteger(revision) || revision < 0 || revision >= Number.MAX_SAFE_INTEGER) throw new TypeError('Checkpoint expected revision must be a nonnegative safe integer with room to advance');
}

function requireContext(contextId: string): void {
  if (typeof contextId !== 'string' || contextId.length === 0) throw new TypeError('Checkpoint context identity is required');
}

function conflict(message: string): RuntimeError {
  return new RuntimeError('CHECKPOINT_CONFLICT', message);
}
