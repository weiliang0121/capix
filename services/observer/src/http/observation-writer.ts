import type { ServerResponse } from 'node:http';
import type { ObservationUpdate } from '@capix-observer/protocol';

/** Per-connection buffering is a sender concern; slow consumers never block the runtime. */
export function observationWriter(response: ServerResponse): (frame: ObservationUpdate) => void {
  const queue: string[] = [];
  let queuedBytes = 0;
  let blocked = false;
  const limit = 16 * 1024 * 1024;
  const flush = () => {
    while (!blocked && queue.length && !response.destroyed) {
      const line = queue.shift()!;
      queuedBytes -= Buffer.byteLength(line);
      blocked = !response.write(line);
    }
  };
  response.on('drain', () => {
    blocked = false;
    flush();
  });
  response.on('close', () => {
    queue.length = 0;
    queuedBytes = 0;
  });
  return (frame) => {
    if (response.destroyed || response.writableEnded) return;
    const line = JSON.stringify(frame) + '\n';
    queuedBytes += Buffer.byteLength(line);
    if (queuedBytes + response.writableLength > limit) {
      response.destroy();
      return;
    }
    queue.push(line);
    flush();
  };
}
