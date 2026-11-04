import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Transcript } from '@capix/transcript';
import type { ConversationCallDetail, ConversationInspection, ConversationRecordingState, ConversationServiceInfo, ConversationSubmissionFrame, TranscriptFrame, ConversationRecoverySummary, ConversationRecoveryActivity } from '@capix/protocol';
import { ConversationEvents } from './events.js';
import { ConversationHttpError, ConversationSubmissions, type ConversationRunner } from './submission.js';
import { streamFrames } from './stream.js';

export interface ConversationServerOptions {
  readonly runner: ConversationRunner;
  readonly transcript: Transcript;
  readonly events: ConversationEvents;
  readonly mode: 'demo' | 'live';
  readonly model: string;
  readonly assertAvailable?: () => void;
  readonly inspect: () => ConversationInspection;
  readonly call: (id: string) => ConversationCallDetail | undefined;
  readonly assetsDirectory?: string;
  readonly submissionRetention?: number;
  readonly previewBytes?: number;
  readonly recording?: {
    state(): ConversationRecordingState;
    start(): ConversationRecordingState;
    stop(): ConversationRecordingState;
    clear(): ConversationRecordingState;
  };
  readonly recovery?: {
    list(): readonly ConversationRecoverySummary[];
    check(contextId: string): ReturnType<Parameters<ConversationSubmissions['resume']>[2]>;
    activity(): ConversationRecoveryActivity;
  };
}

/** HTTP owns connections and submissions. The injected Runner owns execution and the host owns entities. */
export function createConversationServer(options: ConversationServerOptions) {
  if (options.events.transcript !== options.transcript) throw new TypeError('Conversation HTTP sources must share the same Transcript');
  if (options.submissionRetention !== undefined && (!Number.isSafeInteger(options.submissionRetention) || options.submissionRetention < 1 || options.submissionRetention > 128)) throw new RangeError('Invalid submission retention');
  if (options.previewBytes !== undefined && (!Number.isSafeInteger(options.previewBytes) || options.previewBytes < 1 || options.previewBytes > 512 * 1024)) throw new RangeError('Invalid preview capacity');
  const submissions = new ConversationSubmissions(options.runner, options.events, options.assertAvailable, options.submissionRetention, options.previewBytes);
  const connections = new Set<ServerResponse>();
  const assets = options.assetsDirectory ?? fileURLToPath(new URL('../../../../apps/observer/dist', import.meta.url));
  const server = createServer((request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    connections.add(response);
    response.once('close', () => connections.delete(response));
    void handle(request, response).catch((error) => {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      if (response.destroyed) return;
      const known = error instanceof ConversationHttpError;
      json(response, known ? error.status : 500, { code: known ? error.code : 'INTERNAL_ERROR', error: known ? error.message : '服务处理失败。' });
    });
  });

  function session(): ConversationServiceInfo {
    const active = submissions.active;
    return { conversationId: submissions.conversationId, transcriptId: options.transcript.id, mode: options.mode, model: options.model, admission: submissions.admission(), ...(active ? { active } : {}) };
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const address = server.address();
    const port = address && typeof address !== 'string' ? address.port : undefined;
    if (!new Set([`127.0.0.1:${port}`, `localhost:${port}`]).has(request.headers.host ?? '')) throw new ConversationHttpError('INVALID_HOST', '仅接受本机请求。', 403);
    const url = new URL(request.url ?? '/', `http://${request.headers.host}`);
    if (request.method === 'POST' && (request.headers.origin !== url.origin || !request.headers['content-type']?.startsWith('application/json'))) throw new ConversationHttpError('INVALID_ORIGIN', '需要同源 JSON 请求。', 403);
    if (request.method === 'GET' && url.pathname === '/api/session') return json(response, 200, session());
    if (request.method === 'GET' && url.pathname === '/api/conversation/admission') {
      if (url.searchParams.get('conversationId') !== submissions.conversationId) throw new ConversationHttpError('CONVERSATION_NOT_FOUND', '对话不存在。', 404);
      return json(response, 200, submissions.admission());
    }
    if (request.method === 'GET' && (url.pathname === '/api/transcript' || url.pathname === '/api/transcript/observe')) {
      if (url.searchParams.get('id') !== options.transcript.id) throw new ConversationHttpError('TRANSCRIPT_NOT_FOUND', '消息集合不存在。', 404);
      if (!options.events.available) throw new ConversationHttpError('SOURCE_INCOMPLETE', '消息同步来源不完整。', 409);
      if (url.pathname === '/api/transcript') return json(response, 200, options.events.snapshot());
      const stop = streamFrames<TranscriptFrame>(response, (receive) => options.events.connect(receive), undefined);
      const detach = options.events.failed(stop);
      response.once('close', detach);
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/inspection') return json(response, 200, options.inspect());
    if (request.method === 'GET' && url.pathname === '/api/recording') {
      if (!options.recording) throw new ConversationHttpError('RECORDING_UNAVAILABLE', '当前服务未安装记录控制。', 409);
      return json(response, 200, options.recording.state());
    }
    const recordingPath = /^\/api\/recording\/(start|stop|clear)$/.exec(url.pathname);
    if (request.method === 'POST' && recordingPath) {
      const body = await readBody(request);
      const action = recordingPath[1];
      if (!object(body) || (action === 'start' ? Object.keys(body).length !== 0 : Object.keys(body).length !== 1 || typeof body.recorderId !== 'string' || !body.recorderId)) throw new ConversationHttpError('INVALID_INPUT', action === 'start' ? '开始记录请求必须为空对象。' : '需要当前采集的准确身份。');
      const recording = options.recording;
      if (!recording) throw new ConversationHttpError('RECORDING_UNAVAILABLE', '当前服务未安装记录控制。', 409);
      const state = recording.state();
      if (action !== 'start' && state.recorderId !== body.recorderId) throw new ConversationHttpError('RECORDING_CONFLICT', '采集已变化，请刷新后操作当前记录。', 409);
      if (action === 'start' && (state.status === 'stopping' || state.status === 'stopped')) throw new ConversationHttpError('RECORDING_CONFLICT', state.status === 'stopping' ? '请等待已纳入的调用完成记录。' : '请先清空上一次采集，再开始新记录。', 409);
      if (action === 'clear' && (state.status === 'recording' || state.status === 'stopping')) throw new ConversationHttpError('RECORDING_CONFLICT', '请先停止记录，并等待已纳入的调用收尾。', 409);
      // This synchronous check and action only control capture; neither starts nor cancels execution.
      return json(response, 200, action === 'start' ? recording.start() : action === 'stop' ? recording.stop() : recording.clear());
    }
    if (request.method === 'GET' && url.pathname === '/api/recoveries') {
      if (!options.recovery) return json(response, 200, []);
      // Discovery is a deliberate idle-host read, not a live execution probe.
      // Check admission before decoding checkpoint heads; busy is not an empty list.
      const admission = submissions.admission();
      if (admission.status === 'busy') throw new ConversationHttpError('RUNTIME_BUSY', '当前对话正在处理，暂不能检查可恢复处理。', 409);
      if (admission.status === 'unavailable') throw new ConversationHttpError(admission.error.code, admission.error.message, 503);
      return json(response, 200, options.recovery.list());
    }
    if (request.method === 'GET' && url.pathname === '/api/recovery-activity') return json(response, 200, options.recovery?.activity() ?? { complete: true, events: [] });
    if (request.method === 'POST' && url.pathname === '/api/resume') {
      const recovery = options.recovery;
      if (!recovery) throw new ConversationHttpError('RECOVERY_UNAVAILABLE', '当前服务未启用恢复。', 409);
      const { id, contextId } = acceptRecovery(await readBody(request), submissions.conversationId);
      const submission = submissions.resume(id, contextId, () => {
        try {
          return recovery.check(contextId);
        } catch (error) {
          // Eligibility errors carry no request, credential or saved body.
          if (error instanceof Error && Reflect.get(error, 'code') === 'CHECKPOINT_CONTENT_CHANGED') throw new ConversationHttpError('RECOVERY_UNAVAILABLE', error.message, 409);
          throw error;
        }
      });
      follow(response, submission);
      return;
    }
    const callPath = /^\/api\/calls\/([a-zA-Z0-9_-]{1,128})$/.exec(url.pathname);
    if (request.method === 'GET' && callPath) {
      const detail = options.call(callPath[1]!);
      if (!detail) throw new ConversationHttpError('CALL_NOT_FOUND', '本进程中没有这条调用记录。', 404);
      return json(response, 200, detail);
    }
    if (request.method === 'POST' && url.pathname === '/api/run') {
      const { id, input } = acceptSubmission(await readBody(request), submissions.conversationId);
      const submission = submissions.submit(id, input);
      follow(response, submission);
      return;
    }
    const submissionPath = /^\/api\/submissions\/([a-zA-Z0-9_-]{1,128})(?:\/(follow|cancel))?$/.exec(url.pathname);
    if (submissionPath) {
      const id = submissionPath[1]!;
      const action = submissionPath[2];
      if (request.method === 'GET' && action === undefined) return json(response, 200, submissions.read(id).baseline);
      if (request.method === 'GET' && action === 'follow') {
        follow(response, submissions.read(id));
        return;
      }
      if (request.method === 'POST' && action === 'cancel') {
        const body = await readBody(request);
        if (!object(body) || Object.keys(body).length) throw new ConversationHttpError('INVALID_INPUT', '取消请求必须为空对象。');
        return json(response, 200, submissions.cancel(id).baseline);
      }
    }
    if (request.method !== 'GET' || url.pathname.startsWith('/api/')) throw new ConversationHttpError('NOT_FOUND', '接口不存在。', 404);
    const path = url.pathname === '/' || url.pathname === '/conversation.html' ? 'conversation.html' : url.pathname.startsWith('/assets/') ? decodeURIComponent(url.pathname.slice(1)) : '';
    const file = resolve(assets, path);
    if (!path || !file.startsWith(resolve(assets) + sep)) throw new ConversationHttpError('NOT_FOUND', '页面不存在。', 404);
    let bytes: Buffer;
    try {
      bytes = await readFile(file);
    } catch {
      throw new ConversationHttpError('ASSET_NOT_FOUND', '界面尚未构建，请先运行 pnpm build。', 404);
    }
    const type = ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' } as Record<string, string>)[extname(file)];
    if (!type) throw new ConversationHttpError('NOT_FOUND', '页面不存在。', 404);
    response.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` });
    response.end(bytes);
  }

  function follow(response: ServerResponse, submission: ReturnType<ConversationSubmissions['read']>): void {
    streamFrames<ConversationSubmissionFrame>(
      response,
      (receive) => submission.connect(receive),
      () => submission.baseline,
      (frame) => {
        const state = frame.type === 'baseline' ? frame.submission : frame.type === 'submission' ? frame.change : undefined;
        return Boolean(state?.result || state?.integrity?.status === 'incomplete');
      },
    );
  }

  return {
    server,
    stop: () => submissions.stop(),
    settled: () => submissions.settled(),
    close() {
      submissions.close();
      options.events.close();
      for (const connection of connections) connection.destroy();
      connections.clear();
      server.closeAllConnections();
    },
  };
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function acceptSubmission(body: unknown, conversationId: string): { id: string; input: string } {
  if (!object(body) || Object.keys(body).some((key) => !['conversationId', 'submissionId', 'input'].includes(key)) || body.conversationId !== conversationId || typeof body.submissionId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(body.submissionId) || !object(body.input) || Object.keys(body.input).some((key) => key !== 'messages') || !Array.isArray(body.input.messages) || body.input.messages.length !== 1) throw new ConversationHttpError('INVALID_INPUT', '需要当前对话身份、提交身份和一条用户消息；此入口不支持配置或文件任务。');
  const message: unknown = body.input.messages[0];
  if (!object(message) || Object.keys(message).some((key) => !['role', 'content'].includes(key)) || message.role !== 'user' || typeof message.content !== 'string' || !message.content.trim()) throw new ConversationHttpError('INVALID_INPUT', '输入必须是一条非空用户消息。');
  return { id: body.submissionId, input: message.content };
}
function acceptRecovery(body: unknown, conversationId: string): { id: string; contextId: string } {
  if (!object(body) || Object.keys(body).some((key) => !['conversationId', 'submissionId', 'contextId'].includes(key)) || body.conversationId !== conversationId || typeof body.submissionId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(body.submissionId) || typeof body.contextId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(body.contextId)) throw new ConversationHttpError('INVALID_INPUT', '需要当前对话身份、新提交身份和准确的 checkpoint 调用身份。');
  return { id: body.submissionId, contextId: body.contextId };
}
async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += part.length;
    if (bytes > 128 * 1024) throw new ConversationHttpError('INPUT_TOO_LARGE', '请求超过128 KiB。', 413);
    chunks.push(part);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ConversationHttpError('INVALID_JSON', '请求不是有效 JSON。');
  }
}
