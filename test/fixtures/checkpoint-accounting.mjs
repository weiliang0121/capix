/** Independently total current retained CP payloads, excluding SQLite overhead and retired IDs. */
export function retainedCheckpointBytes(database) {
  let total = 0;
  for (const [table, column] of [
    ['checkpoint_images', 'body'],
    ['checkpoint_heads', 'delivery'],
    ['checkpoint_values', 'body'],
    ['checkpoint_values', 'metadata'],
    ['checkpoint_relations', 'body'],
    ['checkpoint_selections', 'body'],
    ['checkpoint_occurrences', 'body'],
  ]) {
    for (const row of database.prepare(`SELECT ${column} AS value FROM ${table}`).all()) {
      if (row.value === null) continue;
      const envelope = JSON.parse(row.value);
      total += envelope.encoding === 'br' ? envelope.jsonBytes : Buffer.byteLength(row.value);
    }
  }
  return total;
}
