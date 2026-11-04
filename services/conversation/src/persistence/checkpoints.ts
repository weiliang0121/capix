import type { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { cloneCheckpointImage, cloneCheckpointDelivery, type CheckpointStore, type CheckpointImage, type CheckpointDelivery, type CheckpointHead } from '@capix/checkpoint';
import { z } from 'zod';
import { RecoveryConflict, requireIdentity, requireRevision, type RecoveryTransaction } from './recovery.js';
import { encodeCheckpointStorage, decodeCheckpointImage, decodeCheckpointDelivery } from './checkpoint-storage.js';

export interface ConversationCheckpoints extends CheckpointStore {
  /** Current root facts only; eligibility and the choice to resume belong to the host. */
  listRoots(): readonly CheckpointHead[];
}

const rowSchema = z.strictObject({ context_id: z.string().min(1), revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), image_id: z.string().min(1), delivery: z.string().nullable(), image_context: z.string().min(1), image_revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), body: z.string() });
const select = 'SELECT h.context_id, h.revision, h.image_id, h.delivery, i.context_id AS image_context, i.revision AS image_revision, i.body FROM checkpoint_heads h LEFT JOIN checkpoint_images i ON i.id = h.image_id';

/** SQL stores immutable images and advances a single CAS head per invocation. */
export class SqliteCheckpoints implements ConversationCheckpoints {
  constructor(
    private readonly database: DatabaseSync,
    private readonly transaction: RecoveryTransaction,
  ) {}

  read(contextId: string): CheckpointHead | undefined {
    requireIdentity(contextId);
    return this.transaction('checkpoint.read', () => this.readCurrent(contextId));
  }

  listRoots(): readonly CheckpointHead[] {
    return this.transaction('checkpoint.list', () => {
      if (this.database.prepare('SELECT 1 FROM checkpoint_images i LEFT JOIN checkpoint_heads h ON h.context_id = i.context_id WHERE h.context_id IS NULL LIMIT 1').get()) throw new Error('Checkpoint images have no owning head');
      const roots: CheckpointHead[] = [];
      // Parent ownership has one source of truth: the verified Frame. Do not add a
      // redundant SQL projection that could silently hide a damaged recovery root.
      for (const row of this.database.prepare(`${select} ORDER BY h.rowid`).iterate()) {
        const head = decodeHead(row);
        if (head.image.frame.owner.parentContextId === undefined) roots.push(head);
      }
      return Object.freeze(roots);
    });
  }

  save(image: CheckpointImage, expectedRevision: number): CheckpointHead {
    const fixed = cloneCheckpointImage(image);
    requireRevision(expectedRevision);
    return this.transaction('checkpoint.save', () => {
      const contextId = fixed.frame.owner.contextId;
      const current = this.readCurrent(contextId);
      requireCurrent(current, expectedRevision);
      if (current && (!isDeepStrictEqual(current.image.frame.owner, fixed.frame.owner) || !isDeepStrictEqual(current.image.contract, fixed.contract) || !isDeepStrictEqual(current.image.frame.input, fixed.frame.input))) throw conflict('Checkpoint owner, contract and original input cannot change');
      if (this.database.prepare('SELECT 1 FROM checkpoint_images WHERE id = ?').get(fixed.id)) throw conflict('Checkpoint identity has already been saved');
      const revision = expectedRevision + 1;
      this.database.prepare('INSERT INTO checkpoint_images (id, context_id, revision, body) VALUES (?, ?, ?, ?)').run(fixed.id, contextId, revision, encodeCheckpointStorage(fixed));
      if (current) {
        const result = this.database.prepare('UPDATE checkpoint_heads SET revision = ?, image_id = ? WHERE context_id = ? AND revision = ? AND delivery IS NULL').run(revision, fixed.id, contextId, expectedRevision);
        if (result.changes !== 1) throw new Error('Checkpoint head changed during exclusive commit');
      } else this.database.prepare('INSERT INTO checkpoint_heads (context_id, revision, image_id) VALUES (?, ?, ?)').run(contextId, revision, fixed.id);
      return Object.freeze({ revision, image: fixed });
    });
  }

  finish(contextId: string, expectedRevision: number, delivery: CheckpointDelivery): CheckpointHead {
    requireIdentity(contextId);
    requireRevision(expectedRevision);
    const fixed = cloneCheckpointDelivery(delivery);
    return this.transaction('checkpoint.finish', () => {
      const current = this.readCurrent(contextId);
      if (!current) throw conflict('Cannot finish a checkpoint scope without a saved image');
      requireCurrent(current, expectedRevision);
      const revision = expectedRevision + 1;
      const result = this.database.prepare('UPDATE checkpoint_heads SET revision = ?, delivery = ? WHERE context_id = ? AND revision = ? AND delivery IS NULL').run(revision, encodeCheckpointStorage(fixed), contextId, expectedRevision);
      if (result.changes !== 1) throw new Error('Checkpoint head changed during exclusive commit');
      return Object.freeze({ revision, image: current.image, delivery: fixed });
    });
  }

  private readCurrent(contextId: string): CheckpointHead | undefined {
    const row = this.database.prepare(`${select} WHERE h.context_id = ?`).get(contextId);
    if (row) return decodeHead(row);
    if (this.database.prepare('SELECT 1 FROM checkpoint_images WHERE context_id = ? LIMIT 1').get(contextId)) throw new Error('Checkpoint images have no owning head');
    return undefined;
  }
}

function decodeHead(value: unknown): CheckpointHead {
  const row = rowSchema.parse(value);
  const image = decodeCheckpointImage(row.body);
  const delivery = row.delivery === null ? undefined : decodeCheckpointDelivery(row.delivery);
  if (image.id !== row.image_id || image.frame.owner.contextId !== row.context_id || row.image_context !== row.context_id || row.revision !== row.image_revision + (delivery ? 1 : 0)) throw new Error('Persisted checkpoint differs from its head');
  return Object.freeze({ revision: row.revision, image, ...(delivery ? { delivery } : {}) });
}

function requireCurrent(current: CheckpointHead | undefined, expectedRevision: number): void {
  if ((current?.revision ?? 0) !== expectedRevision) throw conflict('Checkpoint head revision does not match');
  if (current?.delivery) throw conflict('Final checkpoint delivery cannot advance');
}

function conflict(message: string): RecoveryConflict {
  return new RecoveryConflict('CHECKPOINT_CONFLICT', message);
}
