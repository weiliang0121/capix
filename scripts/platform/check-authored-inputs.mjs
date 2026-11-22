import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

test('portable host explicitly accepts author-owned input and keeps data validation', async (t) => {
  const loader = registerHooks({
    resolve(specifier, context, next) {
      assert.ok(!specifier.startsWith('node:') && !specifier.includes('capix-platform-node'), specifier);
      return next(specifier, { ...context, conditions: context.conditions.filter((condition) => condition !== 'node') });
    },
  });
  t.after(() => loader.deregister());
  const { installObjectInspection, useAuthorProvidedPlainObjects } = await import('@weiliang0121/capix-platform');
  const { isOpaqueObject, isKnownPromise } = await import('@weiliang0121/capix-platform/inspection');
  const { requireModelRequest } = await import('@weiliang0121/capix-model-provider');
  const request = { messages: [{ role: 'user', content: 'hello' }] };
  assert.throws(() => requireModelRequest(request), /object inspection adapter/);
  useAuthorProvidedPlainObjects();
  useAuthorProvidedPlainObjects();
  assert.strictEqual(requireModelRequest(request), request);
  assert.equal(isOpaqueObject(request), false);
  assert.equal(isKnownPromise(Object.create(Promise.prototype)), false);
  assert.throws(() => installObjectInspection({}), /already fixed/);

  let reads = 0;
  const sample = Object.defineProperty({}, 'value', {
    enumerable: true,
    get() {
      reads++;
      return 1;
    },
  });
  const parameters = { type: 'object', properties: { item: { examples: [sample] } } };
  assert.throws(() => requireModelRequest({ ...request, tools: [{ name: 'echo', description: 'Echo', parameters }] }), TypeError);
  assert.equal(reads, 0);
  assert.throws(() => requireModelRequest({ messages: [] }), TypeError);
});
