# CAPiX Observer

独立的 TypeScript 运行链路实验：运行两次模型调用，观察真实的输入、调用、返回和异常。

观测用于理解当前系统。没有文件导入、导出或重放，也没有为离线文件设计的版本兼容、独立消息来源、恢复对象。

## 当前链路

```text
initializeObserver(provider, transcript?)
  → Transcript / Book / Index / Clock / Recorder / Runtime
  → ObserverExecution（固定 selection / assembly / generation 实例）

外部 ExecutionRequest { messages }
  → acceptExecutionInput：向已有 Transcript 追加一批新消息
  → 最后一条只读 user Message → Execution.input
  → selection.call → selectionOutput
  → assembly.call → assemblyOutput
  → generation.call → generationOutput
  → 追加 assistant 消息 → Execution.output
```

Transcript 只增不改删，包含第一条和当前消息。接纳时检查角色及非空正文，复制冻结每条消息；批量追加先全部检查，保留原文。get/current 返回同一不可变消息，snapshot(end) 只复制前缀数组。current(role) 是该角色最新消息，不表示问答配对。

本次 input 只有 role/content。ExecutionContext 在开始时固定 settings 的不可变取值与 TranscriptRangeRef [0,end)，范围包含本次输入；历史选择排除末条。外层修改配置或追加消息不会改变进行中的执行，下一次执行才捕获新的配置与范围。模型操作从所属 ExecutionContext 读取配置；消息只在需要时从固定范围读取。

服务启动时初始化一个本地 Observer 环境，Transcript 可以为空，也可以传入已经装载的实例；初始化不产生 Context、Record 或模型调用。环境、消息与记录跨请求保留，进程退出后消失。当前不提供多环境路由、持久化、清空或恢复接口。

请求只提交 1–501 条新消息，最后一条必须是 user；批量接纳失败不写入任何条目。HTTP 入口先检查本次配置，再接纳消息；当前仅接受串行调用，正在执行时拒绝新调用且不追加消息。已接纳消息不会因执行失败被删除。前端只编辑待追加草稿，已有消息从服务端读取，不再重发全部历史。

## 操作、运行与记录

`Operation<I,BeforeOutput,CommitOutput,O>` 是抽象类，直接拥有 before/commit/after 和 call。call 建立 OperationContext，再顺序执行三个阶段；每个阶段产生独立 AttemptContext。BCA 实现留在具体子类：ModelOperation 处理模型调用，AssembleContext 处理选中消息组装。Operation 实例只持有定义和依赖，不保存当前输入、上下文或最近结果。

BCA 统一为阶段 input 与对应 IO 类型的 AttemptContext；before 输出传给 commit，commit 输出直接传给 after，不组合 `{ raw, input }`。需要操作原始输入时通过 Runtime.getOperationContext 查询，执行配置与消息范围通过 getExecutionContext 查询。阶段内部辅助函数不创建新 scope；不引入权限控制。

`Execution<I,O>` 是抽象类，call 建立 ExecutionContext 并调用具体 execute。ObserverExecution 用顺序代码组合三个 Operation，返回 generationOutput；它不创建 Recorder、Book 或 HTTP 响应。构造时装配三个固定操作；BCA 显式接收自己的 AttemptContext，通过 Runtime.getExecutionContext 取得执行配置和取消信号。实例不保存本次调用状态。

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

可调用实例与 Context 为 1:N；开启记录时，每个 E/O/A Context 对应一条同层 Record。复用 Operation 的 operationInstanceId 保持不变，每次调用的 Context ID 与 Record ID 独立产生。记录容器保留所有调用，而非被新请求替换。

GenerationOutput 只表达生成操作的输出契约，不是独立的 Answer 运行实体。浏览器消费同一契约，所以其数据声明位于 shared/operations/generation.ts。GenerationInput 使用 message 与 selectedMessages；模型装载中的 message 保留 role/content。

| 对象             | 职责                                                                            |
| ---------------- | ------------------------------------------------------------------------------- |
| RuntimeContext   | UUID、input 和 running/succeeded(output)/failed(error) 状态；持有真实 IO 与异常 |
| ExecutionContext | 整次运行；固定配置浅快照、Transcript 范围与 AbortSignal 引用                    |
| OperationContext | 一次操作调用；executionId、可选 parentOperationId 和操作声明                    |
| AttemptContext   | 一次阶段调用；operationId 和阶段声明                                            |
| Runtime          | 三层 lifecycle、活动 scope 归属与结束约束                                       |
| RuntimeRecorder  | Context→Record 映射、登记、事件与观测发布；不执行工作或改写 Context             |
| RecordBook       | add/get/values，保存记录实例、拒绝重复 ID                                       |
| RecordIndex      | selector→key→IDs；显式登记、查询和移除                                          |
| 各 RecordHelper  | 对应记录的创建、关系检查、登记与结果写入                                        |
| Clock            | 现实时间 now() 与单调时间 tick()                                                |

`invoke(lifecycle, execute)` 组合 begin、执行与等待、succeed/fail。begin 失败不执行工作；succeed 登记失败不重新进入 fail。工作失败且失败登记也失败时，AggregateError 保留两个异常。

Runtime 可以不接 Recorder。接入时，工作完成先更新 Context，再登记记录；登记异常不改写已发生的工作结果。observer/observe.ts 只将完整登记的工作失败作为观测结果返回。当前没有登记补偿或进程恢复。

## 事实引用与观测

记录不要求自包含。ExecutionRecord 保存本次 settings 快照与固定 Transcript 范围引用；OperationRecord 通过 executionId 关联，AttemptRecord 通过 operationId 关联，不重复保存这两项。

普通过程数据在登记边界复制冻结，包括简单输入消息与实际模型请求。TranscriptRangeRef 是不可变范围引用，保持原实例，不遍历或复制整个 Transcript。历史选择从执行范围读取候选，组装操作输出选中的普通消息内容和索引，不把整个集合引用放回操作 IO。

Runtime.getExecutionContext 沿已登记的 scope 关系解析 E/O/A 的所属执行；getOperationContext 解析 Attempt 的所属操作。辅助查询不读取任何 Record，未启用 Recorder 时同样工作。

ExecutionRecordHelper.snapshot 查询已有记录；HTTP observeTranscript 在展示时展开执行范围为 start/end/messages。执行详情的 EXECUTION SCOPE 展示配置与范围，输入区域单独显示本次消息。当前没有持久化、独立来源副本或恢复机制。

浏览器据同一组记录投影时序与详情。记录状态、输入输出、错误是观察依据；耗时、CallSpan 和 TraceNode 是派生视图。当前每个边界仍发送完整更新，消息正文可能在展示传输中重复，尚未实现增量传输或按需查询。

```text
RuntimeRecord<T>：id + value
  ExecutionRecord：整次运行，contextId；value 中保存本次配置与消息范围
  OperationRecord：一次操作调用，contextId / executionId / operationInstanceId / parentOperationId?
  AttemptRecord：一次阶段调用，contextId / operationId / phase
  EventRecord：一次调用边界，executionId / callId / sequence / occurredAt / offsetMs；value.type
```

operationInstanceId 指向可复用的 Operation 实例；OperationRecord.id 和 OperationContext.id 各自标识一次调用。Context 归属 ID 指向 Context；Record 归属 ID 指向 Record。三种记录自身 ID 与 Context ID 不同，顶层 contextId 关联对应运行实例。状态在具体记录顶层，基类不规定状态。

完整成功链路为 1 条 Execution、3 条 Operation、9 条 Attempt、26 个 call/return/throw 边界事件。没有发生的阶段不创建记录。Attempt 失败不自动更改父操作状态，异常按实际调用链传播；After 拒绝时保留 Commit 原始返回，没有接纳输出。

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

正式链路每次成功运行包含两次真实模型调用，包括空历史时的选择调用。模型使用 JSON Output、非思考、非流式返回；观测通过 NDJSON 即时发布。

```sh
pnpm check
```

测试命令只发现 test/**/*.test.mjs，不把辅助 fixture 当成测试。测试使用注入的模型返回和 HTTP 替身，覆盖真实链路、固定引用、失败截断、记录一致性及展示数据转换，不消费 API 额度。格式配置 printWidth 为 1000，不强制常规代码按 100 字符换行。

## 怎样观察

- 左侧只读展示服务端已接纳消息；可编辑待追加消息草稿并填写当前输入。“询问城市 → 上海”样例也是待追加内容，不替换已有消息。
- 时序图按实际事件从上向下展开。实线是调用，虚线是返回，红色虚线是异常传播；激活条表示尚未结束的调用。
- 纵向是事件顺序，不是等比时间轴；每个事件显示时间偏移，返回显示耗时。
- 点击箭头查看当时 IO、错误和对应源码。源码来自当前文件，不是历史代码快照。
- 成功返回 answer/unknown/needs-info 表示输出被接纳，不保证用户问题已解决。
- “继续输入”只清空输入框。消息已经由服务端保存，刷新页面会重新读取；本页时序列表仍是本页接收的记录，尚未提供服务端记录列表查询。

容量检查发生在完整模型请求装载后。当前以请求 UTF-8 字节数加余量估算输入容量，再加预留输出 token；不是精确 tokenizer，也不保证供应商一定接纳。超限直接失败，不静默截断、修复或重试。

## 目录

```text
src/server/
  execution/execution.ts     Execution.call 与抽象工作组合
  observer/environment.ts    请求前的环境初始化
  observer/accept.ts         向已有 Transcript 接纳本次输入
  observer/execution.ts      ObserverExecution：复用三个固定 Operation
  observer/observe.ts        本次调用的观测订阅与响应
  transcript/                原始消息、固定引用与展示读取
  context/                   Execution / Operation / Attempt 运行上下文
  invocation/                通用调用流程与 lifecycle 契约
  operations/                Operation.call/BCA、ModelOperation、具体操作
  runtime/                   scope 管理与时钟
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

无生产运行依赖。尚未实现数据库、TRS、工具执行、调度、重试、恢复或持久化队列；不为这些未来功能预先增加当前运行链路之外的对象。
