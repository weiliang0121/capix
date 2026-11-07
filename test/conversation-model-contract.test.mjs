import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Interaction } from '@capix/interaction';
import { ConversationStore } from '@capix/conversation-service/persistence';
import { loadConversationContent } from '@capix/conversation-service/assembly';
import { CompletionInteraction } from '@capix/conversation-service';
import { PersistenceError } from '@capix/diagnostics';

async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'capix-model-legacy-'));
  const path = join(directory, 'content.sqlite');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const initial = ConversationStore.open(path);
  loadConversationContent(initial);
  initial.close();
  const old = new Interaction({ messages: [{ role: 'user', content: 'old question' }] }, { contract: { key: 'conversation.completion.v1', request: (v) => v, reply: (v) => v } });
  old.start(async () => ({ id: 'old-reply', model: 'old-model', text: 'old answer', finishReason: 'stop', usage: null }));
  await old.settled();
  const state = old.exportState();
  const sql = new DatabaseSync(path);
  sql.prepare('INSERT INTO completion_interactions VALUES (?, ?, ?)').run(state.id, state.revision, JSON.stringify(state));
  sql.close();
  const store = ConversationStore.open(path);
  t.after(() => store.close());
  return { store, state };
}

test('saved text v1 is rejected without a historical decoder or fabricated native continuation', async (t) => {
  const { store, state } = await fixture(t);
  assert.equal('readHistory' in store.interactions, false);
  assert.throws(() => store.interactions.read(state.id), PersistenceError);
  assert.throws(() => store.assertAvailable(), PersistenceError);
  assert.equal(CompletionInteraction.key, 'conversation.completion.v2');
  assert.throws(() => Interaction.restore(state, { contract: CompletionInteraction }));
});
