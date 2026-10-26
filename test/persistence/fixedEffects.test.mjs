import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Transcript } from '@capix/transcript';
import { Memories } from '@capix/memory';
import { SqliteObserverStore } from '@capix/observer-service';
import { WorkspaceFiles } from '@capix/observer-service/assembly';

function disk(t) {
  const root = mkdtempSync(join(tmpdir(), 'capix-fixed-effects-'));
  const path = join(root, 'observer.sqlite');
  const stores = [];
  t.after(() => {
    for (const store of stores) store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    path,
    open() {
      const store = SqliteObserverStore.open(path);
      stores.push(store);
      return store;
    },
  };
}
function memoryRequest(memories, changes, position = 'memory') {
  return { contract: { key: 'memories.apply', version: 1 }, operation: { contextId: 'apply-call', position }, memoriesId: memories.id, changes };
}
const change = { action: 'create', memoryId: null, change: 'retain accepted information', sourceIndexes: [0], result: { topic: 'topic', content: 'accepted', sourceIndexes: [0] } };

test('fixed memory batch restores receipt after post-commit notification failure without duplicate facts', (t) => {
  const fixture = disk(t);
  const store = fixture.open();
  const transcript = new Transcript([{ role: 'user', content: 'evidence' }]);
  const original = new Memories(transcript);
  store.initialize({ transcript: transcript.exportState(), memories: original.exportState() });
  const memories = Memories.restore(original.exportState(), transcript, {
    persistence: store.memories,
    changes: {
      capture() {
        throw new Error('notification lost');
      },
    },
  });
  const request = memoryRequest(memories, [change]);
  assert.throws(() => memories.applyFixed(request));
  const receipt = memories.confirmFixed(request);
  assert.equal(receipt.sequence, 1);
  store.close();
  const reopened = fixture.open();
  const content = reopened.loadContent();
  const restored = Memories.restore(content.memories, Transcript.restore(content.transcript), {
    persistence: reopened.memories,
    changes: {
      capture() {
        assert.fail('old fact must not publish');
      },
    },
  });
  assert.deepEqual(restored.applyFixed(request), receipt);
  assert.equal(restored.values().length, 1);
  assert.equal(restored.sequence, 1);
  assert.throws(() => restored.applyFixed({ ...request, changes: [{ ...change, change: 'different basis' }] }), { code: 'MEMORY_APPLY_CONFLICT' });
  const empty = restored.applyFixed(memoryRequest(restored, [], 'empty'));
  assert.equal(empty.startSequence, 1);
  assert.equal(empty.sequence, 1);
  assert.equal(restored.exportState().applies.length, 2);
});

test('memory batch and receipt share one transaction, with no partial memory on receipt failure', (t) => {
  const fixture = disk(t);
  fixture.open().close();
  const database = new DatabaseSync(fixture.path);
  database.exec("CREATE TRIGGER reject_memory_receipt BEFORE INSERT ON memory_applies BEGIN SELECT RAISE(ABORT, 'receipt failure'); END;");
  database.close();
  const store = fixture.open();
  const transcript = new Transcript([{ role: 'user', content: 'evidence' }]);
  const original = new Memories(transcript);
  store.initialize({ transcript: transcript.exportState(), memories: original.exportState() });
  const memories = Memories.restore(original.exportState(), transcript, { persistence: store.memories });
  const request = memoryRequest(memories, [change]);
  assert.throws(() => memories.applyFixed(request));
  assert.equal(memories.sequence, 0);
  assert.equal(memories.confirmFixed(request), undefined);
  store.close();
  const reopened = fixture.open();
  assert.equal(reopened.loadContent().memories.items.length, 0);
  assert.equal(reopened.loadContent().memories.applies, undefined);
});

test('fixed file creation restores historical committed receipt without another write or publication', async (t) => {
  const fixture = disk(t);
  const store = fixture.open();
  const operation = { contextId: 'create-call', position: 'result' };
  const files = new WorkspaceFiles({ root: fixture.root, persistence: store.fileCreations });
  const receipt = await files.createFixed(operation, 'result.md', 'original');
  store.close();
  const reopened = fixture.open();
  const restored = new WorkspaceFiles({ root: fixture.root, persistence: reopened.fileCreations });
  assert.deepEqual(await restored.createFixed(operation, 'result.md', 'original'), receipt);
  await unlink(join(fixture.root, 'result.md'));
  assert.deepEqual(await restored.createFixed(operation, 'result.md', 'original'), receipt, 'receipt is a historical fact, not a claim about current filesystem state');
  await assert.rejects(readFile(join(fixture.root, 'result.md')), { code: 'ENOENT' });
  await assert.rejects(restored.createFixed(operation, 'result.md', 'changed'), { code: 'FILE_CREATION_CONFLICT' });
});

test('file published before receipt commit remains unknown after restart and is never resent', async (t) => {
  const fixture = disk(t);
  const store = fixture.open();
  const operation = { contextId: 'uncertain-create', position: 'result' };
  const files = new WorkspaceFiles({
    root: fixture.root,
    persistence: {
      ...store.fileCreations,
      complete() {
        throw new Error('interrupted after filesystem commit');
      },
    },
  });
  await assert.rejects(files.createFixed(operation, 'result.md', 'original'), (error) => error.code === 'PERSISTENCE_FAILED' && /interrupted/.test(error.cause?.message));
  assert.equal(await readFile(join(fixture.root, 'result.md'), 'utf8'), 'original');
  store.close();
  const reopened = fixture.open();
  const restored = new WorkspaceFiles({ root: fixture.root, persistence: reopened.fileCreations });
  await assert.rejects(restored.createFixed(operation, 'result.md', 'original'), { code: 'FILE_CREATION_UNCONFIRMED' });
  await unlink(join(fixture.root, 'result.md'));
  await assert.rejects(restored.createFixed(operation, 'result.md', 'original'), { code: 'FILE_CREATION_UNCONFIRMED' });
  await assert.rejects(readFile(join(fixture.root, 'result.md')), { code: 'ENOENT' });
});
