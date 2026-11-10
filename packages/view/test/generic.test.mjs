import assert from 'node:assert/strict';

import { test } from 'node:test';

import { PersistenceError } from '@weiliang0121/capix-diagnostics';

import { scopedSource } from './fixtures.mjs';

import { View } from '@weiliang0121/capix-view';

import { fixture, deferred, conflict } from './fixtures.mjs';

test('a three-source view indexes summaries before reading selected immutable values', async () => {
  const { view, sources, skill, state, memory } = fixture();
  const index = await view.index(sources);
  assert.equal(skill.counts.read, 0, 'indexing cannot read skill bodies');
  assert.equal(skill.counts.index, 0, 'indexing a view only inspects its selected members');
  assert.equal(skill.counts.inspect, 1);
  assert.deepEqual(index.members, state.members);
  assert.deepEqual(
    index.entries.map((entry) => [entry.source, entry.key]),
    state.members.map((member) => [member.source, member.key]),
  );
  assert.deepEqual(
    index.entries.map((entry) => entry.summary),
    [{ title: 'translate' }, { role: 'user' }, { topic: 'topic' }],
  );
  assert.ok(index.entries.every((entry) => !('value' in entry)));
  const snapshot = await view.capture(sources, index);
  assert.equal(skill.counts.read, 1);
  assert.deepEqual(
    snapshot.entries.map((entry) => entry.value),
    [{ text: 'Translate faithfully.' }, { role: 'user', content: 'Original request' }, memory.toJSON()],
  );
  assert.deepEqual(snapshot.basis, index.basis);
  assert.ok(Object.isFrozen(snapshot));
  assert.throws(() => {
    snapshot.entries[0].value.text = 'changed';
  }, TypeError);
  const sync = view.captureSync(sources, view.indexSync(sources));
  assert.deepEqual(sync, snapshot);
});

test('source changes invalidate an earlier directory without silently reading newer content', async () => {
  const { view, sources, skill } = fixture();
  const index = await view.index(sources);
  skill.replace('translate', 'A new instruction');
  await assert.rejects(view.capture(sources, index), conflict);
  assert.equal(skill.counts.read, 0, 'stale source basis must be refused before content reads');
  assert.equal((await view.capture(sources)).entries[0].value.text, 'A new instruction');
});

test('missing sources, changed source identity or scope, missing members and duplicates are rejected', async () => {
  const { view, state, sources, transcript } = fixture();
  await assert.rejects(view.index({ messages: sources.messages, memories: sources.memories }), TypeError);
  const foreign = { ...sources, skills: { ...sources.skills, inspect: (keys) => ({ ...sources.skills.inspect(keys), stamp: { id: 'other-skills', scope: 'whole', version: '0' } }) } };
  await assert.rejects(view.index(foreign));
  await assert.rejects(view.index({ ...sources, messages: scopedSource(sources.messages, [0]) }));
  const absent = new View({ ...state, members: [{ source: 'skills', key: 'missing' }] });
  await assert.rejects(absent.index(sources), RangeError);
  assert.throws(() => new View({ ...state, members: [state.members[0], state.members[0]] }), TypeError);
  const duplicateInspection = {
    ...sources,
    skills: {
      ...sources.skills,
      inspect(keys) {
        const indexed = sources.skills.inspect(keys);
        return { ...indexed, entries: [indexed.entries[0], indexed.entries[0]] };
      },
    },
  };
  await assert.rejects(view.index(duplicateInspection), TypeError);
  const duplicateValues = {
    ...sources,
    skills: {
      ...sources.skills,
      read(keys, stamp) {
        const value = sources.skills.read(keys, stamp);
        return { ...value, entries: [value.entries[0], value.entries[0]] };
      },
    },
  };
  await assert.rejects(view.capture(duplicateValues), TypeError);
});

test('view membership has its own CAS and failed persistence never installs a candidate', () => {
  const { view, sources } = fixture();
  const initial = view.exportState();
  const basis = view.indexSync(sources).basis;
  const members = [{ source: 'messages', key: 1 }];
  const failure = new Error('storage unavailable');
  assert.throws(
    () =>
      view.applySync(
        sources,
        { basis, members },
        {
          commit(change) {
            assert.deepEqual(change.previous, initial);
            assert.deepEqual(change.checkedSources, basis.sources);
            assert.equal(change.state.revision, initial.revision + 1);
            assert.deepEqual(view.exportState(), initial);
            throw failure;
          },
        },
      ),
    (error) => error instanceof PersistenceError && error.operation === 'view.commit' && error.cause === failure,
  );
  assert.deepEqual(view.exportState(), initial);
  const writes = [];
  const installed = view.applySync(
    sources,
    { basis, members },
    {
      commit(change) {
        writes.push(change);
      },
    },
  );
  assert.equal(installed.revision, initial.revision + 1);
  assert.deepEqual(installed.members, members);
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].checkedSources, basis.sources);
  assert.deepEqual(view.exportState(), installed);
  assert.throws(() => view.applySync(sources, { basis, members: [] }), conflict);
});

test('saving and restoring membership does not persist content or reuse a saved read basis', async () => {
  const { view, sources, skill } = fixture();
  const index = await view.index(sources);
  const saved = JSON.parse(JSON.stringify(view.exportState()));
  assert.deepEqual(Object.keys(saved).sort(), ['members', 'revision', 'sources']);
  assert.ok(Object.values(saved.sources).every((identity) => !('version' in identity)));
  const restored = new View(saved);
  skill.replace('translate', 'Updated after saving');
  assert.equal(skill.counts.read, 0);
  await assert.rejects(restored.capture(sources, index), conflict);
  const snapshot = await restored.capture(sources);
  assert.equal(snapshot.entries[0].value.text, 'Updated after saving');
  assert.equal(skill.counts.read, 1);
});

test('asynchronous capture rejects changes to the view while reading a source', async () => {
  const { view, sources } = fixture();
  const ready = deferred();
  const release = deferred();
  const asyncSources = {
    ...sources,
    skills: {
      ...sources.skills,
      async read(keys, stamp) {
        const result = sources.skills.read(keys, stamp);
        ready.resolve();
        await release.promise;
        return result;
      },
    },
  };
  const reading = view.capture(asyncSources);
  await ready.promise;
  const current = view.indexSync(sources);
  view.applySync(sources, { basis: current.basis, members: [] });
  release.resolve();
  await assert.rejects(reading, conflict);
});

test('asynchronous capture rechecks source versions and never returns a stale mixed snapshot', async () => {
  const { view, sources, skill } = fixture();
  const ready = deferred();
  const release = deferred();
  const asyncSources = {
    ...sources,
    skills: {
      ...sources.skills,
      async read(keys, stamp) {
        const result = sources.skills.read(keys, stamp);
        ready.resolve();
        await release.promise;
        return result;
      },
    },
  };
  const reading = view.capture(asyncSources);
  await ready.promise;
  skill.replace('translate', 'Changed during capture');
  release.resolve();
  await assert.rejects(reading, conflict);
});

test('asynchronous sources cannot enter synchronous management or pretend to be an atomic source transaction', () => {
  const { view, sources } = fixture();
  const basis = view.indexSync(sources).basis;
  const before = view.exportState();
  const asyncSources = {
    ...sources,
    skills: {
      ...sources.skills,
      async inspect(keys) {
        return sources.skills.inspect(keys);
      },
    },
  };
  let commits = 0;
  assert.throws(
    () =>
      view.applySync(
        asyncSources,
        { basis, members: [] },
        {
          commit() {
            commits++;
          },
        },
      ),
    TypeError,
  );
  assert.equal(commits, 0);
  assert.deepEqual(view.exportState(), before);
});

test('source bodies must return exactly the requested keys and their expected stamp', async () => {
  const { view, sources } = fixture();
  for (const transform of [(snapshot) => ({ ...snapshot, entries: [] }), (snapshot) => ({ ...snapshot, entries: [{ key: 'unexpected', value: { text: 'other' } }] }), (snapshot) => ({ ...snapshot, entries: [...snapshot.entries, { key: 'review', value: { text: 'extra' } }] })]) {
    const invalid = { ...sources, skills: { ...sources.skills, read: (keys, stamp) => transform(sources.skills.read(keys, stamp)) } };
    await assert.rejects(view.capture(invalid), RangeError);
  }
  const anotherVersion = {
    ...sources,
    skills: {
      ...sources.skills,
      read(keys, stamp) {
        const result = sources.skills.read(keys, stamp);
        return { ...result, stamp: { ...result.stamp, version: 'later' } };
      },
    },
  };
  await assert.rejects(view.capture(anotherVersion), conflict);
});

test('view data rejects accessors, proxies and live objects without invoking their behavior', async () => {
  const { view, state, sources, transcript } = fixture();
  let touched = 0;
  const accessor = Object.defineProperty({}, 'text', {
    enumerable: true,
    get() {
      touched++;
      return 'late body';
    },
  });
  const proxy = new Proxy(
    { text: 'hidden' },
    {
      getPrototypeOf() {
        touched++;
        return Object.prototype;
      },
      ownKeys() {
        touched++;
        return ['text'];
      },
    },
  );
  assert.throws(
    () =>
      new View(
        Object.defineProperty({ ...state }, 'revision', {
          enumerable: true,
          get() {
            touched++;
            return 0;
          },
        }),
      ),
    TypeError,
  );
  for (const value of [accessor, proxy, transcript, { read: () => 'late body' }]) {
    const invalid = {
      ...sources,
      skills: {
        ...sources.skills,
        read(keys, stamp) {
          return { stamp, entries: keys.map((key) => ({ key, value })) };
        },
      },
    };
    await assert.rejects(view.capture(invalid), TypeError);
  }
  const summaryAccessor = {
    ...sources,
    skills: {
      ...sources.skills,
      inspect(keys) {
        return { ...sources.skills.inspect(keys), entries: [{ key: 'translate', summary: accessor }] };
      },
    },
  };
  await assert.rejects(view.index(summaryAccessor), TypeError);
  assert.equal(touched, 0);
});

test('no-op selections validate their basis but neither persist nor consume a revision', () => {
  const { view, sources, skill } = fixture();
  const before = view.exportState();
  const index = view.indexSync(sources);
  assert.equal(
    view.applySync(
      sources,
      { basis: index.basis, members: [...before.members] },
      {
        commit() {
          assert.fail('no-op must not persist');
        },
      },
    ),
    before,
  );
  skill.replace('translate', 'new source version');
  assert.throws(() => view.applySync(sources, { basis: index.basis, members: before.members }), conflict);
  assert.equal(view.exportState(), before);
});

test('synchronous persistence rejects async or non-void returns and reentrant application', async () => {
  const { view, sources } = fixture();
  const before = view.exportState();
  const selection = { basis: view.indexSync(sources).basis, members: [] };
  for (const commit of [
    async () => {
      throw new Error('async write rejected');
    },
    () => 1,
  ]) {
    assert.throws(
      () => view.applySync(sources, selection, { commit }),
      (error) => error instanceof PersistenceError && error.cause instanceof TypeError,
    );
    assert.equal(view.exportState(), before);
  }
  assert.throws(
    () =>
      view.applySync(sources, selection, {
        commit() {
          view.applySync(sources, selection);
        },
      }),
    (error) => error instanceof PersistenceError && conflict(error.cause),
  );
  assert.equal(view.exportState(), before);
  await Promise.resolve();
  const installed = view.applySync(sources, selection);
  assert.equal(installed.revision, before.revision + 1, 'failed writes release the mutation guard');
});

test('a source must provide a boolean version check and persisted identities do not include read versions', async () => {
  const { view, sources, state } = fixture();
  const invalid = { ...sources, skills: { ...sources.skills, check: () => 'yes' } };
  await assert.rejects(view.index(invalid), TypeError);
  assert.throws(() => view.indexSync(invalid), TypeError);
  assert.throws(() => new View({ ...state, sources: { ...state.sources, skills: { ...state.sources.skills, version: '0' } } }), TypeError);
});

test('membership storage rejects body payloads and source data cannot extend fixed DTO shapes', async () => {
  const { view, state, sources } = fixture();
  for (const extra of [{ value: { text: 'cached body' } }, { summary: { title: 'cached summary' } }]) {
    assert.throws(() => new View({ ...state, members: [{ ...state.members[0], ...extra }] }), TypeError);
    const basis = view.indexSync(sources).basis;
    assert.throws(() => view.applySync(sources, { basis, members: [{ ...state.members[0], ...extra }] }), TypeError);
  }
  const extraStamp = {
    ...sources,
    skills: {
      ...sources.skills,
      inspect(keys) {
        const index = sources.skills.inspect(keys);
        return { ...index, stamp: { ...index.stamp, unregistered: true } };
      },
    },
  };
  await assert.rejects(view.index(extraStamp), TypeError);
  const extraEntry = {
    ...sources,
    skills: {
      ...sources.skills,
      read(keys, stamp) {
        const snapshot = sources.skills.read(keys, stamp);
        return { ...snapshot, entries: snapshot.entries.map((entry) => ({ ...entry, privateOrigin: 'unexpected' })) };
      },
    },
  };
  await assert.rejects(view.capture(extraEntry), TypeError);
});
