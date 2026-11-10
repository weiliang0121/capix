// Run only against the three installed private candidate packages and public APIs.
import assert from 'node:assert/strict';
import { HttpTransport, HttpError } from '@capix/client-http';
import { TranscriptReplica, TranscriptSequenceError } from '@capix/client-runtime';
import { ConversationContent, initialActiveView, appendActiveView } from '@capix/observer-content';

class JsonTransport extends HttpTransport {
  read(path) {
    return this.get(path);
  }
}
const requests = [];
const transport = new JsonTransport('https://offline.invalid/base/', async (url, init) => {
  requests.push({ url, method: init.method ?? 'GET' });
  return new Response(JSON.stringify({ offline: true }), { headers: { 'Content-Type': 'application/json' } });
});
assert.deepEqual(await transport.read('/snapshot'), { offline: true });
assert.deepEqual(requests, [{ url: 'https://offline.invalid/base/snapshot', method: 'GET' }]);
const failing = new JsonTransport('', async () => new Response('unavailable', { status: 503 }));
await assert.rejects(failing.read('/snapshot'), HttpError);

const snapshot = { id: 'candidate-transcript', revision: 0, start: 0, end: 0, starts: [0], messages: [] };
const replica = TranscriptReplica.receive(undefined, { type: 'baseline', snapshot }, snapshot.id);
snapshot.starts.push(1);
assert.deepEqual(replica.snapshot.starts, [0]);
assert.ok(Object.isFrozen(replica.snapshot));
assert.throws(() => TranscriptReplica.receive(undefined, { type: 'baseline', snapshot: replica.snapshot }, 'other-transcript'), TranscriptSequenceError);

const initial = initialActiveView('transcript', 'memories', 1, 3, ['memory-a']);
const appended = appendActiveView(initial, [3], ['memory-b']);
assert.deepEqual(initial.messageIndexes, [1, 2]);
assert.deepEqual(appended.messageIndexes, [1, 2, 3]);
assert.deepEqual(appended.memoryIds, ['memory-a', 'memory-b']);
assert.equal(appended.revision, 1);
assert.ok(Object.isFrozen(appended.messageIndexes));
assert.throws(() => appendActiveView(initial, [1], []), /Invalid active content members/);
const content = new ConversationContent();
assert.equal(content.closed, false);
content.close();
assert.equal(content.closed, true);
console.log('Verified the three private candidate APIs without external services');
