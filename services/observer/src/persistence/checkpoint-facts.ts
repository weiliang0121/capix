import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type { CheckpointCommit, CheckpointHead, CheckpointDelivery, CheckpointSaveReceipt, CheckpointFinishReceipt } from '@capix/checkpoint';
import { cloneCheckpointDelivery, checkpointFinishReceipt } from '@capix/checkpoint';
import { prepareCheckpointCommit, materializeCheckpointHead, encodeCheckpointRecord, decodeCheckpointRecord, isCheckpointRecord, encodeCheckpointData, type CheckpointStoredHead, type CheckpointStoredChild, type CheckpointStoredValue, type CheckpointRelationCache, type CheckpointRelationRow, type CheckpointStoredSelection, type CheckpointStoredOccurrence, isCheckpointSelectionSlots, checkpointSelectionReferences } from '@capix/checkpoint/storage';
import { RuntimeError } from '@capix/contracts';
import { decodeCheckpointData } from '@capix/checkpoint/storage';

type Row = Record<string, string | number | bigint | Uint8Array | null>;
const select = 'SELECT h.context_id, h.revision, h.image_id, h.delivery, i.context_id AS image_context, i.revision AS image_revision, i.body FROM checkpoint_heads h LEFT JOIN checkpoint_images i ON i.id = h.image_id';

/** Current table-local facts representation. */
export function initializeCheckpointFacts(database: DatabaseSync): void {
  const values = database.prepare('PRAGMA table_info(checkpoint_values)').all();
  const relations = database.prepare('PRAGMA table_info(checkpoint_relations)').all();
  if (!values.length && !relations.length) {
    database.exec(`CREATE TABLE checkpoint_values (context_id TEXT NOT NULL,id TEXT NOT NULL,metadata TEXT NOT NULL,body TEXT,PRIMARY KEY(context_id,id)) STRICT;
      CREATE TABLE checkpoint_relations (context_id TEXT NOT NULL,child_id TEXT NOT NULL,ordinal INTEGER NOT NULL CHECK(ordinal>=0),body TEXT NOT NULL,PRIMARY KEY(context_id,child_id),UNIQUE(context_id,ordinal)) STRICT;`);
    initializeCheckpointSelections(database);
    return;
  }
  for (const [rows, names] of [
    [values, ['context_id', 'id', 'metadata', 'body']],
    [relations, ['context_id', 'child_id', 'ordinal', 'body']],
  ] as const) {
    if (rows.length !== 4 || rows.some((row, index) => row.name !== names[index] || row.type !== (names[index] === 'ordinal' ? 'INTEGER' : 'TEXT') || row.pk !== (index < 2 ? index + 1 : 0) || row.notnull !== (rows === values && index === 3 ? 0 : 1))) throw new Error('Unsupported checkpoint facts table');
  }
  initializeCheckpointSelections(database);
}

function initializeCheckpointSelections(database: DatabaseSync): void {
  const selections = database.prepare('PRAGMA table_info(checkpoint_selections)').all();
  const occurrences = database.prepare('PRAGMA table_info(checkpoint_occurrences)').all();
  if (!selections.length && !occurrences.length) {
    database.exec(`CREATE TABLE checkpoint_selections (context_id TEXT NOT NULL,id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(context_id,id)) STRICT;
      CREATE TABLE checkpoint_occurrences (context_id TEXT NOT NULL,selection_id TEXT NOT NULL,occurrence_id TEXT NOT NULL,ordinal INTEGER NOT NULL CHECK(ordinal>=0),body TEXT,PRIMARY KEY(context_id,selection_id,occurrence_id),UNIQUE(context_id,selection_id,ordinal)) STRICT;
      CREATE INDEX checkpoint_occurrences_active ON checkpoint_occurrences(context_id,selection_id,ordinal) WHERE body IS NOT NULL;`);
    return;
  }
  for (const [rows, names, primary] of [
    [selections, ['context_id', 'id', 'body'], 2],
    [occurrences, ['context_id', 'selection_id', 'occurrence_id', 'ordinal', 'body'], 3],
  ] as const) {
    if (rows.length !== names.length || rows.some((row, index) => row.name !== names[index] || row.type !== (names[index] === 'ordinal' ? 'INTEGER' : 'TEXT') || row.pk !== (index < primary ? index + 1 : 0) || row.notnull !== (rows === occurrences && index === 4 ? 0 : 1))) throw new Error('Unsupported checkpoint selection table');
  }
}

/** The caller owns the transaction. No second invocation state or process-global cache. */
export function saveCheckpointFacts(database: DatabaseSync, request: CheckpointCommit, expectedRevision: number, relations: CheckpointRelationCache): CheckpointSaveReceipt {
  const contextId = request.frame.owner.contextId;
  const row = database.prepare(`${select} WHERE h.context_id = ?`).get(contextId);
  if (row && (typeof row.body !== 'string' || !isCheckpointRecord(row.body))) throw new Error('Unsupported checkpoint head storage format');
  const current = row ? storedHead(row) : undefined;
  if (!row && database.prepare('SELECT 1 FROM checkpoint_images WHERE context_id = ? UNION ALL SELECT 1 FROM checkpoint_values WHERE context_id=? UNION ALL SELECT 1 FROM checkpoint_relations WHERE context_id=? UNION ALL SELECT 1 FROM checkpoint_selections WHERE context_id=? UNION ALL SELECT 1 FROM checkpoint_occurrences WHERE context_id=? LIMIT 1').get(contextId, contextId, contextId, contextId, contextId)) throw new Error('Checkpoint facts have no owning head');
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
  let selectionStatement: StatementSync | undefined;
  let occurrenceStatement: StatementSync | undefined;
  const readSelection = readOnce((id) => selectionInfo((selectionStatement ??= database.prepare('SELECT body FROM checkpoint_selections WHERE context_id=? AND id=?')), contextId, id));
  const occurrences = new Map<string, Map<string, CheckpointStoredOccurrence | undefined>>();
  const readOccurrence = (selection: string, id: string) => {
    let entries = occurrences.get(selection);
    if (!entries) occurrences.set(selection, (entries = new Map()));
    if (!entries.has(id)) entries.set(id, occurrenceInfo((occurrenceStatement ??= database.prepare('SELECT occurrence_id,ordinal,body FROM checkpoint_occurrences WHERE context_id=? AND selection_id=? AND occurrence_id=?')).get(contextId, selection, id)));
    return entries.get(id);
  };
  const plan = prepareCheckpointCommit(request, expectedRevision, {
    head: current,
    value: readValue,
    body: readBody,
    child: readChild,
    order: (order) => orderStatement.get(contextId, order)?.child_id as string | undefined,
    imageUsed: (id) => !!imageStatement.get(id),
    selection: readSelection,
    occurrence: readOccurrence,
  });
  for (const value of plan.values) {
    const metadata = encodeCheckpointRecord('value', value.stored);
    const body = value.stored.uses === 0 ? null : value.body === undefined ? undefined : value.body;
    if (body === undefined) write(database.prepare('UPDATE checkpoint_values SET metadata = ? WHERE context_id = ? AND id = ?').run(metadata, contextId, value.stored.id).changes);
    else write(database.prepare('INSERT INTO checkpoint_values(context_id,id,metadata,body) VALUES (?,?,?,?) ON CONFLICT(context_id,id) DO UPDATE SET metadata=excluded.metadata,body=excluded.body').run(contextId, value.stored.id, metadata, body).changes);
  }
  for (const value of plan.children) write(database.prepare('INSERT INTO checkpoint_relations(context_id,child_id,ordinal,body) VALUES (?,?,?,?) ON CONFLICT(context_id,child_id) DO UPDATE SET ordinal=excluded.ordinal,body=excluded.body').run(contextId, value.child.identity.contextId, value.child.order, encodeCheckpointRecord('child', value)).changes);
  for (const selection of plan.selections) {
    if (selection.reset) database.prepare('UPDATE checkpoint_occurrences SET body=NULL WHERE context_id=? AND selection_id=? AND body IS NOT NULL').run(contextId, selection.head.id);
    for (const id of selection.remove) write(database.prepare('UPDATE checkpoint_occurrences SET body=NULL WHERE context_id=? AND selection_id=? AND occurrence_id=? AND body IS NOT NULL').run(contextId, selection.head.id, id).changes);
    for (const occurrence of selection.append) write(database.prepare('INSERT INTO checkpoint_occurrences(context_id,selection_id,occurrence_id,ordinal,body) VALUES (?,?,?,?,?)').run(contextId, selection.head.id, occurrence.id, occurrence.order, encodeCheckpointRecord('occurrence', occurrence)).changes);
    write(database.prepare('INSERT INTO checkpoint_selections(context_id,id,body) VALUES (?,?,?) ON CONFLICT(context_id,id) DO UPDATE SET body=excluded.body').run(contextId, selection.head.id, encodeCheckpointRecord('selection', selection.head)).changes);
  }
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
      return { stored, body: value.body };
    });
  const selections = isCheckpointSelectionSlots(head.commit.references)
    ? checkpointSelectionReferences(head.commit.references).map(({ id }) => {
        const selection = selectionInfo(database.prepare('SELECT body FROM checkpoint_selections WHERE context_id=? AND id=?'), contextId, id);
        if (!selection) throw new Error('Missing checkpoint selection');
        const occurrences = database
          .prepare('SELECT occurrence_id,ordinal,body FROM checkpoint_occurrences WHERE context_id=? AND selection_id=? ORDER BY ordinal')
          .all(contextId, id)
          .map((row) => occurrenceInfo(row)!);
        return { head: selection, occurrences };
      })
    : [];
  return materializeCheckpointHead(head, children, values, selections);
}

export function finishCheckpointFacts(database: DatabaseSync, row: Row, expectedRevision: number, delivery: CheckpointDelivery): CheckpointFinishReceipt {
  const head = storedHead(row);
  if (head.revision !== expectedRevision || head.delivery) throw conflict('Checkpoint head revision or terminal state differs');
  const fixed = cloneCheckpointDelivery(delivery);
  const contextId = head.commit.frame.owner.contextId;
  write(database.prepare('UPDATE checkpoint_heads SET revision=?,delivery=? WHERE context_id=? AND revision=? AND delivery IS NULL').run(expectedRevision + 1, encodeCheckpointData(fixed), contextId, expectedRevision).changes);
  return checkpointFinishReceipt(contextId, head.commit.id, fixed, expectedRevision + 1);
}

function storedHead(row: Row): CheckpointStoredHead {
  if (typeof row.body !== 'string' || typeof row.revision !== 'number' || !Number.isSafeInteger(row.revision) || row.revision < 1) throw new Error('Invalid checkpoint facts head');
  const head = decodeCheckpointRecord<CheckpointStoredHead>('head', row.body);
  if (head.commit.id !== row.image_id || head.commit.frame.owner.contextId !== row.context_id || (row.image_context ?? row.image_context_id) !== row.context_id || head.revision !== row.image_revision || row.revision !== head.revision + (row.delivery === null ? 0 : 1) || head.delivery !== undefined) throw new Error('Checkpoint facts differ from their head');
  return row.delivery === null ? head : { ...head, revision: row.revision, delivery: cloneCheckpointDelivery(decodeCheckpointData(row.delivery as string)) };
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
  return body;
}

function selectionInfo(statement: StatementSync, owner: string, id: string): CheckpointStoredSelection | undefined {
  const row = statement.get(owner, id);
  if (!row) return undefined;
  if (typeof row.body !== 'string') throw new Error('Invalid checkpoint selection row');
  const value = decodeCheckpointRecord<CheckpointStoredSelection>('selection', row.body);
  if (value.owner !== owner || value.id !== id) throw new Error('Checkpoint selection row identity differs');
  return value;
}
function occurrenceInfo(row: Row | undefined): CheckpointStoredOccurrence | undefined {
  if (!row) return undefined;
  if (typeof row.occurrence_id !== 'string' || typeof row.ordinal !== 'number' || !Number.isSafeInteger(row.ordinal) || row.ordinal < 0) throw new Error('Invalid checkpoint occurrence row');
  if (row.body === null) return { id: row.occurrence_id, order: row.ordinal };
  if (typeof row.body !== 'string') throw new Error('Invalid checkpoint occurrence body');
  const value = decodeCheckpointRecord<CheckpointStoredOccurrence>('occurrence', row.body);
  if (value.id !== row.occurrence_id || value.order !== row.ordinal || !value.reference) throw new Error('Checkpoint occurrence row identity differs');
  return value;
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

function conflict(message: string): RuntimeError {
  return new RuntimeError('CHECKPOINT_CONFLICT', message);
}
function write(changes: number | bigint): void {
  if (changes !== 1 && changes !== 1n) throw new Error('Checkpoint mutation did not affect exactly one row');
}
