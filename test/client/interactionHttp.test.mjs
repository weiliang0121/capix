import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ObservationHttpTransport } from '@capix/client-http';

const state = { id: 'interaction', contract: 'fixture.v1', revision: 1, delivery: 'started', retained: 'memory', model: 'fixture', purpose: 'answer', result: { kind: 'pending' } };
const frame = (value) => JSON.stringify({ type: 'snapshot', value });
const client = (body) => new ObservationHttpTransport('', async () => new Response(body));
const observe = (transport, accept = () => {}) => transport.observeInteraction('conversation', 'call', state.id, accept, new AbortController().signal);

test('interaction HTTP checks links, response identity, complete stream and callback boundary', async () => {
  const wrongLinks = new ObservationHttpTransport('', async () => Response.json({ callId: 'other', interactionIds: [] }));
  await assert.rejects(wrongLinks.interactions('conversation', 'call'), { code: 'CALL_MISMATCH' });
  await assert.rejects(observe(client(frame({ ...state, id: 'other' }))), { code: 'INTERACTION_MISMATCH' });
  await assert.rejects(observe(client(frame(state))), { code: 'INTERACTION_INTERRUPTED' });
  await assert.rejects(observe(client(frame({ ...state, revision: -1 }))), { code: 'INVALID_RESPONSE' });
  await assert.rejects(observe(client('invalid json')), { code: 'INVALID_JSON' });
  const received = { ...state, revision: 2, result: { kind: 'received', feedbackId: 'reply' } };
  await assert.rejects(observe(client(frame(received) + '\n' + frame(received))), { code: 'INTERACTION_TERMINATED' });
  const values = [];
  await observe(client(frame(state) + '\n' + frame(received)), (value) => values.push(value));
  assert.deepEqual(values, [state, received]);
  await assert.rejects(
    observe(client(frame(received)), () => {
      throw new TypeError('consumer failed');
    }),
    (error) => error.kind === 'delivery',
  );
});

test('interaction queries use only explicit conversation/call/id and expose remote failure separately', async () => {
  const requests = [];
  const transport = new ObservationHttpTransport('http://fixture', async (url, init) => {
    requests.push({ url, init });
    return new Response(JSON.stringify({ type: 'error', code: 'INTERACTION_NOT_FOUND', error: 'missing' }) + '\n');
  });
  await assert.rejects(observe(transport), { code: 'INTERACTION_NOT_FOUND' });
  const url = new URL(requests[0].url);
  assert.equal(url.searchParams.get('conversationId'), 'conversation');
  assert.equal(url.searchParams.get('callId'), 'call');
  assert.equal(url.searchParams.get('id'), 'interaction');
  assert.equal(requests[0].init.method, undefined);
  assert.equal(requests[0].init.body, undefined);
});
