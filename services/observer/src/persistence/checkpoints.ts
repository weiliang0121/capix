import type { DatabaseSync } from 'node:sqlite';
import { RuntimeError } from '@capix/contracts';
import { cloneCheckpointImage, cloneCheckpointDelivery, checkpointSaveReceipt, checkpointHeadCommit } from '@capix/checkpoint';
import type { CheckpointStore, CheckpointImage, CheckpointHead, CheckpointDelivery, CheckpointSaveReceipt, CheckpointFinishReceipt, CheckpointCommit } from '@capix/checkpoint';
import { checkpointImageCommit, CheckpointRelationCache } from '@capix/checkpoint/storage';
import { initializeCheckpointSchema } from './checkpoint-schema.js';
import { initializeCheckpointFacts, saveCheckpointFacts, readCheckpointFacts, finishCheckpointFacts } from './checkpoint-facts.js';

/** Uses the host's single-writer connection; checkpoint commits never include content or records. */
export class SqliteCheckpointStore implements CheckpointStore {
  readonly #relations = new CheckpointRelationCache();
  constructor(private readonly database: DatabaseSync) {
    this.transaction(() => {
      initializeCheckpointSchema(this.database);
      initializeCheckpointFacts(this.database);
    });
  }

  read(contextId: string): CheckpointHead | undefined {
    requireContext(contextId);
    try {
      return this.readHead(contextId);
    } catch (cause) {
      this.#relations.clear();
      if (cause instanceof RuntimeError && cause.code === 'CHECKPOINT_FORMAT_UNSUPPORTED') throw cause;
      throw storageFailure(cause);
    }
  }

  save(image: CheckpointImage | CheckpointCommit, expectedRevision: number): CheckpointSaveReceipt {
    if ('kind' in image && image.kind === 'commit') return this.transaction(() => saveCheckpointFacts(this.database, image, expectedRevision, this.#relations));
    const fixed = cloneCheckpointImage(image);
    requireRevision(expectedRevision);
    this.transaction(() => {
      const current = this.readHead(fixed.frame.owner.contextId);
      return saveCheckpointFacts(this.database, checkpointImageCommit(fixed, current && checkpointHeadCommit(current)), expectedRevision, this.#relations);
    });
    return checkpointSaveReceipt(fixed, expectedRevision + 1);
  }

  finish(contextId: string, expectedRevision: number, delivery: CheckpointDelivery): CheckpointFinishReceipt {
    requireContext(contextId);
    requireRevision(expectedRevision);
    const fixed = cloneCheckpointDelivery(delivery);
    try {
      return this.transaction(() => {
        const row = this.database.prepare('SELECT h.context_id,h.revision,h.image_id,h.delivery,i.context_id AS image_context,i.revision AS image_revision,i.body FROM checkpoint_heads h LEFT JOIN checkpoint_images i ON i.id=h.image_id WHERE h.context_id=?').get(contextId);
        if (!row) throw conflict('Cannot finish a checkpoint scope without a saved image');
        return finishCheckpointFacts(this.database, row, expectedRevision, fixed);
      });
    } finally {
      this.#relations.forget(contextId);
    }
  }

  private readHead(contextId: string): CheckpointHead | undefined {
    const row = this.database.prepare('SELECT h.context_id, h.revision, h.image_id, h.delivery, i.context_id AS image_context_id, i.revision AS image_revision, i.body FROM checkpoint_heads h LEFT JOIN checkpoint_images i ON i.id = h.image_id WHERE h.context_id = ?').get(contextId);
    if (!row) {
      if (this.database.prepare('SELECT 1 FROM checkpoint_images WHERE context_id = ? LIMIT 1').get(contextId)) throw new Error('Stored checkpoint head is missing');
      if (this.database.prepare('SELECT 1 FROM checkpoint_values WHERE context_id=? UNION ALL SELECT 1 FROM checkpoint_relations WHERE context_id=? UNION ALL SELECT 1 FROM checkpoint_selections WHERE context_id=? UNION ALL SELECT 1 FROM checkpoint_occurrences WHERE context_id=? LIMIT 1').get(contextId, contextId, contextId, contextId)) throw new Error('Stored checkpoint facts head is missing');
      return undefined;
    }
    return readCheckpointFacts(this.database, row);
  }

  private transaction<Result>(work: () => Result): Result {
    let begun = false;
    try {
      this.database.exec('BEGIN IMMEDIATE');
      begun = true;
      const result = work();
      this.database.exec('COMMIT');
      return result;
    } catch (cause) {
      this.#relations.clear();
      if (begun && this.database.isTransaction) {
        try {
          this.database.exec('ROLLBACK');
        } catch (rollback) {
          throw storageFailure(new AggregateError([cause, rollback], 'Checkpoint transaction and rollback failed'));
        }
      }
      if (cause instanceof RuntimeError && (cause.code === 'CHECKPOINT_CONFLICT' || cause.code === 'CHECKPOINT_FORMAT_UNSUPPORTED')) throw cause;
      throw storageFailure(cause);
    }
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

function storageFailure(cause: unknown): RuntimeError {
  return new RuntimeError('CHECKPOINT_STORAGE_FAILURE', 'Checkpoint storage could not preserve or read its facts', undefined, { cause });
}
