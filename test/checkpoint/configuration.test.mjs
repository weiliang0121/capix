import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ObserverConversations, SqliteObserverStore, WorkspaceFiles } from '@capix/observer-service/assembly';

const settings = { model: 'test', contextBudget: 16000, maxOutputTokens: 1536, timeoutMs: 1000 };
const provider = {
  async invoke(_request, purpose) {
    const content = purpose === 'selection' ? { historyIndexes: [] } : purpose === 'understanding' ? { kind: 'reply' } : purpose === 'memory' ? { memories: [] } : { kind: 'answer', content: 'reply' };
    return { id: 'fixture', model: 'test', content: JSON.stringify(content), finishReason: 'stop', usage: null };
  },
};

for (const changed of ['root', 'readLimit', 'writeLimit']) {
  test(`host rejects changed workspace ${changed} before restoring any work`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'capix-cp-scope-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const root = join(directory, 'original');
    const other = join(directory, 'other');
    mkdirSync(root);
    mkdirSync(other);
    const path = join(directory, 'observer.sqlite');
    const persistence = SqliteObserverStore.open(path);
    const files = new WorkspaceFiles({ root, maxReadBytes: 1000, maxWriteBytes: 1000, persistence: persistence.fileCreations });
    const host = new ObserverConversations(provider, [], { persistence, files });
    const conversation = host.list().conversations[0];
    const environment = host.open(conversation.id);
    await environment.runtime.run({ messages: [{ role: 'user', content: 'hello' }] }, { settings });
    const [run] = environment.checkpointRuns.list(conversation.id);
    assert.equal(run.configuration.fileScope, files.checkpointScope);
    host.close();
    const nextStore = SqliteObserverStore.open(path);
    const next = new ObserverConversations(
      {
        invoke() {
          assert.fail('mismatched workspace cannot dispatch');
        },
      },
      [],
      {
        persistence: nextStore,
        files: new WorkspaceFiles({ root: changed === 'root' ? other : root, maxReadBytes: changed === 'readLimit' ? 2000 : 1000, maxWriteBytes: changed === 'writeLimit' ? 2000 : 1000, persistence: nextStore.fileCreations }),
      },
    );
    try {
      await assert.rejects(next.recover(conversation.id, run.rootContextId), { code: 'CHECKPOINT_CONFIGURATION_CHANGED' });
    } finally {
      next.close();
    }
  });
}
