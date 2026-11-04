import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { ConversationStore } from '@capix/conversation-service/persistence';
import { createConversationWebHost } from '@capix/conversation-service/web';

test('recovery discovery checks live host admission before scanning checkpoint heads', { timeout: 10_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'capix-recovery-query-'));
  const database = join(directory, 'conversation.sqlite');
  const gate = Promise.withResolvers();
  const entered = Promise.withResolvers();
  let host;
  let unavailable = false;
  t.after(async () => {
    unavailable = false;
    gate.resolve();
    await host?.close();
    await rm(directory, { recursive: true, force: true });
  });

  // Reach the implementation through a public instance; do not import a private
  // store module or add production observability only for this assertion.
  const probe = ConversationStore.open(database);
  const checkpoints = Object.getPrototypeOf(probe.checkpoints);
  const listRoots = checkpoints.listRoots;
  const read = checkpoints.read;
  probe.close();
  let lists = 0;
  let reads = 0;
  t.mock.method(checkpoints, 'listRoots', function () {
    lists++;
    return listRoots.call(this);
  });
  t.mock.method(checkpoints, 'read', function (id) {
    reads++;
    return read.call(this, id);
  });
  const assertAvailable = ConversationStore.prototype.assertAvailable;
  t.mock.method(ConversationStore.prototype, 'assertAvailable', function () {
    if (unavailable) throw new Error('injected store unavailability');
    return assertAvailable.call(this);
  });
  const model = {
    async complete(request) {
      if (request.responseFormat === 'text') {
        entered.resolve();
        await gate.promise;
      }
      return { id: 'query-fixture', model: 'fixture', text: request.responseFormat === 'text' ? 'accepted answer' : '{"changes":[]}', finishReason: 'stop', usage: null };
    },
  };
  host = createConversationWebHost({ database, model, modelName: 'fixture', mode: 'demo' });
  host.server.listen(0, '127.0.0.1');
  await once(host.server, 'listening');
  const origin = `http://127.0.0.1:${host.server.address().port}`;
  const session = await (await fetch(origin + '/api/session')).json();
  const post = (path, body) => fetch(origin + path, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  const ready = await fetch(origin + '/api/recoveries');
  assert.equal(ready.status, 200);
  assert.deepEqual(await ready.json(), []);
  assert.equal(lists, 1);

  const response = await post('/api/run', { conversationId: session.conversationId, submissionId: 'active', input: { messages: [{ role: 'user', content: 'hello' }] } });
  await entered.promise;
  const before = { lists, reads };
  // These are direct HTTP requests, independent of any browser-side suppression.
  for (let attempt = 0; attempt < 2; attempt++) {
    const busy = await fetch(origin + '/api/recoveries');
    assert.equal(busy.status, 409);
    assert.equal((await busy.json()).code, 'RUNTIME_BUSY');
  }
  assert.deepEqual({ lists, reads }, before);

  const resume = await post('/api/resume', { conversationId: session.conversationId, submissionId: 'busy-resume', contextId: 'old-context' });
  assert.equal(resume.status, 200);
  const rejected = (await resume.text()).trim().split('\n').map(JSON.parse)[0].submission;
  assert.equal(rejected.result.status, 'rejected');
  assert.equal(rejected.result.error.code, 'RUNTIME_BUSY');
  assert.deepEqual({ lists, reads }, before, 'busy resume must not run expensive eligibility checks either');

  gate.resolve();
  const completed = (await response.text()).trim().split('\n').map(JSON.parse);
  assert.ok(completed.some((frame) => (frame.submission ?? frame.change)?.result?.status === 'completed'));
  const idle = await fetch(origin + '/api/recoveries');
  assert.equal(idle.status, 200);
  assert.deepEqual(await idle.json(), []);
  assert.equal(lists, 2);

  unavailable = true;
  const unavailableResponse = await fetch(origin + '/api/recoveries');
  assert.equal(unavailableResponse.status, 503);
  assert.equal((await unavailableResponse.json()).code, 'CONTENT_UNAVAILABLE');
  assert.equal(lists, 2, 'an unavailable host must not start checkpoint scanning');
});
