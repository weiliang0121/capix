import assert from 'node:assert/strict';

import { test } from 'node:test';

import { PersistenceError } from '@weiliang0121/capix-diagnostics';

import { ExceptionContract } from '@weiliang0121/capix-invocation';

import { Resource, ResourceOffer } from '@weiliang0121/capix-resources';

import { Resources, Runner } from '@weiliang0121/capix-runtime';

import { Group, Node, Scene } from '@weiliang0121/capix-structure';

import { openViewManager } from '@weiliang0121/capix-view';

import { conflict, fixture } from './fixtures/view-sources.mjs';

const mutations = {
  include: (manager) => manager.include([{ source: 'messages', key: 1 }]),
  exclude: (manager) => manager.exclude([{ source: 'messages', key: 0 }]),
  apply: (manager) => manager.apply({ basis: manager.index().basis, members: [] }),
};

function resourceFixture(content, persistence) {
  const manage = new ResourceOffer({ expose: (origin, activity) => openViewManager(origin.view, origin.sources, activity, origin.persistence) });
  const resources = new Resources().register(new Resource({ ...content, persistence }), manage);
  return { manage, resources };
}

function writer(content, persistence, mutate) {
  const { manage, resources } = resourceFixture(content, persistence);
  const failures = [];
  const child = new Node({ deps: { view: manage.request() }, run: (work) => mutate(work.resources.view, work.input) });
  const parent = new Group().add({ child });
  parent.run = (work) => work.children.child.invoke(work.input, { result: { failed: (error) => (failures.push(error), 'masked at group') } });
  const scene = new Scene().add({ parent });
  scene.run = (work) => work.children.parent.invoke(work.input, { result: { failed: (error) => (failures.push(error), 'masked at scene') } });
  return { runner: new Runner(scene, resources).build(), failures };
}

test('View persistence failures cannot become successful parent receptions for include, exclude or apply', async (t) => {
  for (const [operation, mutate] of Object.entries(mutations)) {
    await t.test(operation, async () => {
      const content = fixture();
      const before = content.view.exportState();
      const cause = new Error('View store unavailable');
      let commits = 0;
      const { runner, failures } = writer(
        content,
        {
          commit() {
            commits++;
            throw cause;
          },
        },
        mutate,
      );
      await assert.rejects(runner.run(null), (error) => error instanceof PersistenceError && error.operation === 'view.commit' && error.cause === cause);
      assert.equal(commits, 1);
      assert.deepEqual(failures, []);
      assert.equal(content.view.exportState(), before);
      assert.equal(runner.isRunning, false);
    });
  }
});

test('the actual persistence boundary protects declared exceptions and preserves preclassified error identity', async (t) => {
  const declared = new ExceptionContract('VIEW_STORE_REFUSED').create('adapter refused', { reason: 'store' });
  const marked = new PersistenceError('adapter.view.write', new Error('disk failed'));
  for (const [name, cause] of [
    ['declared exception', declared],
    ['already classified', marked],
  ]) {
    await t.test(name, async () => {
      const content = fixture();
      const before = content.view.exportState();
      const { runner, failures } = writer(
        content,
        {
          commit() {
            throw cause;
          },
        },
        mutations.include,
      );
      await assert.rejects(runner.run(null), (error) => {
        assert.ok(error instanceof PersistenceError);
        if (cause === marked) assert.equal(error, marked);
        else {
          assert.equal(error.operation, 'view.commit');
          assert.equal(error.cause, cause);
        }
        return true;
      });
      assert.deepEqual(failures, []);
      assert.equal(content.view.exportState(), before);
    });
  }
});

test('non-void and asynchronous persistence results are protected contract failures', async (t) => {
  for (const [name, result] of [
    ['non-void', () => 1],
    ['resolved Promise', () => Promise.resolve()],
    ['rejected Promise', () => Promise.reject(new Error('late persistence rejection'))],
  ]) {
    await t.test(name, async () => {
      const content = fixture();
      const before = content.view.exportState();
      let commits = 0;
      const { runner, failures } = writer(
        content,
        {
          commit() {
            commits++;
            return result();
          },
        },
        mutations.include,
      );
      await assert.rejects(runner.run(null), (error) => error instanceof PersistenceError && error.operation === 'view.commit' && error.cause instanceof TypeError);
      assert.equal(commits, 1);
      assert.deepEqual(failures, []);
      assert.equal(content.view.exportState(), before);
      await new Promise((resolve) => setImmediate(resolve));
    });
  }
});

test('a direct methods resource cannot consume View persistence failure as a local operation exception', async () => {
  const content = fixture();
  const before = content.view.exportState();
  const cause = new Error('direct persistence unavailable');
  let commits = 0;
  let received = false;
  const offer = new ResourceOffer({
    methods: {
      change(origin, _input) {
        return origin.view.includeSync(origin.sources, [{ source: 'messages', key: 1 }], {
          commit() {
            commits++;
            throw cause;
          },
        });
      },
    },
  });
  const scene = new Scene({
    deps: { view: offer.request() },
    run: (work) =>
      work.resources.view.change(null, {
        result: {
          failed() {
            received = true;
            return 'masked';
          },
        },
      }),
  });
  const runner = new Runner(scene, new Resources().register(new Resource(content), offer)).build();
  await assert.rejects(runner.run(null), (error) => error instanceof PersistenceError && error.operation === 'view.commit' && error.cause === cause);
  assert.equal(received, false);
  assert.equal(commits, 1);
  assert.equal(content.view.exportState(), before);
});

test('invalid members and stale source versions remain receivable before any persistence call', async (t) => {
  for (const kind of ['invalid member', 'stale source']) {
    await t.test(kind, async () => {
      const content = fixture();
      const before = content.view.exportState();
      const selection = { basis: content.view.indexSync(content.sources).basis, members: [] };
      if (kind === 'stale source') content.skill.replace('translate', 'newer version');
      let commits = 0;
      const mutate = kind === 'invalid member' ? (manager) => manager.include([{ source: 'messages', key: 1000 }]) : (manager) => manager.apply(selection);
      const { runner, failures } = writer(
        content,
        {
          commit() {
            commits++;
          },
        },
        mutate,
      );
      assert.equal(await runner.run(null), 'masked at group');
      assert.equal(failures.length, 1);
      assert.equal(failures[0] instanceof PersistenceError, false);
      if (kind === 'stale source') assert.ok(conflict(failures[0]));
      assert.equal(commits, 0);
      assert.equal(content.view.exportState(), before);
    });
  }
});

test('raw catch cannot reactivate a failed local endpoint, while its parent can explicitly route the exception to a decision node', async () => {
  const content = fixture();
  const before = content.view.exportState();
  const selection = { basis: content.view.indexSync(content.sources).basis, members: [] };
  content.skill.replace('translate', 'new source version');
  let commits = 0;
  const { manage, resources } = resourceFixture(content, {
    commit() {
      commits++;
    },
  });
  let caught;
  let decided = 0;
  let fact;
  const child = new Node({
    deps: { view: manage.request() },
    run(work) {
      try {
        work.resources.view.apply(selection);
      } catch (error) {
        caught = error;
        assert.ok(conflict(error));
        assert.throws(
          () => work.resources.view.members(),
          (next) => next === error,
        );
      }
      return 'pretend local success';
    },
  });
  const decision = new Node({
    run(work) {
      decided++;
      assert.equal(work.input.code, caught.code);
      return 'defer membership change';
    },
  });
  const scene = new Scene().add({ child, decision });
  scene.run = async (work) => {
    const call = work.children.create(child, null);
    const result = await call.invoke({ result: { failed: (error) => work.children.decision.invoke({ code: error.code }) } });
    fact = work.children.facts.get(call.ref);
    return result;
  };
  assert.equal(await new Runner(scene, resources).build().run(null), 'defer membership change');
  assert.equal(decided, 1);
  assert.equal(commits, 0);
  assert.equal(content.view.exportState(), before);
  assert.equal(fact.returned.status, 'failed');
  assert.deepEqual(fact.reception, { status: 'handled', value: 'defer membership change' });
});

test('lost persistence acknowledgement leaves local membership uninstalled without implying durable rollback or retry', async () => {
  const content = fixture();
  const before = content.view.exportState();
  const cause = new Error('commit acknowledgement lost');
  let durable = before;
  let commits = 0;
  const { runner, failures } = writer(
    content,
    {
      commit(change) {
        commits++;
        durable = change.state;
        throw cause;
      },
    },
    mutations.include,
  );
  await assert.rejects(runner.run(null), (error) => error instanceof PersistenceError && error.cause === cause);
  assert.equal(commits, 1);
  assert.deepEqual(failures, []);
  assert.equal(content.view.exportState(), before);
  assert.equal(durable.revision, before.revision + 1);
  assert.ok(durable.members.some((member) => member.source === 'messages' && member.key === 1));
  assert.equal(content.view.has({ source: 'messages', key: 1 }), false);
});
