# @weiliang0121/capix-model-provider

本包通过 Chat Completions 发送文本、固定图片和原生函数调用请求，将普通响应与 SSE 响应接纳为同一份 ModelReply。

## 安装与入口

运行环境为 Node.js `>=22.23.2`。包使用 ESM，附带 TypeScript 类型声明。

```sh
npm install @weiliang0121/capix-model-provider
```

- `@weiliang0121/capix-model-provider` 提供 `ChatCompletionsProvider`、请求与回复校验、工具协议及传输错误类型。

## 用法

```js
import { ChatCompletionsProvider, modelReplyText } from '@weiliang0121/capix-model-provider';

const model = new ChatCompletionsProvider({
  endpoint: 'https://api.deepseek.com/chat/completions',
  apiKey: process.env.DEEPSEEK_API_KEY,
  model: process.env.DEEPSEEK_MODEL,
  thinking: 'disabled',
});
const reply = await model.complete({
  messages: [{ role: 'user', content: '把 hello 翻译为中文。' }],
  maxTokens: 512,
});
if (reply.termination.reason !== 'stop') throw new Error('模型未正常完成');
console.log(modelReplyText(reply));
```

运行示例前设置 `DEEPSEEK_API_KEY` 和账户可用的模型名 `DEEPSEEK_MODEL`。执行 `complete` 时会访问模型服务。

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

`messages` 是固定的 system/user/assistant 前缀，`exchanges` 按顺序附加完整的模型交换。每个交换必须有准确且完整的反馈集合；Provider 按模型原调用顺序编码 `assistant.tool_calls` 与 `tool.tool_call_id`，调用方反馈数组的排列不改变关联。`ToolResult` 为 `{status:'ok'|'error',content:readonly ModelInputContent[]}`，`ToolFeedback` 另含 `toolCallId`；纯文本结果的两种状态都编码为明确的 JSON 数据正文，不能靠措辞暗示失败。工具结果不会成为 system 消息，Provider 也不自动执行其中指令。结果的可信程度、提示策略与实际资源授权仍由宿主和业务确定。

`toolChoice` 可为 `auto`、`none`、`required` 或 `{name}`。指定名称必须已登记；除 `none` 外，显式选择要求有工具目录。参数 Schema 为纯 JSON 对象，原样转交，不在 Provider 内建立另一套业务 Schema 执行器。本实现每份目录/回复最多 32 个工具，工具名支持字母、数字、`_`、`-`，长度 1–128。

DeepSeek 思考模式在带 `tools` 的后续请求中要求回传此前回复的 `reasoning_content`，包括没有工具调用的回复。Provider 在 exchanges 中始终保留并编码该字段；不带 tools 时，是否使用由兼容端点决定。调用方不能用只有正文的普通 assistant 消息替代需要精确续接的思考回复。协议依据：[工具调用](https://api-docs.deepseek.com/guides/tool_calls/)、[思考模式](https://api-docs.deepseek.com/guides/thinking_mode/)。

## 固定图片输入

`ModelInputContent` 为文本块 `ModelTextOutput` 或图片块 `ModelImageInput`。图片形状为 `{kind:'image', mimeType:'image/png'|'image/jpeg'|'image/webp', data:string}`；`data` 必须是非空、规范的 RFC 4648 base64（包含所需 padding，不带 data URL 前缀或空白）。user 的 `ModelMessage.content` 接受字符串或 1–32 个有序内容块；system/assistant 只接受字符串或文本块数组。`ToolResult.content` 同样接受 1–32 个文本／图片块。图片是输入材料，`ModelReply.output` 仍只有文本与工具调用。

图片在发送前核验 base64、声明的 MIME 与文件签名、基本头尾结构；不会解码像素，也不保证图片可完整解码或在具体模型中可用。宿主负责来源授权、解码安全、尺寸／像素预算和必要的缩放再编码。远端 URL、本地路径、SVG 与任意 MIME 不属于图片本体；Provider 不读取图片文件、不下载图片、不自动转换格式。图片字节及 base64 膨胀计入请求纯值和 HTTP 正文各自的预算；默认均为 2 MiB，宿主可显式提高至框架支持范围。工具反馈与交换的独立 2 MiB 上限不变。

内容数组逐块编码为 Chat Completions 的 `text` 或 `image_url`，图片 URL 由固定字节生成 `data:<mimeType>;base64,<data>`。工具反馈始终保持 `role:'tool'`、准确 `tool_call_id` 和 `{status,content}` JSON 字符串正文；图片在此正文中投影为 `{kind:'image-reference',contentIndex}`。本轮所有工具反馈闭合后，追加一条 user 附件消息：依原工具调用顺序，以文本 `{kind:'tool-images',toolCallId}` 标识每组，再按内容顺序以 `{contentIndex}` 文本紧邻对应真实图片。它仅是工具材料的传输投影，不代表新的用户指令，不改变原始实体、反馈回执或图片保留策略。无图片的工具反馈保持原有传输形状，不追加附件消息。

该通用映射只在 user 角色发送图片，要求所选模型支持 user 图片输入。DeepSeek 当前[图像文档](https://api-docs.deepseek.com/guides/vision/#restrictions)也支持 system/tool 图片，但这不是所有 Chat Completions 端点的共同能力；本适配器不使用该扩展。预检与发送共同执行严格校验并计算完整附件展开后的 HTTP 大小，拒绝时不会发送请求，错误中不包含图片正文。

## 流式与用量

```js
const reply = await model.complete({ messages: [{ role: 'user', content: '解释这份材料。' }], stream: true }, { signal, emit: (delta) => process.stdout.write(delta) });
```

`stream` 默认 false；单独提供 emit、emitReasoning 或 progress 不开启流式。emit 只同步交付正文预览，工具参数与思考文本不会被当作正文发布。未提供预览消费者时仍完整消费并保留最终回复。

`ModelControls.emitReasoning?: (delta: string) => void` 独立同步交付供应商实际返回的 reasoning_content 增量。当前 SSE chunk 完整校验后，每个非空字符串增量按原样交付一次，不去重、不合成摘要，也不按空白裁剪；缺失、null 和空字符串不触发。非流式请求仅在完整回复中提供原生思考字段，不补发预览。宿主决定如何展示或保存这些文本；它们不进入 `ModelReply.output`，也不代替正文或工具执行事实。是否订阅不改变最终 `native.reasoningContent` 及 exchanges 的完整续接材料。

`ModelControls.progress?: (progress: ModelStreamProgress) => void` 同步报告实际流式活动，公开值只有 `{ kind: 'reasoning' | 'text' | 'tool-call' }`。只有当前 SSE chunk 完整校验后，其中非空的 reasoning_content、正文或工具 ID/名称/参数增量才触发；空字段、role-only、usage 与终态不会触发。连续同类增量只通知一次，切换后再次出现可重新通知。单个 chunk 同时含多类增量时，顺序为 reasoning 进度、emitReasoning、tool-call 进度、text 进度、emit；不符合触发条件或未订阅的通知跳过。进度去重不抑制推理或正文增量。通知不包含思考正文、工具名称或参数；tool-call 仅表示模型正在生成调用，不表示工具执行或完成。非流式回复不合成进度。

progress、emitReasoning 与 emit 使用相同的同步消费者失败语义：抛错保留原错误身份，返回 Promise 或 thenable 拒绝为 TypeError，停止后续通知并释放流读取；内部 ModelEmissionFailure 仅用于保留错误来源。消费者触发取消后不再调用当前 chunk 及后续 chunk 的其他消费者。合法增量的预览和进度不代表最终回复或业务接纳已成立；后续协议错误、超限或取消仍会使 complete 失败，已交付的预览不能代替完整回复。流式回调不建立新的实体、协议状态或恢复依据。

SSE 按 `tool_calls[index]` 拼接名称与参数片段，保留 reasoning_content，终态与独立 usage 均支持。缺少 ID、重复 ID、索引缺口、超过 32 个调用、终态后继续 choice、重复 usage、缺少 finish_reason 或 `[DONE]` 均拒绝。`[DONE]` 结束协议后立即释放读取，不要求上游 HTTP 连接先关闭。默认不重发，也不退回非流式请求；显式重试的流中断边界见下节。原有 UTF-8 分片、SSE 换行/注释、多行 data、接收者失败、取消和总超时行为保持。

JSON 与 SSE 共用 `ModelUsage`：`promptTokens / completionTokens / totalTokens`，可选 `promptCacheHitTokens / promptCacheMissTokens` 原样保留。计数必须是非负安全整数，缓存单项不超过 promptTokens，两项都报告时其和须等于 promptTokens。缺失不估算为零；不把其他厂商的缓存字段自动映射成 DeepSeek 计数。

## 显式请求重试

`ChatCompletionsConfiguration.retry` 可显式配置 `{maxAttempts, delayMs?, maxDelayMs?}`。不配置时仍只有一次 HTTP 尝试；`maxAttempts` 包含首次请求，必须是正安全整数。初始间隔 `delayMs` 默认 1000 毫秒，等待上限 `maxDelayMs` 默认 30000 毫秒，两者为 0 到 2147483647 的安全整数，上限不得小于初始间隔。后续间隔指数增加并受上限约束。有效的 `Retry-After` 不会被缩短；超出等待上限时直接返回该次 HTTP 错误。调用方 signal 和原有 `timeoutMs` 覆盖全部尝试及等待，不为每次重试重新计时。

启用前，宿主须确认端点只做模型生成，并接受重复推理及可能的重复计费。断线、超时、5xx 或没有收到字节，都不证明服务端没有处理。服务端工具、有副作用的扩展或有状态接口不能自动套用这个许可，须另有明确的效果确认或去重协议。本能力不恢复连接上的旧生成，而是用同一份已校验和编码的请求重新生成；配置与 HTTP 正文固定一次，调用方后续修改输入不会改变重试内容。

只在当前尝试内部确认来源后重试：fetch 失败、响应读取失败、SSE 在完整终态和 `[DONE]` 之前结束，以及 HTTP 408/429/500/502/503/504。响应读取失败报告 `NETWORK`；提前结束的 SSE 仍报告 `ENVELOPE`，尝试诊断 phase 为 `stream`。完整但非法的 JSON、UTF-8、SSE 或回复协议，配置、容量、消费者失败与取消不重试；总超时也不重试。错误码本身不是重发许可，消费者抛出的同类错误不会获得传输来源资格。

每次重试前已释放前次读取器并等待取消清理。任何有效 `ModelReply` 都结束重试，包括 `incomplete` 和 `refused`；后续反馈持久化、业务接纳或工具执行错误不会重新请求模型。Interaction 仍只启动一次发送者，整个尝试循环属于该次发送者生命周期；历史 pending、失败调用和冷恢复不因此取得重新发送的资格。

`ModelControls.attempt` 同步接收冻结的 `ModelAttemptEvent`，attempt 从 1 开始，仅在本次 complete 内编号：

- `started`：准备开始一次尝试。通知可以取消或拒绝发送，因此它不证明 HTTP 已到达服务端。
- `failed`：该次传输或回复接纳失败，携带有界的 `failure.code / phase / status?`，不含正文、headers、底层 cause 或密钥。
- `retrying`：上一尝试已清理，携带 nextAttempt 和 delayMs；仍可能在等待期间取消，不保证下一尝试会启动。
- `completed`：该次取得有效协议回复，携带该次 usage，仍不代表工具执行、业务接纳或持久化成功。

该通知与 emit 的同步消费者规则一致：抛错保留原错误身份，Promise/thenable 拒绝，立即停止后续通知和重试。因此消费者失败后不补发 failed，completed 通知失败也不会变成另一条 failed。无效请求在尝试开始之前拒绝，不伪造尝试事件。等待期间取消或超时不补造新的尝试。

启用重试并消费预览的宿主必须按逻辑请求与 attempt 分隔内容：started 开始新的正文／思考缓存，failed 的片段只能作为失败尝试的临时观察，不能拼接到后续正文、写入正式历史或执行其中的工具参数。最终回复仅来自成功的完整尝试。逻辑调用数、尝试数与工具执行数分别统计；usage 仅描述该份有效回复，不包含失败尝试的成本。失败尝试的费用与用量未知，不能补零，也不能把最后一次 usage 当作所有尝试的总量。

## 容量与范围

`ChatCompletionsProvider.inspectRequest(request)` 同步完成请求预检，返回冻结的 `{requestBytes, wireBytes, limits: {maxRequestBytes, maxWireRequestBytes}}`，内层 `limits` 也被冻结：前者是共同请求完整 JSON 的 UTF-8 字节数，后者是实际 HTTP 正文字节数，包括固定的 model/thinking 配置、工具目录、交换编码和流式字段。它与 `complete` 共用校验和编码路径，能够计算 Unicode、转义字符以及工具反馈嵌套 JSON 带来的真实大小；不发请求、不读取网络，也不返回正文、headers 或密钥。

`ModelProvider` 上此端口可选，依赖精确发送预算的宿主应在装配时要求它存在。无效或超出框架支持范围时，预检与 `complete` 一样抛出 `ProviderError('REQUEST')`。框架支持范围内，即使超过配置的发送预算，预检仍返回计量；内置 Provider 总返回有效预算 `limits`，自定义 Provider 可省略。预检不冻结输入、不预留额度，也不保证模型上下文 token 容量；实际发送仍重新校验当前请求，修改过输入后必须以本次检查为准。

- `maximumModelRequestBytes` 与 `maximumModelWireRequestBytes` 均为 64 MiB，分别定义公开请求纯 JSON 与编码后 HTTP 正文经回归覆盖的框架支持范围，不代表厂商通用限制、模型上下文容量或可用 token 数。深度最多 64、值数最多 100,000；图片块数、工具数、输出等结构限制不变。
- `ChatCompletionsConfiguration.maxRequestBytes / maxWireRequestBytes` 是独立发送预算，默认各 2 MiB，可显式配置为对应支持范围内的正安全整数。`complete` 使用本次实际计量，在打开传输前执行两个预算；超预算抛出继承 `ProviderError` 的 `ProviderRequestLimitError`，`code` 为 `REQUEST_LIMIT`，`metric` 为 `requestBytes` 或 `wireBytes`，并仅携带数值 `bytes / limit`，不保存正文。共同请求先检查，HTTP 正文随后检查。
- 公开回复、工具结果、反馈仍各限 2 MiB；`maximumModelExchangeBytes` 为 2 MiB，限制单个闭合交换的完整公共 JSON，请求中嵌套的交换也必须符合该独立上限。较大请求只允许累计多个合法材料，不会扩大单份回复或反馈。合法的单项不代表任意累计历史都能继续装入请求。
- 默认总超时 60 秒，涵盖发送与完整读取。`maxResponseBytes` 是独立的实际传输预算，默认 2 MiB，SSE 计入事件封装、注释和思考内容；提高传输预算不会放宽公开回复的纯值上限。
- 一次 complete 默认只有一次 HTTP 请求；显式 retry 仅允许上述有界传输尝试。调用取消保持原 reason，不修改调用者 signal；对独立 Interaction 的生命周期不作推断。
- `ProviderError` 含 code/message/可选 HTTP status；请求预算错误另含上述数值诊断，不保存上游正文、请求、headers、密钥或底层错误。宿主可注入 fetch；实现必须遵守 Fetch 取消与重定向语义。
- `thinking` 是宿主显式配置的 DeepSeek 扩展。当前实现 Chat Completions 函数调用、文本与固定图片输入；不承诺 Responses、Anthropic 原生协议、MCP、音视频或 strict beta。正式 Transcript 的消息角色不因此扩展。

完整协议参考 [Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/) 与 [SSE 标准](https://html.spec.whatwg.org/multipage/server-sent-events.html#event-stream-interpretation)。

## 契约与版本记录

- [原生工具调用契约](https://github.com/weiliang0121/capix/blob/main/docs/native-tool-integration.md)
- [按版本查阅 CHANGELOG](https://github.com/weiliang0121/capix/blob/main/packages/model-provider/CHANGELOG.md)
- [MIT 许可证](LICENSE)
