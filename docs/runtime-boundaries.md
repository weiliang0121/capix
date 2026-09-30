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

Runtime 装配时创建三层 ContextBuilder 和 InvocationBuilder，跨调用复用。ExecutionContextBuilder 只持有 Transcript；OperationContextBuilder 通过 ExecutionContextBuilder 检查本次归属，AttemptContextBuilder 通过 OperationContextBuilder 检查直接父级。ExecutionContext 私有保存构造器身份，不再保存完整 Runtime；手工创建、未绑定构造器的 Context 仍保留原有直接使用方式，这不是权限或成员资格体系。O/A 的父级引用本轮保留，具体工作的信息投影及按需能力声明尚未全面迁移。

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

ApplyMemory 只检查现场并提交提案和因果身份，不自行创建 Memory 或补写记录。Memories 在实际变化发生后调用 Recorder。MemoryRecord 保留变化解释和结果正文，关联执行、操作及实际调用；无调用的变更也能记录，不伪造 executionId/operationId。记录链接在调用侧从 invocation.source 取得，由记录接线解释本次绑定记录，再传递给内容对象；不用记录状态裁决记忆变更是否允许。MemoryRecordHelper 构造记录并提供查询，Memories 通过通用 Recorder.add 登记。

提案返回、提案接纳、内容落实是不同事实：提案与接纳结果在调用 IO 中，已落实变化才进入内容记录。登记错误发生时保留已经改变的内容，不虚构回滚或自动重做。批次预检查失败不部分落实；登记期间失败仍可能留下已经落实的批次前缀，当前不承诺事务。

## 观察与协议

现有 RuntimeSnapshot 仍只包含一次执行的 E/O/A 记录和调用事件。TranscriptRecord 留在同一 RecordBook，未增加传输增量或内容事件订阅。记忆查询继续返回当前内容及变化记录；调用外变化不显示虚假的执行跳转。

Observer 按实际操作角色查询历史，不依赖当前行为实例 ID 来过滤旧执行。OperationRecord 仍保留真实 operationInstanceId。更换行为实例不会丢失历史回答、选择计数或记忆关联。

本轮没有 Thread/TRSA、插件注册、通用上下文容器、调度队列、导入恢复或新重试机制。后续快照与增量设计从消息变化、记忆变化和调用记录变化分别出发。

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
