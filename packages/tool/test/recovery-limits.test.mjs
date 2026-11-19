import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Interaction, MAX_INTERACTION_TEXT_UNITS } from '@weiliang0121/capix-interaction';
import { ModelExchanges } from '@weiliang0121/capix-model-exchanges';
import { Resource, Resources } from '@weiliang0121/capix-resources';
import { ToolModelResource, defaultToolByteBudgets } from '@weiliang0121/capix-tool';
import { contract, final } from './fixture.mjs';

async function material() {
  const exchanges = new ModelExchanges();
  const origin = exchanges.begin('recovery-limits', { request: { messages: [{ role: 'user', content: 'fixed request' }] }, catalog: { tools: [], digest: 'test', policyVersion: 'v1' } });
  const basis = { origin, exchanges: [] };
  let sends = 0;
  const interaction = new Interaction(exchanges.request(basis), { contract });
  interaction.start(() => {
    sends += 1;
    return final;
  });
  await interaction.settled();
  const saved = structuredClone(interaction.exportState());
  const before = structuredClone(saved);
  const snapshot = structuredClone(exchanges.snapshot());
  const source = {
    exchanges,
    channel: {
      start() {
        assert.fail('recovery resent');
      },
    },
  };
  const input = { reference: { id: saved.id, contract: contract.key }, basis, budgets: defaultToolByteBudgets };
  return {
    source,
    saved,
    input,
    unchanged() {
      assert.deepEqual(saved, before);
      assert.deepEqual(exchanges.snapshot(), snapshot);
      assert.equal(sends, 1);
    },
  };
}

function open(source) {
  return new Resources().register(new Resource(source), ToolModelResource).bind({ model: ToolModelResource.request() }).open();
}

test('captured recovery preserves class capability getters and private receivers', async () => {
  const fixture = await material();
  const reads = { exchanges: 0, channel: 0, inspection: 0, context: 0, recovery: 0 };
  class Recovery {
    #saved = fixture.saved;
    interactionLimits = { requestTextUnits: 1024, replyTextUnits: 1024 };
    read() {
      reads.recovery += 1;
      return this.#saved;
    }
  }
  class Source {
    #exchanges = fixture.source.exchanges;
    #channel = { wait: () => ({ kind: 'received', feedback: fixture.saved.feedback }) };
    #inspection = { inspectRequest: (request) => ({ requestBytes: Buffer.byteLength(JSON.stringify(request)), wireBytes: Buffer.byteLength(JSON.stringify(request)) }) };
    #context = { prepare: () => 'context' };
    recovery = new Recovery();
    get exchanges() {
      reads.exchanges += 1;
      return this.#exchanges;
    }
    get channel() {
      reads.channel += 1;
      return this.#channel;
    }
    get inspection() {
      reads.inspection += 1;
      return this.#inspection;
    }
    get context() {
      reads.context += 1;
      return this.#context;
    }
  }
  const source = new Source();
  const access = open(source);
  try {
    await access.endpoints.model.confirm(fixture.input);
    assert.deepEqual(await access.endpoints.model.wait({ reference: fixture.input.reference, waitMs: 0, maxReplyBytes: 1024 }), final);
    assert.ok(reads.exchanges > 0);
    assert.ok(reads.channel > 0);
    assert.equal(reads.inspection, 0);
    assert.equal(reads.recovery, 1);
    // Context preparation still requires an own data capability; it never reads this getter.
    await assert.rejects(access.endpoints.model.prepare({ prefix: fixture.input.basis, context: {} }));
    assert.equal(reads.context, 0);
    assert.equal(Object.isFrozen(source), false);
    fixture.unchanged();
  } finally {
    access.close();
  }
  source.recovery = undefined;
  const withoutRecovery = open(source);
  try {
    assert.deepEqual(await withoutRecovery.endpoints.model.wait({ reference: fixture.input.reference, waitMs: 0, maxReplyBytes: 1024 }), final);
    fixture.unchanged();
  } finally {
    withoutRecovery.close();
  }
});

test('capture fixes recovery read and limits before callbacks mutate the original configuration', async () => {
  const fixture = await material();
  const limits = { requestTextUnits: 1024, replyTextUnits: 1024 };
  let reads = 0;
  const recovery = {
    interactionLimits: limits,
    read() {
      assert.equal(this, recovery);
      reads += 1;
      limits.requestTextUnits = 1;
      limits.replyTextUnits = 1;
      recovery.read = () => assert.fail('read capability changed after capture');
      return fixture.saved;
    },
  };
  fixture.source.recovery = recovery;
  const access = open(fixture.source);
  try {
    await access.endpoints.model.confirm(fixture.input);
    await access.endpoints.model.confirm(fixture.input);
    assert.equal(reads, 2);
    assert.equal(Object.isFrozen(recovery), false);
    assert.equal(Object.isFrozen(limits), false);
    fixture.unchanged();
  } finally {
    access.close();
  }
});

test('read callbacks cannot increase a captured low recovery limit to admit persisted material', async () => {
  const fixture = await material();
  const limits = { requestTextUnits: 1 };
  let reads = 0;
  fixture.source.recovery = {
    interactionLimits: limits,
    read() {
      reads += 1;
      limits.requestTextUnits = MAX_INTERACTION_TEXT_UNITS;
      return fixture.saved;
    },
  };
  const access = open(fixture.source);
  try {
    await assert.rejects(access.endpoints.model.confirm(fixture.input));
    assert.equal(reads, 1);
    fixture.unchanged();
  } finally {
    access.close();
  }
});

test('cold proxies and then accessors are rejected without running traps or getters', async () => {
  const fixture = await material();
  let touched = 0;
  const proxy = new Proxy(fixture.saved, {
    has() {
      touched += 1;
      return true;
    },
    get() {
      touched += 1;
      return undefined;
    },
    getPrototypeOf() {
      touched += 1;
      return Object.prototype;
    },
    ownKeys() {
      touched += 1;
      return [];
    },
  });
  const thenable = Object.defineProperty({ ...fixture.saved }, 'then', {
    enumerable: true,
    get() {
      touched += 1;
      return () => {};
    },
  });
  const promise = Promise.reject(new Error('async read'));
  Object.defineProperty(promise, 'then', {
    get() {
      touched += 1;
      return () => {};
    },
  });
  for (const saved of [promise, proxy, thenable]) {
    fixture.source.recovery = { read: () => saved };
    const access = open(fixture.source);
    try {
      await assert.rejects(access.endpoints.model.confirm(fixture.input));
      assert.equal(touched, 0);
      fixture.unchanged();
    } finally {
      access.close();
    }
  }
});

test('recovery configuration rejects proxies, accessors, hidden and unknown limit fields before reading', async () => {
  const fixture = await material();
  let touched = 0;
  const read = () => {
    touched += 1;
    return fixture.saved;
  };
  const getter = {
    enumerable: true,
    get() {
      touched += 1;
      return 1024;
    },
  };
  const proxy = new Proxy(
    {},
    {
      get() {
        touched += 1;
        return 1024;
      },
      getPrototypeOf() {
        touched += 1;
        return Object.prototype;
      },
      ownKeys() {
        touched += 1;
        return [];
      },
    },
  );
  const limits = [proxy, Object.defineProperty({}, 'requestTextUnits', getter), Object.defineProperty({}, 'replyTextUnits', { value: 1024 }), { other: 1024 }, { [Symbol('extra')]: 1024 }, { requestTextUnits: MAX_INTERACTION_TEXT_UNITS + 1 }, { replyTextUnits: null }];
  const recoveries = [proxy, Object.defineProperty({ read }, 'interactionLimits', getter), Object.defineProperty({}, 'read', getter), ...limits.map((interactionLimits) => ({ read, interactionLimits }))];
  const expose = () => {
    const access = open(fixture.source);
    try {
      void access.endpoints.model;
    } finally {
      access.close();
    }
  };
  for (const [index, recovery] of recoveries.entries()) {
    fixture.source.recovery = recovery;
    assert.throws(expose, undefined, `configuration ${index}`);
    assert.equal(touched, 0);
  }
  Object.defineProperty(fixture.source, 'recovery', getter);
  assert.throws(expose);
  assert.equal(touched, 0);
  fixture.unchanged();
});
