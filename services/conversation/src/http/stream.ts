import type { ServerResponse } from 'node:http';

/** Coalesce missed frames only when the wire contract permits another baseline; otherwise reconnect. */
export function streamFrames<Frame>(response: ServerResponse, connect: (receive: (frame: Frame) => void) => () => void, baseline: (() => Frame) | undefined, terminal: (frame: Frame) => boolean = () => false): () => void {
  let blocked = false;
  let pending = false;
  let detach = () => {};
  const close = () => {
    pending = false;
    detach();
    response.off('drain', drain);
  };
  const write = (frame: Frame) => {
    if (response.destroyed || response.writableEnded) return;
    if (blocked) {
      pending = true;
      return;
    }
    try {
      blocked = !response.write(JSON.stringify(frame) + '\n');
      if (terminal(frame)) {
        close();
        response.end();
      }
    } catch {
      close();
      response.destroy();
    }
  };
  const drain = () => {
    blocked = false;
    if (pending) {
      pending = false;
      if (!baseline) {
        // Transcript connections allow one initial baseline. A clean EOF lets their
        // existing bounded reconnect obtain a fresh one without inventing a delta.
        close();
        response.end();
        return;
      }
      try {
        write(baseline());
      } catch {
        close();
        response.destroy();
      }
    }
  };
  response.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
  response.on('drain', drain);
  response.once('close', close);
  detach = connect(write);
  if (response.destroyed || response.writableEnded) close();
  else response.flushHeaders();
  return () => {
    close();
    response.destroy();
  };
}
