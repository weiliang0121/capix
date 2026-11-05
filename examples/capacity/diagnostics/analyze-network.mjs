import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const directory = process.argv[2];
if (!directory || process.argv.length < 3 || process.argv.length > 4) throw new Error('Usage: node analyze-network.mjs CASE_DIRECTORY [NEW_OUTPUT_FILE]');
const output = process.argv[3] ?? join(directory, 'network-analysis.json');
const client = JSON.parse(readFileSync(join(directory, 'network-client.json'), 'utf8'));
const upstream = JSON.parse(readFileSync(join(directory, 'network-upstream.json'), 'utf8'));
if (client.overflow || upstream.overflow) throw new Error('Network probe exceeded its event bound');
const origin = Math.min(client.events[0].at, upstream.events[0].at);
const sent = client.events.filter((event) => event.kind === 'request.send');
const failures = client.events
  .filter((event) => event.kind === 'request.error')
  .map((error) => {
    const attempts = sent.filter((event) => event.request === error.request && event.at <= error.at);
    const send = attempts.at(-1);
    // A port alone is not a connection identity: the OS may reuse it. Require
    // that this exact client socket has already carried a different request.
    const reusedClientSocket = !!send && sent.some((event) => event.socket === send.socket && event.request !== send.request && event.at < send.at);
    const connection = send && upstream.events.findLast((event) => event.kind === 'socket.registered' && event.remotePort === send.localPort && event.localPort === send.remotePort && event.at <= send.at);
    const server = connection ? upstream.events.filter((event) => event.socket === connection.socket && event.at <= send.at) : [];
    const finished = server.findLast((event) => event.kind === 'response.finish');
    const timeout = server.findLast((event) => event.kind === 'socket.timeout');
    const closed = server.findLast((event) => event.kind === 'socket.close');
    return {
      request: error.request,
      code: error.code,
      syscall: error.syscall,
      attempts: attempts.length,
      clientSocket: send?.socket,
      upstreamSocket: connection?.socket,
      priorResponse: finished?.request,
      priorResponseFinishedMs: finished && finished.at - origin,
      serverTimeoutMs: timeout && timeout.at - origin,
      serverClosedMs: closed && closed.at - origin,
      sentMs: send && send.at - origin,
      failedMs: error.at - origin,
      sentAfterServerClosedMs: closed && send.at - closed.at,
      sentAfterPriorResponseMs: finished && send.at - finished.at,
      clientStillOpenAtSend: send && !send.destroyed && !send.readableEnded && !send.writableEnded,
      reusedClientSocket,
      reusedAfterServerTimeout: reusedClientSocket && !!finished && !!timeout && !!closed && closed.at < send.at,
    };
  });
const counts = (events) => Object.fromEntries([...new Set(events.map((event) => event.kind))].map((kind) => [kind, events.filter((event) => event.kind === kind).length]));
const summary = {
  client: counts(client.events),
  upstream: counts(upstream.events),
  serverConfiguration: upstream.events.find((event) => event.kind === 'server.listening'),
  failed: failures.length,
  failedReusedAfterServerTimeout: failures.filter((failure) => failure.reusedAfterServerTimeout).length,
  clientEventLoopGapCount: client.events.filter((event) => event.kind === 'eventLoop.gap').length,
  clientEventLoopGaps: client.events
    .filter((event) => event.kind === 'eventLoop.gap')
    .slice(0, 16)
    .map((event) => ({ fromMs: event.previous - origin, toMs: event.at - origin, elapsedMs: event.elapsedMs })),
  sentAfterServerClosedMs: range(failures.map((failure) => failure.sentAfterServerClosedMs)),
  sentAfterPriorResponseMs: range(failures.map((failure) => failure.sentAfterPriorResponseMs)),
  failureExamples: failures.slice(0, 8),
};
writeFileSync(output, JSON.stringify(summary, null, 2), { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ failed: summary.failed, failedReusedAfterServerTimeout: summary.failedReusedAfterServerTimeout, client: summary.client, upstream: summary.upstream }, null, 2));

function range(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return { count: sorted.length, min: sorted.at(0) ?? null, median: sorted.length ? sorted[Math.floor(sorted.length / 2)] : null, max: sorted.at(-1) ?? null };
}
