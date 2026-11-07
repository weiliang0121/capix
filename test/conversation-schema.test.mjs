import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ConversationStore } from '@capix/conversation-service/persistence';
import { loadConversationContent } from '@capix/conversation-service/assembly';
import { PersistenceError } from '@capix/diagnostics';

function files(t) {
  const directory = mkdtempSync(join(tmpdir(), 'capix-schema-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, path: join(directory, 'conversation.sqlite') };
}

for (const version of [1, 2, 3, 4, 5, 6, 7, 9]) {
  test(`schema ${version} is rejected before changing stored data, schema, file mode or journal`, (t) => {
    const f = files(t);
    const database = new DatabaseSync(f.path);
    try {
      database.exec(`PRAGMA application_id=1128353859; PRAGMA user_version=${version};
        PRAGMA journal_mode=DELETE;
        CREATE TABLE historical_content(id INTEGER PRIMARY KEY, body TEXT NOT NULL);
        INSERT INTO historical_content VALUES (1, 'retain original content');`);
    } finally {
      database.close();
    }
    chmodSync(f.path, 0o640);
    const before = readFileSync(f.path);
    const mode = statSync(f.path).mode;
    const names = readdirSync(f.directory);
    assert.throws(
      () => ConversationStore.open(f.path),
      (error) => error instanceof PersistenceError && /Unsupported conversation database version/.test(error.cause?.message),
    );
    assert.deepEqual(readFileSync(f.path), before);
    assert.equal(statSync(f.path).mode, mode);
    assert.deepEqual(readdirSync(f.directory), names);
    const original = new DatabaseSync(f.path, { readOnly: true });
    try {
      assert.equal(original.prepare('PRAGMA user_version').get().user_version, version);
      assert.equal(original.prepare('PRAGMA journal_mode').get().journal_mode, 'delete');
      assert.equal(original.prepare('SELECT body FROM historical_content').get().body, 'retain original content');
    } finally {
      original.close();
    }
  });
}

test('new databases directly install schema 8 and current content reopens without migration', (t) => {
  const f = files(t);
  const store = ConversationStore.open(f.path);
  let expected;
  try {
    const content = loadConversationContent(store);
    content.transcript.append({ role: 'user', content: 'current content' });
    expected = store.load();
  } finally {
    store.close();
  }
  const database = new DatabaseSync(f.path, { readOnly: true });
  try {
    assert.equal(database.prepare('PRAGMA user_version').get().user_version, 8);
    for (const table of ['checkpoint_values', 'checkpoint_relations', 'checkpoint_selections', 'checkpoint_occurrences', 'archive_usage']) assert.ok(database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
    assert.equal(database.prepare("SELECT 1 FROM sqlite_master WHERE name LIKE 'old_%' OR name LIKE 'retained_%'").get(), undefined);
  } finally {
    database.close();
  }
  const reopened = ConversationStore.open(f.path);
  try {
    assert.deepEqual(reopened.load(), expected);
  } finally {
    reopened.close();
  }
});

test('a current-version label cannot bless an incompatible table layout', (t) => {
  const f = files(t);
  const store = ConversationStore.open(f.path);
  store.close();
  const database = new DatabaseSync(f.path);
  try {
    database.exec('ALTER TABLE messages RENAME COLUMN body TO payload');
  } finally {
    database.close();
  }
  const before = readFileSync(f.path);
  assert.throws(() => ConversationStore.open(f.path), PersistenceError);
  assert.deepEqual(readFileSync(f.path), before);
});
