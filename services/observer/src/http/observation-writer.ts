import type { ServerResponse } from 'node:http';

/** Per-connection buffering is a sender concern; slow consumers never block the runtime. */
export function observationWriter<Frame>(response: ServerResponse): ((frame: Frame) => void) & { end(frame: Frame): void } {
  const queue: ({ readonly line: string; readonly bytes: number } | undefined)[] = [];
  let offset = 0;
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
    while (!blocked && offset < queue.length && !response.destroyed) {
      const item = queue[offset]!;
      queue[offset++] = undefined;
      queuedBytes -= item.bytes;
      blocked = !response.write(item.line);
    }
    // Release sent entries without repeatedly shifting the entire blocked backlog.
    if (offset === queue.length || (offset >= 1024 && offset * 2 >= queue.length)) {
      queue.splice(0, offset);
      offset = 0;
    }
  };
  response.on('drain', () => {
    blocked = false;
    flush();
  });
  response.on('close', () => {
    queue.length = 0;
    offset = 0;
    queuedBytes = 0;
  });
  const write = (frame: Frame) => {
    if (ended || response.destroyed || response.writableEnded) return;
    const line = JSON.stringify(frame) + '\n';
    const bytes = Buffer.byteLength(line);
    queuedBytes += bytes;
    if (queuedBytes + response.writableLength > limit) {
      response.destroy();
      return;
    }
    queue.push({ line, bytes });
    flush();
  };
  write.end = (frame: Frame) => {
    if (ended || response.destroyed || response.writableEnded) return;
    ended = true;
    queue.length = 0;
    offset = 0;
    queuedBytes = 0;
    terminal = JSON.stringify(frame) + '\n';
    flush();
  };
  return write;
}
