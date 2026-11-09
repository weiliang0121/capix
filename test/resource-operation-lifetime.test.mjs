import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { Resource, ResourceOffer, Resources, ResourceAccessClosed, ResourcePortError } from '@weiliang0121/capix-resources';

const failures = { isProtected: () => false, isCancellation: (error, signal) => error === signal.reason, describe: () => null };

function open(method, owner = {}) {
  const offer = new ResourceOffer({ methods: { read: method } });
  const access = new Resources()
    .register(new Resource(null), offer)
    .bind({ reader: offer.request() })
    .open({ contextId: 'lifetime', failures, validate() {}, ...owner });
  return { access, read: access.endpoints.reader.read };
}

test('operation cleanup runs once before reception, with removable registrations and late registration', async () => {
  const calls = [];
  let operation;
  const { access, read } = open((_origin, _input, current) => {
    operation = current;
    const detach = current.onClose(() => assert.fail('removed cleanup'));
    detach();
    detach();
    current.onClose((reason) => {
      assert.ok(reason instanceof ResourceAccessClosed);
      calls.push('closed');
      assert.throws(() => current.emit('too late'), ResourceAccessClosed);
    });
    return 'value';
  });
  assert.equal(
    await read(undefined, {
      result: {
        succeeded: (value) => {
          calls.push('received');
          return value;
        },
      },
    }),
    'value',
  );
  operation.onClose(() => {
    calls.push('late');
  });
  access.close();
  access.close();
  assert.deepEqual(calls, ['closed', 'received', 'late']);
});

test('window closure wakes pending local consumption without aborting the original signal', async () => {
  const controller = new AbortController();
  let reason;
  let called = 0;
  const { access, read } = open(
    (_origin, _input, operation) => {
      assert.equal(operation.signal, controller.signal);
      return new Promise((_resolve, reject) => {
        operation.onClose((closed) => {
          called++;
          reason = closed;
          reject(closed);
        });
      });
    },
    { signal: controller.signal },
  );
  let fallback = false;
  const pending = read(undefined, {
    result: {
      failed: () => {
        fallback = true;
        return 'wrong';
      },
    },
  });
  const rejected = assert.rejects(pending, (error) => error === reason && error instanceof ResourceAccessClosed);
  access.close();
  await rejected;
  assert.equal(controller.signal.aborted, false);
  assert.equal(called, 1);
  assert.equal(fallback, false);
});

test('signal cancellation keeps the exact reason and does not close other accesses', async () => {
  const controller = new AbortController();
  const cancelled = new Error('local cancel');
  let closed;
  const first = open(
    (_origin, _input, operation) =>
      new Promise((_resolve, reject) => {
        operation.onClose((reason) => {
          closed = reason;
          reject(reason);
        });
      }),
    { signal: controller.signal },
  );
  const second = open(() => 'independent');
  const pending = first.read(undefined, { result: { failed: () => assert.fail('cancellation cannot be handled') } });
  const rejected = assert.rejects(pending, (error) => error === cancelled);
  controller.abort(cancelled);
  await rejected;
  assert.equal(closed, cancelled);
  assert.equal(await second.read(), 'independent');
  first.access.close();
  second.access.close();
});

test('cleanup does not make an unrelated pending operation settle before its real execution exits', async () => {
  let finish;
  let cleaned = 0;
  let settled = false;
  const { access, read } = open((_origin, _input, operation) => {
    operation.onClose(() => {
      cleaned++;
    });
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  const pending = read().finally(() => {
    settled = true;
  });
  const rejected = assert.rejects(pending, ResourceAccessClosed);
  access.close();
  await Promise.resolve();
  assert.equal(cleaned, 1);
  assert.equal(settled, false);
  finish('late');
  await rejected;
});

test('window close exhausts all operation cleanups and late reads preserve a protected failure', async () => {
  const original = new Error('cleanup failed');
  const calls = [];
  let finish;
  const { access, read } = open(
    (_origin, input, operation) =>
      new Promise((resolve, reject) => {
        if (input === 'broken') {
          finish = resolve;
          operation.onClose(() => {
            calls.push('broken');
            throw original;
          });
          operation.onClose(() => {
            calls.push('remaining');
          });
        } else {
          operation.onClose((reason) => {
            calls.push('other');
            reject(reason);
          });
        }
      }),
  );
  const first = read('broken', { result: { failed: () => assert.fail('protected cleanup cannot be handled') } });
  const second = read('other');
  const rejection1 = assert.rejects(first, (error) => {
    const nested = error instanceof AggregateError ? error.errors : [error];
    assert.ok(nested.some((error) => error instanceof ResourcePortError));
    return true;
  });
  const rejection2 = assert.rejects(second, ResourceAccessClosed);
  assert.throws(
    () => access.close(),
    (error) => error instanceof ResourcePortError && error.cause === original,
  );
  assert.deepEqual(calls, ['broken', 'remaining', 'other']);
  access.close();
  finish('late');
  await Promise.all([rejection1, rejection2]);
});

test('ordinary completion cleanup failure is protected while the actual successful return remains observable', async () => {
  const cause = new Error('cleanup failed');
  const facts = [];
  const { access, read } = open(
    (_origin, _input, operation) => {
      operation.onClose(() => {
        throw cause;
      });
      return 'success';
    },
    {
      observation: {
        publish: (fact) => {
          facts.push(fact);
        },
      },
    },
  );
  await assert.rejects(read(undefined, { result: { failed: () => assert.fail('cleanup cannot become fallback') } }), (error) => error instanceof ResourcePortError && error.cause === cause);
  assert.equal(
    facts.some((fact) => fact.phase === 'returned'),
    true,
  );
  assert.equal(
    facts.some((fact) => fact.phase === 'threw'),
    false,
  );
  access.close();
});

test('caught late cleanup failures remain part of the operation failure', async () => {
  const controller = new AbortController();
  const cause = new Error('late cleanup failed');
  const { access, read } = open(
    (_origin, _input, operation) => {
      operation.onClose(() => {
        try {
          operation.onClose(() => {
            throw cause;
          });
        } catch {
          // Catching a failed cleanup does not erase its owning operation's fault.
        }
      });
      controller.abort('cancel');
      return 'success';
    },
    { signal: controller.signal },
  );
  await assert.rejects(read(undefined, { result: { failed: () => assert.fail('cleanup cannot become fallback') } }), (error) => error instanceof AggregateError && error.errors.some((item) => item instanceof ResourcePortError && item.cause === cause));
  access.close();
});

test('invalid cleanup registration cannot be hidden by a resource without an invocation owner', async () => {
  const offer = new ResourceOffer({
    methods: {
      read(_origin, _input, operation) {
        try {
          operation.onClose(null);
        } catch {
          // The resource must preserve its own port failure without relying on a host.
        }
        return 'wrong';
      },
    },
  });
  const access = new Resources().register(new Resource(null), offer).bind({ value: offer.request() }).open();
  await assert.rejects(access.endpoints.value.read(undefined, { result: { failed: () => assert.fail('invalid cleanup registration cannot become fallback') } }), (error) => error instanceof ResourcePortError && /must be a function/.test(error.message));
  access.close();
});

test('cleanup supports close reentry and detach during draining without duplicate invocation', async () => {
  const calls = [];
  let finish;
  const { access, read } = open((_origin, _input, operation) => {
    operation.onClose(() => {
      calls.push('first');
      access.close();
      detach();
      operation.onClose(() => {
        calls.push('late');
      });
    });
    const detach = operation.onClose(() => assert.fail('detached during cleanup'));
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  const pending = read();
  const rejected = assert.rejects(pending, ResourceAccessClosed);
  access.close();
  finish('late');
  await rejected;
  assert.deepEqual(calls, ['first', 'late']);
});

test('async and non-void cleanup are rejected while every remaining cleanup runs, without unhandled rejection', () => {
  const source = `
    import assert from 'node:assert/strict';
    import { Resource, ResourceOffer, Resources, ResourcePortError } from '@weiliang0121/capix-resources';
    for (const mode of ['return', 'promise', 'abort']) {
      const controller = new AbortController();
      let cleaned = 0;
      let release;
      const offer = new ResourceOffer({ methods: { read(_origin, _input, operation) {
        operation.onClose(mode === 'return' ? () => 7 : async () => { throw new Error('late rejection'); });
        operation.onClose(() => { cleaned++; });
        return mode === 'abort' ? new Promise(resolve => { release = resolve; }) : 'value';
      } } });
      const access = new Resources().register(new Resource(null), offer).bind({read:offer.request()}).open({
        contextId:'cleanup', signal:controller.signal, validate(){},
        failures:{isProtected:()=>false,isCancellation:()=>false,describe:()=>null},
      });
      const pending = access.endpoints.read.read();
      const rejected = assert.rejects(pending, error => error instanceof ResourcePortError || error instanceof AggregateError);
      if(mode === 'abort') { controller.abort('cancel'); release('late'); }
      await rejected;
      assert.equal(cleaned, 1);
      access.close();
    }
    await new Promise(resolve => setImmediate(resolve));
  `;
  const result = spawnSync(process.execPath, ['--unhandled-rejections=strict', '--input-type=module', '-e', source], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
