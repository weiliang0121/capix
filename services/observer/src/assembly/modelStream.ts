import { RuntimeError } from '@capix/contracts';
import { isObject } from '@capix/server-runtime';
import { type ProgressChannel } from '@capix/changes';
import type { ModelOutput, ModelTextDelta } from '../conversation/model/types.js';
import { modelTextByteLimit } from '../conversation/model/stream.js';

const maximumWireBytes = 16 * 1024 * 1024;
const maximumEventLength = 1024 * 1024;

/** Decode the provider's SSE transport; business output interpretation stays in the declaration. */
export async function receiveModelStream(body: ReadableStream<Uint8Array>, signal: AbortSignal, progress?: ProgressChannel<ModelTextDelta>): Promise<ModelOutput> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const output = new StreamOutput(progress);
  const events = new StreamEvents((data) => output.receive(data));
  let wireBytes = 0;
  let ended = false;
  const cancel = () => {
    void reader.cancel(signal.reason).catch(() => undefined);
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    while (!ended && !output.done) {
      signal.throwIfAborted();
      const next = await reader.read();
      signal.throwIfAborted();
      ended = next.done;
      if (next.value) {
        wireBytes += next.value.byteLength;
        if (wireBytes > maximumWireBytes) throw limitError();
        events.receive(decoder.decode(next.value, { stream: true }));
      }
      if (ended) events.receive(decoder.decode());
    }
    return output.result();
  } finally {
    signal.removeEventListener('abort', cancel);
    if (!ended) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** SSE records may span chunks and use CRLF, LF, or CR line endings. */
class StreamEvents {
  private line = '';
  private data: string[] = [];
  private length = 0;
  private skipLF = false;

  constructor(private readonly accept: (data: string) => void) {}

  receive(text: string): void {
    let start = 0;
    if (this.skipLF && text.startsWith('\n')) start = 1;
    this.skipLF = false;
    const endings = /[\r\n]/g;
    endings.lastIndex = start;
    let match = endings.exec(text);
    while (match) {
      this.append(text.slice(start, match.index));
      this.finishLine();
      start = match.index + 1;
      if (match[0] === '\r') {
        if (text[start] === '\n') start += 1;
        else if (start === text.length) this.skipLF = true;
      }
      endings.lastIndex = start;
      match = endings.exec(text);
    }
    this.append(text.slice(start));
  }

  private append(text: string): void {
    this.length += text.length;
    if (this.length > maximumEventLength) throw limitError();
    this.line += text;
  }

  private finishLine(): void {
    if (!this.line) {
      if (this.data.length) this.accept(this.data.join('\n'));
      this.data = [];
      this.length = 0;
    } else if (this.line === 'data') {
      this.data.push('');
    } else if (this.line.startsWith('data:')) {
      const value = this.line.slice(5);
      this.data.push(value.startsWith(' ') ? value.slice(1) : value);
    }
    this.line = '';
  }
}

class StreamOutput {
  private id: string | undefined;
  private model: string | undefined;
  private readonly content: string[] = [];
  private contentBytes = 0;
  private finishReason: string | undefined;
  private usage: ModelOutput['usage'] = null;
  private completed = false;

  constructor(private readonly progress?: ProgressChannel<ModelTextDelta>) {}

  get done(): boolean {
    return this.completed;
  }

  receive(data: string): void {
    if (this.completed) return;
    if (data.trim() === '[DONE]') {
      if (!this.finishReason) throw new RuntimeError('PROVIDER_STREAM_INCOMPLETE', '模型流结束，但没有收到完成原因。');
      this.completed = true;
      return;
    }
    let chunk: unknown;
    try {
      chunk = JSON.parse(data);
    } catch (cause) {
      throw new RuntimeError('PROVIDER_ENVELOPE', '模型流片段不是 JSON。', undefined, { cause });
    }
    if (!isObject(chunk) || typeof chunk.id !== 'string' || !chunk.id || typeof chunk.model !== 'string' || !chunk.model || !Array.isArray(chunk.choices) || chunk.choices.length > 1) throw envelopeError();
    if ((this.id !== undefined && this.id !== chunk.id) || (this.model !== undefined && this.model !== chunk.model)) throw new RuntimeError('PROVIDER_STREAM_IDENTITY', '模型流片段的身份不一致。');
    this.id = chunk.id;
    this.model = chunk.model;
    if (chunk.usage !== undefined && chunk.usage !== null) {
      if (!isObject(chunk.usage)) throw envelopeError();
      const usage = chunk.usage;
      if (![usage.prompt_tokens, usage.completion_tokens, usage.total_tokens].every((value) => Number.isSafeInteger(value) && (value as number) >= 0)) throw envelopeError();
      this.usage = { promptTokens: usage.prompt_tokens as number, completionTokens: usage.completion_tokens as number, totalTokens: usage.total_tokens as number };
    }
    const choice: unknown = chunk.choices[0];
    if (choice === undefined) {
      if (!this.finishReason || chunk.usage === undefined || chunk.usage === null) throw envelopeError();
      return;
    }
    if (!isObject(choice) || choice.index !== 0 || !isObject(choice.delta) || (choice.finish_reason !== null && typeof choice.finish_reason !== 'string')) throw envelopeError();
    const text = choice.delta.content;
    if (text !== undefined && text !== null && typeof text !== 'string') throw envelopeError();
    if (this.finishReason !== undefined) {
      if (text || (choice.finish_reason !== null && choice.finish_reason !== this.finishReason)) throw envelopeError();
      return;
    }
    if (typeof text === 'string' && text) {
      this.contentBytes += Buffer.byteLength(text, 'utf8');
      if (this.contentBytes > modelTextByteLimit) throw limitError();
      this.content.push(text);
      this.progress?.publish(Object.freeze({ text }));
    }
    if (typeof choice.finish_reason === 'string') {
      if (!choice.finish_reason) throw envelopeError();
      this.finishReason = choice.finish_reason;
    }
  }

  result(): ModelOutput {
    if (!this.completed || !this.finishReason || !this.id || !this.model) throw new RuntimeError('PROVIDER_STREAM_INCOMPLETE', '模型流在完整结束标记之前中断；未接纳部分结果。');
    return { id: this.id, model: this.model, content: this.content.join(''), finishReason: this.finishReason, usage: this.usage };
  }
}

function envelopeError(): RuntimeError {
  return new RuntimeError('PROVIDER_ENVELOPE', '模型流片段结构不符合约定。');
}

function limitError(): RuntimeError {
  return new RuntimeError('PROVIDER_STREAM_LIMIT', '模型流超过本地接收容量。');
}
