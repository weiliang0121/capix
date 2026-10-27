import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Interaction } from '@capix/interaction';

const contract = { key: 'test.observation.v1', request: (value) => value, reply: (value) => value };

test('interaction facts follow installed state; observer failures never reject dispatch or feedback', async () => {
  const facts = [];
  let interaction;
  let failures = 0;
  interaction = new Interaction(
    { input: 'x' },
    {
      contract,
      observation: {
        receive(fact) {
          facts.push(fact);
          if (fact.state.delivery === 'started') {
            assert.equal(interaction.exportState(), fact.state);
            assert.throws(() => interaction.receive({ id: 'reentrant', payload: 'bad' }), { code: 'INTERACTION_REENTRANT_MUTATION' });
            throw new Error('optional consumer');
          }
        },
        failed() {
          failures += 1;
        },
      },
    },
  );
  let sends = 0;
  interaction.start(() => {
    sends += 1;
    return 'reply';
  });
  await interaction.settled();
  assert.equal(sends, 1);
  assert.equal(failures, 1);
  assert.equal(interaction.read().kind, 'received');
  assert.deepEqual(
    facts.map((fact) => fact.state.revision),
    [0, 1],
  );
});

test('failed feedback persistence emits unavailable at last accepted revision and restore emits no fresh facts', async () => {
  const facts = [];
  const interaction = new Interaction('request', {
    contract,
    persistence: {
      create() {},
      commit({ state }) {
        if (state.feedback) throw new Error('disk unavailable');
      },
    },
    observation: {
      receive(fact) {
        facts.push(fact);
      },
    },
  });
  interaction.start(() => 'reply');
  await interaction.settled();
  assert.equal(interaction.read().kind, 'unavailable');
  assert.deepEqual(
    facts.map((fact) => [fact.type, fact.state.revision]),
    [
      ['changed', 0],
      ['changed', 1],
      ['unavailable', 1],
    ],
  );
  assert.equal(facts.at(-1).state.feedback, undefined);
  const restored = Interaction.restore(interaction.exportState(), {
    contract,
    observation: {
      receive() {
        assert.fail('restoration is not a new fact');
      },
    },
  });
  assert.equal(restored.read().kind, 'unavailable');
});

test('a dispatch failure is visible to a synchronous observer read, and late feedback is a separate fact', async () => {
  const facts = [];
  let interaction;
  interaction = new Interaction('request', {
    contract,
    observation: {
      receive(fact) {
        facts.push(fact);
        if (fact.state.failure) assert.equal(interaction.read().kind, 'unavailable');
      },
    },
  });
  interaction.start(() => {
    throw new Error('transport failed');
  });
  await interaction.settled();
  interaction.receive({ id: 'late', payload: 'reply' });
  assert.equal(interaction.read().kind, 'received');
  assert.deepEqual(
    facts.map((fact) => fact.state.revision),
    [0, 1, 2, 3],
  );
});
