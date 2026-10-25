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

每个结构只占据一个位置：Scene 是根，Group/Node 单父归属；共享逻辑和资源时分别创建结构实例。构建成功后配置固定，不支持运行中换绑或空闲时修改再构建。需要新结构时复用配置工厂及独立实体。每次构建建立独立 CallableInvocationBuilder 作为 Context 的安装归属；它不缓存本次输入、信号或 Work。Context 直接构造，无独立 ContextBuilder。低层扩展者从 `@capix/server-runtime/construction` 使用 Binder、CallableBuilder、CallableInvocationBuilder 和 CallableContext，内部职责分离不增加作者必须操作的步骤。

## 包与目录

仓库只有一个根 pnpm workspace 与锁文件，九个实际包：contracts、protocol、server/resources、server/structure、server/runtime、client/runtime、client/http、services/observer、apps/observer。跨包只用公开出口，服务端与客户端互不依赖。

| 包                      | 负责什么                                            |
| ----------------------- | --------------------------------------------------- |
| `@capix/contracts`      | 跨包共同端口、签名、操作接收与 CP 事实，不依赖实现  |
| `@capix/protocol`       | 跨端纯数据、协议接纳与兼容，显式复用共同纯值类型    |
| `@capix/resources`      | 资源定义、登记、供给、受控访问与操作接收            |
| `@capix/structure`      | 可复用结构、成员组织、作者配置、Work 类型组合及预设 |
| `@capix/server-runtime` | 将结构与资源装配为运行能力，执行与恢复单次调用      |

```text
server-runtime → structure → resources → protocol → contracts
      └───────────── 各包需要的共同端口 ────────────────┘
```

Runtime 也直接依赖 resources/protocol/contracts，structure 直接依赖 resources/contracts。资源包和结构包均不反向依赖 Runtime；完整依赖图和类型归属见 [契约与协议](contracts-protocol.md)，实体边界见 [资源包](resources-package.md) 和 [结构包](structure-package.md)。

| 位置                                                  | 归属                                                |
| ----------------------------------------------------- | --------------------------------------------------- |
| `server/structure/src/{callable,scene,group,node}.ts` | 结构实体、公共配置和成员能力                        |
| `server/structure/src/{members,configuration}.ts`     | 单父归属、循环检查、命名成员与配置状态              |
| `server/structure/src/definition/`                    | 具体配置、Work 组合、成员限制、工厂与 CP point 配置 |
| `contracts/src/`                                      | 各包共同使用的签名、操作端口、引用与事实契约        |
| `server/structure/src/composition/`                   | 使用公开子调用端口的业务组合辅助                    |
| `server/runtime/src/structure/`                       | CallableBuilder 与具体同体构建结果                  |
| `server/runtime/src/binding/`                         | 声明解算、资源接线、阶段端口适配                    |
| `server/runtime/src/runner.ts`                        | 宿主入口与占用                                      |
| `server/runtime/src/context/`                         | 本次状态与固定构造归属                              |
| `server/runtime/src/invocation/`                      | 本次调用、控制、单次执行、关系与通用构造            |
| `server/runtime/src/checkpoint/`                      | Frame、Store、核验、恢复与事实出口                  |
| `server/runtime/src/records/observation/`             | 可选记录安装、单次句柄与事实映射                    |
| `server/runtime/src/records/restoration/`             | 历史载体读取，不恢复执行                            |

共同的 `BusinessEvent`、输出端口及 `CheckpointValue/Codec/Contract` 由契约包单独定义，结构包和 Runtime 重导同一类型。真正的观测发布、输出窗口、CP 持久化与恢复由 Runtime 实现。`@capix/structure/construction` 只提供结构校验、配置构建状态与依赖收集；它不创建 Invocation，也不安装资源。

`invocation/builders/callable.ts` 协调资源选择、Context 建立、恢复与调用接线。`binding/children/builder.ts` 固定成员及接纳接线，分别构造单次引用认证和阶段动作窗口。binding/children 管理已声明成员及本阶段行动，invocation/children 管理真实父子关系。

Clock、Initializer、ProgressChannel 仍位于 Runtime 根文件；ResourceInstallation 与 Runtime 的 Resources 负责结构范围和可选 Interaction 接线。目录边界按职责划分，不以文件数量决定。

## 类型与身份

类型参数按实际含义命名 Input、Output、Resources、Delta；结构判别使用 Kind。签名消费只依赖 CallableContract 的 kind 和 I/O/Delta，完整注册使用实际结构对象。类型见证不产生运行字段，不替代声明对象身份、阶段资格或恢复位置的检查。

| 名称                                   | 内容                                     |
| -------------------------------------- | ---------------------------------------- |
| Resources                              | 资源实体注册、明确成组捕获与收窄         |
| callableHooks                          | 独立校验、必要建立登记与进展/输出出口    |
| CallableCallBindings                   | 内部、一次根调用的固定接线依据           |
| InvocationWorkBinding                  | 可复用的声明到调用工作适配               |
| InvocationAccess                       | 本次调用引用认证与阶段 Work 签发         |
| ChildCall / ChildReference / ChildFact | 当前阶段动作、可跨阶段保留引用、只读事实 |
| InvocationFact / DriverFact            | 单次调用事实、驱动入口事实               |

来源、资源供应和本层资源访问分开：父层不为了子层需求扩张自己的 Work。每次调用只打开已接线端点；显式来源边界才重新捕获固定依据。资源不再隐式收口于某个 E 层。

## 内容与记录

Transcript、Memories、SelectionUsage、Provider、Interaction 是独立实体，声明和 Runner 不拥有其生命周期。资源描述允许申请的访问形式。Invocation、实体和变化生产者不依赖 Recorder。

新记录用 `kind: 'invocation'`、`structureKind`、真实 parentId 和可选 role 表达调用。`conversation-task` 是 Observer 明确标记的业务角色，不是所有 Group 的含义。记录根仍为 `kind: 'runtime'`，只是既有载体身份。旧 REOA 记录保持只读，由服务投影成通用调用树，不能用它们恢复新结构。

`ExecutionRecordSnapshot` 仍是 Observer 查询选定任务的跨端名字，正文为 `execution`、通用 `calls`、`rootCall`、可选中间 `ancestors`、`boundaries` 及内容/资源变化；它不是内核 E 层。内核 CallableRecordHelper 允许显式选择任意调用子树，不负责判断业务任务。

Checkpoint Frame v5 与声明版本分别核验；旧 round 2/continuation 执行恢复拒绝，历史诊断仍可读取。v1/v2/v3/v4 明确拒绝续接，不影响健康历史内容与记录读取。新 Scene/Task 声明契约也已更新，详见 [Checkpoint](checkpoints.md)。

## 服务、客户端与公开入口

Observer 的 ConversationScene 接纳输入并调用 ConversationGroup；后者是普通 Group，负责材料准备、决策与结果落实。服务提供模型协议、业务资源、内容同步及对外进展解释。环境拥有实体和关闭边界，HTTP 拥有传输；没有服务自己的另一套内核循环。

ClientRuntime 保持无 UI，协调提交、同步和可选观测；client/http 只收发与接纳协议。应用 binding 负责读模型、调用图、几何布局与帧合并，React 消费 props/Store。当前客户端实际依赖对话与 Observer 契约，不宣称已是任意业务的通用客户端。

| 目的                          | 公开入口                                                                             |
| ----------------------------- | ------------------------------------------------------------------------------------ |
| 调用、资源装配、异常与观测    | `@capix/server-runtime`                                                              |
| 结构、作者契约与组合辅助      | `@capix/structure`                                                                   |
| 结构检查与配置构建状态        | `@capix/structure/construction`                                                      |
| 资源定义、供给与受控访问      | `@capix/resources`                                                                   |
| 资源与子调用共用的操作契约    | `@capix/resources/operation`                                                         |
| 内容实体                      | `@capix/server-runtime/content`                                                      |
| 记录预设与查询                | `@capix/server-runtime/recording`                                                    |
| 低层构造与机制扩展            | `@capix/server-runtime/construction`                                                 |
| 对话声明 / 观测 / 环境 / HTTP | `@capix/observer-service/conversation`、`/observation`、`/assembly`、`/http`         |
| 跨端数据                      | `@capix/protocol/content`、`/invocation`、`/recording`、`/conversation`、`/observer` |

根出口按职责分组，不为减少名称建立门面，不导入其他包的私有路径。Runtime 根入口重导结构包同一对象，既有最小例子可以继续使用；新的独立结构代码可直接依赖 `@capix/structure`。

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

Observer 已移除 buildConversation、ConversationCallSource 与旧 provider 数组，直接使用 Resources / Runner。Driver 和旧 source 构造适配暂保留给低层兼容测试；它们不是推荐服务 API，退役不要求再次改动生产链。旧持久记录按数据兼容边界保留。动态能力注册、调度器、任意执行重放与自动接纳不由此次结构调整引入。

统一操作模型同时移除了结构 setter、普通 accept/exceptions/raises/maxRounds/uses/observation。普通 run 使用登记的成员和 deps，恢复点单独声明 resume.deps/uses；观测消费者经宿主安装。业务循环与备用来源属于 run，内核不再提供独立异常阶段或有限两轮解释器。详见 [全仓迁移](callable-operation-migration.md)。
