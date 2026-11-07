import type { DatabaseSync } from 'node:sqlite';
import { cloneCheckpointImage, cloneCheckpointDelivery, checkpointSaveReceipt, checkpointHeadCommit, type CheckpointStore, type CheckpointImage, type CheckpointDelivery, type CheckpointHead, type CheckpointSaveReceipt, type CheckpointFinishReceipt, type CheckpointCommit } from '@capix/checkpoint';
import { isCheckpointRecord, checkpointImageCommit, CheckpointRelationCache } from '@capix/checkpoint/storage';
import { z } from 'zod';
import { RecoveryConflict, requireIdentity, requireRevision, type RecoveryTransaction } from './recovery.js';
import { saveCheckpointFacts, readCheckpointFacts, finishCheckpointFacts } from './checkpoint-facts.js';

export interface ConversationCheckpoints extends CheckpointStore {
  /** Current root facts only; eligibility and the choice to resume belong to the host. */
  listRoots(): readonly CheckpointHead[];
}

const rowSchema = z.strictObject({ context_id: z.string().min(1), revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), image_id: z.string().min(1), delivery: z.string().nullable(), image_context: z.string().min(1), image_revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), body: z.string() });
type CheckpointRow = z.infer<typeof rowSchema>;
const select = 'SELECT h.context_id, h.revision, h.image_id, h.delivery, i.context_id AS image_context, i.revision AS image_revision, i.body FROM checkpoint_heads h LEFT JOIN checkpoint_images i ON i.id = h.image_id';

/** SQL retains the current head and its owned facts; old image rows reserve identities. */
export class SqliteCheckpoints implements ConversationCheckpoints {
  readonly #relations = new CheckpointRelationCache();
  constructor(
    private readonly database: DatabaseSync,
    private readonly transaction: RecoveryTransaction,
  ) {}

  /** Host cleanup only; not part of the public checkpoint persistence port. */
  clearCache(): void {
    this.#relations.clear();
  }

  read(contextId: string): CheckpointHead | undefined {
    requireIdentity(contextId);
    return this.withTransaction('checkpoint.read', () => this.readCurrent(contextId));
  }

  listRoots(): readonly CheckpointHead[] {
    return this.withTransaction('checkpoint.list', () => {
      if (this.database.prepare('SELECT 1 FROM checkpoint_images i LEFT JOIN checkpoint_heads h ON h.context_id = i.context_id WHERE h.context_id IS NULL LIMIT 1').get()) throw new Error('Checkpoint images have no owning head');
      if (this.database.prepare('SELECT 1 FROM checkpoint_values v LEFT JOIN checkpoint_heads h ON h.context_id=v.context_id WHERE h.context_id IS NULL UNION ALL SELECT 1 FROM checkpoint_relations r LEFT JOIN checkpoint_heads h ON h.context_id=r.context_id WHERE h.context_id IS NULL LIMIT 1').get()) throw new Error('Checkpoint facts have no owning head');
      if (this.database.prepare('SELECT 1 FROM checkpoint_selections s LEFT JOIN checkpoint_heads h ON h.context_id=s.context_id WHERE h.context_id IS NULL UNION ALL SELECT 1 FROM checkpoint_occurrences o LEFT JOIN checkpoint_selections s ON s.context_id=o.context_id AND s.id=o.selection_id WHERE s.id IS NULL LIMIT 1').get()) throw new Error('Checkpoint selections have no owning scope');
      const roots: CheckpointHead[] = [];
      // Parent ownership has one source of truth: the verified Frame. Do not add a
      // redundant SQL projection that could silently hide a damaged recovery root.
      for (const row of this.database.prepare(`${select} ORDER BY h.rowid`).iterate()) {
        const checked = rowSchema.parse(row);
        if (!isCheckpointRecord(checked.body)) throw new Error('Unsupported checkpoint storage format');
        const head = readCheckpointFacts(this.database, checked);
        if (head.image.frame.owner.parentContextId === undefined) roots.push(head);
      }
      return Object.freeze(roots);
    });
  }

  save(image: CheckpointImage | CheckpointCommit, expectedRevision: number): CheckpointSaveReceipt {
    if ('kind' in image && image.kind === 'commit') return this.withTransaction('checkpoint.save', () => saveCheckpointFacts(this.database, image, expectedRevision, this.#relations));
    const fixed = cloneCheckpointImage(image);
    requireRevision(expectedRevision);
    this.withTransaction('checkpoint.save', () => {
      const current = this.readCurrent(fixed.frame.owner.contextId);
      return saveCheckpointFacts(this.database, checkpointImageCommit(fixed, current && checkpointHeadCommit(current)), expectedRevision, this.#relations);
    });
    return checkpointSaveReceipt(fixed, expectedRevision + 1);
  }

  finish(contextId: string, expectedRevision: number, delivery: CheckpointDelivery): CheckpointFinishReceipt {
    requireIdentity(contextId);
    requireRevision(expectedRevision);
    const fixed = cloneCheckpointDelivery(delivery);
    try {
      return this.withTransaction('checkpoint.finish', () => {
        const row = this.readRow(contextId);
        if (!row) throw conflict('Cannot finish a checkpoint scope without a saved image');
        if (!isCheckpointRecord(row.body)) throw new Error('Unsupported checkpoint storage format');
        return finishCheckpointFacts(this.database, row, expectedRevision, fixed);
      });
    } finally {
      this.#relations.forget(contextId);
    }
  }

  private withTransaction<Result>(operation: string, work: () => Result): Result {
    try {
      return this.transaction(operation, work);
    } catch (error) {
      // Includes COMMIT failures after the callback and use of a closed host.
      this.clearCache();
      throw error;
    }
  }

  private readCurrent(contextId: string): CheckpointHead | undefined {
    const row = this.readRow(contextId);
    if (!row) return undefined;
    if (!isCheckpointRecord(row.body)) throw new Error('Unsupported checkpoint storage format');
    return readCheckpointFacts(this.database, row);
  }

  private readRow(contextId: string): CheckpointRow | undefined {
    const row = this.database.prepare(`${select} WHERE h.context_id = ?`).get(contextId);
    if (row) return rowSchema.parse(row);
    if (this.database.prepare('SELECT 1 FROM checkpoint_images WHERE context_id = ? LIMIT 1').get(contextId)) throw new Error('Checkpoint images have no owning head');
    if (this.database.prepare('SELECT 1 FROM checkpoint_values WHERE context_id=? UNION ALL SELECT 1 FROM checkpoint_relations WHERE context_id=? UNION ALL SELECT 1 FROM checkpoint_selections WHERE context_id=? UNION ALL SELECT 1 FROM checkpoint_occurrences WHERE context_id=? LIMIT 1').get(contextId, contextId, contextId, contextId)) throw new Error('Checkpoint facts have no owning head');
    return undefined;
  }
}

function conflict(message: string): RecoveryConflict {
  return new RecoveryConflict('CHECKPOINT_CONFLICT', message);
}
