# @weiliang0121/capix-model-provider

本包直接实现 Chat Completions、OpenAI Responses、Anthropic Messages 和 Gemini generateContent。各适配器均支持文本、固定图片、客户端工具调用和 SSE，并把完整回复接纳为可持久的 `ModelReply`。

## 安装与入口

包使用 ESM，附带 TypeScript 类型声明。完整回归在 Node.js 22.23.2 上运行，支持范围为 Node.js `>=22.23.2`。其他 JavaScript 宿主按使用的入口配置所需能力。[宿主能力与验证范围](https://github.com/weiliang0121/capix/blob/main/docs/host-platforms.md)

适配器优先使用配置传入的 `fetch`，省略时使用 `globalThis.fetch`。JSON 和 SSE 都需要可读取的 `Response.body`。[iOS Hermes 接入](https://github.com/weiliang0121/capix/blob/main/docs/ios-hermes.md)

```sh
npm install @weiliang0121/capix-model-provider
```

- `@weiliang0121/capix-model-provider` 提供四种协议适配器、请求与回复校验、工具参数读取及传输错误类型。

本页描述当前源码版本。npm 0.9.1 提供 Chat Completions，其他协议适配器的可用版本见[发布记录](https://github.com/weiliang0121/capix/releases)。

## 按部署端点选择适配器

根据部署文档中实际调用的 API 选择适配器，并配置该部署的完整 `endpoint`、模型和凭证。同一个模型可以由不同协议的端点提供。下表列出部分官方 API 示例，网关实测的覆盖范围以测试所用端点、模型及功能为限。

| API 协议               | CAPiX 适配器                    | 部署示例与官方文档                                                                                                                                                                                                                                                                                                                                             |
| ---------------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chat Completions       | `ChatCompletionsProvider`       | OpenAI GPT 的 [Chat Completions](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)、DeepSeek 的 [Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/)、阿里云百炼 Qwen 的 [OpenAI 兼容 Chat](https://www.alibabacloud.com/help/en/model-studio/qwen-api-via-openai-chat-completions) |
| OpenAI Responses       | `OpenAIResponsesProvider`       | OpenAI GPT 的 [Responses](https://developers.openai.com/api/reference/resources/responses/methods/create)                                                                                                                                                                                                                                                      |
| Anthropic Messages     | `AnthropicMessagesProvider`     | Anthropic Claude 的 [Messages](https://platform.claude.com/docs/en/api/messages/create)                                                                                                                                                                                                                                                                        |
| Gemini generateContent | `GeminiGenerateContentProvider` | Google Gemini 的 [generateContent 和 streamGenerateContent](https://aistudio.google.com/api-reference/generate-content)                                                                                                                                                                                                                                        |

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
if (reply.termination.kind !== 'completed') throw new Error('模型未正常完成');
console.log(modelReplyText(reply));
```

运行示例前设置 `DEEPSEEK_API_KEY` 和账户可用的模型名 `DEEPSEEK_MODEL`。执行 `complete` 时会访问模型服务。

使用同一 Chat 协议的其他服务可以更换完整 `endpoint`、模型名与凭证。本仓使用构造的 DeepSeek 和百炼 Qwen 函数调用样本验证两轮 JSON/SSE 请求，覆盖面限定在夹具使用的字段。[离线端点回归](https://github.com/weiliang0121/capix/blob/main/packages/tool/test/chat-endpoints.test.mjs)

## Anthropic Messages

```js
import { AnthropicMessagesProvider } from '@weiliang0121/capix-model-provider';

const model = new AnthropicMessagesProvider({
  endpoint: 'https://api.anthropic.com/v1/messages',
  apiKey: process.env.ANTHROPIC_API_KEY,
  model: process.env.ANTHROPIC_MODEL,
  anthropicVersion: '2023-06-01',
  bindingId: 'primary-account-production',
  maxTokens: 4096,
});
```

`bindingId` 是宿主分配给部署与账号作用域的稳定、非秘密标识。已保存的交换只能由同一绑定、配置模型和 API 版本回传；轮换同一作用域下的密钥可以沿用标识。固定具体模型版本可避免服务端重定向别名。宿主变更可恢复运行的绑定时也应变更 Tool 的 `policyVersion`。历史读取只需要相应格式校验器。发送使用 `x-api-key` 和 `anthropic-version`，每次请求的 `maxTokens` 可以覆盖构造时的默认上限。

含签名思考或遮盖块的回复会保存 `native.prefixSha256`。在续轮前，适配器核对原来的 system、工具目录、之前的消息和本条回复的内容块，随后可以正常追加本轮工具反馈。需要跨轮保留思考时，宿主应固定这些输入。摘要用于发现本地历史变化，原生签名由 Anthropic 验证。[Anthropic 的前缀核验规则](https://platform.claude.com/docs/en/build-with-claude/preserved-thinking/prefix-checks)

初始消息以 user 开始，前置 system 消息可提到顶层 `system`。工作流支持文本、图片和客户端工具，工具 Schema 须以对象为根。可选 `thinkingBudgetTokens` 对支持手动思考预算的模型启用 extended thinking，取值至少 1024 且低于有效输出上限；此时温度仅接受 1 或省略，工具选择接受自动、禁用或省略。`json_object` 响应格式及无法准确编码的消息在发送前拒绝。

## OpenAI Responses

OpenAI Responses 的两种续轮策略使用同一个 `OpenAIResponsesProvider`。构造时传入完整的 `endpoint`（例如 `https://api.openai.com/v1/responses`）、`apiKey`、`model` 和宿主为部署及账号分配的非秘密 `bindingId`。

同一凭据作用域内轮换密钥可沿用 `bindingId`。切换项目、账号或部署时，应分配新绑定，并更新可恢复 Tool 的 `policyVersion`。使用 `previous-response-id` 表示宿主选择在该网关保存响应。

| 构造参数 `continuation`  | 请求行为                                                                            | 宿主需要提供什么                                                  |
| ------------------------ | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `'replay'`（默认）       | 发送 `store: false`，将历史输出项与新的 `function_call_output` 放入 `input`         | 完整公共交换，保留原生输出顺序、消息阶段和续轮所需的 reasoning 项 |
| `'previous-response-id'` | 发送 `store: true`。首轮发送完整输入，后续发送上一个 `response.id` 及新增的工具结果 | 支持响应存储的网关、同一绑定以及与远端一致的本地历史前缀          |

两种策略都从当次请求提供的 `exchanges` 计算续轮。一个 Provider 可以并发服务多个会话。工具反馈使用 `function_call.call_id`。响应 ID 标识生成结果，输出项 ID 标识原生条目。服务端模式在本地预检通过后仍可能遇到响应过期、删除或访问权限变化，失败会交付给调用方。两种模式都保留完整的本地材料，共同请求预算仍按完整材料计算。显式历史模式重建原生输入，服务端是否继续采用早期 reasoning 还取决于模型对提示前缀的要求。[OpenAI 会话状态](https://developers.openai.com/api/docs/guides/conversation-state) · [前缀与推理复用](https://developers.openai.com/api/docs/guides/keep-prefix-unchanged)

当前支持文本与固定图片输入、直接调用宿主函数、消息与推理摘要的 SSE 预览，以及工具结果中的文本和图片。显式设置 `maxTokens` 时，Responses 适配器要求至少 16。工具结果的首个文本块编码 `status`，后面按顺序跟随结果内容。拒绝正文保存在原生材料中，截断保留结束原因。遇到托管工具、非空引用注解或其他无法完整回传的输出项时，请求会明确失败。回放 reasoning 需要网关返回相应密文。可在本地运行[原生协议测试](https://github.com/weiliang0121/capix/blob/main/packages/model-provider/test/responses-provider.test.mjs)和[完整工具场景](https://github.com/weiliang0121/capix/blob/main/packages/tool/test/responses-recovery.test.mjs)。

SSE 的创建、排队、进行中和终态快照只要回显 `store` 或 `previous_response_id`，都须与当前请求一致。`response.output_item.done` 与终态快照按相同的 JSON 接纳规则核对，省略的 `phase` 与 `null` 等价，省略的 `logprobs` 与空数组等价。显式历史回放的 `output_text` 会发送 `annotations: []` 和 `logprobs: []`。工具结果使用的 `call_id` 必须能按 `function_call_output` 的输入约束回传，长度为 1 至 64 个 Unicode 码点。[Responses 请求契约](https://developers.openai.com/api/reference/resources/responses/methods/create) · [快照一致性回归](https://github.com/weiliang0121/capix/blob/main/packages/model-provider/test/responses-reply.test.mjs)

## Gemini generateContent

```js
import { GeminiGenerateContentProvider } from '@weiliang0121/capix-model-provider';

const modelName = process.env.GEMINI_MODEL;
const model = new GeminiGenerateContentProvider({
  endpoint: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelName)}:generateContent`,
  apiKey: process.env.GEMINI_API_KEY,
  model: modelName,
  bindingId: 'primary-account-production',
});
```

设置 `GEMINI_API_KEY` 和 `GEMINI_MODEL`，模型名使用裸名称。请求使用 `x-goog-api-key` 认证。`endpoint` 必须以 `/models/<model>:generateContent` 路径结尾。`stream: true` 时将末尾方法改为 `:streamGenerateContent` 并设置 `alt=sse`，沿用配置的主机、路径前缀和其他查询参数。[Gemini 生成接口](https://ai.google.dev/api/generate-content)

适配器将前置 system 消息放入 `systemInstruction`，首条对话消息须为 user。用户图片编码为 `inlineData`。函数目录要求名称以字母或下划线开头，Schema 以对象为根。工具选择映射为 `AUTO`、`NONE` 或 `ANY`，指定名称时用 `allowedFunctionNames` 限定。`maxTokens`、`temperature` 和 `json_object` 分别映射到生成配置的 `maxOutputTokens`、`temperature` 和 JSON 对象响应要求。模型是否支持选定功能及功能组合由实际端点决定。回复接纳单个候选中的文本、思考和完整函数调用。图片输出、托管工具的原生 Part 和分段函数参数会使接纳失败。

上游提供 `responseId` 和 `modelVersion` 时，分别保存在 `reply.id` 和 `reply.model`。省略 `responseId` 时，适配器在接纳回复时生成一次本地 ID，并设置 `native.idSource: 'local'`。省略 `modelVersion` 时，使用配置模型，并设置 `native.modelSource: 'configured'`。回复与来源标记一起保存，冷载入后仍使用同一 ID。续轮从请求的 `exchanges` 回放完整原生历史，并核验宿主分配的 `bindingId` 与 `reply.native.model` 中的配置模型。`bindingId` 应稳定标识部署及账号作用域，可以公开。切换部署、账号或模型时，宿主应为可恢复 Tool 更新 `policyVersion`。已保存的回复可独立离线校验。[Google SDK 的回复定义](https://googleapis.github.io/js-genai/release_docs/classes/types.GenerateContentResponse.html)

每个公共 `toolCallId` 由回复 ID 和原生 Part 位置确定。适配器按原顺序回放 `functionCall`，并发送对应的 `functionResponse`。有上游调用 ID 时，两处保留该 ID；上游省略时，两处也省略，可按原调用位置保持同名调用的顺序。上游省略 `args` 时，工具看到空对象，回放保留省略形式。工具反馈将成功与失败分别编码在 `response.output` 和 `response.error`；其中的固定图片通过 `$ref` 指向 `functionResponse.parts` 中按 `displayName` 标识的 `inlineData`。[Gemini 函数调用](https://ai.google.dev/gemini-api/docs/function-calling)

`native.parts` 保留原生 Part 的顺序和边界，回放时保持 `thoughtSignature` 与原 Part 的关联。含签名的回复额外保存 `native.partsSha256` 供离线检查本条回复的 Part 和公共输出；原生签名由 Gemini 校验。[Gemini 思考签名](https://ai.google.dev/gemini-api/docs/thought-signatures) · [原生协议测试](https://github.com/weiliang0121/capix/blob/main/packages/model-provider/test/gemini-provider.test.mjs) · [Tool 冷恢复测试](https://github.com/weiliang0121/capix/blob/main/packages/tool/test/gemini-recovery.test.mjs)

## 唯一回复材料

`ModelReply` 是 `ChatCompletionsReply | OpenAIResponsesReply | AnthropicMessagesReply | GeminiGenerateContentReply`。具体 Provider 的 `complete` 各自返回对应类型。所有分支都保存版本 1 的共同信封，含 `id`、`model`、有序 `output`、`termination`、`usage` 和版本化 `native`。通用调用方根据 `termination.kind` 处理 `completed`、`incomplete` 和 `refused`。`termination.reason` 保存协议原因，读取 `native` 专属字段前可用 `reply.native.format` 缩窄类型。

| 协议                   | 工具参数与原生续轮材料                                                                                                                                                       | 结束原因                                                                           |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Chat Completions       | `json-text` 保留参数原文，即使是无效 JSON。可选 `native.reasoningContent` 在续轮时原样回传。                                                                                 | `stop` 和 `tool_calls` 为 `completed`，`content_filter` 为 `refused`。             |
| OpenAI Responses       | `json-text` 保留函数参数原文。`native.items` 保存原生项的顺序与身份，工具反馈按调用 ID 回传。                                                                                | 接纳正式终态，分别处理完成、截断与拒绝。                                           |
| Anthropic Messages     | `json-value` 保存固定 JSON 对象。`native.blocks` 按原顺序引用正文与调用，并保存思考块的内容与签名或遮盖数据。下一轮按原调用 ID 写入 `tool_result` 的 `content`、`is_error`。 | `end_turn`、`stop_sequence` 和 `tool_use` 为 `completed`，`refusal` 为 `refused`。 |
| Gemini generateContent | `json-value` 保存固定 JSON 对象。`native.parts` 按原顺序引用正文与调用，保留原生 Part 边界、思考、签名和可选原生调用 ID。                                                    | `STOP` 为 `completed`。提示被拦截或候选触发 `SAFETY` 等过滤规则时为 `refused`。    |

其余结束原因保留原文并归入 `incomplete`。Tool 只推进已完整接纳的回复。`modelReplyText(reply)` 拼接文本，遇到工具调用时拒绝。协议版本、块顺序或续轮所需材料不完整时拒绝接纳。签名作为不透明数据传回原服务。

Messages 流可在报告 `stop_reason` 后继续更新累计用量。输入、缓存读取、缓存写入和输出分别累计，后续帧省略字段或给出 `null` 时保留已知值，任一已知计数回退会以 `invalid-usage` 拒绝整轮。`message_start` 的输出计数是初值，首次输出用量以 `message_delta` 为准。适配器在 `message_stop` 交付最终回复。若 `max_tokens` 截断末个工具调用的 JSON 参数，回复保留之前完整的块及用量，略去无法解析的调用，终态为 `incomplete/max_tokens`。Tool 对整轮停止派发，包括同轮中参数已经完整的调用。[Anthropic 工具参数流](https://platform.claude.com/docs/en/agents-and-tools/tool-use/fine-grained-tool-streaming) · [工具执行回归](https://github.com/weiliang0121/capix/blob/main/packages/tool/test/messages-recovery.test.mjs)

公开 `requireModelReply`、`requireModelRequest`、`requireToolResult`、`requireToolFeedback` 和 `requireModelExchange` 对未知值作完整校验，返回原对象身份，不克隆、不冻结，也不缓存对可变对象的信任。适用于资源、Interaction、实体与 CP 的接纳边界。校验拒绝旧双字段形状、未知字段/版本、重复 ID、不完整反馈、getter、循环引用与非 JSON 值；错误不包含传入正文。原生检查拒绝 Proxy，采用作者保证模式时由宿主提供无代理的数据。[宿主对象检查](https://github.com/weiliang0121/capix/blob/main/docs/runtime-boundaries.md#宿主对象检查)

Provider 自己生成的回复已深冻结。旧 `text/finishReason` 双字段回复不是新协议的有效持久值，不能自动迁移后冒充已认证反馈。

## 原生工具与续接

直接消费工具调用时，用 `readModelToolArguments(call)` 读取参数。它解析 `json-text` 或返回 `json-value` 中的值，返回类型为 `unknown`，无效 JSON 文本会抛出 `SyntaxError`。宿主在执行前按工具的 Schema 校验参数，并保留原始 `reply` 供后续 `exchanges` 回放。

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

`messages` 是固定的 system/user/assistant 前缀，`exchanges` 按顺序附加完整的模型交换。每个交换应提供该回复中每个工具调用的反馈，适配器按原调用顺序和 ID 编码，因此反馈数组可以反序到达。`ToolResult` 包含 `status` 和 `content`，`ToolFeedback` 还包含 `toolCallId`。Chat 使用 `assistant.tool_calls`、`tool.tool_call_id` 和含状态的 JSON 字符串正文。Messages 使用有序的 `tool_use`、`tool_result` 块，并用 `is_error` 表示失败。宿主负责授权和实际执行。

`toolChoice` 可为 `auto`、`none`、`required` 或 `{name}`。指定名称必须已登记；除 `none` 外，显式选择要求有工具目录。参数 Schema 为纯 JSON 对象，原样转交，不在 Provider 内建立另一套业务 Schema 执行器。本实现每份目录/回复最多 32 个工具，工具名支持字母、数字、`_`、`-`，长度 1–128。

DeepSeek 思考模式在带 `tools` 的后续请求中要求回传此前回复的 `reasoning_content`，包括没有工具调用的回复。Provider 在 exchanges 中始终保留并编码该字段；不带 tools 时，是否使用由兼容端点决定。调用方不能用只有正文的普通 assistant 消息替代需要精确续接的思考回复。协议依据：[工具调用](https://api-docs.deepseek.com/guides/tool_calls/)、[思考模式](https://api-docs.deepseek.com/guides/thinking_mode/)。

## 固定图片输入

`ModelInputContent` 为文本块 `ModelTextOutput` 或图片块 `ModelImageInput`。图片形状为 `{kind:'image', mimeType:'image/png'|'image/jpeg'|'image/webp', data:string}`；`data` 必须是非空、规范的 RFC 4648 base64（包含所需 padding，不带 data URL 前缀或空白）。user 的 `ModelMessage.content` 接受字符串或 1–32 个有序内容块；system/assistant 只接受字符串或文本块数组。`ToolResult.content` 同样接受 1–32 个文本／图片块。图片是输入材料，`ModelReply.output` 仍只有文本与工具调用。

图片在发送前核验 base64、声明的 MIME 与文件签名、基本头尾结构；不会解码像素，也不保证图片可完整解码或在具体模型中可用。宿主负责来源授权、解码安全、尺寸／像素预算和必要的缩放再编码。远端 URL、本地路径、SVG 与任意 MIME 不属于图片本体；Provider 不读取图片文件、不下载图片、不自动转换格式。图片字节及 base64 膨胀计入请求纯值和 HTTP 正文各自的预算；默认均为 2 MiB，宿主可显式提高至框架支持范围。工具反馈与交换的独立 2 MiB 上限不变。

内容数组逐块编码为 Chat Completions 的 `text` 或 `image_url`，图片 URL 由固定字节生成 `data:<mimeType>;base64,<data>`。工具反馈始终保持 `role:'tool'`、准确 `tool_call_id` 和 `{status,content}` JSON 字符串正文；图片在此正文中投影为 `{kind:'image-reference',contentIndex}`。本轮所有工具反馈闭合后，追加一条 user 附件消息：依原工具调用顺序，以文本 `{kind:'tool-images',toolCallId}` 标识每组，再按内容顺序以 `{contentIndex}` 文本紧邻对应真实图片。它仅是工具材料的传输投影，不代表新的用户指令，不改变原始实体、反馈回执或图片保留策略。无图片的工具反馈保持原有传输形状，不追加附件消息。

该通用映射只在 user 角色发送图片，要求所选模型支持 user 图片输入。DeepSeek 当前[图像文档](https://api-docs.deepseek.com/guides/vision/#restrictions)也支持 system/tool 图片，但这不是所有 Chat Completions 端点的共同能力；本适配器不使用该扩展。预检与发送共同执行严格校验并计算完整附件展开后的 HTTP 大小，拒绝时不会发送请求，错误中不包含图片正文。

## 流式与用量

Messages 按事件类型与块索引累积文本、思考和工具参数，到 `message_stop` 才交付完整回复。普通文本和公开的思考文本分别交给 `emit` 和 `emitReasoning`。签名与遮盖数据仅用于原协议续轮。HTTP 200 响应中的显式错误事件终止该次调用，提前 EOF 只在允许传输重试时重试。输入 token 按普通、缓存读取、缓存写入三种口径合计，输出使用最终累计值。四项齐全时，`reply.usage` 和完成事件才提供完整统计。部分计数保存在 `native.partialUsage`。跨协议调用 `modelReplyUsage(reply)` 可读取含义明确的公共计数，签名为 `Partial<ModelUsage> | null`。例如只报告普通输入 25 和输出 15 时，返回 `{ completionTokens: 15 }`，总输入仍未知。仅报告缓存写入时，公共字段 `promptCacheWriteTokens` 也会保留该值。例如普通输入 12、缓存读取 3、缓存写入 5、输出 7 对应提示总量 20 和总用量 27。[官方流式示例](https://platform.claude.com/docs/en/build-with-claude/streaming#basic-streaming-request)

Gemini 按 SSE 事件累积完整 Part。候选的有效 `finishReason` 或提示拦截原因确认终态；终态事件缺少计量时，等待尾部用量事件或正常 EOF。尚未收到终态的提前 EOF 会被拒绝。`emit` 和 `emitReasoning` 分别交付原生 Part 中的正文和思考文本，`progress` 按 Part 顺序报告活动类别。输入用量合计提示与工具提示 token，输出用量合计候选与思考 token，缓存读取量单列。缺少可靠依据时 `usage` 为 `null`。以下为 Chat Completions 流规则。

```js
const reply = await model.complete({ messages: [{ role: 'user', content: '解释这份材料。' }], stream: true }, { signal, emit: (delta) => process.stdout.write(delta) });
```

`stream` 默认 false；单独提供 emit、emitReasoning 或 progress 不开启流式。emit 只同步交付正文预览，工具参数与思考文本不会被当作正文发布。未提供预览消费者时仍完整消费并保留最终回复。

`ModelControls.emitReasoning?: (delta: string) => void` 独立同步交付供应商实际返回的 reasoning_content 增量。当前 SSE chunk 完整校验后，每个非空字符串增量按原样交付一次，不去重、不合成摘要，也不按空白裁剪；缺失、null 和空字符串不触发。非流式请求仅在完整回复中提供原生思考字段，不补发预览。宿主决定如何展示或保存这些文本；它们不进入 `ModelReply.output`，也不代替正文或工具执行事实。是否订阅不改变最终 `native.reasoningContent` 及 exchanges 的完整续接材料。

`ModelControls.progress?: (progress: ModelStreamProgress) => void` 同步报告实际流式活动，公开值只有 `{ kind: 'reasoning' | 'text' | 'tool-call' }`。只有当前 SSE chunk 完整校验后，其中非空的 reasoning_content、正文或工具 ID/名称/参数增量才触发；空字段、role-only、usage 与终态不会触发。连续同类增量只通知一次，切换后再次出现可重新通知。单个 chunk 同时含多类增量时，顺序为 reasoning 进度、emitReasoning、tool-call 进度、text 进度、emit；不符合触发条件或未订阅的通知跳过。进度去重不抑制推理或正文增量。通知不包含思考正文、工具名称或参数；tool-call 仅表示模型正在生成调用，不表示工具执行或完成。非流式回复不合成进度。

progress、emitReasoning 与 emit 使用相同的同步消费者失败语义：抛错保留原错误身份，返回 Promise 或 thenable 拒绝为 TypeError，停止后续通知并释放流读取；内部 ModelEmissionFailure 仅用于保留错误来源。消费者触发取消后不再调用当前 chunk 及后续 chunk 的其他消费者。合法增量的预览和进度不代表最终回复或业务接纳已成立；后续协议错误、超限或取消仍会使 complete 失败，已交付的预览不能代替完整回复。流式回调不建立新的实体、协议状态或恢复依据。

SSE 按 `tool_calls[index]` 拼接名称与参数片段，保留 reasoning_content，终态与独立 usage 均支持。缺少 ID、重复 ID、索引缺口、超过 32 个调用、终态后继续 choice、重复 usage、缺少 finish_reason 或 `[DONE]` 均拒绝。`[DONE]` 结束协议后立即释放读取，不要求上游 HTTP 连接先关闭。默认不重发，也不退回非流式请求；显式重试的流中断边界见下节。原有 UTF-8 分片、SSE 换行/注释、多行 data、接收者失败、取消和总超时行为保持。

JSON 与 SSE 共用 `ModelUsage`。提示、输出和总计分别为 `promptTokens`、`completionTokens` 和 `totalTokens`。Chat Completions 优先读取 DeepSeek 的 `prompt_cache_hit_tokens`，缺失时使用 `prompt_tokens_details.cached_tokens`。只有回报 `prompt_cache_miss_tokens` 才填写 `promptCacheMissTokens`。命中和未命中都已知时，两项之和必须等于提示总量。

Messages 的 `cache_creation_input_tokens` 和 Responses 的 `input_tokens_details.cache_write_tokens` 映射为 `promptCacheWriteTokens`。缓存读取与写入已包含在提示用量中。各计数须为非负安全整数，缓存单项最多为提示总量。已回报的 0 保留，缺失的缓存计数省略。

## 定位协议错误

内置 Provider 在协议校验失败时，通过 `ProviderError.diagnostic` 给出 `protocol`、`phase` 和 `reason`。原有 `code` 仍可用于区分 `REQUEST`、`HTTP` 和 `ENVELOPE` 等错误。诊断使用固定枚举，只报告遇到的第一个失败条件。请求预检的阶段为 `request`；非流式回复为 `response`；流式回复为 `stream`。已经开始的 HTTP 尝试会在 `attempt` 的 `failed.failure.diagnostic` 交付相同信息。HTTP 状态从 `status` 读取。

| 实际情况                                   | `reason`                                   |
| ------------------------------------------ | ------------------------------------------ |
| Gemini 的响应 ID 或模型字段已提供但非法    | `invalid-response-id` 或 `invalid-model`   |
| Messages 思考块关闭时仍缺少签名            | `missing-thinking-signature`               |
| 响应流的事件次序不符、或在协议终态之前结束 | `event-order` 或 `missing-terminal`        |
| Responses 无状态回放缺少上一轮推理密文     | `missing-reasoning-ciphertext`             |
| 服务端回显的保存模式或前驱 ID 与请求冲突   | `store-mismatch` 或 `predecessor-mismatch` |

Gemini 流中间事件的 `finishReason: null` 表示这一帧尚未给出终态。Messages 的签名可以随 `signature_delta` 补齐。框架在完整回复或相应块关闭时核验这些事实。模型返回了与业务期望不同的文本或工具选择时，由调用方核对实际内容和业务要求。

## 显式请求重试

各适配器均可通过 `retry` 显式配置 `{maxAttempts, delayMs?, maxDelayMs?}`。不配置时仍只有一次 HTTP 尝试；`maxAttempts` 包含首次请求，必须是正安全整数。初始间隔 `delayMs` 默认 1000 毫秒，等待上限 `maxDelayMs` 默认 30000 毫秒，两者为 0 到 2147483647 的安全整数，上限不得小于初始间隔。后续间隔指数增加并受上限约束。有效的 `Retry-After` 不会被缩短；超出等待上限时直接返回该次 HTTP 错误。调用方 signal 和原有 `timeoutMs` 覆盖全部尝试及等待，不为每次重试重新计时。

启用前，宿主须确认端点只做模型生成，并接受重复推理及可能的重复计费。断线、超时、5xx 或没有收到字节，都不证明服务端没有处理。服务端工具、有副作用的扩展或有状态接口不能自动套用这个许可，须另有明确的效果确认或去重协议。本能力不恢复连接上的旧生成，而是用同一份已校验和编码的请求重新生成；配置与 HTTP 正文固定一次，调用方后续修改输入不会改变重试内容。

只在当前尝试内部确认来源后重试：fetch 失败、响应读取失败、SSE 在对应协议的终态到达前结束，以及 HTTP 408/429/500/502/503/504。响应读取失败报告 `NETWORK`；提前结束的 SSE 仍报告 `ENVELOPE`，尝试诊断 phase 为 `stream`。完整但非法的 JSON、UTF-8、SSE 或回复协议，配置、容量、消费者失败与取消不重试；总超时也不重试。错误码本身不是重发许可，消费者抛出的同类错误不会获得传输来源资格。

每次重试前已释放前次读取器并等待取消清理。任何有效 `ModelReply` 都结束重试，包括 `incomplete` 和 `refused`；后续反馈持久化、业务接纳或工具执行错误不会重新请求模型。Interaction 仍只启动一次发送者，整个尝试循环属于该次发送者生命周期；历史 pending、失败调用和冷恢复不因此取得重新发送的资格。

`ModelControls.attempt` 同步接收冻结的 `ModelAttemptEvent`，attempt 从 1 开始，仅在本次 complete 内编号：

- `started`：准备开始一次尝试。通知可以取消或拒绝发送，因此它不证明 HTTP 已到达服务端。
- `failed`：该次传输或回复接纳失败，携带 `failure.code`、`phase`、可选的 `status` 和协议校验的 `diagnostic`。
- `retrying`：上一尝试已清理，携带 nextAttempt 和 delayMs；仍可能在等待期间取消，不保证下一尝试会启动。
- `completed`：该次取得有效协议回复，携带该次 usage，仍不代表工具执行、业务接纳或持久化成功。

该通知与 emit 的同步消费者规则一致：抛错保留原错误身份，Promise/thenable 拒绝，立即停止后续通知和重试。因此消费者失败后不补发 failed，completed 通知失败也不会变成另一条 failed。无效请求在尝试开始之前拒绝，不伪造尝试事件。等待期间取消或超时不补造新的尝试。

启用重试并消费预览的宿主必须按逻辑请求与 attempt 分隔内容：started 开始新的正文／思考缓存，failed 的片段只能作为失败尝试的临时观察，不能拼接到后续正文、写入正式历史或执行其中的工具参数。最终回复仅来自成功的完整尝试。逻辑调用数、尝试数与工具执行数分别统计；usage 仅描述该份有效回复，不包含失败尝试的成本。失败尝试的费用与用量未知，不能补零，也不能把最后一次 usage 当作所有尝试的总量。

## 容量与范围

各适配器的 `inspectRequest(request)` 都同步返回冻结的 `{requestBytes, wireBytes, limits: {maxRequestBytes, maxWireRequestBytes}}`。`requestBytes` 是共同请求完整 JSON 的 UTF-8 字节数，`wireBytes` 是该适配器实际 HTTP 正文的字节数，包含模型选项、工具目录、交换编码和流式字段。预检复用 `complete` 的校验和编码，只返回计量和限制，在本地即可运行。

`ModelProvider` 上此端口可选，依赖精确发送预算的宿主应在装配时要求它存在。无效或超出框架支持范围时，预检与 `complete` 一样抛出 `ProviderError('REQUEST')`。框架支持范围内，即使超过配置的发送预算，预检仍返回计量；内置 Provider 总返回有效预算 `limits`，自定义 Provider 可省略。预检不冻结输入、不预留额度，也不保证模型上下文 token 容量；实际发送仍重新校验当前请求，修改过输入后必须以本次检查为准。

- `maximumModelRequestBytes` 与 `maximumModelWireRequestBytes` 均为 64 MiB，分别定义公开请求纯 JSON 与编码后 HTTP 正文经回归覆盖的框架支持范围，不代表厂商通用限制、模型上下文容量或可用 token 数。深度最多 64、值数最多 100,000；图片块数、工具数、输出等结构限制不变。
- `ChatCompletionsConfiguration.maxRequestBytes / maxWireRequestBytes` 是独立发送预算，默认各 2 MiB，可显式配置为对应支持范围内的正安全整数。`complete` 使用本次实际计量，在打开传输前执行两个预算；超预算抛出继承 `ProviderError` 的 `ProviderRequestLimitError`，`code` 为 `REQUEST_LIMIT`，`metric` 为 `requestBytes` 或 `wireBytes`，并仅携带数值 `bytes / limit`，不保存正文。共同请求先检查，HTTP 正文随后检查。
- 公开回复、工具结果、反馈仍各限 2 MiB；`maximumModelExchangeBytes` 为 2 MiB，限制单个闭合交换的完整公共 JSON，请求中嵌套的交换也必须符合该独立上限。较大请求只允许累计多个合法材料，不会扩大单份回复或反馈。合法的单项不代表任意累计历史都能继续装入请求。
- 默认总超时 60 秒，涵盖发送与完整读取。`maxResponseBytes` 是独立的实际传输预算，默认 2 MiB，SSE 计入事件封装、注释和思考内容；提高传输预算不会放宽公开回复的纯值上限。
- 一次 complete 默认只有一次 HTTP 请求；显式 retry 仅允许上述有界传输尝试。调用取消保持原 reason，不修改调用者 signal；对独立 Interaction 的生命周期不作推断。
- `ProviderError` 含 code、message、可选 HTTP status 和协议诊断，预算错误另含上述数值计量。宿主可注入 fetch；实现必须遵守 Fetch 取消与重定向语义。
- `thinking` 是 Chat 适配器中由宿主显式配置的 DeepSeek 扩展。Messages 使用独立的配置和原生编码。各适配器在续轮时核对自己的原生格式。

公开 `assertModelRequestNodeCapacity(request, additionalNodes)` 验证请求结构以及可预留的节点数量，用于在反馈产生前检查公共 JSON 结构上限。`maximumFeedbackImages(toolCallId, maxBytes)` 根据调用 ID 和完整反馈的字节预算计算可容纳的最大图片数，小反馈槽可以预留零张。

`assertModelContinuation(request, reservation?, additionalNodes?)` 可在没有 Provider 实例或凭证时核对候选请求。它验证请求和预留；对于绑定原始前缀的 Messages 签名思考和 Responses 服务端续轮，拒绝可能改写该前缀的上下文或图片预留。要在执行工具前同时确认宿主此次选择的部署及其发送上限，将该部署的 Provider 传给 Tool 的 `inspection`。

各适配器都实现同步 `reserveWireBytes(request, reservation)`，用于 Tool 在产生反馈和上下文之前计算整个请求体的保守上界。实际正文计量仍由 `inspectRequest` 提供。[工具预算契约](https://github.com/weiliang0121/capix/blob/main/packages/tool/README.md#预算与等待)

直接调用时，`contextGrowthBytes` 表示一条可选前缀消息引起的公共请求 JSON 字节增长上限，插入时计入数组分隔符。已有消息可能等长替换或移除时传 `mutableContext: true`。图片省略使用每个候选文本标记的完整 JSON 字节数，计算预算时保留被替换图片的空间。`ModelExchanges.previewFeedback` 已按交换给出这些标记的上界，合计值传 `imageOmissionBytes`，各交换的数值传 `imageOmissionByExchange`。

若其余消息固定，且 `messages` 末条已是可选的 user 字符串消息，可同时传 `mutableContext: true` 和 `contextShape: 'trailing-user-text'`。调用方据此承诺只替换该条的文本或移除整条消息。内置 Provider 在已测得的请求上加一次文本增长上限，反馈和图片另行预留。未指定形状时按通用消息的可能变化估算。两种形式都会检查 Messages 签名前缀和 Responses 服务端前驱的续轮约束。

协议参考 [Anthropic Messages](https://platform.claude.com/docs/en/api/messages/create) · [Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/) · [Gemini generateContent](https://ai.google.dev/api/generate-content) · [SSE 标准](https://html.spec.whatwg.org/multipage/server-sent-events.html#event-stream-interpretation)

## 契约与版本记录

- [原生工具调用契约](https://github.com/weiliang0121/capix/blob/main/docs/native-tool-integration.md)
- [按版本查阅 CHANGELOG](https://github.com/weiliang0121/capix/blob/main/packages/model-provider/CHANGELOG.md)
- [MIT 许可证](LICENSE)
