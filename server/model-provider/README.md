# 模型 Provider

`@capix/model-provider` 提供 Chat Completions 文本与原生函数调用、可选 SSE，以及唯一的 `ModelReply` 纯值契约。可以从 `.mjs` 使用，不依赖 Runtime、资源、Interaction 或服务。Provider 负责通信和协议接纳；工具选择、参数业务校验、执行、接纳与恢复由调用方组织。

```js
import { ChatCompletionsProvider, modelReplyText } from '@capix/model-provider';

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
if (reply.termination.reason !== 'stop') throw new Error('模型未正常完成');
console.log(modelReplyText(reply));
```

通过 `npm install @capix/model-provider` 安装后可直接运行；仅在本仓库从源码使用时需要先执行 `pnpm build`。配置由宿主传入，包不读取环境文件。只有显式执行真实请求才会访问模型。

## 唯一回复材料

```ts
interface ModelReply {
  formatVersion: 1;
  id: string;
  model: string;
  output: readonly ({ kind: 'text'; text: string } | { kind: 'tool-call'; id: string; name: string; arguments: { encoding: 'json-text'; text: string } })[];
  termination: {
    kind: 'completed' | 'incomplete' | 'refused';
    reason: string;
  };
  usage: ModelUsage | null;
  native: {
    format: 'chat-completions';
    version: 1;
    reasoningContent?: string;
  };
}
```

共同字段保存正文、工具调用、结束原因和用量；`native` 只保存共同字段表达不了的思考文本。`format` 描述协议，不充当厂商身份。Provider 从这份材料编码下一次请求，没有可分别修改的第二份 continuation。工具参数保留原始 JSON 字符串，即使字符串不能被 JSON 解析也不会擅自修复；是否注册、参数是否合法由工具调用方判断。

`stop` 与 `tool_calls` 映射为 `completed`，`content_filter` 为 `refused`，其他原因（包括未知新值）保留原文并映射为 `incomplete`。`completed` 表示协议结束，并不表示业务已完成。`modelReplyText(reply)` 拒绝含工具调用的回复；它不代替业务检查 `stop`、拒绝状态或非空正文。

公开 `requireModelReply`、`requireModelRequest`、`requireToolResult`、`requireToolFeedback` 和 `requireModelExchange` 对未知值作完整校验，返回原对象身份，不克隆、不冻结，也不缓存对可变对象的信任。适用于资源、Interaction、实体与 CP 的接纳边界。校验拒绝旧双字段形状、未知字段/版本、重复 ID、不完整反馈、getter、Proxy、循环引用与非 JSON 值；错误不包含传入正文。Provider 自己生成的回复已深冻结。旧 `text/finishReason` 双字段回复不是新协议的有效持久值，不能自动迁移后冒充已认证反馈。

## 原生工具与续接

```js
const tools = [
  {
    name: 'read_file',
    description: '读取一个已授权文件。',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false,
    },
  },
];
const request = { messages: [{ role: 'user', content: '读取 notes.md。' }], tools };
const first = await model.complete(request);

// 业务负责核验结束状态、参数、权限与执行；此处只展示反馈契约。
const feedback = first.output
  .filter((item) => item.kind === 'tool-call')
  .map((call) => ({
    toolCallId: call.id,
    status: 'ok',
    content: [{ kind: 'text', text: '经授权工具读取的内容' }],
  }));
const next = await model.complete({
  ...request,
  exchanges: [{ reply: first, feedback }],
});
```

`messages` 是固定的 system/user/assistant 文本前缀，`exchanges` 按顺序附加完整的模型交换。每个交换必须有准确且完整的反馈集合；Provider 按模型原调用顺序编码 `assistant.tool_calls` 与 `tool.tool_call_id`，调用方反馈数组的排列不改变关联。`ToolResult` 为 `{status:'ok'|'error',content:[{kind:'text',text}]}`，`ToolFeedback` 另含 `toolCallId`；两种状态都编码为明确的 JSON 数据正文，不能靠措辞暗示失败。工具结果不会成为 system 消息，Provider 也不自动执行其中指令。结果的可信程度、提示策略与实际资源授权仍由宿主和业务确定。

`toolChoice` 可为 `auto`、`none`、`required` 或 `{name}`。指定名称必须已登记；除 `none` 外，显式选择要求有工具目录。参数 Schema 为纯 JSON 对象，原样转交，不在 Provider 内建立另一套业务 Schema 执行器。本实现每份目录/回复最多 32 个工具，工具名支持字母、数字、`_`、`-`，长度 1–128。

DeepSeek 思考模式在带 `tools` 的后续请求中要求回传此前回复的 `reasoning_content`，包括没有工具调用的回复。Provider 在 exchanges 中始终保留并编码该字段；不带 tools 时，是否使用由兼容端点决定。调用方不能用只有正文的普通 assistant 消息替代需要精确续接的思考回复。协议依据：[工具调用](https://api-docs.deepseek.com/guides/tool_calls/)、[思考模式](https://api-docs.deepseek.com/guides/thinking_mode/)。

## 流式与用量

```js
const reply = await model.complete({ messages: [{ role: 'user', content: '解释这份材料。' }], stream: true }, { signal, emit: (delta) => process.stdout.write(delta) });
```

`stream` 默认 false；单独提供 emit 不开启流式。emit 只同步交付正文预览，工具参数与思考文本不会被当作正文发布。未提供 emit 时仍完整消费。回调抛错保留原错误身份，回调返回 Promise 会被拒绝。预览不代表最终回复或业务接纳已成立。

SSE 按 `tool_calls[index]` 拼接名称与参数片段，保留 reasoning_content，终态与独立 usage 均支持。缺少 ID、重复 ID、索引缺口、超过 32 个调用、终态后继续 choice、重复 usage、缺少 finish_reason 或 `[DONE]` 均拒绝。`[DONE]` 结束协议后立即释放读取，不要求上游 HTTP 连接先关闭；不重发或退回非流式请求。原有 UTF-8 分片、SSE 换行/注释、多行 data、接收者失败、取消和总超时行为保持。

JSON 与 SSE 共用 `ModelUsage`：`promptTokens / completionTokens / totalTokens`，可选 `promptCacheHitTokens / promptCacheMissTokens` 原样保留。计数必须是非负安全整数，缓存单项不超过 promptTokens，两项都报告时其和须等于 promptTokens。缺失不估算为零；不把其他厂商的缓存字段自动映射成 DeepSeek 计数。

## 容量与范围

`ChatCompletionsProvider.inspectRequest(request)` 同步完成请求预检，返回冻结的 `{requestBytes, wireBytes}`：前者是共同请求完整 JSON 的 UTF-8 字节数，后者是实际 HTTP 正文字节数，包括固定的 model/thinking 配置、工具目录、交换编码和流式字段。它与 `complete` 共用校验和编码路径，能够计算 Unicode、转义字符以及工具反馈嵌套 JSON 带来的真实大小；不发请求、不读取网络，也不返回正文、headers 或密钥。

`ModelProvider` 上此端口可选，依赖精确发送预算的宿主应在装配时要求它存在。无效或超出共同请求／HTTP 正文 2 MiB 限额时，预检与 `complete` 一样抛出 `ProviderError('REQUEST')`。预检不冻结输入、不预留额度，也不保证模型上下文 token 容量；实际发送仍重新校验当前请求，修改过输入后必须以本次检查为准。

- 公开请求、回复、反馈、交换值均限制为 2 MiB 的纯 JSON，深度最多 64、值数最多 100,000。请求编码后的 HTTP 正文也受 2 MiB 限制。合法的单项不代表任意累计历史都能继续装入请求。
- 默认总超时 60 秒，涵盖发送与完整读取。`maxResponseBytes` 是独立的实际传输预算，默认 2 MiB，SSE 计入事件封装、注释和思考内容；提高传输预算不会放宽公开回复的纯值上限。
- 一次 complete 只有一次 HTTP 请求，无隐式重试。调用取消保持原 reason，不修改调用者 signal；对独立 Interaction 的生命周期不作推断。
- `ProviderError` 只含 code/message/可选 HTTP status，不保存上游正文、请求、headers、密钥或底层错误。宿主可注入 fetch；实现必须遵守 Fetch 取消与重定向语义。
- `thinking` 是宿主显式配置的 DeepSeek 扩展。当前实现 Chat Completions 函数调用与文本；不承诺 Responses、Anthropic 原生协议、MCP、多模态或 strict beta。正式 Transcript 的消息角色不因此扩展。

仓库中的原生工具方案与离线验证记录保留设计和早期契约推演，不包含在此 npm 包中。完整协议参考 [Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/) 与 [SSE 标准](https://html.spec.whatwg.org/multipage/server-sent-events.html#event-stream-interpretation)。
