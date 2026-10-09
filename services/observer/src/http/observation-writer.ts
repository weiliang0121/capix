import type { ServerResponse } from 'node:http';

/** Per-connection buffering is a sender concern; slow consumers never block the runtime. */
export function observationWriter<T>(response: ServerResponse): ((frame: T) => void) & { end(frame: T): void } {
  const queue: string[] = [];
  let queuedBytes = 0;
  let blocked = response.writableNeedDrain;
  let ended = false;
  let terminal: string | undefined;
  const limit = 16 * 1024 * 1024;
  const flush = () => {
    if (terminal && !blocked && !response.destroyed) {
      response.end(terminal);
      terminal = undefined;
      return;
    }
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
  const write = (frame: T) => {
    if (ended || response.destroyed || response.writableEnded) return;
    const line = JSON.stringify(frame) + '\n';
    queuedBytes += Buffer.byteLength(line);
    if (queuedBytes + response.writableLength > limit) {
      response.destroy();
      return;
    }
    queue.push(line);
    flush();
  };
  write.end = (frame: T) => {
    if (ended || response.destroyed || response.writableEnded) return;
    ended = true;
    queue.length = 0;
    queuedBytes = 0;
    terminal = JSON.stringify(frame) + '\n';
    flush();
  };
  return write;
}
