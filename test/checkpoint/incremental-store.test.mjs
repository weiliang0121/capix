import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MemoryCheckpointStore, createCheckpointValueBlock, checkpointHeadCommit, cloneCheckpointHead, checkCheckpointCommitReceipt, cloneCheckpointCommit } from '@capix/checkpoint';
import { encodeCheckpointRecord, decodeCheckpointRecord } from '@capix/checkpoint/storage';
import { SqliteCheckpointStore } from '@capix/observer-service/assembly';
import { ConversationStore } from '@capix/conversation-service/persistence';
import { loadConversationContent } from '@capix/conversation-service/assembly';

const ref = ({ id, digest }) => ({ id, digest });
const block = createCheckpointValueBlock;
const childRef = { contextId: 'child', parentContextId: 'parent', parentRound: 1, order: 0, target: { position: 0 } };

function initial() {
  const input = block('input', { text: '~0', negative: -0 });
  const state = block('state-1', { step: 'first', material: 'initial material'.repeat(100) });
  const refs = block('refs-1', {});
  return { kind: 'commit', formatVersion: 6, id: 'image-1', contract: { key: 'incremental', version: 1 }, point: 'first', frame: { owner: { contextId: 'parent', kind: 'group' }, round: 1, phase: 'execute', input: ref(input), currentInput: ref(input), nextChildOrder: 0 }, state: ref(state), references: ref(refs), values: [input, state, refs], children: [] };
}

function fixture(t, kind) {
  if (kind === 'memory') return { store: new MemoryCheckpointStore(), close() {} };
  const directory = mkdtempSync(join(tmpdir(), 'capix-facts-store-'));
  const path = join(directory, 'facts.sqlite');
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
      host = ConversationStore.open(path);
      loadConversationContent(host);
      store = host.checkpoints;
    }
    return store;
  };
  open();
  t.after(() => {
    close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    get store() {
      return store;
    },
    get database() {
      return database;
    },
    get host() {
      return host;
    },
    close,
    reopen() {
      close();
      return open();
    },
    sql(work) {
      close();
      const db = new DatabaseSync(path);
      try {
        return work(db);
      } finally {
        db.close();
      }
    },
    open,
  };
}

function returned(base, status = 'pending') {
  const input = block('child-input', { query: 'fixed' });
  const output = block('child-output', { answer: 'large'.repeat(1000), negative: -0 });
  const received = block('child-accepted', { accepted: true });
  const refs = block('refs-2', { selected: [childRef, childRef] });
  const state = block('state-2', { step: 'received' });
  const child = { identity: { contextId: 'child', parentContextId: 'parent', kind: 'node' }, target: { position: 0 }, round: 1, order: 0, input: ref(input), state: { kind: 'returned', output: ref(output), progress: { round: 1, currentInput: ref(input), phase: 'execute' }, reception: status === 'accepted' ? { kind: 'accepted', output: ref(received), contract: { position: 0 } } : { kind: 'pending' } } };
  return { ...base, id: 'image-2', point: 'second', frame: { ...base.frame, nextChildOrder: 1 }, state: ref(state), references: ref(refs), values: [input, output, refs, state, ...(status === 'accepted' ? [received] : [])], children: [child] };
}

for (const kind of ['memory', 'observer', 'conversation']) {
  test(`${kind}: incremental facts preserve exact values, repeated refs and no-child-CP delivery`, (t) => {
    const h = fixture(t, kind);
    const first = initial();
    const receipt = h.store.save(first, 0);
    checkCheckpointCommitReceipt(receipt, first, 0);
    assert.throws(() => checkCheckpointCommitReceipt({ ...receipt, digest: '0'.repeat(64) }, first, 0), /receipt/i);
    const second = returned(first, 'accepted');
    h.store.save(second, 1);
    const saved = h.store.read('parent');
    assert.equal(saved.image.formatVersion, 6);
    assert.equal(Object.is(saved.image.frame.input.negative, -0), true);
    assert.equal(saved.image.frame.input.text, '~0');
    assert.equal(saved.image.frame.children[0].contract, undefined);
    assert.equal(saved.image.frame.children[0].state.reception.kind, 'accepted');
    assert.equal(Object.is(saved.image.frame.children[0].state.output.negative, -0), true);
    assert.deepEqual(saved.image.references.selected, [childRef, childRef]);
    const basis = checkpointHeadCommit(saved);
    assert.ok(basis);
    assert.equal(checkpointHeadCommit(cloneCheckpointHead(saved)), basis);
    assert.equal(checkpointHeadCommit(JSON.parse(JSON.stringify(saved))), undefined);
    assert.deepEqual(checkpointHeadCommit(cloneCheckpointHead(structuredClone(saved))), basis);
    assert.throws(() => cloneCheckpointHead(JSON.parse(JSON.stringify(saved))), /publication|logical image/, 'ordinary JSON loses negative zero and cannot silently certify a different value');
    h.store.save({ ...basis, id: 'image-3', children: [] }, 2);
    assert.deepEqual(h.store.read('parent').image.frame.children, saved.image.frame.children);
    if (kind !== 'memory') assert.deepEqual(h.reopen().read('parent').image, h.store.read('parent').image);
    h.store.finish('parent', 3, { status: 'succeeded', output: -0, progress: { round: 1, currentInput: saved.image.frame.input, phase: 'execute' } });
    if (kind !== 'memory') h.reopen();
    assert.equal(Object.is(h.store.read('parent').delivery.output, -0), true);
    assert.throws(() => h.store.save({ ...basis, id: 'image-4', children: [] }, 4), /terminal|advance|revision/);
  });

  test(`${kind}: retired state bodies may be republished only under their exact original identity`, (t) => {
    const h = fixture(t, kind);
    const first = initial();
    h.store.save(first, 0);
    const nextState = block('next-state', { step: 'next' });
    const second = { ...first, id: 'image-2', state: ref(nextState), values: [nextState] };
    h.store.save(second, 1);
    if (kind !== 'memory') {
      h.sql((db) => {
        assert.equal(db.prepare("SELECT body FROM checkpoint_values WHERE context_id='parent' AND id='state-1'").get().body, null);
        assert.equal(db.prepare("SELECT body FROM checkpoint_images WHERE id='image-1'").get().body, null);
      });
      h.open();
    }
    h.store.save({ ...first, id: 'image-3', values: [first.values[1]] }, 2);
    assert.deepEqual(h.store.read('parent').image.state, first.values[1].value);
    const incorrect = block('state-1', { changed: true });
    assert.throws(() => h.store.save({ ...first, id: 'image-4', state: ref(incorrect), values: [incorrect] }, 3), /different content|persistence|storage/i);
  });

  test(`${kind}: immutable returned facts cannot be replaced by a later relation update`, (t) => {
    const h = fixture(t, kind);
    const first = initial();
    h.store.save(first, 0);
    const second = returned(first);
    h.store.save(second, 1);
    const changed = block('different-output', { answer: 'replacement' });
    const child = { ...second.children[0], state: { ...second.children[0].state, output: ref(changed) } };
    assert.throws(() => h.store.save({ ...second, id: 'image-3', values: [changed], children: [child] }, 2), /cannot change|persistence|storage/i);
    if (kind !== 'memory') h.reopen();
    assert.equal(h.store.read('parent').revision, 2);
    assert.equal(h.store.read('parent').image.frame.children[0].state.output.answer, 'large'.repeat(1000));
  });

  test(`${kind}: all refs are authenticated even without an author query`, (t) => {
    const h = fixture(t, kind);
    const first = initial();
    h.store.save(first, 0);
    const references = block('bad-refs', { ignored: { ...childRef, contextId: 'not-created' } });
    assert.throws(() => h.store.save({ ...first, id: 'image-2', references: ref(references), values: [references] }, 1), /reference|persistence|storage/i);
    if (kind !== 'memory') h.reopen();
    assert.equal(h.store.read('parent').revision, 1);
  });

  test(`${kind}: explicit full-v6 cold imports preserve established fact identities`, (t) => {
    const h = fixture(t, kind);
    const first = initial();
    h.store.save(first, 0);
    const second = returned(first, 'accepted');
    h.store.save(second, 1);
    const full = h.store.read('parent').image;
    h.store.save({ ...full, id: 'image-3', state: { step: 'cold import' } }, 2);
    assert.deepEqual(h.store.read('parent').image.frame, full.frame);
    h.store.save({ ...checkpointHeadCommit(h.store.read('parent')), id: 'image-4', children: [] }, 3);
    assert.equal(h.store.read('parent').revision, 4);
  });
}

test('serialized publication is reauthenticated against all logical data and metadata', () => {
  const store = new MemoryCheckpointStore();
  const first = initial();
  store.save(first, 0);
  store.save(returned(first, 'accepted'), 1);
  const head = store.read('parent');
  for (const mutate of [
    (value) => {
      value.image.state.step = 'changed';
    },
    (value) => {
      value.image.frame.children[0].state.output.answer = 'changed';
    },
    (value) => {
      value.publication.point = 'other';
    },
    (value) => {
      value.publication.children[0].key = 'injected';
    },
    (value) => {
      value.publication.references.extra = 'unknown';
    },
    (value) => {
      value.publication.values = [createCheckpointValueBlock('unexpected', null)];
    },
    (value) => {
      value.publication.children[0].state.output.id = value.publication.frame.input.id;
    },
  ]) {
    const value = structuredClone(head);
    mutate(value);
    assert.throws(() => cloneCheckpointHead(value));
  }
  const borrowedId = structuredClone(head);
  borrowedId.publication.state.id = 'unpublished';
  const checked = cloneCheckpointHead(borrowedId);
  assert.throws(() => store.save({ ...checkpointHeadCommit(checked), id: 'forged-next', children: [] }, 2), /missing|retired/, 'matching data alone cannot grant membership in the owning Store');
  assert.equal(store.read('parent').revision, 2);
});

test('commit accessors are refused without evaluating their bodies', () => {
  let reads = 0;
  const first = initial();
  const accessor = { ...first };
  Object.defineProperty(accessor, 'values', {
    get() {
      reads++;
      return first.values;
    },
    enumerable: true,
  });
  assert.throws(() => cloneCheckpointCommit(accessor), /accessor/);
  const values = [...first.values];
  Object.defineProperty(values, '0', {
    get() {
      reads++;
      return first.values[0];
    },
    enumerable: true,
  });
  assert.throws(() => cloneCheckpointCommit({ ...first, values }), /accessor/);
  const value = { ...first.values[0] };
  Object.defineProperty(value, 'value', {
    get() {
      reads++;
      return first.values[0].value;
    },
    enumerable: true,
  });
  assert.throws(() => cloneCheckpointCommit({ ...first, values: [value, ...first.values.slice(1)] }), /accessor/);
  assert.equal(reads, 0);
});

test('an established incremental scope cannot change round or continuation', () => {
  const store = new MemoryCheckpointStore();
  const first = initial();
  store.save(first, 0);
  assert.throws(() => store.save({ ...first, id: 'next-round', values: [], frame: { ...first.frame, round: 2, continuation: { fromRound: 1, stage: 'accept', reason: 'retired-round' } } }, 1), /round|continuation/);
  assert.equal(store.read('parent').revision, 1);
});

test('hot SQLite updates read metadata but never fetch old unchanged value bodies', (t) => {
  const h = fixture(t, 'observer');
  const first = initial();
  h.store.save(first, 0);
  const second = returned(first);
  h.store.save(second, 1);
  const prepare = h.database.prepare.bind(h.database);
  let oldBodyReads = 0;
  h.database.prepare = (sql) => {
    if (/SELECT\s+body\s+FROM\s+checkpoint_values/i.test(sql)) oldBodyReads++;
    return prepare(sql);
  };
  const received = block('accepted', { accepted: true });
  const child = { ...second.children[0], state: { ...second.children[0].state, reception: { kind: 'accepted', output: ref(received) } } };
  h.store.save({ ...second, id: 'image-3', values: [received], children: [child] }, 2);
  for (let revision = 3; revision < 10; revision++) h.store.save({ ...second, id: `image-${revision + 1}`, values: [], children: [] }, revision);
  assert.equal(oldBodyReads, 0);
  assert.equal(h.store.read('parent').image.frame.children[0].state.reception.kind, 'accepted');
});

test('logical image quota counts duplicated input occurrences rather than deduplicated stored blocks', () => {
  const store = new MemoryCheckpointStore();
  const first = initial();
  const input = block('large', 'x'.repeat(4 * 1024 * 1024));
  assert.throws(() => store.save({ ...first, frame: { ...first.frame, input: ref(input), currentInput: ref(input) }, values: [input, first.values[1], first.values[2]] }, 0), /logical image exceeds/);
  assert.equal(store.read('parent'), undefined);
});

test('cold SQLite reads reject recalculated checksums on false relation metadata', (t) => {
  const h = fixture(t, 'observer');
  const first = initial();
  h.store.save(first, 0);
  h.store.save(returned(first, 'accepted'), 1);
  h.sql((db) => {
    const row = db.prepare("SELECT body FROM checkpoint_relations WHERE child_id='child'").get();
    const record = decodeCheckpointRecord('child', row.body);
    const child = { ...record.child, identity: { ...record.child.identity, parentContextId: 'foreign' } };
    db.prepare("UPDATE checkpoint_relations SET body=? WHERE child_id='child'").run(encodeCheckpointRecord('child', { ...record, child }));
  });
  h.open();
  assert.throws(() => h.store.read('parent'), /storage/i);
});

for (const kind of ['observer', 'conversation']) {
  test(`${kind}: failed head insertion rolls back new blocks, relations and image identity`, (t) => {
    const h = fixture(t, kind);
    h.sql((db) => db.exec("CREATE TRIGGER refuse_head BEFORE INSERT ON checkpoint_heads BEGIN SELECT RAISE(ABORT,'refused'); END"));
    h.open();
    assert.throws(() => h.store.save(initial(), 0), /storage|persistence/i);
    h.sql((db) => {
      for (const table of ['checkpoint_images', 'checkpoint_heads', 'checkpoint_values', 'checkpoint_relations']) assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 0);
      if (kind === 'conversation') assert.equal(db.prepare('SELECT checkpoint_bytes FROM archive_usage').get().checkpoint_bytes, 0);
    });
  });
}

for (const kind of ['observer', 'conversation']) {
  test(`${kind}: each commit rereads current rows while repeated refs share that commit's reads`, (t) => {
    const h = fixture(t, kind);
    const first = initial();
    h.store.save(first, 0);
    const second = returned(first, 'accepted');
    h.store.save(second, 1);
    const queries = {
      child: 'SELECT child_id,ordinal,body FROM checkpoint_relations WHERE context_id=? AND child_id=?',
      value: 'SELECT metadata,body IS NOT NULL AS material FROM checkpoint_values WHERE context_id=? AND id=?',
    };
    const prepared = { child: 0, value: 0 };
    const reads = { child: new Map(), value: new Map() };
    const updated = [];
    const prepare = DatabaseSync.prototype.prepare;
    t.mock.method(DatabaseSync.prototype, 'prepare', function (sql) {
      const statement = prepare.call(this, sql);
      const type = Object.keys(queries).find((key) => queries[key] === sql);
      if (type) {
        prepared[type]++;
        const get = statement.get.bind(statement);
        statement.get = (...args) => {
          reads[type].set(args[1], (reads[type].get(args[1]) ?? 0) + 1);
          return get(...args);
        };
      }
      if (sql === 'UPDATE checkpoint_values SET metadata = ? WHERE context_id = ? AND id = ?') {
        const run = statement.run.bind(statement);
        statement.run = (...args) => {
          updated.push(args[2]);
          return run(...args);
        };
      }
      return statement;
    });
    const next = (revision, selected = [childRef, childRef, childRef]) => {
      const refs = block(`refs-${revision}`, { selected });
      return { ...second, id: `image-${revision}`, references: ref(refs), values: [refs], children: [] };
    };
    h.store.save(next(3), 2);
    assert.deepEqual(prepared, { child: 1, value: 1 });
    assert.equal(reads.child.get('child'), 1, 'repeated refs use the same authenticated transaction row');
    assert.ok([...reads.value.values()].every((count) => count === 1));
    assert.ok(!updated.includes('input'), 'net-zero input/currentInput counts must not rewrite old metadata');
    assert.ok(!updated.includes('state-2'), 'unchanged state must not rewrite old metadata');
    h.store.save(next(4), 3);
    assert.deepEqual(prepared, { child: 2, value: 2 });
    assert.equal(reads.child.get('child'), 2, 'the next commit rereads the current row; unchanged parsing may be reused');
    assert.throws(() => h.store.save(next(5, [childRef, { ...childRef, target: { position: 1 } }]), 4), /reference|storage|persistence/i, 'each occurrence is checked even when the row is reused');
    assert.equal(reads.child.get('child'), 3);
    h.reopen();
    assert.equal(h.store.read('parent').revision, 4);
    h.sql((db) => db.prepare("UPDATE checkpoint_relations SET body='{}' WHERE context_id='parent' AND child_id='child'").run());
    h.open();
    assert.throws(() => h.store.save(next(5), 4), /storage|persistence/i, 'no previous commit cache can hide a damaged row');
    assert.equal(reads.child.get('child'), 4);
  });
}
