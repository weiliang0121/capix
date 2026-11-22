import assert from 'node:assert/strict';
import { isBuiltin, registerHooks } from 'node:module';
import test from 'node:test';

test('resource access uses host UUIDs with the default resolver condition', async (t) => {
  const loader = registerHooks({
    resolve(specifier, context, nextResolve) {
      assert.ok(!isBuiltin(specifier), `Portable resources loaded ${specifier}`);
      return nextResolve(specifier, { ...context, conditions: context.conditions.filter((condition) => condition !== 'node') });
    },
  });
  t.after(() => loader.deregister());
  const { Resources, Resource, ResourceOffer, ResourceAccessClosed } = await import('@weiliang0121/capix-resources');
  const ids = [];
  const hostCrypto = {
    randomUUID() {
      assert.equal(this, hostCrypto);
      const id = `e44af9ad-dac9-4bc5-a0ea-${String(ids.length + 1).padStart(12, '0')}`;
      ids.push(id);
      return id;
    },
  };
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, 'crypto', descriptor);
    else delete globalThis.crypto;
  });
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: undefined });
  const methods = { read: (value) => value };
  assert.throws(() => new ResourceOffer({ methods }), /crypto\.randomUUID/);
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: hostCrypto });
  const offer = new ResourceOffer({ methods });
  const access = new Resources().register(new Resource('answer'), offer).bind({ source: offer.request() }).open();
  assert.equal(offer.id, ids[0]);
  assert.equal(access.supply.entries[0].supplyId, ids[1]);
  const endpoint = access.endpoints.source;
  assert.equal(await endpoint.read(), 'answer');
  assert.equal(ids.length, 3);
  access.close();
  await assert.rejects(endpoint.read(), ResourceAccessClosed);
  assert.equal(ids.length, 3);
});
