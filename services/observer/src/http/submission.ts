import type { ServerResponse } from 'node:http';
import type { ConversationSubmissionSnapshot } from '@capix/protocol';
import type { ConversationSubmission } from '../conversation/submission.js';

/** One bounded pending snapshot per connection; transport backpressure never reaches the runtime. */
export function followSubmission(submission: ConversationSubmission, response: ServerResponse): void {
  if (response.destroyed) return;
  response.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
  let blocked = false;
  let pending: ConversationSubmissionSnapshot | undefined;
  let detach = () => {};
  const terminal = (snapshot: ConversationSubmissionSnapshot) => !!snapshot.result || snapshot.integrity.status === 'incomplete';
  const write = (snapshot: ConversationSubmissionSnapshot) => {
    if (response.destroyed || response.writableEnded) return;
    if (blocked) {
      pending = snapshot;
      return;
    }
    try {
      blocked = !response.write(JSON.stringify(snapshot) + '\n');
      if (terminal(snapshot)) {
        detach();
        response.end();
      }
    } catch {
      detach();
      response.destroy();
    }
  };
  response.on('drain', () => {
    blocked = false;
    const latest = pending;
    pending = undefined;
    if (latest) write(latest);
  });
  response.once('close', () => {
    pending = undefined;
    detach();
  });
  detach = submission.connect(write);
  if (response.destroyed || response.writableEnded) detach();
  else response.flushHeaders();
}
