# Checkpoint 与执行恢复：机制对照和 CAPiX 的选择

本文是待讨论的研究材料，不是已经实现或决定采用的恢复契约。整理于 2026-10-14，CAPiX 代码基线为 `54d1398`。外部材料来自官方文档与官方源码；源码链接固定到本次审阅的提交，不代表指定发行版。本次没有运行外部框架或进行崩溃注入。

后续讨论已整理为 [REOA Checkpoint 与执行恢复设计](checkpoints.md)，已完成有限内核与 Observer 内置声明的续接、消息/记忆落实和文件确认验证；默认服务仍不自动恢复旧 QA。本文其余“当前”描述保留研究时基线，最新承诺以该实现文档为准。该方案采用显式恢复点、父子事实协作和实体操作凭据；下文两条候选路径与跨对象事务示例保留为研究对照，不表示需要同时实现或作为最终契约。

当前已经实现客户端接回、内容恢复和独立 Interaction 反馈读取。接下来的问题是：如果原执行者已经消失，系统是否需要依据保存的数据继续推进同一笔工作，以及允许重做哪部分。

## 1. 先区分恢复的对象

| 能力           | 恢复什么                                     | CAPiX 当前边界                                   |
| -------------- | -------------------------------------------- | ------------------------------------------------ |
| 客户端接回     | 对仍可查询的提交重新读取、跟随反馈           | 已实现；不重新 POST，不要求原连接仍在            |
| 内容恢复       | 对话、消息、记忆、可选历史记录               | 已实现；重启后可以开启新提交                     |
| 交互反馈再消费 | 按已知 Interaction ID 读取已经保存的完整反馈 | 已实现读取；没有自动恢复原父调用                 |
| 业务推进恢复   | 从某个被确认的位置继续决策、接纳和落实结果   | 未实现；是本次研究对象                           |
| 进程现场恢复   | 原对象、Promise、闭包、调用栈与内存现场      | 当前没有需求；下述框架的主要路径也不依赖这个承诺 |

Checkpoint 是保存形式或边界；恢复是读取这些数据后执行的行为。保存了一份数据，不代表已确定恢复行为。重试、恢复和历史分叉也不同：重试再次尝试一个工作单元，恢复继续原逻辑工作，历史分叉允许重新做出后续选择。

## 2. 外部框架实际提供了什么

### LangGraph：图状态与任务写入

完整 checkpoint 位于 superstep 边界；同一 superstep 内节点完成的输出另存为 pending writes，正常恢复可以复用这些写入。节点内部未纳入持久 task 的代码仍可能重跑。`sync` 在下一步前等保存，`async` 存在未落盘窗口，`exit` 不提供中途进程崩溃的中间检查点。这些是不同承诺，不能统称“支持 checkpoint”。参见 [Checkpointers](https://docs.langchain.com/oss/python/langgraph/checkpointers)。

源码中的 [`Checkpoint` / `CheckpointTuple`](https://github.com/langchain-ai/langgraph/blob/8a77332d0db75c49d296b1f3833a3a5ccd5f0dc8/libs/checkpoint/langgraph/checkpoint/base/__init__.py#L93-L147) 保存 channel 值、版本、已见版本以及 pending writes；[`_reapply_writes_to_succeeded_nodes`](https://github.com/langchain-ai/langgraph/blob/8a77332d0db75c49d296b1f3833a3a5ccd5f0dc8/libs/langgraph/langgraph/pregel/_loop.py#L804-L821) 回填已有输出，[调度循环](https://github.com/langchain-ai/langgraph/blob/8a77332d0db75c49d296b1f3833a3a5ccd5f0dc8/libs/langgraph/langgraph/pregel/main.py#L3050-L3079) 跳过有写入的 task。恢复依据是这些正式状态，而非普通诊断日志或任意 Python 局部变量。

Functional API 更接近普通代码：重新进入 entrypoint，已保存 task 返回缓存结果。模型调用只有落在这种完成边界内，才可沿用旧决策；处于未完成节点内部的普通调用可能再次请求模型。副作用仍需幂等，task/interrupt 的位置变化也会影响历史匹配。参见 [Functional API](https://docs.langchain.com/oss/python/langgraph/functional-api#determinism)、[Interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts#rules-of-interrupts)。

显式从旧 checkpoint 做历史 replay，会重新执行其后的节点，包括模型和 API 调用；这与失败恢复复用 pending writes 不同。参见 [Replay](https://docs.langchain.com/oss/python/langgraph/checkpointers#replay)。还有一个本次源码审阅的限制：[`read_task_statuses`](https://github.com/langchain-ai/langgraph/blob/8a77332d0db75c49d296b1f3833a3a5ccd5f0dc8/libs/langgraph/langgraph/pregel/_task_status.py#L23-L48) 注释指出，带部分输出写入的失败 task 可能被判为 finished。本次未运行复现，不能据此推断所有版本的行为，但也不能把常规恢复语义扩大为任意失败现场的完整恢复。

### Temporal：历史驱动的编排重放

服务保存 Workflow History，包括输入、Activity 调度和完成事实等；Worker 重新运行 Workflow 代码，历史结果满足其发出的操作。Workflow 需要产生与历史兼容的 Command 序列；这不是要求内存逐字节相同。外部 I/O 由 Activity 承担。参见 [Event History](https://docs.temporal.io/workflow-execution/event)、[Workflow Definition](https://docs.temporal.io/workflow-definition)。

TypeScript 源码给出明确链条：离线重放入口 [`runReplayHistory`](https://github.com/temporalio/sdk-typescript/blob/c42ad422e91174967984c6793b4b0b72502872c7/packages/worker/src/worker.ts#L641) 装入历史和 Workflow 代码；[`scheduleActivityNextHandler`](https://github.com/temporalio/sdk-typescript/blob/c42ad422e91174967984c6793b4b0b72502872c7/packages/workflow/src/workflow.ts#L216) 发出命令并登记当前 Promise；[`Activator`](https://github.com/temporalio/sdk-typescript/blob/c42ad422e91174967984c6793b4b0b72502872c7/packages/workflow/src/internals.ts#L661) 启动函数、按完成事件解码结果并解决当前 Promise。它重建内存状态，不读取旧 Promise。

Activity 已产生外部效果、但 Worker 在报告完成前崩溃，仍可能重试。官方将幂等键的执行责任放在被调用服务；拆小 Activity 可以减少重做范围，同时增加历史量。因此，“已确认完成的 Activity 不重跑”不等于“每个外部效果只发生一次”。参见 [Activity Idempotency](https://docs.temporal.io/activity-definition#idempotency)。

版本也属于执行契约：当前提供 Pinned Worker Deployment，自动升级则仍要求保持重放兼容。恢复需要完整历史与兼容且可执行的 Worker 代码；Activity 是否再次执行受超时和重试策略约束，不能混同为 Workflow 必须配置业务重试。参见 [Worker Versioning](https://docs.temporal.io/worker-versioning)、[Tasks](https://docs.temporal.io/tasks)。

### Restate：Context 操作日志与持久完成结果

恢复时再次进入 handler，通过 Context API 与 Journal 匹配。`ctx.run` 包住非确定性工作并保存返回结果；闭包可能被跳过，所以不能依赖它修改外层变量来恢复状态。参见 [Durable Steps](https://docs.restate.dev/develop/ts/durable-steps)。

[`ContextImpl.run`](https://github.com/restatedev/sdk-typescript/blob/02a12acb879fcf46448d88d028304d3a3113e7e2/packages/libs/restate-sdk/src/context_impl.ts#L621) 调用 core VM，只在需要实际执行时调用 action，再提交序列化结果。共享 core 的 [`SysRun`](https://github.com/restatedev/sdk-shared-core/blob/382649d0652aa6d971ec16e788d24b4b2c8c8b45/src/vm/transitions/journal.rs#L718) 匹配命令和 completion；只有 Run 命令而没有完成结果，仍可能再次执行。相关 [调用协议](https://github.com/restatedev/sdk-shared-core/blob/382649d0652aa6d971ec16e788d24b4b2c8c8b45/docs/service-invocation-protocol.md#run-mechanics) 区分执行返回、提交 completion、服务端保存与确认。

Restate 内部 RPC/KV 有自己的协议保证，任意外部 HTTP/数据库操作没有自动获得同样保证。数据库提交成功而完成结果未保存的窗口，仍需条件更新、幂等 token 或特定事务集成处理。参见 [Databases and Restate](https://docs.restate.dev/guides/databases)、[Request Lifecycle](https://docs.restate.dev/guides/request-lifecycle)。

Invocation 默认固定到原 deployment；应用需保持端点对应的代码不可变，并保留到相关调用结束。迁移仍须兼容旧操作日志，日志和幂等信息也有保留策略。不能把一个 ID 理解为永久保证。参见 [Versioning](https://docs.restate.dev/services/versioning)、[Configuration](https://docs.restate.dev/services/configuration)。

### DBOS：函数重放与逐步骤结果查找

保存 Workflow 输入与 step 结果，恢复后以原输入重新调用函数；遇到已存结果直接返回，否则执行 step。编排必须在给定输入和步骤返回值时保持相同的步骤输入与顺序，非确定性访问放入 step。参见 [DBOS Architecture](https://docs.dbos.dev/architecture#how-workflow-recovery-works)、[Workflows](https://docs.dbos.dev/python/tutorials/workflow-tutorial)。

源码中 [`execute_dequeued_workflow`](https://github.com/dbos-inc/dbos-transact-py/blob/61426cb95bcd749dd18137b4eb483d02b9975d7d/dbos/_core.py#L1185-L1345) 读取保存的输入、定位函数并建立新执行环境；[`check_existing_result` / `record_step_result`](https://github.com/dbos-inc/dbos-transact-py/blob/61426cb95bcd749dd18137b4eb483d02b9975d7d/dbos/_core.py#L2292-L2389) 读取结果或运行后保存；[存储查询](https://github.com/dbos-inc/dbos-transact-py/blob/61426cb95bcd749dd18137b4eb483d02b9975d7d/dbos/_sys_db.py#L2951-L3029) 按 Workflow ID、function ID 匹配并核对函数名。这个查询并不全面比较本次输入，正确重放仍依赖声明约束。

普通 step 的外部效果完成与 step 结果保存之间，仍有重复窗口。事务能力的加强保证来自业务数据库写入和结果在同一事务提交，不能推广到任意远端副作用。参见 [Steps](https://docs.dbos.dev/python/tutorials/step-tutorial)、[Transactional Outbox](https://docs.dbos.dev/python/examples/outbox)。未处理业务错误也不同于进程中断，恢复和版本匹配有各自条件。参见 [Workflow Guarantees](https://docs.dbos.dev/python/tutorials/workflow-tutorial#workflow-guarantees)、[Recovery](https://docs.dbos.dev/production/workflow-recovery)、[Upgrading Workflows](https://docs.dbos.dev/python/tutorials/upgrading-workflows)。

### 对照后的共同点与区别

| 机制      | 主要恢复依据                          | 哪部分会再次执行                                    | 对 CAPiX 的启发                                      |
| --------- | ------------------------------------- | --------------------------------------------------- | ---------------------------------------------------- |
| LangGraph | 图状态、channel 版本、任务写入        | 未完成节点的控制代码；没有持久完成结果的 task       | 显式状态边界可以小于整个程序，不需要保存栈           |
| Temporal  | 运行命令与完成历史                    | Workflow 控制代码；无确认结果的 Activity 依策略重做 | “游走”必须维持历史兼容，外部效果另有契约             |
| Restate   | Context 操作 Journal 与 completion    | handler 控制代码；无持久完成结果的 run 依策略重做   | 声明持久边界与普通函数调用有本质区别                 |
| DBOS      | Workflow 输入和按位置存放的 step 结果 | Workflow 函数；没有保存结果的 step                  | 普通代码式编排可恢复，但步骤身份、顺序和版本要受约束 |

这是机制归纳，不是选型排名。四者都提供了真实可用的恢复模型；同时，它们都对哪些行为受管理、什么完成事实已保存、哪些外部操作允许重做设定了条件。投入的重点不只是存储，更是持续维护这些条件。

## 3. CAPiX 当前已有的基础与明确缺口

### 已有能力

- **内容是权威实体。** Transcript 与 Memories 先提交持久变更，再更新内存并通知；已保存消息、记忆可恢复，不需要重做旧调用。参见 [内容持久化](persistence.md)。
- **外部请求与调用寿命已分开。** Interaction 固定请求和反馈，A1 等待结束后 A2 可以读同一交互。保存的完整模型反馈可再次解释；无反馈的恢复交互明确 unavailable，不自动重发。参见 [交互边界](interactions.md)。
- **返回和接纳已有独立表达。** InvocationChildren / InvocationRelation 区分子调用返回、父层开始接纳和接纳结果，不需要为了恢复重新发明这几个事实。参见 [relation.ts](../server/runtime/src/invocation/relation.ts) 的 `returnedWith`、`accept`。
- **声明、资源与单次调用有边界。** 可重建绑定结构，新建 Context/Invocation；资源入口受控。这为以后限定恢复能力提供接缝，不等于已经拥有恢复契约。
- **客户端反馈独立。** 接回仅查询和 follow 原提交，消息同步另行进行。服务执行不会因网络重连而重做。参见 [客户端接回](client-runtime.md)。

### 当前没有保存的内容

| 位置                 | 实际状态                                                       | 若要恢复，需要另外确定什么                            |
| -------------------- | -------------------------------------------------------------- | ----------------------------------------------------- |
| Invocation / Context | 本次身份、轮次、阶段、真实 IO 与关系存在内存；run 只运行一次   | 恢复数据如何重建活动，不把原对象反序列化后复活        |
| Sequence             | 每次 run 新建空 outputs，从第一项开始                          | 哪个步骤结果可以复用，如何匹配，接纳是否可重做        |
| 对话 E               | selection、step、state、feedback、checkedCandidates 是局部变量 | 保存业务状态，或用受约束重放重新导出这些值            |
| 资源 capture         | 本次固定历史范围、记忆快照、配置与惰性来源                     | 旧输入与当前资源如何区分，哪些数据固定、哪些重新检查  |
| 绑定身份             | 子声明/资源主要按对象身份绑定，子 key 表示组合位置             | 跨进程声明版本、绑定定位和逻辑步骤位置                |
| Submission           | 有界进程内 Map，不跨重启                                       | 若承诺同一工作继续，需持久身份与状态，不能只改 follow |
| 文件保存             | 发布文件后返回凭据；未与数据库推进状态共用事务                 | 发布结果如何核实，同一次效果如何识别                  |

代码入口：[Invocation.run](../server/runtime/src/invocation/invocation.ts)（193 行）、[Context](../server/runtime/src/context/context.ts)（13 行）、[Sequence.run](../server/runtime/src/composition/sequence.ts)（72 行）、[E.execute](../services/observer/src/conversation/execution.ts)（69–125 行）、[bindResources（资源捕获）](../server/runtime/src/resource/bindings.ts)（207 行）、[BoundChildren](../server/runtime/src/binding/children/bound.ts)（原 binding/children.ts，35 行）、[Submission 保留](../services/observer/src/conversation/submission.ts)（294 行）。行号对应本文基线。

`key: 'decision'` 会在 E 循环中多次出现，当前随机 Context ID、结构 ID、资源 supplyId 也各有原职责。不能直接挑一个字段作为持久步骤身份。若选择重放，通常需要逻辑工作、组合位置、迭代位置与声明版本的匹配规则；这些可以是内部地址，不必变成新的 REOA 层级或大量公共实体。

### 记录为什么不能直接成为恢复依据

记录当前是可选观测结果，允许关闭、缺损或只保存描述信息。例如 [ReadTextDefinition](../services/observer/src/conversation/attempt/files/read.ts) 的 output 使用 `documentDescriptor`，[ProcessDocumentDefinition](../services/observer/src/conversation/operations/document/process.ts) 也将父层接纳记录映射为 descriptor，但后续生成实际需要 `outputs.read` 中的正文。

因此，不只是“记录不应该承担恢复”这个设计偏好；现有数据事实上不足以重放。恢复所需的完整结果、推进位置和效果归属必须有自己的权威契约，可以再被记录解释。必要恢复数据的写入，也不能依赖默认隔离消费者错误的可选观测出口。

## 4. 最需要核对的是中断窗口

同一个业务步骤可能依次经过以下位置，其中部分顺序由具体能力决定：

```text
固定输入 / 建立交互
    → 实际调用或实体操作
    → 得到返回
    → 保存返回依据
    → 父层接纳（这里也可能追加消息或改变实体）
    → 父层推进状态成立
    → 向客户端交付
```

| 中断点                                     | 目前可能保留下来的事实               | 不能做的推断 / 未来要补的约定                                      |
| ------------------------------------------ | ------------------------------------ | ------------------------------------------------------------------ |
| user 消息已追加，E 尚未创建                | Transcript 已有输入；可能没有 E 记录 | 缺少 E 不等于未受理；再次进入原入口可能重复追加                    |
| Interaction 已记 started，远端结果尚未保存 | 已固定请求和发送意图                 | 不知道远端是否执行；不能直接认定可重发                             |
| 模型完整反馈已保存，A/O 尚未接纳           | Interaction 中有原反馈               | 可以再次读取；还需知道逻辑步骤对应哪笔交互及按哪个契约解释         |
| assistant 消息已追加，父接纳状态未保存     | Transcript 已有回答                  | 再次 accept 可能追加第二条；只缓存 child 输出不够                  |
| 文件已 link 发布，凭据或父状态丢失         | 文件可能存在                         | 同路径已存在不证明属于本次；不能当作未写入，也不能直接伪造成功凭据 |
| 记忆整批已提交，调用收尾未保存             | Memories 已有新事实                  | 整批原子性不等于重复消费幂等；重跑 create 仍可能新增               |
| 服务工作已结束，客户端反馈丢失             | 进程内提交、正式内容可能仍在         | 当前 follow 已处理这类问题，不需要启动执行恢复                     |

具体位置：输入先于 E 建立，见 [entry 流程](../server/runtime/src/execution/execution.ts)（72–95 行）与 [输入追加](../services/observer/src/conversation/accept.ts)（35 行）；父层追加回答见 [receiveAnswer](../services/observer/src/conversation/execution.ts)（144 行）；`InvocationRelation.accept` 先运行接纳函数，再标记 accepted（83–90 行）；交互发送/保存见 [Interaction](../server/runtime/src/interaction/interaction.ts)（64–107 行）；文件发布见 [WorkspaceFiles](../services/observer/src/files/workspace.ts)（136 行起）。

这些中断窗口说明：**恢复粒度不能只按 E、O、A 名称选择，而要看一个边界两侧的事实能否对应起来。** 一个 A 内也可能有多个效果；一个父层 accept 也可能不只是纯数据转换。

## 5. 对 CAPiX 的两条候选路径

以下是分析建议，不是新增 API 或实施决定。它们可以组合，也可以只对少数声明开放。

### 路径 A：显式保存业务推进状态

由可恢复的业务声明定义可序列化状态与下一处推进位置。宿主加载后建立新的绑定和调用活动，从该位置继续，而不是重新进入原请求接纳入口。

以当前 E 为例，状态可能包含已固定的输入位置、选择结果、文件目标、已接纳回答位置、保存凭据、决策步数与待消费交互。它不包含资源端点、Provider、AbortSignal、闭包或实际 Context。

优点是恢复承诺容易限定；代价是业务要显式维护推进状态，过度应用会把普通函数改成庞大的状态机。状态越少，允许重算或重做的范围越大；并不能用一个 `next` 字段掩盖边界内的效果不确定性。

### 路径 B：重新进入编排，复用已确认结果

以固定输入重新运行编排函数；到达某个已保存的逻辑步骤时返回原结果，重建父层局部变量，直到未完成位置。这接近之前讨论的“游走/快放”，并不需要复原原 Invocation 实例。

代价是收紧可恢复声明的编程契约：步骤顺序与版本要可匹配，模型决策、文件读取等非确定性结果要有固定依据，普通控制代码不能悄悄执行副作用，父层接纳的实体变化也须进入受管理边界。现有 `Sequence` 可以成为研究位置，但当前任意 E/O 的 execute 并未满足这些约束。

| 需要的能力              | 显式状态继续           | 编排重放                         |
| ----------------------- | ---------------------- | -------------------------------- |
| 重新建立活动实例        | 需要                   | 需要                             |
| 固定输入、业务/绑定版本 | 需要                   | 需要                             |
| 保存所有局部变量        | 不需要，只保存声明状态 | 不需要，靠执行导出               |
| 重跑此前控制代码        | 通常不用               | 需要                             |
| 外部效果的确认和去重    | 需要                   | 同样需要                         |
| 对普通编程方式的约束    | 声明推进状态与恢复入口 | 限定非确定性、步骤位置与效果入口 |

最小路径不一定是先实现完整 checkpoint。例如“反馈已经保存，重新做一次纯校验”可以是独立消费动作；“回答已经存在，重新提取记忆”也可以是明确的新后处理工作。只有业务要求维持原工作的推进、等待和结果身份时，才需要进一步承担执行恢复。

## 6. 用伪代码验证承诺，而不是先增加类

### 先验证已有反馈的重新解释

下面都是概念代码，不是仓库现有接口。`saved` 表示经过另行设计、已经可靠保存的逻辑位置；不能从可选 Record 反查来伪造它。

```ts
type SavedModelPosition = {
  workId: string;
  position: string;
  definitionVersion: string;
  interactionId: string;
  requestDigest: string;
};

async function consumeSavedModel(saved: SavedModelPosition, bindings: RecoveryBindings) {
  const definition = bindings.resolveVersion(saved.definitionVersion);
  const interaction = await bindings.interactions.read(saved.interactionId);
  verifyRequest(interaction, saved.requestDigest);

  if (interaction.kind !== 'received') {
    return { kind: 'unavailable', reason: '没有已保存反馈，不能据此重发' };
  }

  const output = definition.decode(interaction.feedback); // 这一步限定为纯解释
  return { kind: 'interpreted', output };
}
```

它能够说明“新的消费活动可以使用旧交互”，但还没有完成父层推进。逻辑位置与 Interaction 的关联必须在可能发送之前可靠建立，或者能通过可靠的唯一业务键查回；仅在 A 返回后保存 interactionId，会留下已发送但关联丢失的窗口。当前 create/start 流程没有为执行恢复提供这项跨实体承诺，不能假定已解决。

### 再验证消息落实与推进之间的闭合

```ts
// 假设能力：当前 Transcript 和执行状态尚未提供这个跨对象事务。
// 这里只展示所需保证，不决定由哪个类或接口实现。
const committed = store.transaction(() => {
  const existing = effects.find(effectKey);
  if (existing) {
    verifySameMeaning(existing, { workId, position, inputDigest, definitionVersion });
    return { receipt: existing, progress: progress.read(workId) };
  }

  requireExpectedProgress(workId, expectedRevision);
  const message = appendStoredAssistant(answer.content);
  const next = advanceSavedProgress(previous, message);
  const receipt = effects.insert({ effectKey, workId, position, inputDigest, definitionVersion, message });
  progress.save(next);
  return { receipt, progress: next };
});

installIfNewer(committed.progress); // 不用历史接纳快照覆盖更晚的当前进度
```

如果持久实体写入与接纳凭据能在同一存储事务中成立，提交后崩溃可以读取同一凭据，不再次追加。这里的 inputDigest 要覆盖实际写入内容；旧凭据证明这个效果已经完成，当前推进位置仍读取权威进度，并按版本安装，不能回退到旧凭据对应的历史位置。否则需要效果所属实体支持可靠的同次操作查询/去重，不能靠“append 后再 checkpoint”解决。

这段代码不是让运行内核直接访问 SQLite，也不是允许绕开 Transcript 的审查和更新不变量。若选择这种保证，实体持久端口与服务推进存储需要共同设计提交、内存安装与失败行为；恢复仍由实体正式 restore。这里正是尚未闭合、不能用 helper 隐藏的成本。

同样的事务不能包住任意外部文件或 HTTP 调用：

```ts
const published = await external.create(fixedRequest);
// 此时进程消失：外部效果可能成立，下行保存尚未发生。
await progress.saveReceipt(published);
```

这需要能力自己的合同：稳定效果身份、外部幂等或状态查询、已知可安全重做的语义，或者保留 unknown。仅检查目标存在、内容相同或增加自动重试次数，都不能普遍证明同一效果已经完成。

### 最后看“游走”的隐藏约束

```ts
// 概念 API；每个 durable 单元都必须解决上一节的中断窗口。
const selected = await durable.step('selection', fixedInput, selectHistory);
const choice = await durable.step(`decision/${step}`, decisionInput, decide);
const delivered = await durable.step(`capability/${step}`, fixedChoice, invokeCapability);
const accepted = await durable.accept(`accept/${step}`, delivered, acceptCapability);
```

写起来短，不代表承诺小。`acceptCapability` 若仍任意 append，最后一行只是换了函数名。读取历史结果还要核对位置、输入与版本，不能把旧决策套在新输入上；模型输出是否沿用，由持久边界决定，不能通过重新请求模型“尽量得到同一结果”。

## 7. 我的判断与下一次讨论的切入点

**可以做有限执行恢复，但目前还不能从已有持久化直接推导出来。** REOA、资源、返回/接纳、Interaction 的分离有价值：需要补的是某些边界的持久协作契约，暂未看到为了恢复重写 REOA 层级的理由。是否需要通用机制，要由验证结果决定。

我建议先用同一组断点推演两条路径，选择一个很小的承诺，例如：**完整模型反馈已经保存后，进程中断，能够重新解释该反馈，并至多落实一次对应的正式消息。** 前半段利用现有 Interaction，后半段暴露必要的新契约；输入接纳归属和交互定位必须一并说明，不能跳过。

在实施之前，应明确六件事：

1. **逻辑工作的身份和期限。** 是否沿用持久化后的提交身份、结果保留多久；当前 submissionId 本身还没有这个服务承诺，不预设新增统一 Run 实体。
2. **允许继续的位置。** 按业务状态还是重放历史定位；已明确失败/取消的工作不得仅因进程重启而复活。当前异常处理和进程中断要保持区分。
3. **旧输入与当前条件。** 哪些原文、记忆、决策、文件正文需要固定，哪些资源必须重新检查。UID、范围或 hash 只有在原数据仍可取得时才足够；资源端点、密钥和旧信号不直接持久化。
4. **返回、接纳与效果凭据。** 哪些结果可复用，哪些消费允许重复，不确定结果如何终止自动继续。未取得结束记录不能替代这些判断。
5. **代码与绑定版本。** 如何解析相容声明，版本不存在或数据不兼容时应明确不可恢复，不能悄悄套用最新实现。
6. **推进权。** 第一步可以保持单进程、单个明确恢复者；如果未来允许多个实例接管，就需要相应的排他/租约或 fencing。负载均衡改善可用性，不会自行回答原实例是否仍在写、旧外部效果是否成立。

未来的故障验证应检查：输入已落库但 E 未建立；反馈已保存但未接纳；消息已提交但推进未保存；文件已发布但无回执；重复消费；版本不匹配；关闭 Recorder。关键断言是模型没有误重发、正式消息没有重复、未知效果没有伪装为成功、观测缺失不影响恢复依据。本次仅列出这些验证要求，未运行这些未来能力的测试。

若这些场景确实需要，先完成一个有限闭环，再决定共性应该进入 Invocation、组合机制、实体持久端口还是服务装配。不要先给所有 REOA 声明增加 checkpoint 字段，也不要把完整 Context 或整个记录树存起来以后再解释它意味着什么。
