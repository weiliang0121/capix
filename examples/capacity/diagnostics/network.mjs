import diagnostics from 'node:diagnostics_channel';
import childProcess from 'node:child_process';
import http from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import { performance } from 'node:perf_hooks';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Diagnostic preload for the offline capacity worker only. Never records URLs,
// request/response bodies, credentials, or arbitrary error messages. Response
// headers are restricted to the Connection / Keep-Alive timing metadata.
const directory = process.env.CAPIX_CAPACITY_NETWORK_DIRECTORY ?? process.argv[2];
const role = process.env.CAPIX_CAPACITY_NETWORK_ROLE ?? 'client';
if (!directory || !['client', 'upstream'].includes(role)) throw new Error('Network probe needs a capacity experiment directory');
const expectedEntry = fileURLToPath(new URL(role === 'client' ? '../worker.mjs' : '../upstream.mjs', import.meta.url));
if (!process.argv[1] || resolve(process.argv[1]) !== expectedEntry) throw new Error('Network probe may only preload the offline capacity worker or its fixture upstream');
const events = [];
let overflow = false;
const sockets = new WeakMap();
const requests = new WeakMap();
let socketSequence = 0;
let requestSequence = 0;
const now = () => performance.timeOrigin + performance.now();
const record = (kind, data = {}) => {
  if (events.length === 100_000) {
    overflow = true;
    return;
  }
  events.push({ at: now(), kind, ...data });
};
const errorValue = (error) => ({ code: error?.code, errno: error?.errno, syscall: error?.syscall, name: error?.name });

function socketState(socket) {
  return { destroyed: socket.destroyed, readableEnded: socket.readableEnded, writableEnded: socket.writableEnded, bytesRead: socket.bytesRead, bytesWritten: socket.bytesWritten, localPort: socket.localPort, remotePort: socket.remotePort };
}

function socketId(socket) {
  if (!socket) return undefined;
  let id = sockets.get(socket);
  if (id) return id;
  id = ++socketSequence;
  sockets.set(socket, id);
  record('socket.registered', { socket: id, ...socketState(socket) });
  for (const name of ['timeout', 'end', 'close', 'error']) {
    socket.on(name, (value) => record(`socket.${name}`, { socket: id, ...(name === 'error' ? errorValue(value) : {}), ...(name === 'close' ? { hadError: value } : {}), ...socketState(socket) }));
  }
  return id;
}

function requestId(request) {
  let id = requests.get(request);
  if (!id) {
    id = ++requestSequence;
    requests.set(request, id);
  }
  return id;
}

if (role === 'client') {
  // The capacity upstream intentionally clears execArgv and env. Explicitly pass
  // this probe only to that fixture process, not arbitrary application children.
  const fork = childProcess.fork;
  childProcess.fork = function (modulePath, args, options) {
    if (String(modulePath).endsWith('/capacity/upstream.mjs')) {
      options = { ...options, execArgv: [...(options?.execArgv ?? []), '--import', fileURLToPath(import.meta.url)], env: { ...options?.env, CAPIX_CAPACITY_NETWORK_DIRECTORY: directory, CAPIX_CAPACITY_NETWORK_ROLE: 'upstream' } };
    }
    return fork.call(this, modulePath, args, options);
  };
  diagnostics.subscribe('undici:client:connected', ({ socket }) => record('connected', { socket: socketId(socket), ...socketState(socket) }));
  diagnostics.subscribe('undici:client:connectError', ({ error }) => record('connect.error', errorValue(error)));
  diagnostics.subscribe('undici:request:create', ({ request }) => record('request.create', { request: requestId(request) }));
  diagnostics.subscribe('undici:client:sendHeaders', ({ request, socket }) => record('request.send', { request: requestId(request), socket: socketId(socket), ...socketState(socket) }));
  diagnostics.subscribe('undici:request:bodySent', ({ request }) => record('request.bodySent', { request: requestId(request) }));
  diagnostics.subscribe('undici:request:headers', ({ request, response }) => {
    const headers = {};
    for (let index = 0; index < response.headers.length; index += 2) {
      const name = response.headers[index].toString().toLowerCase();
      if (name === 'connection' || name === 'keep-alive') headers[name] = response.headers[index + 1].toString();
    }
    record('request.headers', { request: requestId(request), status: response.statusCode, connection: headers.connection, keepAlive: headers['keep-alive'] });
  });
  diagnostics.subscribe('undici:request:trailers', ({ request }) => record('request.complete', { request: requestId(request) }));
  diagnostics.subscribe('undici:request:error', ({ request, error }) => record('request.error', { request: requestId(request), ...errorValue(error) }));
} else {
  const createServer = http.createServer;
  http.createServer = function (...args) {
    const server = createServer.apply(this, args);
    server.on('listening', () => record('server.listening', { keepAliveTimeout: server.keepAliveTimeout, keepAliveTimeoutBuffer: server.keepAliveTimeoutBuffer, requestTimeout: server.requestTimeout, headersTimeout: server.headersTimeout }));
    server.on('connection', (socket) => socketId(socket));
    server.on('request', (request, response) => {
      const id = requestId(request);
      const socket = socketId(request.socket);
      record('request.received', { request: id, socket, ...socketState(request.socket) });
      response.on('finish', () => record('response.finish', { request: id, socket }));
      response.on('close', () => record('response.close', { request: id, socket, finished: response.writableFinished }));
    });
    return server;
  };
}
syncBuiltinESMExports();
let tick = now();
const timer = setInterval(() => {
  const current = now();
  if (current - tick > 100) record('eventLoop.gap', { previous: tick, elapsedMs: current - tick });
  tick = current;
}, 10);
timer.unref();
process.on('exit', () => writeFileSync(join(directory, `network-${role}.json`), JSON.stringify({ role, pid: process.pid, overflow, events }, null, 2), { flag: 'wx', mode: 0o600 }));
