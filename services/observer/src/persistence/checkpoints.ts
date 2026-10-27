import type { DatabaseSync } from 'node:sqlite';
import { isEqual } from 'es-toolkit';
import { RuntimeError } from '@capix/contracts';
import { cloneCheckpointImage, cloneCheckpointDelivery, CHECKPOINT_MAX_BYTES } from '@capix/checkpoint';
import type { CheckpointStore, CheckpointImage, CheckpointHead, CheckpointDelivery } from '@capix/checkpoint';

type Row = Record<string, string | number | bigint | Uint8Array | null>;

/** Uses the host's single-writer connection; checkpoint commits never include content or records. */
export class SqliteCheckpointStore implements CheckpointStore {
  constructor(private readonly database: DatabaseSync) {
    this.transaction(() =>
      this.database.exec(`
      CREATE TABLE IF NOT EXISTS checkpoint_images (
        id TEXT PRIMARY KEY,
        context_id TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision > 0),
        body TEXT NOT NULL,
        UNIQUE (context_id, revision)
      );
      CREATE TABLE IF NOT EXISTS checkpoint_heads (
        context_id TEXT PRIMARY KEY,
        revision INTEGER NOT NULL CHECK (revision > 0),
        image_id TEXT NOT NULL REFERENCES checkpoint_images(id),
        delivery TEXT
      );
    `),
    );
  }

  read(contextId: string): CheckpointHead | undefined {
    requireContext(contextId);
    try {
      return this.readHead(contextId);
    } catch (cause) {
      if (cause instanceof RuntimeError && cause.code === 'CHECKPOINT_FORMAT_UNSUPPORTED') throw cause;
      throw storageFailure(cause);
    }
  }

  save(image: CheckpointImage, expectedRevision: number): CheckpointHead {
    const fixed = cloneCheckpointImage(image);
    requireRevision(expectedRevision);
    return this.transaction(() => {
      const contextId = fixed.frame.owner.contextId;
      const current = this.readHead(contextId);
      requireCurrent(current, expectedRevision);
      if (current && (!isEqual(current.image.frame.owner, fixed.frame.owner) || !isEqual(current.image.contract, fixed.contract) || !isEqual(current.image.frame.input, fixed.frame.input))) throw conflict('Checkpoint owner, contract and original input cannot change');
      if (this.database.prepare('SELECT 1 FROM checkpoint_images WHERE id = ?').get(fixed.id)) throw conflict('Checkpoint identity has already been saved');
      const revision = expectedRevision + 1;
      requireWrite(this.database.prepare('INSERT INTO checkpoint_images(id, context_id, revision, body) VALUES (?, ?, ?, ?)').run(fixed.id, contextId, revision, JSON.stringify(fixed)).changes);
      if (current) {
        requireWrite(this.database.prepare('UPDATE checkpoint_heads SET revision = ?, image_id = ? WHERE context_id = ? AND revision = ? AND delivery IS NULL').run(revision, fixed.id, contextId, expectedRevision).changes);
      } else {
        requireWrite(this.database.prepare('INSERT INTO checkpoint_heads(context_id, revision, image_id) VALUES (?, ?, ?)').run(contextId, revision, fixed.id).changes);
      }
      return Object.freeze({ revision, image: fixed });
    });
  }

  finish(contextId: string, expectedRevision: number, delivery: CheckpointDelivery): CheckpointHead {
    requireContext(contextId);
    requireRevision(expectedRevision);
    const fixed = cloneCheckpointDelivery(delivery);
    return this.transaction(() => {
      const current = this.readHead(contextId);
      if (!current) throw conflict('Cannot finish a checkpoint scope without a saved image');
      requireCurrent(current, expectedRevision);
      const revision = expectedRevision + 1;
      requireWrite(this.database.prepare('UPDATE checkpoint_heads SET revision = ?, delivery = ? WHERE context_id = ? AND revision = ? AND delivery IS NULL').run(revision, JSON.stringify(fixed), contextId, expectedRevision).changes);
      return Object.freeze({ revision, image: current.image, delivery: fixed });
    });
  }

  private readHead(contextId: string): CheckpointHead | undefined {
    const row = this.database.prepare('SELECT h.context_id, h.revision, h.image_id, h.delivery, i.context_id AS image_context_id, i.revision AS image_revision, i.body FROM checkpoint_heads h LEFT JOIN checkpoint_images i ON i.id = h.image_id WHERE h.context_id = ?').get(contextId);
    if (!row) {
      if (this.database.prepare('SELECT 1 FROM checkpoint_images WHERE context_id = ? LIMIT 1').get(contextId)) throw new Error('Stored checkpoint head is missing');
      return undefined;
    }
    return decodeHead(row);
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

function decodeHead(row: Row): CheckpointHead {
  if (typeof row.body !== 'string' || typeof row.revision !== 'number' || !Number.isSafeInteger(row.revision) || row.revision < 1 || typeof row.image_revision !== 'number' || !Number.isSafeInteger(row.image_revision) || row.image_revision < 1) throw new Error('Invalid stored checkpoint head');
  const image = cloneCheckpointImage(parse(row.body));
  if (image.id !== row.image_id || image.frame.owner.contextId !== row.context_id || row.image_context_id !== row.context_id) throw new Error('Stored checkpoint identity does not match');
  if (row.delivery === null) {
    if (row.revision !== row.image_revision) throw new Error('Stored checkpoint revision does not match');
    return Object.freeze({ revision: row.revision, image });
  }
  if (typeof row.delivery !== 'string' || row.revision !== row.image_revision + 1) throw new Error('Invalid stored checkpoint delivery revision');
  const delivery = cloneCheckpointDelivery(parse(row.delivery));
  return Object.freeze({ revision: row.revision, image, delivery });
}

function requireCurrent(current: CheckpointHead | undefined, expectedRevision: number): void {
  if ((current?.revision ?? 0) !== expectedRevision) throw conflict('Checkpoint head revision does not match');
  if (current?.delivery) throw conflict('Final checkpoint delivery cannot advance');
}

function requireWrite(changes: number | bigint): void {
  if (changes !== 1 && changes !== 1n) throw new Error('Checkpoint mutation did not affect exactly one row');
}

function parse(value: string): unknown {
  if (Buffer.byteLength(value, 'utf8') > CHECKPOINT_MAX_BYTES) throw new Error('Stored checkpoint body exceeds the byte limit');
  return JSON.parse(value);
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
