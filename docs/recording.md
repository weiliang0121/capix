# 记录机制与特化处理

RuntimeRecorder 是环境共享的登记入口。它只依赖 RecordBook、Clock 和记录基类；索引只要求 add/remove 接口，不导入 E/O/A、Context、Transcript、Memory 或 RuntimeSnapshot。

## 通用机制

- add(record, indexes?) 先拒绝重复身份，登记显式提供的索引，再写入 Book；失败清理本次新增索引，不发布成功通知。
- update(record, apply) 要求是 Book 中登记的同一实例，再执行特化更新。如何判断终态、复制正文和检查子记录由具体 Record / Helper 决定。
- subscribe 接收 record 与 add/update 分类，同步表达本次登记变化。通知不是历史快照，不承诺持久化或跨进程传输；有这些需求的消费者应另行捕获数据。
- 写入失败统一为 RecordingError。通知发生在登记之后，每个订阅者独立隔离；观察失败不回滚登记，也不阻止其他订阅者。
- Clock 仅作为共享时间来源。调用起点、执行内偏移和事件顺序都属于调用记录特化。

## 调用记录

ExecutionRecordHelper、OperationRecordHelper、AttemptRecordHelper 分别组装本层的 InvocationRecording：begin、process、finish。创建时读取行为实例描述和父调用关系，结束时使用原有子记录检查；Recorder 不做类型分派。

InvocationRecordHelper 复用调用记录共有的 Context 映射、过程格式、结果引用、错误转换和边界事件逻辑。调用级 InvocationRecording 是一组函数接线，没有独立 ID、状态机或执行能力。Invocation 只在调用边界调用这组函数，仍统一处理本地循环、终态与记录异常。

Runtime.invocationRecordIndex 持有 InvocationRecordIndex，内部封装 Context / Operation / Attempt / Event 的关联索引，只提供登记、移除和关联查询。它不创建或结束记录、不持有计时状态。Recorder.add 在写入 Book 前登记索引，写入失败撤销本次关联，通知时关联与记录均已可见。RecordBook 仍是实际记录的唯一存储。

Runtime.recording 持有原有 InvocationRecordHelper 的实例，使用共享 Recorder 与上述索引组织调用记录，私有保存执行计时起点；执行终态边界登记后释放起点。历史索引继续保留，Observer 通过 index.hasExecution 判断归属，不依赖计时表。EventRecordHelper 继续负责事件序号、状态匹配与单调时间检查，不增加独立时序管理器。无 Recorder 时不创建这两个辅助对象。

## 内容记录与来源

Memories 和 Transcript 决定是否允许变化、如何落实及何时记录。MemoryRecordHelper / TranscriptRecordHelper 构造对应记录，集合再交给 Recorder.add。运行事实和记录仍分别存在：登记失败保留已经发生的变化，不虚构回滚。

调用侧通过 InvocationRecordHelper.source 取得已经解析的 ChangeSource：contextId、callId、executionId，以及适用时的 operationId。集合不接收 Context，不查询调用关系；通用 Recorder 同样不负责解析来源。来源是因果说明，不是权限凭据。调用外变化不伪造来源。

## 观察发布

services/observer/src/observer/observe.ts 的 subscribeExecutions 订阅通用变化，再用 ExecutionRecordHelper.snapshot 组织现有 RuntimeSnapshot。仍在 call/return/throw 边界事件和运行中调用过程更新时发布；原始调用创建和终态更新不提前发布缺少边界事件的快照。

消息、记忆变化也会通知通用订阅者，但不伪装成执行快照。当前 Observer 仍通过原有查询接口读取内容，不增加内容增量协议。共享 Recorder 时，订阅投影按各自 Runtime 的调用记录范围筛选。

本次没有新增 Recorder 子类、插件注册、持久化、补偿、重试或自动索引框架。Book 仍只存记录；记录特化没有转移进 Book。
