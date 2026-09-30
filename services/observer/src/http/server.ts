import { isString, isUndefined } from 'es-toolkit/predicate';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ConfigurationResponse, ErrorResponse, ModelSettings, ConversationUpdate, SourceResponse, TranscriptResponse } from '@capix-observer/protocol';
import { ExecutionRecord, ExecutionRecordHelper, isObject, observeMemory, observeTranscript, RuntimeError } from '@capix-observer/runtime';
import type { initializeObserver } from '../observer/environment.js';
import { acceptExecutionInput } from '../observer/accept.js';
import { ObservationFeed } from '../observer/feed.js';
import { observationWriter } from './observation-writer.js';
import { observeOverview } from '../observer/overview.js';
import { validateSettings } from '../settings.js';
import { allowedSources } from './source.js';

export interface ObserverServerOptions {
  observer: ReturnType<typeof initializeObserver>;
  settings: ModelSettings;
  configured: boolean;
  projectDirectory?: string;
  assetsDirectory?: string;
}

/** Assemble transport around an initialized world. Importing this module never starts a listener. */
export function createObserverServer(options: ObserverServerOptions) {
  const { observer, configured } = options;
  const settings = validateSettings(options.settings);
  const project = options.projectDirectory ?? fileURLToPath(new URL('../../../../', import.meta.url));
  const assets = options.assetsDirectory ?? resolve(project, 'apps/observer/dist');
  const feed = new ObservationFeed(observer, observer.changes);
  const server = createServer((req, res) => {
    void handle(req, res).catch((error) => {
      const body: ErrorResponse = error instanceof RuntimeError ? { error: error.message, code: error.code } : { error: '服务内部错误。', code: 'INTERNAL_ERROR' };
      if (res.headersSent) {
        if (!res.destroyed) res.end(JSON.stringify({ type: 'error', ...body } satisfies ConversationUpdate) + '\n');
        return;
      }
      json(res, error instanceof RuntimeError ? (error.code === 'RUNTIME_BUSY' ? 409 : 400) : 500, body);
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const address = server.address();
    const port = address && !isString(address) ? address.port : undefined;
    if (!new Set([`127.0.0.1:${port}`, `localhost:${port}`]).has(req.headers.host || '')) return json(res, 403, { error: '只接受本机请求。' } satisfies ErrorResponse);
    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    if (req.method === 'GET' && url.pathname === '/api/config') return json(res, 200, { ...settings, configured } satisfies ConfigurationResponse);
    if (req.method === 'GET' && url.pathname === '/api/observe') {
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
      const write = observationWriter(res);
      const unsubscribe = feed.connect((frame) => {
        if (res.destroyed) return;
        try {
          if (frame.type === 'error') {
            res.end(JSON.stringify(frame) + '\n');
            return;
          }
          write(frame);
        } catch {
          res.destroy();
        }
      });
      res.on('close', unsubscribe);
      res.flushHeaders();
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/memory') return json(res, 200, observeMemory(observer.runtime.context.memories, observer.book));
    if (req.method === 'GET' && url.pathname === '/api/executions') return json(res, 200, observeOverview(observer));
    if (req.method === 'GET' && url.pathname === '/api/transcript') return json(res, 200, { messages: observer.transcript.snapshot() } satisfies TranscriptResponse);
    if (req.method === 'GET' && url.pathname === '/api/execution') {
      const id = url.searchParams.get('id') || '';
      if (!(observer.book.get(id) instanceof ExecutionRecord)) return json(res, 404, { error: '未找到执行记录。' } satisfies ErrorResponse);
      return json(res, 200, ExecutionRecordHelper.snapshot(observer.recording.recorder, id), observeTranscript);
    }
    if (req.method === 'GET' && url.pathname === '/api/source') {
      const path = url.searchParams.get('file') || '';
      if (!allowedSources.has(path)) return json(res, 404, { error: '未找到源码。' } satisfies ErrorResponse);
      return json(res, 200, { path, content: await readFile(resolve(project, path), 'utf8') } satisfies SourceResponse);
    }
    if (req.method === 'POST' && url.pathname === '/api/run') {
      if ((req.headers.origin && req.headers.origin !== url.origin) || !req.headers['content-type']?.startsWith('application/json')) return json(res, 403, { error: '需要同源 JSON 请求。' } satisfies ErrorResponse);
      const data = await readBody(req);
      if (!isObject(data)) throw new RuntimeError('INVALID_INPUT', '无效请求。');
      const runSettings = validateSettings({ ...settings, ...(isUndefined(data.contextBudget) ? {} : { contextBudget: data.contextBudget }) });
      const controller = new AbortController();
      res.on('close', () => {
        if (!res.writableEnded) controller.abort();
      });
      let deliveryError: unknown;
      await observer.execution.converse(
        () => {
          const input = acceptExecutionInput(observer.transcript, data);
          res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
          res.flushHeaders();
          return input;
        },
        { settings: runSettings, signal: controller.signal, transcript: observer.transcript },
        (update) => {
          if (res.destroyed || deliveryError) return;
          try {
            res.write(JSON.stringify(update) + '\n');
          } catch (error) {
            deliveryError = error;
          }
        },
      );
      if (deliveryError) throw deliveryError;
      res.end();
      return;
    }
    if (req.method === 'GET') return serveAsset(res, assets, url.pathname);
    return json(res, 404, { error: 'Not found' } satisfies ErrorResponse);
  }
  server.on('close', () => feed.close());
  return server;
}

function json(res: ServerResponse, status: number, value: unknown, replacer?: (key: string, value: unknown) => unknown) {
  const body = JSON.stringify(value, replacer);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
async function readBody(req: IncomingMessage): Promise<unknown> {
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
const contentTypes: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
async function serveAsset(res: ServerResponse, directory: string, pathname: string) {
  const name = pathname === '/' ? 'index.html' : pathname.slice(1);
  if (name !== 'index.html' && !name.startsWith('assets/')) return json(res, 404, { error: 'Not found' } satisfies ErrorResponse);
  const path = resolve(directory, name);
  if (relative(directory, path).startsWith('..') || !contentTypes[extname(path)]) return json(res, 404, { error: 'Not found' } satisfies ErrorResponse);
  let content: Buffer;
  try {
    content = await readFile(path);
  } catch (error) {
    if (isObject(error) && error.code === 'ENOENT') return json(res, 404, { error: 'Not found' } satisfies ErrorResponse);
    throw error;
  }
  res.writeHead(200, { 'Content-Type': contentTypes[extname(path)]!, 'Cache-Control': name === 'index.html' ? 'no-cache' : 'public, max-age=31536000, immutable' });
  res.end(content);
}
