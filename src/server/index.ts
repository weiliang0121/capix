import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isObject } from './value/object.js';
import { observeTranscript } from './transcript/observe.js';
import { acceptExecutionInput } from './observer/accept.js';
import { initializeObserver } from './observer/environment.js';
import { RuntimeError } from './errors/error.js';
import { DeepSeekProvider } from './provider.js';
import { observeExecution } from './observer/observe.js';
import { validateSettings } from './settings.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const project = resolve(root, '..');
const settings = validateSettings({
  model: process.env.DEEPSEEK_MODEL || 'deepseek-flash',
  contextBudget: Number(process.env.CONTEXT_BUDGET || 32768),
  maxOutputTokens: Number(process.env.MAX_OUTPUT_TOKENS || 1536),
  timeoutMs: Number(process.env.MODEL_TIMEOUT_MS || 90000),
});
const key = process.env.DEEPSEEK_API_KEY?.trim() || '';
const observer = initializeObserver(new DeepSeekProvider(key));
let executing = false;
const port = Number(process.env.PORT || 4317);
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
const allowedSources = new Set([
  'observer/environment.ts',
  'observer/execution.ts',
  'observer/observe.ts',
  'execution/execution.ts',
  'invocation/invoke.ts',
  'invocation/lifecycle.ts',
  'operations/operation.ts',
  'runtime/runtime.ts',
  'runtime/clock.ts',
  'records/event/record.ts',
  'records/event/helper.ts',
  'errors/error.ts',
  'errors/helper.ts',
  'errors/traversal.ts',
  'errors/detail.ts',
  'errors/format.ts',
  'records/value/snapshot.ts',
  'records/value/copy.ts',
  'transcript/observe.ts',
  'settings.ts',
  'records/value/check.ts',
  'records/value/freeze.ts',
  'context/context.ts',
  'context/execution.ts',
  'context/operation.ts',
  'context/attempt.ts',
  'records/recorder.ts',
  'records/record.ts',
  'records/execution/record.ts',
  'records/execution/helper.ts',
  'records/operation/record.ts',
  'records/operation/helper.ts',
  'records/attempt/record.ts',
  'records/attempt/helper.ts',
  'records/container/book.ts',
  'records/container/index.ts',
  'records/index.ts',
  'operations/model.ts',
  'operations/model/request.ts',
  'operations/model/capacity.ts',
  'operations/history/select.ts',
  'operations/context/assemble.ts',
  'operations/answer/generate.ts',
  'observer/accept.ts',
  'transcript/ref.ts',
  'transcript/transcript.ts',
  'operations/history/input.ts',
  'value/object.ts',
  'operations/history/output.ts',
  'operations/answer/output.ts',
  'provider.ts',
]);

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(body));
}
async function body(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 4 * 1024 * 1024) throw new RuntimeError('BODY_TOO_LARGE', '请求超过 4 MiB。');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new RuntimeError('INVALID_JSON', '请求正文不是 JSON。');
  }
}
async function handle(req: IncomingMessage, res: ServerResponse) {
  if (!allowedHosts.has(req.headers.host || '')) return json(res, 403, { error: '只接受本机请求。' });
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  if (req.method === 'GET' && url.pathname === '/api/config') return json(res, 200, { ...settings, configured: Boolean(key) });
  if (req.method === 'GET' && url.pathname === '/api/transcript') return json(res, 200, { messages: observer.transcript.snapshot() });
  if (req.method === 'GET' && url.pathname === '/api/source') {
    const name = url.searchParams.get('file') || '';
    if (!allowedSources.has(name)) return json(res, 404, { error: '未找到源码。' });
    return json(res, 200, {
      path: `src/server/${name}`,
      content: await readFile(resolve(project, 'src/server', name), 'utf8'),
    });
  }
  if (req.method === 'POST' && url.pathname === '/api/run') {
    if ((req.headers.origin && req.headers.origin !== url.origin) || !req.headers['content-type']?.startsWith('application/json')) return json(res, 403, { error: '需要同源 JSON 请求。' });
    const data = await body(req);
    if (!isObject(data)) throw new RuntimeError('INVALID_INPUT', '无效请求。');
    const runSettings = validateSettings({ ...settings, ...(data.contextBudget === undefined ? {} : { contextBudget: data.contextBudget }) });
    if (executing) return json(res, 409, { error: '当前环境正在执行，请等待本次调用结束。' });
    const input = acceptExecutionInput(observer.transcript, data);
    executing = true;
    try {
      res.writeHead(200, {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Accel-Buffering': 'no',
      });
      res.flushHeaders();
      const controller = new AbortController();
      res.on('close', () => {
        if (!res.writableEnded) controller.abort();
      });
      await observeExecution(observer.execution, observer.recorder, input, { settings: runSettings, signal: controller.signal, transcript: observer.transcript }, (trace) => {
        if (!res.destroyed) res.write(JSON.stringify({ type: 'trace', trace }, observeTranscript) + '\n');
      });
      res.end();
    } finally {
      executing = false;
    }
    return;
  }
  const files: Record<string, [string, string]> = {
    '/': [resolve(project, 'src/web/index.html'), 'text/html; charset=utf-8'],
    '/app.js': [resolve(root, 'web/app.js'), 'text/javascript; charset=utf-8'],
    '/shared/execution/project.js': [resolve(root, 'shared/execution/project.js'), 'text/javascript; charset=utf-8'],
    '/messages/draft.js': [resolve(root, 'web/messages/draft.js'), 'text/javascript; charset=utf-8'],
    '/sequence/view.js': [resolve(root, 'web/sequence/view.js'), 'text/javascript; charset=utf-8'],
    '/app.js.map': [resolve(root, 'web/app.js.map'), 'application/json'],
    '/style.css': [resolve(project, 'src/web/style.css'), 'text/css; charset=utf-8'],
  };
  const file = files[url.pathname];
  if (req.method !== 'GET' || !file) return json(res, 404, { error: 'Not found' });
  res.writeHead(200, { 'Content-Type': file[1], 'Cache-Control': 'no-cache' });
  res.end(await readFile(file[0]));
}
const server = createServer((req, res) => {
  void handle(req, res).catch((error) => {
    if (res.headersSent) {
      res.end();
      return;
    }
    json(res, error instanceof RuntimeError ? 400 : 500, {
      error: error instanceof RuntimeError ? error.message : '服务内部错误。',
    });
  });
});
server.listen(port, '127.0.0.1', () => console.log(`CAPiX Observer · http://127.0.0.1:${port} · DeepSeek ${key ? 'configured' : 'key missing'}`));
