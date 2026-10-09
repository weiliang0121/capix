# 运行结构、调用与资源访问边界

“运行时”表示声明、绑定、结构以及实体实际协作的活动状态，不等同于 `Runtime` 类。`Runtime` 只表示 R 层。世界的根是一簇独立实体：Transcript、Memories、SelectionUsage、模型供给、记录器、变化捕获器各有自己的职责与生命周期；R 绑定它们公开的资源访问形式，不成为这些实体的所有者。

## 声明、绑定和结构

| 层次 | 声明                                                            | 绑定职责                                                   | 固定结构                               |
| ---- | --------------------------------------------------------------- | ---------------------------------------------------------- | -------------------------------------- |
| R    | RuntimeDefinition：唯一 E 声明                                  | assembleRuntime：供给检查、来源捕获及可选记录/变化能力装配 | Runtime：业务 run 入口、占用与构造能力 |
| E    | ExecutionDefinition：entry、资源申请、O 声明及 execute/receive  | 本次入口资源、工作资源与子结构接线                         | Execution → ExecutionInvocationBuilder |
| O    | OperationDefinition：描述、资源申请、O/A 声明及 execute/receive | 本位置的稳定结构身份、直接子入口与调用描述                 | Operation → OperationInvocationBuilder |
| A    | AttemptDefinition：描述、资源申请及 execute/receive             | 本次叶子访问与调用描述                                     | Attempt → AttemptInvocationBuilder     |

声明由内核定义契约，服务提供具体内容，可使用类实例或满足契约的普通对象。声明不持有模型实例、Runtime、构造器、Recorder、原实体或本次调用状态。业务复杂度留在声明及组合中，绑定不执行 Sequence、不决定业务分支。

绑定是职责，不要求每层有一个与结构功能重复的可调用包装类。原 RuntimeBinding、ExecutionBinding、OperationBinding、AttemptBinding 已删除；落实后的 E/O/A 结构持有声明、调用工作及惰性直接子结构。服务只把已装配 R 作为业务运行入口。

```ts
const transcript = new Transcript(messages, { recorder, changes });
const memories = new Memories(transcript, { recorder, changes });
const selectionUsage = new SelectionUsage();
const definition = new ObserverRuntimeDefinition();
const runtime = bindObserver(definition, { transcript, memories, selectionUsage }, provider, { recorder, changes });

await runtime.run({ messages: newMessages }, { settings, signal, deliver });
```

上面是服务装配示例。`bindObserver` 创建模型 Initializer 并供应原实体；模型与配置不是同一对象，配置是固定数据，模型供给是可兑现的调用能力。显式供应同一模型实例可以共享它，供应工厂则由各次装配建立自己的模型缓存。

`createRuntime({ recorder?, changes? })` 是低层建立入口，只建立 RuntimeContext、可选 RuntimeRecord 和构造能力，不创建 Transcript/Memory 等实体。未装配 E 的 Runtime 不接受业务 `run`；其 Builder 保留供机制测试使用。`new Runtime(context, options)` 可以接管已建立的现场和记录，不是恢复加载入口。

RuntimeContext 仅保存唯一占用状态。Runtime 的 `running` 委托该 Context，不再另存一份状态；`reserve` 是内部调用机制入口，拒绝并发，不排队，finally 释放。业务通过 `run(input, options, callbacks)` 进入唯一已装配 E。

RuntimeRecord 正文目前只有 createdAt，通过 childIds 关联执行记录；没有伪造的调用 IO、processes 或调用终态。一次 E 完成不结束 R，也不释放独立实体。当前不引入 R Invocation、活动 E 集合、历史 Context 集合或统一实体管理器。

## E 的入口与工作

ExecutionDefinition 可声明 `entry: { requires, accept, admit? }`。accept 和 admit 是业务内容；固定 Execution 结构只控制时机和访问窗口。未声明 entry 的通用定义直接使用提交输入。

一次服务调用的顺序为：

```text
R 占用
  → source.validate 检查入口参数
  → 建立 entry 资源
  → entry.accept 正式接纳输入
  → accepted 通知（HTTP 在这里确认接纳）
  → 未取消时 entry.admit 执行分段策略
  → 关闭 entry 访问窗口
  → 捕获工作配置、固定历史范围与其他供给
  → 建立 E Context / Invocation
  → started → 调用 started 变化 → 开始记录
  → 启动本次资源事实 → execute / receive
  → 终态、变化及记录 → 释放 R 占用
```

entry 只能得到自己申请的访问形式；其端点在 accept/admit 窗口结束后失效，失败也通过 finally 关闭。这个窗口没有虚构的 Context ID 或 E 记录。取消保留现有规则：输入仍接纳，跳过 admit，随后由 Invocation 的取消检查阻止工作。

配置与固定历史范围在 capture 时决定，运行和记录使用同一来源，不能到记录或投影阶段重新读取当前配置、当前集合长度。Context 建立之前失败明确返回，不伪造 E 记录。输入校验失败不部分追加；若内容已经落实、捕获或记录随后失败，不承诺回滚。

started 是绑定侧同步回调，在 Context 已建立、Record 尚未登记时运行。它可以取得本次身份，但此时不能兑现工作资源。HTTP 的消息索引由入口或绑定已经确定的事实获得，不在 started 中读取历史端点。回调异常原样传播并释放 R 占用。

## Context、Invocation 与业务视图

R 装配三层 ContextBuilder 与 InvocationBuilder，跨调用复用；构造器不保存本次输入、信号或 Context。E 建立本次信号，O/A 保持同一信号引用。Context 私有保存直接父级或 E 构造器身份，供归属和活动检查使用，不向业务公开祖先取数入口。

Invocation 是单次、只能运行一次的结构化调用。它持有实际 Context、可选调用 Record、内部过程顺序与直接子关系。构造不写调用记录；运行前、每轮 execute 前及 receive 前检查本层和父层活动。子调用在已有记录模式下要求父调用已经登记。

业务声明实际收到的是冻结视图，不只是 TypeScript 的 Pick：

- ExecutionScope、OperationScope、AttemptScope：本层 level、id、input/currentInput、progress、state/status、signal、resources.values 和 continueWith。
- InvocationView：本次 context、origin.contextId、过程 sequence 及只读直接子关系。
- InvocationRelationView：子调用视图、round、key、returned、reception，不提供 returnedWith/accept 或生命周期修改。
- ChildBindings：本次父调用的已声明子入口，get/entry 创建窄 ChildCall；组合通过 accept 记录父层接收。

视图不暴露 Recorder、Record、原实体、ResourceBindings.select/attach、Context.complete/fail/startRound，也不能通过子关系绕过边界。视图保持 live getters；运行 IO、错误与再次生成证据保留原对象身份，不通过 JSON 复制“隔离”。业务视图的 level 保持类型层级约束，A 仍只能作为 O 的直接子项。

低层 Builder 与测试可以操作实际 Context/Invocation；这不使业务定义获得同样能力，也不是第三方代码沙箱或权限系统。资源实现中的实体引用只留在内部适配层。

未声明 receive 时由公共循环默认接收，声明 receive 后独立记录接收结果；不检查原型方法等价。局部 continueWith 复用同一 Context 与记录，只允许现有一／两轮范围；子调用始终另建 Invocation、Context、Record。

## 直接子调用、组合与有限再次生成

BindingEnvironment 在装配时沿轻量声明检查 E→O、O→O/A、无环以及直接资源覆盖，不建立未使用的子结构，不访问实体或调用模型。BoundChildren 为每个直接声明保留 Initializer，首次实际创建子调用时建立该绑定位置的结构。同一位置复用稳定 O 身份，不同 R 或不同父位置独立。

Initializer 只支持同步一次建立、递归检查、成功或失败缓存，没有重置、异步调度或统一释放。共享声明不承诺隔离应用自己保存的外部闭包；绑定后修改声明不是动态重配置能力。

InvocationChildren 是直接父子运行关系，与 Recorder 无关。关系记录子 Context 状态、run 返回/抛错以及父层接收状态；成功 Context 与交付失败可以同时存在，例如终态记录失败。直接 call 不声称父层已接收，只有明确的组合 accept 才推进 reception。

Sequence 是不可变顺序定义，step 包含 key、use、input 与可选 accept；类型只能读取前项已接收输出。每次 run 新建本次输出容器；输入构造失败不创建子调用，子调用或接收失败停止后续创建。组合没有第四层 Context、Record、调度器或自动重试。

回答生成仍只有一个受限再次生成声明：完整模型返回因 INVALID_JSON、EMPTY_OUTPUT 或 OUTPUT_SHAPE 被拒绝时，GenerateAnswer.receive 可决定再生成一次。InvokeModel.regeneration 的 InvocationEntry 检查直接子归属、实际返回/接收状态、剩余次数及完整反馈请求。第一轮组装上下文、准备、调用、接纳；第二轮只准备反馈请求、调用、接纳。使用原始结果和错误身份，不从 Recorder 反查，也不把调用关系写入业务 IO。

网络、超时、取消、非 stop 返回、记录/捕获失败，以及内容落实后的错误不进入该重试分支。回答仅在生成操作成功返回后由 E 的 accept 追加并交付一次；记忆后处理失败保留已交付回答。

## 资源供给、访问与事实

ResourceOffer 由资源所属模块公开来源、访问接口、binding/access 时机、capture 和可记录 describe。能力通过 request 正式申请，装配通过 provide 供应独立实体。项目对象身份控制匹配，名称标识资源事实和诊断；同名项目不能冒充。Sequence.requests 收集全部申请，不按本地别名覆盖。

ResourceBindings 持有供给与本次端点：

- capture 的结果或失败可由父子申请共享；配置、历史范围、记忆快照按 binding 时机固定，模型按 access 时机兑现。
- 每次调用通过 select 得到本地端点及事实序列，再 attach 本次归属；不能共享包含父调用来源的 writer 闭包。
- Invocation 记录建立后 start，记录本次 bound 和需要立即兑现的 available；惰性项目不会因为记录而提前建立。
- 普通业务只使用 values；保存下来的正式实体方法仍检查本次调用及祖先活动性，调用结束不能继续读写实体。已经取得的纯数据快照不因此失效。
- entry 使用独立短窗口 restrict，没有伪造调用身份，不混入工作资源的生命周期。

业务访问端点自动附加运行来源及可选私有记录来源。来源不由业务每次写入时传递，也不依赖 Recorder 存在。Transcript、Memories 的正式变化仍由实体自己审查、落实、产生变化并登记内容记录。

资源运行事实独立为 ResourceRecord 子记录：公共部分表达父调用、访问形式、供给、局部顺序、时间、阶段和操作关联；具体正文由资源契约定义。静态声明不登记。bound/available 不等于实际使用，runSync/runAsync 只包正式操作，不拦截每个属性读取。模型供给描述不序列化 Provider，消息资源只保存 UID、固定范围及必要版本，不保留运行实体引用。

| 资源访问形式                     | 业务端点                  | 记录说明                                         |
| -------------------------------- | ------------------------- | ------------------------------------------------ |
| 配置 snapshot/timeout            | 固定配置或字段值          | 本次采用的值，不等于模型实际请求                 |
| Transcript fixedRange            | locate/read/entries/slice | 原文 UID、固定区间与版本；不内嵌原文集合         |
| Transcript append / segmentation | append / current、start   | 正式访问及变化关联，entry 不伪造调用归属         |
| Memory snapshot / apply          | 固定正文 / 提案落实       | 所见版本或实际变化事实；不返回 Memory 实例       |
| SelectionUsage record            | add                       | 正式统计写入，不暴露统计实体                     |
| Model invoke                     | invoke                    | 实际供给描述、请求及结果摘要；不复制已有调用证据 |

E 记录不再认识 settings/transcriptRange。资源访问事实解释可见范围，选择 O 的结果解释实际选择，模型 A 的输入解释实际请求，不能互相替代。

## 记录失败与内容事实

启用记录/捕获时保持严格失败。开始记录失败不执行工作；资源或过程记录失败停止本地工作，不触发模型再次生成。成功操作后的记录失败保持已经发生的成果，不把记录异常误记为原操作异常，不自动重做。原操作失败与失败登记又失败时用 AggregateError 同时保留原因。

Invocation 的终态仍是 Context 先结束，再发布及登记；登记失败不回滚已完成 Context。Transcript 全批预检后追加，Memories 全批预检后逐项落实；登记期间失败可能留下已落实的批次前缀，不宣称事务。

TranscriptRecord 保存集合身份、追加或分段范围等事实，不携带消息全集。MemoryRecord 继续保留变更解释和结果，暂不建立通用历史版本仓库。资源访问事实和内容变化记录可以关联，二者不能重复声称发生了一次实体变化。

## 跨端消费

单次执行详情包含 E/O/A、调用边界和资源事实；基线、增量、按需详情都要覆盖新增记录，不能只在服务端登记。变化由正式生产者产生，不比较两份快照反推。记录、本地过程顺序与传输交付序号含义不同。

消息实体通过独立受控端点获取与同步，记录中的 UID/范围在客户端绑定层与实体副本组合。未加载不等于空正文；已加载实体接续增量，快照与增量有明确接续点。可变记忆不能用最新正文冒充历史证据。详见 [协议](protocol.md) 与 [观测增量](observation-increments.md)。

对话交付通过本次 delivery 资源，回答追加后、记忆后处理前交付；是否启用观测不决定对话能力。网络/UI 消费失败不回写业务结果。

当前不增加 Thread/TRSA、持久化恢复、通用版本仓库、权限、插件注册、动态规划、跨进程重放或页面布局重做。记录和实体历史保留能力也不等同于未来持久化保证。
