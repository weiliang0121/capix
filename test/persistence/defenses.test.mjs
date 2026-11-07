import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, chmodSync, existsSync, statSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Transcript } from '@capix/transcript';
import { Memories } from '@capix/memory';
import { SqliteObserverStore } from '@capix/observer-service';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'capix-persistence-defense-'));
  const path = join(directory, 'observer.sqlite');
  const stores = [];
  t.after(() => {
    for (const store of stores) store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    directory,
    path,
    open() {
      const store = SqliteObserverStore.open(path);
      stores.push(store);
      return store;
    },
  };
}

function initialize(store) {
  const transcript = new Transcript([{ role: 'user', content: 'saved content' }]);
  const memories = new Memories(transcript);
  store.initialize({ transcript: transcript.exportState(), memories: memories.exportState() });
}

test('load rejects orphan foreign-key rows without silently hiding or deleting saved content', (t) => {
  const disk = fixture(t);
  const first = disk.open();
  initialize(first);
  first.close();
  const raw = new DatabaseSync(disk.path);
  try {
    raw.exec('PRAGMA foreign_keys = OFF');
    raw.prepare('INSERT INTO messages(transcript_id, position, body) VALUES (?, ?, ?)').run('missing-transcript', 0, JSON.stringify({ role: 'user', content: 'orphaned content' }));
  } finally {
    raw.close();
  }
  const reopened = disk.open();
  assert.throws(
    () => reopened.loadContent(),
    (error) => error.code === 'PERSISTENCE_UNAVAILABLE' && error.cause?.message === 'Stored database integrity check failed',
  );
  assert.equal(reopened.failure.code, 'PERSISTENCE_UNAVAILABLE');
  reopened.close();
  const verify = new DatabaseSync(disk.path);
  try {
    assert.equal(verify.prepare('SELECT count(*) AS count FROM messages').get().count, 2);
  } finally {
    verify.close();
  }
});

test('new database and SQLite sidecars stay private inside a previously public data directory', { skip: process.platform === 'win32' }, (t) => {
  const disk = fixture(t);
  chmodSync(disk.directory, 0o755);
  const store = disk.open();
  initialize(store);
  assert.equal(statSync(disk.directory).mode & 0o777, 0o755, 'opening storage does not silently change an existing parent directory');
  assert.ok(existsSync(disk.path + '-wal'), 'exercise the actual WAL file while the connection is open');
  for (const suffix of ['', '-wal', '-shm']) {
    const path = disk.path + suffix;
    if (existsSync(path)) assert.equal(statSync(path).mode & 0o777, 0o600, `private mode for ${suffix || 'database'}`);
  }
});

test('opening existing storage narrows current database and sidecar modes before use', { skip: process.platform === 'win32' }, (t) => {
  const disk = fixture(t);
  chmodSync(disk.directory, 0o755);
  const first = disk.open();
  initialize(first);
  first.close();
  chmodSync(disk.path, 0o644);
  for (const suffix of ['-wal', '-shm']) {
    // Empty sidecars are valid remnants; restrictive modes must not rely on first-time creation.
    writeFileSync(disk.path + suffix, '');
    chmodSync(disk.path + suffix, 0o644);
  }
  const reopened = disk.open();
  assert.equal(reopened.loadContent().transcript.messages[0].content, 'saved content');
  for (const suffix of ['', '-wal', '-shm']) {
    const path = disk.path + suffix;
    if (existsSync(path)) assert.equal(statSync(path).mode & 0o777, 0o600, `private mode for existing ${suffix || 'database'}`);
  }
});

test('service startup rejects a ..name data directory inside its model workspace before opening a database', (t) => {
  const disk = fixture(t);
  const dataDirectory = join(disk.directory, '..data');
  const start = fileURLToPath(new URL('../../services/observer/dist/start.js', import.meta.url));
  const result = spawnSync(process.execPath, [start], {
    cwd: disk.directory,
    env: { CAPIX_FILES_ROOT: disk.directory, CAPIX_DATA_DIR: dataDirectory },
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.equal(result.error, undefined, 'startup should reject configuration rather than run until timeout');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /内容数据库必须位于模型文件工作区之外/);
  assert.equal(existsSync(join(dataDirectory, 'observer.sqlite')), false);
  assert.equal(existsSync(join(dataDirectory, 'observer.sqlite-wal')), false);
});

for (const version of [1, 2, 3, 4, 5, 99]) {
  test(`opening unsupported Observer v${version} leaves bytes, permissions and journal mode unchanged`, (t) => {
    const disk = fixture(t);
    const database = new DatabaseSync(disk.path);
    database.exec(`CREATE TABLE retained(value TEXT); INSERT INTO retained VALUES ('kept'); PRAGMA user_version = ${version}; PRAGMA journal_mode = DELETE;`);
    database.close();
    chmodSync(disk.path, 0o644);
    const before = readFileSync(disk.path);
    const mode = statSync(disk.path).mode;
    assert.throws(() => disk.open(), /Unsupported Observer persistence schema/);
    assert.deepEqual(readFileSync(disk.path), before);
    assert.equal(statSync(disk.path).mode, mode);
    for (const suffix of ['-wal', '-shm', '-journal']) assert.equal(existsSync(disk.path + suffix), false);
    const verify = new DatabaseSync(disk.path, { readOnly: true });
    try {
      assert.equal(verify.prepare('PRAGMA journal_mode').get().journal_mode, 'delete');
      assert.equal(verify.prepare('SELECT value FROM retained').get().value, 'kept');
    } finally {
      verify.close();
    }
  });
}

test('opening current Observer version with retired checkpoint tables refuses before file changes', (t) => {
  const disk = fixture(t);
  const database = new DatabaseSync(disk.path);
  database.exec(`CREATE TABLE checkpoint_images (id TEXT PRIMARY KEY, context_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision > 0), body TEXT NOT NULL, UNIQUE(context_id, revision));
    CREATE TABLE checkpoint_heads (context_id TEXT PRIMARY KEY, revision INTEGER NOT NULL CHECK(revision > 0), image_id TEXT NOT NULL REFERENCES checkpoint_images(id), delivery TEXT);
    INSERT INTO checkpoint_images VALUES ('saved', 'owner', 1, '{"formatVersion":5}');
    INSERT INTO checkpoint_heads VALUES ('owner', 1, 'saved', NULL);
    PRAGMA user_version = 6; PRAGMA journal_mode = DELETE;`);
  database.close();
  chmodSync(disk.path, 0o644);
  const before = readFileSync(disk.path);
  const mode = statSync(disk.path).mode;
  assert.throws(() => disk.open(), /Unknown checkpoint storage columns/);
  assert.deepEqual(readFileSync(disk.path), before);
  assert.equal(statSync(disk.path).mode, mode);
  for (const suffix of ['-wal', '-shm', '-journal']) assert.equal(existsSync(disk.path + suffix), false);
  const verify = new DatabaseSync(disk.path, { readOnly: true });
  try {
    assert.equal(verify.prepare('PRAGMA journal_mode').get().journal_mode, 'delete');
  } finally {
    verify.close();
  }
});
