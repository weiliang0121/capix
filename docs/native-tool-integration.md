# 原生模型工具调用

CAPiX 使用三个独立包组合工具调用：Provider 负责模型协议，ModelExchanges 保存固定起点与交换事实，Tool 是串行推进的普通 Group 预设。工具是已登记的 Node / Group，使用自己的资源；模型给出的名称与参数不会直接成为资源权限。

## 责任与调用关系

| 包                                                       | 保证                                                                                                                                   | 不承担                                 |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| [model-provider](../packages/model-provider/README.md)   | Chat Completions、OpenAI Responses、Anthropic Messages 和 Gemini generateContent 的原生调用、完整 ModelReply、SSE 接纳、预算与显式重试 | 工具执行、业务参数判断、任务重做、CP   |
| [model-exchanges](../packages/model-exchanges/README.md) | 固定起点、完整回复、按 toolCallId 的反馈槽位、准确接纳凭据、请求重建                                                                   | 执行节点、资源授权、重发判断           |
| [tool](../packages/tool/README.md)                       | 同源目录与成员、Schema 校验、串行模型／工具推进、预算、可选 CP                                                                         | 任意外部效果幂等、跨实体事务、自动恢复 |
| interaction                                              | 固定请求、独立一次发送、持久反馈与局部等待                                                                                             | 因调用取消终止发送、未知反馈自动重发   |
| runtime / invocation                                     | 结构绑定、本次 Work、父子接纳、窗口关闭、真实交付                                                                                      | 模型协议和宿主业务策略                 |

```text
Tool Group → 模型子调用 → ToolModelResource
                            ↓ 展开交换前缀及可选宿主文本
                       独立 Interaction → Provider
                            ↓ 完整回复
                   ModelExchanges.intake
                            ↓ 工具调用列表
Tool Group → 已登记工具成员 → 接纳映射 → 固定反馈槽
                            ↓ 全部闭合后
                      下一次模型请求
```

Tool 不依赖 Runtime 实现；宿主用普通 Scene、Resources、Runner 装配。完整可运行例子见 [examples/tool.mjs](../examples/tool.mjs)，作者与登记代码见 [Tool README](../packages/tool/README.md)。默认不开 CP。

原生工具调用也可以用于作者自己的模型节点。若业务要自己决定何时结束，普通 Group 可以接纳模型子调用的回复，校验提议、调用登记成员，再用 ModelExchanges 将反馈与原调用 ID 配对，构造下一次请求。使用 Tool 时，这段推进、预检和预算检查由预设提供。自行编排时，作者负责相应的校验和交接。[独立编排模型与工具子调用的回归](../packages/runtime/test/model-exchange-origin.test.mjs) · [Group 的推进与交付](./concepts/structure.md#推进与交付的责任边界)

## 一份完整模型回复

Provider 的 ModelReply v1 保存 id、model、有序 output、termination、usage 和原生协议补充。output 包含有序 text 或 tool-call。Chat Completions 和 Responses 工具调用保留 `{encoding:'json-text',text}` 的原文，Messages 和 Gemini 工具调用保留 `{encoding:'json-value',value}` 的 JSON 对象。Tool 通过 Provider 的公共函数 `readModelToolArguments(call)` 取得参数，再按登记成员的 Schema 校验。

共同字段与 native 合成唯一续接材料，没有另一份可以分别修改的 continuation。Chat Completions 的 reasoning_content 保存在 native 中，后续由 Provider 编码；只保留普通 assistant 文本不能替代精确续接依据。Anthropic Messages 通过 `native.blocks` 保留公共输出的位置、带签名的思考内容和遮盖块。只读取历史时可离线验证材料结构，继续发送还需匹配绑定、配置模型和 API 版本。

Messages 的签名思考与原提示前缀绑定。带签名或遮盖块的回复会记录 `native.prefixSha256`，续轮时校验系统提示、工具目录、此前消息和该次回复。Tool 在本轮工具执行前，离线核对动态上下文或图片淘汰能否改写这段前缀。追加当前工具的结果可以正常续轮。将实际发送者的 Provider 同时传给 `inspection`，还可在执行前核对目标部署、模型和 API 版本。

Chat Completions 的 `stop`、`tool_calls`，Messages 的 `end_turn`、`stop_sequence`、`tool_use`，以及 Gemini 的 `STOP` 可被接纳为 completed。Chat 的 `content_filter`、Messages 的 `refusal`、Gemini 的提示拦截或候选过滤归入 refused。未知结束原因保留原文并归入 incomplete。协议完成不等于工具业务成功。`modelReplyText` 拒绝含工具调用的回复，也不替代非空正文、结束状态等业务检查。

`ToolResult` 为 `{status:'ok'|'error',content:readonly ModelInputContent[]}`，content 接受 1–32 个文本或固定图片块。ToolFeedback 另含 toolCallId。续轮时，Provider 要求回复中的每个工具调用都有准确、完整的反馈，并按原调用顺序编码。不能用措辞暗示错误，也不把工具结果提升为 system 指令。提示策略、结果可信度和资源授权由宿主决定。

公开 requireModelRequest / requireModelReply / requireToolResult / requireToolFeedback / requireModelExchange 在接纳边界完整核验，返回原对象、不冻结或缓存对可变对象的信任；Provider 生成的回复已深冻结。未知字段／版本、重复调用 ID、不完整反馈、getter、循环和非 JSON 值拒绝，错误不含传入正文。原生检查拒绝 Proxy，采用作者保证模式时由宿主提供无代理的数据。[宿主对象检查](runtime-boundaries.md#宿主对象检查)

## 工具登记与业务失败

`new Tool({tools,policyVersion})` 中每个键同时是模型名称与结构成员选择名。登记包含 node、description、input Schema 和 result.succeeded，可选 `result.failed`、`maxOutputBytes` 和 `maxFeedbackBytes`。构造固定配置，一棵树内成员实例唯一；不需要额外工厂、重复 add 或专用 installer。

Schema 只校验，不填默认值、不转换或剔除字段。非法 JSON、未知名称和 Schema 不匹配产生明确错误反馈，不创建工具子调用；Schema 自身故障或改变参数的解析结果终止推进。目录和成员同源，避免模型可见目录与真实可调用成员分叉。

Schema 的解析结果应是与固定模型参数相等的普通 JSON 数据，字段使用可枚举的数据属性。Node 使用原生深比较，比较时可能读取解析结果上的 getter。即使 getter 返回原值并通过 Tool 预检，运行时仍会在固定工具子调用输入时拒绝访问器。非 Node 宿主使用的平台 `default` 分支按属性描述符递归比较，预检在遇到 getter 时终止推进且不会调用它。两个分支都要求工具成员接收固定数据；作者保证模式还要求宿主排除 Proxy 和 JSI `HostObject`。 [宿主对象检查](runtime-boundaries.md#宿主对象检查)

普通业务失败只有显式 result.failed 才映射为反馈。取消、装配、捕获、CP、严格观测及持久故障受保护，不交给模型决定能否继续；子失败已 handled 也不变成子成功。结果映射必须纯且无副作用；允许异步，但尚未保存的接纳在恢复时可能重新执行映射，不能据此承诺幂等。

policyVersion 覆盖 Schema 之外的细化和映射语义。目录摘要还包含 Schema、成员顺序／种类／CP 契约与预算；Zod 升级可能改变摘要并拒绝原恢复依据。同版本任意改变业务实现不在自动可检测承诺内。

## 固定起点与交换实体

ModelExchanges 的起点保存初始消息、请求选项、工具定义、目录摘要、策略版本及可选图片策略。只有工具定义作为目录发送给模型，图片策略用于投影历史反馈。每次 Tool 调用创建独立起点，可共享同一实体；普通资源直接登记实体，不要求父输入 capture。目录不包含 Node、回调、执行映射或端点。origin 引用是内容身份，不能自行授权重发或扩大资源范围。

模型子输入包含 `{origin,exchanges}` 引用。启用 requestContext 且宿主选出字符串时，子输入还包含固定的 `context` 文本。ToolModelResource 在发送边界重建请求。`closed` 核对引用是否构成同一起点下反馈已闭合的有序前缀，`request` 检查组装后的公共请求及其容量。发送前，Provider 按所选协议核验续轮材料和传输限制。恢复执行时还须核验原调用与发送依据。

View 管理业务想读哪些材料，ModelExchanges 保存模型续轮所需的起点、回复和配对反馈。例如，展示界面可以用 View 只选最后一条交换。使用 ModelExchanges 重建续轮请求时，前面的工具调用及其反馈仍须按序纳入，即使界面只展示最后一条。工具节点也可以通过资源读取宿主提供的 View 材料，只把本次操作需要的结果映射为工具反馈。[View 的材料选择](./concepts/entities.md#view-选择要使用的材料) · [ModelExchanges 的固定起点与请求重建](../packages/model-exchanges/README.md)

`requestContext: { maxBytes }` 可在固定初始消息之后、原生交换之前传递一条可替换的 user-role 数据消息。完整标签明确它是低优先级宿主参考数据，不是新的用户指令、授权或模型回复；不伪造 assistant、reasoning、prefix 或工具交换。容量按含标签与消息封套的完整 JSON UTF-8 字节计量，工具执行前还预留下一片段上限；固定起点与真实原生续接材料不变。选材、预算与冷恢复规则见 [Tool 每次请求的宿主材料](../packages/tool/README.md#每次请求的宿主材料)。

模型回复 intake、工具结果 receive 使用真实父子 reception；预检错误 complete 不伪造子调用。准确同内容确认不重复提交；不同来源或正文冲突拒绝。实体可将反馈与凭据同次提交，但不构成工具效果、父接纳与 CP 的统一事务。

快照 v2 包含 origins、entries 和共同 sequence。restore 核对完整起点摘要、前缀归属、顺序、唯一效果来源及反馈槽，不发布变化或重新发送。缺失起点不能从回复补造初始消息或目录。普通 JSON 会把 -0 改为 0，持久适配必须保真，不能将变化后的材料当作同一摘要依据。

同步持久端口成功后才安装并发布；端口抛错或返回异步值为 PersistenceError，写入停止，宿主从权威介质重新载入确认未知结果。发布失败保留已成立事实，不撤回内容，也不授权再次执行工具。

### Responses 的两种续轮

宿主在 Provider 上选择策略。默认 `replay` 发送 `store: false`，展开固定输入、原生输出项和真实工具反馈。`previous-response-id` 发送 `store: true`，后续沿用准确的上一份 `response.id`，只传新增反馈。两种模式均用 `function_call.call_id` 关联工具输出。响应 ID 与输出项 ID 各自保存，工具成员继续使用同一个调用契约。

服务端模式需要与远端一致的历史前缀。Tool 在执行工具前检查将来的上下文替换、旧图片淘汰能否改变已有前缀。普通完成点的冷恢复仍读本地固定材料，能否发起下一次续轮还取决于远端响应是否存在。更换部署、模型或续轮策略时，宿主同步更新可恢复 Tool 的 `policyVersion`。[两种模式的恢复回归](../packages/tool/test/responses-recovery.test.mjs)

### Gemini 的原生 Part 回放

每轮从固定起点和闭合交换重建 `contents`。`native.parts` 保存原生 Part 的顺序、边界和思考签名。公共 `toolCallId` 由回复身份与 Part 位置确定，ModelExchanges 据此接纳反馈，Provider 按原调用顺序回放 `functionCall` 并编码 `functionResponse`。上游提供调用 ID 时原样回传，省略时继续按位置关联，包括同名并行调用。图片反馈以内联图片和同一结果内的 `$ref` 表达。[Gemini Provider 契约](../packages/model-provider/README.md#gemini-generatecontent)

离线读取校验固定回复和签名 Part 的摘要。继续发送还需匹配配置模型与宿主的 `bindingId`。宿主将发送所用的 Provider 注入 `inspection`，Tool 即可在执行成员前核对绑定和下一次请求的容量上界。部分反馈的冷恢复继续使用尚未闭合的槽位，完成点则根据原 Interaction 和已安装的交换核验。[交换快照回归](../packages/model-exchanges/test/gemini.test.mjs) · [Tool 冷恢复回归](../packages/tool/test/gemini-recovery.test.mjs)

## 有界推进与流式

工具串行执行，登记 1–32 个成员；maxModelCalls 默认 1000，接受正安全整数，作为异常循环的兜底，也可由作者显式设置。它统计单次 Tool 调用中的模型请求，包含最终回答，显式恢复不重置；耗尽时抛出带 calls/limit 的 ToolModelCallLimitError，不再启动下一次模型调用，已有工具效果保留。次数属于固定目录配置，改变它会拒绝原 CP。waitMs 默认 30000。

调用次数与 token、上下文及数据容量分别管理。Tool 默认单回复 64 KiB、包含 toolCallId 的完整反馈 4 KiB（图片按含 base64 的实际 JSON UTF-8 字节计量）、展开请求 2 MiB、集合 8 MiB；成员可另限输出。工具派发前保守预留反馈与下一请求，避免已经产生效果后才发现明显无法反馈。提高次数不会扩大这些容量，也不自动压缩历史；实际检查位置与配置见 [预算表](../packages/tool/README.md#预算与等待)。

maxWireRequestBytes 显式设置时要求同步 inspection。内置 Provider 均可作为 `ToolModelSource.inspection` 直接注入。有效 wire 上限下，未知工具反馈或上下文还须由 `reserveWireBytes` 给出该编码的整个请求体上界。预检不发请求、不返回正文或密钥、不预留额度。修改输入后发送仍重新核验。集合、预设和 Provider 各有独立上限；共享调用不形成跨实体预留事务。

Provider 公共组装请求与 HTTP 编码请求分别支持到 64 MiB，默认发送预算各为 2 MiB，宿主通过 `maxRequestBytes` / `maxWireRequestBytes` 显式配置；回复、单份反馈、单个闭合 exchange 仍各受 2 MiB JSON 限制，深度 64、100000 值不变。`inspectRequest` 返回实际计量及配置 `limits`，合法但超过配置预算时仍可测量，`complete` 在发送前再次拒绝超限。Tool 使用自身预算与 Provider 上限的较小值，并在工具执行前独立预留 exchange 容量。默认总超时 60 秒、传输响应预算 2 MiB。合法单项不保证累计历史仍能装入下一请求，限制也不是堆内存或 token 上界。ModelExchanges 默认最多 10000 起点、10000 交换、累计 64 MiB，单起点／交换实体最多 8 MiB；集合容量、传输预算和 CP 的 8 MiB 逻辑图分别验证。

Provider 一次 complete 默认仅发送一次 HTTP，无隐式重试。显式 retry 只在一次发送者内部对固定编码请求作有限尝试；来源确认、取消、等待、计数与预览隔离见 [Provider 重试契约](../packages/model-provider/README.md#显式请求重试)。它不重启 Interaction、Tool 或已失败调用，不重做已执行工具，也不保证服务端推理只计费一次。Tool 的 maxModelCalls 仍统计逻辑模型调用，宿主需要实际尝试额度时通过 attempt 通知另行核验。

Chat Completions 的 SSE 固定回复身份，检查索引、完整终态、usage 与 DONE；缺失或冲突明确拒绝，不回退非流式。只有显式许可下的传输读取失败与提前结束可重试，完整非法协议不重试。DONE 后释放读取，不要求 HTTP 连接先关闭。emit 只发布正文预览，不把工具参数或思考文本作为正文。可选同步 emitReasoning 独立交付供应商公开返回的 reasoning_content 非空增量，宿主决定展示或保存；不改变最终回复与 exchanges 的原始思考材料。可选同步 progress 以 `ModelStreamProgress` 的 `{ kind: 'reasoning' | 'text' | 'tool-call' }` 报告已校验非空流式增量的类别变化，同类连续增量去重；不含思考或工具内容，不表示执行或完成。三个通道均在当前 chunk 完整校验后交付，类别去重不抑制文本增量；空字段和非流式回复不合成预览或进度。消费者失败、取消与流读取清理沿用 emit 规则，已展示的预览不能代替最终回复接纳。准确回调顺序与失败语义见 [Provider 流式契约](../packages/model-provider/README.md#流式与用量)。

Tool 的 stream 可让 Provider 消费 SSE，但预设只交付最终正文，不转交中间候选。stages 仅提供内部结构 ID 供宿主投影真实进度。候选正文、完整模型回复、最终 Transcript 消息、父接纳和 Runner settled 分别表达不同事实。

累计请求构造、集合核算和部分完整关系检查仍读取完整历史；CP 增量选择只降低引用保存成本，不承诺整个模型循环恒定成本。没有自动淘汰、分段或 continue-as-new。

## 显式 CP 与独立发送

checkpoint:true 声明 Tool 与内部模型节点恢复点，要求每个工具成员已有 CP。宿主还须安装 Store、持久 ModelExchanges、Interaction 持久化及原交互查询 recovery.read(id)。Scene 包装不自动获得根恢复契约，上层仍须保存准确子引用并声明 resume。

| 点            | 恢复依据                                                     | 缺失时                     |
| ------------- | ------------------------------------------------------------ | -------------------------- |
| prepared      | 先保存固定起点 ID、目录摘要，再确认建立同一起点              | 不补造起点或换目录         |
| model-waiting | 准确子调用、原 Interaction 请求与已保存反馈                  | 不重发探测                 |
| tools         | 当前交换、游标、派发前保存的准确工具引用、成员 CP 或固定交付 | 不猜效果、不重做失败子调用 |
| completed     | 最终回复、完整接纳与原交互依据                               | 不再次执行模型或工具       |

Tool 的 CP 契约为 v5，内部 completion 为 v3；恢复要求相应契约版本准确匹配，不改写旧请求或持久数据，升级后使用新调用。恢复重新核对输入、目录、交换前缀、原模型回复、工具返回／接纳及效果凭据。父层已接纳后仍确认原模型交互；目录变化、未知反馈、缺首份子 CP、失败终态或不准确来源明确拒绝。外部工具自身效果是否可确认仍由其资源契约保证。

ToolModelPending 携带原交互引用。局部等待到期或调用取消不取消／重发原发送，失败调用也不因引用仍在就变成可恢复。宿主关闭先停止本地入口，再等待自己的独立发送 settled；不能提前关闭反馈存储。过程流只作临时反馈，不能用其 sealed 或游标代替最终持久回复。见 [交互](interactions.md) 与 [Checkpoint](checkpoints.md)。

## MCP 范围

当前没有 MCP 客户端、服务器发现、会话重建、授权、工具目录刷新或远端效果恢复适配。MCP 不是 Provider 的模型续接协议，也不能由 ModelExchanges 的反馈槽自动得到支持。

需要 MCP 的宿主应独立实现资源与明确登记的工具成员，并维护连接、权限、Schema 兼容和效果确认。远端名称、调用 ID 或成功文本不能代替实际授权或恢复凭据；协议错误和未知远端效果不能靠重新发送探测。本指南不承诺 MCP 集成已实现。

## 框架验证

协议选择、各包改动和宿主升级影响见[模型协议适配设计](proposals/model-provider-adapters.md)。

- [兼容端点两轮回归](../packages/tool/test/chat-endpoints.test.mjs)、[Messages 原生协议](../packages/model-provider/test/messages-provider.test.mjs)、[Messages 冷恢复](../packages/tool/test/messages-recovery.test.mjs)使用本仓 HTTP 样本离线运行。
- Gemini 回归覆盖 JSON/SSE 的 Part 保真、原生调用 ID 缺省或存在时的两轮交换、图片反馈及执行前容量预留。[Gemini 请求](../packages/model-provider/test/gemini-provider.test.mjs) · [Gemini 回复](../packages/model-provider/test/gemini-reply.test.mjs) · [Gemini 冷恢复](../packages/tool/test/gemini-recovery.test.mjs)
- [Responses 回复](../packages/model-provider/test/responses-reply.test.mjs)和[两种续轮策略的恢复](../packages/tool/test/responses-recovery.test.mjs)验证本地回放与服务端响应 ID 的边界。
- [Provider 工具协议](../packages/model-provider/test/model-provider-tools.test.mjs)、[流式](../packages/model-provider/test/model-provider-streaming.test.mjs) 和[请求预检](../packages/model-provider/test/model-provider-inspection.test.mjs) 验证接纳、原生续接和大小限制。
- [固定起点](../packages/model-exchanges/test/model-exchanges-origins.test.mjs) 与[恢复](../packages/model-exchanges/test/model-exchanges-restoration.test.mjs) 验证实体独立保存、冲突与缺失依据拒绝。
- [Tool 行为](../packages/tool/test/tool.test.mjs)、[恢复](../packages/tool/test/recovery.test.mjs) 和[类型](../packages/tool/test/types.test.mjs) 使用公开包验证串行推进、失败分流、预算、新 Runner／Store 恢复和拒绝反例。

普通测试离线，不调用真实模型。这些测试证明框架契约，不为任意外部工具、宿主持久适配或实际模型容量背书。
