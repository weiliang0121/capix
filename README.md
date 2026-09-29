# CAPiX Observer

独立的 TypeScript 运行链路实验：运行三次模型调用，观察真实的输入、调用、返回和异常。

观测用于理解当前系统。没有文件导入、导出或重放，也没有为离线文件设计的版本兼容、独立消息来源、恢复对象。

## 当前链路

```text
initializeObserver(provider, messages?)
  → Transcript / Book / Index / Clock / Recorder / Runtime
  → ObserverExecution（固定 selection / generation / extraction 实例）

外部 ExecutionRequest { messages }
  → acceptExecutionInput：向已有 Transcript 追加一批新消息
  → 最后一条只读 user Message → Execution.input
  → 读取本轮开始时的 previousMemories
  → selection.call({ message: input, memories: previousMemories }) → selectionOutput
  → generation.call（内部组合消息、准备请求、调用模型、接纳结果）→ generationOutput
  → 追加 assistant 消息
  → extraction.call（previousMemories + 当前 QA + 可见原文）
  → 接纳变更 → Memories.apply 创建/更新并登记 MemoryRecord
  → 更新后的记忆供下一轮 selection 使用
  → generationOutput → Execution.output
```

Transcript 只增不改删，包含第一条和当前消息。接纳时检查角色及非空正文，复制冻结每条消息；批量追加先全部检查，保留原文。get/current 返回同一不可变消息，snapshot(end) 只复制前缀数组。current(role) 是该角色最新消息，不表示问答配对。

本次 input 只有 role/content。ExecutionContext 在开始时固定 settings 的不可变取值与 TranscriptRangeRef [activeStart,end)，范围包含本次输入；历史选择排除末条。外层修改配置或追加消息不会改变进行中的执行，下一次执行才捕获新的配置与范围。模型操作从所属 ExecutionContext 读取配置；消息只在需要时从固定范围读取。

服务启动时初始化一个本地 Observer 环境，Runtime 创建并持有 Transcript、Memories 和消息选择计数。可以传入初始消息数组，按正常接纳产生内容记录；初始化不产生调用 Context 或模型调用。环境、消息与记录跨请求保留，进程退出后消失。当前不提供多环境路由、持久化、清空或恢复接口。

请求只提交 1–501 条新消息，最后一条必须是 user；批量接纳失败不写入任何条目。HTTP 入口先检查本次配置，再接纳消息；当前仅接受串行调用，正在执行时拒绝新调用且不追加消息。已接纳消息不会因执行失败被删除。前端只编辑待追加草稿，已有消息从服务端读取，不再重发全部历史。

## 操作、运行与记录

`Operation<I,O>` 提供统一 call 与抽象 execute。具体操作自行组合具名 Attempt，数量和顺序由工作决定。BCA 只用于分析这些动作，不再作为执行接口、阶段枚举或记录分类。

`Attempt<I,O>` 是最底层抽象执行类，call 委托复用的 AttemptInvocationBuilder，通过 AttemptContextBuilder 建立现场，再由独立 Invocation 调用具体 execute。实例定义 name/label/source/callee，持有稳定依赖；每次调用的输入、上下文、结果独立。内部只组合普通函数，不再细分执行层级。Operation 在构造时创建所需 Attempt 实例，跨调用复用；不建立统一的动作列表解释器或新的调度系统。

当前三个操作的真实组合：

```text
SelectHistory  → PrepareModelRequest → InvokeModel → AcceptModelOutput
GenerateAnswer → AssembleContext → PrepareModelRequest → InvokeModel → AcceptModelOutput
ExtractMemory  → PrepareModelRequest → InvokeModel → AcceptModelOutput → ApplyMemory
```

消息组装是生成回答内部的 Attempt。记忆接纳与落实是两个不同动作，因此合法结果已取得、但变更落实失败可以分别观察。模型请求容量、输出解析与检查仍由对应动作组合普通函数完成，不为每个函数创建执行对象。

`Execution<I,O>` 的 call 建立 ExecutionContext 并调用具体 execute。ObserverExecution 持有筛选、生成和记忆三个 Operation，在生成成功后追加助手消息，然后执行记忆提取。实例不保存本次调用状态，操作原始输入、执行配置与消息范围仍通过上层 Context 引用取得。三层调用共享 execute/receive 接入，具体业务目前默认一轮；不自动重发模型请求或恢复。

```ts
const environment = initializeObserver(provider); // 请求到来前

const generationOutput = await environment.execution.submit(() => acceptExecutionInput(environment.transcript, request), { settings, signal }); // Runtime 先占用，再接纳输入；消息范围在调用开始时固定。
```

环境初始化、请求接纳、执行组合和观测响应分别位于 observer/environment.ts、accept.ts、execution.ts、observe.ts。observeExecution 用 Execution.submit 的 started 回调取得 Context ID，在首条记录发布前绑定本次调用，按 contextId 筛选记录，结束时解除订阅。它不再通过 input 对象身份关联记录。

记录创建发生在 Context 创建之后，工作执行之前。对应记录 Helper 在这个边界直接读取已有 Operation 实例的描述及现场父 Context；Attempt 的源码和参与者描述也从现场执行实例读取。Context 不携带这些描述、不保存 declaration；记录固化信息后，完成/失败只依据 Context 登记结果。不新增长期的实例关联表。

可调用实例与 Context 为 1:N；开启记录时，每个 E/O/A Context 对应一条同层 Record。复用 Operation 的 operationInstanceId 保持不变，每次调用的 Context ID 与 Record ID 独立产生。记录容器保留所有调用，而非被新请求替换。

GenerationOutput 只表达生成操作的输出契约，不是独立的 Answer 运行实体。浏览器消费同一契约，所以其数据声明位于 protocol/src/generation.ts。GenerationInput 使用 selection 与 memories；内部 AssembleContext 产生 message 与 selectedMessages，模型装载中的 message 保留 role/content。

回答输出在 operations/answer/output.ts 使用 Zod 配对生成 JSON Schema 与本地接纳检查。严格拒绝额外字段、非法分类和空白正文，不自动转换或修剪内容；接纳返回新普通对象。结构失败仍为 OUTPUT_SHAPE，detail.issues 保留字段路径与原因。共享 GenerationOutput 保持纯数据类型，通过 Schema 的类型约束检查兼容性，不从 protocol 反向导入服务端。记忆提取在 operations/memory/output.ts 同样用 Schema 定义 create/update 的结构并推导 MemoryExtraction，保留来源去重和长度限制。结构接纳后继续检查目标、来源和无变化更新；这些语义规则独立于 Schema。历史筛选也使用 Zod，保留空结果和优先级，结构通过后再检查本轮索引范围。model/schema.ts 复用文本与索引规则，非空白和去重要求同时进入提示 Schema 与本地检查。JSON 解析及执行重试不归 Zod。settings.ts 用 Zod 接纳配置，保持原有已知字段选取与数值边界。

| 对象                  | 职责                                                                      |
| --------------------- | ------------------------------------------------------------------------- |
| InvocationContext     | UUID、初始 input、当前轮 currentInput/progress 与终态；持有真实 IO 与异常 |
| ExecutionContext      | 整次运行；固定配置浅快照、Transcript 范围与 AbortSignal 引用              |
| OperationContext      | 一次操作调用；executionContext 引用和本次 IO/状态                         |
| AttemptContext        | 一次动作调用；operationContext 引用和本次 IO/状态                         |
| Runtime               | 持续消息与记忆、顶层运行占用和上下文读取                                  |
| Invocation            | 单次调用的现场、execute/receive 循环和调用记录生命周期                    |
| Transcript / Memories | 各自内容的审查、变更与变更记录登记                                        |
| RuntimeRecorder       | 通用 add/update/subscribe、登记错误隔离；不解释记录种类或生成快照         |
| RecordBook            | add/get/values，保存记录实例、拒绝重复 ID                                 |
| RecordIndex           | selector→key→IDs；显式登记、查询和移除                                    |
| 各 RecordHelper       | 对应记录的创建、关系检查、登记与结果写入                                  |
| Clock                 | 现实时间 now() 与单调时间 tick()                                          |

对应的 InvocationBuilder / ContextBuilder 建立本次调用与现场，`Invocation.run()` 统一入口检查、开始登记、本地循环和终态登记。开始登记失败不执行工作；成功结果登记失败不重新进入工作失败处理。工作失败且失败登记也失败时，AggregateError 保留两个异常。EOA 主链统一通过 Invocation 执行，构造器由 Runtime 装配后持续复用；每次调用的信号与输入不保存到构造器。具体结构见 [调用与上下文构造](docs/runtime-boundaries.md)。

Runtime 可以不接 Recorder。接入时，工作完成先更新 Context，再登记记录；登记异常不改写已发生的工作结果。observer/observe.ts 只将完整登记的工作失败作为观测结果返回。当前没有登记补偿或进程恢复。

## 本地执行与接收

三层调用采用同一结构：call → execute → receive → complete/fail。receive 接收本轮成功结果或失败，各具体类决定后续；默认返回成功结果或传播原错误。需要继续时显式返回 context.continueWith(nextInput, reason)。没有通用 retry/skip/fallback 策略表。

maxRounds 默认 1，具体类可设为 2，均包含首次执行；不接受更大值。每轮开始检查取消。次数耗尽、无效继续原因、接收自身异常明确退出；登记失败不能触发本地恢复。原有模型单次超时仍有效，这不是通用的抢占或恢复机制。现有筛选、生成、记忆链路未开启重复执行。

同一调用内 Context 身份不变：input 是初始引用，currentInput 是当前轮输入，progress 表达当前轮次、执行/接收位置及 execute 结果。continueWith 不重置初始输入，不改写已结束的子调用。运行可不接 Recorder，处理分支不依赖记录。

一条调用记录的 value.processes 按序追加执行、接收和停止事实，不为内部条目生成 ID 或独立记录。正文登记时复制冻结，保留每次输入、结果、接收决定与继续/退出原因。E/O/A Record 共用 InvocationRecord 的追加和终态方法，Book 仍只管理记录。RuntimeRecorder 在追加后通知记录变化，Observer 订阅侧组织执行快照，调用详情可展开完整过程；call/return/throw 时序事件的含义与数量不变。

记录失败通过 RecordingError 保留原始 cause，并阻止父层把它当成可重做的工作错误；错误和错误登记同时失败则保留两个原因。记录失败不撤销已经发生的运行事实，也不补造未登记的条目。

## 事实引用与观测

记录不要求自包含。ExecutionRecord 保存本次 settings 快照与固定 Transcript 范围引用；OperationRecord 通过 executionId 关联，AttemptRecord 通过 operationId 关联，不重复保存这两项。

普通过程数据在登记边界复制冻结，包括简单输入消息与实际模型请求。TranscriptRangeRef 是不可变范围引用，保持原实例，不遍历或复制整个 Transcript。历史选择从执行范围读取候选，组装操作输出选中的普通消息内容和索引，不把整个集合引用放回操作 IO。

Runtime.getExecutionContext/getOperationContext 沿 AttemptContext.operationContext → OperationContext.executionContext 直接读取上层上下文，不需要登记表或 Record，调用完成后仍可读取。Runtime 不维护活动子调用集合，当前串行流程通过 await 保证结束顺序；手动提前结束父调用不受通用运行管理保护。父调用已结束、嵌套调用属于不同执行和重复结束仍直接检查。

ExecutionRecordHelper.snapshot 查询已有记录；HTTP observeTranscript 在展示时展开执行范围为 start/end/messages。执行详情的 EXECUTION CONTEXT 展示配置与范围，输入区域单独显示本次消息。当前没有持久化、独立来源副本或恢复机制。

浏览器据同一组记录投影时序与详情。记录状态、输入输出、错误是观察依据；耗时、CallSpan 和 TraceNode 是派生视图。可选 GET /api/observe 在执行期间发送完整观测更新，尚未实现记录增量传输。POST /api/run 独立交付回答及处理状态，对话不依赖观测。首次加载使用轻量概览，完整快照与源码在打开详情时按需查询。

```text
RuntimeRecord<T>：id + value
  ExecutionRecord：整次运行，contextId；value 中保存本次配置与消息范围
  OperationRecord：一次操作调用，contextId / executionId / operationInstanceId / parentOperationId?
  AttemptRecord：一次动作调用，contextId / operationId / name / label
  EventRecord：一次调用边界，executionId / callId / sequence / occurredAt / offsetMs；value.type
```

operationInstanceId 指向可复用的 Operation 实例；OperationRecord.id 和 OperationContext.id 各自标识一次调用。Context 直接引用上层 Context；Record 归属 ID 指向 Record。三种记录自身 ID 与 Context ID 不同，顶层 contextId 关联对应调用现场。状态在调用记录顶层，由 InvocationRecord 共用实现；RuntimeRecord 基类不规定状态。

当前完整成功链路为 1 条 Execution、3 条 Operation、11 条 Attempt、30 个 call/return/throw 边界事件。数量来自实际组合，不是框架限制。没有执行的动作不创建记录；Attempt 失败不自动更改父操作状态，异常按实际调用链传播。接纳失败保留模型原始返回，落实失败保留已接纳结果，不假装运行事实回滚。

EventRecord 继承 RuntimeRecord，自己的 id 与 callId 不同：callId 指向被描述的 E/O/A 调用记录。EventRecordHelper 负责创建和查询，Book 保存原记录，eventIndex 按执行 ID 查询，不另保存事件数组。sequence 为执行内顺序；occurredAt 为现实时间，offsetMs 使用单调时钟，现实时间回拨不改变时序。Runtime.invocationRecordIndex 维护调用关联查询；Runtime.recording 在调用记录过程中保存单调计时起点，终态边界登记后释放。事件记录没有 Context 或运行状态，不承担推进或消息传递；validateSnapshot 检查记录身份、归属与边界一致性。

错误内嵌在 value.error。RuntimeErrorHelper.format 保留名称、code/message、堆栈、cause 与复合 errors；不可记录的诊断内容转为明确标记，不执行 detail 的 getter/toJSON。ErrorTraversal 管理一次格式化的预算与递归路径。没有独立错误记录或异常还原功能。

## 启动与检查

固定工具链：Node **22.23.2**、pnpm **10.7.1**、TypeScript **6.0.3**。一个根 Workspace、一个锁文件。

```sh
pnpm install --frozen-lockfile
cp .env.example .env
# 仅在本机填写 DEEPSEEK_API_KEY。
pnpm build
pnpm start
```

默认打开 http://127.0.0.1:4317 。可以通过 PORT 指定其他端口。服务只监听本机，生产入口同时提供 Vite 构建产物与 API。Key 不进入配置响应或观测数据。进程退出后内存消息与记录丢失。

开发界面：先在另一个终端运行 `PORT=4320 pnpm start`，再运行 `pnpm dev`；Vite 的 `/api` 代理默认指向 4320，可通过 `OBSERVER_API_ORIGIN` 修改。服务端源码更改后需重新构建和重启；Vite 自动更新前端。没有为开发增加进程恢复或数据导入。

```sh
pnpm check
```

检查包括各包构建/类型、现有运行链路测试、HTTP 契约、跨包依赖边界、图谱布局与搜索、格式。单元测试使用注入的返回，不访问模型。真实模型检查仍是显式运行的 `test/live/memory.mjs`。

## 怎样观察

- 左侧运行图谱、右侧完整对话；对话独立滚动，输入器固定底部。
- 文本搜索覆盖完整用户和助手正文，导航显示命中片段。输入只高亮，切换命中或点击导航时定位问答。
- 紧凑问答导航有独立横向滚动，固定块宽。主图每轮等宽，有最低阅读宽度；调整密度只改变主图，不改变导航块大小。
- 轮内执行、操作、意图按真实单调计时比例布局。不同轮不共享耗时宽度比例；轮间不存在被省略为零的真实等待时间含义。
- 上下文行展示本轮关联的历史、可见记忆和记忆变更入口。选中历史不等于最终容量装载成功，可见记忆不代表模型实际使用；实际请求和依据通过详情核对。
- 深灰背景，蓝色标识当前查看，状态以文字 tag 展示；操作类别使用稳定的淡色，意图沿用所属操作颜色。耗时不再映射颜色。
- 点击节点打开详情，查看 IO、执行/接收过程、记录中的上下文、当轮记忆与变化、执行源码。完整快照按需读取，不为首次绘图预取所有正文。
- 当前查看、主图可见范围和本轮引用是不同状态。导航与图谱状态留在前端，服务端只发布运行事实与记录。

容量检查发生在完整模型请求装载后。当前以请求 UTF-8 字节数加余量估算输入容量，再加预留输出 token；不是精确 tokenizer，也不保证供应商一定接纳。历史选择超限时，在下一轮开始前切换当前消息段；旧段保留，优先保留最近两轮完整 QA，预算不足降为一轮、零轮；消息对象和绝对索引不变。当前输入加记忆本身超限仍失败。选择结果要求模型按相关性与必要性从高到低返回索引；这是模型指导，不保证排序质量。生成请求按该顺序纳入完整消息，遇到第一条放不下的就停止，不跳过长消息凑容量；第一条就放不下则失败。保留的前缀在最终请求里恢复原始时间顺序。当前输入和固定请求内容不裁剪，容量处理不生成摘要、不额外调用模型、不自动修复或重试。生成 PrepareModelRequest 的输入保留候选顺序，输出记录最终请求，可以对照检查实际采用了哪些历史。

## 目录与依赖

```text
protocol/src/               跨端消息、记录、观测与 HTTP 契约
server/runtime/src/         EOA、Context、调用循环、Transcript、Memory、记录与错误
client/runtime/src/         Headless 客户端：接入接口、提交、查询、观测状态与快照缓存
client/http/src/            HTTP 基类、Observer 业务子类、响应接纳与记录流校验
services/observer/src/       当前场景、具体操作/意图、模型适配器与 HTTP 入口
apps/observer/src/           React 界面、shadcn/ui 源码组件、图谱与详情投影
docs/                       对象职责与协议说明
test/                       运行、边界、HTTP 和前端纯逻辑测试
```

服务、客户端 Runtime 与应用都依赖 `@capix-observer/protocol`；服务装配 `@capix-observer/runtime`，应用装配 `@capix-observer/client-runtime` 与 `@capix-observer/client-http`。HTTP 包依赖客户端 Runtime 的接入接口，客户端 Runtime 不依赖 HTTP 实现。运行内核不依赖服务，前端不依赖服务端。跨包只使用公开出口。协议不包含 ModelRequest、Provider、Trace、像素布局、颜色或交互状态。具体接口、身份、时序和流式更新规则见 [跨端协议](docs/protocol.md)。

这次借鉴 CAPiX 的依赖方向与工程组织，不迁入 Graph/TRS，不创建公共 UI 包、调度与持久化能力。Observer 当前运行对象和场景语义保持不变。客户端 Runtime 从原 React 页面抽离现有能力；应用由绑定层订阅 Runtime、整理观测数据并写入 Zustand Store；组件只消费 Store 与明确的 props，提交与查询通过绑定层命令进入 Runtime。使用方式与职责见 [客户端 Runtime](docs/client-runtime.md)。

通用数据操作优先使用 es-toolkit 的公开分类入口，直接具名导入，不额外建立工具转发层。当前已用于记录字段投影、消息排序/去重及记忆正文比较；服务端基础类型判断统一使用库的同语义函数，分类入口缺少的数组、对象范围、有限数和安全整数判断通过 compat 具名导入。简单展开、原生集合和领域类身份检查仍保留。pick 仅取自身字段，类 getter 显式读取；正文比较保持来源索引顺序。快照、引用保留、错误转换继续由对应概念负责，不默认套用深合并或深拷贝。浏览器模块由 Vite 统一构建，工具库仍通过公开入口使用。

服务端错误转换、Provider、Transcript、Memory 和记录正文使用同语义的标准类型谓词；错误字段由固定字段表和 zipObject 组织。跨 realm 原生错误仍用 Node 的 isNativeError，专用对象范围、循环检测、访问器隔离和转换预算保留原有规则。工具函数替换不改变错误代码、正文或身份语义。

运行内核及场景使用 zod@4.6.5 和 es-toolkit@1.52.0；界面使用 React、Vite、Tailwind 与按需接入的 shadcn/ui 源码组件，精确版本见各包清单。尚未实现数据库、TRS、工具执行、调度、模型自动重试、恢复或持久化队列；不为这些未来功能预先增加当前运行链路之外的对象。

筛选结果仅包含所选原文索引，保存在操作上下文与记录中，不写入消息列表。Transcript 仅保留接纳的 user/assistant 消息与正式生成的回答。Jev 筛选与热区装载尚未接入。消息关联计数保留，但不参与模型输入。

历史选择计数：在上下文关联与详情中展示累计被选次数，点击查看原文和调用。数据由当前进程已有筛选操作记录推导，刷新后仍可查看；进程退出即丢失。只统计已接纳的筛选结果，后续回答失败仍计入，不表示回答实际使用或判断正确。次数不传给筛选或生成模型；候选范围仍为全部可见历史，计数不引起额外模型调用。

## 回答后的记忆提取

第三次模型调用返回零到四项创建或更新提议，每项明确目标、变化说明、依据与变更后完整内容。Memories.apply 先检查整批再落实；Runtime 持有的 Memories 保存持续身份的 Memory，更新不新建身份。每次落实产生独立 MemoryRecord，继承 RuntimeRecord，关联 memoryId、executionId、operationId，保存本次变化说明和结果快照。

页面直接读取这些记录显示变化，点击记忆体可以查看当前理解、历次变化及调用关联。每轮开始从Runtime 的 Memories 取得 previousMemories 的正文快照，筛选、回答和本轮提取使用同一份旧记忆。筛选输入为 message + memories，原始 history 从执行固定范围读取；记忆不插入 Transcript，计数不发送给模型。生成接收 message + 选中原文 + previousMemories；提取接收 previousMemories + 本轮 QA + 当前段筛选原文，不沿来源加载旧段，落实后下一轮筛选读取更新后的记忆。三次实际模型请求都由原有 AttemptRecord 记录，不读取 MemoryRecord 推进。

可在配置密钥后执行 `pnpm build` 和 `node --env-file-if-exists=.env test/live/memory.mjs` 检查三轮真实 QA。该检查直接调用产品的 ObserverExecution，不替换操作、提示词或流程；输出记录到本地 traces/memoryLoop（可用第一个参数指定新目录），失败停止，不修复或重试。不随普通测试访问模型。

门店与培训交叉变更的 16 轮串行场景：`node --env-file-if-exists=.env test/live/memory.mjs traces/memoryContinuity test/live/scenarios/continuity.json`。场景文件仅提供用户消息和事后参考，参考不发送给模型；测试仍调用同一产品执行，逐轮核对记忆进入筛选及提取的实际请求。

提取失败会让整体执行失败，已经生成的回答仍保留。记录登记失败不会伪装成事实已回滚；尚无事务、补偿、重试或持久化。记忆本身或当前消息超预算仍明确失败。分段与有限继承见 [消息分段](docs/transcript.md)。详情见 [记忆体与记忆记录](docs/memory.md)。

调用记录内的结果复用：

```text
processes[sequence=2] execute.return → output（冻结正文）
processes[sequence=3] receive.return → resultOf: 2（默认透传）
value.resultOf: 2                   → 最终采用该正文
```

`resultOf` 是本条记录内的过程序号，只能指向直接保存正文的条目。自定义 receive 独立记录自己的结果，最终引用该结果；即使原地修改并返回同一对象，也保留执行与接收两个时刻的快照。前端投影与查询通过 `protocol/src/records/invocation.ts` 的 `readOutput` 读取，快照中不重新展开。输入和错误正文保持现有记录方式，不做跨记录去重。

运行实例、调用通道与内容变化的当前职责见 [运行边界](docs/runtime-boundaries.md)。Runtime 的消息与记忆跨执行保留；Invocation 统一调用过程；内容对象自己审查、落实并记录变化。Recorder 由环境装配，不属于某个调用的生命周期。

记录机制、类型特化与观察发布的分离见 [记录边界](docs/recording.md)。
