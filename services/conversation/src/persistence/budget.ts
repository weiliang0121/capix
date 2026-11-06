import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';

/** Retained JSON facts, not SQLite file size, write traffic or reserved future growth. */
export interface ConversationArchiveUsage {
  readonly exchangesBytes: number;
  readonly interactionsBytes: number;
  readonly checkpointBytes: number;
  readonly totalBytes: number;
}

const bytes = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const row = z.strictObject({ singleton: z.literal(1), exchanges_bytes: bytes, interactions_bytes: bytes, checkpoint_bytes: bytes });

export function readArchiveUsage(database: DatabaseSync): ConversationArchiveUsage {
  const saved = row.parse(database.prepare('SELECT * FROM archive_usage').get());
  const totalBytes = saved.exchanges_bytes + saved.interactions_bytes + saved.checkpoint_bytes;
  if (!Number.isSafeInteger(totalBytes)) throw new Error('Archive usage exceeds the supported counter range');
  return Object.freeze({ exchangesBytes: saved.exchanges_bytes, interactionsBytes: saved.interactions_bytes, checkpointBytes: saved.checkpoint_bytes, totalBytes });
}

/** Install once during migration. Row updates and their counters share the writer's transaction. */
export function installArchiveUsage(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE archive_usage (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      exchanges_bytes INTEGER NOT NULL CHECK (exchanges_bytes >= 0),
      interactions_bytes INTEGER NOT NULL CHECK (interactions_bytes >= 0),
      checkpoint_bytes INTEGER NOT NULL CHECK (checkpoint_bytes >= 0)
    ) STRICT;
    INSERT INTO archive_usage VALUES (1,
      (SELECT COALESCE(SUM(length(CAST(body AS BLOB))), 0) FROM model_exchange_entries) +
      (SELECT COALESCE(SUM(length(CAST(metadata AS BLOB))), 0) FROM model_exchanges),
      (SELECT COALESCE(SUM(length(CAST(body AS BLOB))), 0) FROM completion_interactions),
      (SELECT COALESCE(SUM(${checkpointBytes('body')}), 0) FROM checkpoint_images) +
      (SELECT COALESCE(SUM(${checkpointBytes('delivery')}), 0) FROM checkpoint_heads)
    );
  `);
  for (const sql of usageTriggers().values()) database.exec(sql);
  readArchiveUsage(database);
}

/** A missing accounting trigger cannot silently turn admission into a stale-counter check. */
export function inspectArchiveUsage(database: DatabaseSync): void {
  const query = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?");
  for (const [name, sql] of usageTriggers()) {
    const stored = query.get(name)?.sql;
    if (typeof stored !== 'string' || normalize(stored) !== normalize(sql)) throw new Error('Unsupported archive usage accounting');
  }
  readArchiveUsage(database);
}

/** Schema migration must not repair a damaged counter by silently recounting it. */
export function removeArchiveUsageForMigration(database: DatabaseSync): void {
  inspectArchiveUsage(database);
  const saved = readArchiveUsage(database);
  const actual = database
    .prepare(
      `SELECT
    (SELECT COALESCE(SUM(length(CAST(body AS BLOB))), 0) FROM model_exchange_entries) + (SELECT COALESCE(SUM(length(CAST(metadata AS BLOB))), 0) FROM model_exchanges) AS exchanges_bytes,
    (SELECT COALESCE(SUM(length(CAST(body AS BLOB))), 0) FROM completion_interactions) AS interactions_bytes,
    (SELECT COALESCE(SUM(${checkpointBytes('body')}), 0) FROM checkpoint_images) + (SELECT COALESCE(SUM(${checkpointBytes('delivery')}), 0) FROM checkpoint_heads) AS checkpoint_bytes`,
    )
    .get();
  if (!actual || actual.exchanges_bytes !== saved.exchangesBytes || actual.interactions_bytes !== saved.interactionsBytes || actual.checkpoint_bytes !== saved.checkpointBytes) throw new Error('Archive usage differs from retained facts');
  for (const name of usageTriggers().keys()) database.exec(`DROP TRIGGER ${name}`);
  database.exec('DROP TABLE archive_usage');
}

function checkpointBytes(value: string): string {
  // Current storage records its original JSON length. Opaque historical rows are
  // measured without reinterpreting their format; normal reads still certify them.
  return `CASE WHEN ${value} IS NULL THEN 0 WHEN json_type(${value}, '$.jsonBytes') = 'integer' THEN json_extract(${value}, '$.jsonBytes') ELSE length(CAST(${value} AS BLOB)) END`;
}

function usageTriggers(): ReadonlyMap<string, string> {
  const statements = new Map<string, string>();
  const track = (table: string, column: string, counter: string, size: (value: string) => string): void => {
    const insert = `archive_${table}_insert`;
    const update = `archive_${table}_update`;
    const remove = `archive_${table}_delete`;
    statements.set(insert, `CREATE TRIGGER ${insert} AFTER INSERT ON ${table} BEGIN UPDATE archive_usage SET ${counter} = ${counter} + (${size(`NEW.${column}`)}) WHERE singleton = 1; END`);
    statements.set(update, `CREATE TRIGGER ${update} AFTER UPDATE OF ${column} ON ${table} BEGIN UPDATE archive_usage SET ${counter} = ${counter} + (${size(`NEW.${column}`)}) - (${size(`OLD.${column}`)}) WHERE singleton = 1; END`);
    statements.set(remove, `CREATE TRIGGER ${remove} AFTER DELETE ON ${table} BEGIN UPDATE archive_usage SET ${counter} = ${counter} - (${size(`OLD.${column}`)}) WHERE singleton = 1; END`);
  };
  track('model_exchange_entries', 'body', 'exchanges_bytes', (value) => `length(CAST(${value} AS BLOB))`);
  track('model_exchanges', 'metadata', 'exchanges_bytes', (value) => `COALESCE(length(CAST(${value} AS BLOB)), 0)`);
  track('completion_interactions', 'body', 'interactions_bytes', (value) => `length(CAST(${value} AS BLOB))`);
  track('checkpoint_images', 'body', 'checkpoint_bytes', checkpointBytes);
  track('checkpoint_heads', 'delivery', 'checkpoint_bytes', checkpointBytes);
  return statements;
}

function normalize(sql: string): string {
  return sql.trim().replace(/\s+/g, ' ').replace(/;$/, '');
}
