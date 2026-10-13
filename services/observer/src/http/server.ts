import { isString, isUndefined } from 'es-toolkit/predicate';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ConversationAdmission, ConversationSubmissionDiscovery, ConfigurationResponse, ErrorResponse, ModelSettings, SourceResponse, InteractionUpdate } from '@capix/protocol';
import { ExecutionRecord, ExecutionRecordHelper, observeMemory } from '@capix/server-runtime/recording';
import { isObject, isInvocationCancelled, RuntimeError } from '@capix/server-runtime';
import type { ObserverConversations } from '../assembly/conversations.js';
import { transcriptSnapshot } from '../conversation/transcript/feed.js';
import { ObservationFeed } from '../observation/feed.js';
import { SourceIncomplete } from '../observation/record/source.js';
import { observationWriter } from './observation-writer.js';
import { observeOverview } from '../observation/overview.js';
import { executionArchive } from '../observation/archive.js';
import { validateSettings } from '../assembly/settings.js';
import { allowedSources } from './source.js';
import { ConversationSubmission, createSubmissionStore, type SubmissionRetention } from '../conversation/submission.js';
import { followSubmission } from './submission.js';
import { callInteractionLinks, observeCallInteraction } from '../observation/interactions.js';

export interface ObserverServerOptions {
  conversations: ObserverConversations;
  settings: ModelSettings;
  configured: boolean;
  submissionRetention?: SubmissionRetention;
  projectDirectory?: string;
  assetsDirectory?: string;
}

/** Assemble transport around an initialized world. Importing this module never starts a listener. */
export function createObserverServer(options: ObserverServerOptions) {
  const { conversations, configured } = options;
  const settings = validateSettings(options.settings);
  const project = options.projectDirectory ?? fileURLToPath(new URL('../../../../', import.meta.url));
  const assets = options.assetsDirectory ?? resolve(project, 'apps/observer/dist');
  const feeds = new Map<string, ObservationFeed>();
  function feedFor(id: string): ObservationFeed {
    const current = feeds.get(id);
    if (current) return current;
    const feed = new ObservationFeed(conversations.open(id));
    feeds.set(id, feed);
    return feed;
  }
  const submissions = createSubmissionStore({ ...options.submissionRetention, admission });
  const transcriptConnections = new Set<() => void>();
  const server = createServer((req, res) => {
    void handle(req, res).catch((error) => {
      const body: ErrorResponse = error instanceof RuntimeError || error instanceof SourceIncomplete ? { error: error.message, code: error.code } : { error: '服务内部错误。', code: 'INTERNAL_ERROR' };
      if (res.headersSent) {
        if (!res.destroyed) res.destroy();
        return;
      }
      if (!res.destroyed) json(res, error instanceof RuntimeError ? (error.code === 'RUNTIME_BUSY' || error.code === 'SUBMISSION_EXISTS' ? 409 : error.code === 'SUBMISSION_CAPACITY' ? 503 : error.code === 'CONVERSATION_NOT_FOUND' || error.code === 'TRANSCRIPT_NOT_FOUND' ? 404 : 400) : 500, body);
    });
  });

  /** A current, non-reserving projection. Reading it never initializes or calls the provider. */
  function admission(conversationId: string): ConversationAdmission {
    const transcriptId = conversations.get(conversationId).transcriptId;
    const observer = conversations.peek(conversationId);
    if (conversations.persistence?.failure) return Object.freeze({ conversationId, transcriptId, status: 'unavailable', error: conversations.persistence.failure });
    if (!configured) return Object.freeze({ conversationId, transcriptId, status: 'unavailable', error: Object.freeze({ code: 'KEY_MISSING', message: '服务端尚未配置模型凭据；请配置并重启。' }) });
    const failure = conversations.model.failure;
    if (failure) return Object.freeze({ conversationId, transcriptId, status: 'unavailable', error: failure });
    return Object.freeze({ conversationId, transcriptId, status: observer?.runtime.running || observer?.interactions.cancelling || !submissions.available ? 'busy' : 'ready' });
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const address = server.address();
    const port = address && !isString(address) ? address.port : undefined;
    if (!new Set([`127.0.0.1:${port}`, `localhost:${port}`]).has(req.headers.host || '')) return json(res, 403, { error: '只接受本机请求。' } satisfies ErrorResponse);
    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    if (req.method === 'GET' && url.pathname === '/api/config') return json(res, 200, { ...settings, configured, ...(conversations.files ? { files: conversations.files.configuration } : {}) } satisfies ConfigurationResponse);
    if (req.method === 'GET' && url.pathname === '/api/conversations') return json(res, 200, conversations.list());
    const conversationPath = /^\/api\/conversations\/([a-zA-Z0-9_-]{1,128})$/.exec(url.pathname);
    if (req.method === 'GET' && conversationPath) return json(res, 200, conversations.get(conversationPath[1]!));
    const discoveryPath = /^\/api\/conversations\/([a-zA-Z0-9_-]{1,128})\/submission$/.exec(url.pathname);
    if (req.method === 'GET' && discoveryPath) {
      const conversation = conversations.get(discoveryPath[1]!);
      const active = submissions.active(conversation.id);
      return json(res, 200, { conversationId: conversation.id, transcriptId: conversation.transcriptId, ...(active ? { submission: active.baseline } : {}) } satisfies ConversationSubmissionDiscovery);
    }
    if (req.method === 'POST' && url.pathname === '/api/conversations') {
      if ((req.headers.origin && req.headers.origin !== url.origin) || !req.headers['content-type']?.startsWith('application/json')) return json(res, 403, { error: '需要同源 JSON 请求。' } satisfies ErrorResponse);
      const body = await readBody(req);
      if (!isObject(body) || Object.keys(body).length) throw new RuntimeError('INVALID_INPUT', '新建对话请求正文必须为空对象。');
      return json(res, 201, conversations.create());
    }
    const target = () => {
      const id = url.searchParams.get('conversationId');
      if (!id) throw new RuntimeError('INVALID_INPUT', '需要明确对话身份。');
      conversations.get(id);
      return id;
    };
    if (req.method === 'GET' && url.pathname === '/api/conversation/admission') return json(res, 200, admission(target()));
    if (req.method === 'GET' && (url.pathname === '/api/interactions' || url.pathname === '/api/interaction/observe')) {
      const observer = conversations.open(target());
      const callId = url.searchParams.get('callId');
      if (!callId) throw new RuntimeError('INVALID_INPUT', '需要明确调用身份。');
      if (url.pathname === '/api/interactions') return json(res, 200, callInteractionLinks(observer, callId));
      const id = url.searchParams.get('id');
      if (!id) throw new RuntimeError('INVALID_INPUT', '需要明确交互身份。');
      const write = observationWriter<InteractionUpdate>(res);
      // Validate the link and establish observation before committing HTTP success headers.
      const unsubscribe = observeCallInteraction(observer, callId, id, (frame) => {
        try {
          if (!res.headersSent) res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
          if (frame.type === 'error' || frame.value.result.kind !== 'pending') write.end(frame);
          else write(frame);
        } catch {
          res.destroy();
        }
      });
      res.on('close', unsubscribe);
      if (res.writableEnded || res.destroyed) unsubscribe();
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/observe') {
      const id = target();
      const observer = conversations.open(id);
      const feed = feedFor(id);
      observer.recordSource.assertComplete();
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
      const write = observationWriter(res);
      const unsubscribe = feed.connect((frame) => {
        if (res.destroyed) return;
        try {
          if (frame.type === 'error') {
            write.end(frame);
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
    if (req.method === 'GET' && url.pathname === '/api/memory') {
      const observer = conversations.open(target());
      observer.recordSource.assertComplete();
      return json(res, 200, observeMemory(observer.memories, observer.book));
    }
    if (req.method === 'GET' && url.pathname === '/api/executions') {
      const observer = conversations.open(target());
      observer.recordSource.assertComplete();
      return json(res, 200, observeOverview(observer));
    }
    if (req.method === 'GET' && (url.pathname === '/api/transcript' || url.pathname === '/api/transcript/observe')) {
      const id = url.searchParams.get('id');
      if (!id) throw new RuntimeError('INVALID_INPUT', '需要明确消息集合身份。');
      const observer = conversations.forTranscript(id);
      if (url.pathname === '/api/transcript') return json(res, 200, transcriptSnapshot(observer.transcript));
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
      const write = observationWriter(res);
      observer.consumer.flush();
      const unsubscribe = observer.transcripts.connect((frame) => {
        if (!res.destroyed) write(frame);
      });
      const close = () => {
        unsubscribe();
        transcriptConnections.delete(close);
      };
      transcriptConnections.add(close);
      res.on('close', close);
      res.flushHeaders();
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/execution') {
      const observer = conversations.open(target());
      observer.recordSource.assertComplete();
      const id = url.searchParams.get('id') || '';
      if (!(observer.book.get(id) instanceof ExecutionRecord)) return json(res, 404, { error: '未找到执行记录。' } satisfies ErrorResponse);
      const archive = executionArchive(observer.book, observer.recordingArchives, id);
      return json(res, 200, { ...ExecutionRecordHelper.snapshot(observer.recording.recorder, id), ...(archive ? { archive } : {}) });
    }
    if (req.method === 'GET' && url.pathname === '/api/source') {
      const path = url.searchParams.get('file') || '';
      if (!allowedSources.has(path)) return json(res, 404, { error: '未找到源码。' } satisfies ErrorResponse);
      return json(res, 200, { path, content: await readFile(resolve(project, path), 'utf8') } satisfies SourceResponse);
    }
    const submissionPath = /^\/api\/submissions\/([a-zA-Z0-9_-]{1,128})(\/follow|\/cancel)?$/.exec(url.pathname);
    if (req.method === 'GET' && submissionPath && submissionPath[2] !== '/cancel') {
      const submission = submissions.get(submissionPath[1]!);
      if (!submission) return json(res, 404, { code: 'SUBMISSION_UNAVAILABLE', error: '提交进展不可用；这不表示请求没有执行。' } satisfies ErrorResponse);
      if (submissionPath[2] === '/follow') return followSubmission(submission, res);
      return json(res, 200, submission.baseline);
    }
    if (req.method === 'POST' && submissionPath?.[2] === '/cancel') {
      if ((req.headers.origin && req.headers.origin !== url.origin) || !req.headers['content-type']?.startsWith('application/json')) return json(res, 403, { error: '需要同源 JSON 请求。' } satisfies ErrorResponse);
      const body = await readBody(req);
      if (!isObject(body) || Object.keys(body).length) throw new RuntimeError('INVALID_INPUT', '取消请求正文必须为空对象。');
      const submission = submissions.get(submissionPath[1]!);
      if (!submission) return json(res, 404, { code: 'SUBMISSION_UNAVAILABLE', error: '提交进展不可用；不能确认取消，也不表示请求没有执行。' } satisfies ErrorResponse);
      submission.requestCancellation();
      return json(res, 200, submission.baseline);
    }
    if (req.method === 'POST' && url.pathname === '/api/run') {
      if ((req.headers.origin && req.headers.origin !== url.origin) || !req.headers['content-type']?.startsWith('application/json')) return json(res, 403, { error: '需要同源 JSON 请求。' } satisfies ErrorResponse);
      const data = await readBody(req);
      if (!isObject(data) || typeof data.submissionId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(data.submissionId)) throw new RuntimeError('INVALID_INPUT', '无效提交身份。');
      if (typeof data.conversationId !== 'string') throw new RuntimeError('INVALID_INPUT', '需要明确对话身份。');
      const conversationId = conversations.get(data.conversationId).id;
      const currentAdmission = admission(conversationId);
      let submission: ConversationSubmission;
      try {
        submission = submissions.create(data.submissionId, conversationId);
      } catch (error) {
        if (!(error instanceof RuntimeError) || error.code !== 'SUBMISSION_CAPACITY') throw error;
        // This refusal has not run and occupies no retained slot. A lost response remains unknown.
        const refusal = new ConversationSubmission(data.submissionId, conversationId, { admission: () => admission(conversationId) });
        refusal.reject(error, { retry: 'admission' });
        return json(res, 503, refusal.baseline);
      }
      let runSettings: ModelSettings;
      try {
        if (!isObject(data.input)) throw new RuntimeError('INVALID_INPUT', '无效对话输入。');
        runSettings = validateSettings({ ...settings, ...(isUndefined(data.input.contextBudget) ? {} : { contextBudget: data.input.contextBudget }) });
      } catch (error) {
        submission.reject(error);
        return json(res, 400, submission.baseline);
      }
      if (currentAdmission.status === 'unavailable') {
        submission.reject(new RuntimeError(currentAdmission.error.code, currentAdmission.error.message), { retry: 'admission' });
        return json(res, 503, submission.baseline);
      }
      if (currentAdmission.status === 'busy') {
        submission.reject(new RuntimeError('RUNTIME_BUSY', '运行环境正忙，请稍后再提交。'), { retry: 'admission' });
        return json(res, 409, submission.baseline);
      }
      submission.start(async (signal) => {
        const observer = conversations.open(conversationId);
        try {
          return await observer.runtime.run(data.input, { settings: runSettings, progress: submission.progress, activity: submission.activity, fileProgress: submission.fileProgress, answerProgress: submission.answerProgress, signal });
        } catch (error) {
          // A can return pending before cancellation reaches its parent. Service cancellation
          // still waits for this owner's external cleanup, without extending the ended R call.
          if (isInvocationCancelled(error, signal)) await observer.interactions.settled({ owner: signal });
          throw error;
        }
      });
      // This controller only detaches the initial HTTP waiter; it is never passed to runtime.run.
      const waiting = new AbortController();
      const detachWaiting = () => waiting.abort();
      res.once('close', detachWaiting);
      let initial;
      try {
        initial = await submission.ready(waiting.signal);
      } finally {
        res.off('close', detachWaiting);
      }
      if (res.destroyed) return;
      if (initial.result?.status === 'rejected') return json(res, initial.result.error.code === 'RUNTIME_BUSY' ? 409 : 400, submission.baseline);
      followSubmission(submission, res);
      return;
    }
    if (req.method === 'GET') return serveAsset(res, assets, url.pathname);
    return json(res, 404, { error: 'Not found' } satisfies ErrorResponse);
  }
  server.on('close', () => {
    for (const feed of feeds.values()) feed.close();
    for (const close of [...transcriptConnections]) close();
  });
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
