import { isArray, isFinite } from 'es-toolkit/compat';
import { isString } from 'es-toolkit/predicate';
import type { ModelOutput, ModelProvider, ModelRequest, Purpose } from '../conversation/model/types.js';
import { isObject, RuntimeError, InvocationCancelled } from '@capix/server-runtime';

export class DeepSeekProvider implements ModelProvider {
  constructor(
    private readonly key: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}
  async invoke(request: ModelRequest, _purpose: Purpose, signal: AbortSignal): Promise<ModelOutput> {
    if (!this.key) throw new RuntimeError('KEY_MISSING', '服务端尚未配置 DEEPSEEK_API_KEY；请填写 .env 并重启。');
    let response: Response;
    try {
      response = await this.fetcher('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.key}` },
        body: JSON.stringify(request),
        signal,
      });
    } catch (cause) {
      if (isAbortedRequest(cause, signal)) throw new InvocationCancelled(signal, { cause });
      throw new RuntimeError('NETWORK_ERROR', '无法连接 DeepSeek。', undefined, { cause });
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new RuntimeError(`HTTP_${response.status}`, `DeepSeek 返回 HTTP ${response.status}；未自动重试。`);
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch (cause) {
      if (isAbortedRequest(cause, signal)) throw new InvocationCancelled(signal, { cause });
      throw new RuntimeError('PROVIDER_ENVELOPE', 'DeepSeek HTTP 响应不是 JSON。', undefined, { cause });
    }
    if (!isObject(body) || !isArray(body.choices) || !isObject(body.choices[0])) throw new RuntimeError('PROVIDER_ENVELOPE', 'DeepSeek 响应缺少 choices。');
    const choice = body.choices[0];
    const message = isObject(choice.message) ? choice.message : {};
    const usage = isObject(body.usage) ? body.usage : null;
    return {
      id: isString(body.id) ? body.id : '',
      model: isString(body.model) ? body.model : request.model,
      content: isString(message.content) ? message.content : '',
      finishReason: isString(choice.finish_reason) ? choice.finish_reason : 'unknown',
      usage:
        usage && [usage.prompt_tokens, usage.completion_tokens, usage.total_tokens].every(isFinite)
          ? {
              promptTokens: usage.prompt_tokens as number,
              completionTokens: usage.completion_tokens as number,
              totalTokens: usage.total_tokens as number,
            }
          : null,
    };
  }
}

/** Fetch may reject with the supplied reason; body readers use a native AbortError. */
function isAbortedRequest(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted && (error === signal.reason || (error instanceof DOMException && error.name === 'AbortError'));
}
