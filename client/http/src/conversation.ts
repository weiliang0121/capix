import type { ConversationTransport, TranscriptTransport } from '@capix/client-runtime';
import type { ConversationUpdate, ConversationRequest, TranscriptFrame } from '@capix/protocol';
import { HttpTransport } from './transport.js';
import { HttpTransportError } from './errors.js';
import { acceptResponse, configurationResponse, transcriptResponse, transcriptUpdate, conversationUpdate, responseStatusError, parseLine, deliver } from './responses.js';
import { readLines } from './stream.js';

/** Conversation requests and delivery, independent of observation. */
export class ConversationHttpTransport extends HttpTransport implements ConversationTransport, TranscriptTransport {
  protected override statusError = responseStatusError;

  async config() {
    return acceptResponse(configurationResponse, await this.get('/api/config'), '配置');
  }
  async transcript(id?: string, signal?: AbortSignal) {
    const snapshot = acceptResponse(transcriptResponse, await this.get(`/api/transcript${id ? `?id=${encodeURIComponent(id)}` : ''}`, signal), '消息');
    if (id && snapshot.id !== id) throw new HttpTransportError('contract', '返回了不同的消息集合。', 'TRANSCRIPT_MISMATCH');
    return snapshot;
  }
  async observeTranscript(id: string | undefined, accept: (frame: TranscriptFrame) => void, signal: AbortSignal): Promise<void> {
    const response = await this.send(`/api/transcript/observe${id ? `?id=${encodeURIComponent(id)}` : ''}`, { signal });
    if (!response.body) throw new HttpTransportError('contract', '服务未返回消息流。', 'MISSING_STREAM');
    for await (const line of readLines(response.body)) {
      const frame = acceptResponse(transcriptUpdate, parseLine(line), '消息流');
      if (frame.type === 'error') throw new HttpTransportError('remote', frame.error, frame.code);
      deliver(() => accept(frame), '消息变化');
    }
    if (!signal.aborted) throw new HttpTransportError('contract', '消息同步连接已结束。', 'INCOMPLETE_STREAM');
  }
  async run(request: ConversationRequest, accept: (update: ConversationUpdate) => void, accepted: () => void): Promise<void> {
    const response = await this.post('/api/run', request);
    try {
      deliver(accepted, '接纳通知');
    } catch (error) {
      await response.body?.cancel().catch(() => undefined);
      throw error;
    }
    if (!response.body) throw new HttpTransportError('contract', '服务未返回对话流。', 'MISSING_STREAM');
    let contextId: string | undefined;
    let inputIndex: number | undefined;
    let transcriptId: string | undefined;
    let answered = false;
    let completed = false;
    for await (const line of readLines(response.body)) {
      if (completed) throw new HttpTransportError('contract', '处理结束后又返回了内容。', 'AFTER_TERMINAL');
      const update = acceptResponse(conversationUpdate, parseLine(line), '对话');
      if (update.type === 'error') throw new HttpTransportError('remote', update.error, update.code);
      if (update.type === 'started') {
        if (contextId) throw new HttpTransportError('contract', '重复的处理开始通知。', 'INVALID_UPDATE');
        contextId = update.contextId;
        inputIndex = update.inputIndex;
        transcriptId = update.transcriptId;
      } else {
        if (!contextId || update.contextId !== contextId) throw new HttpTransportError('contract', '对话处理身份不一致。', 'CONVERSATION_MISMATCH');
        if (update.type === 'answer') {
          if (update.transcriptId !== transcriptId) throw new HttpTransportError('contract', '回答消息集合与开始通知不一致。', 'TRANSCRIPT_MISMATCH');
          if (answered || update.index <= inputIndex!) throw new HttpTransportError('contract', '回答重复或消息位置无效。', 'INVALID_UPDATE');
          answered = true;
        } else {
          if (!answered) throw new HttpTransportError('contract', '处理结束但未交付回答。', 'MISSING_ANSWER');
          completed = true;
        }
      }
      deliver(() => accept(update), '对话内容');
    }
    if (!completed) throw new HttpTransportError('contract', '对话流提前结束，尚未获得处理结果。', 'INCOMPLETE_STREAM');
  }
}
