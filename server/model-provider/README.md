# 模型 Provider

`@capix/model-provider` 是可以从 `.mjs` 直接导入的模型通信包。提供 Chat Completions 文本请求及可选 SSE 增量，已用于 DeepSeek 意图识别实验与对照服务的材料回答；不依赖 Runtime、资源、Interaction 或 Observer。

```js
import { ChatCompletionsProvider } from '@capix/model-provider';

const model = new ChatCompletionsProvider({
  endpoint: 'https://api.deepseek.com/chat/completions',
  apiKey: process.env.DEEPSEEK_API_KEY,
  model: process.env.DEEPSEEK_MODEL || 'deepseek-flash',
  thinking: 'disabled',
});
const reply = await model.complete({
  messages: [{ role: 'user', content: '把 hello 翻译为中文。' }],
  maxTokens: 512,
});
if (reply.finishReason !== 'stop') throw new Error('模型未正常完成');
console.log(reply.text);
```

运行前在仓库执行 `pnpm build`。包不读取环境文件；配置由宿主传入。只有宿主显式执行以上调用才访问真实模型。

## 增量与最终回复

```js
const reply = await model.complete({ messages: [{ role: 'user', content: '把 hello 翻译为中文。' }], stream: true }, { signal, emit: (delta) => process.stdout.write(delta) });
// 已展示增量不证明完整回复能够被业务接纳。
if (reply.finishReason !== 'stop') throw new Error('模型未正常完成');
console.log(reply.text);
```

`stream` 默认 false，显式 true 才改变传输方式；提供 emit 不会自动开启流式。未提供 emit 时，流式请求仍完整读取并返回 ModelReply。emit 是本次请求内的同步正文增量入口，不提供回放或持久订阅。回调抛错停止消费并保留原错误身份；回调不能返回 Promise。

流式请求携带 `stream_options.include_usage`。读取器按 SSE 事件解析，支持分片 UTF-8、换行、注释和多行 data；只发布单一 choice 的正文 content，不发布 reasoning_content。完成需要准确的回复身份、finish_reason 与 `[DONE]`；截断不转换成成功，也不会退回非流式重新发送。usage 可以位于最后一个 choice，也可以来自末尾独立的 usage 片段。

流式 ModelReply.text 由正文增量顺序累积；length 等结束原因及空正文继续交给业务决定。有限读取覆盖整条传输的实际字节（含事件封装和非正文数据），不在每个片段重置预算或总超时。

JSON 与 SSE 的 `usage` 使用相同接纳规则，返回 `promptTokens / completionTokens / totalTokens`。DeepSeek 报告的 `prompt_cache_hit_tokens / prompt_cache_miss_tokens` 分别保留为可选 `promptCacheHitTokens / promptCacheMissTokens`；未报告时字段缺失，不能按零或全未命中统计。计数必须为非负安全整数，单项缓存计数不得超过 promptTokens；两项都报告时其和必须等于 promptTokens。当前不从其他厂商字段推导缓存数据，也不根据历史或重复请求估算命中。服务的交互及 CP 反馈可保留这些可选字段，既有无缓存计数反馈仍合法。缓存机制参考 [DeepSeek 上下文缓存](https://api-docs.deepseek.com/zh-cn/guides/kv_cache/)。

## 边界

- Provider 固定 endpoint/model/key/超时等配置，每次 `complete` 发起一次请求，无自动重试。它不持有会话、消息实体或交互引用。
- 返回 `text / finishReason / usage`，保留空文本和非 `stop` 结束。业务负责是否接纳、JSON 格式及意图契约；JSON 输出模式不能代替业务检查。
- 请求消息支持 system/user/assistant 文本。这是模型传输协议，不扩展正式 Transcript 的消息角色。提示词、历史、记忆和 Skill 如何组织由调用方决定。
- 总超时默认 60 秒，覆盖请求与响应读取；默认最多读取 2 MiB 响应，超限明确失败。显式 signal 取消保持原 reason；不会伪装为业务成功或重发请求。
- ProviderError 仅包含 code/message/可选 HTTP status，不保留上游错误正文、请求、headers 或底层异常。可注入 fetch 用于离线验证；自定义实现需遵守 Fetch 的取消语义。
- `thinking` 是明确可选的 DeepSeek 扩展；不向其他端点默认发送。其他兼容服务需要验证其协议，当前不承诺工具调用、多模态或所有厂商 SDK 的等效适配。

这是独立包的起点，Observer 既有业务 Provider 与流式链路保持现状。未来共享传输应另做等效迁移，不能把实验完成当成生产替换。

协议依据：[Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/)、[JSON Output](https://api-docs.deepseek.com/guides/json_mode/)、[SSE 事件解析](https://html.spec.whatwg.org/multipage/server-sent-events.html#event-stream-interpretation)。示例入口见 [意图识别实验](../../examples/intent/README.md)与[材料回答及记忆维护](../../examples/conversation-memory.mjs)。
