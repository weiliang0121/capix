import type { ServerResponse } from 'node:http';
import type { ConversationSubmissionFrame } from '@weiliang0121/capix-protocol';
import type { ConversationSubmission } from '../conversation/submission.js';

/** A slow connection resumes from an authoritative baseline, never drops arbitrary deltas. */
export function followSubmission(submission: ConversationSubmission, response: ServerResponse): void {
  if (response.destroyed) return;
  response.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
  let blocked = false;
  let pending = false;
  let detach = () => {};
  const write = (frame: ConversationSubmissionFrame) => {
    if (response.destroyed || response.writableEnded) return;
    if (blocked) {
      pending = true;
      return;
    }
    try {
      blocked = !response.write(JSON.stringify(frame) + '\n');
      const progress = frame.type === 'baseline' ? frame.submission : frame.type === 'submission' ? frame.change : undefined;
      if (progress && (progress.result || progress.integrity?.status === 'incomplete')) {
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
    if (pending) {
      pending = false;
      write(submission.baseline);
    }
  });
  response.once('close', () => {
    pending = false;
    detach();
  });
  detach = submission.connectFrames(write);
  if (response.destroyed || response.writableEnded) detach();
  else response.flushHeaders();
}
