import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FactCall } from './fact-call.mjs';
import { FactStore, hash, identity } from './fact-store.mjs';
import { applicationContract, proposalContract, checkCaptured, checkMaintenance, checkTools, restorePoint, seedCapture, seedMaintenance, seedTools, toolContract } from './author-scenarios.mjs';

function storeFor(t) {
  const store = new FactStore();
  t.after(() => store.close());
  return store;
}

test('ToolLoop shape retains repeated declaration, handled failure, waiting child and rejection without a child', (t) => {
  const store = storeFor(t);
  const { call, first, second, active, state } = seedTools(store);
  assert.equal(call.relationCount('tool', toolContract), 3);
  assert.equal(call.relation(first).phase, 'accepted');
  assert.equal(call.relation(second).phase, 'handled');
  assert.equal(call.relation(active).phase, 'waiting');
  assert.equal(call.referenceSize('tools'), 3);
  assert.equal(store.readHead('tools').status, 'active');
  const restored = restorePoint(store, 'tools', 'author-tools@1', { waiting: checkTools });
  assert.deepEqual(restored.state, state);
  assert.deepEqual(restored.call.references('tools'), [first, second, active]);
  assert.equal(restored.call.resolve(first).mode, 'accepted');
  assert.equal(restored.call.resolve(second).mode, 'handled');
  assert.throws(() => restored.call.resolve(active), /Missing checkpoint/, 'No first child head does not authorize a new child');
});

test('same declaration cannot substitute another instance for the active role', (t) => {
  const store = storeFor(t);
  const { call, state } = seedTools(store);
  const wrong = call.createChild('other-waiting', { exchange: 'exchange-1', slot: 99 }, { position: 'tool', contract: toolContract });
  call.addReference('tools', wrong);
  call.reference('active', wrong);
  const revision = store.readHead('tools').revision;
  assert.throws(() => call.save('waiting', state, { check: checkTools }), /Active instance differs/);
  assert.equal(store.readHead('tools').revision, revision);
});

test('new slot membership from a different declaration is rejected by the author binding policy', (t) => {
  const store = storeFor(t);
  const { call, state } = seedTools(store);
  const wrong = call.createChild('different-tool', { exchange: 'exchange-1', slot: 3 }, { position: 'tool', contract: 'other@1' });
  call.addReference('tools', wrong);
  assert.throws(() => call.save('waiting', state, { check: checkTools }));
  assert.equal(store.readHead('tools').revision, 4);
});

test('ordered many allows duplicate occurrences and author order, deleting one selection leaves every fact', (t) => {
  const store = storeFor(t);
  const { call, first, second, active, state } = seedTools(store);
  const duplicate = call.addReference('tools', first, { before: call.referenceEntries('tools')[0].id });
  call.save('waiting', state, { check: checkTools });
  assert.deepEqual(call.references('tools'), [first, first, second, active]);
  call.removeReference('tools', duplicate);
  call.save('waiting', state, { check: checkTools });
  const restored = restorePoint(store, 'tools', 'author-tools@1', { waiting: checkTools });
  assert.deepEqual(restored.call.references('tools'), [first, second, active]);
  assert.equal(restored.call.relation(first).phase, 'accepted');
  assert.equal(restored.call.relationCount('tool', toolContract), 3);
});

test('empty delta still checks changed state against an old accepted fact', (t) => {
  const store = storeFor(t);
  const call = new FactCall(store, identity('parent'), null);
  const child = call.createChild('answer', null);
  call.returned(child, { text: 'X' });
  call.receive(child, { answer: 'X' });
  call.reference('chosen', child);
  const check = (state, facts) => assert.equal(state.answer, facts.value(facts.relation(facts.referenceOf('chosen')).received).answer);
  call.save('answered', { answer: 'X' }, { check });
  let delta;
  assert.throws(() =>
    call.save(
      'answered',
      { answer: 'Y' },
      {
        check: (state, facts) => {
          delta = facts.changes();
          check(state, facts);
        },
      },
    ),
  );
  assert.deepEqual(delta.events, []);
  assert.equal(delta.baseRevision, 1);
  assert.equal(store.readHead('parent').revision, 1);
  call.save('answered', { answer: 'X' }, { check });
  assert.equal(call.encodings.get('answer:returned'), 1);
  assert.equal(call.encodings.get('parent:answer:accepted'), 1);
});

test('point switch must check old relation even if state and delta are unchanged', (t) => {
  const store = storeFor(t);
  const call = new FactCall(store, identity('parent'), null);
  const child = call.createChild('waiting', null);
  call.reference('active', child);
  call.save('waiting', null);
  assert.throws(() =>
    call.save('completed', null, {
      check: (_state, facts) => {
        assert.equal(facts.changes().events.length, 0);
        assert.equal(facts.relation(facts.referenceOf('active')).phase, 'accepted');
      },
    }),
  );
  assert.equal(store.readHead('parent').point, 'waiting');
});

test('new selection of an old accepted child reruns state correlation', (t) => {
  const store = storeFor(t);
  const call = new FactCall(store, identity('parent'), null);
  const children = ['X', 'Y'].map((text) => {
    const child = call.createChild(text, null);
    call.returned(child, text);
    call.receive(child, text);
    return child;
  });
  const check = (state, facts) => assert.equal(facts.value(facts.relation(facts.referenceOf('chosen')).received), state.answer);
  call.reference('chosen', children[0]);
  call.save('answered', { answer: 'X' }, { check });
  call.reference('chosen', children[1]);
  assert.throws(() => call.save('answered', { answer: 'X' }, { check }));
  call.save('answered', { answer: 'Y' }, { check });
  assert.equal(store.stats.factsWritten, 7);
});

test('handled maintenance remains queryable after clearing refs and with empty subsequent delta', (t) => {
  const store = storeFor(t);
  const { call, child } = seedMaintenance(store);
  assert.equal(call.referenceOf('proposal'), undefined);
  const before = call.stats.authoredScans;
  call.save(
    'completed',
    { status: 'skipped' },
    {
      check: (state, facts) => {
        assert.deepEqual(facts.changes().events, []);
        checkMaintenance(state, facts);
      },
    },
  );
  assert.equal(call.stats.authoredScans, before, 'Exact indexed query does not enumerate history');
  const restored = restorePoint(store, 'maintenance', 'author-maintenance@1', { completed: checkMaintenance });
  assert.equal(restored.call.relation(child).phase, 'handled');
  assert.equal(restored.call.referenceOf('proposal'), undefined);
  assert.throws(() => restored.call.save('completed', { status: 'ready' }, { check: checkMaintenance }), /Ready requires/);
});

test('skipped proposal cannot conceal an apply child', (t) => {
  const store = storeFor(t);
  const { call } = seedMaintenance(store);
  call.createChild('apply', {}, { position: 'apply', contract: applicationContract });
  assert.throws(() => call.save('completed', { status: 'skipped' }, { check: checkMaintenance }), /Skipped branch/);
});

test('skipped maintenance cannot conceal a child outside known propose/apply indices', (t) => {
  const store = storeFor(t);
  const { call } = seedMaintenance(store);
  call.createChild('unrelated', {}, { position: 'other', contract: 'other@1' });
  assert.throws(() => call.save('completed', { status: 'skipped' }, { check: checkMaintenance }), /unexpected children/);
});

test('ready maintenance needs the accurate accepted application, not only the proposal', (t) => {
  const store = storeFor(t);
  const call = new FactCall(store, identity('maintenance', null, 'root', 0, 'author-maintenance@1'), { message: 4 });
  const proposal = call.createChild('proposal', { message: 4 }, { position: 'propose', contract: proposalContract });
  const changes = [{ text: 'new memory' }];
  call.returned(proposal, changes);
  call.receive(proposal, { status: 'ready', changes });
  assert.throws(() => call.save('completed', { status: 'ready' }, { check: checkMaintenance }), /exactly proposal and apply/);
  const apply = call.createChild('apply', { changes }, { position: 'apply', contract: applicationContract });
  call.returned(apply, ['memory-1']);
  call.receive(apply, ['memory-1']);
  call.save('completed', { status: 'ready' }, { check: checkMaintenance });
  const restored = restorePoint(store, 'maintenance', 'author-maintenance@1', { completed: checkMaintenance });
  assert.equal(restored.call.relation(apply).phase, 'accepted');
});

test('material and state cannot jointly substitute a source different from immutable call input', (t) => {
  const store = storeFor(t);
  const { call } = seedCapture(store);
  const material = call.capture({ source: 'other-file', version: 7, text: 'wrong source' });
  assert.throws(() => call.save('captured', { source: 'other-file', version: 7, material }, { check: checkCaptured }), /differs from original input/);
});

test('local material lookup rejects input and child delivery IDs even if their values match', (t) => {
  const store = storeFor(t);
  const { call, state } = seedCapture(store);
  const child = call.createChild('child-material', null);
  call.returned(child, { source: 'file-1', version: 7, text: 'same fields' });
  assert.throws(() => call.material('capture:input'), /not local material/);
  assert.throws(() => call.save('captured', { ...state, material: call.relation(child).output }, { check: checkCaptured }), /Foreign material owner/);
});

test('local continuation material is fixed, persisted once, and not a successful delivery', (t) => {
  const store = storeFor(t);
  const { call, state, raw } = seedCapture(store, 'x'.repeat(64 * 1024));
  assert.equal(raw.version, 8);
  const prior = { ...store.stats };
  const encodings = new Map(call.encodings);
  call.save('captured', state, { check: checkCaptured });
  assert.equal(store.stats.factBytesWritten, prior.factBytesWritten);
  assert.deepEqual(call.encodings, encodings);
  assert.equal(store.readHead('capture').delivery, null);
  assert.ok(Buffer.byteLength(store.readHead('capture').state) < 1024);
  const restored = restorePoint(store, 'capture', 'author-capture@1', { captured: checkCaptured });
  assert.equal(restored.call.value(state.material).version, 7);
  assert.equal(restored.call.value(state.material).text.length, 64 * 1024);
  restored.call.fail();
  assert.equal(store.readHead('capture').status, 'failed', 'A later failure still prevents successful call delivery');
});

test('local material body missing on cold restore rejects; no live entity reread fallback', (t) => {
  const store = storeFor(t);
  const { state } = seedCapture(store);
  store.db.prepare('DELETE FROM facts WHERE id=?').run(state.material);
  assert.throws(() => restorePoint(store, 'capture', 'author-capture@1', { captured: checkCaptured }), /Missing fact/);
});

test('cold restore runs business point check even when head/hash are structurally valid', (t) => {
  const store = storeFor(t);
  seedMaintenance(store);
  const row = store.db.prepare('SELECT body FROM heads WHERE owner=?').get('maintenance');
  const head = JSON.parse(row.body);
  // State encoding is valid; its business correlation is deliberately false.
  const codec = new FactCall(store, identity('unused'), null);
  codec.save('unused', { status: 'ready' });
  head.state = store.readHead('unused').state;
  const body = JSON.stringify(head);
  store.db.prepare('UPDATE heads SET body=?,digest=? WHERE owner=?').run(body, hash(body), 'maintenance');
  assert.throws(() => restorePoint(store, 'maintenance', 'author-maintenance@1', { completed: checkMaintenance }), /Ready requires/);
});

test('cold restore refuses incompatible author contract or unknown point before resumed processing', (t) => {
  const store = storeFor(t);
  seedCapture(store);
  assert.throws(() => restorePoint(store, 'capture', 'author-capture@2', { captured: checkCaptured }), /Author contract changed/);
  assert.throws(() => restorePoint(store, 'capture', 'author-capture@1', {}), /Unknown author point/);
});

test('asynchronous check cannot commit or permit resumed processing', async (t) => {
  const store = storeFor(t);
  const { call, state } = seedCapture(store);
  const prior = store.readHead('capture').revision;
  assert.throws(
    () =>
      call.save('captured', state, {
        check: async () => {
          throw new Error('late rejection');
        },
      }),
    /must be synchronous/,
  );
  assert.equal(store.readHead('capture').revision, prior);
  assert.throws(() => restorePoint(store, 'capture', 'author-capture@1', { captured: async () => {} }), /must be synchronous/);
  await new Promise((resolve) => setImmediate(resolve)); // Rejected checks are consumed, not unhandled.
});

test('same author alias at different points can map to different slot identities and cardinalities', (t) => {
  const store = storeFor(t);
  const call = new FactCall(store, identity('parent'), null);
  const child = call.createChild('child', null);
  // Storage key is a resolved slot identity; author spelling is not global.
  const waiting = { selected: 'waiting/selected' };
  const completed = { selected: 'completed/selected' };
  call.reference(waiting.selected, child);
  call.save('waiting', null);
  call.clearReference(waiting.selected);
  call.addReference(completed.selected, child);
  call.addReference(completed.selected, child);
  call.save('another-point', null);
  const restored = FactCall.reopen(store, 'parent');
  assert.equal(restored.referenceOf(waiting.selected), undefined);
  assert.deepEqual(restored.references(completed.selected), [child, child]);
});
