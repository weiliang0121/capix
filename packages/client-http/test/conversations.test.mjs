import test from 'node:test';

import assert from 'node:assert/strict';

import { ConversationHttpTransport, ObservationHttpTransport } from '@capix/client-http';

import { conversationDescriptor } from './fixtures.mjs';

test('HTTP conversation targets are explicit and mismatched descriptors or admission responses are rejected', async () => {
  const calls = [];
  const descriptor = conversationDescriptor('a', 't');
  const http = new ConversationHttpTransport('', async (url, init) => {
    calls.push({ url, init });
    return Response.json(url.includes('/admission') ? { conversationId: 'a', transcriptId: 't', status: 'ready' } : descriptor);
  });
  assert.deepEqual(await http.createConversation(), descriptor);
  assert.equal(calls[0].url, '/api/conversations');
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(await http.conversation('a'), descriptor);
  assert.equal(calls[1].url, '/api/conversations/a');
  await assert.rejects(http.conversation('b'), (error) => error.code === 'CONVERSATION_MISMATCH');
  await assert.rejects(http.admission('b'), (error) => error.code === 'CONVERSATION_MISMATCH');
  const observation = new ObservationHttpTransport('', async (url) => {
    calls.push({ url });
    return Response.json({ items: [] });
  });
  await observation.memory('a/b');
  assert.equal(calls.at(-1).url, '/api/memory?conversationId=a%2Fb');
});
