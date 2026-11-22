# 模型协议适配与宿主接入

宿主按部署端点支持的 API 选用 Provider。同一套 harness 发送 `ModelRequest`，从 `ModelReply` 读取正文、工具调用和结束状态。CAPiX 直接实现四种 HTTP 协议，共用传输实现，优先使用 Provider 配置传入的 `fetch`，省略时使用 `globalThis.fetch`。账号可以调用哪些模型、各模型在哪些端点可用，由宿主配置。[适配器与配置示例](../../packages/model-provider/README.md)

## 新端点接在哪里

| 端点协议               | 复用的适配器                    | 工具续轮依据                                                                                                                          |
| ---------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Chat Completions       | `ChatCompletionsProvider`       | 按调用 ID 回传反馈，保留原始参数文本以及上游返回的 `reasoning_content`。OpenAI 兼容端点可共用此实现。                                 |
| OpenAI Responses       | `OpenAIResponsesProvider`       | 默认 `replay` 发送显式历史并请求 `store: false`。宿主选择 `previous-response-id` 时发送 `store: true`，按前驱响应 ID 与本轮反馈续接。 |
| Anthropic Messages     | `AnthropicMessagesProvider`     | 按块顺序回放模型轮次，按 `tool_use_id` 回传结果，保留签名思考与遮盖块。                                                               |
| Gemini generateContent | `GeminiGenerateContentProvider` | 保留有序 Part、思考签名及可选的函数调用 ID。上游省略调用 ID 时，按 Part 位置对应工具反馈。                                            |

兼容已有协议的新部署通常只需配置端点、认证与模型，加一份能覆盖实际差异的样本。遇到新的请求字段或事件形状，应在相应适配器中验证 JSON、SSE 和工具续轮。新增原生协议才需要新的编码器、解码器以及版本化的历史校验。各协议的公开能力与配置约束见 [Provider README](../../packages/model-provider/README.md)。

## 为什么边界落在这三个包

- **model-provider** 拥有 HTTP 编码和字节测量、SSE 事件、结束原因、用量以及下一轮请求的重建。四个适配器共用传输、取消和重试；完整回复按 `native.format/version` 交给对应协议校验。宿主通过 `readModelToolArguments` 读取工具参数，原始参数继续随回复保存。[协议分发](../../packages/model-provider/src/native-reply.ts) · [公共回复契约](../../packages/model-provider/src/contract.ts)
- **model-exchanges** 持有固定起点、按序交换和反馈槽。普通载入只需公开回复校验器。工具执行前预览下一轮时，实体复用实际发送时的图片保留规则，不会写入反馈。[交换实体](../../packages/model-exchanges/README.md)
- **tool** 拥有成员登记、执行与恢复。工具执行可能产生外部效果，所以 Tool 在派发前用公共接口核对历史能否续接，并预留新反馈和上下文的容量。具体编码的开销由 Provider 计算。Runtime、Interaction 与 Checkpoint 沿用原有调用契约。[预检与恢复](../native-tool-integration.md) · [容量检查](../../packages/tool/src/budget.ts)

## 回复身份与用量

- **Gemini 回复身份。** 早期实现把 Chat 回复的身份要求套在了 Gemini 上，省略 `responseId` 或 `modelVersion` 的完整文本也会被拒绝。现在 JSON 和 SSE 共用接纳规则：有上游值时保留原值，省略的 ID 在接纳时生成一次，省略的模型版本使用配置模型，并分别标记来源。工具反馈槽使用已保存的回复 ID 和 Part 位置；发给上游的函数反馈只携带上游实际提供的调用 ID。[Google 回复类型](https://googleapis.github.io/js-genai/release_docs/classes/types.GenerateContentResponse.html) · [JSON/SSE 回归](../../packages/model-provider/test/gemini-reply.test.mjs) · [冷恢复](../../packages/tool/test/gemini-recovery.test.mjs)
- **Messages 部分用量。** 上游只报告普通输入和输出时，缺少缓存读写计数，总输入仍未知。适配器保存已报告的原生计数，宿主用 `modelReplyUsage(reply)` 可直接读取已知的公共字段。公共 `reply.usage` 和 attempt 完成事件继续提供完整统计或 `null`。[官方流式示例](https://platform.claude.com/docs/en/build-with-claude/streaming#basic-streaming-request) · [计量与快照回归](../../packages/model-exchanges/test/messages.test.mjs)

Messages 的思考块仍须提供协议要求的签名，Responses 若回显与请求相反的存储策略也会被拒绝。这两个条件分别影响下一轮能否准确回放、上游是否按宿主要求处理存储。[Messages 工具回放](https://platform.claude.com/docs/en/build-with-claude/thinking-tool-workflows) · [Responses 会话状态](https://developers.openai.com/api/docs/guides/conversation-state)

## 宿主升级影响

具体 Chat 适配器保留原返回类型和已存回复形状。升级通用 harness 时，分别验证以下三条实际调用路径。

| 宿主路径             | 接线与验收                                                                                                                                                                                                                                                                                                                                                                            |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 第一次工具调用       | 将实际发送请求的内置 Provider 作为 `ToolModelSource.inspection`。若封装检查器，用同一实例同步转发 `inspectRequest(request)` 与 `reserveWireBytes(request, reservation)`。启用 wire 上限时，纯文本首轮成功仍可能在首个工具派发前因缺少预留能力失败。用一个可计数的工具验证一次执行、两次模型请求和最终正文。[Tool 检查器](../../packages/tool/README.md)                               |
| 工具参数与日志       | 执行工具时用 `readModelToolArguments(call)`。记录参数字节数时按 `call.arguments.encoding` 分支，`json-text` 量原始 `text`，`json-value` 量 `JSON.stringify(value)` 的 UTF-8 字节。这个数表示参数大小；完整请求体的字节数由 `inspectRequest` 提供。访问协议专属数据前按 `reply.native.format` 收窄。[公共类型](../../packages/model-provider/src/types.ts)                             |
| 交付复核与结构化结果 | 单独构造复核请求，将系统指令放在首个用户消息之前，待复核材料放入用户消息。当前 Messages 适配器拒绝 `responseFormat: 'json_object'`，可在指令中要求 JSON，再由宿主解析并校验业务 schema。Gemini 等支持该选项的部署可显式启用它。用实际 Provider 的 `inspectRequest` 核对出站请求，再验收最终正文、`termination.kind` 和解析结果。[适配器配置](../../packages/model-provider/README.md) |

交换快照维持 v2，读取某种原生回复需要包含该校验器的包版本。可恢复 Tool 的目录预检策略由 v4 升至 v5，旧目录下的调用即使仅用 Chat 也会拒绝恢复，已有材料保留。Tool CP 仍为 v5，模型节点 CP 仍为 v3。[恢复边界](../development-compatibility.md)

## 验收口径

| 要回答的问题                 | 可以作为依据的结果                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 框架是否编码、解析并可靠续轮 | 离线用同一轮的 JSON 与 SSE 样本验证正式回复、下一份请求及字节数；加入多个同名工具调用、实际反馈和持久快照，核对冷恢复后的发送数和执行数。[Chat 两轮](../../packages/tool/test/chat-endpoints.test.mjs) · [Messages](../../packages/tool/test/messages-recovery.test.mjs) · [Responses](../../packages/tool/test/responses-recovery.test.mjs) · [Gemini](../../packages/tool/test/gemini-recovery.test.mjs) |
| 账号的某个模型是否可用       | 按模型与端点的文档或已知路由选取组合，分别记录网关返回的正文与终态、Provider 是否接纳、业务断言是否通过。记录 JSON 或 SSE、工具是否真实续轮，以及标记是包含还是精确回显。                                                                                                                                                                                                                                  |
| 官方模型是否已在线验证       | 需要有对应模型及官方端点的观测记录。网关转换只证明所测账号和路由。图片生成、嵌入、重排使用各自 API，单独记载。                                                                                                                                                                                                                                                                                             |

## 最初的改动量评估

基线提交 `107098af4362` 仅实现 Chat。当时估算复用 Chat 接入一个兼容端点需 1–2 人日，出现一至两个请求字段差异时为 2–3 人日；新增 Messages 并验证可恢复 Tool 另需 11–18 人日。这些数字是初始两协议范围的排期估算，未统计后来加入的 Responses、Gemini 或真实账号联调工时。最终实现的生产改动集中在上述三个包，包外通过独立安装 tarball 的消费者核对类型与运行行为。[分发消费者](../../scripts/release/fixtures/consumer.mjs) · [版本与发布](../npm-publishing.md)
