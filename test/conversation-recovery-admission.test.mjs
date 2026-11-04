import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { assertConversationRecovery, restoreConversationContent } from '@capix/conversation-service/assembly';
import { ConversationStore } from '@capix/conversation-service/persistence';

const fixture = fileURLToPath(new URL('./fixtures/conversation-recovery.mjs', import.meta.url));

function captured(t, boundary = 'memory') {
  const directory = mkdtempSync(join(tmpdir(), 'capix-recovery-admission-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'conversation.sqlite');
  const child = spawnSync(process.execPath, [fixture, boundary === 'completed' ? 'run' : 'crash', path, boundary], { encoding: 'utf8', timeout: 10_000 });
  assert.ifError(child.error);
  assert.equal(child.status, boundary === 'completed' ? 0 : 73, child.stdout + child.stderr);
  const store = ConversationStore.open(path);
  try {
    const root = store.checkpoints.listRoots().at(-1);
    const heads = new Map();
    function collect(head) {
      heads.set(head.image.frame.owner.contextId, structuredClone(head));
      for (const child of head.image.frame.children) {
        const saved = store.checkpoints.read(child.identity.contextId);
        if (saved) collect(saved);
      }
    }
    collect(root);
    const contextId = root.image.frame.owner.contextId;
    // A real last image just before root finish has the same content, but no terminal delivery.
    if (boundary === 'completed') delete heads.get(contextId).delivery;
    const state = structuredClone(store.load());
    const interactions = new Map([...heads.values()].filter((head) => head.image.contract.key === 'conversation.completion-start').map((head) => [head.image.state.id, store.interactions.read(head.image.state.id)]));
    const port = { assertAvailable() {}, interactions: { read: (id) => interactions.get(id) }, checkpoints: { read: (id) => heads.get(id), listRoots: () => [heads.get(contextId)] } };
    const check = () => assertConversationRecovery(restoreConversationContent(state), port, 'test-v1', contextId);
    check();
    return { heads, state, check, root: heads.get(contextId), contextId };
  } finally {
    store.close();
  }
}

test('host eligibility refuses a pending child whose checkpoint disappeared', (t) => {
  const fixture = captured(t);
  const head = [...fixture.heads.values()].find((head) => head.image.contract.key === 'conversation.memory.apply');
  fixture.heads.delete(head.image.frame.owner.contextId);
  assert.throws(fixture.check, { code: 'CHECKPOINT_CONTENT_CHANGED' });
});

test('host eligibility requires a completed memory application to retain its exact fixed effect and output IDs', async (t) => {
  for (const corruption of ['missing receipt', 'missing effect', 'different IDs'])
    await t.test(corruption, (t) => {
      const fixture = captured(t, 'completed');
      const applied = [...fixture.heads.values()].find((head) => head.image.contract.key === 'conversation.memory.apply');
      if (corruption === 'missing receipt') delete fixture.state.memories.applies;
      else if (corruption === 'different IDs') applied.image.state = ['unrelated-memory'];
      else {
        const original = fixture.root.image.state.basis.memories;
        fixture.state.memories = structuredClone(original);
        fixture.state.view.members = fixture.state.view.members.filter((ref) => ref.source !== 'memories');
        fixture.state.view.revision--;
      }
      assert.throws(fixture.check, { code: 'CHECKPOINT_CONTENT_CHANGED' });
    });
});

test('host eligibility rejects a fixed memory call whose source identity no longer matches its receipt', async (t) => {
  for (const field of ['memoriesId', 'transcriptId'])
    await t.test(field, (t) => {
      const fixture = captured(t);
      const applied = [...fixture.heads.values()].find((head) => head.image.contract.key === 'conversation.memory.apply');
      applied.image.frame.input.basis[field] = 'different-owner';
      assert.throws(fixture.check, { code: 'CHECKPOINT_CONTENT_CHANGED' });
    });
});

test('completed message inclusion cannot resume after its member was rolled back to an earlier valid View', (t) => {
  const fixture = captured(t, 'feedback');
  fixture.state.view = structuredClone(fixture.root.image.state.basis.view);
  assert.throws(fixture.check, { code: 'CHECKPOINT_CONTENT_CHANGED' });
});

test('completed memory inclusion cannot resume after its member was rolled back to the preceding valid View', (t) => {
  const fixture = captured(t, 'completed');
  fixture.state.view.members = fixture.state.view.members.filter((ref) => ref.source !== 'memories');
  fixture.state.view.revision--;
  assert.throws(fixture.check, { code: 'CHECKPOINT_CONTENT_CHANGED' });
});

test('an accepted answer cannot resume after content is rolled back to the pre-answer basis', (t) => {
  const fixture = captured(t);
  const basis = fixture.root.image.state.basis;
  assert.ok(fixture.root.image.state.response, 'the root formally accepted the assistant answer');
  fixture.state.transcript = { id: basis.accepted.transcriptId, messages: fixture.state.transcript.messages.slice(0, basis.transcript.end), starts: [...basis.transcript.starts], revision: basis.transcript.revision };
  fixture.state.memories = structuredClone(basis.memories);
  fixture.state.view = structuredClone(basis.view);
  assert.throws(fixture.check, { code: 'CHECKPOINT_CONTENT_CHANGED' });
});
