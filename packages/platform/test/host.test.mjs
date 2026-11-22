import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { isNativeError, isPromise, isProxy } from 'node:util/types';
import test from 'node:test';

test('a portable host installs real engine predicates once and preserves the UUID owner', async (t) => {
  const loader = registerHooks({
    resolve(specifier, context, nextResolve) {
      assert.ok(!specifier.startsWith('node:') && !specifier.includes('capix-platform-node'), specifier);
      return nextResolve(specifier, { ...context, conditions: context.conditions.filter((condition) => condition !== 'node') });
    },
  });
  t.after(() => loader.deregister());
  const { installRandomUUID, installObjectInspection } = await import('@weiliang0121/capix-platform');
  const { isOpaqueObject, isNativeError: nativeError, isPromise: nativePromise } = await import('@weiliang0121/capix-platform/inspection');
  const { randomUUID } = await import('@weiliang0121/capix-platform/identity');
  assert.equal(isOpaqueObject(undefined), false);
  const input = Proxy.revocable({}, {});
  input.revoke();
  assert.throws(() => isOpaqueObject(input.proxy), /object inspection adapter/);
  assert.throws(() => installObjectInspection({}), TypeError);
  const inspection = { isOpaqueObject: isProxy, isNativeError, isPromise };
  installObjectInspection(inspection);
  installObjectInspection(inspection);
  inspection.isOpaqueObject = () => false;
  assert.equal(isOpaqueObject(input.proxy), true);
  assert.equal(nativeError(new Error()), true);
  assert.equal(nativePromise(Promise.resolve(1)), true);
  assert.throws(() => installObjectInspection({ ...inspection }), /already fixed/);
  const id = 'e44af9ad-dac9-4bc5-a0ea-100000000001';
  const generate = () => id;
  installRandomUUID(generate);
  assert.equal(randomUUID(), id);
  installRandomUUID(generate);
  assert.throws(() => installRandomUUID(() => id), /already fixed/);
});
