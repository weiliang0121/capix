# 运行体系、观测与绑定的改造方案

## 本次基线与边界

2026-10-08，基线提交 `d3b2544`：`refactor: separate runtime declarations bindings and execution structures`。

本次观测迭代已进一步统一 R 调用与观测出口，下方保留历史分析；最新结构以 [观测方案](observation.md)、[运行边界](runtime-boundaries.md) 为准。

本次检查从独立实体创建、资源供给、REOA 声明与绑定，沿调用、上下文、记录检查到服务观测出口及客户端消费点。三个独立只读审查分别覆盖实体与资源、结构与装配、运行端点与观测影响。下方问题审查保留为改造前基线；2026-10-09 已按确认方案实施，当前 API 以 AGENTS.md、runtime-boundaries.md 和代码为准。

结论：业务声明与资源访问已经有基础，主要错位集中在上游装配、业务可见端点以及记录／观测接线。改造按职责调整这些接缝，保留已有执行、记录和变化机制。

本次采用的判断标准：

- 世界的起点是一簇独立实体。Transcript、Memories、模型供应实例、配置数据来源、Recorder 不因被 R 引用就成为 R 的内容或生命周期附属物。
- 原实体引用用于内部装配、适配与实体协作。业务执行、编排、输入构造与结果接纳使用正式资源端点及普通 IO；不能通过闭包、构造参数或调用对象取得旁路引用。
- 声明描述契约与执行内容；绑定了解较大的环境，落实资源、直接子项及调用接线；运行结构管理自身节点与调用机制。绑定不承担业务编排。
- 具体业务复杂度主要在 A，O/E 组合业务；R 当前对应一个 E，不引入 R 业务工作流或具名多 E 路由。
- 可复用的运行节点、本次 Invocation、Context、Record 是不同对象；建立节点、建立本次现场、开始并登记记录是不同时间点。

## 上轮已落地的边界（2026-10-09，观测迭代前）

- 环境独立创建 Transcript、Memories、SelectionUsage、模型初始化器、Recorder 与变化捕获；RContext 只持有占用。`bindObserver` / `assembleRuntime` 产出唯一 `R.run(request, options, callbacks)` 业务入口。
- E 的 `entry.requires/accept/admit` 说明提交契约，固定机制保持占用、检查、接纳、HTTP accepted、分段、资源捕获、Context/Invocation、started、记录、工作顺序。入口端点只在接纳窗口内有效。
- 业务 execute/receive 使用 Scope / InvocationView，子关系也是只读投影；真实 Context、Recorder、资源重绑定等内部能力不向业务开放。原始 IO、错误对象身份仍保留以支持有限再次生成。
- 资源声明定义访问接口及事实正文；共享供给和固定快照，逐调用绑定端点及来源。记录资源 `bound/available/unavailable/started/returned/threw`，无记录时不执行描述映射，方法仍保持原本同步或异步形式。
- 记录只以 `transcriptId + index/范围 + revision` 关联消息实体；E 不再特化保存 settings/transcriptRange。资源事实属于具体 E/O/A 调用的直接下级；内容变化仍由实体产生。
- 消息通过独立受控 HTTP 查询／订阅取得；客户端按集合身份和版本保有权威副本，绑定层与记录定位符组合。不使用观测也能对话；停止观测不停止消息同步。
- 保留严格记录与捕获失败，不回滚已发生变化，不重做已完成操作。网络/UI 消费者失败不能回灌到运行流程。

详细实现与验证见当前 [运行边界](runtime-boundaries.md)、[协议](protocol.md)、[客户端](client-runtime.md)。本轮不引入持久化、通用实体仓库、权限系统、多 R 管理、调度或新的可视化布局。

2026-10-09 最终 `pnpm check` 通过：所有包构建与类型检查、345 项测试、格式检查。独立审查发现并修复回答位置必须紧邻输入、UI 订阅异常中断实体同步两处问题；回归包含真实本地 HTTP 链路，模型使用注入实现，没有访问真实模型服务。依赖与工具链版本未变。

## 术语与分析维度：运行时是一切的活动状态

**“运行时”表示整个系统实际活动起来时的状态、对象协作与事实产生，不指 Runtime 类，不是一个待创建的对象、容器或总的执行范围。** 本文讨论具体 R 层时使用“R”或代码名 `Runtime`，不再用“运行时”指代它。

下面三个视角应分开理解：

| 视角     | 要解释的问题               | 当前约定                                                                             |
| -------- | -------------------------- | ------------------------------------------------------------------------------------ |
| 职责线   | 哪种职责参与系统活动？     | 运行线、观测线；持久化线未来讨论                                                     |
| 组织方式 | 能力与机制如何定义和接线？ | 运行线明确声明、绑定、结构；观测线也有自身契约、实现及绑定，但不机械复制同样的类体系 |
| 活动状态 | 装配好的对象实际如何工作？ | 节点被调用、上下文演进、内容实体变化、记录形成、事实被捕获和消费                     |

这三个视角不构成依次进入的三层流水线。观测对象也在运行时活动，独立实体也可以在没有 EOA 调用时发生变化。职责线用来解释协作，不把所有对象强行划为互斥的归属类别。

“汇合”指不同职责通过已绑定的端点在具体活动处协同。例如 Invocation 推进过程时，记录能力保留过程证据，捕获能力接收进度事实；Transcript 追加消息时也有自己的相应端点。系统不存在一个接收全部对象的统一“运行时层”。

R 仍是 REOA 中的具体运行结构，负责当前约定的 E 入口和占用。Transcript、Memories、Recorder、捕获器和发送者的存在、活动及生命周期不因此从属于 R。

## 改造前对象与调用关系

```text
initializeObserver
  ├─ RecordBook / Clock / ChangeObserver / Recorder
  ├─ createRuntime
  │   ├─ Transcript / Memories / SelectionUsage
  │   ├─ RuntimeContext（三者的引用）
  │   ├─ RuntimeRecord
  │   └─ Runtime（EOA 构造器、记录能力、运行占用）
  ├─ ObserverRuntimeDefinition
  │   ├─ model 实例或工厂、providers、admit 分段策略
  │   └─ conversation E 声明 → O 声明 → A 声明
  └─ ObserverBinding
      ├─ 模型 Initializer、入口资源绑定
      └─ RuntimeBinding.execution('conversation', source)
          └─ ExecutionBinding
              ├─ E 声明、资源捕获、BoundChildren
              └─ Execution（主要转发给 InvocationBuilder）
```

```text
HTTP → ObserverBinding.converse/submit
  → ExecutionBinding.submit → Execution.submit
  → ExecutionInvocationBuilder.submit
  → Runtime.run(work) 取得占用
      → validate → accept 输入 → admit 分段
      → 捕获范围、配置和资源 → Context / Invocation
      → started → 变化通知 → Record 登记 → execute
          → E 的 Sequence → O → A
          → 回答追加与交付 → 记忆后处理
      → 结束 → 释放占用
```

这条链目前可以工作，但“哪个对象是已装配的 R/E/O/A 节点”并不清楚：调用入口在 Binding，Structure 又提供一层入口，R 则被 E 构造器回调使用。

## 改造前发现与代码摘要

### 1. R 的创建仍暗含内容实体创建

[runtime/create.ts](../server/runtime/src/runtime/create.ts) 创建 Transcript、Memories 和 SelectionUsage，再将三者放入 [RuntimeContext](../server/runtime/src/context/runtime.ts)。[Observer 环境](../services/observer/src/observer/environment.ts) 反过来从 `runtime.context` 取回消息集合。

```ts
// 当前关系的摘要，省略记录和变化接线。
const transcript = new Transcript(messages);
const memories = new Memories(transcript);
const context = new RuntimeContext(transcript, memories, new SelectionUsage());
return new Runtime(context, options);
```

这些实体本来就有自己的身份、状态与正式更新入口。Memories 内部引用 Transcript 以验证记忆来源属于实体协作，应该保留；把这两个实体视作 R 的内容范围则没有同样的依据。

建议由环境显式创建这些实体并接线；资源绑定侧使用明确的实体来源，不再使用 `source.runtime` 作为通用大包。R 持有运行所需的绑定与内部能力。这里不要求引入一个新的环境管理器，现有初始化函数足够。

### 2. 声明、绑定和运行结构尚未对齐

[Runtime.run](../server/runtime/src/runtime/runtime.ts) 当前只接受回调并取得占用；[RuntimeBinding.execution](../server/runtime/src/binding/runtime.ts) 实际完成查声明、检查资源与子图、创建 E 结构和绑定。

```ts
// 当前 API 的职责摘要。
runtime.run(work); // busy 检查与 finally 释放
binding.execution(key, source); // 每次调用创建新的 E 结构与子缓存
executionBinding.submit(accept, options); // 真正使用声明和绑定发起工作
```

`execution(key)` 看似获取节点，实际重新建立节点；`Runtime.run` 看似执行业务结构，实际只负责排他。这是命名和对象持有关系一起错位。

[Execution](../server/runtime/src/execution/execution.ts)、[Operation](../server/runtime/src/operations/operation.ts)、[Attempt](../server/runtime/src/attempt/attempt.ts) 主要转发给 Builder；定义、资源和子项主要放在对应 Binding。O 另有被观测使用的稳定实例 ID。

建议让运行实例成为明确的节点：持有落实后的绑定、直接子节点及自身构造器。绑定负责产生这个节点需要的装配结果，不再与 Structure 并列暴露两套可运行入口。应重分现有对象职责，而不是额外增加 Runner 或另一套节点包装。

R 最终通过 `run(input, controls)` 驱动唯一已装配 E；现有 `run(work)` 的占用逻辑转为内部机制。无需为 E/A 机械补实例 UUID，也无需为 R 机械增加一次 Invocation。

### 3. Service 的 R 声明混入了实体供应与 E 业务策略

[ObserverRuntimeDefinition](../services/observer/src/observer/definition.ts) 当前既接收 `ModelProvider | (() => ModelProvider)`，又持有分段函数 `admit` 和供应函数表；[ObserverBinding](../services/observer/src/observer/binding.ts) 同时负责模型初始化、R 引用、E 绑定、入口资源和对话流交付。

模型实例／工厂应属于环境供给，供应函数表属于绑定接线。按历史容量选择新分段是 E 入口的具体业务策略，不应放在 R 声明上。R 保留确定的执行次序，不理解模型预算和消息含义。

当前环境返回的 `execution` 实际是 ObserverBinding，HTTP 使用 `observer.execution.converse`。新结构确定之后应一起清理这些名称，避免通过改名把同样的职责混合保留下来。

### 4. 资源访问本身大致闭合，业务调用端点仍过宽

已有效收敛的部分：

- [历史范围资源](../server/runtime/src/transcript/resource.ts) 不返回 Transcript 或 MessageRef，slice 只能收窄；追加端点只返回普通消息及索引。
- [记忆资源](../server/runtime/src/memory/resource.ts) 返回快照，apply 不返回 Memory 实例。
- [模型资源](../services/observer/src/model/resources.ts) 通过包装对象提供 invoke，保留供应者方法的接收对象；没有把 Provider 原实例直接交给 A。
- [ResourceBindings](../server/runtime/src/resource/bindings.ts) 按资源公开项目身份匹配，子层只能选择父层已提供的项目；配置、范围和记忆快照固定时机，模型及部分访问对象按需兑现。

不过 [InvocationDefinition](../server/runtime/src/definition/invocation.ts) 的 execute/receive 仍接收完整的 Context 与 Invocation。当前业务实际只需要其中一部分：

| 业务实际需要                                               | 当前额外可达                                                        | 建议边界                 |
| ---------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------ |
| input/currentInput、signal、id、进度、资源值、continueWith | Context.startRound/receiving/complete/fail，ResourceBindings.select | 本层工作现场的实际窄视图 |
| 本次来源、直接子调用证据                                   | Invocation.record、run、原 Context                                  | 本次调用的受限端点       |
| 建立已声明的直接子调用、读取其状态和结果                   | 完整子 Invocation、可修改的关系对象                                 | 子调用句柄与只读关系证据 |

一条具体旁路是：

```text
业务 Invocation.record
  → ExecutionRecord.value.transcriptRange
  → TranscriptRangeRef.transcript
  → 原 Transcript
```

[记录复制](../server/runtime/src/records/value/copy.ts) 有意保留内部 Ref，[TranscriptRangeRef](../server/runtime/src/transcript/ref.ts) 也公开其来源。内部记录这样保存有用途；问题是原 Record 通过业务端点流出。**目前没有发现实际业务沿这条路径绕过资源，不能把接口缺口报告成已发生的数据破坏。**

`ChildBindings = Pick<BoundChildren, ...>` 只收窄 TypeScript 类型，实际仍返回完整 BoundChildren；`create` 又返回原 Invocation。需要构造实际窄对象，不能只增加几个类型别名。此改造是正式接口约束，不承诺隔离任意不可信 JavaScript，也不引入权限系统。

### 5. Context、Record 能携带业务数据，但不能执行业务政策

通用 Context 保存输入、进度、结果，没有分析消息或模型的业务逻辑；这一点应保留。业务输入构造、输出契约及再次生成决策继续在具体声明中。

尚有明确的记录特化：[ExecutionRecordMetadata](../server/runtime/src/records/execution/helper.ts) 和 [ExecutionValue](../protocol/src/records.ts) 固定包含 `settings`、`transcriptRange`。service 已掌握何时捕获它们，但核心记录格式仍认识 Observer 信息。

建议本轮先隔离原 Record，保留现有观测字段。后续单独收敛 Observer 观测描述的归属；不能改成 `unknown` 或任意 `metadata` 字典就宣称已解耦。若迁移这些字段，需要同步 service 的 overview/selection/inspect 与 app 的详情和快照投影。

RuntimeContext 的初步改造已确认：内容实体引用迁出后，仅接管 R 现有的唯一占用状态，不加入无消费者的执行历史或当前 E 集合。这还不代表 R 的持续数据生命周期已完整设计。RuntimeRecord 的根关联、创建时间与子引用保留，R 实例存活也不直接等同为全部数据生命周期。

### 6. 来源与子关系需要保留准确语义

`Invocation.source` 是纯 ID 的 [ChangeSource](../server/runtime/src/records/source.ts)，不是原实体。业务目前两处使用：E [追加回答](../services/observer/src/observer/execution.ts)，A [落实记忆](../services/observer/src/attempt/memory/apply.ts)。其中 callId/executionId/operationId 是记录身份；无 Recorder 时整个 source 为 undefined。现有内容变化事件也不带调用来源，因此无记录时虽然仍有调用进度与内容变化，却不能可靠关联“哪个调用产生了这次变化”。

需要区分运行来源与记录引用：前者表达已经成立的调用关系，可以从现有 Context 身份和直接父子关系着手；后者表达启用记录后对应的 Record 关系。来源事实由运行机制确定，记录绑定负责记录映射，观测不能靠事件相邻或时间相近猜测归因。不建立新的全局身份平台。先确定最小来源契约；其后如需传入内容变化事件，应同步调整 protocol 和客户端类型，并保持缺省情况下已有行为，不能声称只是内部接线。

如果以后写资源自动绑定来源，必须绑定到当前 E/A 调用。资源值目前沿父子层共享，不能在 E 捕获时缓存 E 来源给全部下层，否则 A 的记忆变化会错误归属到 E。

[有限再次生成](../services/observer/src/model/regeneration.ts) 确实依赖直接子调用的归属、先后、轮次、位置 key、输入、返回、接收状态及原始输出身份。需要继续区分：

```text
子层工作完成 ≠ 子层成功交付给父层 ≠ 父层成功接纳
```

只读关系证据必须保留这些事实及身份关联，不能通过 JSON 复制消除对象身份，也不能重新依赖 Recorder 反查。创建、运行和接收登记仍由固定组合机制负责。

### 7. 实体独立不等于本轮支持任意跨 R 共享

[ObservationFeed](../services/observer/src/observer/feed.ts) 已有独立 scopeId，基线分别标识 Transcript、Memories、Recorder；[客户端副本](../client/runtime/src/observation.ts) 区分交付顺序和来源顺序。因此环境装配迁移不要求重做快照／增量协议，也不要求业务流依赖记录。

但当前 feed 读取同 Book 内全部运行中的 E，selection 按 TranscriptRangeRef 归组，客户端要求 Recorder revision 连续。若多 R 共用来源，不能简单过滤其他 R 事件，否则会留下序号缺口。本轮保持“一套 Observer 环境明确选择一组来源”，不顺带支持任意共享环境、分域重放或多会话。

内容变化记录挂在调用下面表达的是**产生位置**；它不意味着消息集合或记忆集合实体属于该调用。不要把实体持有关系、调用关系和记录因果关系合并成一棵万能树。

## 已确认的目标关系

```text
运行线
  A / O / E / R 声明 ──运行绑定──→ 已装配的 REOA 结构
  独立实体／配置来源 ─资源绑定──→ 业务可访问的限定端点

观测线
  记录实现 ──记录绑定──→ Invocation / 内容实体的记录出口
  捕获实现 ──捕获绑定──→ Invocation / 内容实体 / Recorder 的变化出口
  查询与交付 ──接线──→ 明确的数据来源与捕获消费入口

持久化线（未来）
  待具体保存／恢复需求确定，不预置入口、对象或依赖关系
```

这些是职责及绑定关系。它们在实际活动时表现为下面的协作；没有新增“运行时对象”：

```text
调用活动       Invocation 推进 ↔ Context／直接子调用关系
                   ├─ 已绑定的记录端点 → 调用记录
                   └─ 已绑定的捕获端点 → 调用变化事实

内容活动       Transcript／Memories 正式更新
                   ├─ 已绑定的记录端点 → 内容变化记录
                   └─ 已绑定的捕获端点 → 内容变化事实

记录活动       Recorder 正式登记／更新
                   └─ 已绑定的捕获端点 → 记录变化事实

观测活动       捕获消费／来源查询 → 投影 → 交付
```

不同活动之间通过身份、直接关系和来源关联。记录不是观测专属数据，观测也不强制通过记录才能获取所有事实。图中的记录绑定由当前观测装配选择，独立使用记录的能力仍然保留。

每个位置需要能解释自己的职责，不要求每层机械增加相同数量的类：

| 位置           | 应持有／处理                                     | 不应承担                                         |
| -------------- | ------------------------------------------------ | ------------------------------------------------ |
| 初始化函数     | 创建独立实体、选择供应与记录出口、组合声明       | 世界根、全局实体管理器                           |
| 声明           | 输入输出契约、资源申请、执行内容、EO 业务编排    | 原实体引用、当前调用状态                         |
| 运行绑定       | 环境接线、资源兑现、直接子声明解析、本次来源捕获 | 筛选历史、模型策略、记忆判断                     |
| 记录／观测绑定 | 选择实现和出口、建立每来源／每调用的接线         | 决定业务流程、猜测事实发生位置、统一持有所有实体 |
| 运行节点       | 落实后的绑定、直接子节点、相应构造器             | 与调用混用的可变输入或信号                       |
| Invocation     | 本次流程、正式状态变化、Context 和记录接线       | Observer 业务规则                                |
| EOA Context    | 本次 IO、进度及已限定的工作现场                  | 全域查找入口、原实体集合                         |
| Record         | 按明确规则留存事实、顺序与关联                   | 驱动工作、决定重试、自动承诺可恢复               |
| 变化出口       | 在正式发生处交付固定事实                         | 由消费者回读可变现场猜测变化                     |

持有方向建议：装配后的节点持有自己的绑定结果；绑定对象不再作为并列的业务运行入口。可复用声明可以服务多个独立装配，惰性子节点按父绑定与声明身份区分，本次调用状态不进入缓存。

运行时这个视角不要求每个对象新增 running 字段、统一生命周期接口或一份 Context。RContext 按已确认方案接管现有占用状态；内容实体已有的状态继续由自身持有。

### 记录与观测绑定的最小边界

保留 recording 与 changes 两个独立出口。记录负责留存可查询证据，捕获负责接收正式变化；待消费队列不是历史仓库，也不是持久化日志。可以只记录、只捕获、两者都装配或都不装配。内核已有这些组合的基础，当前完整 Observer 服务和图谱仍按记录与捕获一起装配，暂不新增产品级模式开关。

绑定负责选择实现与限定接线，Invocation、Transcript、Memories、Recorder 各自负责事实的正式发生位置。业务声明不通过 requires 领取 Recorder 来报告内核进度，也不由外部包装器或快照比较反推进度。

装配时确定共享能力和来源；调用建立时，构造机制再建立当前调用的记录关联、进度序号与计时现场。绑定不只发生一次初始化，但也不因此新增每一阶段的管理器。各来源可使用同一个捕获器的窄接口；每次调用状态独立。

当前 ChangeObserver.take 转移并清空待消费批次，因此由一个消费入口统一取走，再向多个订阅者交付。不能给多个消费者分别 take 而假定每个都收到完整变化。

可选注入需要同时明确以下约定：

| 边界 | 本次约定                                                                               |
| ---- | -------------------------------------------------------------------------------------- |
| 触发 | 由正式变化方法和固定调用机制触发；观测不决定是否发生业务变化                           |
| 正文 | 保留既有快照和冻结规则；开启记录附带可记录 IO 的约束，不能承诺任意 IO 下完全透明       |
| 来源 | 运行来源与记录引用分开设计；当前调用身份不由观测器生成或从相邻事件猜测                 |
| 故障 | 保留目前同步记录／捕获失败的明确传播，不吞错、不重做已落实业务；下游消费者失败继续隔离 |
| 粒度 | 当前调用记录按完整运行树接入，独立内容实体分别接入；不任意只记录 A 而缺失其父记录      |
| 时机 | 建立来源时装配，不实现运行中任意 attach/detach，也不补造未捕获历史                     |

记录与捕获故障可能改变对外返回：工作完成后登记失败，Context 仍可成功而 run 抛错；内容已经改变后捕获失败，后续记录可能缺失。可选装配只说明没有安装仍可执行业务，不表示安装后故障无影响。若未来需要允许丢失的诊断观测，必须另外约定降级和不完整性表达。

未来持久化可能保存实体状态、继续执行所需信息或记录。保存对象、提交顺序与失败保证要按真实需求确定；本轮不把“保存 Record”等同为持久化体系，不预留统一 PersistenceManager。

### 入口与接纳的伪代码方向

以下仅表达职责与先后，不是新公共 API 定稿：

```ts
// 独立实体由环境建立，之后才选择哪些能力向业务开放。
// recording / observation 表示可选绑定；不要求新增同名的统一管理类。
const transcript = new Transcript(messages, {
  recording: recording?.transcript(),
  changes: observation?.transcript(),
});
const memories = new Memories(transcript, {
  recording: recording?.memories(),
  changes: observation?.memories(),
});
const model = new Initializer(createModel);

const execution = new ObserverExecutionDefinition({ selection, generation, extraction });
const definition = { execution }; // R 当前只指定一个 E，不携带 model 原实例或业务 workflow。

// R 只接收自身结构所需的绑定，其他实体已独立取得各自的能力。
const r = assembleRuntime(definition, {
  resources: observerResourceBinding({ transcript, memories, model }),
  recording: recording?.runtime(),
  changes: observation?.invocations(),
});
await r.run(input, controls);
```

这些调用通过实际协作体现运行时状态；`r` 本身只表示 R 实例。recording 与 observation 的实现可以共享 Recorder／捕获器，但每个接收者取得自己的窄端点。Recorder 的变化出口也由环境独立接线，不经过 R。查询与交付在服务消费端接线，不传给业务声明。

这里的 `input` 最终应是正式入口声明约定的数据；`controls` 只承载信号等本次运行控制，不能重新变成全部实体的参数袋。函数名和构造参数仅表示目标分工，具体复用现有 Builder／Helper 还是合并对象，在每个小闭环中确定。

Observer 的新消息接纳还需要在这个方向中明确落位。建议保留一个明确的 E 入口契约：声明侧约定提交数据、接纳资源与业务分段策略；绑定侧提供入口资源；固定机制在 R 占用后执行接纳，再捕获 E 的固定资源。它与当前用于模型再次生成的子层 InvocationEntry 并非已经等价，不先强行合并。

HTTP 只接纳传输格式并提交普通数据，业务批量消息规则和分段策略通过声明资源执行。HTTP 成功响应仍在输入接纳成功之后发出。不能为了简化 `R.run(input)`，在调用 R 之前先把输入写入 Transcript。

## 方案选择与第四项讨论

用户已确认第 1、2、3 项按推荐方案推进，第 5 项当前保持严格失败；第 4 项继续讨论，尚未选定字段和实现形式。以下保留各项比较以说明取舍，已确认不代表已实现。文末历史材料不属于本次待决清单。

### 1. RContext：收敛现有活动状态，还是暂不保留独立对象

| 方案                                 | 代价与适用性                                                                                     |
| ------------------------------------ | ------------------------------------------------------------------------------------------------ |
| 移出内容引用后暂时取消独立 RContext  | 最少对象，当前占用仍在 R；将来出现 R 自身上下文信息时再建立。取舍是当前不再有单独的 R 上下文载体 |
| 保留 RContext，迁入 R 已有的占用状态 | R 持有结构和绑定，Context 持有活动状态；需要从 R 删除重复的 running 字段。无需额外身份或状态机   |
| RContext 同时保存全部 E 上下文／历史 | 增加跨调用持有和清理职责，当前没有相应消费者；容易再次变成总容器，不推荐                         |

**已确认第二项**，初版只迁入现有占用状态。当前 E 关联只有出现明确读取需求才增加，不预存历史。这样 Context 有真实持有内容，又不需要独立的 Session 或活动注册表。

```text
R                已装配 E、运行入口、内部能力绑定
RContext         唯一的当前占用状态及其检查／转换
RuntimeRecord    可选的 R 记录根及 E 记录关系
```

R 仍负责在 try/finally 中取得和释放占用，Context 不执行 E。每次 E 结束释放占用，不结束或销毁 RContext；它也不代表所有独立内容实体的数据生命周期。

### 2. 变化来源：显式传参，还是本次调用的写端点绑定

最小运行来源建议从 `Readonly<{ contextId: string }>` 起步。层级与直接父关系由既有调用事实表达；变化事件不复制所有祖先身份。记录引用继续由本次调用私有的 recording 接线提供，不能凭一个 contextId 恢复全局记录反查。

| 方案                           | 代价与适用性                                                                   |
| ------------------------------ | ------------------------------------------------------------------------------ |
| `writer.apply(data, origin)`   | 改动较小、来源显式；业务要传递机制参数，且纯 origin 仍不能解决记录关联         |
| 业务传递含内部记录桥的来源令牌 | 可避免全局查找，但令牌已超出普通身份数据，业务仍要负责传递                     |
| 每次调用绑定写端点             | 业务只传写入内容，绑定负责真实来源与私有记录关联；需拆清共享供给与单次访问端点 |

**已确认第三项**，先只覆盖 Transcript.append 与 Memories.apply 两个实际写入口，不引入所有资源的通用 Proxy。

```ts
// 概念伪代码：绑定内部持有，业务只取得 messages.append。
const origin = Object.freeze({ contextId: context.id });
const messages = Object.freeze({
  append(values) {
    context.requireActive();
    const recordSource = callRecording?.source();
    return appendMessages(transcript, values, { origin, recordSource });
  },
});
```

记录关联在调用开始登记之后才存在，因此 `callRecording.source()` 在正式写入前解析，不能在建立 Context 时提前求值。这个接线只读当前调用已绑定的记录，不建立 contextId → Record 查询表，也不把 Record 给业务。

共享缓存仍保存实体供应、历史／记忆固定快照和惰性兑现结果；带来源的写端点按调用重新绑定。子调用从共享供给取得自己的端点，不能直接继承父调用已封闭来源的 writer。E 追加回答归 E，A 落实记忆归 A。

E 建立之前的提交接纳，以及普通调用外更新，可以没有调用来源；不能为归因伪造尚不存在的 E。若来源进入 TranscriptEvent/MemoryEvent，需显式修改协议和客户端接纳；保留原有集合顺序与交付顺序。

### 3. E 的入口：把提交与正式工作输入分开

| 方案                                     | 代价与适用性                                                                      |
| ---------------------------------------- | --------------------------------------------------------------------------------- |
| 由 service 在 R.run 前接纳和分段         | 简单，但忙碌检查之前可能已经写入消息，不能直接采用                                |
| 继续把任意 accept 回调作为主入口参数     | 能保持现状时序，但输入契约隐含在回调里，R.run 继续难以解释                        |
| E 声明明确入口契约，固定机制在占用后调用 | 提交数据、入口资源与执行输入可区分；业务决策留在 E 声明，绑定只负责供应和交付接线 |

**已确认第三项**。入口先用类型明确的对象／函数表达，不强制新增类；也不把它强行并入用于子层再次生成的 InvocationEntry。

```ts
// 契约方向，具体类型由内核定义；这些名称尚未落实到代码。
const entry = {
  requires: {
    ...observerEntryRequests,
    messages: TranscriptResource.append.request(),
  },
  accept: acceptSubmittedMessages, // 提交批次 → 已接纳的输入消息
  admit: prepareObserverSegment, // 已接纳输入 → 本次工作前的业务分段
};
```

入口与正式执行分别声明所需资源：接纳需要追加和分段端点，正式执行取得接纳／分段之后固定的历史范围。接纳过程中需要用到的消息规则、预算判断仍由对应业务与实体方法承担，不能进入 R 或公共 Binding。

必须保持更精确的现有顺序：

```text
R 取得占用 → 输入接纳并追加
  → 服务收到“输入已接纳”通知，发送 HTTP 成功头
  → E 入口业务分段
  → 捕获正式执行资源 → Context／Invocation → started → Record → execute
```

“输入已接纳”通知是当前 HTTP 交付边界的接线，不新增一套任意生命周期 hook。现有成功头在分段之前发出；不能将 accept 与 admit 合成一步后，在其全部成功时才响应，否则分段失败的传输行为会改变。

HTTP 解析传输格式和配置；E 入口接收明确的普通提交数据。已追加输入不会因后续分段或记录失败而撤销，不增加接纳事务、回滚或自动重试。当前配置与按次 delivery 等绑定来源继续与业务提交分组表达，不通过入参传入 Transcript 原实体。

“输入已接纳”通知保持当前 append 正式返回后的时点。输入审查失败时整批不追加；但追加已落实后的捕获／记录失败可能使 append 抛错，消息已存在而通知尚未发送。这是已有的失败边界，不能以“接纳失败”笼统承诺未写入。取消时机本轮也保持原行为，不顺带加入撤销或排队机制。

### 4. 资源事实与大实体关联（已确认并实现）

通用调用记录只解释调用；资源自行声明访问契约及事实正文，统一使用 ResourceFact 承载。静态装配不产生记录，正式调用开始后记录绑定及访问事实。配置快照是可记录的数据；模型提供者是惰性能力，记录公开描述和调用信息，不遍历提供者内部对象。

大实体不留活引用，也不默认在记录中展开。Transcript 记录保存集合 ID、索引范围与版本，客户端经受控端点按需或主动同步消息，再按 ID/索引组合。原文追加不可变，消息位置稳定；记忆更新继续保留已有 MemoryRecord 的不可变结果，不增加通用历史版本仓库。

记录可用于诊断、审查和观测；可选观测绑定不改变记录的事实含义。资源契约定义扩展正文，Record/Recorder 不引入具体实体分支。没有 Recorder 时描述函数不执行，也不强制兑现惰性资源。

### 5. 记录／捕获失败：保留严格行为，还是隔离降级

当前可比较两种政策：保留已装配能力的严格失败传播；或者业务继续而观测标记不完整。第二种需要明确缺失如何报告、客户端怎样停止应用不连续的增量、如何重建基线以及不可补齐的记录怎样展示，不能只吞掉异常。

**已确认当前保持严格失败**：记录或捕获失败明确报错，已经发生的业务不撤销、不自动重做；网络和 UI 消费失败继续隔离。记录树按完整调用结构开启，暂不增加 A 单独开启、正文级采样或运行中切换。故障降级与持久化保持后续独立议题。

## 原定推进顺序与验收边界

| 阶段                     | 主要改动位置                                                                                                    | 可单独验证的结果                                                                                            |
| ------------------------ | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 1. 环境与独立实体        | runtime/create、context/runtime、observer/environment、binding、resources                                       | 环境显式建立内容实体；source 不再绕 RuntimeContext 取对象；各实体独立接入记录／捕获能力，业务与输出保持原状 |
| 2. 业务端点与来源        | definition/invocation、binding/work/children、Invocation/Context 对外视图、Sequence、regeneration、内容来源接口 | 业务拿不到原 Record/Context 生命周期写入口；运行来源与记录引用有独立契约，保留直接子调用及有限再次生成语义  |
| 3. 记录与观测绑定        | invocation/capabilities、各 Builder 的 recording/changes 接线、Transcript/Memories 记录接线、Observer 环境      | 稳定能力与每次调用关联分开；事实出口保留在产生处；不通过 Recorder 反推全部变化，不扩大开关粒度              |
| 4. A→O→E 节点持有        | attempt、operations、execution、binding 各层、BindingEnvironment                                                | 每层有明确的已装配节点；绑定与结构不再有两套运行入口；保持惰性建立与父层资源约束                            |
| 5. R 入口及 Service 接纳 | definition/runtime、runtime/runtime、observer/definition/binding/execution、http/server                         | R 驱动唯一 E；模型来源在环境；分段归 E 业务入口；busy 时不追加输入，响应时机不改变                          |
| 6. 清理与闭环            | public exports、测试夹具、源码查看映射、文档                                                                    | 旧入口没有残留调用者；类型、行为与文档对应；新结构不需要兼容转发链维持                                      |

以上阶段已实施：R 的唯一占用迁入 RContext，本调用写端点绑定来源，最小运行来源进入跨端契约，E.entry.accept/admit 保留中间交付通知。第四项随后确认采用 ResourceFact 与实体 UID 定位，正文和消费改造已包含在本轮实现中。

现有测试优先适配而非另建验收体系：

- `test/environment.test.mjs`、`test/initialization.test.mjs`、`test/binding.test.mjs`：实体接线、惰性、定义复用和直接父绑定限制。
- `test/context-resources.test.mjs`、`test/types/`：正式资源身份、固定范围、缺失资源和业务端点的类型反例。
- `test/invocation/composition.test.mjs`、`test/invocation/invocation.test.mjs`：返回与接收分离、started 时机、成功后记录失败。
- `test/operations/regeneration.test.mjs`：归属、顺序、轮次、允许错误、输出身份、容量检查、取消与无记录运行。
- `test/observer/http.test.mjs`、`test/observation/increments.test.mjs`：busy 不追加、回答先交付、取消观测不取消对话、基线接缝、来源序号与整批接纳。

新增检查只聚焦真实边界：实际交付给业务的对象及其关系返回值不含原 Invocation/Context/Record；不是仅验证新接口命名。无需真实模型调用。

记录／观测接线另外验证三点：没有记录时本次变化来源仍能成立；两项能力独立装配且不泄漏共享状态；装配后仍遵守 IO 快照约束和既定失败语义。捕获消费保持单一交接，不新增生产者同步调用 UI 或网络的路径。

必须维持的时序和失败语义：

1. R 占用后才追加输入；输入审查失败时整批不追加、不建立 E 记录。追加后的捕获／记录失败保留已发生事实，不能视为未写入。
2. 接纳、业务分段之后固定本轮配置与历史范围，再建立 Context；started 在记录登记之前。
3. 父层有效性检查、子关系建立、子层返回和父层接收各在原来的正式位置。
4. 回答落实后即可交付，记忆后处理失败不撤销回答；记录或捕获失败也不能自动重做已经发生的业务。
5. 子记录及父 childId 同批登记；变化生产、捕获、服务发送和客户端消费继续分开。

## 原定范围（实现状态见文首）

不引入“运行时容器”、实体管理器、权限系统、R 工作流、多 E 调度、持久化、生命周期状态机或统一扩展平台。不调整 EOA 图宽、颜色及页面布局，不修改 AG-UI 适配。随后确认的 ResourceFact、实体 UID 与独立消息同步扩充了原定传输改动范围；已保留原有运行与观测分离、基线接缝和顺序校验。

阶段 6 同步清理公开出口、旧运行包装类和过时源码说明，不保留兼容转发链。

改造前基线检查为构建、类型、315 项测试及格式通过；本轮实现增加资源事实、实体同步、窄视图和失败边界的回归验证，实际交付以最终全量检查结果为准。依赖与工具链未变：Node 22.23.2、pnpm 10.7.1。

## 历史材料：Recorder 分离前的复核

本页保留上轮清理后、Recorder 分离前的分析材料。Recorder 已按随后确认的方案分离，当前结构见 [记录边界](recording.md)；其他实体边界仍可继续讨论。

## 已清理的遗留

- 删除生产代码的 invocation/invoke.ts 与 invocation/lifecycle.ts，以及公开导出和源码查看白名单。旧接口已经退出 E/O/A 链路，不能仅因旧测试仍使用它而继续作为第二条执行路径保留。
- 原 invoke 测试改为验证 Invocation。测试夹具执行工作时也使用正式 Invocation；手工 begin/complete/fail 仅用于独立构造记录状态，不实现另一套执行循环。
- 删除 Operation 文件中的 identity 导出：它只有测试消费者，测试内定义即可。
- 删除 Recorder.hasOutcome：观测链路已经直接判断快照与终态事件，该方法仅剩测试引用。
- 清理测试中已失效的筛选实例参数、页面未使用的回调参数，以及文档中旧 Runtime 工厂和计数持有关系。
- 清理已无对应源码的本地编译产物，包括前一轮客户端分层遗留的 overview。

保留记录配对 helper、正文复制与冻结、关系查询等实际使用的代码，不以文件短小或只有间接调用为删除依据。

## Recorder 的职责正在集中

当前 Recorder 约二百行；问题主要在变化原因和依赖方向，而非行数。

| 当前职责       | 实际实现                                                                              | 扩展时的影响                                                   |
| -------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| 调用登记       | beginExecution / beginOperation / beginAttempt 读取现场与行为实例，创建记录并登记关系 | Recorder 认识全部 E/O/A 描述和父级关系                         |
| 调用过程与终态 | process / finish、输出引用复用、错误转换、不同层级结束检查                            | 记录格式和调用过程的变化都需要修改 Recorder                    |
| 内容记录       | memoryChanged / transcriptChanged 创建两类内容记录                                    | 增加新的内容类型时，Recorder 继续增加专用方法和依赖            |
| 因果关系解析   | contextId → 调用 Record → executionId / operationId                                   | 消息与记忆虽然只传来源 ID，登记仍依赖 Recorder 中的 E/O/A 映射 |
| 时间与边界事件 | 单调计时起点、事件创建与发布                                                          | 调用时间语义和记录接收耦合                                     |
| 查询与观察发布 | snapshot / subscribe / publish，构造整次执行快照                                      | 共用 Recorder 的订阅实际只覆盖调用快照；内容变更不会独立发布   |

Recorder 没有执行模型、审查记忆内容或修改 Context，因此尚未吞并整个运行流程。但是它已经兼任类型转换、归属解析、记录写入和观察发布；只要新增一种内容，就需要回来修改这个中心类。

“环境创建一个共享 Recorder”解决的是实例装配和记录去向，不意味着所有类型的创建逻辑都应放进这个类。

下一步建议先确定三个边界，再决定是否需要新类：

1. **记录由谁构造，Recorder 接收什么。** 调用与内容变化的特化逻辑，应当能分别变化；共享登记入口不必理解每种内容。集合依然负责审查和落实，不能因为移动记录构造而把这些职责重新交给流程。
2. **来源由谁给出。** 目前只传 contextId，代价是登记时统一解析 E/O/A。需要比较调用侧提供已建立的来源关联与 Recorder 查询映射；不能让消息或记忆为此理解整个调用体系。
3. **写入与观察如何衔接。** 当前“记录有变化”直接触发“重新发布整次执行快照”，内容记录却不进入这条订阅。应在后续快照／增量设计时明确生产、登记和投影的边界，本次不提前引入通用事件总线。

不建议把 Recorder 的方法机械分散到多个新管理器里，或者先给每个方法增加接口：如果输入仍是整个 Context、Runtime 和 Recorder，实际耦合没有减少。

## 新增与改变的结构清单

| 结构                                | 实际性质                       | 本轮用途                                          | 后续需要核对的点                                                          |
| ----------------------------------- | ------------------------------ | ------------------------------------------------- | ------------------------------------------------------------------------- |
| Invocation                          | 新增有单次生命周期的调用对象   | 持有现场，运行 execute/receive，完成登记          | prepare / register 等接线是否清晰；不成为新的执行层级                     |
| InvocationContext                   | 原 RuntimeContext 改名         | 明确它保存调用现场，而非实例生命周期内容          | 命名与调用对象的分工是否准确；没有新增另一套 Context                      |
| Memories                            | 替换 MemoryCollection 的强集合 | 校验整批变更、保持记忆身份、落实并记录变化        | 对外入口和记忆体自身能力的边界；包内更新方式是否合适                      |
| TranscriptRecord / TranscriptChange | 新增内容记录类与数据联合       | 记录追加原文和分段事实                            | 是否需要记录完整追加正文；当前仅留在 Book，没有传输消费者                 |
| ChangeSource                        | 新增仅含 contextId 的类型      | 内容变更提交因果来源                              | 不是运行实体；来源信息是否太少，以致 Recorder 必须补齐所有关系            |
| Transcript.id                       | 新增集合身份                   | 把消息变化记录关联回集合                          | 当前单 Runtime 下的用途，以及是否应现在暴露到记录协议                     |
| ExecutionContext.runtime            | 新增实例引用                   | 拒绝跨 Runtime 使用现场                           | 整个 Runtime 引用是否过重；当前无 Runtime 的手工 Context 仍可用于低层测试 |
| MemoryRecord 来源字段               | 既有记录结构扩展               | 支持调用内和调用外变化，关联实际 ApplyMemory 调用 | contextId / callId / executionId / operationId 是否都必须保存             |
| Runtime.selectionUsage              | 原 SelectionUsage 迁移持有位置 | 更换行为实例后保留累计观测值                      | 属于观测累计信息，不是记忆能力，没有新建计数实体                          |
| Runtime.run / Execution.submit      | 新增入口方法，不是新实体       | 在接纳输入前取得顶层运行占用                      | 串行机制和接纳回调是否适合当前对象边界；未增加队列或调度                  |

优先讨论 Invocation 与记录接线，再讨论 ChangeSource 和内容记录，最后核对 Memories / Memory 的方法边界。新增结构的必要性不能仅由“能够对应讨论中的名词”证明，应逐一说明真实状态、生命周期、调用者和消费者。
