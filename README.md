# CAPiX Observer

独立的 TypeScript 运行链路实验：运行两次模型调用，观察真实的输入、调用、返回和异常。

观测用于理解当前系统。没有文件导入、导出或重放，也没有为离线文件设计的版本兼容、独立消息来源、恢复对象。

## 当前链路

```text
外部 QueryRequest { query, history }
  → acceptQuery：检查请求，Transcript 接纳消息
  → Execution.input = query MessageRef
  → SelectionInput { query, historyRange: [0, query.index) }
  → 选择历史：before → commit → after
  → Selection { historyIndexes }
  → 组装上下文：identity → commit → identity
  → AnswerInput { query, messages: MessageRef[] }
  → 生成回答：before → commit → after
  → Execution.output = Answer
```

Transcript 只增不改删，包含第一条和当前消息。接纳时检查角色及非空正文，复制冻结每条消息；批量追加先全部检查，保留原文。get/current 返回同一不可变消息，snapshot(end) 只复制前缀数组。current(role) 是该角色最新消息，不表示问答配对。

MessageRef 由 Transcript 实例及绝对 index 定位；TranscriptRangeRef 固定 `[start,end)`。query 和候选范围不随后续消息追加改变。EOA 的 IO 结构按实际操作异构，模型 before 装载时才读取选中消息正文。生成回答后追加 assistant 消息。

请求入口检查 query 与最多 500 条历史；Transcript 自身维护消息规则。前端 MessageDraft 负责编辑与展示，仅共享 Message 契约，不导入服务端运行类。每次请求独立接纳 Transcript，当前没有跨请求仓库、持久化或问答配对关系。

## 操作、运行与记录

`Operation<I,P,R,O>` 是抽象类，直接拥有 before/commit/after 和 call。call 建立 OperationContext，再顺序执行三个阶段；每个阶段产生独立 AttemptContext。BCA 实现留在具体子类：ModelOperation 处理模型调用，AssembleContext 处理消息引用组装。Operation 实例只持有定义和依赖，不保存当前输入、上下文或最近结果。

`Execution<I,O>` 是抽象类，call 建立 ExecutionContext 并调用具体 execute。QueryExecution 用顺序代码组合三个 Operation，返回 Answer；它不创建 Recorder、Book 或 HTTP 响应。每次调用按当前 Context 的配置装配模型操作，不把一次调用的配置或状态留在复用实例上。

```ts
const execution = new QueryExecution(runtime, provider);
const answer = await execution.call(query, {
  settings,
  signal,
  transcript: query.transcript,
});
```

QueryExecution.execute 内部仍然明确表达数据流：

```ts
const input = selectionInput(context.input);
const selection = await selectHistory.call(context, input);
const assembled = await assemble.call(context, { original: input, selection });
const answer = await generateAnswer.call(context, assembled);
```

query/run.ts 只装配本次请求使用的 Book、索引、Clock、Recorder、Runtime 和 QueryExecution，调用后返回实际观测结果。没有 Node、registerNode、runOperation 或 Pipeline 类；也不新增流程 DSL、操作数组调度或实例上的 currentContext。

| 对象             | 职责                                                                            |
| ---------------- | ------------------------------------------------------------------------------- |
| RuntimeContext   | UUID、input 和 running/succeeded(output)/failed(error) 状态；持有真实 IO 与异常 |
| ExecutionContext | 整次运行；固定配置浅快照、Transcript/AbortSignal 引用                           |
| OperationContext | 一次操作调用；executionId、可选 parentOperationId 和操作声明                    |
| AttemptContext   | 一次阶段调用；operationId 和阶段声明                                            |
| Runtime          | 三层 lifecycle、活动 scope 归属与结束约束                                       |
| RuntimeRecorder  | Context→Record 映射、登记、事件与观测发布；不执行工作或改写 Context             |
| RecordBook       | add/get/values，保存记录实例、拒绝重复 ID                                       |
| RecordIndex      | selector→key→IDs；显式登记、查询和移除                                          |
| 各 RecordHelper  | 对应记录的创建、关系检查、登记与结果写入                                        |
| Clock            | 现实时间 now() 与单调时间 tick()                                                |

`invoke(lifecycle, execute)` 组合 begin、执行与等待、succeed/fail。begin 失败不执行工作；succeed 登记失败不重新进入 fail。工作失败且失败登记也失败时，AggregateError 保留两个异常。

Runtime 可以不接 Recorder。接入时，工作完成先更新 Context，再登记记录；登记异常不改写已发生的工作结果。query/run.ts 只将完整登记的工作失败作为观测结果返回。当前没有登记补偿或进程恢复。

## 事实引用与观测

记录不要求自包含。EOA 记录中的 MessageRef/TranscriptRangeRef 与运行共享同一份不可变消息事实，不额外保存 Transcript 副本或“本次执行消息来源”。

普通过程数据仍在登记边界取得冻结快照，避免后续修改覆盖当时内容。`snapshotValue` 组合 `copyContent → assertRecordContent → freezeContent`；消息引用作为不可变叶子原样保留，不遍历或冻结 Transcript。其他内容仍限制为普通 JSON 值，拒绝循环、Map、函数和 undefined 等。

ExecutionRecordHelper.snapshot 组合记录与事件：外层数据表达当时的状态，正文使用已登记的不可变值，消息引用仍指向事实。HTTP 发送观测响应时，`observeTranscript` 才读取消息引用，展开为 `{index,message}`；范围展开为 `{start,end,messages}`。这是无状态的展示转换，不创建新记录或保存内容副本。

浏览器据同一组记录投影时序与详情。记录状态、输入输出、错误是观察依据；耗时、CallSpan 和 TraceNode 是派生视图。当前每个边界仍发送完整更新，消息正文可能在展示传输中重复，尚未实现增量传输或按需查询。

```text
RuntimeRecord<T>：id + value
  ExecutionRecord：整次运行，contextId
  OperationRecord：一次操作调用，contextId / executionId / operationInstanceId / parentOperationId?
  AttemptRecord：一次阶段调用，contextId / operationId / phase
```

operationInstanceId 指向可复用的 Operation 实例；OperationRecord.id 和 OperationContext.id 各自标识一次调用。Context 归属 ID 指向 Context；Record 归属 ID 指向 Record。三种记录自身 ID 与 Context ID 不同，顶层 contextId 关联对应运行实例。状态在具体记录顶层，基类不规定状态。

完整成功链路为 1 条 Execution、3 条 Operation、9 条 Attempt、26 个 call/return/throw 边界事件。没有发生的阶段不创建记录。Attempt 失败不自动更改父操作状态，异常按实际调用链传播；After 拒绝时保留 Commit 原始返回，没有接纳输出。

事件目前仅记录调用边界，由 RuntimeRecorder 持有计时基准及事件序列；不是推进指令或事件总线。validateSnapshot 检查当前记录身份、状态、归属与事件一致性，不是导入文件校验。

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

- 当前输入与历史在左侧编辑；可载入“询问城市 → 上海”样例。
- 时序图按实际事件从上向下展开。实线是调用，虚线是返回，红色虚线是异常传播；激活条表示尚未结束的调用。
- 纵向是事件顺序，不是等比时间轴；每个事件显示时间偏移，返回显示耗时。
- 点击箭头查看当时 IO、错误和对应源码。源码来自当前文件，不是历史代码快照。
- 成功返回 answer/unknown/needs-info 表示输出被接纳，不保证用户问题已解决。
- “将本轮加入历史”使用本页提交内容与回答继续提问；刷新页面不保留历史和观测。

容量检查发生在完整模型请求装载后。当前以请求 UTF-8 字节数加余量估算输入容量，再加预留输出 token；不是精确 tokenizer，也不保证供应商一定接纳。超限直接失败，不静默截断、修复或重试。

## 目录

```text
src/server/
  execution/execution.ts     Execution.call 与抽象工作组合
  query/execution.ts         QueryExecution：三个 Operation 的组合
  query/run.ts               请求环境装配与观测响应
  query/input.ts             请求接纳
  transcript/                原始消息、固定引用与展示读取
  context/                   Execution / Operation / Attempt 运行上下文
  invocation/                通用调用流程与 lifecycle 契约
  operations/                Operation.call/BCA、ModelOperation、具体操作
  runtime/                   scope 管理、时钟、边界事件
  records/                   容器、索引、三类记录及配对操作、正文快照
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
