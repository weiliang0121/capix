import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PersistenceError } from '@weiliang0121/capix-diagnostics';
import { Resource, ResourceOffer, Resources, ResourceAccessClosed } from '@weiliang0121/capix-resources';
import { View, openView, openViewManager } from '@weiliang0121/capix-view';

function sourceFor(id, entries, scope = 'whole') {
  const values = new Map(entries);
  const calls = { index: 0, inspect: [], read: [], check: 0 };
  let version = 0;
  let online = true;
  const stamp = () => ({ id, scope, version: String(version) });
  const requireOnline = () => {
    if (!online) throw new Error(`${id} is offline`);
  };
  const requireValue = (key) => {
    if (!values.has(key)) throw new RangeError(`Unknown ${id} key: ${String(key)}`);
    return values.get(key);
  };
  const source = {
    index() {
      requireOnline();
      calls.index++;
      return { stamp: stamp(), entries: [...values].map(([key]) => ({ key, summary: { title: String(key) } })) };
    },
    inspect(keys) {
      requireOnline();
      calls.inspect.push([...keys]);
      return {
        stamp: stamp(),
        entries: keys.map((key) => {
          requireValue(key);
          return { key, summary: { title: String(key) } };
        }),
      };
    },
    read(keys, expected) {
      requireOnline();
      calls.read.push([...keys]);
      assert.deepEqual(expected, stamp(), 'a source read must use its verified version');
      return { stamp: stamp(), entries: keys.map((key) => ({ key, value: requireValue(key) })) };
    },
    check(expected) {
      requireOnline();
      calls.check++;
      return expected.id === id && expected.scope === scope && expected.version === String(version);
    },
  };
  return {
    source,
    identity: { id, scope },
    calls,
    offline() {
      online = false;
    },
    replace(key, value) {
      values.set(key, value);
      version++;
    },
    remove(key) {
      values.delete(key);
      version++;
    },
  };
}

function setup(members = [{ source: 'messages', key: 0 }]) {
  const messages = sourceFor('messages-id', [
    [0, { text: 'First' }],
    [1, { text: 'Second' }],
    [2, { text: 'Third' }],
  ]);
  const skills = sourceFor('skills-id', [
    ['translate', { text: 'Translate' }],
    ['review', { text: 'Review' }],
  ]);
  const sources = { messages: messages.source, skills: skills.source };
  const view = new View({ revision: 0, sources: { messages: messages.identity, skills: skills.identity }, members });
  return { view, sources, messages, skills };
}

const failureCode = (error) => error?.code === 'VIEW_SOURCE_CONFLICT' || error?.code === 'VIEW_CONFLICT';
const failures = { isProtected: () => false, isCancellation: () => false, describe: (error) => ({ message: error.message }) };
const owner = (contextId) => ({ contextId, failures, validate() {} });
const closed = (error) => error instanceof ResourceAccessClosed || (error instanceof AggregateError && error.errors.length > 0 && error.errors.every(closed));

function accessFor(view, sources, persistence) {
  const read = new ResourceOffer({ expose: (origin, activity) => openView(origin.view, origin.sources, activity) });
  const manage = new ResourceOffer({ expose: (origin, activity) => openViewManager(origin.view, origin.sources, activity, persistence) });
  const origin = new Resource({ view, sources });
  return new Resources().register(origin, read).register(origin, manage).bind({ read: read.request(), manage: manage.request() }).open(owner('membership'));
}

test('membership queries are local immutable facts, preserving source and key type identity', () => {
  const source = sourceFor('mixed', [
    [1, { text: 'numeric' }],
    ['1', { text: 'string' }],
  ]);
  const other = sourceFor('other', [[1, { text: 'other' }]]);
  const references = [
    { source: 'mixed', key: 1 },
    { source: 'mixed', key: '1' },
    { source: 'other', key: 1 },
  ];
  const view = new View({ revision: 0, sources: { mixed: source.identity, other: other.identity }, members: references });
  references[0].key = 999;
  source.offline();
  other.offline();
  assert.equal(view.has({ source: 'mixed', key: 1 }), true);
  assert.equal(view.has({ source: 'mixed', key: '1' }), true);
  assert.equal(view.has({ source: 'other', key: 1 }), true);
  assert.equal(view.has({ source: 'other', key: '1' }), false);
  const members = view.members();
  assert.ok(Object.isFrozen(members));
  assert.ok(members.every(Object.isFrozen));
  assert.throws(() => members.push({ source: 'mixed', key: 2 }), TypeError);
  view.excludeSync([{ source: 'mixed', key: 1 }]);
  assert.equal(view.has({ source: 'mixed', key: 1 }), false);
  assert.equal(view.has({ source: 'mixed', key: '1' }), true);
  assert.equal(view.has({ source: 'other', key: 1 }), true);
  assert.equal(members.length, 3, 'an earlier returned membership array is not mutated');
});

test('include preserves retained order, deduplicates additions and only checks their sources', () => {
  const { view, sources, messages, skills } = setup();
  messages.offline();
  const commits = [];
  const next = view.includeSync(
    sources,
    [
      { source: 'skills', key: 'review' },
      { source: 'messages', key: 0 },
      { source: 'skills', key: 'translate' },
      { source: 'skills', key: 'review' },
    ],
    {
      commit: (change) => {
        commits.push(change);
      },
    },
  );
  assert.deepEqual(next.members, [
    { source: 'messages', key: 0 },
    { source: 'skills', key: 'review' },
    { source: 'skills', key: 'translate' },
  ]);
  assert.equal(next.revision, 1);
  assert.deepEqual(skills.calls.inspect, [['review', 'translate']]);
  assert.equal(skills.calls.index, 0);
  assert.deepEqual(messages.calls, { index: 0, inspect: [], read: [], check: 0 });
  assert.deepEqual(Object.keys(commits[0].checkedSources), ['skills']);
  assert.equal('basis' in commits[0], false, 'a partial source check is not a full view basis');
  skills.offline();
  assert.equal(
    view.includeSync(sources, next.members, {
      commit() {
        assert.fail('no-op cannot persist');
      },
    }),
    next,
  );
});

test('exclude removes deleted and offline members without source access, and absent removal is a no-op', () => {
  const { view, messages, skills } = setup([
    { source: 'messages', key: 0 },
    { source: 'skills', key: 'translate' },
  ]);
  messages.remove(0);
  messages.offline();
  skills.offline();
  const commits = [];
  const next = view.excludeSync(
    [
      { source: 'messages', key: 0 },
      { source: 'messages', key: 0 },
      { source: 'messages', key: 999 },
    ],
    {
      commit: (change) => {
        commits.push(change);
      },
    },
  );
  assert.deepEqual(next.members, [{ source: 'skills', key: 'translate' }]);
  assert.deepEqual(commits[0].checkedSources, {});
  assert.deepEqual(messages.calls, { index: 0, inspect: [], read: [], check: 0 });
  assert.equal(
    view.excludeSync([{ source: 'messages', key: 0 }], {
      commit() {
        assert.fail('no-op cannot persist');
      },
    }),
    next,
  );
  assert.equal(view.excludeSync([]), next);
});

test('a bad addition rejects the whole batch and a later valid attempt can proceed', () => {
  const { view, sources } = setup();
  const before = view.exportState();
  let commits = 0;
  assert.throws(
    () =>
      view.includeSync(
        sources,
        [
          { source: 'messages', key: 1 },
          { source: 'skills', key: 'missing' },
        ],
        {
          commit() {
            commits++;
          },
        },
      ),
    RangeError,
  );
  assert.equal(view.exportState(), before);
  assert.equal(view.has({ source: 'messages', key: 1 }), false);
  assert.equal(commits, 0);
  view.includeSync(sources, [{ source: 'messages', key: 1 }]);
  assert.equal(view.has({ source: 'messages', key: 1 }), true);
});

test('local queries and mutations reject malformed references before reaching any source', () => {
  const { view, sources, messages, skills } = setup();
  const invalid = [
    { source: 'unknown', key: 0 },
    { source: 'messages', key: -1 },
    { source: 'messages', key: 1.5 },
    { source: 'messages', key: '' },
    { source: 'messages', key: Number.MAX_SAFE_INTEGER + 1 },
    { source: 'messages', key: 0, value: 'hidden body' },
  ];
  const before = view.exportState();
  for (const reference of invalid) {
    assert.throws(() => view.has(reference));
    assert.throws(() => view.includeSync(sources, [reference]));
    assert.throws(() => view.excludeSync([reference]));
  }
  assert.equal(view.exportState(), before);
  assert.deepEqual(messages.calls, { index: 0, inspect: [], read: [], check: 0 });
  assert.deepEqual(skills.calls, { index: 0, inspect: [], read: [], check: 0 });
});

test('inspect must return the exact keys under the registered source identity and scope', () => {
  const { view, sources } = setup();
  const before = view.exportState();
  const invalidInspections = [(result) => ({ ...result, stamp: { ...result.stamp, id: 'foreign' } }), (result) => ({ ...result, stamp: { ...result.stamp, scope: 'outside' } }), (result) => ({ ...result, entries: [] }), (result) => ({ ...result, entries: [...result.entries, result.entries[0]] }), (result) => ({ ...result, entries: [...result.entries, { key: 'review', summary: { title: 'extra' } }] })];
  for (const transform of invalidInspections) {
    const invalid = { ...sources, skills: { ...sources.skills, inspect: (keys) => transform(sources.skills.inspect(keys)) } };
    assert.throws(() =>
      view.includeSync(invalid, [{ source: 'skills', key: 'translate' }], {
        commit() {
          assert.fail('invalid source cannot persist');
        },
      }),
    );
    assert.equal(view.exportState(), before);
  }
});

test('a change to an earlier inspected source invalidates a multi-source include', () => {
  const { view, sources, messages } = setup();
  const before = view.exportState();
  const changed = {
    ...sources,
    skills: {
      ...sources.skills,
      inspect(keys) {
        const result = sources.skills.inspect(keys);
        messages.replace(1, { text: 'changed during inspection' });
        return result;
      },
    },
  };
  assert.throws(
    () =>
      view.includeSync(changed, [
        { source: 'messages', key: 1 },
        { source: 'skills', key: 'translate' },
      ]),
    failureCode,
  );
  assert.equal(view.exportState(), before);
});

test('conditional apply still rejects stale member and source bases, including apparent no-ops', () => {
  const { view, sources, messages } = setup();
  const initial = view.indexSync(sources);
  view.includeSync(sources, [{ source: 'messages', key: 1 }]);
  assert.throws(() => view.applySync(sources, { basis: initial.basis, members: view.members() }), failureCode);
  const current = view.indexSync(sources);
  messages.replace(0, { text: 'updated' });
  assert.throws(() => view.applySync(sources, { basis: current.basis, members: view.members() }), failureCode);
  const fresh = view.indexSync(sources);
  let checks;
  view.applySync(
    sources,
    { basis: fresh.basis, members: [{ source: 'messages', key: 2 }] },
    {
      commit(change) {
        checks = change.checkedSources;
      },
    },
  );
  assert.deepEqual(Object.keys(checks).sort(), ['messages', 'skills']);
});

test('persistence sees frozen prior and next state, and failure never installs either mutation', () => {
  const { view, sources } = setup();
  const before = view.exportState();
  const failure = new Error('storage rejected');
  const persistence = {
    commit(change) {
      assert.equal(change.previous, before);
      assert.equal(view.exportState(), before);
      assert.equal(change.state.revision, before.revision + 1);
      assert.ok(Object.isFrozen(change));
      assert.ok(Object.isFrozen(change.checkedSources));
      assert.ok(Object.isFrozen(change.state.members));
      throw failure;
    },
  };
  assert.throws(
    () => view.includeSync(sources, [{ source: 'messages', key: 1 }], persistence),
    (error) => error instanceof PersistenceError && error.operation === 'view.commit' && error.cause === failure,
  );
  assert.throws(
    () => view.excludeSync(before.members, persistence),
    (error) => error instanceof PersistenceError && error.operation === 'view.commit' && error.cause === failure,
  );
  assert.equal(view.exportState(), before);
  assert.equal(view.has({ source: 'messages', key: 0 }), true);
  assert.equal(view.has({ source: 'messages', key: 1 }), false);
});

test('mutations reject asynchronous persistence and cross-operation reentry without poisoning the guard', async () => {
  const { view, sources } = setup();
  const before = view.exportState();
  for (const commit of [
    async () => {
      throw new Error('late persistence failure');
    },
    () => 'not a synchronous void result',
  ]) {
    assert.throws(
      () => view.includeSync(sources, [{ source: 'messages', key: 1 }], { commit }),
      (error) => error instanceof PersistenceError && error.cause instanceof TypeError,
    );
    assert.throws(
      () => view.excludeSync(before.members, { commit }),
      (error) => error instanceof PersistenceError && error.cause instanceof TypeError,
    );
    assert.equal(view.exportState(), before);
  }
  assert.throws(
    () =>
      view.includeSync(sources, [{ source: 'messages', key: 1 }], {
        commit() {
          view.excludeSync(before.members);
        },
      }),
    (error) => error instanceof PersistenceError && failureCode(error.cause),
  );
  assert.throws(
    () =>
      view.excludeSync(before.members, {
        commit() {
          view.includeSync(sources, [{ source: 'messages', key: 1 }]);
        },
      }),
    (error) => error instanceof PersistenceError && failureCode(error.cause),
  );
  assert.equal(view.exportState(), before);
  await Promise.resolve();
  assert.equal(view.includeSync(sources, [{ source: 'messages', key: 1 }]).revision, 1);
});

test('two View instances must compare the persisted prior revision and cannot silently overwrite one another', () => {
  const { view, sources } = setup();
  const second = new View(view.exportState());
  let stored = view.exportState();
  const conflict = new Error('persisted membership revision conflict');
  let writes = 0;
  const persistence = {
    commit(change) {
      writes++;
      if (change.previous.revision !== stored.revision) throw conflict;
      stored = change.state;
    },
  };
  view.includeSync(sources, [{ source: 'messages', key: 1 }], persistence);
  const beforeSecond = second.exportState();
  assert.throws(
    () => second.excludeSync(beforeSecond.members, persistence),
    (error) => error instanceof PersistenceError && error.cause === conflict,
  );
  assert.equal(second.exportState(), beforeSecond);
  assert.equal(stored, view.exportState());
  assert.equal(writes, 2, 'a refused commit is not automatically retried');
  const reloaded = new View(stored);
  reloaded.excludeSync([{ source: 'messages', key: 0 }], persistence);
  assert.deepEqual(stored.members, [{ source: 'messages', key: 1 }]);
});

test('selected inspection and capture cost depend on requested keys rather than the source directory', () => {
  const source = sourceFor(
    'large-source',
    Array.from({ length: 10000 }, (_, key) => [key, { text: `message ${key}` }]),
  );
  const sources = { messages: source.source };
  const view = new View({ revision: 0, sources: { messages: source.identity }, members: [] });
  view.includeSync(sources, [
    { source: 'messages', key: 9998 },
    { source: 'messages', key: 4 },
    { source: 'messages', key: 9998 },
  ]);
  assert.deepEqual(source.calls.inspect, [[9998, 4]]);
  assert.equal(source.calls.index, 0);
  assert.deepEqual(
    view.indexSync(sources).entries.map((entry) => entry.key),
    [9998, 4],
  );
  assert.deepEqual(
    view.captureSync(sources).entries.map((entry) => entry.value.text),
    ['message 9998', 'message 4'],
  );
  assert.equal(source.calls.index, 0, 'view reads never request a full source directory');
  assert.ok(source.calls.inspect.every((keys) => keys.length === 2));
  assert.deepEqual(source.calls.read, [[9998, 4]]);
});

test('resource membership endpoints keep read and write permissions separate and expire with their windows', () => {
  const { view, sources, messages, skills } = setup();
  const access = accessFor(view, sources);
  const reader = access.endpoints.read;
  const manager = access.endpoints.manage;
  assert.equal('include' in reader, false);
  assert.equal('exclude' in reader, false);
  manager.include([{ source: 'skills', key: 'review' }]);
  assert.equal(reader.has({ source: 'skills', key: 'review' }), true);
  const fixedMembers = reader.members();
  messages.offline();
  skills.offline();
  manager.exclude([{ source: 'messages', key: 0 }]);
  assert.equal(manager.has({ source: 'messages', key: 0 }), false);
  assert.equal(reader.members().length, 1);
  access.close();
  for (const endpoint of [reader, manager]) {
    assert.throws(() => endpoint.has({ source: 'skills', key: 'review' }), closed);
    assert.throws(() => endpoint.members(), closed);
  }
  assert.throws(() => manager.include([]), closed);
  assert.throws(() => manager.exclude([]), closed);
  assert.equal(fixedMembers.length, 2);
});

test('a source closing the manager window during an include cannot install or persist its candidate', () => {
  const { view, sources } = setup();
  let access;
  let commits = 0;
  const controlled = {
    ...sources,
    skills: {
      ...sources.skills,
      check(stamp) {
        access.close();
        return sources.skills.check(stamp);
      },
    },
  };
  access = accessFor(view, controlled, {
    commit() {
      commits++;
    },
  });
  const before = view.exportState();
  assert.throws(() => access.endpoints.manage.include([{ source: 'skills', key: 'review' }]), closed);
  assert.equal(commits, 0);
  assert.equal(view.exportState(), before);
});

test('captured values remain fixed when all sources disappear and membership is later cleared', () => {
  const { view, sources, messages, skills } = setup([
    { source: 'messages', key: 0 },
    { source: 'skills', key: 'translate' },
  ]);
  const snapshot = view.captureSync(sources);
  messages.replace(0, { text: 'changed' });
  messages.offline();
  skills.offline();
  view.excludeSync(view.members());
  assert.deepEqual(
    snapshot.entries.map((entry) => entry.value.text),
    ['First', 'Translate'],
  );
  assert.equal(view.members().length, 0);
  assert.throws(() => {
    snapshot.entries[0].value.text = 'edited';
  }, TypeError);
});
