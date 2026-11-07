import { isEqual } from 'es-toolkit';
import { RuntimeError } from '@capix/contracts';
import type { CheckpointStore, CheckpointImage, CheckpointHead, CheckpointDelivery, CheckpointSaveReceipt, CheckpointFinishReceipt, CheckpointCommit } from './contract.js';
import { cloneCheckpointImage, cloneCheckpointDelivery } from './value.js';
import { checkpointSaveReceipt, checkpointFinishReceipt } from './receipt.js';
import { prepareCheckpointCommit, materializeCheckpointHead, checkpointImageCommit, type CheckpointStoredHead, type CheckpointStoredChild, type CheckpointStoredValue } from './incremental.js';
import { checkpointHeadCommit } from './evidence.js';

/** Deterministic local installation; it provides no guarantee across process loss. */
export class MemoryCheckpointStore implements CheckpointStore {
  readonly #heads = new Map<string, CheckpointHead>();
  // Historical identities remain reserved; only each head retains its image body.
  readonly #usedImageIds = new Set<string>();
  readonly #incremental = new Map<string, { head: CheckpointStoredHead; children: Map<string, CheckpointStoredChild>; orders: Map<number, string>; values: Map<string, { stored: CheckpointStoredValue; body?: string }> }>();

  read(contextId: string): CheckpointHead | undefined {
    requireContext(contextId);
    const current = this.#incremental.get(contextId);
    if (current)
      return materializeCheckpointHead(
        current.head,
        [...current.children.values()],
        [...current.values.values()].filter((entry) => entry.stored.uses > 0).map((entry) => ({ stored: entry.stored, body: entry.body! })),
      );
    return this.#heads.get(contextId);
  }

  save(image: CheckpointImage | CheckpointCommit, expectedRevision: number): CheckpointSaveReceipt {
    if ('kind' in image && image.kind === 'commit') return this.saveChanges(image, expectedRevision);
    const fixed = cloneCheckpointImage(image);
    if (fixed.formatVersion === 6) {
      const current = this.read(fixed.frame.owner.contextId);
      this.saveChanges(checkpointImageCommit(fixed, current && checkpointHeadCommit(current)), expectedRevision);
      return checkpointSaveReceipt(fixed, expectedRevision + 1);
    }
    requireRevision(expectedRevision);
    const contextId = fixed.frame.owner.contextId;
    if (this.#incremental.has(contextId)) throw conflict('Cannot replace v6 facts with a legacy full image');
    const current = this.#heads.get(contextId);
    requireCurrent(current, expectedRevision);
    if (current && (!isEqual(current.image.frame.owner, fixed.frame.owner) || !isEqual(current.image.contract, fixed.contract) || !isEqual(current.image.frame.input, fixed.frame.input))) throw conflict('Checkpoint owner, contract and original input cannot change');
    if (this.#usedImageIds.has(fixed.id)) throw conflict('Checkpoint identity has already been saved');
    const head = Object.freeze({ revision: expectedRevision + 1, image: fixed });
    this.#usedImageIds.add(fixed.id);
    this.#heads.set(contextId, head);
    return checkpointSaveReceipt(fixed, head.revision);
  }

  finish(contextId: string, expectedRevision: number, delivery: CheckpointDelivery): CheckpointFinishReceipt {
    requireContext(contextId);
    requireRevision(expectedRevision);
    const fixed = cloneCheckpointDelivery(delivery);
    const incremental = this.#incremental.get(contextId);
    if (incremental) {
      if (incremental.head.revision !== expectedRevision || incremental.head.delivery) throw conflict('Checkpoint head revision or terminal state differs');
      incremental.head = Object.freeze({ ...incremental.head, revision: expectedRevision + 1, delivery: fixed });
      return checkpointFinishReceipt(contextId, incremental.head.commit.id, fixed, expectedRevision + 1);
    }
    const current = this.#heads.get(contextId);
    if (!current) throw conflict('Cannot finish a checkpoint scope without a saved image');
    requireCurrent(current, expectedRevision);
    const head = Object.freeze({ revision: expectedRevision + 1, image: current.image, delivery: fixed });
    this.#heads.set(contextId, head);
    return checkpointFinishReceipt(contextId, current.image.id, fixed, head.revision);
  }

  private saveChanges(commit: CheckpointCommit, expectedRevision: number): CheckpointSaveReceipt {
    const contextId = commit.frame.owner.contextId;
    if (this.#heads.has(contextId)) throw conflict('Legacy checkpoint scopes cannot advance under stable facts');
    const current = this.#incremental.get(contextId);
    const plan = prepareCheckpointCommit(commit, expectedRevision, {
      head: current?.head,
      value: (id) => current?.values.get(id)?.stored,
      body: (id) => current?.values.get(id)?.body,
      child: (id) => current?.children.get(id),
      order: (order) => current?.orders.get(order),
      imageUsed: (id) => this.#usedImageIds.has(id),
    });
    const next = current ?? { head: plan.head, children: new Map(), orders: new Map(), values: new Map() };
    // All fallible authentication above precedes this synchronous installation.
    for (const entry of plan.values) {
      const body = entry.stored.uses === 0 ? undefined : (entry.body ?? next.values.get(entry.stored.id)?.body);
      next.values.set(entry.stored.id, { stored: entry.stored, ...(body !== undefined ? { body } : {}) });
    }
    for (const entry of plan.children) {
      next.children.set(entry.child.identity.contextId, entry);
      next.orders.set(entry.child.order, entry.child.identity.contextId);
    }
    next.head = plan.head;
    this.#usedImageIds.add(commit.id);
    this.#incremental.set(contextId, next);
    return plan.receipt;
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
