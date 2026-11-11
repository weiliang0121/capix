// Run only against the two installed private client candidates and public APIs.
import assert from 'node:assert/strict';
import { HttpTransport, HttpError } from '@capix/client-http';
import { TranscriptReplica, TranscriptSequenceError } from '@capix/client-runtime';

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

console.log('Verified the two private client candidate APIs without external services');
