import assert from 'node:assert/strict';
import { test } from 'node:test';

test('Runtime exports preserve the independent interaction and shared persistence error identities', async () => {
  const interaction = await import('@weiliang0121/capix-interaction');
  const diagnostics = await import('@weiliang0121/capix-diagnostics');
  const invocation = await import('@weiliang0121/capix-invocation');
  const runtime = await import('@weiliang0121/capix-runtime');
  assert.equal(runtime.Interaction, interaction.Interaction);
  assert.equal(runtime.Interactions, interaction.Interactions);
  assert.equal(runtime.PersistenceError, diagnostics.PersistenceError);
  assert.equal(invocation.PersistenceError, diagnostics.PersistenceError);
  assert.equal(runtime.RuntimeErrorHelper, diagnostics.RuntimeErrorHelper);
  assert.equal(invocation.RuntimeErrorHelper, diagnostics.RuntimeErrorHelper);
});

test('real interaction persistence failures remain protected through resource result.failed', async (t) => {
  const { Interactions } = await import('@weiliang0121/capix-interaction');
  const { PersistenceError } = await import('@weiliang0121/capix-diagnostics');
  const { Resources, Runner, Scene } = await import('@weiliang0121/capix-runtime');
  const { ResourceOffer } = await import('@weiliang0121/capix-resources');
  for (const phase of ['create', 'feedback', 'read']) {
    await t.test(phase, async () => {
      const cause = new Error(`fixture persistence ${phase} failed`);
      const contract = { key: `package.persistence.${phase}`, request: (value) => value, reply: (value) => value };
      let sends = 0;
      let handled = 0;
      let sourceFailure;
      let caughtFailure;
      const exchanges = new Interactions().register(contract, {
        send(request) {
          sends++;
          return request;
        },
        persistence: {
          create() {
            if (phase === 'create') throw cause;
          },
          commit({ state }) {
            if (phase === 'feedback' && state.feedback) throw cause;
          },
          read() {
            throw cause;
          },
        },
      });
      try {
        const channel = exchanges.bind(contract);
        const ref = phase === 'feedback' ? channel.start('request') : { id: 'persisted', contract: contract.key };
        if (phase === 'feedback') {
          await exchanges.settled();
          const unavailable = channel.read(ref);
          assert.equal(unavailable.kind, 'unavailable');
          sourceFailure = unavailable.error;
        }
        const offer = new ResourceOffer({
          methods: {
            access(bound) {
              try {
                if (phase === 'create') return bound.start('request');
                const result = bound.read(ref);
                if (result.kind === 'unavailable') throw result.error;
                return result;
              } catch (error) {
                if (sourceFailure) assert.equal(error, sourceFailure);
                sourceFailure = error;
                throw error;
              }
            },
          },
        });
        const scene = new Scene({
          deps: { exchange: offer.request() },
          async run(work) {
            try {
              await work.resources.exchange.access(undefined, { result: { failed: () => ++handled } });
            } catch (error) {
              caughtFailure = error;
            }
            return 'cannot mask a persistence failure';
          },
        });
        const runner = new Runner(scene, new Resources().registerInteraction(offer, contract), exchanges).build();
        await assert.rejects(runner.run(null), (error) => {
          assert.ok(error instanceof PersistenceError);
          assert.equal(error, sourceFailure);
          assert.equal(error, caughtFailure);
          assert.equal(error.cause, cause);
          assert.equal(error.operation, phase === 'feedback' ? 'interaction.commit' : `interaction.${phase}`);
          return true;
        });
        assert.equal(handled, 0);
        assert.equal(sends, phase === 'feedback' ? 1 : 0);
        assert.equal(runner.isRunning, false);
      } finally {
        await exchanges.settled();
        exchanges.close();
      }
    });
  }
});
