import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** Exact marker plus ASCII padding. The marker is never truncated to fit the target. */
export function expectedAnswer(query, outputBytes) {
  const marker = `capacity-answer:${query}\n`;
  return marker + 'x'.repeat(Math.max(0, outputBytes - Buffer.byteLength(marker)));
}

/** A separate loopback producer keeps synthetic streaming timers outside the measured process. */
export async function startUpstream(configuration = {}) {
  const child = fork(fileURLToPath(new URL('./upstream.mjs', import.meta.url)), [], {
    execArgv: [],
    env: {},
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  const ready = Promise.withResolvers();
  const exit = Promise.withResolvers();
  const waiting = new Map();
  let sequence = 0;
  let ended = false;
  let failure;
  let closing;
  let stderr = '';
  child.stderr.on('data', (bytes) => {
    stderr = (stderr + bytes.toString()).slice(-4096);
  });
  const fail = (error) => {
    failure ??= error;
    ready.reject(error);
    for (const pending of waiting.values()) pending.reject(error);
    waiting.clear();
  };
  child.on('error', fail);
  child.on('exit', (code, signal) => {
    ended = true;
    exit.resolve({ code, signal });
    if (!closing || code !== 0) fail(new Error(`Capacity upstream exited (${code ?? signal})${stderr ? `: ${stderr}` : ''}`));
    else if (waiting.size) fail(new Error('Capacity upstream exited before replying to its controller'));
  });
  child.on('message', (message) => {
    if (message?.kind === 'ready') ready.resolve(message.endpoint);
    else if (message?.kind === 'error') fail(new Error(`Capacity upstream: ${message.message}`));
    else if (message?.kind === 'reply') {
      const pending = waiting.get(message.id);
      waiting.delete(message.id);
      pending?.resolve(message.stats);
    }
  });
  const send = (message) => {
    if (ended || !child.connected) throw failure ?? new Error('Capacity upstream is unavailable');
    child.send(message, (error) => {
      if (error) fail(error);
    });
  };
  const request = async (kind) => {
    if (failure) throw failure;
    const id = ++sequence;
    const pending = Promise.withResolvers();
    waiting.set(id, pending);
    try {
      send({ kind, id });
      return await bounded(pending.promise, 10_000, `upstream ${kind}`);
    } finally {
      waiting.delete(id);
    }
  };
  // Observe readiness before sending, including immediate startup errors.
  const started = bounded(ready.promise, 10_000, 'upstream startup');
  void started.catch(() => undefined);
  try {
    send({ kind: 'initialize', configuration });
    const endpoint = await started;
    return {
      endpoint,
      snapshot() {
        if (closing) return Promise.reject(new Error('Capacity upstream is closing'));
        return request('snapshot');
      },
      close() {
        closing ??= (async () => {
          try {
            if (ended) {
              if (failure) throw failure;
              return;
            }
            const stats = await request('close');
            const result = await bounded(exit.promise, 10_000, 'upstream exit');
            if (result.code !== 0) throw failure ?? new Error('Capacity upstream did not shut down cleanly');
            return stats;
          } finally {
            if (!ended) {
              child.kill('SIGKILL');
              await bounded(exit.promise, 3000, 'upstream forced exit');
            }
          }
        })();
        return closing;
      },
    };
  } catch (error) {
    child.kill('SIGKILL');
    await bounded(exit.promise, 3000, 'upstream failed-start exit');
    throw error;
  }
}

async function bounded(pending, milliseconds, label) {
  let timer;
  try {
    return await Promise.race([
      pending,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
