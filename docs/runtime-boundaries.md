# 运行结构、调用与资源访问边界

“运行时”表示声明、绑定、结构以及实体实际协作的活动状态，不等同于 `BoundRuntime` 类。`BoundRuntime` 只表示 R 层。世界的根是一簇独立实体：Transcript、Memories、SelectionUsage、模型供给、记录器、变化捕获器各有自己的职责与生命周期；R 绑定它们公开的资源访问形式，不成为这些实体的所有者。

## 声明、绑定和结构

| 层次 | 声明                                                                 | 绑定职责                                                       | 固定结构                                    |
| ---- | -------------------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------- |
| R    | RuntimeDefinition：E 子声明及 run/exceptions/observation             | assembleRuntime：供给检查、按次来源捕获及可选观测/变化能力装配 | BoundRuntime：业务 run 入口、占用与构造能力 |
| E    | ExecutionDefinition：entry、O 声明及平级 run/exceptions/observation  | 本次入口资源、工作资源与子结构接线                             | BoundExecution → ExecutionInvocationBuilder |
| O    | OperationDefinition：描述、O/A 声明及平级 run/exceptions/observation | 本位置的稳定结构身份、直接子入口与调用描述                     | BoundOperation → OperationInvocationBuilder |
| A    | AttemptDefinition：描述及平级 run/exceptions/observation             | 本次叶子访问与调用描述                                         | BoundAttempt → AttemptInvocationBuilder     |

声明由内核定义契约，服务提供具体内容，可使用类实例或满足契约的普通对象。声明不持有模型实例、BoundRuntime、构造器、Recorder、原实体或本次调用状态。业务复杂度留在声明及组合中，绑定不执行 Sequence、不决定业务分支。

`run` 声明 execute 与可选的正常输出 accept；`exceptions` 声明可接纳的异常契约、所需能力及处理内容；`observation` 是接收类型化事实、申请独立端口的同步声明数组。记录 IO 描述通过 `invocationRecording({ input, output })` 预设完成。它们是所属声明中的平级部分，不是 run 引用的附属处理器。`raises` 与 `maxRounds` 是所属结构的交付与轮次约束。错误收敛由内核固定，不增加第四类可替换声明。详见 [异常与错误边界](exceptions.md)。

绑定是职责，不要求每层有一个与结构功能重复的可调用包装类。BoundRuntimeBinding 是 R 装配结果的内部契约；落实后的 REOA 结构持有声明、调用工作及惰性直接子结构。服务只把已装配 R 作为业务运行入口。

```ts
const recording = bindRecording(recorder, { failure: 'isolate', invalidate: (error) => source.invalidate(error) });
const transcript = new Transcript(messages, { observation: recording.transcript, changes });
const memories = new Memories(transcript, { observation: recording.memory, changes });
const selectionUsage = new SelectionUsage();
const definition = new ConversationRuntimeDefinition();
const runtime = bindConversation(definition, { transcript, memories, selectionUsage }, provider, { observations: [recording], changes });

await runtime.run({ messages: newMessages }, { settings, signal, progress });
```

上面是服务装配示例。progress 是宿主为本次请求建立的 `ProgressChannel<ConversationProgress>`，输入、回答和调用映射共同使用它；任一来源消费失败后统一停用，下一次请求使用独立通道。`bindConversation` 创建模型 Initializer 并供应原实体；模型与配置不是同一对象，配置是固定数据，模型供给是可兑现的调用能力。显式供应同一模型实例可以共享它，供应工厂则由各次装配建立自己的模型缓存。

`createBoundRuntime({ observations?, changes?, clock? })` 是低层结构入口，不建立消息、记忆或记录实体。`assembleRuntime` 将声明、独立供给及本次来源绑定到 R。省略 observations 时关闭调用观测；显式空数组启用声明但不附加预设；[recording] 提供记录预设的本调用端口。开启后缺资源是装配错误，局部供给只满足观测声明，不能泄漏给工作和异常处理。

BoundRuntime 实例维护占用与稳定 ID；每次 run 建立独立 RuntimeContext / Invocation，通过声明的 children 选择、调用并接纳 E。当前服务只配置一个 E，内核不假定唯一 E。reserve 拒绝并发并在 finally 释放，包括构造、调用和观测失败。RuntimeContext 保存本次输入、信号、资源与进度，不保存实例占用。

RecordingRootRecord 是记录预设的跨调用根，RuntimeCallRecord 表达一次 R 调用。归属为根 → R 调用 → E → O/A。它们与真实 BoundRuntime/Context 身份分开；一次 R 调用结束不关闭实例根或独立实体。

## E 的入口与工作

ExecutionDefinition 可声明 `entry: { requires, accept, admit? }`。accept 和 admit 是业务内容；固定 BoundExecution 结构只控制时机和访问窗口。未声明 entry 的通用定义直接使用提交输入。

一次服务调用的顺序为：

```text
R 占用
  → source.validate 检查入口参数
  → 建立 R Context / Invocation，开始 R 工作
  → 选择已声明 E，建立 entry 资源
  → entry.accept 正式接纳输入，实体写入点发布被动提交进展
  → accepted 建立回调（仍是严格绑定钩子）
  → 未取消时 entry.admit 执行分段策略
  → 关闭 entry 访问窗口
  → 捕获工作配置、固定历史范围与其他供给
  → 建立 E Context / Invocation
  → started 建立回调 → 被动 started 进展 → 调用 started 变化 → 开始记录
  → 启动运行阶段资源 → run.execute / run.accept
  → 已声明的运行异常按契约进入 exceptions.handle
  → E 终态 → R 收到真实返回并接纳 → R 终态及实际交付 → 释放占用
```

entry 只能得到自己申请的访问形式；其端点在 accept/admit 窗口结束后失效，失败也通过 finally 关闭。入口事实归已有 R 调用，不虚构 E Context 或 E 记录。R 开始工作前已取消时不进入 E、不追加消息；接纳后取消保留已落实内容，在检查点停止。

配置与固定历史范围在 capture 时决定，运行和记录使用同一来源，不能到记录或投影阶段重新读取当前配置、当前集合长度。Context 建立之前失败明确返回，不伪造 E 记录。输入校验失败不部分追加；若内容已经落实、捕获或记录随后失败，不承诺回滚。

started 是绑定侧同步回调，在 Context 已建立、Record 尚未登记时运行。它可以取得本次身份，但此时不能兑现工作资源。它属于建立机制，异常原样传播并释放 R 占用；服务反馈不使用这个严格钩子。消息索引由实体写入点获得，不在 started 中读取当前集合长度。

## 被动运行进展与服务解释

ProgressChannel 是本次绑定提供的窄同步出口，不依赖 Recorder 或 C/S 协议。InvocationProgress 只表达 started / finished 和不可变调用身份，finished 的 status 是 Context 事实，不保证随后的捕获、观测或最终调用交付成功。四层 Builder 可接入；服务通过 RuntimeCallSource.progress 按实际 E 声明选择关联对象。

Transcript 的 append 在整批消息落实并更新 revision 后发布 TranscriptAppendProgress `{ transcriptId, start, end, revision }`，然后执行必要变化捕获及可选观测。资源供给可用 `{ transcript, progress }` 为入口写入和回答写入安装不同接收端；业务声明仍只取得正式 append 能力。无需 Record，也不能事后比较快照推断写入。

进展接收失败停用对应出口并报告 failure；同步抛错、意外异步返回及失败报告错误均不得进入 Context、Invocation 或业务异常处理。它与必要 ChangeCapture 的严格职责、观测声明的可选 propagate 策略不同。进展是反馈依据，无法完整接收时由服务标记解释不完整；已成立事实不回滚，也不重做业务。

`source.progress` / `source.executionProgress` 工厂属于绑定构造契约，工厂求值失败仍按构造错误传播；隔离边界针对已建立接收器的 `receive` / `failed`，不掩盖装配错误。

Conversation 绑定选择哪些调用与实体写入属于本次请求，产生服务内部 ConversationProgress；ConversationSubmission 再解释成跨端累计投影。R.run 的实际返回/抛错决定服务任务结果，不能由 E finished、记录状态或网络连接结束代替。见 [跨端协议](protocol.md)。

## Context、Invocation 与业务视图

R 装配 REOA 四层 ContextBuilder 与 InvocationBuilder，跨调用复用；构造器不保存本次输入、信号或 Context。R 建立本次信号，EOA 沿直接关系使用同一信号。Context 私有保存直接父级或 E 构造器身份，供归属和活动检查使用，不向业务公开祖先取数入口。

Invocation 是单次、只能运行一次的结构化调用。它持有实际 Context、局部观测绑定、内部过程及事实顺序与直接子关系，不持有 Record。构造不写调用记录；运行前、每轮 execute、正常接纳和异常处理阶段检查本层和父层活动及正式错误状态。可选记录预设维护自己的本调用句柄和父预设关系；无记录时调用仍完整成立。

业务声明实际收到的是冻结视图，不只是 TypeScript 的 Pick：

- RuntimeContextView、ExecutionContextView、OperationContextView、AttemptContextView：本层 level、id、input/currentInput、progress、state/status、signal、当前声明申请的 resources.values 和 continueWith。运行内容和异常内容分别取得自己的资源别名。
- InvocationView：本次 context、origin.contextId、过程 sequence、最终交付 failure 及只读直接子关系。本层工作视图有阶段资源，子关系与 ChildInvocationView 的 Context 只保留运行事实，不含子层资源端点。
- InvocationRelationView：子调用视图、round、key、returned、reception，不提供 returnedWith/accept 或生命周期修改。
- ChildBindings：本次父调用当前声明获准使用的子入口，get/entry 创建窄 ChildInvocationView；组合通过 accept 记录父层接收。run.uses 缺省沿用所属子声明，exceptions.uses 缺省为空；二者都不能申请所属 children 之外的子项。

视图不暴露 Recorder、Record、原实体、ResourceBindings.select/attach、Context.complete/fail/startRound，也不能通过子关系绕过边界。视图保持 live getters；运行 IO、错误与再次生成证据保留原对象身份，不通过 JSON 复制“隔离”。业务视图的 level 保持类型层级约束，A 仍只能作为 O 的直接子项。

低层 Builder 与测试可以操作实际 Context/Invocation；这不使业务定义获得同样能力，也不是第三方代码沙箱或权限系统。资源实现中的实体引用只留在内部适配层。

未声明 run.accept 时由公共循环直接接纳正常输出；声明后独立记录接纳结果。旧 receive 混合处理入口已移除，不检查原型方法等价。正常接纳的内部过程阶段仍名为 receive；异常处理使用 handling。局部继续复用同一 Context 与记录，只允许现有一／两轮范围；子调用始终另建 Invocation、Context、Record。

## 直接子调用、组合与有限再次生成

BindingEnvironment 在装配时沿轻量声明检查 R→E、E→O、O→O/A、无环、已开启声明的总资源覆盖及各自 uses 归属，不建立未使用的子结构，不访问实体或调用模型。BoundChildren 为每个直接声明保留 Initializer，首次实际创建子调用时建立该绑定位置的结构。同一位置复用稳定 O 身份，不同 R 或不同父位置独立。

Initializer 只支持同步一次建立、递归检查、成功或失败缓存，没有重置、异步调度或统一释放。共享声明不承诺隔离应用自己保存的外部闭包；绑定后修改声明不是动态重配置能力。

InvocationChildren 是直接父子运行关系，与 Recorder 无关。关系记录子 Context 状态、run 返回/抛错以及父层接收状态；成功 Context 与交付失败可以同时存在，例如终态记录失败。直接 call 不声称父层已接收，只有明确的组合 accept 才推进 reception。`children.accept(child, delivered => accepted)` 的 delivered 来自该直接子调用保存的真实成功返回，类型跟随 child；不能接纳异父、未返回、失败或已经接纳的调用。父层可以将真实交付加工成自己的接纳结果，returned 与 accepted 不必相等。

O/A 需要在执行中确定更小资源范围时，可信装配可配置 `childResources: [bindChildResources(definition, [offer.refine(input => selection)])]`。创建子调用前，根据该调用的输入派生供给；ResourceOffer 的 refine 检查并返回收窄后的捕获，内核只允许处理该子声明已经申请、父层已经供应的 offer。新供给有独立 supplyId，不修改父层或兄弟，不重捕获无关模型或原文。规则不是业务编排，也不能自行增加资源；endpoint 继续受调用活动与声明阶段约束。

Observer 的 E 在选择历史后运行有限决策循环。决策 O 交付 `invoke { capability, arguments }` 或 `finish { conclusion }` 提案；E 检查公开能力、参数、当前阶段和完成条件，再调用真实子声明。当前能力条目为 checkFile、answer、document、save，条目引用真实子声明，并分别提供参数 Schema、可用条件、内部输入构造和真实输出接纳。决策 O、选择历史与记忆收尾不进入可选目录。目录是本次 E 组合的派生信息，不是第二个全局注册表。

默认决策 O 将已知交付直接转为下一步：预检通过后处理正文、回答落实后按已选目标保存、保存凭据接纳后结束。只有目标尚未确定或候选需要修正时，内部理解 O 才使用模型；函数决策 O 无模型资源，也使用同一交付契约。可通过 `ConversationRuntimeDefinition({ decision })` 替换声明；专门的决策模型同样可提供一个 O，在其内部通过 A 接入。E 不知道具体 Prompt 或模型类型。

```ts
const definition = new ConversationRuntimeDefinition({
  decision: new FunctionConversationDecisionDefinition(({ progress }) => (progress.answer ? { kind: 'finish', conclusion: { kind: 'settled' } } : { kind: 'invoke', capability: 'answer', arguments: {} })),
});
```

以上是纯问答策略；选择其他能力的策略需要消费预检交付和 available，不能拿这个策略绕过显式文件任务。E 只接纳真实事实支持的完成提案：没有回答不能 settled；已有成功正文且选定保存目标时，必须接纳真实保存凭据才能 settled。决策输入是独立数据副本，不把实体、端点或可修改的内部进展交给策略。正式用户 message 仍保留冻结身份，以对应固定原文范围。

循环默认最多 8 步，可在 1–16 步内配置。无效提案与重复文件候选形成正常接纳反馈，不成为内核错误；达到上限则以 DECISION_LIMIT 失败，保留已落实内容。真实子调用、绑定、观测传播或处理器错误按现有机制退出，不转给模型无限修正。这与 Invocation.maxRounds 的同一调用有限再次生成是两种边界。

文件预检 O→A 通过独立 inspect 资源，仅核对命名路径和元数据；根内绝对路径可规范为相对路径，不读取正文、不枚举目录、不预留文件。候选缺陷返回 revise，已确认的文件条件不足返回 needs-input，环境故障与取消仍抛出。显式文件范围在预检端点核对，实际文档 O/保存 O 的绑定继续收窄 read/create 路径。预检通过不保证随后成功，实际读取继续检查 UTF-8、大小和目录身份，实际创建继续拒绝覆盖。

候选与预检事实只存在于本次 E 进展和普通调用交付中。task 在正式执行分支启动或形成澄清/不支持结论时才发布一次。回答生成后由 E 接纳并追加，记忆提取是 E 的固定收尾，不由策略选择。没有新增 DecisionRecord、Context 规划字段、跨 QA 挂起、持久计划或运行中注册能力。

Sequence 是不可变顺序定义，step 包含 key、use、input 与可选 accept；类型只能读取前项已接收输出。每次 run 新建本次输出容器；输入构造失败不创建子调用，子调用或接收失败停止后续创建。组合没有第四层 Context、Record、调度器或自动重试。

回答生成仍只有一个受限再次生成声明：AcceptModelOutputDefinition 对完整返回的 INVALID_JSON、EMPTY_OUTPUT 或 OUTPUT_SHAPE 拒绝生产正式 modelOutputRejected 异常，保留原始拒绝原因与模型返回。该 A 通过 raises 允许向父层交付；GenerateAnswerDefinition.exceptions 按契约身份与直接子调用证据决定是否继续一次。InvokeModelDefinition.regeneration 的 InvocationEntry 复查直接归属、实际返回/接收状态、次数及完整反馈请求。第一轮组装上下文、准备、调用、接纳；第二轮只准备反馈请求、调用、接纳。不从 Recorder 反查，也不把调用关系写入业务 IO。

网络、超时、取消、非 stop 返回、记录/捕获失败，以及内容落实后的错误不进入该重试分支。回答仅在生成操作成功返回后由 E 对应能力条目的 accept 追加并交付一次；记忆后处理失败保留已交付回答。

## 资源供给、访问与事实

ResourceOffer 由资源所属模块公开来源、访问接口、binding/access 时机、capture 和可记录 describe。能力通过 request 正式申请，装配通过 provide 供应独立实体。项目对象身份控制匹配，名称标识资源事实和诊断；同名项目不能冒充。Sequence.requests 收集全部申请，不按本地别名覆盖。

ResourceBindings 持有供给与本次端点：

- capture 的结果或失败可由父子申请共享；配置、历史范围、记忆快照按 binding 时机固定，模型按 access 时机兑现。
- 每次调用通过 select 得到本地供给范围与事实会话，再 attach 本次归属；运行和异常阶段分别兑现受阶段约束的端点，共享本次资源顺序与固定捕获，不能共享包含父调用来源的 writer 闭包。
- Invocation started 发布后 start 只激活 run 请求；进入异常处理时才激活 exceptions 请求。相同调用内同一供给的 bound/available 不因阶段切换重复登记；惰性项目不会因为记录而提前建立。
- 普通业务只使用本阶段的 values；保存下来的正式实体方法仍检查当前阶段、本次调用及祖先活动性。正式错误成立之后也不能继续读写实体或启动子调用。已经取得的纯数据快照不因此失效。
- entry 使用独立短窗口 restrict，归已有 R 调用，不混入工作资源的生命周期。

业务访问端点自动附加 origin 与本次实体观察端口。实体自行审查、落实并发布变化；必要捕获与可选消费独立分发。记录预设解释事件形成记录，实体不持有 Recorder 或记录身份。同一实体发布期间拒绝重入变更。

资源发布 ResourceObservation，记录预设可将其写为 ResourceRecord：公共部分表达父调用、访问形式、供给、局部顺序、时间、阶段和操作关联；具体正文由资源契约定义。静态声明不登记。bound/available 不等于实际使用，runSync/runAsync 只包正式操作，不拦截每个属性读取。模型供给描述不序列化 Provider，消息资源只保存 UID、固定范围及必要版本，不保留运行实体引用。

| 资源访问形式                     | 业务端点                  | 记录说明                                         |
| -------------------------------- | ------------------------- | ------------------------------------------------ |
| 配置 snapshot/timeout            | 固定配置或字段值          | 本次采用的值，不等于模型实际请求                 |
| Transcript fixedRange            | locate/read/entries/slice | 原文 UID、固定区间与版本；不内嵌原文集合         |
| Transcript append / segmentation | append / current、start   | 正式访问及变化关联，entry 不伪造调用归属         |
| Memory snapshot / apply          | 固定正文 / 提案落实       | 所见版本或实际变化事实；不返回 Memory 实例       |
| SelectionUsage record            | add                       | 正式统计写入，不暴露统计实体                     |
| Model invoke                     | invoke                    | 实际供给描述、请求及结果摘要；不复制已有调用证据 |

E 记录不再认识 settings/transcriptRange。资源访问事实解释可见范围，选择 O 的结果解释实际选择，模型 A 的输入解释实际请求，不能互相替代。

## 异常、错误与已成立事实

ExceptionContract 按对象身份定义可处理异常。工作产生自身 raises 声明的异常，或直接子调用交付已经确认的异常，才能进入匹配的 exceptions.handle。A 没有本地处理器不等于立即变为错误；交付异常仍保留该 A 的失败状态。没有最终消费者的异常在 R.run 出口转为 UNHANDLED_EXCEPTION，cause 保留原异常。

结构、绑定、调用机制和处理器自身错误不进入业务异常处理。正式端点将错误归入所属调用，业务 catch 不能抹掉该事实或换抛异常重新获得处理资格；错误之后的正式端点停止接纳。异常处理器返回 return/continue/unhandled，结构检查并落实；处理器本身抛错或返回非法结果按错误结束，不递归调用处理器。

Invocation.failure 表达最终交付的 exception/error 分类、发生阶段、Context 归属及原因，独立于 Context.status。错误收敛保留已成立事实、结束相应调用并交付失败；收敛机制自身出错属于 bug，不再建立第二层处理链或故障恢复承诺。

## 观测失败与已成立事实

观测预设是可选安装。安装后默认 isolate：停用失败观察者，保留已写结果，健康观察者继续消费本事实；propagate 另外使所属运行交付错误。服务采用 isolate，记录来源仍须终止不完整的观测交付。必要变化捕获仍是严格同步职责，失败不会回滚事实或重复工作。原操作失败与报告失败共同保留为 AggregateError。

调用 Context 先结束，再发布 finished；终态观测失败不回滚已成功 Context。子真实返回由父关系 returned 表达，父返回观察失败不得进入子 run 的 catch 造成二次返回。receiving 观察传播失败会阻止接纳工作；accepted 已成立后失败则保持接纳成功。每种关系变化沿父调用事实顺序发布，记录预设另存 relationChanges，不改变 processes/resultOf 相邻语义。

Transcript 全批预检后追加，Memories 全批预检后逐项落实。捕获与可选观察均尝试消费同一已落实事实，再结算故障；不宣称事务。消息记录只保留范围，记忆记录保留本次解释与结果。更多见 [观测出口与载体](observation.md)。

## 跨端消费

单次执行详情包含父 R 调用、E/O/A、各自计时范围的调用边界和资源事实；基线、增量、按需详情都要覆盖新增记录，不能只在服务端登记。变化由正式生产者产生，不比较两份快照反推。记录、本地过程顺序与传输交付序号含义不同。

消息实体通过独立受控端点获取与同步，记录中的 UID/范围在客户端绑定层与实体副本组合。未加载不等于空正文；已加载实体接续增量，快照与增量有明确接续点。可变记忆不能用最新正文冒充历史证据。详见 [协议](protocol.md) 与 [观测增量](observation-increments.md)。

对话交付读取服务提交投影，独立消息流提供正文。回答追加后、记忆后处理前即可被确认；是否启用观测不决定对话能力。HTTP 连接结束不取消运行，投影消费和网络/UI 故障不回写业务结果。

## 协作取消

运行取消通过本次 R 的 InvocationControls.signal 传递到 E/O/A。新子调用、父层接纳及业务资源活动复用公共活动检查；先保留已归属错误，再检查取消。InvocationCancelled 绑定本次 signal 身份，isInvocationCancelled 只识别这个明确交付，不遍历 cause 或仅比较 code。Context、Invocation 和调用方保持同一交付原因；独立错误与复合故障不能被并发取消覆盖。

模型资源把运行信号与 timeout 合并，在资源活动捕获之前规范化：主动取消保留根信号身份，超时为 MODEL_TIMEOUT，网络和解析故障保留真实原因。取消不回滚已经成立的实体更新，也不阻止内核收尾、记录终态和释放占用。能力未响应取消时仍等待其返回，不采用抢先结束 Promise 的方式虚构完成。服务根据 R.run 的实际退出投影 cancelled，内核不感知客户端队列或服务提交协议。

当前不增加 Thread/TRSA、未完成调用恢复、通用版本仓库、权限、插件注册、动态规划或跨进程重放。单一对话的内容与记录持久化由独立实体端口和服务存储负责，见 [持久化](persistence.md)；不序列化 Invocation / Context，也不让历史记录重新驱动运行。
