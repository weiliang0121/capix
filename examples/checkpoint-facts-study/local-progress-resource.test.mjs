import assert from 'node:assert/strict';
import test from 'node:test';
import { Resource, ResourceOffer, Resources } from '@weiliang0121/capix-resources';
import { FactCall } from './fact-call.mjs';
import { FactStore, identity, stableCodec } from './fact-store.mjs';
import { LocalProgress } from './local-progress.mjs';
import { StableValues } from './stable.mjs';

const failures = { isProtected: () => false, isCancellation: () => false, describe: (error) => ({ message: error instanceof Error ? error.message : String(error) }) };

function setup(t) {
  const store = new FactStore();
  t.after(() => store.close());
  const parent = new FactCall(store, identity('parent'), { input: 'fixed' });
  return { store, parent, progress: new LocalProgress(parent) };
}

function item(key) {
  return { key, revision: 1, calls: [] };
}

function save(progress, prefix, key) {
  progress.save('processing', { prefix, current: { key, revision: 1 }, cursor: 0, active: null });
}

function child(store, parent, prefix, id = 'child') {
  const input = { prefix };
  return new FactCall(store, parent.createChild(id, input), input);
}

// Deliberately conservative resource seam, not a proposed hot-path reader.
// It authenticates the whole durable owner's history, then expands the selected
// prefix. Neither the origin nor its methods can read a live parent FactCall.
function openSelection(t, store, parentIdentity, childCall) {
  const scope = new StableValues().own({ parent: parentIdentity, child: childCall.identity, input: childCall.input });
  const stats = { operations: 0, coldFactReads: 0, selectedNodes: 0 };
  const offer = new ResourceOffer({
    methods: {
      read(origin, token) {
        origin.stats.operations++;
        assert.deepEqual(token, origin.scope.input.prefix, 'Request differs from the fixed child input token');
        assert.equal(token.owner, origin.scope.parent.contextId, 'Token outside the bound parent owner');
        assert.equal(origin.scope.child.parentId, origin.scope.parent.contextId, 'Child outside the bound parent');
        const visible = origin.store.visibleFact(token.owner, token.id);
        assert.ok(visible, 'Selected local material is not durably published');
        assert.equal(visible.owner, token.owner, 'Foreign selected material');
        assert.equal(visible.kind, 'material', 'Selected reference is not material');
        const codec = stableCodec();
        const before = origin.store.stats.oldBodyReads;
        const durable = origin.store.restore(token.owner, new Map([[codec.key, codec]]));
        origin.stats.coldFactReads += origin.store.stats.oldBodyReads - before;
        assert.deepEqual(durable.head.identity, origin.scope.parent, 'Bound parent identity changed');
        const relation = durable.relations.get(origin.scope.child.contextId);
        assert.ok(relation, 'Child dispatch relationship is not durably published');
        assert.deepEqual(relation.identity, origin.scope.child, 'Inaccurate child relationship');
        assert.deepEqual(durable.values.get(relation.input), origin.scope.input, 'Child input differs from durable dispatch');
        // A read-only view over authenticated durable facts, not a second writer
        // or a separately retained prefix store. LocalProgress still checks its
        // predecessor/count rules; the generic Store does not infer those rules.
        const local = new LocalProgress({
          identity: durable.head.identity,
          material(id) {
            const metadata = durable.metadata.get(id);
            assert.ok(metadata && durable.values.has(id), 'Missing authenticated local material');
            assert.equal(metadata.owner, token.owner, 'Foreign local material owner');
            assert.equal(metadata.kind, 'material', 'Reference is not local material');
            assert.deepEqual({ ...origin.store.visibleFact(token.owner, id) }, metadata, 'Local material is no longer durably available');
            return durable.values.get(id);
          },
        });
        const result = local.materialize(token);
        origin.stats.selectedNodes += local.stats.materializedNodes;
        return result;
      },
    },
  });
  const access = new Resources()
    .register(new Resource({ store, scope, stats }), offer)
    .bind({ selection: offer.request() })
    .open({ contextId: childCall.identity.contextId, failures, validate() {} });
  t.after(() => access.close());
  return { access, endpoint: access.endpoints.selection, stats };
}

test('real resource access resolves an explicitly handed-off parent token; child local material does not', async (t) => {
  const { store, parent, progress } = setup(t);
  const prefix = progress.append(null, item('one'));
  const consumer = child(store, parent, prefix);
  save(progress, prefix, 'one');
  assert.throws(() => consumer.material(prefix.id), /Missing local material/);
  const { endpoint, stats } = openSelection(t, store, parent.identity, consumer);
  const material = await endpoint.read(consumer.input.prefix);
  assert.deepEqual(
    material.map((entry) => entry.key),
    ['one'],
  );
  assert.equal(stats.selectedNodes, 1);
  assert.equal(stats.coldFactReads, 3); // parent input + local material + child input
});

test('live captured material and an unsaved dispatch cannot bypass durable handoff', async (t) => {
  const { store, parent, progress } = setup(t);
  const prefix = progress.append(null, item('one'));
  const consumer = child(store, parent, prefix);
  assert.equal(parent.material(prefix.id).item.key, 'one');
  const first = openSelection(t, store, parent.identity, consumer);
  await assert.rejects(first.endpoint.read(prefix), /not durably published/);
  save(progress, prefix, 'one');
  assert.equal((await first.endpoint.read(prefix))[0].key, 'one');
  const unsavedConsumer = child(store, parent, prefix, 'next-child');
  const next = openSelection(t, store, parent.identity, unsavedConsumer);
  await assert.rejects(next.endpoint.read(prefix), /dispatch relationship is not durably published/);
  save(progress, prefix, 'one');
  assert.equal((await next.endpoint.read(prefix))[0].key, 'one');
});

test('resource supply checks exact owner, child identity, and the fixed selected token', async (t) => {
  const { store, parent, progress } = setup(t);
  const first = progress.append(null, item('one'));
  const alternate = progress.append(null, item('alternate'));
  const consumer = child(store, parent, first);
  save(progress, alternate, 'alternate');
  const supplied = openSelection(t, store, parent.identity, consumer);
  await assert.rejects(supplied.endpoint.read(alternate), /fixed child input token/);
  const wrongOwner = openSelection(t, store, { ...parent.identity, contextId: 'other' }, consumer);
  await assert.rejects(wrongOwner.endpoint.read(first), /bound parent owner/);
  const wrongIdentity = openSelection(t, store, { ...parent.identity, contract: 'different@1' }, consumer);
  await assert.rejects(wrongIdentity.endpoint.read(first), /identity changed/);
  const fakeChild = new FactCall(store, { ...consumer.identity, position: 'different' }, consumer.input);
  const wrongRelation = openSelection(t, store, parent.identity, fakeChild);
  await assert.rejects(wrongRelation.endpoint.read(first), /Inaccurate child relationship/);
});

test('resource lookup rejects lost durable material instead of using a live parent copy', async (t) => {
  const { store, parent, progress } = setup(t);
  const prefix = progress.append(null, item('one'));
  const consumer = child(store, parent, prefix);
  save(progress, prefix, 'one');
  const { endpoint } = openSelection(t, store, parent.identity, consumer);
  assert.equal((await endpoint.read(prefix))[0].key, 'one');
  store.db.prepare('DELETE FROM facts WHERE id=?').run(prefix.id);
  assert.equal(parent.material(prefix.id).item.key, 'one');
  await assert.rejects(endpoint.read(prefix), /not durably published/);
});

test('advancing the parent tip does not drift child material, and a closed window blocks reads', async (t) => {
  const { store, parent, progress } = setup(t);
  const first = progress.append(null, item('one'));
  const consumer = child(store, parent, first);
  save(progress, first, 'one');
  const { access, endpoint, stats } = openSelection(t, store, parent.identity, consumer);
  const earlier = await endpoint.read(first);
  const next = progress.append(first, item('two'));
  save(progress, next, 'two');
  assert.deepEqual(await endpoint.read(first), earlier);
  assert.deepEqual(
    earlier.map((entry) => entry.key),
    ['one'],
  );
  assert.equal(stats.selectedNodes, 2);
  assert.equal(stats.coldFactReads, 7); // Explicit cold owner validation grows 3 -> 4.
  access.close();
  const before = stats.operations;
  await assert.rejects(endpoint.read(first), /closed/i);
  assert.equal(stats.operations, before);
  assert.throws(() => access.endpoints.selection, /closed/i);
  assert.equal(parent.material(next.id).item.key, 'two');
});
