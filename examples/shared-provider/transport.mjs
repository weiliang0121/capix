import { ChatCompletionsProvider } from '@weiliang0121/capix-model-provider';

const encoder = new TextEncoder();

/** Real provider adapter; only the HTTP transport is controlled and entirely offline. */
export function createControlledProvider() {
  const requests = [];
  const waiting = new Map();
  let closed = false;
  const transport = {
    get requests() {
      return requests.slice();
    },
    async waitFor(index) {
      if (!Number.isSafeInteger(index) || index < 0) throw new RangeError('A nonnegative request index is required');
      if (requests[index]) return requests[index];
      if (closed) throw new Error('Offline transport is closed');
      let arrival = waiting.get(index);
      if (!arrival) {
        arrival = Promise.withResolvers();
        waiting.set(index, arrival);
      }
      return arrival.promise;
    },
    close() {
      if (closed) return;
      closed = true;
      const reason = new Error('Offline transport closed');
      for (const request of requests) request.close(reason);
      for (const arrival of waiting.values()) arrival.reject(reason);
      waiting.clear();
    },
  };
  const model = new ChatCompletionsProvider({
    endpoint: 'https://offline.invalid/chat/completions',
    apiKey: 'offline-fixture-key',
    model: 'shared-fixture-model',
    timeoutMs: 10_000,
    async fetch(_url, options) {
      if (closed) throw new Error('Offline transport is closed');
      const body = JSON.parse(options.body);
      if (body.stream !== true) throw new Error('This experiment requires SSE requests');
      const request = createRequest(requests.length, body, options.signal);
      requests.push(request);
      waiting.get(request.index)?.resolve(request);
      waiting.delete(request.index);
      return new Response(request.stream, { headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } });
    },
  });
  return { model, transport };
}

function createRequest(index, body, signal) {
  let controller;
  let cancelled = 0;
  let closed = false;
  let terminal = false;
  const stream = new ReadableStream({
    start(value) {
      controller = value;
    },
    cancel() {
      // A successful [DONE] also makes the parser cancel its HTTP reader. Only
      // signal.aborted denotes request cancellation; these are different facts.
      cancelled++;
      closed = true;
    },
  });
  const write = (wire) => {
    if (closed || terminal) throw new Error('This request no longer accepts SSE chunks');
    controller.enqueue(encoder.encode(wire));
  };
  const event = (text, finishReason = null) => `data: ${JSON.stringify({ id: `reply-${index}`, model: body.model, choices: [{ index: 0, delta: { content: text }, finish_reason: finishReason }] })}\n\n`;
  return {
    index,
    body,
    signal,
    stream,
    get cancelled() {
      return cancelled;
    },
    get closed() {
      return closed;
    },
    chunk(text) {
      write(event(text));
    },
    finish(text = '', finishReason = 'stop') {
      write(event(text, finishReason) + 'data: [DONE]\n\n');
      terminal = true;
      // Deliberately leave the HTTP body open: the real provider must recognize
      // [DONE] and release its reader without waiting for a transport EOF.
    },
    malformed() {
      write('data: {invalid-json\n\n');
      terminal = true;
    },
    close(reason) {
      if (closed) return;
      closed = true;
      controller.error(reason);
    },
  };
}
