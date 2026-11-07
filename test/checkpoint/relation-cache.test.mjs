import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createCheckpointValueBlock } from '@capix/checkpoint';
import { CheckpointRelationCache } from '@capix/checkpoint/storage';
import { SqliteCheckpointStore } from '@capix/observer-service/assembly';
import { ConversationStore } from '@capix/conversation-service/persistence';
import { loadConversationContent } from '@capix/conversation-service/assembly';

const reference = ({ id, digest }) => ({ id, digest });
const relationRef = (owner, id, order = 0) => ({ contextId: id, parentContextId: owner, parentRound: 1, order, target: { position: 0 } });

// Keep the same host, Store and SQLite connection alive while exercising a hot row.
// ConversationStore intentionally does not expose its connection; capture the real
// native receiver during construction instead of importing a private service file.
function fixture(t, kind) {
  const directory = mkdtempSync(join(tmpdir(), 'capix-relation-cache-'));
  const path = join(directory, 'facts.sqlite');
  let database;
  let host;
  let store;
  let generation = 0;
  const open = () => {
    generation++;
    if (kind === 'observer') {
      database = new DatabaseSync(path);
      store = new SqliteCheckpointStore(database);
    } else {
      const prepare = DatabaseSync.prototype.prepare;
      const mock = t.mock.method(DatabaseSync.prototype, 'prepare', function (...args) {
        database ??= this;
        return prepare.apply(this, args);
      });
      try {
        host = ConversationStore.open(path);
        loadConversationContent(host);
        store = host.checkpoints;
      } finally {
        mock.mock.restore();
      }
    }
  };
  const close = () => {
    try {
      if (host) host.close();
      else if (database?.isOpen) database.close();
    } finally {
      host = undefined;
      database = undefined;
    }
  };
  open();
  t.after(() => {
    close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    get database() {
      return database;
    },
    get store() {
      return store;
    },
    get generation() {
      return generation;
    },
    reopen() {
      close();
      open();
    },
  };
}

function scenario(h, owner = 'parent') {
  const input = createCheckpointValueBlock('input', null);
  const output = createCheckpointValueBlock('output', 'original output');
  const state = createCheckpointValueBlock('state', null);
  const refs = createCheckpointValueBlock('refs-initial', {});
  const child = {
    identity: { contextId: 'child', parentContextId: owner, kind: 'node' },
    target: { position: 0 },
    round: 1,
    order: 0,
    input: reference(input),
    state: { kind: 'returned', output: reference(output), progress: { round: 1, currentInput: reference(input), phase: 'execute' }, reception: { kind: 'pending' } },
  };
  const base = {
    kind: 'commit',
    formatVersion: 6,
    id: `${owner}-initial`,
    contract: { key: 'relation-cache', version: 1 },
    point: 'saved',
    frame: { owner: { contextId: owner, kind: 'group' }, phase: 'execute', round: 1, input: reference(input), currentInput: reference(input), nextChildOrder: 1 },
    state: reference(state),
    references: reference(refs),
    values: [input, output, state, refs],
    children: [child],
  };
  let revision = 0;
  let serial = 0;
  const selected = relationRef(owner, child.identity.contextId);
  const next = ({ choices = [selected, selected], children = [], values = [], nextChildOrder = 1 } = {}) => {
    const suffix = ++serial;
    const refs = createCheckpointValueBlock(`refs-${suffix}`, { selected: choices });
    return { ...base, id: `${owner}-save-${suffix}`, frame: { ...base.frame, nextChildOrder }, references: reference(refs), values: [refs, ...values], children };
  };
  const save = (commit = next()) => {
    const receipt = h.store.save(commit, revision);
    revision = receipt.revision;
    return receipt;
  };
  save(base);
  save(); // First read of the established row.
  save(); // A second save can reuse its authenticated parsing, not the SQL read.
  return {
    owner,
    child,
    selected,
    next,
    save,
    get revision() {
      return revision;
    },
  };
}

for (const kind of ['observer', 'conversation']) {
  test(`${kind}: warm relation evidence cannot conceal a changed or missing SQL row`, async (t) => {
    for (const variant of ['body', 'deleted', 'ordinal', 'child-id'])
      await t.test(variant, (t) => {
        const h = fixture(t, kind);
        const s = scenario(h);
        const sameStore = h.store;
        const sameDatabase = h.database;
        if (variant === 'body') h.database.prepare('UPDATE checkpoint_relations SET body=? WHERE context_id=?').run('{}', s.owner);
        else if (variant === 'deleted') h.database.prepare('DELETE FROM checkpoint_relations WHERE context_id=?').run(s.owner);
        else if (variant === 'ordinal') h.database.prepare('UPDATE checkpoint_relations SET ordinal=99 WHERE context_id=?').run(s.owner);
        else h.database.prepare('UPDATE checkpoint_relations SET child_id=? WHERE context_id=?').run('renamed-child', s.owner);
        const attempted = s.next();
        assert.throws(() => s.save(attempted), /storage|persistence/i);
        assert.equal(h.store, sameStore);
        assert.equal(h.database, sameDatabase);
        assert.equal(h.generation, 1, 'this rejection must occur on a warm connection, not after reopen');
        assert.equal(h.database.prepare('SELECT revision FROM checkpoint_heads WHERE context_id=?').get(s.owner).revision, 3);
        assert.equal(h.database.prepare('SELECT count(*) AS n FROM checkpoint_images WHERE id=?').get(attempted.id).n, 0);
      });
  });

  test(`${kind}: cached relations follow real pending, receiving and accepted progression`, (t) => {
    const h = fixture(t, kind);
    const s = scenario(h);
    const receiving = { ...s.child, state: { ...s.child.state, reception: { kind: 'receiving', contract: { position: 0 } } } };
    s.save(s.next({ children: [receiving] }));
    s.save();
    assert.equal(h.store.read(s.owner).image.frame.children[0].state.reception.kind, 'receiving');
    const output = createCheckpointValueBlock('accepted-output', { kept: true });
    const accepted = { ...s.child, state: { ...s.child.state, reception: { kind: 'accepted', contract: { position: 0 }, output: reference(output) } } };
    s.save(s.next({ children: [accepted], values: [output] }));
    s.save();
    const head = h.store.read(s.owner);
    assert.equal(head.revision, 7);
    assert.deepEqual(head.image.frame.children[0].state.reception.output, { kept: true });
    assert.deepEqual(head.image.references.selected, [s.selected, s.selected]);
    assert.throws(() => s.save(s.next({ children: [receiving] })), /storage|persistence/i, 'a cached pending state must not authorize regression after acceptance');
    assert.equal(h.generation, 1);
  });

  test(`${kind}: repeated warm refs still authenticate every occurrence and its owner`, async (t) => {
    for (const field of ['target', 'order', 'owner'])
      await t.test(field, (t) => {
        const h = fixture(t, kind);
        const s = scenario(h);
        const forged = field === 'target' ? { ...s.selected, target: { position: 1 } } : field === 'order' ? { ...s.selected, order: 1 } : { ...s.selected, parentContextId: 'other-parent' };
        assert.throws(() => s.save(s.next({ choices: [s.selected, s.selected, forged] })), /storage|persistence/i);
        assert.equal(h.database.prepare('SELECT revision FROM checkpoint_heads WHERE context_id=?').get(s.owner).revision, 3);
        assert.equal(h.generation, 1);
      });
    await t.test('same child id in another owner is a separate row', (t) => {
      const h = fixture(t, kind);
      const first = scenario(h, 'first-parent');
      const second = scenario(h, 'second-parent');
      second.save();
      first.save();
      assert.throws(() => second.save(second.next({ choices: [second.selected, first.selected] })), /storage|persistence/i);
      assert.equal(h.database.prepare('SELECT revision FROM checkpoint_heads WHERE context_id=?').get(first.owner).revision, 4);
      assert.equal(h.database.prepare('SELECT revision FROM checkpoint_heads WHERE context_id=?').get(second.owner).revision, 4);
    });
  });

  test(`${kind}: failed transactions cannot publish a phantom relation or reservation`, async (t) => {
    for (const failure of ['head-write', 'commit'])
      await t.test(failure, (t) => {
        const h = fixture(t, kind);
        const s = scenario(h);
        const ghost = { ...s.child, identity: { ...s.child.identity, contextId: 'ghost' }, order: 1 };
        const attempt = s.next({ children: [ghost], nextChildOrder: 2, choices: [s.selected, relationRef(s.owner, 'ghost', 1)] });
        let mock;
        if (failure === 'head-write') h.database.exec("CREATE TRIGGER refuse_cache_head BEFORE UPDATE ON checkpoint_heads BEGIN SELECT RAISE(ABORT,'injected head failure'); END");
        else {
          const exec = h.database.exec;
          let pending = true;
          mock = t.mock.method(h.database, 'exec', function (sql) {
            if (pending && sql === 'COMMIT') {
              pending = false;
              throw new Error('injected commit failure');
            }
            return exec.call(this, sql);
          });
        }
        assert.throws(() => s.save(attempt), /storage|persistence/i);
        mock?.mock.restore();
        if (failure === 'head-write') h.database.exec('DROP TRIGGER refuse_cache_head');
        assert.equal(h.database.prepare('SELECT revision FROM checkpoint_heads WHERE context_id=?').get(s.owner).revision, 3);
        assert.equal(h.database.prepare('SELECT count(*) AS n FROM checkpoint_relations WHERE child_id=?').get('ghost').n, 0);
        assert.equal(h.database.prepare('SELECT count(*) AS n FROM checkpoint_images WHERE id=?').get(attempt.id).n, 0);
        // The conversation host intentionally remains failed after a persistence
        // fault. Its fresh host must see only durable facts; Observer can retry on
        // the same connection. Neither path claims a failed callback was a commit.
        if (kind === 'conversation') {
          assert.throws(() => s.save(), /persistence/i);
          h.reopen();
        }
        assert.equal(h.store.read(s.owner).image.frame.children.length, 1);
        s.save(attempt);
        assert.equal(h.store.read(s.owner).image.frame.children.length, 2);
        assert.equal(s.revision, 4, 'rolled-back image identity can be saved for the first time');
      });
  });

  test(`${kind}: closing and reopening never legitimizes stale relation evidence`, (t) => {
    const h = fixture(t, kind);
    const s = scenario(h);
    const before = h.store;
    h.reopen();
    assert.notEqual(h.store, before);
    assert.equal(h.store.read(s.owner).revision, 3);
    h.database.prepare('UPDATE checkpoint_relations SET body=? WHERE context_id=?').run('{}', s.owner);
    assert.throws(() => s.save(), /storage|persistence/i);
    assert.equal(h.generation, 2, 'this is explicitly a cold lifecycle case, separate from hot rejection above');
  });
}

test('bounded relation parsing evidence evicts old rows and never retains a missing row', (t) => {
  const h = fixture(t, 'observer');
  for (const owner of ['one', 'two', 'three']) scenario(h, owner);
  const row = (owner) => h.database.prepare('SELECT child_id,ordinal,body FROM checkpoint_relations WHERE context_id=? AND child_id=?').get(owner, 'child');
  const cache = new CheckpointRelationCache({ maxEntries: 2 });
  const one = cache.decode('one', 'child', row('one'));
  assert.equal(cache.decode('one', 'child', row('one')), one, 'a fresh exact SQL row may reuse only its parsed value');
  assert.equal(Object.isFrozen(one.child.state), true);
  cache.decode('two', 'child', row('two'));
  cache.decode('three', 'child', row('three'));
  const again = cache.decode('one', 'child', row('one'));
  assert.notEqual(again, one, 'excess reads evict the oldest parsing evidence');
  assert.deepEqual(again, one);
  assert.equal(cache.decode('one', 'child', undefined), undefined);
  const afterMissing = cache.decode('one', 'child', row('one'));
  assert.notEqual(afterMissing, again, 'a missing current row discards earlier evidence');
  assert.deepEqual(afterMissing, one);
  assert.throws(() => cache.decode('one', 'child', { ...row('one'), ordinal: 99 }), /identity differs/);
  const afterMismatch = cache.decode('one', 'child', row('one'));
  assert.notEqual(afterMismatch, afterMissing);
  assert.deepEqual(afterMismatch, one);
});

test('byte bounds and explicit lifecycle release discard parsing evidence without changing values', (t) => {
  const h = fixture(t, 'observer');
  scenario(h, 'one');
  scenario(h, 'two');
  const row = (owner) => h.database.prepare('SELECT child_id,ordinal,body FROM checkpoint_relations WHERE context_id=? AND child_id=?').get(owner, 'child');
  const oneRow = row('one');
  const cache = new CheckpointRelationCache({ maxEntries: 10, maxBytes: 64 + 2 * ('one'.length + 'child'.length + oneRow.body.length) });
  const first = cache.decode('one', 'child', oneRow);
  cache.decode('two', 'child', row('two'));
  const second = cache.decode('one', 'child', row('one'));
  assert.notEqual(second, first, 'encoded retention budget applies even below the entry limit');
  assert.deepEqual(second, first);
  cache.forget('one');
  const third = cache.decode('one', 'child', row('one'));
  assert.notEqual(third, second);
  cache.clear();
  assert.notEqual(cache.decode('one', 'child', row('one')), third);
  const disabled = new CheckpointRelationCache({ maxBytes: 0 });
  assert.notEqual(disabled.decode('one', 'child', row('one')), disabled.decode('one', 'child', row('one')));
});
