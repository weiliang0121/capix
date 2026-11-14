# 原生模型工具调用

CAPiX 使用三个独立包组合工具调用：Provider 负责模型协议，ModelExchanges 保存固定起点与交换事实，Tool 是串行推进的普通 Group 预设。工具是已登记的 Node / Group，使用自己的资源；模型给出的名称与参数不会直接成为资源权限。

## 责任与调用关系

| 包                                                       | 保证                                                                 | 不承担                                 |
| -------------------------------------------------------- | -------------------------------------------------------------------- | -------------------------------------- |
| [model-provider](../packages/model-provider/README.md)   | Chat Completions 文本／函数调用、完整 ModelReply、SSE 接纳、请求预检 | 工具执行、业务参数判断、重试、CP       |
| [model-exchanges](../packages/model-exchanges/README.md) | 固定起点、完整回复、按 toolCallId 的反馈槽位、准确接纳凭据、请求重建 | 执行节点、资源授权、重发判断           |
| [tool](../packages/tool/README.md)                       | 同源目录与成员、Schema 校验、串行模型／工具推进、预算、可选 CP       | 任意外部效果幂等、跨实体事务、自动恢复 |
| interaction                                              | 固定请求、独立一次发送、持久反馈与局部等待                           | 因调用取消终止发送、未知反馈自动重发   |
| runtime / invocation                                     | 结构绑定、本次 Work、父子接纳、窗口关闭、真实交付                    | 模型协议和宿主业务策略                 |

```text
Tool Group → 模型子调用 → ToolModelResource
                            ↓ 展开 { origin, exchanges }
                       独立 Interaction → Provider
                            ↓ 完整回复
                   ModelExchanges.intake
                            ↓ 工具调用列表
Tool Group → 已登记工具成员 → 接纳映射 → 固定反馈槽
                            ↓ 全部闭合后
                      下一次模型请求
```

Tool 不依赖 Runtime 实现；宿主用普通 Scene、Resources、Runner 装配。完整可运行例子见 [examples/tool.mjs](../examples/tool.mjs)，作者与登记代码见 [Tool README](../packages/tool/README.md)。默认不开 CP。

## 一份完整模型回复

Provider 的 ModelReply v1 保存 id、model、有序 output、termination、usage 和原生协议补充。output 包含 text 或 tool-call；工具参数保留 `{encoding:'json-text',text}` 的原始字符串。参数非法 JSON 时不擅自修复，业务执行方明确拒绝。

共同字段与 native 合成唯一续接材料，没有另一份可以分别修改的 continuation。Chat Completions 的 reasoning_content 保存在 native 中，后续由 Provider 编码；只保留普通 assistant 文本不能替代精确续接依据。Provider 不承诺其他厂商的原生协议。

`stop` 和 `tool_calls` 是 completed，content_filter 是 refused；其他及未知终止原因保留原文并归 incomplete。协议完成不等于工具业务成功。`modelReplyText` 拒绝含工具调用的回复，也不替代非空正文、结束状态等业务检查。

`ToolResult` 为 `{status:'ok'|'error',content:[{kind:'text',text}]}`；ToolFeedback 另含 toolCallId。Provider 要求每个模型调用都有准确、完整反馈，按原模型调用顺序编码关联。不能用措辞暗示错误，也不把工具结果提升为 system 指令。提示策略、结果可信度和资源授权由宿主决定。

公开 requireModelRequest / requireModelReply / requireToolResult / requireToolFeedback / requireModelExchange 在接纳边界完整核验，返回原对象、不冻结或缓存对可变对象的信任；Provider 生成的回复已深冻结。未知字段／版本、重复调用 ID、不完整反馈、getter、Proxy、循环和非 JSON 值拒绝，错误不含传入正文。

## 工具登记与业务失败

`new Tool({tools,policyVersion})` 中每个键同时是模型名称与结构成员选择名。登记包含 node、description、input Schema 和 result.succeeded，可选 result.failed、maxOutputBytes。构造固定配置，一棵树内成员实例唯一；不需要额外工厂、重复 add 或专用 installer。

Schema 只校验，不填默认值、不转换或剔除字段。非法 JSON、未知名称和 Schema 不匹配产生明确错误反馈，不创建工具子调用；Schema 自身故障或改变参数的解析结果终止推进。目录和成员同源，避免模型可见目录与真实可调用成员分叉。

普通业务失败只有显式 result.failed 才映射为反馈。取消、装配、捕获、CP、严格观测及持久故障受保护，不交给模型决定能否继续；子失败已 handled 也不变成子成功。结果映射必须纯且无副作用；允许异步，但尚未保存的接纳在恢复时可能重新执行映射，不能据此承诺幂等。

policyVersion 覆盖 Schema 之外的细化和映射语义。目录摘要还包含 Schema、成员顺序／种类／CP 契约与预算；Zod 升级可能改变摘要并拒绝原恢复依据。同版本任意改变业务实现不在自动可检测承诺内。

## 固定起点与交换实体

ModelExchanges 的起点保存初始消息、请求选项和模型可见目录。每次 Tool 调用创建独立起点，可共享同一实体；普通资源直接登记实体，不要求父输入 capture。目录不包含 Node、回调、执行映射或端点。origin 引用是内容身份，不能自行授权重发或扩大资源范围。

模型子输入仅传 `{origin,exchanges}` 引用；ToolModelResource 在发送边界重建完整请求。`closed` 核对引用归属于同一起点且为顺序前缀、反馈完整；`request` 再检查协议续接资格与整体请求限额。查询旧前缀不等于取得执行恢复许可，模型发送历史与调用关系仍须准确核验。

模型回复 intake、工具结果 receive 使用真实父子 reception；预检错误 complete 不伪造子调用。准确同内容确认不重复提交；不同来源或正文冲突拒绝。实体可将反馈与凭据同次提交，但不构成工具效果、父接纳与 CP 的统一事务。

快照 v2 包含 origins、entries 和共同 sequence。restore 核对完整起点摘要、前缀归属、顺序、唯一效果来源及反馈槽，不发布变化或重新发送。缺失起点不能从回复补造初始消息或目录。普通 JSON 会把 -0 改为 0，持久适配必须保真，不能将变化后的材料当作同一摘要依据。

同步持久端口成功后才安装并发布；端口抛错或返回异步值为 PersistenceError，写入停止，宿主从权威介质重新载入确认未知结果。发布失败保留已成立事实，不撤回内容，也不授权再次执行工具。

## 有界推进与流式

工具串行执行，登记 1–32 个成员；maxModelCalls 默认 1000，接受正安全整数，作为异常循环的兜底，也可由作者显式设置。它统计单次 Tool 调用中的模型请求，包含最终回答，显式恢复不重置；耗尽时抛出带 calls/limit 的 ToolModelCallLimitError，不再启动下一次模型调用，已有工具效果保留。次数属于固定目录配置，改变它会拒绝原 CP。waitMs 默认 30000。

调用次数与 token、上下文及数据容量分别管理。Tool 默认单回复 64 KiB、包含 callId 的反馈 4 KiB、展开请求 2 MiB、集合 8 MiB；成员可另限输出。工具派发前保守预留反馈与下一请求，避免已经产生效果后才发现明显无法反馈。提高次数不会扩大这些容量，也不自动压缩历史；实际检查位置与配置见 [预算表](../packages/tool/README.md#预算与等待)。

maxWireRequestBytes 显式设置时要求同步 inspection，可用 Provider.inspectRequest；预检不发请求、不返回正文或密钥、不预留额度。修改输入后发送仍重新核验。集合、预设和 Provider 各有独立上限；共享调用不形成跨实体预留事务。

Provider 共同请求／回复／反馈为至多 2 MiB JSON、深度 64、100000 值；HTTP 编码请求另受 2 MiB 限制。默认总超时 60 秒、传输响应预算 2 MiB。合法单项不保证累计历史仍能装入下一请求，限制也不是堆内存或 token 上界。ModelExchanges 默认最多 10000 起点、10000 交换、累计 64 MiB，单起点／交换最多 8 MiB；较大实体容量不会放宽 Provider 限额。

Provider 一次 complete 仅发送一次 HTTP，无隐式重试。SSE 固定回复身份，检查索引、完整终态、usage 与 DONE；缺失或冲突明确拒绝，不回退非流式或重发。DONE 后释放读取，不要求 HTTP 连接先关闭。只发布正文预览，不把工具参数或思考文本作为正文。

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

恢复重新核对输入、目录、交换前缀、原模型回复、工具返回／接纳及效果凭据。父层已接纳后仍确认原模型交互；目录变化、未知反馈、缺首份子 CP、失败终态或不准确来源明确拒绝。外部工具自身效果是否可确认仍由其资源契约保证。

ToolModelPending 携带原交互引用。局部等待到期或调用取消不取消／重发原发送，失败调用也不因引用仍在就变成可恢复。宿主关闭先停止本地入口，再等待自己的独立发送 settled；不能提前关闭反馈存储。过程流只作临时反馈，不能用其 sealed 或游标代替最终持久回复。见 [交互](interactions.md) 与 [Checkpoint](checkpoints.md)。

## MCP 范围

当前没有 MCP 客户端、服务器发现、会话重建、授权、工具目录刷新或远端效果恢复适配。MCP 不是 Provider 的模型续接协议，也不能由 ModelExchanges 的反馈槽自动得到支持。

需要 MCP 的宿主应独立实现资源与明确登记的工具成员，并维护连接、权限、Schema 兼容和效果确认。远端名称、调用 ID 或成功文本不能代替实际授权或恢复凭据；协议错误和未知远端效果不能靠重新发送探测。本指南不承诺 MCP 集成已实现。

## 框架验证

- [Provider 工具协议](../packages/model-provider/test/model-provider-tools.test.mjs)、[流式](../packages/model-provider/test/model-provider-streaming.test.mjs) 和[请求预检](../packages/model-provider/test/model-provider-inspection.test.mjs) 验证接纳、原生续接和大小限制。
- [固定起点](../packages/model-exchanges/test/model-exchanges-origins.test.mjs) 与[恢复](../packages/model-exchanges/test/model-exchanges-restoration.test.mjs) 验证实体独立保存、冲突与缺失依据拒绝。
- [Tool 行为](../packages/tool/test/tool.test.mjs)、[恢复](../packages/tool/test/recovery.test.mjs) 和[类型](../packages/tool/test/types.test.mjs) 使用公开包验证串行推进、失败分流、预算、新 Runner／Store 恢复和拒绝反例。

普通测试离线，不调用真实模型。这些测试证明框架契约，不为任意外部工具、宿主持久适配或实际模型容量背书。
