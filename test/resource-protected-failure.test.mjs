import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Resources as ResourceRegistry, Resource, ResourceOffer, ResourceAccessClosed, ResourcePortError } from '@capix/resources';

const policy = { isProtected: () => false, isCancellation: () => false, describe: () => null };

function accessFor(failure) {
  const offer = new ResourceOffer({
    methods: {
      fail() {
        throw failure;
      },
    },
  });
  const reports = [];
  const access = new ResourceRegistry()
    .register(new Resource(null), offer)
    .bind({ resource: offer.request() })
    .open({ contextId: 'resource-host', failures: policy, validate() {}, error: (error) => reports.push(error) });
  return { access, reports };
}

test('resource-owned closed-window failures stay protected through aggregate wrapping', async () => {
  const closed = new ResourceAccessClosed();
  const nested = new AggregateError([new AggregateError([closed])]);
  const cyclic = new AggregateError([]);
  cyclic.errors.push(cyclic, nested);
  for (const failure of [closed, nested, cyclic]) {
    const { access, reports } = accessFor(failure);
    let received = false;
    await assert.rejects(
      access.endpoints.resource.fail(undefined, {
        result: {
          failed() {
            received = true;
            return 'masked';
          },
        },
      }),
      (error) => error === failure,
    );
    assert.equal(received, false);
    assert.ok(reports.includes(failure));
    access.close();
  }
});

test('resource failure classification does not invoke aggregate getters or custom iterators', async () => {
  let accessed = 0;
  const accessor = new AggregateError([]);
  Object.defineProperty(accessor, 'errors', {
    get() {
      accessed++;
      throw new Error('must not read getter');
    },
  });
  const arrayAccessor = new AggregateError([]);
  Object.defineProperty(arrayAccessor.errors, '0', {
    enumerable: true,
    get() {
      accessed++;
      throw new Error('must not read array getter');
    },
  });
  const iterator = new AggregateError([new ResourceAccessClosed()]);
  iterator.errors[Symbol.iterator] = () => {
    accessed++;
    throw new Error('must not iterate');
  };
  for (const failure of [accessor, arrayAccessor, iterator]) {
    const { access } = accessFor(failure);
    let received = false;
    await assert.rejects(
      access.endpoints.resource.fail(undefined, {
        result: {
          failed() {
            received = true;
            return 'masked';
          },
        },
      }),
      (error) => error === failure,
    );
    assert.equal(received, false);
    assert.equal(accessed, 0);
    access.close();
  }
});

test('an aggregate of ordinary operation failures remains eligible for explicit reception', async () => {
  const ordinary = new AggregateError([new Error('ordinary')]);
  const { access, reports } = accessFor(ordinary);
  assert.equal(await access.endpoints.resource.fail(undefined, { result: { failed: () => 'fallback' } }), 'fallback');
  assert.deepEqual(reports, []);
  access.close();
});

test('a child resource closed-window failure cannot be accepted as a parent fallback', async () => {
  const { Node, Scene, Resources, Runner } = await import('@capix/server-runtime');
  for (const wrapped of [false, true]) {
    const closed = new ResourceAccessClosed();
    const failure = wrapped ? new AggregateError([new ResourcePortError('invalid port'), closed]) : closed;
    const offer = new ResourceOffer({
      methods: {
        read() {
          throw failure;
        },
      },
    });
    let received = false;
    const child = new Node({ deps: { resource: offer.request() }, run: (work) => work.resources.resource.read(undefined) });
    const scene = new Scene({
      run: (work) =>
        work.children.invoke(child, null, {
          result: {
            failed() {
              received = true;
              return 'masked';
            },
          },
        }),
    }).add(child);
    const runner = new Runner(scene, new Resources().register(new Resource(null), offer)).build();
    await assert.rejects(runner.run(null));
    assert.equal(received, false);
  }
});
