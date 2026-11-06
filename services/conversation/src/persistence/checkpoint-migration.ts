import type { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { cloneCheckpointImage } from '@capix/checkpoint';
import { z } from 'zod';
import { decodeCheckpointStorage } from './checkpoint-storage.js';

const identity = z.string().min(1);
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const imageIdentity = z.object({ id: identity, formatVersion: z.unknown(), contract: z.unknown(), frame: z.object({ owner: z.looseObject({ contextId: identity }), input: z.unknown() }) });
const savedRow = z.object({ id: identity, context_id: identity, revision, body: z.string(), image_id: identity, head_revision: revision, delivery: z.string().nullable() });

/** Caller owns the opening transaction. Validate every body before discarding any of them. */
export function retainCheckpointHeads(database: DatabaseSync): void {
  if (database.prepare('SELECT 1 FROM checkpoint_heads h LEFT JOIN checkpoint_images i ON i.id = h.image_id WHERE i.id IS NULL OR i.context_id != h.context_id LIMIT 1').get()) throw new Error('Checkpoint head has no matching image');
  let previousContext: string | undefined;
  let expectedRevision = 1;
  let reachedHead = false;
  let baseline: { owner: unknown; contract: unknown; input: unknown } | undefined;
  for (const value of database.prepare('SELECT i.*, h.image_id, h.revision AS head_revision, h.delivery FROM checkpoint_images i LEFT JOIN checkpoint_heads h ON h.context_id = i.context_id ORDER BY i.context_id, i.revision').iterate()) {
    const row = savedRow.parse(value);
    if (previousContext !== row.context_id) {
      if (previousContext !== undefined && !reachedHead) throw new Error('Checkpoint history has no current head');
      previousContext = row.context_id;
      expectedRevision = 1;
      reachedHead = false;
      baseline = undefined;
      // Delivery formats may be older than the current recovery contract. This is
      // bounded storage validation, not permission to execute their contents.
      if (row.delivery !== null) decodeCheckpointStorage(row.delivery);
    }
    if (reachedHead || row.revision !== expectedRevision) throw new Error('Checkpoint history does not match its head');
    const decoded = decodeCheckpointStorage(row.body);
    const image = imageIdentity.parse(decoded);
    if (image.formatVersion === 5) cloneCheckpointImage(decoded);
    if (image.id !== row.id || image.frame.owner.contextId !== row.context_id) throw new Error('Checkpoint identity differs from its row');
    const fixed = { owner: image.frame.owner, contract: image.contract, input: image.frame.input };
    if (baseline && !isDeepStrictEqual(fixed, baseline)) throw new Error('Checkpoint history changed its owner, contract or original input');
    baseline = fixed;
    if (row.id === row.image_id) {
      if (row.head_revision !== row.revision + (row.delivery === null ? 0 : 1)) throw new Error('Checkpoint revision differs from its delivery');
      reachedHead = true;
    }
    expectedRevision++;
  }
  if (previousContext !== undefined && !reachedHead) throw new Error('Checkpoint history has no current head');

  // Keep foreign keys enabled. Copy the new pair first, drop the old child table
  // before its referenced table, then rename. Head bytes and all IDs stay exact.
  database.exec(`
    CREATE TABLE retained_checkpoint_images (
      id TEXT PRIMARY KEY,
      context_id TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK (revision > 0),
      body TEXT CHECK (body IS NULL OR json_valid(body)),
      UNIQUE (context_id, revision)
    ) STRICT;
    CREATE TABLE retained_checkpoint_heads (
      context_id TEXT PRIMARY KEY,
      revision INTEGER NOT NULL CHECK (revision > 0),
      image_id TEXT NOT NULL UNIQUE REFERENCES retained_checkpoint_images(id),
      delivery TEXT CHECK (delivery IS NULL OR json_valid(delivery))
    ) STRICT;
    INSERT INTO retained_checkpoint_images
      SELECT i.id, i.context_id, i.revision, CASE WHEN i.id = h.image_id THEN i.body ELSE NULL END
      FROM checkpoint_images i JOIN checkpoint_heads h ON h.context_id = i.context_id ORDER BY i.rowid;
    INSERT INTO retained_checkpoint_heads SELECT * FROM checkpoint_heads ORDER BY rowid;
    DROP TABLE checkpoint_heads;
    DROP TABLE checkpoint_images;
    ALTER TABLE retained_checkpoint_images RENAME TO checkpoint_images;
    ALTER TABLE retained_checkpoint_heads RENAME TO checkpoint_heads;
  `);
  if (database.prepare('PRAGMA foreign_key_check').get()) throw new Error('Checkpoint migration violated a persisted reference');
}
