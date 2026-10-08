# Runtime、调用和内容变化边界

Runtime 通过 RuntimeContext 持有持续运行信息：Transcript、Memories，以及消息选择累计观测值。它们跨多次 E 调用存在，不随业务声明或 O/A 绑定的重新建立而重置。运行记忆不是用户画像；当前不分短期／长期存储，不实现持久化或恢复。

## 装配与持有

环境初始化一个 Recorder 和 RecordBook、Clock，再通过 createRuntime 建立新的数据范围，建立业务声明并绑定到 Runtime。实际 O/A 结构按需初始化。Runtime 接受已建立的 RuntimeContext 与可选的 recorder/record 配对，不创建或关闭 Recorder；Transcript、Memories 和 Invocation 的记录接线使用同一个 Recorder。无 Recorder 时，内容与调用仍正常工作。

`createRuntime({ recorder?, messages? })` 创建独立 Transcript、Memories 与 SelectionUsage，组成 RuntimeContext；开启记录时登记一条 RuntimeRecord，再构造 Runtime。messages 是待接纳的初始原始消息，经过正常 append 并产生内容记录，不是历史快照导入。initializeObserver 同样接受消息数组，不再接受或转移已有 Transcript 实例。环境的 transcript 属性只是 runtime.context.transcript 的同一引用。

`new Runtime(context, { recording: { recorder, record }, changes })` 只接管显式传入的现场和已登记记录，不清空内容或创建新记录；这不是持久化恢复入口，也不提供多个活动实例共享同一现场时的协调。实例存活、数据范围持续和记录保留分别理解，构造与销毁实例不隐含数据范围的建立或结束。

RuntimeRecord 继承 CompositeRecord，正文目前只有 createdAt，通过 childIds 关联其下的执行记录。它没有调用 IO、processes 或 running/succeeded/failed；某个 E 完成不会结束 R。RuntimeContext 保留内容对象引用，RuntimeRecord 不复制消息或记忆正文。此次不增加 Context ID、持久化、恢复、暂停或完成状态机。

Runtime.run 只负责顶层运行占用：忙时拒绝，不排队；finally 释放。ExecutionBinding.call 把已有输入交给 submit，经固定 Execution 结构委托 ExecutionInvocationBuilder，在占用之后执行接纳函数，再捕获本次资源、建立 Context 和 Invocation。HTTP 使用延迟接纳，因此拒绝并发请求时既不追加消息，也不发送成功响应。不同 E 绑定调用同一个 Runtime，同样受约束。

## 调用对象

运行结构 Execution、Operation、Attempt 是固定的内核类，不再由具体业务继承。业务分别实现 ExecutionDefinition、OperationDefinition、AttemptDefinition；声明只保存资源需求、直接子声明、描述和 execute/receive 内容，不持有 Runtime、构造器或本次调用状态。Binding 将声明与本环境结构对应起来，每次调用再建立独立 Context、Invocation 和可选 Record。

Runtime 装配时创建三层 ContextBuilder 和 InvocationBuilder，跨调用复用。ExecutionContextBuilder 只提供现场构造与归属身份，不持有 Transcript；OperationContextBuilder 检查 E 或 O 父级，AttemptContextBuilder 检查 O 父级。ExecutionContext 私有保存构造器身份，不保存 Runtime 或服务来源。O/A 私有持有直接父级用于归属和活动检查，不公开父 Context 取数入口；工作只从本层 resources 取得声明接口。手工创建的 Context 仍可供低层使用，这不是权限隔离。

各 InvocationBuilder 接受对应上下文构造器和所需记录能力；E 另接受 Runtime 让渡的 run 函数，先占用再接纳。构造器不保存本次输入、Context 或 signal。顶层每次创建或接收信号，O/A Context 绑定同一信号引用；取消改变信号状态，下次调用的新信号不覆盖旧 Context。构造器不通过方法分派 E/O/A，不引入无实际公共实现的构造器基类。

ObserverRuntimeDefinition.admit 声明容量判断和切段策略，由 ObserverBinding 在接纳后、Context 固定范围前调用，仍处于 Runtime 占用内。绑定提供入口需要的配置、记忆快照和分段接口；策略属于业务内容。请求组装、模型调用、契约接纳、记忆落实仍是工作本身，不移动到绑定。

对应入口：

| 工作入口                       | 调用构造器                 | 上下文构造器            |
| ------------------------------ | -------------------------- | ----------------------- |
| ExecutionBinding.call / submit | ExecutionInvocationBuilder | ExecutionContextBuilder |
| OperationBinding.create / call | OperationInvocationBuilder | OperationContextBuilder |
| AttemptBinding.create / call   | AttemptInvocationBuilder   | AttemptContextBuilder   |

Invocation 接收已经建立的 Context、工作、信号、记录接线和可选入口检查，采用具名参数；构造时不写调用记录。run 只允许一次，并在开始登记前重新检查父级是否仍有效，避免建立后延迟运行穿过已结束的父级。它负责开始登记、execute/receive 局部循环、终态和错误登记。循环中的轮数、输入与状态只存放在 InvocationContext，不复制到 Invocation。ExecutionContext、OperationContext、AttemptContext 是调用现场的特化，不是实例生命周期信息容器。

EOA 声明共用 InvocationDefinition 的 execute、可选 receive 和默认 maxRounds 契约，也可以使用满足契约的普通对象。bindInvocationWork 在建立调用时接线到声明，并为 execute/receive 提供当前父调用的 ChildBindings。它不维护业务状态。未声明 receive 时，默认接收仍只由公共调用循环提供；声明后独立保存接收结果，不检查原型方法身份。

具体 receive 决定分支；通用调用只落实继续或结束，保留一／两轮限制、取消检查、默认接收结果引用。局部循环复用同一 Context 和记录；子调用创建独立 Invocation。Attempt 不再细分运行层级。

execute(context, invocation, children) 与 receive(context, result, invocation, children) 显式取得本次调用及子入口。叶子可以省略不用的参数。OperationBinding.create/call 接受 E 或 O 的 Invocation，AttemptBinding 只接受 O 的 Invocation。嵌套操作直接传父操作调用；InvocationBuilder 将 parent.context 交给 ContextBuilder，将 parent 交给记录接线；没有 Context → Invocation 的全局反查表。

Invocation.record 在登记前为空，登记后固定指向本次调用记录；可选 started(context, invocation) 回调发生在登记之前，供调用方捕获调用对象，不保证此时已有记录。回调类型统一为 InvocationStarted，执行入口使用 ExecutionStarted 特化；它是同步接线，在调用有效性检查之后、登记之前执行。回调抛错保持原异常，停止登记与工作并释放顶层占用，不包装成 RecordingError。记录启用时，子调用开始登记要求父调用已登记。原有 Context 活动与 Runtime 归属检查仍保留；未记录的调用不需要伪造记录。

调用建立失败不产生虚构的运行记录。Context 仍沿用原有 running 状态，progress.round=0 表示尚未进入工作；本轮不新增生命周期状态。开始登记失败不执行工作；过程登记失败终止调用，不自动重试。Context 成功结束后，终态登记失败只传播登记异常，不把已完成的工作改判为失败。工作失败且失败登记再次失败时，AggregateError 同时保留两个错误。Runtime 的占用均会释放。

## 内容的正式变化入口

Transcript.append / appendFrom 审查整批消息后追加；startSegment 检查有效且前进的边界后切段。每次有效变化登记一个 TranscriptRecord，含 Transcript 身份、时间、追加范围与正文或分段边界。消息仍为不可变原文，绝对索引不重排。带调用来源时记录 contextId、callId、executionId；调用外接纳不伪造调用。空追加与非法变化不登记。

Memories 绑定一个 Transcript，提供 get/values/snapshot/apply。apply 检查完整批次的动作、目标、解释、唯一依据、来源存在性与包含关系，才落实内容。无变化更新不登记。模型提案的可见范围与本轮证据约束仍归提取输出契约。当前记忆体对外只读，无 add 或公开 update 旁路；包内更新保留 Memory 实例与 ID，替换冻结正文。

ApplyMemory 通过申请到的写入接口提交提案和因果身份，现场活动检查统一由调用机制执行，不自行创建 Memory 或补写记录。Memories 在实际变化发生后调用 Recorder。MemoryRecord 保留变化解释和结果正文，关联执行、操作及实际调用；无调用的变更也能记录，不伪造 executionId/operationId。记录链接在调用侧从 invocation.source 取得，由记录接线解释本次绑定记录，再传递给内容对象；不用记录状态裁决记忆变更是否允许。MemoryRecordHelper 构造记录并提供查询，Memories 通过通用 Recorder.add 登记。

提案返回、提案接纳、内容落实是不同事实：提案与接纳结果在调用 IO 中，已落实变化才进入内容记录。登记错误发生时保留已经改变的内容，不虚构回滚或自动重做。批次预检查失败不部分落实；登记期间失败仍可能留下已经落实的批次前缀，当前不承诺事务。

## 观察与协议

RuntimeSnapshot 是单次执行的 E/O/A 及调用边界详情。独立 ObservationFeed 消费系统变化，首次发 baseline，后续发有归属与顺序的 delta；不通过快照 diff 推测变化。内容、调用过程及记录登记分别产生事实；对话回答由 ObserverBinding.converse 独立交付，不依赖观测。详见 [观测基线与增量](observation-increments.md)。

Observer 按实际操作角色查询历史，不依赖当前行为实例 ID 来过滤旧执行。OperationRecord 仍保留实际 Operation 结构的 operationInstanceId。更换绑定不会丢失历史回答、选择计数或记忆关联。

本轮没有 Thread/TRSA、插件注册、通用上下文容器、调度队列、导入恢复或通用重试机制。已有变化生产、捕获和发送职责不变。

记录机制的进一步分离见 [记录边界](recording.md)。

## 入口参数与变化出口

入口按所处边界分类，不按统一参数数量改写：

- Runtime(context, options)、Memories(transcript, options)、Recorder(book, options)：必需主体独立，可选稳定能力具名装配。Recorder 的 clock 是记录时间来源，记录 Helper 不再另传一份 Clock。
- 三层 InvocationBuilder(contexts, capabilities)：上下文构造者与稳定调用能力分开；E 额外要求 run 占用入口，O/A 不获得它。
- ExecutionInvocationBuilder.create(input, request) / submit(accept, request)：输入或接纳函数独立，request 包含 context、requires、establish、validate、work、started。context 只带本次信号；establish 由绑定侧提供本次 ResourceBindings 和记录元数据，validate 检查入口环境。submit 在接纳前检查，create 在接纳后复查；构造器不保存当前信号或服务来源。
- Operation/AttemptInvocationBuilder.create(parent, request)：直接父调用独立，request 包含 input、description、requires、work、key。普通 Binding.call(parent, input) 保持简短，不穿透传递记录或观测能力。
- 记录构造保留 definition 与 value 的区分；definition 集中身份、局部位置及来源。Record Helper 的机制依赖（Recorder 或 Clock）放在独立参数中。
- cycle(invocation, work, options)：调用对象、工作行为、循环控制与过程出口分开；Context 从 invocation 取得。onProcess 表达过程发生，不将循环与 Recorder 绑定。

InvocationChangeEmitter 每次调用独立创建，保存固定身份和本地事件序号；负责时间戳及不可变事件正文，向装配好的 ChangeCapture 发布。Invocation 仍明确控制开始、过程与结束处的发布及登记顺序，并处理失败；没有通用插件列表或隐式生命周期分派。捕获失败不回滚事实、不自动重做，记录绑定仍属于 Invocation。

## 直接子调用与顺序组合

父层对直接子调用的感知属于运行机制，不由 RecordTree 反向推导。OperationBinding/AttemptBinding.create(parent,input,{key?}) 经固定结构与 Builder 创建 Invocation 并挂到 parent.children；call 是 create 后 run。E→O、O→O、O→A 沿用 ContextBuilder 的层级与归属检查。A 不增加子执行层。

每个父 Invocation 独立持有 InvocationChildren，集合中的 InvocationRelation 表达父子调用关系，不是新的调用实体，也不限定 E/O/A。关系关联实际子 Invocation、创建时父层 round、可选工作位置 key。父层能在子运行前看到它，运行状态读取子 Context，不复制另一份状态机。子 run 返回或抛错后保存 returned；父层接收以 pending → receiving → accepted(output) / failed(error) 单独表达。直接 call 没有声明父层接收动作，reception 保持 pending。调用结束后的登记异常可能使 Context 已成功而 returned 失败，这是不同边界的事实，不将它们合并。关系不进入可复用行为实例，也没有全局子调用索引。

Sequence 是不可变的顺序组合定义。每个 step 有工作位置 key、use 子能力、input 构造与可选 accept。输入输出契约沿用子能力的 TypeScript 类型和已有业务接纳；只允许读取前项已接收的输出。accept 可返回父层接收后的值，后项使用这个值；子层原始结果仍由对应子调用保存。Sequence 不创建第四层 Context/Record。每次 run 只建立本次输出容器，父层持续持有实际子调用及接收结果；同一能力可用于不同位置，同一组合可跨调用复用。

Observer 的选择计数、回答追加与交付属于父层接收，不隐藏在 input 构造中。三个操作内部也显式组合请求准备、模型调用、输出接纳等 A。契约失败后仍可从本次操作的直接子调用读取模型原始返回，无须查询记录；记忆失败仍保留生成子调用、父层已接收的回答及正式消息。

第一版只按声明顺序运行，等待父层接收结束再创建下一项。输入准备失败不创建子调用；子调用或父层接收失败立即抛出，尚未运行的项仍只是定义，不补造调用。没有重试、恢复、取消补偿、并行或父层自动等待所有手工子调用等策略。运行关系暂不新增观测通知或线协议字段；现有记录与前端行为保持原边界。

## 完整模型返回被拒绝后的有限再次生成

这一轮只启用 GenerateAnswer：第一次完整模型返回因 INVALID_JSON、EMPTY_OUTPUT 或 OUTPUT_SHAPE 被 AcceptModelOutput 拒绝时，父操作可以再生成一次。筛选与记忆提取仍为一次。网络失败、超时、取消、非 stop 返回、记录/变化捕获失败，以及消息或记忆落实后的失败，不属于该声明。

声明与决定分开：InvokeModel.regeneration 暴露适用条件、最多一次追加调用、allows 与 InvocationEntry。GenerateAnswer.receive 检查实际接纳失败，再决定 continueWith；第二轮 Sequence 引用该 entry，由当前 ChildBindings 先检查直接声明与父调用归属，再运行 entry.accept，检查完成状态、原始结果与拒绝的关联、剩余次数及完整反馈请求，最后通过同一个已绑定 A 创建新调用。InvocationEntry 只有输入接纳逻辑，不能自行创建调用。这是服务内明确的协作约定，不是阻止任意代码再次调用普通入口的权限体系。

首次序列为组装上下文 → 准备请求 → 调用模型 → 接纳结果。第二轮仅为准备反馈请求 → 调用模型 → 接纳结果。反馈包含上次原始正文与校验错误码/消息，原有 Schema 和请求参数不变；不截断错误返回，加入反馈后超容量则停止，不发出第二次外部调用。原错误的详细结构仍保留在失败调用中。第二次仍不合法时传播第二次原错误，不再继续。

父操作同一 Context / Record 中追加第二轮过程；每次实际 A 都建立独立 Invocation、Context 和 Record。父层通过 Invocation.children 的直接关系取得原始结果和拒绝，不反查 Recorder。关系只作为组合运行参数使用，不进入 GenerationInput 或模型调用的记录 IO；准备反馈的 A 只接收普通请求、模型输出和错误正文。无 Recorder 时执行语义一致。

回答只有在生成操作成功返回后，才由 E 的 accept 追加并交付一次。随后记忆提取失败仍保留回答，不触发生成重试。Sequence 仍然在每轮首个失败处停止；再次生成策略属于 GenerateAnswer.receive，通用调用循环只落实最多两轮。当前 Promise 只有一次终态，不支持错误后继续交付结果、迟到回包接管或跨进程恢复。

## 资源公布、申请与交付

资源不是把实体按名称塞进 Context。资源所属模块公布可申请项，能力引用该项目发出申请，装配处供应实际来源，资源项目自身负责兑现访问接口。

```ts
// 资源所属模块：定义可申请的访问形式及来源契约。
TranscriptResource.fixedRange;
ModelSettingsResource.snapshot;
ModelSettingsResource.timeout;

// 能力：申请公开项目，history/settings 只是本地别名。
readonly requires = {
  history: TranscriptResource.fixedRange.request(),
  settings: ModelSettingsResource.snapshot.request(),
};

// 装配处：提供当前范围；如何构造读取对象由资源定义负责。
TranscriptResource.fixedRange.provide((source: ObserverResourceSource) => source.transcriptRange!);

// 工作：使用正式交付的接口。
context.resources.values.history.read(index);
```

核心机制在 `resource/offer.ts` 与 `resource/bindings.ts`：

- ResourceOffer 由资源所属模块定义，固定诊断名称、来源类型以及来源到访问接口的实现。request 生成正式申请，provide 把本次来源供应函数接入该项目；供应方不能另写返回接口的语义。
- ResourceRequest 引用公布项目的身份。名字只用于说明和错误，不作为匹配键；临时定义一个同名项目不能满足原项目申请。能力不能用 `access: 'read'` 给任意实体自行赋予访问能力。
- ResourceBindings 持有本次可供应项目与访问入口。对子层 select 根据项目身份匹配，允许不同别名引用同一项目；只交付子层声明的部分，不从祖先补齐。values 的属性读取才兑现 access 类项目，父子及别名共用同一次兑现结果或错误。
- Sequence.requests 收集实际 use 的全部申请，不按别名合并。两个子能力的同名别名指向不同项目时都必须检查，不能互相覆盖。steps 保留实际组合引用，不另维护依赖图。

BindingEnvironment 在 E 绑定建立时沿声明检查 E→O、O→O/A、无环关系以及直接父层是否覆盖子层资源申请。只遍历轻量声明，不建立 O/A 结构，不兑现资源、不读取消息或调用模型；允许不同分支共享同一声明。资源装配检查申请有且只有一个供应者。声明的 children 是允许绑定的直接子集合，Sequence 是业务选择的顺序及输入/接收逻辑，两者职责不同。

创建调用时，现有构造器先检查父层有效性，再落实申请。E 在本次 Context 建立时绑定服务装配提供的来源；所有 O/A，包括顶层 O，都只能使用直接父层开放的项目。未供应的申请在对应 Invocation 建立之前失败；按需资源在首次读取时兑现，来源初始化失败在该使用位置传播。资源交付不依赖记录，资源对象不进入调用记录 IO。

| 公布项目                        | 来源契约           | 实际交付                            | 变化语义                                        |
| ------------------------------- | ------------------ | ----------------------------------- | ----------------------------------------------- |
| TranscriptResource.fixedRange   | TranscriptRangeRef | start/end/length/read/entries/slice | 固定范围；slice 只能收窄                        |
| TranscriptResource.append       | Transcript         | append                              | 返回不可变索引与消息条目，不返回 MessageRef     |
| TranscriptResource.segmentation | Transcript         | current/start                       | 仅用于 E 受理后的分段准备，不下发到工作 Context |
| MemoryResource.snapshot         | Memories           | 冻结的记忆正文数组                  | 本次快照不随集合后续变化                        |
| MemoryResource.apply            | Memories           | apply                               | 委托实体校验和落实，不返回 Memory 实例          |
| SelectionUsageResource.record   | SelectionUsage     | add                                 | 只提交选择计数，不暴露统计实体                  |
| ModelSettingsResource.snapshot  | 本次配置           | 冻结的配置副本                      | 后续配置变化不影响本次值                        |
| ModelSettingsResource.timeout   | 本次配置           | timeoutMs                           | 配置字段投影                                    |
| ModelResource.invoke            | ModelProvider      | invoke                              | 保留方法接收者，只交付调用接口                  |

TranscriptRangeReader 私有持有区间引用，不公开原 Transcript、MessageRef 或写入方法。read 委托原区间检查边界；entries 返回冻结的索引/消息条目，消息沿用原不可变对象。slice 用于容量分段候选，只能在已给范围内收窄。固定区间申请仍不附带任意区间表达式；范围来源由构造时确定。

核心 ExecutionContext 不再包含 settings、TranscriptRangeRef 或来源 WeakMap。ObserverBinding 在接纳和切段完成后，固定本次配置与区间，作为 ObserverResourceSource 交给资源供应函数；另将既有观测字段通过 ExecutionRecordMetadata 交给记录接线。ExecutionContext 只收到正式的 ResourceBindings。元数据沿用现有 settings/transcriptRange 记录契约；无此元数据的通用执行保存 settings:null，本轮不重设计记录正文或传输协议。

ObserverRuntimeDefinition 声明资源供应函数、模型工厂和 E 定义；ObserverBinding 持有本 Runtime 的模型 Initializer，并在每次执行捕获来源。模型首次实际访问时建立，同一绑定内复用。ObserverExecutionDefinition 申请本层及子层需要的资源，selection/generation/extraction 逐层收窄；ApplyMemory 只取得 memoryWriter，InvokeModel 只取得 model/settings/timeoutMs。业务定义不持有构造器或本次来源。

分段准备与执行工作分开：entry 申请配置、记忆快照和分段访问，完成当前容量策略后才建立 E Context、固定执行区间。E 工作持有消息追加、选择统计等必要接口；记忆变更由 A 提交。输入消息接纳仍属于服务入口，不伪装成 E 内部工作。

O/A 的直接父级改为私有引用，公开 requireActive/belongsTo 只回答运行有效性与构造归属，不返回祖先 Context；Runtime 的 getExecutionContext/getOperationContext 移除。调用机制在开始、每轮执行前、接收前重查父层活动状态，覆盖异步等待期间父级结束的情况；校验不是取消已发出的外部请求，也不回滚已经落实的变更。

原资源的所有权、释放、变更校验、变化事件与记录职责保持原位。资源接口不再生成一份通知或记录。服务装配、HTTP 输入接纳、观测查询和记录 Helper 仍按自身职责访问原实体；它们不是业务工作绕过声明的入口。本轮不新增 Scope、权限系统、动态资源注册或通用生命周期框架，正式申请也不提供对任意第三方代码的执行隔离。

输入组织仍属于原有组合与业务能力。AcceptModelOutput 显式接收 output 及按需的 basis，不从父操作输入强转；请求构造、容量检查和模型输出接纳仍在对应工作中执行。

## 声明、绑定和结构

声明的契约由内核定义，具体内容由服务实现，可以使用类实例或类型明确的普通对象。声明不等于配置 JSON，也不是可以绕过运行结构自行执行的入口。

| 层次 | 声明                                                  | 绑定                                                       | 固定结构                               |
| ---- | ----------------------------------------------------- | ---------------------------------------------------------- | -------------------------------------- |
| R    | RuntimeDefinition：资源供应、具名 E 声明              | RuntimeBinding：本 Runtime 的 E 装配入口                   | Runtime：持续现场、占用和构造能力      |
| E    | ExecutionDefinition：申请、O 声明、执行与接收         | ExecutionBinding：接纳、来源捕获接线、本次资源与记录元数据 | Execution → ExecutionInvocationBuilder |
| O    | OperationDefinition：描述、申请、O/A 声明、执行与接收 | OperationBinding：本环境身份、子入口和调用描述接线         | Operation → OperationInvocationBuilder |
| A    | AttemptDefinition：描述、申请、执行与接收             | AttemptBinding：将具体内容接到本环境调用入口               | Attempt → AttemptInvocationBuilder     |

`BindingEnvironment` 持有 Runtime 让渡的 O/A 构造能力，按声明创建对应 Binding 与结构。它不执行 Sequence、不决定业务分支。`ChildBindings` 是工作可见的本次父调用入口，只提供 get/entry，不提供构造器或重新划分调用范围的方法。

```ts
// 服务定义内容，整个声明可绑定到不同 Runtime。
const definition = new ObserverRuntimeDefinition(() => new ApplicationModel());
const observer = new ObserverBinding(runtime, definition);

// ObserverBinding 内：绑定一个声明过的 E，提供每次调用的来源捕获。
const bound = runtime.bind(definition).execution('conversation', {
  validate: (options) => checkEntryEnvironment(options),
  capture: (input, options) => ({
    source: captureObserverSource(input, options),
    record: captureExistingRecordMetadata(options),
  }),
});

// 业务 E/O 内：引用子声明，由本次绑定提供对应入口。
return children.get(childDefinition).call(invocation, childInput);
// 固定顺序也引用同样的声明，组合内部仍负责 input/accept。
return composition.run(invocation, input, children);
```

上面是装配关系示意，实际 Observer 只捕获一次配置与区间并同时用于 source/record，详见 `services/observer/src/observer/binding.ts`。

按声明对象身份查找，不按任意名称兜底。未声明子项在构造调用前拒绝；从某次父调用取得的入口不能用于另一父调用。一个声明在同一父绑定位置复用同一 O/A 结构，不同父绑定或 Runtime 独立创建。Operation 实例 ID 属于结构，不属于声明；每次 Invocation、Context、Record 仍独立。另行调用 RuntimeBinding.execution 会建立新的 E 绑定，不是具名的全局单例缓存。

## 装配与按需初始化

服务先建立轻量 REOA 声明，绑定时检查声明关系和资源供应。声明可以预先建立 A 定义，但并不创建实际 A 结构或调用模型。BoundChildren 为直接子声明保留 Initializer，第一次 get 才建立该绑定位置的结构；未走到的分支保持未初始化。现有 Transcript、Memories 的建立和所有权不变。

Initializer<T> 只管理一次同步建立及缓存：未建立、建立中、成功、失败。递归建立明确失败，异常保留原对象且不自动重试；initialized 只做无副作用观察。没有异步初始化、重置、依赖调度或统一释放。原 BehaviorInitializer、ObserverInitializer 与 ObserverResourceInitializer 已由上述声明/绑定职责替代，不保留生产兼容层。

ResourceOffer 的 binding/access 时机保持不变：配置、历史范围和记忆快照在本次资源绑定时固定；模型及写入接口在首次读取 values 时兑现，向下传递共享本次访问值或错误。模型实体缓存属于 ObserverBinding；传入工厂时不同绑定分别建立，显式传入同一个模型实例则仍共享该实例。定义本身不承诺隔离外部闭包或可变对象；绑定后修改声明不作为动态重配置能力支持。

一次服务调用的顺序是：

```text
Runtime 占用
  → 检查入口归属
  → 接纳新消息
  → 业务声明的分段策略（只取得入口资源）
  → 捕获配置、历史范围与资源来源
  → 建立 E Context / Invocation
  → started → 登记记录 → 执行定义
  → 按需绑定子结构 → 创建子调用 → 父层接收
  → 终态及记录 → 释放占用
```

对话交付回调属于本次资源绑定，E 的回答接收通过 ConversationResource.delivery 发出 answer；ObserverBinding.converse 负责 started/completed。回调不保存到可复用定义，也不进入记录 IO；记录和观测失败仍遵循已有错误边界。

本轮只迁移已有工作与装配职责，不增加动态规划、插件注册、权限、持久化或恢复。前端协议与可视化保持原有行为。声明内部的具体策略、记录正文特化以及更多异步能力的生命周期，仍按后续实际场景继续细化。
