import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

test('author-provided data admits synchronous progress and saved reads without calling unverified thenables', async () => {
  const hook = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === '#engine') return nextResolve(specifier, { ...context, conditions: context.conditions.filter((condition) => condition !== 'node') });
      return nextResolve(specifier, context);
    },
  });
  try {
    const { useAuthorProvidedPlainObjects } = await import('@weiliang0121/capix-platform');
    useAuthorProvidedPlainObjects();
    const { Interaction, Interactions } = await import('@weiliang0121/capix-interaction');
    const { InteractionProgress } = await import('../dist/progress/buffer.js');
    const contract = { key: 'fixture', request: (value) => value, reply: (value) => value };
    const state = new Interaction({ word: 'saved' }, { contract }).exportState();
    let saved = state;
    const host = new Interactions().register(contract, { persistence: { create() {}, commit() {}, read: () => saved }, send: () => assert.fail('unexpected dispatch') });
    const channel = host.bind(contract);
    assert.equal(channel.read({ id: state.id, contract: contract.key }).kind, 'unavailable');

    let reads = 0;
    const thenable = Object.defineProperty({}, 'then', {
      get() {
        reads++;
        return () => {};
      },
    });
    const imitation = Object.create(Promise.prototype);
    const progress = new InteractionProgress('portable', (value) => value);
    assert.equal(progress.publish({ word: 'text' }).kind, 'published');
    for (const invalid of [thenable, imitation, Promise.resolve('async')]) {
      const invalidProgress = new InteractionProgress('invalid', () => invalid);
      assert.deepEqual(invalidProgress.publish('text'), { kind: 'unavailable', reason: 'invalid-data' });
      saved = invalid;
      assert.throws(() => channel.read({ id: 'missing', contract: contract.key }), { code: 'PERSISTENCE_FAILED' });
      assert.throws(() => new Interaction('text', { contract, persistence: { create: () => invalid } }), { code: 'PERSISTENCE_FAILED' });
    }
    assert.equal(reads, 0);
    host.close();
  } finally {
    hook.deregister();
  }
});
