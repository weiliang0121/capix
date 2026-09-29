import type { ConversationTransport } from '@capix-observer/client-runtime';
import type { ConversationUpdate, ExecutionRequest } from '@capix-observer/protocol';
import { HttpTransport } from './transport.js';
import { ObserverTransportError } from './errors.js';
import { acceptResponse, configurationResponse, transcriptResponse, conversationUpdate, responseStatusError, parseLine, deliver } from './responses.js';
import { readLines } from './stream.js';

/** Conversation requests and delivery, independent of observation. */
export class ConversationHttpTransport extends HttpTransport implements ConversationTransport {
  protected override statusError = responseStatusError;

  async config() {
    return acceptResponse(configurationResponse, await this.get('/api/config'), '配置');
  }
  async transcript() {
    return acceptResponse(transcriptResponse, await this.get('/api/transcript'), '消息');
  }
  async run(request: ExecutionRequest, accept: (update: ConversationUpdate) => void, accepted: () => void): Promise<void> {
    const response = await this.post('/api/run', request);
    try {
      deliver(accepted, '接纳通知');
    } catch (error) {
      await response.body?.cancel().catch(() => undefined);
      throw error;
    }
    if (!response.body) throw new ObserverTransportError('contract', '服务未返回对话流。', 'MISSING_STREAM');
    let contextId: string | undefined;
    let inputIndex: number | undefined;
    let answered = false;
    let completed = false;
    for await (const line of readLines(response.body)) {
      if (completed) throw new ObserverTransportError('contract', '处理结束后又返回了内容。', 'AFTER_TERMINAL');
      const update = acceptResponse(conversationUpdate, parseLine(line), '对话');
      if (update.type === 'error') throw new ObserverTransportError('remote', update.error, update.code);
      if (update.type === 'started') {
        if (contextId) throw new ObserverTransportError('contract', '重复的处理开始通知。', 'INVALID_UPDATE');
        contextId = update.contextId;
        inputIndex = update.inputIndex;
      } else {
        if (!contextId || update.contextId !== contextId) throw new ObserverTransportError('contract', '对话处理身份不一致。', 'CONVERSATION_MISMATCH');
        if (update.type === 'answer') {
          if (answered || update.index !== inputIndex! + 1) throw new ObserverTransportError('contract', '回答重复或消息位置无效。', 'INVALID_UPDATE');
          answered = true;
        } else {
          if (!answered) throw new ObserverTransportError('contract', '处理结束但未交付回答。', 'MISSING_ANSWER');
          completed = true;
        }
      }
      deliver(() => accept(update), '对话内容');
    }
    if (!completed) throw new ObserverTransportError('contract', '对话流提前结束，尚未获得处理结果。', 'INCOMPLETE_STREAM');
  }
}
