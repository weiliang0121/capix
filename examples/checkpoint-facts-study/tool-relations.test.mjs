import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ToolRelations } from './tool-relations.mjs';

function relation(contextId, order, options = {}) {
  const { parentId = 'loop', position = 'read', contract = 'read@1', key = 'same-call-id', input = { path: 'a' } } = options;
  return { identity: { contextId, parentId, position, contract, order }, key, input, phase: 'waiting' };
}

function query(index, options = {}) {
  return index.query({ parentId: 'loop', position: 'read', contract: 'read@1', key: 'same-call-id', ...options });
}

test('tool relation index scopes repeated keys to an exact member and model interval', () => {
  const index = new ToolRelations([relation('first', 2), relation('second', 6), relation('other-parent', 2, { parentId: 'foreign' }), relation('other-position', 3, { position: 'write' }), relation('other-contract', 3, { contract: 'read@2' }), relation('other-key', 3, { key: 'different' })]);
  assert.deepEqual(
    query(index, { after: 1, before: 5 }).map((entry) => entry.identity.contextId),
    ['first'],
  );
  assert.deepEqual(
    query(index, { after: 5, before: 9 }).map((entry) => entry.identity.contextId),
    ['second'],
  );
  assert.deepEqual(query(index, { after: 2, before: 6 }), []);
  assert.deepEqual(query(index, { key: 'missing' }), []);
});

test('duplicate candidates survive and author selection order is distinct from creation order', () => {
  const first = relation('first', 2);
  const second = relation('second', 3);
  const index = new ToolRelations([first, second]);
  const candidates = query(index, { after: 1, before: 4 });
  assert.deepEqual(
    candidates.map((entry) => entry.identity.contextId),
    ['first', 'second'],
  );
  assert.equal(index.firstInReferences(candidates, [second.identity, first.identity]).identity.contextId, 'second');
  assert.equal(index.firstInReferences(candidates, [second.identity, first.identity], (entry) => entry.identity.contextId === 'first').identity.contextId, 'first');
  assert.equal(index.firstInReferences(candidates, []), undefined);
});

test('exact input remains a caller predicate and a same-key candidate cannot overwrite another', () => {
  const wrong = relation('wrong', 2, { input: { path: 'wrong' } });
  const correct = relation('correct', 3, { input: { path: 'wanted' } });
  const index = new ToolRelations([wrong, correct]);
  const candidates = query(index);
  const found = index.firstInReferences(candidates, [wrong.identity, correct.identity], (entry) => entry.input.path === 'wanted');
  assert.equal(found.identity.contextId, 'correct');
  assert.equal(index.size, 2);
  assert.equal(
    index.firstInReferences(candidates, [wrong.identity], (entry) => entry.input.path === 'wanted'),
    undefined,
  );
});

test('identity and key are pinned while current relation state can advance', () => {
  const source = relation('child', 2);
  const index = new ToolRelations([source]);
  source.key = 'mutated';
  source.identity.order = 900;
  source.input.path = 'changed';
  assert.equal(query(index)[0].identity.order, 2);
  assert.equal(query(index)[0].key, 'same-call-id');
  // The ledger, not the lookup, owns input stability. Input aliases cannot move
  // a relation to another bucket or change the selected relation identity.
  assert.equal(query(index)[0].input.path, 'changed');
  const accepted = index.put({ ...index.get('child'), phase: 'accepted' });
  assert.equal(query(index)[0], accepted);
  assert.equal(index.size, 1);
  assert.throws(() => index.put({ ...accepted, key: 'replacement' }), /key changed/);
  for (const field of ['contextId', 'parentId', 'position', 'contract', 'order']) {
    if (field === 'contextId') continue; // A genuinely new context is a new relation.
    const identity = { ...accepted.identity, [field]: field === 'order' ? 4 : 'changed' };
    assert.throws(() => index.put({ ...accepted, identity }), /identity changed/);
  }
  assert.equal(query(index)[0], accepted);
});

test('removing one author occurrence never erases the relation ledger', () => {
  const child = relation('child', 2);
  const index = new ToolRelations([child]);
  const references = [child.identity, child.identity];
  references.splice(0, 1);
  assert.equal(index.firstInReferences(query(index), references).identity.contextId, 'child');
  references.pop();
  assert.equal(index.firstInReferences(query(index), references), undefined);
  assert.equal(query(index).length, 1);
  assert.equal(index.get('child').identity.contextId, 'child');
});

test('cold rebuild sorts restored facts and incremental out-of-order insertion remains queryable', () => {
  const history = [relation('a', 2), relation('b', 5), relation('c', 9)];
  const live = new ToolRelations(history);
  const restored = new ToolRelations(JSON.parse(JSON.stringify([...history].reverse())));
  assert.deepEqual(query(restored), query(live));
  restored.put(relation('middle', 7));
  assert.deepEqual(
    query(restored, { after: 4, before: 10 }).map((entry) => entry.identity.contextId),
    ['b', 'middle', 'c'],
  );
  assert.equal(query(live).length, 3);
  assert.equal(restored.stats.queries, 2);
});

test('bounded key query cost is logarithmic plus candidates, independent of unrelated facts', () => {
  const history = Array.from({ length: 4096 }, (_, order) => relation(`child-${order}`, order));
  const unrelated = Array.from({ length: 4096 }, (_, order) => relation(`foreign-${order}`, order, { parentId: 'other' }));
  const index = new ToolRelations([...history, ...unrelated]);
  assert.deepEqual(
    query(index, { after: 2047, before: 2050 }).map((entry) => entry.identity.order),
    [2048, 2049],
  );
  assert.equal(index.stats.queryCandidates, 2);
  assert.ok(index.stats.queryComparisons <= 26);
  assert.equal(index.stats.referenceScans, 0);
  assert.equal(index.stats.reads, 0);
  const missing = query(index, { key: 'absent' });
  assert.deepEqual(missing, []);
  assert.equal(index.stats.queryCandidates, 2);
});

test('author-order compatibility makes its scan cost explicit instead of claiming constant selection', () => {
  const records = Array.from({ length: 128 }, (_, order) => relation(`child-${order}`, order));
  const index = new ToolRelations(records);
  const candidates = query(index, { after: 126 });
  assert.equal(
    index.firstInReferences(
      candidates,
      records.map((record) => record.identity),
    ).identity.contextId,
    'child-127',
  );
  assert.equal(index.stats.referenceScans, 128);
  assert.equal(index.stats.referenceCandidates, 1);
  assert.equal(index.stats.queryCandidates, 1);
  assert.throws(() => index.firstInReferences(candidates, [{ ...records[127].identity, parentId: 'forged' }]), /identity mismatch/);
});

test('missing scope, invalid coordinates and invalid intervals reject without installing data', () => {
  const index = new ToolRelations();
  assert.throws(() => index.put(relation('bad', -1)), /order/);
  assert.throws(() => index.put(relation('bad', 1, { parentId: '' })), /parentId/);
  assert.equal(index.size, 0);
  assert.throws(() => query(index, { position: undefined }), /scope/);
  assert.throws(() => query(index, { after: 2, before: 2 }), /interval/);
  assert.throws(() => query(index, { before: NaN }), /upper bound/);
});
