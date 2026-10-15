# 项目组织与命名

这是当前实现的定位、名称和入口说明。它整理已有机制，不引入新的执行层次、资源管理者或通用应用门面。

## 仓库身份

当前 `capix` 是原 `capix-observer` 的直接延续，Git 历史不变；相邻 `capix-explorations` 保留原 CAPiX 探索内容、独立历史及未提交工作。旧工程只按需参考，不成为运行依赖。仓库身份迁移不意味着采用旧 Graph/TRS 模型。

CAPiX 的框架范围包括 C/S 两端。Observer 是参考服务与应用，负责把业务、内置记录预设、来源投影和界面组合起来，持续验证内核。可观测性属于框架提供的能力；具体记录和具体观测应用可选，不削弱框架的可观测定位。

## 两个维度：层次与角色

REOA 描述结构层次，声明、绑定结构、调用、上下文、视图描述对象角色。名称需要同时说清这两个维度。

| 角色         | R                  | E                    | O                    | A                  | 寿命与权限                                            |
| ------------ | ------------------ | -------------------- | -------------------- | ------------------ | ----------------------------------------------------- |
| 声明         | RuntimeDefinition  | ExecutionDefinition  | OperationDefinition  | AttemptDefinition  | 可复用的内容与契约，不保存某次调用状态                |
| 已绑定结构   | BoundRuntime       | BoundExecution       | BoundOperation       | BoundAttempt       | 绑定位置上的可复用结构，持有稳定身份与声明            |
| 单次上下文   | RuntimeContext     | ExecutionContext     | OperationContext     | AttemptContext     | 输入、进度、终态、本层资源；内部构造关系              |
| 业务视图     | RuntimeContextView | ExecutionContextView | OperationContextView | AttemptContextView | 本次处理可用的只读现场与正式端点，不暴露生命周期修改  |
| 调用         | Invocation         | Invocation           | Invocation           | Invocation         | 统一机制，由具体 Context 保持层级约束，不派生四套循环 |
| 可选调用记录 | RuntimeCallRecord  | ExecutionRecord      | OperationRecord      | AttemptRecord      | 记录预设对调用事实的解释，不能驱动运行                |

绑定是建立关系的职责，不要求每格再建一个 Binding 包装类。`assembleRuntime` 是普通装配入口；`createBoundRuntime` 和各 Builder 是低层构造能力。`BoundRuntimeBinding` 是构造时返回的接线契约；`RuntimeAssemblyOptions` 是装配参数，`RuntimeCallSource` 描述按次校验、入口/工作资源捕获和回调来源。

`Attempt` 在 REOA 中表示具名叶子动作。一次再次生成可以新建多个 A 调用；它不等于“失败后的第几次重试”。UI 当前使用“意图”标签，不借本轮整理改变层级含义。

“运行时”描述活动状态，不是一层；`RuntimeDefinition`、`RuntimeContext`、`RuntimeStructureFact` 中的 Runtime 则明确指 R。现有 `RuntimeError` / `RuntimeErrorValue` 是跨层诊断与序列化错误正文，不表示错误归 R；具体归属由 InvocationFailure 表达。此次保留这些通用诊断名称及错误语义，不机械地给所有类型加 Bound 前缀。

## 类型、参数与对象角色

主类型表达层次与角色：`ExecutionDefinition` 是 E 的内容声明，`BoundExecution` 是已绑定且可复用的 E 结构，`ExecutionContext` 是某次 E 调用的内部状态，`ExecutionContextView` 是业务可用的本层视图。`Invocation` 负责通用单次调用机制；执行过程中的 execute/receive/handling 是调用阶段，不是新的 REOA 层次。

辅助类型也使用同一规则：

| 名称                                                 | 实际内容                                        |
| ---------------------------------------------------- | ----------------------------------------------- |
| `InvocationControls`                                 | 调用控制参数，目前为 signal；不是一个 Context   |
| `ExecutionInvocationBindings`                        | 本次 E 的入口资源、工作资源及回调接线           |
| `ExecutionBindingResolver`                           | 本 R 调用按 E 声明查找上述接线                  |
| `ChildBinding` / `ChildBindings`                     | 当前父调用及阶段允许使用的子调用能力            |
| `BoundChildren`                                      | 持续复用、惰性构造的子结构集合                  |
| `ChildBindingsBuilder`                               | 根据本次调用与阶段约束构造子能力访问 Binding    |
| `InvocationChildBindings`                            | 内部实现；连接父调用、阶段视图和允许的子结构    |
| `ChildInvocationView`                                | 可启动这次子调用的业务视图，不是可复用结构      |
| `DefinitionEntryInput` / `DefinitionInvocationInput` | 入口接纳前的输入 / 接纳后进入调用的输入         |
| `DefinitionContextFacts` / `ContextFactsOf`          | 去除资源能力的上下文事实视图，不是真实 Context  |
| `InvocationFact` / `InvocationEvent`                 | 同步借用值的观测事实 / 可捕获与传输的变化元数据 |
| `InvocationObservation` / `InvocationRecording`      | 单次调用的观测绑定状态 / 可选记录预设           |
| `RuntimeStructureFact`                               | 可复用 R 结构的建立、占用和释放事实             |

泛型按实际含义命名：`Input`、`Output`、`Resources`、`EntryInput`、`EntryResources`、`ExceptionResources`。真实上下文使用 `Context`，业务视图使用 `ContextView`；资源来源使用 `Source`，不称为 parent。Sequence 的 `Outputs` 是逐步骤的结果集合，与资源集合不同。

`Invocation` 与 `InvocationWork` 都使用 `<Input, Output, Context>`。`BoundExecution`、`ExecutionDefinition`、`ExecutionInvocationBindings` 的共同前缀均为 `<Input, Output, Resources, EntryInput, EntryResources>`。不以 I/O/R 等缩写同时暗示输入输出和 REOA 层次。

变量和成员同样表达持有对象：`executionDefinition` 持有声明，`executionInvocationBuilder` 持有一个构造器，`executionBindings` 持有接线。服务的 `SelectHistoryDefinition`、`GenerateAnswerDefinition` 等是具体 O/A 声明；`BoundConversationRuntime` 是装配结果，`ConversationRunOptions` 是 `run` 的参数。记录构造参数使用 `*RecordOptions`，不再与业务 `*Definition` 混用。客户端的 `invocationEvents` 存放已接收事件，不持有服务端调用实例。

这些代码名称不改变 HTTP 路由、协议字段或判别值。例如线协议基线仍使用 `invocations`，内容是 InvocationEvent；记录协议里的 `runtimeCall`、`execution` 等仍按既有契约接纳。

## 独立实体、资源与观测结果

Transcript、Memories、SelectionUsage、模型供给由环境建立。ResourceOffer 描述实体可申请的访问形式；绑定给本次调用建立受限端点；业务使用端点而非原实体引用。对象由谁创建、被哪个结构引用、哪次调用获准访问，是不同关系。

InvocationFact、ResourceObservation、RuntimeStructureFact 是内核提供的类型化观测事实。观察声明可同时写入多个结果，不要求都转换为记录。记录预设位于运行包的 `records/`，通过公开 `/recording` 入口提供；同包不意味着运行机制必须依赖它。

`definition/observation.ts` 声明事实类型、资源申请与同步消费内容；`defineObservation` 固定资源申请，不持有调用状态。`binding/observation.ts` 持有 `ObservationInstallation` / `InvocationObservationSetup` 接线契约，连接安装、父调用和声明，为每次绑定建立独立的资源选择、首次激活与同步访问窗口；声明和安装的资源覆盖计算同属 `binding/`。`observation/` 保留事实契约、运行观察出口、单次消费者会话及发布与故障策略，不承担资源接线或记录解释。

- `RecordingRootRecord`：一次 RecordingInstallation 的跨调用记录根，不承诺与一个 R 实例一一对应。
- `RuntimeCallRecord`：一次 R 调用，带 Context 与结构实例身份。
- `ResourceRecord`：已写入记录载体的资源访问；与实时 `ResourceObservation` 区分。
- `ExecutionRecordSnapshot`：一次 E 的记录详情，带其父 R 调用及边界，不包含系统全部实体或所有 E。
- `InvocationOrigin`：任意 REOA 层本次调用的来源身份，不是 R 实例身份。

记录根的现有线协议判别仍为 `kind: 'runtime'`，本次只改代码名称，不改记录字段、判别值或关系规则。对话反馈现由服务提交投影解释内核被动进展，原 `observer.delivery` 业务资源已移除；这一调整属于明确的交付职责迁移，详见 [协议](protocol.md)。

## 变化捕获不等于观测载体

生产者在变化落实后发布自己类型的事实，`ChangeCapture<E>` 是窄捕获端口。`ChangeBuffer<E>` 只缓冲、唤醒和转移批次，不执行订阅者、构造记录或解释业务。

Observer 环境用 `ObserverChange` 组合当前 TranscriptEvent、MemoryEvent、InvocationEvent、RecordChangeEvent；它是该环境的已知来源集合，不是内核所有事件的封闭全集。环境的 ChangeConsumer 独占缓冲消费，并把结果送到独立的来源与出口。观测传输位置不等于调用过程 sequence、实体 revision 或记录修订号。

## 服务与客户端职责

| 位置                 | 负责                                            | 不负责                           |
| -------------------- | ----------------------------------------------- | -------------------------------- |
| service conversation | 对话 R/E/O/A 内容、模型契约与资源绑定、消息同步 | 内核调用循环、记录来源完整性     |
| service observation  | 记录查询投影、来源与观测交付                    | 运行对话、拥有消息同步连接       |
| service assembly     | 创建实体/供给，连接业务、变化消费及观测预设     | 代替业务声明编排                 |
| service http         | 路由、编码、连接和宿主生命周期                  | 创造调用事实或从快照差异推断变化 |
| client/runtime       | 提交状态、消息副本、可选观测副本、按需查询      | UI 布局、组件 Store、服务端实体  |
| client/http          | HTTP 收发、流接纳与协议检查                     | 业务状态组织                     |
| app binding / store  | 投影、应用读模型、UI 命令                       | 把 UI 数据结构上推到运行内核     |

ClientRuntime 仍保留其当前名称和能力，不为表现通用性建立空的 ClientCore，也不把整个客户端收进 Observer 应用。它当前使用 ConversationRequest、ObserverOverview 等特定契约，这一实际边界需明确；后续由真实复用需求继续提炼。

## 公开入口与合理组合

| 使用者目的                                | 公开入口                                                                             |
| ----------------------------------------- | ------------------------------------------------------------------------------------ |
| 定义和组合 REOA、异常、资源申请与观察声明 | `@capix/server-runtime`                                                              |
| 建立或供应独立内容实体                    | `@capix/server-runtime/content`                                                      |
| 使用内置记录结果、查询与安装              | `@capix/server-runtime/recording`                                                    |
| 低层 Context/Invocation/Bound 结构构造    | `@capix/server-runtime/construction`                                                 |
| 组合参考对话的具体声明                    | `@capix/observer-service/conversation`                                               |
| 消费参考观测实现                          | `@capix/observer-service/observation`                                                |
| 建立完整参考环境 / HTTP 宿主              | `@capix/observer-service/assembly`、`/http`                                          |
| 跨端契约                                  | `@capix/protocol/content`、`/invocation`、`/recording`、`/conversation`、`/observer` |

根入口保留分组导出；子路径提供语义入口，不增加包、包装类或复制对象。跨包不能导入 src/dist 私有路径。服务装配出现多个实体、提供者和声明是正常组合，不以对象数量判断泄漏。真正要收敛的是服务必须维护内核内部不变量、重复接线或没有选择权的构造细节。

## 本轮名称迁移

| 原名                                                                   | 当前名称或位置                                                                     |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Runtime / Execution / Operation / Attempt 结构类                       | BoundRuntime / BoundExecution / BoundOperation / BoundAttempt                      |
| createRuntime / RuntimeCreationOptions                                 | createBoundRuntime / BoundRuntimeOptions                                           |
| RuntimeBinding / RuntimeSource / RuntimeAssembly                       | BoundRuntimeBinding / RuntimeCallSource / RuntimeAssemblyOptions                   |
| InvocationScope、REOA Scope                                            | InvocationContextView、REOA ContextView                                            |
| ScopeOf / ScopeResources / invocationScope                             | ContextViewOf / ContextViewResources / invocationContextView                       |
| ChangeObserver                                                         | ChangeBuffer                                                                       |
| RuntimeRecord / RuntimeRecordHelper / RuntimeValue                     | RecordingRootRecord / RecordingRootHelper / RecordingRootValue                     |
| RuntimeSnapshot / validateSnapshot                                     | ExecutionRecordSnapshot / validateExecutionRecordSnapshot                          |
| ResourceFact（记录 DTO）                                               | ResourceRecord                                                                     |
| RuntimeOrigin / RuntimeChange                                          | InvocationOrigin / ObserverChange                                                  |
| ExecutionRequest / ObserverTransportError                              | ConversationRequest / HttpTransportError                                           |
| ObserverRuntimeDefinition / ObserverExecutionDefinition / bindObserver | ConversationRuntimeDefinition / ConversationExecutionDefinition / bindConversation |
| 混合的 service observer 目录                                           | conversation / observation / assembly                                              |
| memory/observe.ts                                                      | records/memory/observe.ts，属于记录投影                                            |

不保留重复旧名称别名，仓库消费者同步更新。HTTP 路径、JSON 字段、资源正式身份、调用/实体顺序、错误处理和捕获时机保持原约定。原有界面视觉与布局未重做。

本轮不实现新 OA 能力、动态编排、持久化、协议适配、权限体系或新的市场/插件包。组织边界可继续迭代，但不能把目录分类当作已经获得完全独立可发布模块的证明。
