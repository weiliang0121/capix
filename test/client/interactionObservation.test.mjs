import test from 'node:test';
import assert from 'node:assert/strict';
import { client, conversationDescriptor, deferred, transport, transcriptSnapshot } from './fixtures.mjs';

const wait = (signal) => (signal.aborted ? Promise.resolve() : new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true })));
const initial = { id: 'interaction', contract: 'observer.model.v1', revision: 1, delivery: 'started', retained: 'persistent', model: 'fixture', purpose: 'answer', result: { kind: 'pending' } };
const received = { ...initial, revision: 2, result: { kind: 'received', feedbackId: 'reply' } };
const signal = () => new AbortController().signal;

async function fixture(t, observation) {
  const io = transport({ conversation: async (id) => conversationDescriptor(id, `transcript-${id}`) });
  io.observeTranscript = async (id, accept, control) => {
    accept({ type: 'baseline', snapshot: transcriptSnapshot([], id) });
    await wait(control);
  };
  const runtime = client({ conversation: io, observation });
  await runtime.initialize();
  t.after(() => runtime.stopTranscript());
  return runtime;
}

test('interaction queries and streams target the selected conversation without opening the full record feed', async (t) => {
  const calls = [];
  const runtime = await fixture(t, {
    interactions: async (...args) => {
      calls.push(args);
      return { callId: args[1], interactionIds: [initial.id] };
    },
    observeInteraction: async (conversationId, callId, id, accept) => {
      calls.push([conversationId, callId, id]);
      accept(initial);
      accept(received);
    },
    observe: () => assert.fail('full observation is not required'),
  });
  const before = runtime.getSnapshot();
  const links = await runtime.interactionLinks('call');
  assert.deepEqual(links, { callId: 'call', interactionIds: ['interaction'] });
  assert.ok(Object.isFrozen(links) && Object.isFrozen(links.interactionIds));
  const values = [];
  await runtime.observeInteraction('call', initial.id, (value) => values.push(value), signal());
  assert.deepEqual(calls[0].slice(0, 2), ['fixture-conversation', 'call']);
  assert.deepEqual(calls[1], ['fixture-conversation', 'call', 'interaction']);
  assert.deepEqual(values, [initial, received]);
  assert.ok(values.every((value) => Object.isFrozen(value) && Object.isFrozen(value.result)));
  assert.equal(runtime.getSnapshot().submission, before.submission);
  assert.equal(runtime.getSnapshot().observation, before.observation);
});

test('a conversation switch aborts pending links and streams; ignored cancellation cannot deliver stale data', async (t) => {
  const links = deferred();
  const stream = deferred();
  let linkSignal;
  let streamSignal;
  let oldReceive;
  const runtime = await fixture(t, {
    interactions: async (conversationId, callId, owned) => {
      if (conversationId !== 'fixture-conversation') return { callId, interactionIds: ['next'] };
      linkSignal = owned;
      return links.promise;
    },
    observeInteraction: async (_conversationId, _callId, _id, accept, owned) => {
      streamSignal = owned;
      oldReceive = accept;
      accept(initial);
      await stream.promise;
    },
  });
  const seen = [];
  const pendingLinks = runtime.interactionLinks('old-call');
  const pendingStream = runtime.observeInteraction('old-call', initial.id, (value) => seen.push(value), signal());
  await runtime.openConversation('next');
  assert.equal(linkSignal.aborted, true);
  assert.equal(streamSignal.aborted, true);
  assert.throws(() => oldReceive(received), { name: 'AbortError' });
  links.resolve({ callId: 'old-call', interactionIds: ['interaction'] });
  stream.resolve();
  await assert.rejects(pendingLinks, { name: 'AbortError' });
  await assert.rejects(pendingStream);
  assert.deepEqual(seen, [initial]);
  assert.deepEqual(await runtime.interactionLinks('new-call'), { callId: 'new-call', interactionIds: ['next'] });
  assert.equal(runtime.getSnapshot().conversation.id, 'next');
  assert.equal(runtime.getSnapshot().submission, undefined);
});

test('an already aborted detail lifetime never calls transport and cancellation is local to that request', async (t) => {
  let reads = 0;
  const runtime = await fixture(t, {
    interactions: async (_conversation, callId) => {
      reads++;
      return { callId, interactionIds: [] };
    },
    observeInteraction: async () => assert.fail('aborted stream must not start'),
  });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(runtime.interactionLinks('call', controller.signal), { name: 'AbortError' });
  await assert.rejects(
    runtime.observeInteraction('call', initial.id, () => {}, controller.signal),
    { name: 'AbortError' },
  );
  assert.equal(reads, 0);
  await runtime.interactionLinks('call');
  assert.equal(reads, 1);
});

test('interaction scope transfers before old record-connection abort callbacks can reenter queries', async (t) => {
  const requests = [];
  let reentered;
  const runtime = await fixture(t, {
    interactions: async (conversationId, callId) => {
      requests.push(conversationId);
      return { callId, interactionIds: [] };
    },
    observe: async (conversationId, _accept, owned) => {
      owned.addEventListener(
        'abort',
        () => {
          if (conversationId === 'fixture-conversation') reentered = runtime.interactionLinks('new-call');
        },
        { once: true },
      );
      await wait(owned);
    },
  });
  const stop = runtime.startObservation();
  t.after(stop);
  await runtime.openConversation('next');
  await reentered;
  assert.deepEqual(requests, ['next']);
});

test('invalid call links reject their identities without creating subscriptions', async (t) => {
  let response;
  const runtime = await fixture(t, { interactions: async () => response });
  for (response of [
    { callId: 'other', interactionIds: [] },
    { callId: 'call', interactionIds: ['same', 'same'] },
    { callId: 'call', interactionIds: [''] },
  ]) {
    await assert.rejects(runtime.interactionLinks('call'), /交互关联/);
  }
});

test('interaction identity, immutable contract and revision checks precede delivery', async (t) => {
  let frames = [];
  const runtime = await fixture(t, { observeInteraction: async (_conversation, _call, _id, accept) => frames.forEach(accept) });
  for (const change of [{ id: 'foreign' }, { contract: 'other-contract' }, { model: 'other-model' }, { purpose: 'memory' }, { retained: 'memory' }, { revision: 0 }, { revision: 1 }, { revision: -1 }, { revision: 1.5 }, { delivery: 'prepared' }]) {
    const values = [];
    frames = [initial, { ...received, ...change }];
    await assert.rejects(runtime.observeInteraction('call', initial.id, (value) => values.push(value), signal()));
    assert.deepEqual(values, [initial]);
  }
  frames = [{ ...received, id: 'foreign' }];
  const values = [];
  await assert.rejects(runtime.observeInteraction('call', initial.id, (value) => values.push(value), signal()));
  assert.deepEqual(values, []);
});

test('same-revision unavailability can expose a post-commit failure, but terminal facts cannot be revised', async (t) => {
  let frames = [initial, { ...initial, result: { kind: 'unavailable', error: { code: 'CAPTURE_FAILURE', message: 'capture failed' } } }];
  const runtime = await fixture(t, { observeInteraction: async (_conversation, _call, _id, accept) => frames.forEach(accept) });
  const values = [];
  await runtime.observeInteraction('call', initial.id, (value) => values.push(value), signal());
  assert.deepEqual(values, frames);
  frames = [received, { ...received, revision: 3 }];
  const terminal = [];
  await assert.rejects(
    runtime.observeInteraction('call', initial.id, (value) => terminal.push(value), signal()),
    /不一致/,
  );
  assert.deepEqual(terminal, [received]);
});

test('empty or pending EOF is an observation error and never changes a call or submission into success', async (t) => {
  let frames = [];
  const runtime = await fixture(t, { observeInteraction: async (_conversation, _call, _id, accept) => frames.forEach(accept) });
  const state = runtime.getSnapshot();
  for (frames of [[], [initial]]) {
    const values = [];
    await assert.rejects(
      runtime.observeInteraction('call', initial.id, (value) => values.push(value), signal()),
      /最终状态前结束/,
    );
    assert.deepEqual(values, frames);
    assert.equal(runtime.getSnapshot().observation, state.observation);
    assert.equal(runtime.getSnapshot().submissions, state.submissions);
    assert.equal(runtime.getSnapshot().submission, state.submission);
  }
});

test('missing optional transport and unopened conversations fail explicitly without affecting content readiness', async (t) => {
  const unopened = client({ conversation: transport() });
  await assert.rejects(unopened.interactionLinks('call'), /尚未选择对话/);
  await assert.rejects(
    unopened.observeInteraction('call', initial.id, () => {}, signal()),
    /尚未选择对话/,
  );
  const runtime = await fixture(t, {});
  await assert.rejects(runtime.interactionLinks('call'), /未提供外部交互观测/);
  await assert.rejects(
    runtime.observeInteraction('call', initial.id, () => {}, signal()),
    /未提供外部交互观测/,
  );
  assert.equal(runtime.getSnapshot().initialization.status, 'succeeded');
  assert.equal(runtime.getSnapshot().conversation.id, 'fixture-conversation');
});
