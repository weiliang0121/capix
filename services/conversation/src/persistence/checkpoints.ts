import type { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { cloneCheckpointImage, cloneCheckpointDelivery, cloneCheckpointValue, checkpointSaveReceipt, checkpointFinishReceipt, checkpointHeadCommit, type CheckpointStore, type CheckpointImage, type CheckpointDelivery, type CheckpointHead, type CheckpointSaveReceipt, type CheckpointFinishReceipt, type CheckpointCommit } from '@capix/checkpoint';
import { isCheckpointRecord, checkpointImageCommit } from '@capix/checkpoint/storage';
import { z } from 'zod';
import { RecoveryConflict, requireIdentity, requireRevision, type RecoveryTransaction } from './recovery.js';
import { encodeCheckpointStorage, decodeCheckpointImage, decodeCheckpointDelivery } from './checkpoint-storage.js';
import { saveCheckpointFacts, readCheckpointFacts, finishCheckpointFacts } from './checkpoint-facts.js';

export interface ConversationCheckpoints extends CheckpointStore {
  /** Current root facts only; eligibility and the choice to resume belong to the host. */
  listRoots(): readonly CheckpointHead[];
}

const rowSchema = z.strictObject({ context_id: z.string().min(1), revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), image_id: z.string().min(1), delivery: z.string().nullable(), image_context: z.string().min(1), image_revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), body: z.string() });
type CheckpointRow = z.infer<typeof rowSchema>;
type StableBasis = Pick<CheckpointImage, 'contract'> & { readonly owner: CheckpointImage['frame']['owner']; readonly input: CheckpointImage['frame']['input'] };
type AdvanceBasis = StableBasis & { readonly revision: number; readonly imageId: string; readonly terminal: boolean };
type CachedBasis = { readonly row: CheckpointRow; readonly basis: AdvanceBasis; readonly stableBytes: number; readonly weight: number };
const maxCachedEntries = 64;
const maxCachedBytes = 16 * 1024 * 1024;

const select = 'SELECT h.context_id, h.revision, h.image_id, h.delivery, i.context_id AS image_context, i.revision AS image_revision, i.body FROM checkpoint_heads h LEFT JOIN checkpoint_images i ON i.id = h.image_id';

/** SQL retains one complete image per invocation; old rows only reserve their identities. */
export class SqliteCheckpoints implements ConversationCheckpoints {
  // Derived evidence only. Every hit first reads and compares the complete SQL row.
  // Hold stable advancement fields, never a Frame/children or terminal delivery.
  // The byte charge bounds encoded retained material, not exact JavaScript RSS.
  #previous = new Map<string, CachedBasis>();
  #cachedBytes = 0;
  constructor(
    private readonly database: DatabaseSync,
    private readonly transaction: RecoveryTransaction,
  ) {}

  /** Host cleanup only; not part of the public checkpoint persistence port. */
  clearCache(): void {
    this.#previous.clear();
    this.#cachedBytes = 0;
  }

  read(contextId: string): CheckpointHead | undefined {
    requireIdentity(contextId);
    return this.transaction('checkpoint.read', () => this.readCurrent(contextId));
  }

  listRoots(): readonly CheckpointHead[] {
    return this.transaction('checkpoint.list', () => {
      if (this.database.prepare('SELECT 1 FROM checkpoint_images i LEFT JOIN checkpoint_heads h ON h.context_id = i.context_id WHERE h.context_id IS NULL LIMIT 1').get()) throw new Error('Checkpoint images have no owning head');
      if (this.database.prepare('SELECT 1 FROM checkpoint_values v LEFT JOIN checkpoint_heads h ON h.context_id=v.context_id WHERE h.context_id IS NULL UNION ALL SELECT 1 FROM checkpoint_relations r LEFT JOIN checkpoint_heads h ON h.context_id=r.context_id WHERE h.context_id IS NULL LIMIT 1').get()) throw new Error('Checkpoint facts have no owning head');
      const roots: CheckpointHead[] = [];
      // Parent ownership has one source of truth: the verified Frame. Do not add a
      // redundant SQL projection that could silently hide a damaged recovery root.
      for (const row of this.database.prepare(`${select} ORDER BY h.rowid`).iterate()) {
        const checked = rowSchema.parse(row);
        const head = isCheckpointRecord(checked.body) ? readCheckpointFacts(this.database, checked) : decodeHead(checked);
        if (head.image.frame.owner.parentContextId === undefined) roots.push(head);
      }
      return Object.freeze(roots);
    });
  }

  save(image: CheckpointImage | CheckpointCommit, expectedRevision: number): CheckpointSaveReceipt {
    if ('kind' in image && image.kind === 'commit') return this.transaction('checkpoint.save', () => saveCheckpointFacts(this.database, image, expectedRevision));
    const fixed = cloneCheckpointImage(image);
    requireRevision(expectedRevision);
    if (fixed.formatVersion === 6) {
      this.transaction('checkpoint.save', () => {
        const current = this.readCurrent(fixed.frame.owner.contextId);
        return saveCheckpointFacts(this.database, checkpointImageCommit(fixed, current && checkpointHeadCommit(current)), expectedRevision);
      });
      return checkpointSaveReceipt(fixed, expectedRevision + 1);
    }
    const contextId = fixed.frame.owner.contextId;
    let candidate: CachedBasis | undefined;
    let receipt: CheckpointSaveReceipt;
    try {
      receipt = this.transaction('checkpoint.save', () => {
        const previous = this.readPrevious(contextId);
        const current = previous?.basis;
        requireCurrent(current, expectedRevision);
        if (current && (!isDeepStrictEqual(current.owner, fixed.frame.owner) || !isDeepStrictEqual(current.contract, fixed.contract) || !isDeepStrictEqual(current.input, fixed.frame.input))) throw conflict('Checkpoint owner, contract and original input cannot change');
        if (this.database.prepare('SELECT 1 FROM checkpoint_images WHERE id = ?').get(fixed.id)) throw conflict('Checkpoint identity has already been saved');
        const revision = expectedRevision + 1;
        const body = encodeCheckpointStorage(fixed);
        this.database.prepare('INSERT INTO checkpoint_images (id, context_id, revision, body) VALUES (?, ?, ?, ?)').run(fixed.id, contextId, revision, body);
        if (current) {
          const result = this.database.prepare('UPDATE checkpoint_heads SET revision = ?, image_id = ? WHERE context_id = ? AND revision = ? AND delivery IS NULL').run(revision, fixed.id, contextId, expectedRevision);
          if (result.changes !== 1) throw new Error('Checkpoint head changed during exclusive commit');
          const discarded = this.database.prepare('UPDATE checkpoint_images SET body = NULL WHERE id = ? AND context_id = ? AND body IS NOT NULL AND NOT EXISTS (SELECT 1 FROM checkpoint_heads WHERE image_id = checkpoint_images.id)').run(current.imageId, contextId);
          if (discarded.changes !== 1) throw new Error('Superseded checkpoint body could not be released');
        } else this.database.prepare('INSERT INTO checkpoint_heads (context_id, revision, image_id) VALUES (?, ?, ?)').run(contextId, revision, fixed.id);
        // Preserve JSON storage semantics (notably -0 -> 0). On later saves the
        // fixed fields were just compared, so reuse their already checked basis.
        const stable = previous ?? storedStableBasis(fixed);
        const basis = Object.freeze({ owner: stable.basis.owner, contract: stable.basis.contract, input: stable.basis.input, revision, imageId: fixed.id, terminal: false });
        const row = Object.freeze({ context_id: contextId, revision, image_id: fixed.id, delivery: null, image_context: contextId, image_revision: revision, body });
        candidate = { row, basis, stableBytes: stable.stableBytes, weight: rowWeight(row) + stable.stableBytes };
        return checkpointSaveReceipt(fixed, revision);
      });
    } catch (error) {
      this.forget(contextId);
      throw error;
    }
    // A callback result is not a commit. Publish only after the host transaction
    // returns; triggers or later out-of-band writes are detected on the next read.
    if (candidate) this.remember(contextId, candidate);
    return receipt;
  }

  finish(contextId: string, expectedRevision: number, delivery: CheckpointDelivery): CheckpointFinishReceipt {
    requireIdentity(contextId);
    requireRevision(expectedRevision);
    const fixed = cloneCheckpointDelivery(delivery);
    try {
      return this.transaction('checkpoint.finish', () => {
        const row = this.readRow(contextId);
        if (row && isCheckpointRecord(row.body)) return finishCheckpointFacts(this.database, row, expectedRevision, fixed);
        const current = this.readPrevious(contextId)?.basis;
        if (!current) throw conflict('Cannot finish a checkpoint scope without a saved image');
        requireCurrent(current, expectedRevision);
        const revision = expectedRevision + 1;
        const result = this.database.prepare('UPDATE checkpoint_heads SET revision = ?, delivery = ? WHERE context_id = ? AND revision = ? AND delivery IS NULL').run(revision, encodeCheckpointStorage(fixed), contextId, expectedRevision);
        if (result.changes !== 1) throw new Error('Checkpoint head changed during exclusive commit');
        return checkpointFinishReceipt(contextId, current.imageId, fixed, revision);
      });
    } finally {
      this.forget(contextId);
    }
  }

  private readPrevious(contextId: string): { readonly basis: AdvanceBasis; readonly stableBytes: number } | undefined {
    const row = this.readRow(contextId);
    if (!row) return undefined;
    const cached = this.#previous.get(contextId);
    if (cached && sameRow(cached.row, row)) {
      this.#previous.delete(contextId);
      this.#previous.set(contextId, cached);
      return cached;
    }
    this.forget(contextId);
    const head = decodeHead(row);
    const stable = { owner: head.image.frame.owner, contract: head.image.contract, input: head.image.frame.input };
    return { basis: Object.freeze({ ...stable, revision: head.revision, imageId: head.image.id, terminal: !!head.delivery }), stableBytes: Buffer.byteLength(JSON.stringify(stable), 'utf8') };
  }

  private forget(contextId: string): void {
    const previous = this.#previous.get(contextId);
    if (previous) this.#cachedBytes -= previous.weight;
    this.#previous.delete(contextId);
  }

  private remember(contextId: string, value: CachedBasis): void {
    this.forget(contextId);
    if (value.weight > maxCachedBytes) return;
    while (this.#previous.size >= maxCachedEntries || this.#cachedBytes + value.weight > maxCachedBytes) this.forget(this.#previous.keys().next().value!);
    this.#previous.set(contextId, value);
    this.#cachedBytes += value.weight;
  }

  private readCurrent(contextId: string): CheckpointHead | undefined {
    const row = this.readRow(contextId);
    return row ? (isCheckpointRecord(row.body) ? readCheckpointFacts(this.database, row) : decodeHead(row)) : undefined;
  }

  private readRow(contextId: string): CheckpointRow | undefined {
    const row = this.database.prepare(`${select} WHERE h.context_id = ?`).get(contextId);
    if (row) return rowSchema.parse(row);
    this.forget(contextId);
    if (this.database.prepare('SELECT 1 FROM checkpoint_images WHERE context_id = ? LIMIT 1').get(contextId)) throw new Error('Checkpoint images have no owning head');
    if (this.database.prepare('SELECT 1 FROM checkpoint_values WHERE context_id=? UNION ALL SELECT 1 FROM checkpoint_relations WHERE context_id=? LIMIT 1').get(contextId, contextId)) throw new Error('Checkpoint facts have no owning head');
    return undefined;
  }
}

function decodeHead(row: CheckpointRow): CheckpointHead {
  const image = decodeCheckpointImage(row.body);
  const delivery = row.delivery === null ? undefined : decodeCheckpointDelivery(row.delivery);
  if (image.id !== row.image_id || image.frame.owner.contextId !== row.context_id || row.image_context !== row.context_id || row.revision !== row.image_revision + (delivery ? 1 : 0)) throw new Error('Persisted checkpoint differs from its head');
  return Object.freeze({ revision: row.revision, image, ...(delivery ? { delivery } : {}) });
}

function storedStableBasis(image: CheckpointImage): { readonly basis: StableBasis; readonly stableBytes: number } {
  const json = JSON.stringify({ owner: image.frame.owner, contract: image.contract, input: image.frame.input });
  // Only the producer's own serialization is read here; no business codec is run.
  const parsed = JSON.parse(json) as StableBasis;
  return { basis: Object.freeze({ owner: parsed.owner, contract: parsed.contract, input: cloneCheckpointValue(parsed.input) }), stableBytes: Buffer.byteLength(json, 'utf8') };
}

function sameRow(left: CheckpointRow, right: CheckpointRow): boolean {
  return left.context_id === right.context_id && left.revision === right.revision && left.image_id === right.image_id && left.delivery === right.delivery && left.image_context === right.image_context && left.image_revision === right.image_revision && left.body === right.body;
}

function rowWeight(row: CheckpointRow): number {
  return 64 + 2 * (row.context_id.length + row.image_id.length + row.image_context.length + row.body.length + (row.delivery?.length ?? 0));
}

function requireCurrent(current: AdvanceBasis | undefined, expectedRevision: number): void {
  if ((current?.revision ?? 0) !== expectedRevision) throw conflict('Checkpoint head revision does not match');
  if (current?.terminal) throw conflict('Final checkpoint delivery cannot advance');
}

function conflict(message: string): RecoveryConflict {
  return new RecoveryConflict('CHECKPOINT_CONFLICT', message);
}
