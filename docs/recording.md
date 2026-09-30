# 记录机制与特化处理

Recorder 是环境共享的登记入口。它组合 RecordBook、RecordTree、同步登记单元和 Clock。Recorder 本身不分派记录类型，具体关系规则位于 records/tree/relation.ts，不处理 Context、业务正文或 RuntimeSnapshot。

通用基类使用 BaseRecord，树形记录共用 CompositeRecord；只有真正描述 Runtime 范围的类型使用 RuntimeRecord。通用登记入口由 RuntimeRecorder 改名 Recorder，EOA 共用正文由 OperationValue 改名 InvocationValue。RuntimeRecord 当前只保留创建时间与下级引用；不把记录登记、某次调用结束或实例释放等同于整个运行数据范围结束。

## 通用机制

- add(record) 是正式登记入口。RecordRegistration 先通过 RecordTree 检查归属并准备新的 childIds，然后同步写入 Book、替换父级 childIds，全部成功后才通知。登记期间拒绝同一 Recorder 的重入写入。
- 登记失败时恢复原 childIds，并清理本次 Book 写入，包括 Book 写入后抛错的情况。Book/关系的内部恢复不执行用户回调；不保留已无使用者的索引登记或回滚接口。
- update(record, apply, describe?) 要求是 Book 中登记的同一实例，再执行特化更新。如何判断终态、复制正文和检查子记录由具体 Record / Helper 决定。
- subscribe 接收 record、add/update 分类和 related 数组。子记录新增只发布一次 add，related 包含本次同步变更的直接父记录；不另外发布可能触发缺少边界事件快照的父记录 update。通知时记录与父子关系均已可见。原有两参数消费者可继续工作。通知不是历史快照，不承诺持久化或跨进程传输；有这些需求的消费者应另行捕获数据。
- 写入失败统一为 RecordingError。通知发生在登记之后，每个订阅者独立隔离；观察失败不回滚登记，也不阻止其他订阅者。
- Clock 仅作为共享时间来源。调用起点、执行内偏移和事件顺序都属于调用记录特化。

## 直接归属与记录树

BaseRecord.parentId 表达直接产生位置，构造后不可改写；没有调用来源的内容记录保持根记录。CompositeRecord.childIds 是直接下级的冻结 ID 数组，每次成功登记替换数组，已取得的 toJSON/childIds 快照不随之变化。RuntimeRecord 与调用记录均可持有下级，消息与记忆本体的 ID 仍是被描述对象，不作为父级。

- RuntimeRecord 为运行范围的根；执行挂在 Runtime 下；操作挂在执行或父操作下；意图挂在操作下。
- 边界事件挂在被描述的调用下；消息变化、记忆变化依据 ChangeSource.callId 挂在实际产生它们的调用下。
- 现有 executionId、operationId、parentOperationId、callId 等保留，构造时得到 parentId，登记时检查它们与正式关系一致。此次不迁移现有查询及前端投影。
- 新下级调用要求祖先调用仍在运行。终态边界事件在调用结束之后登记；内容来源表示因果，不作为运行授权，保留调用结束后登记带来源内容变化的既有能力。

Recorder.tree 提供 children(id)、descendants(id) 与 root(id)，直接沿 Book 中记录的 childIds 查询，不扫描整个 Book，也不维护第二份节点或边集合。root 沿直接 parentId 查到根并核对下级引用，不维护 Runtime 成员表。后代查询按深度优先返回归属顺序，不能作为事件发生顺序。父级引用写入和关系提交使用包内能力，不对业务公开 attach/reparent 方法。Book.add 仍是底层存储操作，正式业务登记必须经过 Recorder.add。

RecordRegistration 只覆盖一次记录登记，既不包含整个 EOA 调用，也不回滚 Transcript 或 Memories 已经落实的业务变化。没有异步事务、持久化、恢复、重试或补偿体系。

## 调用记录

ExecutionRecordHelper、OperationRecordHelper、AttemptRecordHelper 分别组装本层的 InvocationRecording：begin、process、finish、source。创建时读取行为实例描述和父 Invocation 的记录，结束时使用原有子记录检查；Recorder 不做类型分派。

Invocation 持有本次 Context 和可选 Record 的临时运行关系。begin 创建并登记记录后立即通过 bind 回调交给 Invocation，再登记 call 事件；绑定检查 contextId 一致且只允许一次。process、finish 显式接收这条记录，不再通过 Context ID 反查。即使后续边界事件登记失败，已成功登记的记录引用仍保留。Context 不增加 Record、Invocation 或反向注册表。

InvocationRecordHelper 复用过程格式、结果引用、错误转换和边界事件逻辑，已移除 get(contextId)。调用级 InvocationRecording 是一组函数接线，没有独立 ID、状态机或执行能力。Invocation 仍统一处理本地循环、终态与记录异常。RecordBook 持久持有进程内历史记录；调用对象被释放不删除记录，也不承担历史查询。

InvocationRecordIndex 及其 Context/Operation/Attempt/Event 映射已经移除。通用 RecordIndex 没有其他生产使用者，一并移除。调用绑定由 Invocation 持有，归属查询由 RecordTree 提供；RecordBook 仍是实际记录的唯一存储。正常构造每次建立独立 Context，不为旧索引的重复登记防御另建全局检查。

Runtime.recording 持有原有 InvocationRecordHelper 的实例，持有所属 RuntimeRecord，使用共享 Recorder 组织调用记录，私有保存执行计时起点；执行终态边界登记后释放起点。Observer 通过 tree.root(executionId) 与 RuntimeRecord 的身份比较判断归属，不依赖 Context 索引或计时表。InvocationBoundaryRecordHelper 继续负责事件序号、状态匹配与单调时间检查，不增加独立时序管理器。无 Recorder 时不创建这个辅助对象。

## 内容记录与来源

Memories 和 Transcript 决定是否允许变化、如何落实及何时记录。MemoryRecordHelper / TranscriptRecordHelper 构造对应记录，集合再交给 Recorder.add。运行事实和记录仍分别存在：登记失败保留已经发生的变化，不虚构回滚。

调用侧通过 invocation.source 取得已经解析的 ChangeSource：contextId、callId、executionId，以及适用时的 operationId。内部由 InvocationRecordHelper.source(record) 解释已绑定记录；无 Recorder 时为 undefined，启用记录但尚未绑定时拒绝取得来源。集合不接收 Context 或 Invocation，不查询调用关系；通用 Recorder 同样不负责解析来源。来源是因果说明，不是权限凭据。调用外变化不伪造来源。

## 变化捕获与观察发布

Recorder 正式登记或更新之后，固定 RecordChangeEvent 并交给可选捕获器，然后通知原有同步订阅者。自身 id/revision 表达该登记范围；kind 由记录类声明，Recorder 不按 E/O/A 分派。added 同时描述新记录与父级引用；过程只发送新增条目，finish 只发送终态与结果。通用 update 的 describe 可提供特化变化，省略时使用显式 replaced。没有比较两份快照。

Execution/Operation/Attempt 的 Helper 均通过 Recorder 更新，InvocationRecordHelper 统一过程与终态的描述。实例方法仍维护自身状态约束，正式运行更新不能绕过登记入口。Transcript 和 Memories 自己捕获内容事件，不依赖 Recorder 通知推导业务变化。

services/observer/src/observer/feed.ts 消费共享 ChangeObserver，发送一致基线及后续增量。旧 subscribeExecutions 保留为本地诊断与测试工具，基于同步登记通知组织执行快照；HTTP 观测不再使用它。

RuntimeSnapshot 仍只包含既有 E/O/A 和调用边界正文，是按需查询及本地展示的执行视图，不是整棵记录树。观测基线另带 Runtime 根及活动执行记录，内容记录通过 record 增量传输。parentId/childIds 可以引用未装载的历史正文。对话由 ObserverExecution.converse 独立交付，不从记录生成回答。

没有新增 Recorder 子类、插件注册、持久化、业务补偿或自动索引框架。Book 仍只存记录；记录特化没有转移进 Book。

## 局部顺序与索引迁移进度

Invocation 自行给现有内部过程赋予连续 sequence，传给 InvocationRecording.process；记录不再通过 processes.length 生成序号，只检查是否连续。每次调用从 1 开始，重试不重置，无 Recorder 也推进。此顺序暂不包含新的跨层边界条目。

Memories 持有自身 id 和正式变化 sequence；MemoryRecord 保存 memoriesId/sequence/memoryId，分别表达变化范围、位置和对象。无变化与预检查失败不占号，已落实变化不会因记录失败回收序号。消息继续使用原有绝对 index。均不作为传输游标。

操作、意图的范围查询、父级结束检查、快照中的事件收集均使用 Recorder.tree；事件按执行内 sequence 显式排序。InvocationBoundaryRecordHelper.last 从执行子树中取 sequence 最大的事件，用于下一序号与单调时间检查，不能取遍历末项；登记失败不占用事件序号。它每次遍历执行子树，暂不增加事件游标、缓存或时序管理者。调用索引及其登记接口已退出，见 [观测增量](observation-increments.md)。

## 调用记录与调用边界记录

InvocationRecord 表达一次调用，ExecutionRecord、OperationRecord、AttemptRecord 是三个层级的特化，持续补充内部过程与最终结果。InvocationBoundaryRecord 表达一次 call/return/throw 边界，创建后不可变；InvocationBoundaryRecordHelper 管理原有执行内顺序与时间检查。旧 EventRecord 命名及 records/event 路径已移除。

两者都是运行记录，不是系统变化通知。边界记录的登记产生记录变化事件，但不能为该通知再次自动生成边界记录。RuntimeSnapshot.events 暂保留现有线字段，元素类型已明确为 InvocationBoundaryRecord；这次类型命名调整不改变线上数据形状。
