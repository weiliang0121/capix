import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type { CheckpointCommit, CheckpointHead, CheckpointDelivery, CheckpointSaveReceipt, CheckpointFinishReceipt } from '@capix/checkpoint';
import { cloneCheckpointDelivery, checkpointFinishReceipt } from '@capix/checkpoint';
import { prepareCheckpointCommit, materializeCheckpointHead, encodeCheckpointRecord, decodeCheckpointRecord, isCheckpointRecord, encodeCheckpointData, type CheckpointStoredHead, type CheckpointStoredChild, type CheckpointStoredValue, type CheckpointRelationCache, type CheckpointRelationRow } from '@capix/checkpoint/storage';
import { RecoveryConflict } from './recovery.js';
import { RuntimeError } from '@capix/contracts';
import { encodeCheckpointStorage, decodeCheckpointStorage, decodeCheckpointDelivery } from './checkpoint-storage.js';

type Row = Record<string, string | number | bigint | Uint8Array | null>;
const select = 'SELECT h.context_id, h.revision, h.image_id, h.delivery, i.context_id AS image_context, i.revision AS image_revision, i.body FROM checkpoint_heads h LEFT JOIN checkpoint_images i ON i.id = h.image_id';

/** The caller owns the transaction. No second invocation state or process-global cache. */
export function saveCheckpointFacts(database: DatabaseSync, request: CheckpointCommit, expectedRevision: number, relations: CheckpointRelationCache): CheckpointSaveReceipt {
  const contextId = request.frame.owner.contextId;
  const row = database.prepare(`${select} WHERE h.context_id = ?`).get(contextId);
  if (row && (typeof row.body !== 'string' || !isCheckpointRecord(row.body))) throw conflict('Legacy checkpoint scope cannot advance under stable facts');
  const current = row ? storedHead(row) : undefined;
  if (!row && database.prepare('SELECT 1 FROM checkpoint_images WHERE context_id = ? UNION ALL SELECT 1 FROM checkpoint_values WHERE context_id=? UNION ALL SELECT 1 FROM checkpoint_relations WHERE context_id=? LIMIT 1').get(contextId, contextId, contextId)) throw new Error('Checkpoint facts have no owning head');
  // These readers live only through this preparation, before any writes below.
  // Every reference is still checked; repeated IDs reuse the same transaction row.
  const valueStatement = database.prepare('SELECT metadata,body IS NOT NULL AS material FROM checkpoint_values WHERE context_id=? AND id=?');
  const childStatement = database.prepare('SELECT child_id,ordinal,body FROM checkpoint_relations WHERE context_id=? AND child_id=?');
  const orderStatement = database.prepare('SELECT child_id FROM checkpoint_relations WHERE context_id = ? AND ordinal = ?');
  const imageStatement = database.prepare('SELECT 1 FROM checkpoint_images WHERE id = ?');
  let bodyStatement: StatementSync | undefined;
  const readValue = readOnce((id) => valueInfo(valueStatement, contextId, id));
  const readChild = readOnce((id) => relations.decode(contextId, id, childStatement.get(contextId, id) as CheckpointRelationRow | undefined));
  const readBody = readOnce((id) => valueBody((bodyStatement ??= database.prepare('SELECT body FROM checkpoint_values WHERE context_id=? AND id=?')), contextId, id));
  const plan = prepare(() =>
    prepareCheckpointCommit(request, expectedRevision, {
      head: current,
      value: readValue,
      body: readBody,
      child: readChild,
      order: (order) => orderStatement.get(contextId, order)?.child_id as string | undefined,
      imageUsed: (id) => !!imageStatement.get(id),
    }),
  );
  for (const value of plan.values) {
    const metadata = encodeCheckpointRecord('value', value.stored);
    const body = value.stored.uses === 0 ? null : value.body === undefined ? undefined : encodeCheckpointStorage(JSON.parse(value.body));
    if (body === undefined) write(database.prepare('UPDATE checkpoint_values SET metadata = ? WHERE context_id = ? AND id = ?').run(metadata, contextId, value.stored.id).changes);
    else write(database.prepare('INSERT INTO checkpoint_values(context_id,id,metadata,body) VALUES (?,?,?,?) ON CONFLICT(context_id,id) DO UPDATE SET metadata=excluded.metadata,body=excluded.body').run(contextId, value.stored.id, metadata, body).changes);
  }
  for (const value of plan.children) write(database.prepare('INSERT INTO checkpoint_relations(context_id,child_id,ordinal,body) VALUES (?,?,?,?) ON CONFLICT(context_id,child_id) DO UPDATE SET ordinal=excluded.ordinal,body=excluded.body').run(contextId, value.child.identity.contextId, value.child.order, encodeCheckpointRecord('child', value)).changes);
  write(database.prepare('INSERT INTO checkpoint_images(id,context_id,revision,body) VALUES (?,?,?,?)').run(request.id, contextId, plan.head.revision, encodeCheckpointRecord('head', plan.head)).changes);
  if (current) {
    write(database.prepare('UPDATE checkpoint_heads SET revision=?,image_id=? WHERE context_id=? AND revision=? AND delivery IS NULL').run(plan.head.revision, request.id, contextId, expectedRevision).changes);
    write(database.prepare('UPDATE checkpoint_images SET body=NULL WHERE id=? AND context_id=? AND body IS NOT NULL AND NOT EXISTS (SELECT 1 FROM checkpoint_heads WHERE image_id=checkpoint_images.id)').run(current.commit.id, contextId).changes);
  } else write(database.prepare('INSERT INTO checkpoint_heads(context_id,revision,image_id) VALUES (?,?,?)').run(contextId, plan.head.revision, request.id).changes);
  return plan.receipt;
}

export function readCheckpointFacts(database: DatabaseSync, row: Row): CheckpointHead {
  const head = storedHead(row);
  const contextId = head.commit.frame.owner.contextId;
  const children = database.prepare('SELECT child_id,ordinal,body FROM checkpoint_relations WHERE context_id=? ORDER BY ordinal').all(contextId).map(decodeChild);
  const values = database
    .prepare('SELECT id,metadata,body FROM checkpoint_values WHERE context_id=? AND body IS NOT NULL')
    .all(contextId)
    .map((value) => {
      if (typeof value.id !== 'string' || typeof value.metadata !== 'string' || typeof value.body !== 'string') throw new Error('Invalid checkpoint value row');
      const stored = decodeCheckpointRecord<CheckpointStoredValue>('value', value.metadata);
      if (stored.id !== value.id) throw new Error('Checkpoint value row identity differs');
      return { stored, body: JSON.stringify(decodeCheckpointStorage(value.body)) };
    });
  return materializeCheckpointHead(head, children, values);
}

export function finishCheckpointFacts(database: DatabaseSync, row: Row, expectedRevision: number, delivery: CheckpointDelivery): CheckpointFinishReceipt {
  const head = storedHead(row);
  if (head.revision !== expectedRevision || head.delivery) throw conflict('Checkpoint head revision or terminal state differs');
  const fixed = cloneCheckpointDelivery(delivery);
  const contextId = head.commit.frame.owner.contextId;
  write(database.prepare('UPDATE checkpoint_heads SET revision=?,delivery=? WHERE context_id=? AND revision=? AND delivery IS NULL').run(expectedRevision + 1, encodeCheckpointStorage(JSON.parse(encodeCheckpointData(fixed))), contextId, expectedRevision).changes);
  return checkpointFinishReceipt(contextId, head.commit.id, fixed, expectedRevision + 1);
}

function storedHead(row: Row): CheckpointStoredHead {
  if (typeof row.body !== 'string' || typeof row.revision !== 'number' || !Number.isSafeInteger(row.revision) || row.revision < 1) throw new Error('Invalid checkpoint facts head');
  const head = decodeCheckpointRecord<CheckpointStoredHead>('head', row.body);
  if (head.commit.id !== row.image_id || head.commit.frame.owner.contextId !== row.context_id || row.image_context !== row.context_id || head.revision !== row.image_revision || row.revision !== head.revision + (row.delivery === null ? 0 : 1) || head.delivery !== undefined) throw new Error('Checkpoint facts differ from their head');
  return row.delivery === null ? head : { ...head, revision: row.revision, delivery: decodeCheckpointDelivery(row.delivery as string) };
}

function valueInfo(statement: StatementSync, contextId: string, id: string): CheckpointStoredValue | undefined {
  const row = statement.get(contextId, id);
  if (!row) return undefined;
  if (typeof row.metadata !== 'string') throw new Error('Invalid checkpoint value metadata');
  const value = decodeCheckpointRecord<CheckpointStoredValue>('value', row.metadata);
  if (value.id !== id || value.uses > 0 !== !!row.material) throw new Error('Checkpoint value metadata differs from its body');
  return value;
}

function valueBody(statement: StatementSync, contextId: string, id: string): string | undefined {
  const body = statement.get(contextId, id)?.body;
  if (body === null || body === undefined) return undefined;
  if (typeof body !== 'string') throw new Error('Invalid checkpoint value body');
  return JSON.stringify(decodeCheckpointStorage(body));
}

function readOnce<Value>(read: (id: string) => Value): (id: string) => Value {
  const rows = new Map<string, Value>();
  return (id) => {
    if (rows.has(id)) return rows.get(id)!;
    const value = read(id);
    rows.set(id, value);
    return value;
  };
}

function decodeChild(row: Row): CheckpointStoredChild {
  if (typeof row.body !== 'string') throw new Error('Invalid checkpoint relation body');
  const value = decodeCheckpointRecord<CheckpointStoredChild>('child', row.body);
  if (value.child.identity.contextId !== row.child_id || value.child.order !== row.ordinal) throw new Error('Checkpoint relation row identity differs');
  return value;
}

function conflict(message: string): RecoveryConflict {
  return new RecoveryConflict('CHECKPOINT_CONFLICT', message);
}
function prepare<T>(work: () => T): T {
  try {
    return work();
  } catch (error) {
    if (error instanceof RuntimeError && error.code === 'CHECKPOINT_CONFLICT') throw conflict(error.message);
    throw error;
  }
}
function write(changes: number | bigint): void {
  if (changes !== 1 && changes !== 1n) throw new Error('Checkpoint mutation did not affect exactly one row');
}
