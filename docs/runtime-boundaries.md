# Runtime、调用和内容变化边界

Runtime 持有持续运行信息：Transcript、Memories，以及消息选择累计观测值。它们跨多次 E 调用存在，不随 ObserverExecution 或 Operation 的重新实例化重置。运行记忆不是用户画像；当前不分短期／长期存储，不实现持久化或恢复。

## 装配与持有

环境初始化一个 RuntimeRecorder 和 RecordBook、索引、Clock，再创建 Runtime 和具体 E/O/A 实例。Runtime 接受 recorder 引用，不创建或关闭记录环境；Transcript、Memories 和每个 Invocation 使用同一个 Recorder。无 Recorder 时，内容与调用仍正常工作。

`new Runtime({ recorder?, messages? })` 创建独立 Transcript 和 Memories。messages 是待接纳的初始原始消息，经过正常 append 并产生内容记录，不是历史快照导入。initializeObserver 同样接受消息数组，不再接受或转移已有 Transcript 实例。环境的 transcript 属性只是 runtime.transcript 的同一引用。

Runtime.run 只负责顶层运行占用：忙时拒绝，不排队；finally 释放。Execution.call 把已有输入交给 submit，submit 在占用之后执行同步接纳函数，再建立 Invocation。HTTP 使用延迟接纳，因此拒绝并发请求时既不追加消息，也不发送成功响应。直接通过不同 E 实例调用同一个 Runtime，同样受约束。

## 调用对象

E/O/A 是可复用行为实例，不保存本次调用的状态。它们各自检查父调用关系，构造 Invocation，不经 Runtime 的 E/O/A 工厂。

Invocation 构造时不建立调用现场、不写记录；run 只允许一次。它保存创建后的 Context 引用，负责开始登记、execute/receive 局部循环、终态和错误登记。循环中的轮数、输入与状态只存放在 InvocationContext，不复制到 Invocation。ExecutionContext、OperationContext、AttemptContext 是调用现场的特化，不是实例生命周期信息容器。

具体 receive 决定分支；通用调用只落实继续或结束，保留一／两轮限制、取消检查、默认接收结果引用。局部循环复用同一 Context 和记录；子调用创建独立 Invocation。Attempt 不再细分运行层级。

调用准备失败不产生虚构的运行记录。开始登记失败不执行工作；过程登记失败终止调用，不自动重试。Context 成功结束后，终态登记失败只传播登记异常，不把已完成的工作改判为失败。工作失败且失败登记再次失败时，AggregateError 同时保留两个错误。Runtime 的占用均会释放。

## 内容的正式变化入口

Transcript.append / appendFrom 审查整批消息后追加；startSegment 检查有效且前进的边界后切段。每次有效变化登记一个 TranscriptRecord，含 Transcript 身份、时间、追加范围与正文或分段边界。消息仍为不可变原文，绝对索引不重排。带调用来源时记录 contextId、callId、executionId；调用外接纳不伪造调用。空追加与非法变化不登记。

Memories 绑定一个 Transcript，提供 get/values/snapshot/apply。apply 检查完整批次的动作、目标、解释、唯一依据、来源存在性与包含关系，才落实内容。无变化更新不登记。模型提案的可见范围与本轮证据约束仍归提取输出契约。当前记忆体对外只读，无 add 或公开 update 旁路；包内更新保留 Memory 实例与 ID，替换冻结正文。

ApplyMemory 只检查现场并提交提案和因果身份，不自行创建 Memory 或补写记录。Memories 在实际变化发生后调用 Recorder。MemoryRecord 保留变化解释和结果正文，关联执行、操作及实际调用；无调用的变更也能记录，不伪造 executionId/operationId。记录链接在 Recorder 中解析，不用记录状态裁决记忆变更是否允许。MemoryRecordHelper 只保留查询职责。

提案返回、提案接纳、内容落实是不同事实：提案与接纳结果在调用 IO 中，已落实变化才进入内容记录。登记错误发生时保留已经改变的内容，不虚构回滚或自动重做。批次预检查失败不部分落实；登记期间失败仍可能留下已经落实的批次前缀，当前不承诺事务。

## 观察与协议

现有 RuntimeSnapshot 仍只包含一次执行的 E/O/A 记录和调用事件。TranscriptRecord 留在同一 RecordBook，未增加传输增量或内容事件订阅。记忆查询继续返回当前内容及变化记录；调用外变化不显示虚假的执行跳转。

Observer 按实际操作角色查询历史，不依赖当前行为实例 ID 来过滤旧执行。OperationRecord 仍保留真实 operationInstanceId。更换行为实例不会丢失历史回答、选择计数或记忆关联。

本轮没有 Thread/TRSA、插件注册、通用上下文容器、调度队列、导入恢复或新重试机制。后续快照与增量设计从消息变化、记忆变化和调用记录变化分别出发。
