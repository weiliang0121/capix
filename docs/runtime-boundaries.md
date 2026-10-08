# Runtime、调用和内容变化边界

Runtime 通过 RuntimeContext 持有持续运行信息：Transcript、Memories，以及消息选择累计观测值。它们跨多次 E 调用存在，不随 ObserverExecution 或 Operation 的重新实例化重置。运行记忆不是用户画像；当前不分短期／长期存储，不实现持久化或恢复。

## 装配与持有

环境初始化一个 Recorder 和 RecordBook、Clock，再通过 createRuntime 建立新的数据范围并装配具体 E/O/A 实例。Runtime 接受已建立的 RuntimeContext 与可选的 recorder/record 配对，不创建或关闭 Recorder；Transcript、Memories 和 Invocation 的记录接线使用同一个 Recorder。无 Recorder 时，内容与调用仍正常工作。

`createRuntime({ recorder?, messages? })` 创建独立 Transcript、Memories 与 SelectionUsage，组成 RuntimeContext；开启记录时登记一条 RuntimeRecord，再构造 Runtime。messages 是待接纳的初始原始消息，经过正常 append 并产生内容记录，不是历史快照导入。initializeObserver 同样接受消息数组，不再接受或转移已有 Transcript 实例。环境的 transcript 属性只是 runtime.context.transcript 的同一引用。

`new Runtime(context, { recording: { recorder, record }, changes })` 只接管显式传入的现场和已登记记录，不清空内容或创建新记录；这不是持久化恢复入口，也不提供多个活动实例共享同一现场时的协调。实例存活、数据范围持续和记录保留分别理解，构造与销毁实例不隐含数据范围的建立或结束。

RuntimeRecord 继承 CompositeRecord，正文目前只有 createdAt，通过 childIds 关联其下的执行记录。它没有调用 IO、processes 或 running/succeeded/failed；某个 E 完成不会结束 R。RuntimeContext 保留内容对象引用，RuntimeRecord 不复制消息或记忆正文。此次不增加 Context ID、持久化、恢复、暂停或完成状态机。

Runtime.run 只负责顶层运行占用：忙时拒绝，不排队；finally 释放。Execution.call 把已有输入交给 submit，委托 ExecutionInvocationBuilder 在占用之后执行同步接纳函数，再建立 Context 和 Invocation。HTTP 使用延迟接纳，因此拒绝并发请求时既不追加消息，也不发送成功响应。直接通过不同 E 实例调用同一个 Runtime，同样受约束。

## 调用对象

E/O/A 是可复用行为实例，不保存本次调用状态，也不持有 Runtime。构造时分别注入 ExecutionInvocationBuilder、OperationInvocationBuilder、AttemptInvocationBuilder，call 仅交付输入、父 Invocation 及 execute/receive 工作行为。具体 Observer 仍显式持有其业务需要的 Runtime，不能将这一轮误解为全部业务能力注入已经完成。

Runtime 装配时创建三层 ContextBuilder 和 InvocationBuilder，跨调用复用。ExecutionContextBuilder 只持有 Transcript；OperationContextBuilder 通过 ExecutionContextBuilder 检查本次归属，AttemptContextBuilder 通过 OperationContextBuilder 检查直接父级。ExecutionContext 私有保存构造器身份，不再保存完整 Runtime；手工创建、未绑定构造器的 Context 仍保留原有直接使用方式，这不是权限或成员资格体系。O/A 私有持有直接父级，用于归属和活动检查，不公开父 Context 取数入口；业务资源从本层 resources 取得。模型 Provider 与记忆写入也通过正式申请交付。

各 InvocationBuilder 接受对应上下文构造器和所需记录能力；E 另接受 Runtime 让渡的 run 函数，先占用再接纳。构造器不保存本次输入、Context 或 signal。顶层每次创建或接收信号，O/A Context 绑定同一信号引用；取消改变信号状态，下次调用的新信号不覆盖旧 Context。构造器不通过方法分派 E/O/A，不引入无实际公共实现的构造器基类。

Observer 的容量判断和切段策略留在 ObserverExecution.submit 的接纳回调中，仍在占用内、Context 固定范围前运行；核心 Execution 不再提供通用 prepare 钩子。请求组装、模型调用、契约接纳、记忆落实仍是工作本身。

对应入口：

| 工作入口                | 调用构造器                 | 上下文构造器            |
| ----------------------- | -------------------------- | ----------------------- |
| Execution.call / submit | ExecutionInvocationBuilder | ExecutionContextBuilder |
| Operation.call          | OperationInvocationBuilder | OperationContextBuilder |
| Attempt.call            | AttemptInvocationBuilder   | AttemptContextBuilder   |

Invocation 接收已经建立的 Context、工作、信号、记录接线和可选入口检查，采用具名参数；构造时不写调用记录。run 只允许一次，并在开始登记前重新检查父级是否仍有效，避免建立后延迟运行穿过已结束的父级。它负责开始登记、execute/receive 局部循环、终态和错误登记。循环中的轮数、输入与状态只存放在 InvocationContext，不复制到 Invocation。ExecutionContext、OperationContext、AttemptContext 是调用现场的特化，不是实例生命周期信息容器。

E/O/A 继承 InvocationBehavior，共享 execute 声明、可选 receive 声明、默认 maxRounds 和 work 绑定。work 在建立本次调用时生成，绑定当前实例并捕获轮次约束；不缓存本次 Context，也不额外创建行为实体。默认接收仅存在于公共调用循环：未声明 receive 时复用执行结果记录，声明后独立保存接收结果，不检查原型方法身份。

具体 receive 决定分支；通用调用只落实继续或结束，保留一／两轮限制、取消检查、默认接收结果引用。局部循环复用同一 Context 和记录；子调用创建独立 Invocation。Attempt 不再细分运行层级。

execute(context, invocation) 与 receive(context, result, invocation) 显式取得本次调用；只使用现场的叶子逻辑可省略 Invocation 参数。Operation.call(parent, input) 接受 E 或 O 的 Invocation，Attempt.call(parent, input) 只接受 O 的 Invocation。嵌套操作直接传父操作调用，不再同时传根 Context 和父 Context。InvocationBuilder 将 parent.context 交给 ContextBuilder 检查和构造，将 parent 交给记录接线读取绑定记录；没有 Context → Invocation 的全局反查表。

Invocation.record 在登记前为空，登记后固定指向本次调用记录；可选 started(context, invocation) 回调发生在登记之前，供调用方捕获调用对象，不保证此时已有记录。回调类型统一为 InvocationStarted，执行入口使用 ExecutionStarted 特化；它是同步接线，在调用有效性检查之后、登记之前执行。回调抛错保持原异常，停止登记与工作并释放顶层占用，不包装成 RecordingError。记录启用时，子调用开始登记要求父调用已登记。原有 Context 活动与 Runtime 归属检查仍保留；未记录的调用不需要伪造记录。

调用建立失败不产生虚构的运行记录。Context 仍沿用原有 running 状态，progress.round=0 表示尚未进入工作；本轮不新增生命周期状态。开始登记失败不执行工作；过程登记失败终止调用，不自动重试。Context 成功结束后，终态登记失败只传播登记异常，不把已完成的工作改判为失败。工作失败且失败登记再次失败时，AggregateError 同时保留两个错误。Runtime 的占用均会释放。

## 内容的正式变化入口

Transcript.append / appendFrom 审查整批消息后追加；startSegment 检查有效且前进的边界后切段。每次有效变化登记一个 TranscriptRecord，含 Transcript 身份、时间、追加范围与正文或分段边界。消息仍为不可变原文，绝对索引不重排。带调用来源时记录 contextId、callId、executionId；调用外接纳不伪造调用。空追加与非法变化不登记。

Memories 绑定一个 Transcript，提供 get/values/snapshot/apply。apply 检查完整批次的动作、目标、解释、唯一依据、来源存在性与包含关系，才落实内容。无变化更新不登记。模型提案的可见范围与本轮证据约束仍归提取输出契约。当前记忆体对外只读，无 add 或公开 update 旁路；包内更新保留 Memory 实例与 ID，替换冻结正文。

ApplyMemory 通过申请到的写入接口提交提案和因果身份，现场活动检查统一由调用机制执行，不自行创建 Memory 或补写记录。Memories 在实际变化发生后调用 Recorder。MemoryRecord 保留变化解释和结果正文，关联执行、操作及实际调用；无调用的变更也能记录，不伪造 executionId/operationId。记录链接在调用侧从 invocation.source 取得，由记录接线解释本次绑定记录，再传递给内容对象；不用记录状态裁决记忆变更是否允许。MemoryRecordHelper 构造记录并提供查询，Memories 通过通用 Recorder.add 登记。

提案返回、提案接纳、内容落实是不同事实：提案与接纳结果在调用 IO 中，已落实变化才进入内容记录。登记错误发生时保留已经改变的内容，不虚构回滚或自动重做。批次预检查失败不部分落实；登记期间失败仍可能留下已经落实的批次前缀，当前不承诺事务。

## 观察与协议

现有 RuntimeSnapshot 仍只包含一次执行的 E/O/A 记录和调用事件。TranscriptRecord 留在同一 RecordBook，未增加传输增量或内容事件订阅。记忆查询继续返回当前内容及变化记录；调用外变化不显示虚假的执行跳转。

Observer 按实际操作角色查询历史，不依赖当前行为实例 ID 来过滤旧执行。OperationRecord 仍保留真实 operationInstanceId。更换行为实例不会丢失历史回答、选择计数或记忆关联。

本轮没有 Thread/TRSA、插件注册、通用上下文容器、调度队列、导入恢复或通用重试机制。后续快照与增量设计从消息变化、记忆变化和调用记录变化分别出发。

记录机制的进一步分离见 [记录边界](recording.md)。

## 入口参数与变化出口

入口按所处边界分类，不按统一参数数量改写：

- Runtime(context, options)、Memories(transcript, options)、Recorder(book, options)：必需主体独立，可选稳定能力具名装配。Recorder 的 clock 是记录时间来源，记录 Helper 不再另传一份 Clock。
- 三层 InvocationBuilder(contexts, capabilities)：上下文构造者与稳定调用能力分开；E 额外要求 run 占用入口，O/A 不获得它。
- ExecutionInvocationBuilder.create(input, request) / submit(accept, request)：输入或接纳函数独立，request 分别声明 context、work、started。配置与信号属于当次 context 参数，Builder 不保存当前信号。
- Operation/AttemptInvocationBuilder.create(parent, request)：直接父调用独立，request 包含 input、description、work。普通 Operation/Attempt.call(parent, input) 保持简短，不穿透传递记录或观测能力。
- 记录构造保留 definition 与 value 的区分；definition 集中身份、局部位置及来源。Record Helper 的机制依赖（Recorder 或 Clock）放在独立参数中。
- cycle(invocation, work, options)：调用对象、工作行为、循环控制与过程出口分开；Context 从 invocation 取得。onProcess 表达过程发生，不将循环与 Recorder 绑定。

InvocationChangeEmitter 每次调用独立创建，保存固定身份和本地事件序号；负责时间戳及不可变事件正文，向装配好的 ChangeCapture 发布。Invocation 仍明确控制开始、过程与结束处的发布及登记顺序，并处理失败；没有通用插件列表或隐式生命周期分派。捕获失败不回滚事实、不自动重做，记录绑定仍属于 Invocation。

## 直接子调用与顺序组合

父层对直接子调用的感知属于运行机制，不由 RecordTree 反向推导。Operation/Attempt 新增 create(parent,input,{key?})，对应 Builder 在创建 Invocation 时挂到 parent.children；call 保持 create 后 run。E→O、O→O、O→A 沿用原有 ContextBuilder 的层级与归属检查。A 不增加子执行层。

每个父 Invocation 独立持有 InvocationChildren，集合中的 InvocationRelation 表达父子调用关系，不是新的调用实体，也不限定 E/O/A。关系关联实际子 Invocation、创建时父层 round、可选工作位置 key。父层能在子运行前看到它，运行状态读取子 Context，不复制另一份状态机。子 run 返回或抛错后保存 returned；父层接收以 pending → receiving → accepted(output) / failed(error) 单独表达。直接 call 没有声明父层接收动作，reception 保持 pending。调用结束后的登记异常可能使 Context 已成功而 returned 失败，这是不同边界的事实，不将它们合并。关系不进入可复用行为实例，也没有全局子调用索引。

Sequence 是不可变的顺序组合定义。每个 step 有工作位置 key、use 子能力、input 构造与可选 accept。输入输出契约沿用子能力的 TypeScript 类型和已有业务接纳；只允许读取前项已接收的输出。accept 可返回父层接收后的值，后项使用这个值；子层原始结果仍由对应子调用保存。Sequence 不创建第四层 Context/Record。每次 run 只建立本次输出容器，父层持续持有实际子调用及接收结果；同一能力可用于不同位置，同一组合可跨调用复用。

Observer 的选择计数、回答追加与交付属于父层接收，不隐藏在 input 构造中。三个操作内部也显式组合请求准备、模型调用、输出接纳等 A。契约失败后仍可从本次操作的直接子调用读取模型原始返回，无须查询记录；记忆失败仍保留生成子调用、父层已接收的回答及正式消息。

第一版只按声明顺序运行，等待父层接收结束再创建下一项。输入准备失败不创建子调用；子调用或父层接收失败立即抛出，尚未运行的项仍只是定义，不补造调用。没有重试、恢复、取消补偿、并行或父层自动等待所有手工子调用等策略。运行关系暂不新增观测通知或线协议字段；现有记录与前端行为保持原边界。

## 完整模型返回被拒绝后的有限再次生成

这一轮只启用 GenerateAnswer：第一次完整模型返回因 INVALID_JSON、EMPTY_OUTPUT 或 OUTPUT_SHAPE 被 AcceptModelOutput 拒绝时，父操作可以再生成一次。筛选与记忆提取仍为一次。网络失败、超时、取消、非 stop 返回、记录/变化捕获失败，以及消息或记忆落实后的失败，不属于该声明。

声明与决定分开：InvokeModel.regeneration 暴露适用条件、最多一次追加调用、allows 与 create。GenerateAnswer.receive 检查失败是否来自本轮实际接纳子调用，再决定 continueWith；能力 create 重新检查直接归属、完成状态、原始结果与拒绝的关联、剩余次数，以及请求是否完整保留原请求和对应反馈。父层可以拒绝继续；选择继续不能通过该入口跳过条件。这是服务内明确的协作约定，不是阻止任意代码直接再次调用普通 create 的权限体系。

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
TranscriptResource.fixedRange.provide((source: ExecutionResourceSource) => source.transcriptRange!);

// 工作：使用正式交付的接口。
context.resources.values.history.read(index);
```

核心机制在 `resource/offer.ts` 与 `resource/bindings.ts`：

- ResourceOffer 由资源所属模块定义，固定诊断名称、来源类型以及来源到访问接口的实现。request 生成正式申请，provide 把本次来源供应函数接入该项目；供应方不能另写返回接口的语义。
- ResourceRequest 引用公布项目的身份。名字只用于说明和错误，不作为匹配键；临时定义一个同名项目不能满足原项目申请。能力不能用 `access: 'read'` 给任意实体自行赋予访问能力。
- ResourceBindings 持有本次可供应项目与访问入口。对子层 select 根据项目身份匹配，允许不同别名引用同一项目；只交付子层声明的部分，不从祖先补齐。values 的属性读取才兑现 access 类项目，父子及别名共用同一次兑现结果或错误。
- Sequence.requests 收集实际 use 的全部申请，不按别名合并。两个子能力的同名别名指向不同项目时都必须检查，不能互相覆盖。steps 保留实际组合引用，不另维护依赖图。

各层固定组合建立时，通过轻量声明检查本层申请能否覆盖直接子组合，不需要先构造子行为；O 自身第一次建立时检查其 A 组合，回答首次和再次生成分支都参与。资源装配检查每个申请是否恰好有一个供应者。未建立的深层组合不提前遍历实例化，也不建立第二份依赖图。装配检查不执行来源供应函数，不读取本次消息，也不调用模型。

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

ExecutionContext 的 settings 和 transcriptRange 不再是公开字段。构造时捕获的配置与原始区间，作为 ExecutionResourceSource 交给绑定函数，并通过包内 WeakMap 留给 ExecutionRecordHelper 固化记录；不从工作 Context 暴露原实体，也不建立祖先身份索引。ModelSettingsResource 和 ModelResource 属于 Observer 模型模块；通用资源机制不认识配置或模型。取消信号仍沿现有 Context 机制传递。

服务的 ObserverResourceInitializer 是来源装配入口，接收 RuntimeContext 和模型工厂；模型实例由环境内的 Initializer 首次使用时建立并复用，不把原实体或 Provider 直接放入业务 Context。ObserverExecution 申请自身使用及需要传给子组合的资源；selection/generation/extraction 再按各自声明收窄；ApplyMemory 只有 memoryWriter，InvokeModel 只有 model/settings/timeoutMs。实例仍持有调用构造器与固定业务定义，不保存本次资源值。

分段准备与执行工作分开：entry 申请配置、记忆快照和分段访问，完成当前容量策略后才建立 E Context、固定执行区间。E 工作持有消息追加、选择统计等必要接口；记忆变更由 A 提交。输入消息接纳仍属于服务入口，不伪装成 E 内部工作。

O/A 的直接父级改为私有引用，公开 requireActive/belongsTo 只回答运行有效性与构造归属，不返回祖先 Context；Runtime 的 getExecutionContext/getOperationContext 移除。调用机制在开始、每轮执行前、接收前重查父层活动状态，覆盖异步等待期间父级结束的情况；校验不是取消已发出的外部请求，也不回滚已经落实的变更。

原资源的所有权、释放、变更校验、变化事件与记录职责保持原位。资源接口不再生成一份通知或记录。服务装配、HTTP 输入接纳、观测查询和记录 Helper 仍按自身职责访问原实体；它们不是业务工作绕过声明的入口。本轮不新增 Scope、权限系统、动态资源注册或通用生命周期框架，正式申请也不提供对任意第三方代码的执行隔离。

输入组织仍属于原有组合与业务能力。AcceptModelOutput 显式接收 output 及按需的 basis，不从父操作输入强转；请求构造、容量检查和模型输出接纳仍在对应工作中执行。

## 装配与按需初始化

ObserverInitializer 由服务环境建立，持有 O 的 BehaviorInitializer 与资源初始化对象；E 接收轻量组合成员和绑定函数，不再自行 new 三个 O。O 在自己的组合边界建立 A 的 BehaviorInitializer，直到组合实际走到某个步骤才取得行为实例。每个初始化对象的缓存属于创建它的装配位置，不是进程全局，也不是按名称查询的注册中心。当前 E 作为服务必需入口仍在环境建立时取得；Transcript、Memories 等已有运行实体仍按原环境流程建立。

Initializer<T> 仅管理一次同步建立：未建立、建立中、成功、失败。get 首次执行工厂，后续复用结果；递归建立明确失败，工厂异常保留原对象且不自动重试。initialized 只用于无副作用地查看是否已有成功实例。没有异步初始化、重置、依赖调度或统一释放系统；若需在初始化失败后重新装配，应由外部明确建立新的所属初始化对象。

BehaviorInitializer 保留轻量 requires 和具体 create 签名，不改变输入输出及父调用类型。get 建立行为后检查实际资源需求被声明覆盖；不匹配时不挂接子 Invocation，错误也保留。实际工作仍由原 E/O/A 和 Invocation 执行，初始化对象不持有本次 Context、结果或记录。行为的静态 requires 与实例 requires 共用声明；参数化能力在具体组合处提供声明，不建立能力 Schema 平台。固定顺序仍由 Sequence 表达，输入构造及结果接纳不变。

资源的捕获时机由 ResourceOffer 公布：

- binding：本次绑定时固定值。配置 snapshot/timeout、历史 fixedRange 和记忆 snapshot 采用此规则，即便稍后才使用也不会读取更晚的数据。
- access：第一次读取本次 values 属性时建立访问接口并缓存。模型调用、消息追加、记忆写入、选择统计及分段访问采用此规则；选择或向下传递申请本身不触发初始化。

这两种时机不决定原实体的生命周期。模型实例由 ObserverResourceInitializer 在环境中复用；每次 ResourceBindings 中的访问对象和错误缓存只属于本次绑定，向子层传递时共享它们。分段访问的 current 是显式读取当前值的方法，语义与 fixedRange 不同。

分段容量预检查复用 selectionCapacity 纯函数与同一提示/Schema，无须为预检查提前创建选择 O 或模型 A。再次生成请求准备只在实际进入第二轮时初始化；正常回答不创建这一分支的行为实例。

本轮仍保留 ExecutionOptions 中的配置入口，以及 E 构造与记录共用的 ExecutionResourceSource。它们的业务特化尚待后续小闭环处理；本轮验证初始化职责，不同时重做记录契约、资源所有权、动态装配或权限。
