# 项目组织与命名

这是当前实现的定位、名称和入口说明。它整理已有机制，不引入新的执行层次、资源管理者或通用应用门面。

## 仓库身份

当前 `capix` 是原 `capix-observer` 的直接延续，Git 历史不变；相邻 `capix-explorations` 保留原 CAPiX 探索内容、独立历史及未提交工作。旧工程只按需参考，不成为运行依赖。仓库身份迁移不意味着采用旧 Graph/TRS 模型。

CAPiX 的框架范围包括 C/S 两端。Observer 是参考服务与应用，负责把业务、内置记录预设、来源投影和界面组合起来，持续验证内核。可观测性属于框架提供的能力；具体记录和具体观测应用可选，不削弱框架的可观测定位。

服务如何建立实体、构造声明、绑定运行入口及关闭环境，见 [Observer 服务装配与生命周期](service-assembly.md)。

## 结构角色与共同调用

当前结构采用 Scene / Group / Node，具体契约见 [可调用结构](callable-structures.md)。三个名称描述结构角色，不指定业务动作、模型类型或执行阶段。

| 对象                             | 表达什么                                      | 共同机制                          |
| -------------------------------- | --------------------------------------------- | --------------------------------- |
| Scene                            | 宿主装载的整体场景，显式组织成员              | Callable + Composite              |
| Group                            | 组合成员并实现整体处理，可任意嵌套 Group/Node | Callable + Composite              |
| Node                             | 直接处理，不声明成员                          | Callable                          |
| CallableBinder / CallableBinding | 解算声明、接线，产出绑定契约                  | 不执行业务                        |
| CallableBuilder / BuiltCallable  | 完成原结构的装配 / 表达已构建类型             | 不产生第二个结构对象              |
| Runner                           | 固定场景与机制、构建、启动与结束释放          | 一个 Runner 一个场景入口          |
| Resources / Interactions         | 资源供给注册 / 可选交互注册                   | 不持有调用进度                    |
| Invocation / CallableContext     | 单次调用与本层真实状态                        | 不按结构种类派生循环              |
| Work                             | 当前阶段的资源、输出、CP、成员行动及事实      | 业务不接收内部 Invocation/Context |

`Callable` 是结构公共配置基类，`CallableContract` 是只读调用签名；`Composite` 是成员组合切面。作者直接 new Scene/Group/Node，构造器或 build 前普通赋值形成配置；defineScene/defineGroup/defineNode 仅为创建同样结构的类型推导便捷函数。Scene 在本版作为安装根，Group/Node 可作为成员，Node 的 members 同时在类型与运行检查中拒绝。结构对象经 add 注册 `members`；一次调用实际发生的子调用仍使用 `work.children`。成员注册不代表自动遍历或执行。

宿主显式创建 `new Runner(scene, resources, interactions?).build()`，返回同一个 Runner。CallableBuilder 协调 Binder 的静态解算和运行能力装配，原 Scene/Group/Node 承载固定结果；内部 BuiltCallable 仅表达完成构建的类型。`runner.run(input, options)` 建立调用，`runner.resume(contextId, options)` 按保存依据恢复；无需重复传入场景。

每个结构只占据一个位置：Scene 是根，Group/Node 单父归属；共享逻辑和资源时分别创建结构实例。构建成功后配置固定，不支持运行中换绑或空闲时修改再构建。需要新结构时复用配置工厂及独立实体。每次构建建立独立 CallableInvocationBuilder 作为 Context 的安装归属；它不缓存本次输入、信号或 Work。Context 直接构造，无独立 ContextBuilder。低层扩展者从 `@capix/server-runtime/construction` 使用 Binder、CallableBuilder 和 CallableInvocationBuilder，从 `@capix/invocation` 使用 Invocation/Context 等单次机制；Runtime 既有调用出口仍精确重导同一对象。内部职责分离不增加作者必须操作的步骤。

## 包与目录

仓库只有一个根 pnpm workspace 与锁文件，二十三个实际包。包边界按独立职责和公开契约确定；实体独立拆包不意味着增加生命周期或一层统一平台。跨包只用公开出口，服务端与客户端互不依赖。

| 包                            | 位置                        | 负责什么                                                           |
| ----------------------------- | --------------------------- | ------------------------------------------------------------------ |
| `@capix/contracts`            | `contracts`                 | 跨包共同端口、签名、操作接收、CP 事实及同一 RuntimeError 诊断身份  |
| `@capix/protocol`             | `protocol`                  | 跨端纯数据、协议接纳与兼容，显式复用共同纯值类型                   |
| `@capix/resources`            | `server/resources`          | 资源定义、登记、供给、受控访问与操作接收                           |
| `@capix/structure`            | `server/structure`          | 可复用结构、成员组织、作者配置、Work 类型组合及预设                |
| `@capix/changes`              | `server/changes`            | 事实捕获、缓冲转交、发布及被动进度通知                             |
| `@capix/transcript`           | `server/transcript`         | 正式消息实体、固定引用、追加凭据、持久契约及 Offer                 |
| `@capix/memory`               | `server/memory`             | Memory/Memories、来源、固定批次、持久契约及 Offer                  |
| `@capix/view`                 | `server/view`               | 通用来源契约、成员状态、目录与固定读取、版本检查及资源访问辅助     |
| `@capix/measurement`          | `server/measurement`        | 按消息对象计数及受控写入                                           |
| `@capix/records`              | `server/records`            | 记录实体、登记与树、历史读取、快照资源及宿主构造写口               |
| `@capix/checkpoint`           | `server/checkpoint`         | CP 持久载体、数据核验、版本提交契约与内存存储                      |
| `@capix/invocation`           | `server/invocation`         | 单次调用与 Context、直接关系、访问窗口、输出、故障、观测及 CP 续接 |
| `@capix/interaction`          | `server/interaction`        | 独立请求发送、反馈接纳、局部等待、保留与交互宿主                   |
| `@capix/model-provider`       | `server/model-provider`     | 独立文本模型通信；固定配置、有界反馈，不持有会话或意图策略         |
| `@capix/diagnostics`          | `server/diagnostics`        | 唯一持久化错误类和有界诊断转换，不决定执行故障策略                 |
| `@capix/server-runtime`       | `server/runtime`            | 结构与供给装配、Runner 入口、作者 Work 适配及可选记录预设          |
| `@capix/observer-content`     | `services/observer-content` | Observer 内容持有、ActiveView 策略、观察安装、原文同步与关闭       |
| `@capix/conversation-service` | `services/conversation`     | 并排对话装配、内容持久化、记录、CLI 与独立单会话 Web 宿主          |
| `@capix/observer-service`     | `services/observer`         | 对话业务、模型适配、SQLite、运行环境、观测与 HTTP                  |
| `@capix/client-runtime`       | `client/runtime`            | 客户端提交、反馈、原文同步及观测接纳                               |
| `@capix/client-http`          | `client/http`               | HTTP 收发和协议接纳                                                |
| `@capix/observer-app`         | `apps/observer`             | 浏览器界面与读模型投影                                             |

结构、资源、调用、记录、checkpoint 和内容实体包均不反向依赖 Runtime；调用包也不依赖结构包。Observer 服务组合实体与运行；`@capix/observer-content` 不依赖 Observer 服务或 Runtime。内容协作图、目录和迁移入口见 [内容实体与独立包](content-entities-packages.md)。共同契约、跨端协议和具体机制的区别见 [契约与协议](contracts-protocol.md)。

| 位置                                                  | 归属                                                                    |
| ----------------------------------------------------- | ----------------------------------------------------------------------- |
| `server/structure/src/{callable,scene,group,node}.ts` | 结构实体、公共配置和成员能力                                            |
| `server/structure/src/{members,configuration}.ts`     | 单父归属、循环检查、命名成员与配置状态                                  |
| `server/structure/src/definition/`                    | 具体配置、Work 组合、成员限制、工厂与 CP point 配置                     |
| `contracts/src/`                                      | 各包共同使用的签名、操作端口、引用、事实契约及 RuntimeError             |
| `server/changes/src/`                                 | 生产者事实捕获、发布、批次转交与 ProgressChannel                        |
| `server/{transcript,memory,measurement}/src/`         | 各实体或计量自身的行为、访问形式、快照与持久契约                        |
| `server/view/src/`                                    | 来源读取契约、成员状态与一致性处理、资源窗口端点辅助                    |
| `server/records/src/`                                 | 记录实体、登记与树、纯数据快照及普通 read/write 资源                    |
| `server/records/src/construction.ts`                  | 宿主观察窗口内的 root/add/update/boundary 写口                          |
| `server/records/src/restoration/`                     | 历史载体读取，不恢复执行                                                |
| `server/checkpoint/src/`                              | CP 纯持久载体、一致性检查与 Store，不持有活调用                         |
| `server/interaction/src/`                             | 交互实体、宿主、请求反馈契约和固定数据检查                              |
| `server/diagnostics/src/`                             | 通用诊断格式化与必要持久失败身份                                        |
| `services/conversation/src/`                          | 对照服务的历史/模型资源、对话场景与 Runner 装配                         |
| `services/observer-content/src/`                      | Observer 内容组合、窄持久端口与同步生命周期；view/ 属于 ActiveView 策略 |
| `server/structure/src/composition/`                   | 使用公开子调用端口的业务组合辅助                                        |
| `server/runtime/src/structure/`                       | CallableBuilder 与具体同体构建结果                                      |
| `server/runtime/src/binding/`                         | 声明解算、资源接线、阶段端口适配                                        |
| `server/runtime/src/runner.ts`                        | 宿主入口与占用                                                          |
| `server/invocation/src/context/`                      | 本次状态、受控安装与固定构造归属                                        |
| `server/invocation/src/invocation/`                   | 本次调用、控制、执行、关系、故障归属与资源窗口                          |
| `server/invocation/src/checkpoint/`                   | 活关系捕获、固定契约检查、调用续接与恢复事实出口                        |
| `server/invocation/src/observation/`                  | 调用事实、观察会话及消费故障策略                                        |
| `server/runtime/src/construction/`                    | 从固定结构、供给与宿主选项构造调用                                      |
| `server/runtime/src/construction/capabilities.ts`     | 调用构造所需的已安装机制集合                                            |
| `server/runtime/src/observation/`                     | 结构观察声明、安装与 Driver 入口事实                                    |
| `server/runtime/src/records/observation/`             | 可选记录安装、单次句柄与事实映射                                        |

交互实体与宿主直接由 `@capix/interaction` 提供；Runtime 只连接可选交互通道与资源供给。共享持久失败类及诊断转换归 `@capix/diagnostics`，调用包解释故障策略；两者不因为共同使用诊断而相互依赖。

共同的 `BusinessEvent`、输出端口、`InvocationIdentity` 及 `CheckpointValue/Codec/Contract` 由契约包单独定义。调用观测、输出窗口、CP 捕获与续接由 invocation 实现，结构与机制安装由 Runtime 连接；CP 纯值和 Store 来自 checkpoint 包，具体 SQLite 存储仍归宿主。实体事实发布与通用捕获、进度通知由各实体包和 `@capix/changes` 协作。`@capix/structure/construction` 只提供结构校验、配置构建状态与依赖收集；它不创建 Invocation，也不安装资源。

`construction/invocation.ts` 协调资源选择、Context 建立、恢复与调用接线。`binding/children/builder.ts` 固定成员及接纳接线，分别构造单次引用认证和阶段动作窗口。binding/children 管理已声明成员及本阶段行动，invocation/children 管理真实父子关系。

Runtime 的 `structure/install.ts` 保持整树安装的准备、复核与发布；`entry.ts` 共用根运行占用与释放操作，状态仍属于宿主。旧 Driver/source 位于 `legacy/`，只通过显式适配复用安装与调用。默认 Builder.build/Binder.bind 消费 Resources。

Clock 位于 `server/invocation/src/clock.ts`，Initializer 留在 Runtime 根文件；记录包使用自身的窄 RecordClock 契约，只要求 now/tick，可由宿主注入兼容 Clock。ProgressChannel 与生产者变化支持归 `@capix/changes`。ResourceInstallation 与 Runtime 的 Resources 负责结构范围和可选 Interaction 接线。目录边界按职责划分，不以文件数量决定。

## 类型与身份

类型参数按实际含义命名 Input、Output、Resources、Delta；结构判别使用 Kind。签名消费只依赖 CallableContract 的 kind 和 I/O/Delta，完整注册使用实际结构对象。类型见证不产生运行字段，不替代声明对象身份、阶段资格或恢复位置的检查。

| 名称                                   | 内容                                     |
| -------------------------------------- | ---------------------------------------- |
| Resources                              | 资源实体注册、明确成组捕获与收窄         |
| callableHooks                          | 独立校验、必要建立登记与进展/输出出口    |
| CallableCallScope                      | 内部、一次根调用的固定接线依据           |
| InvocationWorkBinding                  | 可复用的声明到调用工作适配               |
| InvocationAccess                       | 本次调用引用认证与阶段 Work 签发         |
| ChildCall / ChildReference / ChildFact | 当前阶段动作、可跨阶段保留引用、只读事实 |
| InvocationFact / DriverFact            | 单次调用事实、驱动入口事实               |

来源、资源供应和本层资源访问分开：父层不为了子层需求扩张自己的 Work。每次调用只打开已接线端点；显式来源边界才重新捕获固定依据。资源不再隐式收口于某个 E 层。

## 内容与记录

Transcript、Memories、MessageUsage 分别从独立包导入。通用 View 不依赖这些实体；对应实体包提供来源适配器。ActiveView 与 ConversationContent 由 `@capix/observer-content` 提供，前者组合消息/记忆策略，后者持有内容与同步；宿主拥有它们，运行环境可以借用。声明和 Runner 不拥有这些对象的生命周期。Provider、Interaction 仍由宿主明确建立。资源描述允许申请的访问形式。Invocation、实体和变化生产者不依赖 Recorder。

Message 仍是协议中的正式消息值；Memory 与 Memories 在同一包分别表达单项身份和集合写入边界。Runtime 已删除 `/content` 出口与内容实现，具体边界见 [内容实体与独立包](content-entities-packages.md)。

Recorder、RecordBook、RecordTree、记录载体与 Helper 从 `@capix/records` 导入。普通 RecordResource 返回纯快照，write.create 只创建 custom 内容记录；`@capix/records/construction` 的 RecordWriterResource 才在宿主观察窗口内使用准确活对象，提供 root/add/update/boundary。Runtime `/recording` 只保留自动观测预设，内部通过资源包 Resources.bind 固定写口，每个事实独立 open/close；窗口不继承业务 Work 的取消或终态，不回送自身观察链。记录变化出口及 isolate/propagate 策略保持独立，具体约束见 [记录机制](recording.md)。

记录包没有 Runtime 或 memory 包依赖；observeMemory 是消费协议值与只读结构契约的组合辅助。既有记录实体名称和历史格式保留，迁移删除 Runtime 对实体的旧重导，不改变 Checkpoint 语义。

新记录用 `kind: 'invocation'`、`structureKind`、真实 parentId 和可选 role 表达调用。`conversation-task` 是 Observer 明确标记的业务角色，不是所有 Group 的含义。记录根仍为 `kind: 'runtime'`，只是既有载体身份。旧 REOA 记录保持只读，由服务投影成通用调用树，不能用它们恢复新结构。

`ExecutionRecordSnapshot` 仍是 Observer 查询选定任务的跨端名字，正文为 `execution`、通用 `calls`、`rootCall`、可选中间 `ancestors`、`boundaries` 及内容/资源变化；它不是内核 E 层。记录包的 CallableRecordHelper 允许显式选择任意调用子树，不负责判断业务任务。

Checkpoint Frame v5 与声明版本分别核验。`@capix/checkpoint` 持有 Frame/Image/Head/Delivery、引用纯值、数据检查、CheckpointStore 与 MemoryCheckpointStore；`@capix/invocation` 持有活动捕获、Context/关系安装、续接和观测，Runtime 负责结构契约解算与恢复 Work 适配。Store 的同步 read/save/finish 是宿主机制端口，不借用已结束的业务资源窗口。旧 round 2/continuation 执行恢复拒绝，历史诊断仍可读取。v1/v2/v3/v4 明确拒绝续接，不影响健康历史内容与记录读取。详见 [Checkpoint](checkpoints.md)。

## 服务、客户端与公开入口

Observer 的 ConversationScene 接纳输入并调用 ConversationGroup；后者是普通 Group，负责材料准备、决策与结果落实。服务提供模型协议、业务资源、内容同步及对外进展解释。环境拥有实体和关闭边界，HTTP 拥有传输；没有服务自己的另一套内核循环。

并排的 [`@capix/conversation-service`](../services/conversation/README.md) 以正式消息、View 材料、记忆策略、模型资源和原生 Runner 验证作者路径。普通模型 Node 与独立交互 Group 都使用完整 ModelProvider 契约，两者共用 Scene 的消息接纳；后者组合发送、过程反馈跟随和最终读取。`assembly` 组合这些公开能力，`persistence` 保存消息／记忆／View 成员，`recording` 安装现有记录预设及服务摘要，`cli` 承担连续输入、反馈展示、可选记录导出和宿主关闭。`web` 建立独立浏览器宿主，`http` 交付消息同步、提交跟随和按需调用详情；客户端复用已有接纳机制，应用保留独立入口。重启后建立新 Runner 继续对话；不恢复旧调用或重发模型请求，不替换 Observer 的 HTTP/客户端。见 [宿主与持久化](conversation-host.md) 和 [浏览器交付](conversation-web.md)。

ClientRuntime 保持无 UI，协调提交、同步和可选观测；client/http 只收发与接纳协议。应用 binding 负责读模型、调用图、几何布局与帧合并，React 消费 props/Store。当前客户端实际依赖对话与 Observer 契约，不宣称已是任意业务的通用客户端。

| 目的                                  | 公开入口                                                                             |
| ------------------------------------- | ------------------------------------------------------------------------------------ |
| 场景运行入口、资源装配与机制安装      | `@capix/server-runtime`                                                              |
| 单次调用、关系、窗口、故障与 CP 适配  | `@capix/invocation`                                                                  |
| 独立请求、发送、反馈与交互登记        | `@capix/interaction`                                                                 |
| 通用诊断格式化与持久化故障身份        | `@capix/diagnostics`                                                                 |
| 结构、作者契约与组合辅助              | `@capix/structure`                                                                   |
| 结构检查与配置构建状态                | `@capix/structure/construction`                                                      |
| 资源定义、供给与受控访问              | `@capix/resources`                                                                   |
| 资源与子调用共用的操作契约            | `@capix/resources/operation`                                                         |
| 正式消息 / 记忆                       | `@capix/transcript`、`@capix/memory`                                                 |
| 来源目录、成员与固定读取              | `@capix/view`                                                                        |
| 消息计数                              | `@capix/measurement`                                                                 |
| Observer 活跃材料、内容生命周期与同步 | `@capix/observer-content`                                                            |
| 事实捕获、缓冲、发布与进度            | `@capix/changes`                                                                     |
| 共同端口与诊断身份                    | `@capix/contracts`                                                                   |
| 记录实体、查询与普通快照资源          | `@capix/records`                                                                     |
| 宿主记录构造写口                      | `@capix/records/construction`                                                        |
| CP 持久数据、校验与 Store             | `@capix/checkpoint`                                                                  |
| 自动调用、资源及内容记录观测预设      | `@capix/server-runtime/recording`                                                    |
| 低层构造与机制扩展                    | `@capix/server-runtime/construction`                                                 |
| 最小对话场景与资源装配对照            | `@capix/conversation-service`                                                        |
| 对话声明 / 观测 / 环境 / HTTP         | `@capix/observer-service/conversation`、`/observation`、`/assembly`、`/http`         |
| 跨端数据                              | `@capix/protocol/content`、`/invocation`、`/recording`、`/conversation`、`/observer` |

根出口按职责分组，不为减少名称建立门面，不导入其他包的私有路径。Runtime 根入口重导结构包同一对象，既有最小例子可以继续使用；新的独立结构代码可直接依赖 `@capix/structure`。原 Runtime 调用出口精确重导 `@capix/invocation` 同一实现，错误类与引用品牌不复制；独立机制消费者直接依赖 invocation。

## 本轮迁移

| 之前                                                            | 当前                                                                           |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| RuntimeDefinition                                               | Scene                                                                          |
| ExecutionDefinition、OperationDefinition                        | Group；对话任务由服务类表达                                                    |
| AttemptDefinition                                               | Node                                                                           |
| 四套 Binder / Bound / Context / Builder                         | CallableBinder / CallableBuilder / CallableContext / CallableInvocationBuilder |
| BoundRuntime 的占用                                             | Runner                                                                         |
| 声明 children、level                                            | members、kind                                                                  |
| E 隐式捕获与出口                                                | Resources.capture + 独立 callableHooks                                         |
| ConversationRuntimeDefinition / ConversationExecutionDefinition | ConversationScene / ConversationGroup                                          |
| BoundConversationRuntime                                        | ConversationScene + Resources + Runner                                         |
| 活记录 REOA 判别与分层数组                                      | invocation 记录、通用 calls 树、明确任务 role                                  |
| Runtime 根或 `/recording` 的记录实体与 Helper                   | `@capix/records`；Runtime `/recording` 只保留自动观测预设                      |
| Runtime 根的 CP Frame/Store/cloneCheckpoint*                    | `@capix/checkpoint`；活调用适配归 invocation，结构装配归 Runtime               |
| Runtime 内 Invocation/Context、关系、资源窗口与 CP 活动适配     | `@capix/invocation`；Runtime 保留精确重导、构造与作者 Work 接线                |

Observer 已移除 buildConversation、ConversationCallSource 与旧 provider 数组，直接使用 Resources / Runner。Driver 和旧 source 构造适配暂保留给低层兼容测试；它们不是推荐服务 API，退役不要求再次改动生产链。旧持久记录按数据兼容边界保留。动态能力注册、调度器、任意执行重放与自动接纳不由此次结构调整引入。

统一操作模型同时移除了结构 setter、普通 accept/exceptions/raises/maxRounds/uses/observation。普通 run 使用登记的成员和 deps，恢复点单独声明 resume.deps/uses；观测消费者经宿主安装。业务循环与备用来源属于 run，内核不再提供独立异常阶段或有限两轮解释器。详见 [全仓迁移](callable-operation-migration.md)。

`@capix/model-exchanges` 是独立模型交换实体包：完整回复、反馈槽位、固定凭据和 ViewSource。工具循环预设在 `services/conversation/tools`；Provider 负责协议、实体负责事实、Group 负责推进，不引入新的 Invocation 类型。
