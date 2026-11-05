import { fork } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Own one experimental HTTP worker. No conversation work executes in this process. */
export async function startHost({ directory, config, workerIndex, endpoint }) {
  const log = openSync(join(directory, 'worker.log'), 'wx', 0o600);
  const child = fork(fileURLToPath(new URL('./worker.mjs', import.meta.url)), [], { execArgv: [], env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, LANG: process.env.LANG }, stdio: ['ignore', log, log, 'ipc'] });
  closeSync(log);
  const ready = Promise.withResolvers();
  const exited = Promise.withResolvers();
  const replies = new Map();
  let sequence = 0;
  let ended = false;
  let finishing = false;
  let failure;
  let stopping;
  const fail = (error) => {
    failure ??= error;
    ready.reject(error);
    for (const reply of replies.values()) reply.reject(error);
    replies.clear();
  };
  child.on('error', fail);
  child.on('exit', (code, signal) => {
    ended = true;
    exited.resolve({ code, signal });
    if ((!finishing && !stopping) || (code !== 0 && !stopping) || replies.size) fail(new Error(`HTTP worker ${workerIndex} exited (${code ?? signal}); see worker.log`));
  });
  child.on('message', (message) => {
    if (message?.kind === 'ready') ready.resolve(message);
    else if (message?.kind === 'error') fail(new Error(`HTTP worker ${workerIndex}: ${message.message}`));
    else if (message?.kind === 'reply') {
      const reply = replies.get(message.id);
      replies.delete(message.id);
      reply?.resolve(message.value);
    }
  });
  function send(message) {
    if (!child.connected || ended || failure) throw failure ?? new Error('HTTP worker disconnected');
    child.send(message, (error) => {
      if (error) fail(error);
    });
  }
  async function request(kind) {
    const id = ++sequence;
    const reply = Promise.withResolvers();
    replies.set(id, reply);
    try {
      if (kind === 'finish') finishing = true;
      send({ kind, id });
      return await bounded(reply.promise, kind === 'finish' ? 120000 : 15000, `worker ${kind}`);
    } finally {
      replies.delete(id);
    }
  }
  function stop() {
    stopping ??= (async () => {
      if (ended) return;
      child.kill('SIGTERM');
      try {
        await bounded(exited.promise, 10000, 'worker shutdown');
      } catch {
        child.kill('SIGKILL');
        await bounded(exited.promise, 3000, 'worker forced shutdown');
      }
    })();
    return stopping;
  }
  try {
    const started = bounded(ready.promise, 60000, 'HTTP worker startup');
    void started.catch(() => undefined);
    send({ kind: 'initialize', directory, config, workerIndex, endpoint });
    const info = await started;
    return {
      ...info,
      start: () => request('start'),
      async finish() {
        const value = await request('finish');
        const result = await bounded(exited.promise, 10000, 'worker exit');
        if (result.code !== 0) throw failure ?? new Error('HTTP worker did not exit cleanly');
        return value;
      },
      stop,
    };
  } catch (error) {
    await stop();
    throw error;
  }
}

async function bounded(promise, milliseconds, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
