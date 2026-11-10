import assert from 'node:assert/strict';

import { test } from 'node:test';

import { spawnSync } from 'node:child_process';

import { fileURLToPath } from 'node:url';

import { Resource, ResourceOffer, Resources, ResourceAccessClosed } from '@weiliang0121/capix-resources';

import { openView, openViewManager } from '@weiliang0121/capix-view';

import { fixture, deferred, conflict } from './fixtures.mjs';

const failures = { isProtected: () => false, isCancellation: () => false, describe: (error) => ({ message: error.message }) };

const owner = (contextId) => ({ contextId, failures, validate() {} });

const closed = (error) => error instanceof ResourceAccessClosed || (error instanceof AggregateError && error.errors.length > 0 && error.errors.every(closed));

function bindingFor(view, sources) {
  const read = new ResourceOffer({ expose: (origin, activity) => openView(origin.view, origin.sources, activity) });
  const manage = new ResourceOffer({ expose: (origin, activity) => openViewManager(origin.view, origin.sources, activity) });
  const origin = new Resource({ view, sources });
  return new Resources().register(origin, read).register(origin, manage).bind({ read: read.request(), manage: manage.request() });
}

test('read and manage endpoints share membership while their windows remain independent', async () => {
  const { view, sources } = fixture();
  const binding = bindingFor(view, sources);
  const first = binding.open(owner('first'));
  const second = binding.open(owner('second'));
  const reader = first.endpoints.read;
  const manager = first.endpoints.manage;
  assert.equal('apply' in reader, false, 'a read offer does not provide the manager operation');
  const snapshot = await reader.capture();
  const baseline = manager.index();
  first.close();
  await assert.rejects(reader.index(), ResourceAccessClosed);
  await assert.rejects(reader.capture(), ResourceAccessClosed);
  assert.throws(() => manager.index(), ResourceAccessClosed);
  assert.throws(() => manager.apply({ basis: baseline.basis, members: [] }), ResourceAccessClosed);
  assert.equal(snapshot.entries[0].value.text, 'Translate faithfully.', 'a returned pure snapshot can outlive the endpoint');
  const next = second.endpoints.manage;
  try {
    const index = next.index();
    next.apply({ basis: index.basis, members: [{ source: 'messages', key: 1 }] });
    assert.deepEqual(
      (await second.endpoints.read.capture()).entries.map((entry) => entry.value),
      [{ role: 'assistant', content: 'Original answer' }],
    );
    assert.equal(snapshot.entries.length, 3, 'management does not rewrite an already returned snapshot');
    assert.throws(() => next.apply({ basis: baseline.basis, members: [] }), conflict);
  } finally {
    second.close();
  }
});

test('closing an access during async source reading prevents the endpoint from returning the material', async () => {
  const { view, sources } = fixture();
  const ready = deferred();
  const release = deferred();
  const asyncSources = {
    ...sources,
    skills: {
      ...sources.skills,
      async read(keys, expected) {
        const result = sources.skills.read(keys, expected);
        ready.resolve();
        await release.promise;
        return result;
      },
    },
  };
  const offer = new ResourceOffer({ expose: (_origin, activity) => openView(view, asyncSources, activity) });
  const access = new Resources().register(new Resource(null), offer).bind({ view: offer.request() }).open(owner('closing'));
  const reading = access.endpoints.view.capture();
  await ready.promise;
  access.close();
  release.resolve();
  await assert.rejects(reading, closed);
  assert.equal(view.exportState().revision, 0);
});

test('the last synchronous source check cannot close the window and still install management changes', () => {
  const { view, sources } = fixture();
  let access;
  let closeDuringCheck = false;
  const controlled = {
    ...sources,
    skills: {
      ...sources.skills,
      check(stamp) {
        if (closeDuringCheck) access.close();
        return sources.skills.check(stamp);
      },
    },
  };
  let commits = 0;
  const offer = new ResourceOffer({
    expose: (_origin, activity) =>
      openViewManager(view, controlled, activity, {
        commit() {
          commits++;
        },
      }),
  });
  access = new Resources().register(new Resource(null), offer).bind({ view: offer.request() }).open(owner('manage'));
  const manager = access.endpoints.view;
  const baseline = manager.index();
  const before = view.exportState();
  closeDuringCheck = true;
  assert.throws(() => manager.apply({ basis: baseline.basis, members: [] }), closed);
  assert.equal(commits, 0);
  assert.equal(view.exportState(), before);
});

test('a source that closes the window before rejecting cannot leak an unhandled rejection', () => {
  const fixtures = new URL('./fixtures.mjs', import.meta.url).href;
  const source = `
    import assert from 'node:assert/strict';
    import { Resource, ResourceOffer, Resources, ResourceAccessClosed } from '@weiliang0121/capix-resources';
    import { openView } from '@weiliang0121/capix-view';
    import { fixture } from ${JSON.stringify(fixtures)};
    const closed = error => error instanceof ResourceAccessClosed || (error instanceof AggregateError && error.errors.length > 0 && error.errors.every(closed));
    for (const method of ['inspect', 'read', 'check']) {
      const { view, sources } = fixture();
      let access;
      const broken = { ...sources, skills: { ...sources.skills, [method]() {
        access.close();
        return Promise.reject(new Error('late source rejection'));
      } } };
      const offer = new ResourceOffer({ expose: (_origin, activity) => openView(view, broken, activity) });
      access = new Resources().register(new Resource(null), offer).bind({ view: offer.request() }).open({
        contextId: method,
        failures: { isProtected: () => false, isCancellation: () => false, describe: error => ({ message: error.message }) },
        validate() {},
      });
      await assert.rejects(access.endpoints.view.capture(), closed);
      assert.equal(view.exportState().revision, 0);
      await new Promise(resolve => setImmediate(resolve));
    }
  `;
  const result = spawnSync(process.execPath, ['--unhandled-rejections=strict', '--input-type=module', '--eval', source], { cwd: fileURLToPath(new URL('../../', import.meta.url)), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
