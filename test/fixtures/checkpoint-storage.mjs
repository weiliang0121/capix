/** Rebuild an authentic pre-v6 table shape for migration tests; never used by production. */
export function restoreLegacyCheckpointTables(database) {
  const triggers = database.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name IN ('checkpoint_images', 'checkpoint_heads')").all();
  for (const trigger of triggers) database.exec(`DROP TRIGGER ${trigger.name}`);
  database.exec(`
    CREATE TABLE legacy_checkpoint_images (
      id TEXT PRIMARY KEY,
      context_id TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK (revision > 0),
      body TEXT NOT NULL CHECK (json_valid(body)),
      UNIQUE (context_id, revision)
    ) STRICT;
    CREATE TABLE legacy_checkpoint_heads (
      context_id TEXT PRIMARY KEY,
      revision INTEGER NOT NULL CHECK (revision > 0),
      image_id TEXT NOT NULL UNIQUE REFERENCES legacy_checkpoint_images(id),
      delivery TEXT CHECK (delivery IS NULL OR json_valid(delivery))
    ) STRICT;
    INSERT INTO legacy_checkpoint_images SELECT * FROM checkpoint_images ORDER BY rowid;
    INSERT INTO legacy_checkpoint_heads SELECT * FROM checkpoint_heads ORDER BY rowid;
    DROP TABLE checkpoint_heads;
    DROP TABLE checkpoint_images;
    ALTER TABLE legacy_checkpoint_images RENAME TO checkpoint_images;
    ALTER TABLE legacy_checkpoint_heads RENAME TO checkpoint_heads;
  `);
  for (const trigger of triggers) database.exec(trigger.sql);
}
