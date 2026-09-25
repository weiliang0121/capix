# CAPiX Observer

独立的 TypeScript 运行链路实验：运行三次模型调用，观察真实的输入、调用、返回和异常。

观测用于理解当前系统。没有文件导入、导出或重放，也没有为离线文件设计的版本兼容、独立消息来源、恢复对象。

## 当前链路

```text
initializeObserver(provider, transcript?)
  → Transcript / Book / Index / Clock / Recorder / Runtime
  → ObserverExecution（固定 selection / generation / extraction 实例；MemoryCollection）

外部 ExecutionRequest { messages }
  → acceptExecutionInput：向已有 Transcript 追加一批新消息
  → 最后一条只读 user Message → Execution.input
  → 读取本轮开始时的 previousMemories
  → selection.call({ message: input, memories: previousMemories }) → selectionOutput
  → generation.call（内部组合消息、准备请求、调用模型、接纳结果）→ generationOutput
  → 追加 assistant 消息
  → extraction.call（previousMemories + 当前 QA + 可见原文）
  → 接纳变更 → MemoryHelper 创建/更新 → MemoryRecord 登记
  → 更新后的记忆供下一轮 selection 使用
  → generationOutput → Execution.output
```

Transcript 只增不改删，包含第一条和当前消息。接纳时检查角色及非空正文，复制冻结每条消息；批量追加先全部检查，保留原文。get/current 返回同一不可变消息，snapshot(end) 只复制前缀数组。current(role) 是该角色最新消息，不表示问答配对。

本次 input 只有 role/content。ExecutionContext 在开始时固定 settings 的不可变取值与 TranscriptRangeRef [activeStart,end)，范围包含本次输入；历史选择排除末条。外层修改配置或追加消息不会改变进行中的执行，下一次执行才捕获新的配置与范围。模型操作从所属 ExecutionContext 读取配置；消息只在需要时从固定范围读取。

服务启动时初始化一个本地 Observer 环境，Transcript 可以为空，也可以传入已经装载的实例；初始化不产生 Context、Record 或模型调用。环境、消息与记录跨请求保留，进程退出后消失。当前不提供多环境路由、持久化、清空或恢复接口。

请求只提交 1–501 条新消息，最后一条必须是 user；批量接纳失败不写入任何条目。HTTP 入口先检查本次配置，再接纳消息；当前仅接受串行调用，正在执行时拒绝新调用且不追加消息。已接纳消息不会因执行失败被删除。前端只编辑待追加草稿，已有消息从服务端读取，不再重发全部历史。

## 操作、运行与记录

`Operation<I,O>` 提供统一 call 与抽象 execute。具体操作自行组合具名 Attempt，数量和顺序由工作决定。BCA 只用于分析这些动作，不再作为执行接口、阶段枚举或记录分类。

`Attempt<I,O>` 是最底层抽象执行类，call 通过公共 invoke/Runtime 建立 AttemptContext，再调用具体 execute。实例定义 name/label/source/callee，持有稳定依赖；每次调用的输入、上下文、结果独立。内部只组合普通函数，不再细分执行层级。Operation 在构造时创建所需 Attempt 实例，跨调用复用；不建立统一的动作列表解释器或新的调度系统。

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

const input = acceptExecutionInput(environment.transcript, request);
const generationOutput = await environment.execution.call(input, {
  settings,
  signal,
  transcript: environment.transcript, // 开始时固定范围，不放入 input
});
```

环境初始化、请求接纳、执行组合和观测响应分别位于 observer/environment.ts、accept.ts、execution.ts、observe.ts。observeExecution 用 Execution.call 的 started 回调取得 Context ID，在首条记录发布前绑定本次调用，按 contextId 筛选记录，结束时解除订阅。它不再通过 input 对象身份关联记录。

记录创建发生在 Context 创建之后，工作执行之前。Recorder 在这个边界直接读取已有 Operation 实例的描述及现场父 Context；Attempt 的源码和参与者描述也从现场执行实例读取。Context 不携带这些描述、不保存 declaration；记录固化信息后，完成/失败只依据 Context 登记结果。不新增长期的实例关联表。

可调用实例与 Context 为 1:N；开启记录时，每个 E/O/A Context 对应一条同层 Record。复用 Operation 的 operationInstanceId 保持不变，每次调用的 Context ID 与 Record ID 独立产生。记录容器保留所有调用，而非被新请求替换。

GenerationOutput 只表达生成操作的输出契约，不是独立的 Answer 运行实体。浏览器消费同一契约，所以其数据声明位于 shared/operations/generation.ts。GenerationInput 使用 selection 与 memories；内部 AssembleContext 产生 message 与 selectedMessages，模型装载中的 message 保留 role/content。

回答输出在 operations/answer/output.ts 使用 Zod 配对生成 JSON Schema 与本地接纳检查。严格拒绝额外字段、非法分类和空白正文，不自动转换或修剪内容；接纳返回新普通对象。结构失败仍为 OUTPUT_SHAPE，detail.issues 保留字段路径与原因。共享 GenerationOutput 保持纯数据类型，通过 Schema 的类型约束检查兼容性，不从 shared 反向导入服务端。记忆提取在 operations/memory/output.ts 同样用 Schema 定义 create/update 的结构并推导 MemoryExtraction，保留来源去重和长度限制。结构接纳后继续检查目标、来源和无变化更新；这些语义规则独立于 Schema。历史筛选也使用 Zod，保留空结果和优先级，结构通过后再检查本轮索引范围。model/schema.ts 复用文本与索引规则，非空白和去重要求同时进入提示 Schema 与本地检查。JSON 解析及执行重试不归 Zod。settings.ts 用 Zod 接纳配置，保持原有已知字段选取与数值边界。

| 对象             | 职责                                                                      |
| ---------------- | ------------------------------------------------------------------------- |
| RuntimeContext   | UUID、初始 input、当前轮 currentInput/progress 与终态；持有真实 IO 与异常 |
| ExecutionContext | 整次运行；固定配置浅快照、Transcript 范围与 AbortSignal 引用              |
| OperationContext | 一次操作调用；executionContext 引用和本次 IO/状态                         |
| AttemptContext   | 一次动作调用；operationContext 引用和本次 IO/状态                         |
| Runtime          | 三层 lifecycle、本地调用循环、直接父级检查与上下文读取                    |
| RuntimeRecorder  | Context→Record 映射、登记、事件与观测发布；不执行工作或改写 Context       |
| RecordBook       | add/get/values，保存记录实例、拒绝重复 ID                                 |
| RecordIndex      | selector→key→IDs；显式登记、查询和移除                                    |
| 各 RecordHelper  | 对应记录的创建、关系检查、登记与结果写入                                  |
| Clock            | 现实时间 now() 与单调时间 tick()                                          |

`invoke(lifecycle, execute)` 组合 begin、执行与等待、succeed/fail。begin 失败不执行工作；succeed 登记失败不重新进入 fail。工作失败且失败登记也失败时，AggregateError 保留两个异常。

Runtime 可以不接 Recorder。接入时，工作完成先更新 Context，再登记记录；登记异常不改写已发生的工作结果。observer/observe.ts 只将完整登记的工作失败作为观测结果返回。当前没有登记补偿或进程恢复。

## 本地执行与接收

三层调用采用同一结构：call → execute → receive → complete/fail。receive 接收本轮成功结果或失败，各具体类决定后续；默认返回成功结果或传播原错误。需要继续时显式返回 context.continueWith(nextInput, reason)。没有通用 retry/skip/fallback 策略表。

maxRounds 默认 1，具体类可设为 2，均包含首次执行；不接受更大值。每轮开始检查取消。次数耗尽、无效继续原因、接收自身异常明确退出；登记失败不能触发本地恢复。原有模型单次超时仍有效，这不是通用的抢占或恢复机制。现有筛选、生成、记忆链路未开启重复执行。

同一调用内 Context 身份不变：input 是初始引用，currentInput 是当前轮输入，progress 表达当前轮次、执行/接收位置及 execute 结果。continueWith 不重置初始输入，不改写已结束的子调用。运行可不接 Recorder，处理分支不依赖记录。

一条调用记录的 value.processes 按序追加执行、接收和停止事实，不为内部条目生成 ID 或独立记录。正文登记时复制冻结，保留每次输入、结果、接收决定与继续/退出原因。E/O/A Record 共用 InvocationRecord 的追加和终态方法，Book 仍只管理记录。RuntimeRecorder 在追加后发布已有快照，调用详情可展开完整过程；call/return/throw 时序事件的含义与数量不变。

记录失败通过 RecordingError 保留原始 cause，并阻止父层把它当成可重做的工作错误；错误和错误登记同时失败则保留两个原因。记录失败不撤销已经发生的运行事实，也不补造未登记的条目。

## 事实引用与观测

记录不要求自包含。ExecutionRecord 保存本次 settings 快照与固定 Transcript 范围引用；OperationRecord 通过 executionId 关联，AttemptRecord 通过 operationId 关联，不重复保存这两项。

普通过程数据在登记边界复制冻结，包括简单输入消息与实际模型请求。TranscriptRangeRef 是不可变范围引用，保持原实例，不遍历或复制整个 Transcript。历史选择从执行范围读取候选，组装操作输出选中的普通消息内容和索引，不把整个集合引用放回操作 IO。

Runtime.getExecutionContext/getOperationContext 沿 AttemptContext.operationContext → OperationContext.executionContext 直接读取上层上下文，不需要登记表或 Record，调用完成后仍可读取。Runtime 不维护活动子调用集合，当前串行流程通过 await 保证结束顺序；手动提前结束父调用不受通用运行管理保护。父调用已结束、嵌套调用属于不同执行和重复结束仍直接检查。

ExecutionRecordHelper.snapshot 查询已有记录；HTTP observeTranscript 在展示时展开执行范围为 start/end/messages。执行详情的 EXECUTION CONTEXT 展示配置与范围，输入区域单独显示本次消息。当前没有持久化、独立来源副本或恢复机制。

浏览器据同一组记录投影时序与详情。记录状态、输入输出、错误是观察依据；耗时、CallSpan 和 TraceNode 是派生视图。当前每个边界仍发送完整更新，消息正文可能在展示传输中重复，尚未实现增量传输或按需查询。

```text
RuntimeRecord<T>：id + value
  ExecutionRecord：整次运行，contextId；value 中保存本次配置与消息范围
  OperationRecord：一次操作调用，contextId / executionId / operationInstanceId / parentOperationId?
  AttemptRecord：一次动作调用，contextId / operationId / name / label
  EventRecord：一次调用边界，executionId / callId / sequence / occurredAt / offsetMs；value.type
```

operationInstanceId 指向可复用的 Operation 实例；OperationRecord.id 和 OperationContext.id 各自标识一次调用。Context 直接引用上层 Context；Record 归属 ID 指向 Record。三种记录自身 ID 与 Context ID 不同，顶层 contextId 关联对应运行实例。状态在调用记录顶层，由 InvocationRecord 共用实现；RuntimeRecord 基类不规定状态。

当前完整成功链路为 1 条 Execution、3 条 Operation、11 条 Attempt、30 个 call/return/throw 边界事件。数量来自实际组合，不是框架限制。没有执行的动作不创建记录；Attempt 失败不自动更改父操作状态，异常按实际调用链传播。接纳失败保留模型原始返回，落实失败保留已接纳结果，不假装运行事实回滚。

EventRecord 继承 RuntimeRecord，自己的 id 与 callId 不同：callId 指向被描述的 E/O/A 调用记录。EventRecordHelper 负责创建和查询，Book 保存原记录，eventIndex 按执行 ID 查询，不另保存事件数组。sequence 为执行内顺序；occurredAt 为现实时间，offsetMs 使用单调时钟，现实时间回拨不改变时序。RuntimeRecorder 仅保留单调计时起点。事件记录没有 Context 或运行状态，不承担推进或消息传递；validateSnapshot 检查记录身份、归属与边界一致性。

错误内嵌在 value.error。RuntimeErrorHelper.format 保留名称、code/message、堆栈、cause 与复合 errors；不可记录的诊断内容转为明确标记，不执行 detail 的 getter/toJSON。ErrorTraversal 管理一次格式化的预算与递归路径。没有独立错误记录或异常还原功能。

## 启动与检查

工具链：Node **22.23.2**、pnpm **10.7.1**、TypeScript **6.0.3**。

```sh
pnpm install --frozen-lockfile
cp .env.example .env
# 在本机填写 DEEPSEEK_API_KEY。
pnpm dev
```

打开 http://127.0.0.1:4317 。服务只监听本机；Key 只用于服务端模型请求，不进入观测数据。源码或配置变更后重新运行 pnpm dev。默认模型为 deepseek-flash，可通过 DEEPSEEK_MODEL 配置。

正式链路每次成功运行包含三次真实模型调用，包括空历史时的选择调用。模型使用 JSON Output、非思考、非流式返回；观测通过 NDJSON 即时发布。

```sh
pnpm check
```

测试命令只发现 test/**/*.test.mjs，不把辅助 fixture 当成测试。测试使用注入的模型返回和 HTTP 替身，覆盖真实链路、固定引用、失败截断、记录一致性及展示数据转换，不消费 API 额度。格式配置 printWidth 为 1000，不强制常规代码按 100 字符换行。

## 怎样观察

- 左侧运行图谱、右侧对话。对话独立滚动，输入器固定底部；容量配置与待追加消息草稿在设置中。
- 横向按 QA 分段，纵向为消息热度、Execution、Operation、Attempt 四层。轮内 EOA 保持共同耗时比例，轮间采用固定 24px 间隔；每轮标注真实开始时间及相对首轮的时间，底部总跨度仍为真实跨度。
- 每轮用户/助手消息各占该 Execution 区间的一半，不代表消息耗时。消息颜色表示累计被选次数；调用颜色表示同层相对耗时，失败和运行中另行标记。
- 图内纵向滚轮缩放、横向滚轮平移，以鼠标位置为缩放锚点，按主方向判断并合并到动画帧。左侧层级标签与顶部 QA 固定；层级仍可用纵向滚动条或键盘查看。底部等宽 QA 摘要展示用户原文节选、状态、耗时与记忆变更数，点击定位轮次，高亮主图可见范围；不再重复缩小 EOA 图。耗时仅由宽度表达，消息选择次数使用数字与局部短条。聚焦单轮只调整视口，全局内容仍保留；极短调用保持真实宽度，可从父节点详情中进入。
- 点击 QA/EOA 打开弹层，查看输入输出、内部执行/接收过程、记录捕获的上下文、当时传入的记忆与本轮变化、当前执行源码。记忆变化标在实际执行处，不虚构记忆调用层。
- 刷新重新读取当前进程全部执行和消息。成功返回 answer/unknown/needs-info 表示输出被接纳，不保证用户问题已解决。进程退出后内存数据丢失。

容量检查发生在完整模型请求装载后。当前以请求 UTF-8 字节数加余量估算输入容量，再加预留输出 token；不是精确 tokenizer，也不保证供应商一定接纳。历史选择超限时，在下一轮开始前切换当前消息段；旧段保留，优先保留最近两轮完整 QA，预算不足降为一轮、零轮；消息对象和绝对索引不变。当前输入加记忆本身超限仍失败。选择结果要求模型按相关性与必要性从高到低返回索引；这是模型指导，不保证排序质量。生成请求按该顺序纳入完整消息，遇到第一条放不下的就停止，不跳过长消息凑容量；第一条就放不下则失败。保留的前缀在最终请求里恢复原始时间顺序。当前输入和固定请求内容不裁剪，容量处理不生成摘要、不额外调用模型、不自动修复或重试。生成 PrepareModelRequest 的输入保留候选顺序，输出记录最终请求，可以对照检查实际采用了哪些历史。

## 目录

```text
src/server/
  execution/execution.ts     Execution.call 与抽象工作组合
  observer/environment.ts    请求前的环境初始化
  observer/accept.ts         向已有 Transcript 接纳本次输入
  observer/execution.ts      ObserverExecution：复用三个具体 Operation
  observer/observe.ts        本次调用的观测订阅与响应
  transcript/                原始消息、固定引用与展示读取
  memory/                    记忆体、集合与原文关系投影
  context/                   Execution / Operation / Attempt 运行上下文
  invocation/                通用调用流程与 lifecycle 契约
  attempt/                   Attempt.call/execute 及具名动作实现
  model/                     模型契约、请求装载、容量与 Schema 辅助函数
  operations/                Operation 与各个具体工作的动作组合
  runtime/                   调用生命周期与时钟
  records/                   容器、索引、E/O/A 与事件记录及配对操作、正文快照
  errors/                    异常及诊断格式化
  settings.ts                模型配置检查
  provider.ts                DeepSeek HTTP 接入
  index.ts                   本地 HTTP 与观测响应
src/shared/
  records.ts                 记录与观测数据形状
  execution/project.ts       时序和详情投影
  transcript/message.ts      消息契约
  errors.ts                  诊断正文契约
  types.ts                   请求、模型与视图契约
src/web/                     工作台、消息编辑与时序图
```

通用数据操作优先使用 es-toolkit 的公开分类入口，直接具名导入，不额外建立工具转发层。当前已用于记录字段投影、消息排序/去重及记忆正文比较；服务端基础类型判断统一使用库的同语义函数，分类入口缺少的数组、对象范围、有限数和安全整数判断通过 compat 具名导入。简单展开、原生集合和领域类身份检查仍保留。pick 仅取自身字段，类 getter 显式读取；正文比较保持来源索引顺序。快照、引用保留、错误转换继续由对应概念负责，不默认套用深合并或深拷贝。浏览器当前直接加载 tsc 输出，运行时工具库导入暂限 server，后续前端接入需统一处理模块解析。

服务端错误转换、Provider、Transcript、Memory 和记录正文使用同语义的标准类型谓词；错误字段由固定字段表和 zipObject 组织。跨 realm 原生错误仍用 Node 的 isNativeError，专用对象范围、循环检测、访问器隔离和转换预算保留原有规则。工具函数替换不改变错误代码、正文或身份语义。

生产运行依赖为 zod@4.6.5（模型输出契约与配置接纳）和 es-toolkit@1.52.0（通用数据操作）。尚未实现数据库、TRS、工具执行、调度、模型自动重试、恢复或持久化队列；不为这些未来功能预先增加当前运行链路之外的对象。

筛选结果仅包含所选原文索引，保存在操作上下文与记录中，不写入消息列表。Transcript 仅保留接纳的 user/assistant 消息与正式生成的回答。Jev 筛选与热区装载尚未接入。消息关联计数保留，但不参与模型输入。

历史选择热区：消息按 QA 配对展示于调用图顶层，颜色表示累计被选次数；选择执行高亮选中范围，点击查看该轮原文和调用。数据由当前进程已有筛选操作记录推导，刷新后仍可查看；进程退出即丢失。只统计已接纳的筛选结果，后续回答失败仍计入，不表示回答实际使用或判断正确。次数不传给筛选或生成模型；候选范围仍为全部可见历史，计数不引起额外模型调用。

## 回答后的记忆提取

第三次模型调用返回零到四项创建或更新提议，每项明确目标、变化说明、依据与变更后完整内容。MemoryHelper 先检查整批再落实；MemoryCollection 保存持续身份的 Memory，更新不新建身份。每次落实产生独立 MemoryRecord，继承 RuntimeRecord，关联 memoryId、executionId、operationId，保存本次变化说明和结果快照。

页面直接读取这些记录显示变化，点击记忆体可以查看当前理解、历次变化及调用关联。每轮开始从当前 Transcript 的 MemoryCollection 取得 previousMemories 的正文快照，筛选、回答和本轮提取使用同一份旧记忆。筛选输入为 message + memories，原始 history 从执行固定范围读取；记忆不插入 Transcript，计数不发送给模型。生成接收 message + 选中原文 + previousMemories；提取接收 previousMemories + 本轮 QA + 当前段筛选原文，不沿来源加载旧段，落实后下一轮筛选读取更新后的记忆。三次实际模型请求都由原有 AttemptRecord 记录，不读取 MemoryRecord 推进。

可在配置密钥后执行 `pnpm build` 和 `node --env-file-if-exists=.env test/live/memory.mjs` 检查三轮真实 QA。该检查直接调用产品的 ObserverExecution，不替换操作、提示词或流程；输出记录到本地 traces/memoryLoop（可用第一个参数指定新目录），失败停止，不修复或重试。不随普通测试访问模型。

门店与培训交叉变更的 16 轮串行场景：`node --env-file-if-exists=.env test/live/memory.mjs traces/memoryContinuity test/live/scenarios/continuity.json`。场景文件仅提供用户消息和事后参考，参考不发送给模型；测试仍调用同一产品执行，逐轮核对记忆进入筛选及提取的实际请求。

提取失败会让整体执行失败，已经生成的回答仍保留。记录登记失败不会伪装成事实已回滚；尚无事务、补偿、重试或持久化。记忆本身或当前消息超预算仍明确失败。分段与有限继承见 [消息分段](docs/transcript.md)。详情见 [记忆体与记忆记录](docs/memory.md)。

调用记录内的结果复用：

```text
processes[sequence=2] execute.return → output（冻结正文）
processes[sequence=3] receive.return → resultOf: 2（默认透传）
value.resultOf: 2                   → 最终采用该正文
```

`resultOf` 是本条记录内的过程序号，只能指向直接保存正文的条目。自定义 receive 独立记录自己的结果，最终引用该结果；即使原地修改并返回同一对象，也保留执行与接收两个时刻的快照。前端投影与查询通过 `shared/records/invocation.ts` 的 `readOutput` 读取，快照中不重新展开。输入和错误正文保持现有记录方式，不做跨记录去重。
