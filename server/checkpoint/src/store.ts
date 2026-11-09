import { RuntimeError } from '@weiliang0121/capix-contracts';
import type { CheckpointStore, CheckpointImage, CheckpointHead, CheckpointDelivery, CheckpointSaveReceipt, CheckpointFinishReceipt, CheckpointCommit } from './contract.js';
import { cloneCheckpointImage, cloneCheckpointDelivery } from './value.js';
import { checkpointSaveReceipt, checkpointFinishReceipt } from './receipt.js';
import { prepareCheckpointCommit, materializeCheckpointHead, checkpointImageCommit, type CheckpointStoredHead, type CheckpointStoredChild, type CheckpointStoredValue } from './incremental.js';
import { checkpointHeadCommit } from './evidence.js';
import { isCheckpointSelectionSlots, checkpointSelectionReferences, type CheckpointStoredSelection, type CheckpointStoredOccurrence } from './selections.js';

/** Deterministic local installation; it provides no guarantee across process loss. */
export class MemoryCheckpointStore implements CheckpointStore {
  // Historical identities remain reserved; only each head retains its image body.
  readonly #usedImageIds = new Set<string>();
  readonly #incremental = new Map<string, { head: CheckpointStoredHead; children: Map<string, CheckpointStoredChild>; orders: Map<number, string>; values: Map<string, { stored: CheckpointStoredValue; body?: string }>; selections: Map<string, { head: CheckpointStoredSelection; active: Map<string, CheckpointStoredOccurrence>; reserved: Map<string, number> }> }>();

  read(contextId: string): CheckpointHead | undefined {
    requireContext(contextId);
    const current = this.#incremental.get(contextId);
    if (current)
      return materializeCheckpointHead(
        current.head,
        [...current.children.values()],
        [...current.values.values()].filter((entry) => entry.stored.uses > 0).map((entry) => ({ stored: entry.stored, body: entry.body! })),
        isCheckpointSelectionSlots(current.head.commit.references)
          ? checkpointSelectionReferences(current.head.commit.references).map(({ id }) => {
              const source = current.selections.get(id);
              if (!source) throw new Error('Missing checkpoint selection');
              return { head: source.head, occurrences: [...source.reserved].map(([id, order]) => source.active.get(id) ?? { id, order }) };
            })
          : [],
      );
    return undefined;
  }

  save(image: CheckpointImage | CheckpointCommit, expectedRevision: number): CheckpointSaveReceipt {
    if ('kind' in image && image.kind === 'commit') return this.saveChanges(image, expectedRevision);
    const fixed = cloneCheckpointImage(image);
    const current = this.read(fixed.frame.owner.contextId);
    this.saveChanges(checkpointImageCommit(fixed, current && checkpointHeadCommit(current)), expectedRevision);
    return checkpointSaveReceipt(fixed, expectedRevision + 1);
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
    throw conflict('Cannot finish a checkpoint scope without a saved image');
  }

  private saveChanges(commit: CheckpointCommit, expectedRevision: number): CheckpointSaveReceipt {
    const contextId = commit.frame.owner.contextId;
    const current = this.#incremental.get(contextId);
    const plan = prepareCheckpointCommit(commit, expectedRevision, {
      head: current?.head,
      value: (id) => current?.values.get(id)?.stored,
      body: (id) => current?.values.get(id)?.body,
      child: (id) => current?.children.get(id),
      order: (order) => current?.orders.get(order),
      imageUsed: (id) => this.#usedImageIds.has(id),
      selection: (id) => current?.selections.get(id)?.head,
      occurrence: (selection, id) => {
        const source = current?.selections.get(selection);
        const order = source?.reserved.get(id);
        return source?.active.get(id) ?? (order === undefined ? undefined : { id, order });
      },
    });
    const next = current ?? { head: plan.head, children: new Map(), orders: new Map(), values: new Map(), selections: new Map() };
    // All fallible authentication above precedes this synchronous installation.
    for (const entry of plan.values) {
      const body = entry.stored.uses === 0 ? undefined : (entry.body ?? next.values.get(entry.stored.id)?.body);
      next.values.set(entry.stored.id, { stored: entry.stored, ...(body !== undefined ? { body } : {}) });
    }
    for (const entry of plan.children) {
      next.children.set(entry.child.identity.contextId, entry);
      next.orders.set(entry.child.order, entry.child.identity.contextId);
    }
    for (const change of plan.selections) {
      const source = next.selections.get(change.head.id) ?? { head: change.head, active: new Map<string, CheckpointStoredOccurrence>(), reserved: new Map<string, number>() };
      if (change.reset) source.active.clear();
      for (const id of change.remove) source.active.delete(id);
      for (const item of change.append) {
        source.active.set(item.id, item);
        source.reserved.set(item.id, item.order);
      }
      source.head = change.head;
      next.selections.set(change.head.id, source);
    }
    next.head = plan.head;
    this.#usedImageIds.add(commit.id);
    this.#incremental.set(contextId, next);
    return plan.receipt;
  }
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
