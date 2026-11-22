import assert from 'node:assert/strict';
import test from 'node:test';
import { systemInspection, systemRandomUUID } from '@weiliang0121/capix-platform-node';

test('Node engine checks arbitrary values without invoking proxy traps', () => {
  const proxy = Proxy.revocable(
    {},
    {
      get() {
        assert.fail('unexpected property read');
      },
    },
  );
  proxy.revoke();
  assert.equal(systemInspection.isOpaqueObject(proxy.proxy), true);
  assert.equal(systemInspection.isNativeError(Object.create(Error.prototype)), false);
  assert.equal(systemInspection.isNativeError(Object.setPrototypeOf(new Error(), null)), true);
  assert.equal(systemInspection.isPromise(Object.create(Promise.prototype)), false);
  assert.equal(systemInspection.isPromise(Promise.resolve(1)), true);
  assert.match(systemRandomUUID(), /^[\da-f-]{36}$/);
});
