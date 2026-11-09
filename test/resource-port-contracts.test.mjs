import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { Resources, Resource, ResourceOffer } from '@weiliang0121/capix-resources';

const policy = { isProtected: () => false, isCancellation: () => false, describe: () => null };

function deferred() {
  let resolve;
  const promise = new Promise((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

test('a lazy publication hook failure is owned and blocks other in-flight reception', async () => {
  const pending = deferred();
  const failure = new Error('available hook failed');
  let owned;
  let effects = 0;
  let received = false;
  const waiting = new ResourceOffer({
    methods: {
      async read() {
        await pending.promise;
        effects++;
        return 1;
      },
    },
  });
  const broken = new ResourceOffer({ methods: { read: () => 2 } });
  const registry = new Resources().register(new Resource(null), waiting).register(new Resource(null), broken);
  const access = registry.bind({ waiting: waiting.request(), broken: broken.request() }).open(
    {
      contextId: 'hooks',
      failures: policy,
      validate() {
        if (owned) throw owned;
      },
      error(error) {
        owned ??= error;
      },
    },
    {
      available(entry) {
        if (entry.offer === broken.request().offer) throw failure;
        return true;
      },
    },
  );
  const running = access.endpoints.waiting.read(undefined, {
    result: {
      succeeded() {
        received = true;
        return 1;
      },
      failed() {
        received = true;
        return 'masked';
      },
    },
  });
  assert.throws(
    () => access.endpoints.broken,
    (error) => error === failure,
  );
  assert.equal(owned, failure);
  pending.resolve();
  await assert.rejects(running, (error) => error === failure);
  assert.equal(effects, 1);
  assert.equal(received, false);
  access.close();
});

test('publication hooks require synchronous boolean decisions and report contract failures', () => {
  for (const kind of ['bound', 'available']) {
    for (const value of [undefined, 'yes', {}]) {
      const reports = [];
      const offer = new ResourceOffer({ methods: { read: () => 1 } });
      const binding = new Resources().register(new Resource(null), offer).bind({ value: offer.request() });
      assert.throws(() => {
        const access = binding.open({ contextId: kind, failures: policy, validate() {}, error: (error) => reports.push(error) }, { [kind]: () => value });
        try {
          void access.endpoints.value;
        } finally {
          access.close();
        }
      }, /must return a boolean/);
      assert.ok(reports.some((error) => /must return a boolean/.test(error.message)));
    }
  }
});

test('synchronous void host ports may keep ordinary ignored return values', async () => {
  const failure = new Error('source');
  const reports = [];
  const offer = new ResourceOffer({
    methods: {
      fail() {
        throw failure;
      },
    },
  });
  const access = new Resources()
    .register(new Resource(null), offer)
    .bind({ value: offer.request() })
    .open({ contextId: 'void', failures: policy, validate: () => 7, error: (error) => reports.push(error) });
  await assert.rejects(access.endpoints.value.fail(), (error) => error === failure);
  assert.ok(reports.includes(failure));
  access.close();
});

test('async host ports are rejected without leaking late rejection or losing the original operation failure', () => {
  const source = `
    import assert from 'node:assert/strict';
    import { Resources, Resource, ResourceOffer } from '@weiliang0121/capix-resources';
    const all = ['validate', 'error', 'publish', 'nextSequence', 'reception', 'describe', 'hookValidate', 'hookBound', 'hookAvailable', 'transcript', 'memory'];
    for (const mode of all) {
      const original = new Error('operation failed');
      const rejected = new Error('late rejection ' + mode);
      const invalid = async () => { throw rejected; };
      const policy = { isProtected: () => false, isCancellation: () => false, describe: () => null };
      const owner = {
        contextId: mode, failures: policy, validate() {}, error() {}, reception: () => ({parentContextId:'parent',childContextId:'child'}),
        observation: { publish(fact) { fact.describe(); } },
        transcript: { publish() {} }, memory: { publish() {} },
      };
      const hooks = {};
      if (mode === 'validate' || mode === 'error' || mode === 'nextSequence' || mode === 'reception') owner[mode] = invalid;
      else if (mode === 'publish') owner.observation.publish = invalid;
      else if (mode === 'describe') policy.describe = invalid;
      else if (mode === 'hookValidate') hooks.validate = invalid;
      else if (mode === 'hookBound') hooks.bound = invalid;
      else if (mode === 'hookAvailable') hooks.available = invalid;
      else owner[mode].publish = invalid;
      let executed = 0;
      const offer = new ResourceOffer({ expose(_source, activity) { return {
        read() { return activity.runSync('read', {}, () => {
          executed++;
          if (mode === 'error' || mode === 'describe') throw original;
          if (mode === 'reception') return activity.reception();
          if (mode === 'transcript') return activity.transcriptObservation.publish({});
          if (mode === 'memory') return activity.memoryObservation.publish({});
          return 1;
        }); }
      }; } });
      const binding = new Resources().register(new Resource(null), offer).bind({value:offer.request()});
      let caught;
      let access;
      try { access = binding.open(owner, hooks); access.endpoints.value.read(); }
      catch (error) { caught = error; }
      finally { access?.close(); }
      assert.ok(caught, mode + ' must reject synchronous contract');
      const pending = [caught]; const errors = [];
      while (pending.length) { const error = pending.pop(); errors.push(error); if (error instanceof AggregateError) pending.push(...error.errors); }
      assert.ok(errors.some(error => error instanceof TypeError && /synchronously/.test(error.message)), mode);
      if (mode === 'error' || mode === 'describe') assert.ok(errors.includes(original), mode + ' lost original failure');
      if (mode === 'validate' || mode.startsWith('hook') || mode === 'publish' || mode === 'nextSequence') assert.equal(executed, 0, mode);
    }
    await new Promise(resolve => setImmediate(resolve));
    console.log('all synchronous port contracts verified');
  `;
  const result = spawnSync(process.execPath, ['--unhandled-rejections=strict', '--input-type=module', '-e', source], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /all synchronous port contracts verified/);
});

test('provenance and required content port failures cannot enter a resource business fallback', async () => {
  const { ResourcePortError } = await import('@weiliang0121/capix-resources');
  for (const mode of ['reception', 'async-reception', 'transcript', 'memory']) {
    const original = new Error('host port failed');
    const reports = [];
    const owner = {
      contextId: mode,
      failures: policy,
      validate() {},
      error: (error) => reports.push(error),
      reception() {
        if (mode === 'async-reception') return Promise.reject(original);
        throw original;
      },
      transcript: {
        publish() {
          throw original;
        },
      },
      memory: {
        publish() {
          return original;
        },
      },
    };
    const offer = new ResourceOffer({
      expose(_source, activity) {
        return {
          read(options) {
            return activity.operate(
              'read',
              {},
              () => {
                if (mode.includes('reception')) return activity.reception();
                return activity[mode + 'Observation'].publish({});
              },
              options,
            );
          },
        };
      },
    });
    const access = new Resources().register(new Resource(null), offer).bind({ value: offer.request() }).open(owner);
    let fallback = false;
    await assert.rejects(
      access.endpoints.value.read({
        result: {
          failed() {
            fallback = true;
            return 'masked';
          },
        },
      }),
      (error) => {
        assert.ok(error instanceof ResourcePortError);
        if (mode !== 'async-reception') assert.equal(error.cause, original);
        assert.ok(reports.includes(error));
        return true;
      },
    );
    assert.equal(fallback, false);
    access.close();
  }
});

test('a required resource provenance failure stays protected across child delivery', async () => {
  const { Scene, Node, Runner, Resources: RuntimeResources } = await import('@weiliang0121/capix-runtime');
  const offer = new ResourceOffer({
    expose(_source, activity) {
      return {
        read() {
          return activity.operate('read', {}, () => activity.reception());
        },
      };
    },
  });
  const child = new Node({ deps: { value: offer.request() }, run: (work) => work.resources.value.read() });
  let handled = false;
  const scene = new Scene({
    run: (work) =>
      work.children.invoke(child, null, {
        result: {
          failed() {
            handled = true;
            return 'masked';
          },
        },
      }),
  }).add(child);
  await assert.rejects(new Runner(scene, new RuntimeResources().register(new Resource(null), offer)).build().run(null));
  assert.equal(handled, false);
});
