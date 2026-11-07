import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Invocation, InvocationContext } from '@capix/invocation';
import { MemoryCheckpointStore, cloneCheckpointHead } from '@capix/checkpoint';

const identity = { encode: (value) => value, decode: (value) => value };

function setup({ execute, check, store = new MemoryCheckpointStore(), saved, beforeSave, afterSave, finish, resume } = {}) {
  const context = new InvocationContext(null);
  if (saved) context.installCheckpoint({ id: saved.image.frame.owner.contextId, round: 1, currentInput: null });
  const writes = [];
  const signal = new AbortController().signal;
  const childBinding = { key: 'incremental-selection-child', version: 1, input: identity, output: identity, points: {} };
  const point = (position = 0) => ({ state: identity, references: { models: { cardinality: 'many', position } }, check, execute: resume ?? (() => assert.fail('unexpected resume')) });
  const binding = {
    key: 'incremental-selection-parent',
    version: 1,
    input: identity,
    output: identity,
    children: [
      { kind: 'node', binding: childBinding },
      { kind: 'node', binding: childBinding },
    ],
    points: { waiting: point(), accepted: point(), wrong: point(1), one: { state: identity, references: { models: { cardinality: 'one', position: 0 } }, execute() {} }, mixed: { state: identity, references: { models: { cardinality: 'many', position: 0 }, copied: { cardinality: 'many', position: 0 }, latest: { cardinality: 'one', position: 0 } }, execute() {} } },
  };
  const port = {
    read: (id) => store.read(id),
    save(commit, revision) {
      beforeSave?.(commit, revision);
      const receipt = store.save(commit, revision);
      writes.push(commit);
      return afterSave?.(receipt, commit) ?? receipt;
    },
    finish: finish ?? ((...args) => store.finish(...args)),
  };
  const invocation = new Invocation({ context, signal, identity: { contextId: context.id, kind: 'group' }, checkpoints: { store: port }, ...(saved ? { restore: { head: saved } } : {}), work: { checkpoint: binding, execute: (_context, parent) => execute(parent) } });
  function child(parent, input = 'child', position = 0) {
    const childContext = new InvocationContext(input);
    const invocation = new Invocation({ context: childContext, identity: { contextId: childContext.id, parentContextId: parent.context.id, kind: 'node' }, signal, parent: { invocation: parent, declarationPosition: position }, work: { checkpoint: childBinding, execute: () => input } });
    const relation = parent.children.get(invocation);
    const ref = { contextId: childContext.id, parentContextId: parent.context.id, parentRound: relation.round, order: relation.order, target: { position } };
    return { invocation, ref };
  }
  return { invocation, writes, store, child, context };
}

test('owned selection saves only new occurrences while preserving duplicate order and all relations', async () => {
  let escaped;
  const observations = [];
  const fixture = setup({
    check(_frame, state, refs, decoded) {
      assert.ok(Array.isArray(refs.models));
      observations.push({ state, length: refs.models.length, last: refs.models.at(-1)?.contextId });
      assert.deepEqual(
        refs.models.map((ref) => ref.contextId),
        [...refs.models].map((ref) => ref.contextId),
      );
      assert.equal(decoded.children.length, state < 3 ? 2 : 3, 'selection does not remove or hide unselected relationships');
      escaped ??= refs.models;
    },
    async execute(parent) {
      const first = fixture.child(parent, 'first');
      const second = fixture.child(parent, 'second');
      const selection = parent.checkpointWriter.select(0);
      const one = selection.add(first.ref);
      const duplicate = selection.add(first.ref);
      const omitted = selection.add(second.ref);
      selection.remove(omitted); // Local add/remove does not allocate durable order.
      parent.checkpointWriter.save('waiting', 1, { models: selection });
      assert.throws(() => escaped.length, /outside/);
      await first.invocation.run();
      await parent.children.get(first.invocation).accept((value) => value);
      parent.checkpointWriter.save('accepted', 2, { models: selection });
      parent.checkpointWriter.save('waiting', 2, { models: selection });
      selection.remove(one);
      const third = fixture.child(parent, 'third');
      selection.add(third.ref);
      assert.equal(selection.occurrenceAt(0), duplicate);
      parent.checkpointWriter.save('waiting', 3, { models: selection });
      assert.equal(parent.children.values().length, 3);
      return null;
    },
  });
  await fixture.invocation.run();
  const [first, advanced, unchanged, next] = fixture.writes;
  assert.equal(first.selectionChanges.length, 1);
  assert.equal(first.selectionChanges[0].append.length, 2);
  assert.equal(unchanged.selectionChanges, undefined, 'point switching does not republish an unchanged selection');
  assert.equal(advanced.children.length, 1, 'the returned relation still progresses independently');
  assert.equal(unchanged.children.length, 0);
  assert.equal(unchanged.values.length, 1, 'only point state is published when old selection and inputs are unchanged');
  assert.equal(next.selectionChanges[0].append.length, 1);
  assert.equal(next.selectionChanges[0].remove.length, 1);
  assert.equal(next.selectionChanges[0].remove[0].order, 0);
  assert.deepEqual(
    observations.map(({ length }) => length),
    [2, 2, 2, 2],
  );
  const head = fixture.store.read(fixture.context.id);
  assert.equal(head.image.frame.children.length, 3);
  assert.deepEqual(
    head.image.references.models.map((ref) => ref.contextId),
    [first.selectionChanges[0].append[1].reference.contextId, next.selectionChanges[0].append[0].reference.contextId],
  );
});

test('each newly supplied reference is authenticated even if its child was previously selected', async (t) => {
  for (const property of ['parentContextId', 'order', 'target'])
    await t.test(property, async () => {
      const fixture = setup({
        execute(parent) {
          const child = fixture.child(parent);
          const selection = parent.checkpointWriter.select(0);
          selection.add(child.ref);
          parent.checkpointWriter.save('waiting', null, { models: selection });
          const forged = { ...child.ref, [property]: property === 'target' ? { position: 1 } : property === 'order' ? 999 : 'other-owner' };
          selection.add(forged);
          assert.fail('forged selection must not be admitted');
        },
      });
      await assert.rejects(fixture.invocation.run(), /reference|declaration/);
      assert.equal(fixture.writes.length, 1);
    });
});

test('selection occurrences are exact and removal never means removing every equal child', async () => {
  const fixture = setup({
    execute(parent) {
      const child = fixture.child(parent);
      const left = parent.checkpointWriter.select(0);
      const first = left.add(child.ref);
      left.add(child.ref);
      left.remove(first);
      assert.equal(left.length, 1);
      parent.checkpointWriter.save('waiting', null, { models: left });
      return null;
    },
  });
  await fixture.invocation.run();
  assert.equal(fixture.writes[0].selectionChanges[0].append.length, 1);
  assert.deepEqual(fixture.writes[0].selectionChanges[0].remove, []);
});

test('invalid occurrence removal remains a protected failure when the low-level caller catches it', async (t) => {
  for (const invalid of ['foreign', 'forged', 'removed'])
    await t.test(invalid, async () => {
      const fixture = setup({
        execute(parent) {
          const child = fixture.child(parent);
          const selected = parent.checkpointWriter.select(0);
          const original = selected.add(child.ref);
          const other = parent.checkpointWriter.select(0);
          const foreign = other.add(child.ref);
          const token = invalid === 'foreign' ? foreign : invalid === 'forged' ? {} : original;
          if (invalid === 'removed') selected.remove(original);
          assert.throws(() => selected.remove(token), /occurrence/);
          assert.throws(() => parent.checkpointWriter.save('waiting', null, { models: selected }), /occurrence/);
          return null;
        },
      });
      await assert.rejects(fixture.invocation.run(), /occurrence/);
      assert.equal(fixture.writes.length, 0);
    });
});

test('point changes recheck declared position and cardinality even with no selection changes', async (t) => {
  for (const point of ['wrong', 'one'])
    await t.test(point, async () => {
      const fixture = setup({
        execute(parent) {
          const child = fixture.child(parent);
          const selection = parent.checkpointWriter.select(0);
          selection.add(child.ref);
          parent.checkpointWriter.save('waiting', null, { models: selection });
          parent.checkpointWriter.save(point, null, { models: selection });
        },
      });
      await assert.rejects(fixture.invocation.run(), /declaration|cardinality/);
      assert.equal(fixture.writes.length, 1);
    });
});

test('a selection from another still-running invocation grants no authority', async () => {
  let selected;
  let announce;
  let release;
  const ready = new Promise((resolve) => {
    announce = resolve;
  });
  const hold = new Promise((resolve) => {
    release = resolve;
  });
  const owner = setup({
    async execute(parent) {
      const child = owner.child(parent);
      selected = parent.checkpointWriter.select(0);
      selected.add(child.ref);
      announce();
      await hold;
      return null;
    },
  });
  const pending = owner.invocation.run();
  await ready;
  const other = setup({
    execute(parent) {
      parent.checkpointWriter.save('waiting', null, { models: selected });
    },
  });
  try {
    await assert.rejects(other.invocation.run(), /checkpoint|accessor|hidden|value|data/i);
    assert.equal(other.writes.length, 0);
  } finally {
    release();
    await pending;
  }
});

test('a plain imported array remains a new selection and cannot impersonate restored evidence', async () => {
  const fixture = setup({
    execute(parent) {
      const child = fixture.child(parent);
      const original = parent.checkpointWriter.select(0, [child.ref, child.ref]);
      parent.checkpointWriter.save('waiting', 1, { models: original });
      const copied = parent.checkpointWriter.select(0, [...original]);
      assert.notEqual(copied, original);
      parent.checkpointWriter.save('waiting', 2, { models: copied });
      return null;
    },
  });
  await fixture.invocation.run();
  assert.notEqual(fixture.writes[0].selectionChanges[0].id, fixture.writes[1].selectionChanges[0].id);
  assert.equal(fixture.writes[1].selectionChanges[0].expectedRevision, 0);
});

test('mixed selections, replacement arrays and singles preserve their distinct update semantics', async () => {
  const fixture = setup({
    execute(parent) {
      const child = fixture.child(parent);
      const selected = parent.checkpointWriter.select(0);
      selected.add(child.ref);
      parent.checkpointWriter.save('mixed', 1, { models: selected, copied: [child.ref, child.ref], latest: child.ref });
      parent.checkpointWriter.save('mixed', 2, { models: selected, copied: [child.ref], latest: child.ref });
      parent.checkpointWriter.save('mixed', 3, { models: [], copied: [], latest: child.ref });
      parent.checkpointWriter.save('mixed', 4, { models: selected, copied: [], latest: child.ref });
      return null;
    },
  });
  await fixture.invocation.run();
  const [first, second, full, fourth] = fixture.writes;
  const copied = first.references.slots.copied.selection;
  assert.equal(first.references.slots.models.selection.revision, 1);
  assert.equal(second.selectionChanges.length, 1);
  assert.equal(second.selectionChanges[0].id, copied.id);
  assert.equal(second.selectionChanges[0].reset, true);
  assert.equal(second.selectionChanges[0].expectedRevision, 1);
  assert.equal(second.selectionChanges[0].append.length, 1);
  assert.equal(full.selectionChanges, undefined);
  assert.equal(full.references.kind, undefined, 'full arrays use the explicit full replacement path');
  assert.equal(fourth.selectionChanges.length, 1);
  assert.equal(fourth.selectionChanges[0].id, copied.id);
  assert.equal(fourth.selectionChanges[0].expectedRevision, 2);
  assert.equal(fourth.selectionChanges[0].append.length, 0);
  const head = fixture.store.read(fixture.context.id);
  assert.equal(head.image.references.models.length, 1);
  assert.deepEqual(head.image.references.copied, []);
  assert.equal(Array.isArray(head.image.references.latest), false);
  assert.equal(head.image.frame.children.length, 1);
});

test('synchronous check cannot mutate a selection and catching the error does not make capture valid', async () => {
  let selection;
  let ref;
  const fixture = setup({
    check() {
      assert.throws(() => selection.add(ref), /during a save/);
    },
    execute(parent) {
      ref = fixture.child(parent).ref;
      selection = parent.checkpointWriter.select(0);
      selection.add(ref);
      parent.checkpointWriter.save('waiting', null, { models: selection });
    },
  });
  await assert.rejects(fixture.invocation.run(), /during a save/);
  assert.equal(fixture.writes.length, 0);
});

test('a committed save with a lost acknowledgement does not advance the in-process selection basis', async () => {
  let selection;
  const fixture = setup({
    afterSave(receipt) {
      return { ...receipt, digest: 'wrong' };
    },
    execute(parent) {
      const child = fixture.child(parent);
      selection = parent.checkpointWriter.select(0);
      selection.add(child.ref);
      assert.throws(() => parent.checkpointWriter.save('waiting', null, { models: selection }), /receipt|acknowledg|differs/);
      assert.throws(() => selection.add(child.ref));
      assert.throws(() => parent.checkpointWriter.save('waiting', null, { models: selection }));
      return null;
    },
  });
  await assert.rejects(fixture.invocation.run());
  const head = fixture.store.read(fixture.context.id);
  assert.equal(head.revision, 1);
  assert.equal(head.delivery, undefined, 'uncertain save is not overwritten with a fabricated failed terminal');
  assert.equal(head.image.references.models.length, 1);
  assert.equal(fixture.writes.length, 1);
});

test('cold restored ordered selections preserve original occurrence ids and continue incrementally', async () => {
  const interrupted = new Error('host stopped before terminal persistence');
  const fixture = setup({
    finish() {
      throw interrupted;
    },
    async execute(parent) {
      const child = fixture.child(parent);
      await child.invocation.run();
      await parent.children.get(child.invocation).accept((value) => value);
      const selected = parent.checkpointWriter.select(0);
      selected.add(child.ref);
      selected.add(child.ref);
      parent.checkpointWriter.save('accepted', null, { models: selected });
      return null;
    },
  });
  await assert.rejects(fixture.invocation.run(), (error) => error === interrupted);
  // JSON removes every process-local proof; the restored invocation must validate
  // the public publication against the full logical image before reusing it.
  const saved = JSON.parse(JSON.stringify(fixture.store.read(fixture.context.id)));
  const continued = setup({
    store: fixture.store,
    saved,
    execute: () => assert.fail('root body must not rerun'),
    resume(_context, parent, _state, refs) {
      const selection = parent.checkpointWriter.select(0, refs.models);
      assert.equal(selection, parent.checkpointWriter.select(0, refs.models), 'exact restored source denotes the same selection');
      const first = selection.occurrenceAt(0);
      selection.remove(first);
      const child = continued.child(parent, 'new');
      selection.add(child.ref);
      parent.checkpointWriter.save('waiting', null, { models: selection });
      return null;
    },
  });
  await continued.invocation.run();
  const before = fixture.writes[0].selectionChanges[0];
  const after = continued.writes[0].selectionChanges[0];
  assert.equal(after.id, before.id);
  assert.equal(after.expectedRevision, 1);
  assert.equal(after.remove[0].id, before.append[0].id);
  assert.equal(after.remove[0].order, 0);
  assert.equal(after.append.length, 1);
  const snapshot = fixture.store.read(fixture.context.id).publication.selectedSelections[0];
  assert.deepEqual(
    snapshot.occurrences.map((entry) => entry.order),
    [1, 2],
  );
  assert.equal(snapshot.nextOrder, 3);
});

test('cold recovery rejects a self-consistent replacement of the actual selection identity or revision', async (t) => {
  for (const replacement of ['identity', 'revision'])
    await t.test(replacement, async () => {
      let earlier;
      const interrupted = new Error('stopped');
      const fixture = setup({
        afterSave(receipt) {
          earlier ??= JSON.parse(JSON.stringify(fixture.store.read(receipt.contextId)));
        },
        finish() {
          throw interrupted;
        },
        async execute(parent) {
          const child = fixture.child(parent);
          await child.invocation.run();
          await parent.children.get(child.invocation).accept((value) => value);
          const first = parent.checkpointWriter.select(0);
          const token = first.add(child.ref);
          parent.checkpointWriter.save('accepted', 1, { models: first });
          if (replacement === 'identity') {
            const next = parent.checkpointWriter.select(0);
            next.add(child.ref);
            parent.checkpointWriter.save('accepted', 2, { models: next });
          } else {
            first.remove(token);
            first.add(child.ref);
            parent.checkpointWriter.save('accepted', 2, { models: first });
          }
          return null;
        },
      });
      await assert.rejects(fixture.invocation.run(), (error) => error === interrupted);
      const forged = JSON.parse(JSON.stringify(fixture.store.read(fixture.context.id)));
      forged.publication.references = earlier.publication.references;
      forged.publication.selectedSelections = earlier.publication.selectedSelections;
      assert.doesNotThrow(() => cloneCheckpointHead(forged), 'the snapshot still agrees with every logical ref and its own digest');
      let continued = false;
      const resume = setup({
        store: fixture.store,
        saved: forged,
        resume() {
          continued = true;
          return null;
        },
      });
      await assert.rejects(resume.invocation.run(), /selection publication changed/);
      assert.equal(continued, false, 'the real Store basis is checked before the resume body');
      assert.equal(fixture.store.read(fixture.context.id).delivery, undefined);
    });
});
