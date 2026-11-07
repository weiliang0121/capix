import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MemoryCheckpointStore, createCheckpointValueBlock, checkpointHeadCommit, cloneCheckpointHead, cloneCheckpointCommit, checkpointCommitDigest, checkCheckpointCommitReceipt } from '@capix/checkpoint';
import { prepareCheckpointCommit, encodeCheckpointRecord, decodeCheckpointRecord } from '@capix/checkpoint/storage';
import { SqliteCheckpointStore } from '@capix/observer-service/assembly';
import { ConversationStore } from '@capix/conversation-service/persistence';
import { loadConversationContent } from '@capix/conversation-service/assembly';

const reference = ({ id, digest }) => ({ id, digest });
const childRef = (id = 'first', order = 0) => ({ contextId: id, parentContextId: 'parent', parentRound: 1, order, target: { position: 0 } });
const firstRef = childRef();
const secondRef = childRef('second', 1);
function firstCommit() {
  const input = createCheckpointValueBlock('input', null);
  const state = createCheckpointValueBlock('state', 0);
  return {
    kind: 'commit',
    formatVersion: 6,
    id: 'image-1',
    contract: { key: 'selection-store', version: 1 },
    point: 'waiting',
    frame: { owner: { contextId: 'parent', kind: 'group' }, round: 1, phase: 'execute', input: reference(input), currentInput: reference(input), nextChildOrder: 2 },
    state: reference(state),
    references: { kind: 'slots', slots: { items: { kind: 'many', selection: { id: 'selection', revision: 1, target: { position: 0 } } } } },
    values: [input, state],
    children: [firstRef, secondRef].map((ref) => ({ identity: { contextId: ref.contextId, parentContextId: 'parent', kind: 'node' }, target: ref.target, contract: { key: 'child', version: 1 }, round: 1, order: ref.order, input: reference(input), state: { kind: 'waiting' } })),
    selectionChanges: [
      {
        id: 'selection',
        target: { position: 0 },
        expectedRevision: 0,
        append: [
          { id: 'a', reference: firstRef },
          { id: 'b', reference: firstRef },
          { id: 'c', reference: secondRef },
        ],
      },
    ],
  };
}
function nextCommit(first, revision, changes, slots = { items: { kind: 'many', selection: { id: 'selection', revision: changes ? changes.expectedRevision + 1 : 1, target: { position: 0 } } } }) {
  const { selectionChanges: _changes, ...base } = first;
  return { ...base, id: `image-${revision}`, point: revision % 2 ? 'waiting' : 'accepted', references: { kind: 'slots', slots }, values: [], children: [], ...(changes ? { selectionChanges: [changes] } : {}) };
}
function fixture(t, kind) {
  if (kind === 'memory') return { store: new MemoryCheckpointStore(), reopen() {} };
  const dir = mkdtempSync(join(tmpdir(), 'capix-selection-store-'));
  const path = join(dir, 'state.sqlite');
  let database;
  let host;
  let store;
  const close = () => {
    host?.close();
    host = undefined;
    if (database?.isOpen) database.close();
  };
  const open = () => {
    if (kind === 'observer') {
      database = new DatabaseSync(path);
      store = new SqliteCheckpointStore(database);
    } else {
      const prepare = DatabaseSync.prototype.prepare;
      try {
        DatabaseSync.prototype.prepare = function (...args) {
          database = this;
          return prepare.apply(this, args);
        };
        host = ConversationStore.open(path);
      } finally {
        DatabaseSync.prototype.prepare = prepare;
      }
      loadConversationContent(host);
      store = host.checkpoints;
    }
  };
  open();
  t.after(() => {
    close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    get store() {
      return store;
    },
    get database() {
      return database;
    },
    reopen() {
      close();
      open();
    },
    sql(work) {
      close();
      const db = new DatabaseSync(path);
      try {
        return work(db);
      } finally {
        db.close();
        open();
      }
    },
  };
}

for (const kind of ['memory', 'observer', 'conversation']) {
  test(`${kind}: ordered occurrences survive point switches, cold publication, removals and reset`, (t) => {
    const h = fixture(t, kind);
    const first = firstCommit();
    const receipt = h.store.save(first, 0);
    checkCheckpointCommitReceipt(receipt, first, 0);
    assert.equal(checkpointCommitDigest(first), checkpointCommitDigest(cloneCheckpointCommit(first)), 'request and normalized field order give the same receipt');
    const saved = h.store.read('parent');
    assert.deepEqual(saved.image.references.items, [firstRef, firstRef, secondRef]);
    const parsed = cloneCheckpointHead(structuredClone(saved));
    assert.deepEqual(
      checkpointHeadCommit(parsed).selectedSelections[0].occurrences.map(({ id }) => id),
      ['a', 'b', 'c'],
    );
    h.store.save(nextCommit(first, 2), 1);
    const remove = { id: 'selection', target: { position: 0 }, expectedRevision: 1, remove: [{ id: 'b', order: 1, reference: firstRef }] };
    h.store.save(nextCommit(first, 3, remove), 2);
    assert.deepEqual(h.store.read('parent').image.references.items, [firstRef, secondRef]);
    h.reopen();
    const reset = { id: 'selection', target: { position: 0 }, expectedRevision: 2, reset: true, append: [{ id: 'd', reference: secondRef }] };
    h.store.save(nextCommit(first, 4, reset), 3);
    assert.deepEqual(checkpointHeadCommit(h.store.read('parent')).selectedSelections[0].occurrences, [{ id: 'd', order: 3, reference: secondRef }]);
    h.store.save(nextCommit(first, 5, undefined, { only: { kind: 'one', reference: firstRef } }), 4);
    assert.deepEqual(checkpointHeadCommit(h.store.read('parent')).selectedSelections, [], 'inactive collections are not cold restore selections');
    h.reopen();
    h.store.save(nextCommit(first, 6, undefined, { chosen: { kind: 'many', selection: { id: 'selection', revision: 3, target: { position: 0 } } } }), 5);
    assert.deepEqual(h.store.read('parent').image.references, { chosen: [secondRef] }, 'retained collection can be explicitly selected again');
    if (kind !== 'memory')
      h.sql((db) => {
        assert.equal(db.prepare('SELECT count(*) AS n FROM checkpoint_occurrences WHERE body IS NULL').get().n, 3);
        assert.equal(db.prepare('SELECT count(*) AS n FROM checkpoint_occurrences WHERE body IS NOT NULL').get().n, 1);
      });
  });

  test(`${kind}: incorrect deltas never advance selection or parent head`, (t) => {
    const h = fixture(t, kind);
    const first = firstCommit();
    h.store.save(first, 0);
    const base = { id: 'selection', target: { position: 0 }, expectedRevision: 1 };
    const remove = { id: 'a', order: 0, reference: firstRef };
    const failures = [
      { ...base, expectedRevision: 0 },
      { ...base, target: { position: 1 } },
      { ...base, remove: [{ ...remove, id: 'missing' }] },
      { ...base, remove: [{ ...remove, order: 1 }] },
      { ...base, remove: [{ ...remove, reference: secondRef }] },
      { ...base, remove: [remove, remove] },
      { ...base, append: [{ id: 'a', reference: firstRef }] },
      {
        ...base,
        append: [
          { id: 'new', reference: firstRef },
          { id: 'new', reference: secondRef },
        ],
      },
      { ...base, remove: [remove], append: [{ id: 'a', reference: firstRef }] },
      { ...base, reset: true, append: [{ id: 'a', reference: firstRef }] },
      { ...base, reset: true, remove: [remove] },
      { ...base, append: [{ id: 'new', reference: { ...firstRef, parentContextId: 'foreign' } }] },
      { ...base, unexpected: true },
    ];
    for (const change of failures) {
      assert.throws(() => h.store.save(nextCommit(first, 2, change), 1));
      h.reopen();
      assert.equal(h.store.read('parent').revision, 1);
      assert.deepEqual(h.store.read('parent').image.references.items, [firstRef, firstRef, secondRef]);
    }
    const update = nextCommit(first, 2, { ...base, append: [{ id: 'new', reference: firstRef }] });
    assert.throws(() => h.store.save({ ...update, selectionChanges: [update.selectionChanges[0], update.selectionChanges[0]] }, 1));
    h.reopen();
    assert.throws(() => h.store.save({ ...update, references: { kind: 'slots', slots: {} } }, 1));
    h.reopen();
    assert.equal(h.store.read('parent').revision, 1);
  });

  test(`${kind}: full-array replacement remains independent of physical selection storage`, (t) => {
    const h = fixture(t, kind);
    const first = firstCommit();
    h.store.save(first, 0);
    const refs = createCheckpointValueBlock('full-refs', { items: [secondRef, firstRef] });
    const next = nextCommit(first, 2);
    h.store.save({ ...next, references: reference(refs), values: [refs] }, 1);
    h.reopen();
    assert.deepEqual(h.store.read('parent').image.references.items, [secondRef, firstRef]);
    assert.equal(checkpointHeadCommit(h.store.read('parent')).selectedSelections, undefined);
  });
}

test('selection publication exactly accounts for ordinary logical refs, including repeated aliases', () => {
  const first = firstCommit();
  const store = new MemoryCheckpointStore();
  const expected = new Map();
  let revision = 0;
  for (const [change, slots] of [
    [first.selectionChanges[0], first.references.slots],
    [undefined, { a: first.references.slots.items, b: first.references.slots.items, one: { kind: 'one', reference: secondRef } }],
    [{ id: 'selection', target: { position: 0 }, expectedRevision: 1, remove: [{ id: 'a', order: 0, reference: firstRef }] }, { items: { kind: 'many', selection: { id: 'selection', revision: 2, target: { position: 0 } } } }],
    [
      { id: 'selection', target: { position: 0 }, expectedRevision: 2, reset: true },
      { empty: { kind: 'many', selection: { id: 'selection', revision: 3, target: { position: 0 } } }, one: { kind: 'one', reference: firstRef } },
    ],
  ]) {
    const commit = revision === 0 ? first : nextCommit(first, revision + 1, change, slots);
    store.save(commit, revision++);
    if (change?.reset) expected.clear();
    for (const item of change?.remove ?? []) expected.delete(item.id);
    for (const item of change?.append ?? []) expected.set(item.id, item.reference);
    const entries = [...expected.values()];
    const logical = Object.fromEntries(Object.entries(slots).map(([name, slot]) => [name, slot.kind === 'one' ? slot.reference : entries]));
    const saved = cloneCheckpointHead(structuredClone(store.read('parent')));
    assert.deepEqual(saved.image.references, logical);
    const selection = checkpointHeadCommit(saved).selectedSelections[0];
    assert.equal(selection.count, entries.length);

    // Compare persisted aggregate fields with the ordinary full-value path,
    // whose encoder traverses each logical occurrence rather than using selection metadata.
    const full = createCheckpointValueBlock(`full-${revision}`, logical);
    const source = { ...first, references: reference(full), selectionChanges: undefined, values: [...first.values, full] };
    delete source.selectionChanges;
    const oldPlan = prepareCheckpointCommit(source, 0, { head: undefined, value() {}, body() {}, child() {}, order() {}, imageUsed: () => false, selection() {}, occurrence() {} });
    const metrics = oldPlan.values.find((item) => item.stored.id === full.id).stored.metrics;
    let bytes = 2;
    let nodes = 1;
    let depth = 0;
    const fields = Object.entries(slots);
    for (const [index, [name, slot]] of fields.entries()) {
      bytes += (index ? 1 : 0) + Buffer.byteLength(JSON.stringify(name)) + 1;
      if (slot.kind === 'many') {
        bytes += 2 + selection.bytes + Math.max(0, selection.count - 1);
        nodes += 1 + selection.nodes;
        depth = Math.max(depth, selection.count ? 4 : 1);
      } else {
        // References have five scalar fields plus the target object/position.
        bytes += Buffer.byteLength(JSON.stringify(slot.reference));
        nodes += 7;
        depth = Math.max(depth, 3);
      }
    }
    assert.deepEqual({ bytes, nodes, depth }, metrics);
  }
});

test('serialized selection publication rejects incorrect identities, metrics, order and logical projection', () => {
  const store = new MemoryCheckpointStore();
  store.save(firstCommit(), 0);
  const saved = store.read('parent');
  for (const mutate of [
    (head) => {
      head.publication.selectedSelections[0].count++;
    },
    (head) => {
      head.publication.selectedSelections[0].bytes++;
    },
    (head) => {
      head.publication.selectedSelections[0].sum = '0'.repeat(64);
    },
    (head) => {
      head.publication.selectedSelections[0].occurrences[0].id = 'swapped';
    },
    (head) => {
      head.publication.selectedSelections[0].occurrences[0].order = 1;
    },
    (head) => {
      head.publication.selectedSelections[0].occurrences[0].reference = secondRef;
    },
    (head) => {
      head.publication.references.slots.items.selection.revision++;
    },
    (head) => {
      head.image.references.items.pop();
    },
  ]) {
    const copy = structuredClone(saved);
    mutate(copy);
    assert.throws(() => cloneCheckpointHead(copy));
  }
});

for (const kind of ['observer', 'conversation']) {
  test(`${kind}: failed head commit rolls back selection rows and reserved occurrence IDs`, (t) => {
    const h = fixture(t, kind);
    const first = firstCommit();
    h.store.save(first, 0);
    h.sql((db) => db.exec("CREATE TRIGGER reject_selection_head BEFORE UPDATE ON checkpoint_heads BEGIN SELECT RAISE(ABORT,'stop'); END"));
    const update = nextCommit(first, 2, { id: 'selection', target: { position: 0 }, expectedRevision: 1, append: [{ id: 'new', reference: firstRef }] });
    assert.throws(() => h.store.save(update, 1));
    h.sql((db) => {
      assert.equal(db.prepare("SELECT count(*) AS n FROM checkpoint_occurrences WHERE occurrence_id='new'").get().n, 0);
      assert.equal(decodeCheckpointRecord('selection', db.prepare("SELECT body FROM checkpoint_selections WHERE id='selection'").get().body).revision, 1);
      db.exec('DROP TRIGGER reject_selection_head');
    });
    h.store.save(update, 1);
    assert.equal(h.store.read('parent').image.references.items.length, 4);
  });

  test(`${kind}: cold reconstruction checks reserved order and all selected occurrence bodies`, (t) => {
    const h = fixture(t, kind);
    const first = firstCommit();
    h.store.save(first, 0);
    h.sql((db) => db.prepare("DELETE FROM checkpoint_occurrences WHERE occurrence_id='b'").run());
    assert.throws(() => h.store.read('parent'));
  });
}

test('one physical selection used twice pays for both logical occurrence sequences', () => {
  const store = new MemoryCheckpointStore();
  const first = firstCommit();
  first.selectionChanges[0].append = Array.from({ length: 12000 }, (_, index) => ({ id: `item-${index}`, reference: firstRef }));
  store.save(first, 0);
  const selected = first.references.slots.items;
  assert.throws(() => store.save(nextCommit(first, 2, undefined, { left: selected, right: selected }), 1), /logical image exceeds/);
  assert.equal(store.read('parent').revision, 1);
});

test('canonical receipts do not depend on field order within selection changes or references', () => {
  const first = firstCommit();
  const reorder = (value) =>
    Array.isArray(value)
      ? value.map(reorder)
      : value && typeof value === 'object'
        ? Object.fromEntries(
            Object.entries(value)
              .reverse()
              .map(([key, item]) => [key, reorder(item)]),
          )
        : value;
  const reversed = reorder(first);
  assert.equal(checkpointCommitDigest(first), checkpointCommitDigest(reversed));
  const store = new MemoryCheckpointStore();
  const receipt = store.save(reversed, 0);
  checkCheckpointCommitReceipt(receipt, first, 0);
  assert.deepEqual(cloneCheckpointHead(reorder(structuredClone(store.read('parent')))).image.references.items, [firstRef, firstRef, secondRef]);
});

for (const kind of ['observer', 'conversation']) {
  test(`${kind}: selection changes also roll back when COMMIT fails after its callback`, (t) => {
    const h = fixture(t, kind);
    const first = firstCommit();
    h.store.save(first, 0);
    h.database.exec("CREATE TABLE selection_commit_guard (image TEXT REFERENCES checkpoint_images(id) DEFERRABLE INITIALLY DEFERRED); CREATE TRIGGER reject_selection_commit AFTER UPDATE ON checkpoint_heads BEGIN INSERT INTO selection_commit_guard VALUES ('absent'); END");
    const update = nextCommit(first, 2, { id: 'selection', target: { position: 0 }, expectedRevision: 1, remove: [{ id: 'b', order: 1, reference: firstRef }], append: [{ id: 'new', reference: secondRef }] });
    assert.throws(() => h.store.save(update, 1));
    h.sql((db) => {
      assert.equal(db.prepare("SELECT count(*) AS n FROM checkpoint_occurrences WHERE occurrence_id='new'").get().n, 0);
      assert.notEqual(db.prepare("SELECT body FROM checkpoint_occurrences WHERE occurrence_id='b'").get().body, null);
      assert.equal(db.prepare('SELECT count(*) AS n FROM selection_commit_guard').get().n, 0);
      db.exec('DROP TRIGGER reject_selection_commit; DROP TABLE selection_commit_guard');
    });
    h.store.save(update, 1);
    assert.deepEqual(h.store.read('parent').image.references.items, [firstRef, secondRef, secondRef]);
  });
}
