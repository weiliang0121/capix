# 变化捕获与观测增量

当前已经接通生产、捕获、发送、接收和应用绑定。观测不以重复完整执行快照作为实时消息；初次加载或重新同步使用基线，后续直接发送生产者明确声明的变化。不在 service 比较两份快照，也不从运行记录反推所有业务变化。声明和可选观测安装见 [运行中的观测边界](runtime-boundaries.md#观测失败与已成立事实)。

## 生产者与出口

| 来源       | 正式变化                                   | 局部顺序                                | 记录关系                                                |
| ---------- | ------------------------------------------ | --------------------------------------- | ------------------------------------------------------- |
| Transcript | 新消息批次、段边界                         | transcriptId + revision；index 定位消息 | TranscriptRecord 使用同一 revision                      |
| Memories   | 创建、更新及完整结果                       | memoriesId + sequence                   | MemoryRecord 使用同一 sequence                          |
| Invocation | 开始、内部进度、子关系、入口阶段、结束     | contextId + sequence                    | 调用记录用 contextId 关联；过程和关系保留 eventSequence |
| Recorder   | 新登记、过程追加、关系追加、终态、显式替换 | recorderId + revision                   | 捕获记录自身的正式变化                                  |

内容来源先校验并固定事件正文，落实状态后独立发布变化与可选观测事实。内容和调用进度不依赖 Recorder；记录安装消费明确事实，不能截获私有运行结构来反推。捕获失败保留已落实事实并交付错误；观测默认 isolate，显式 propagate 才传播到运行出口。两种策略都不能抹去内容变化或让已发生工作重做。整个业务流程并非事务。

一次记录登记包含新记录及父级新增 childId；RecordRegistration 只保证 Book 与直接关系的同步登记。InvocationRecord 逐步补齐一次调用，InvocationBoundaryRecord 只表达整个调用进入、返回或抛错。它们登记后都可以产生 RecordChangeEvent，不能将变化通知再次自动登记成调用边界。

ResourceRecord 描述本次调用实际绑定、取得或调用资源的事实，直接归属于相应 R/E/O/A 调用记录，也通过 Recorder 的变化出口交付。内容实体仍自己产生 TranscriptEvent / MemoryEvent；资源访问记录不能替代内容变化事件。内容事件可保留 origin.contextId，无 Recorder 时也有运行来源。

## 单一排空与独立交付

```text
Transcript ── TranscriptEvent ─┐
Memories ──── MemoryEvent ─────┤
Invocation ── InvocationEvent ├→ ChangeBuffer<ObserverChange>
Recorder ──── RecordChangeEvent┘        │ wait / take
                                       ↓
                                 ChangeConsumer
                                    ├─ RecordSource ─────┐
                                    ├─ 非记录变化 ────────┴→ ObservationFeed → ObservationReplica
                                    └─ TranscriptFeed ─────→ TranscriptReplica
                                                                  │
                               binding 组合记录定位符与实体正文 → Store → UI
```

各来源只持有 ChangeCapture<自己的事件>。共享 ChangeBuffer 只保留捕获顺序；capture 不调用消费者，wait 唤醒异步消费，take 转移当前批次。一个环境只有一个 ChangeConsumer 排空捕获器，RecordSource、消息同步与连接交付订阅其结果，不争抢缓冲。没有记录订阅时，消息实体仍正常同步；创建或关闭 HTTP 连接不创建或销毁来源。

Service 的 ObservationSource / SourceReceiver 约定一致打开与来源失效，bindDelivery 负责消费侧的排队、基线和增量投影、发送及连接解除。RecordSource 履行记录来源约定，ObservationFeed 提供 Observer 的投影与附加来源订阅；源回调只入队，不在生产者调用栈上写网络。该辅助位于服务层，不把 HTTP 或消费者生命周期移入运行内核。

ChangeConsumer 的 position 仅用于同步打开时的本地交接水位，不是来源版本或网络游标。重入打开时先吸收已有变化，基线覆盖的旧批次不会在新订阅中再交付；RecordSource 和 TranscriptFeed 也分别以自身 revision 排除已覆盖的变化。批次是消费边界，不是跨源事务。

消息实体通道交付原文与 revision；观测通道只交付 transcriptId、消息索引/计数和追加范围，不附带整份消息正文。两类客户端订阅互相独立。受控消息接口仅开放服务显式安装的 Transcript，UID 不等于任意实体访问权限。

## 基线与交付位置

环境先创建 ChangeConsumer 和长期 RecordSource，再安装记录观测并创建内容实体、运行结构。记录安装通过 invalidate 端口告知来源失效，该职责不挂到 Recorder。RecordSource.open({ change, incomplete }) 同步排空已有捕获，固定 sourceId、revision 和不可变记录基线，再登记接收器，返回可关闭的订阅；建立基线和订阅之间没有 await。

每次 ObservationFeed.connect 创建自己的 scopeId，首帧 sequence 为 0，后续每个非空变化批次递增。来源 revision 跨连接连续，连接重建不会重置来源，也不复用旧交付范围。发送者不是通过多次异步查询拼凑基线。

基线包含完整消息索引与执行简介、当前记忆及已有记忆记录、各来源水位、记录安装根、活动 R 调用的局部子树和活动调用进度。E 已结束而 R 正在接纳时，该 E 子树仍包含在内。其他已完成执行的详细 IO 与过程不预取，通过详情接口按需加载。根 childIds 可以引用尚未加载的记录，不代表关系丢失。

启用对话持久化后，基线另含历史记录来源 archives，执行简介与详情附带其来源状态。只有当前安装根下的 running 记录进入活动子树；旧 running 是未结束的观测前缀，不是当前运行。历史来源完整性与当前来源分别表达，不通过重启清除历史缺口。存储保存最新记录正文及确定性变更位置，不提供旧交付游标重放，见 [持久化](persistence.md)。

后续 delta 只包含新事实。process-appended 和 relation-appended 分别发送新增过程与关系；终态发送结果或 resultOf；新记录与父级引用一起发送。Recorder.update 未给出特化描述时发送该记录的显式 replaced，正常调用过程使用特化增量。服务不解析动态业务正文来猜测变化。

## 来源不完整与连接失败

记录安装发生遗漏时同步调用 invalidate，RecordSource 永久进入 SOURCE_INCOMPLETE。接收器只收到一次失效通知，立即停止接纳普通记录变化；交付层丢弃未发送批次，连接可写时发送控制错误并结束。已经交给网络的字节不能撤回。失效后新 open 和 executions/execution/memory 查询明确失败，不能把带有缺失的现有 Book 包装成健康基线。

这一状态独立于单次连接。编码、断线和单连接消费者错误关闭相应消费者，不反向污染来源。消息集合基线和增量仍由独立 TranscriptFeed 发送；记录失效不停止消息同步。Observer 当前使用默认 isolate 记录安装，记录观测失败不否认已经成立的业务事实。

每个 HTTP 连接以 16 MiB 限制待发数据和流缓冲总量，过慢的连接断开。捕获器不留已取走历史，交付序号不表示客户端已确认。当前没有持久化日志、ACK、任意游标重放或多 Runtime 路由。

## 接收与展示

客户端首帧必须是基线；之后检查 scopeId 与交付 sequence，重复交付忽略，缺口拒绝。每个来源检查自己的顺序；在新结构中完成整批变更后才替换已接纳状态，失败不暴露半条父子关系。

调用过程和关系历史分开追加，以同调用 eventSequence 对照先后。子层 returned 不等于父层 accepted，failed.source 区分接纳工作与观测故障。入口阶段元数据可由父调用描述尚未建立 E 的 accept/notification/admit/capture 结果，不凭空创建一个失败 QA。R 详情沿独立 runtimeEvents 计时；图谱仍以 E 为 QA，不把 R 计入轮数。

记录状态更新与边界登记是两个事实。接收端保留暂未齐备的原始条目，边界齐备后才生成通过 validateExecutionRecordSnapshot 的本地执行视图。ConversationSubmissionSnapshot 交付本次提交的累计事实与完整性，result 在 R.run 实际返回/抛错后产生；TranscriptReplica 保存独立查询/订阅所得的权威消息。二者通过正式位置关联，不要求回答紧邻输入，不重复追加，也不要求提交反馈结束时实体已经追赶完成。

顺序异常最多自动重建一次基线；连续异常停止并提示。SOURCE_INCOMPLETE 直接终止观测，不自动重连，显式重连同一失效来源也不能修复。普通断线不无限重连，可显式刷新健康来源。旧连接回调、旧详情响应不得覆盖新范围。binding 负责组织轮次、来源、父层接纳和记忆关联，UI 几何与选择状态不进入 Runtime。

## 调用索引退出后的归属

| 用途                                 | 当前归属                                                                  |
| ------------------------------------ | ------------------------------------------------------------------------- |
| 执行下操作、操作下意图及活动下级查询 | RecordTree 的后代/直接子级查询                                            |
| E 快照及父 R 详情                    | ExecutionRecordHelper 从树收集；R 与 E 边界各按 scopeId/sequence 排序     |
| Context 与调用记录绑定               | 记录安装的本次 InvocationRecording 持有记录句柄，通过其父预设关系建立归属 |
| Context 重复登记                     | 正常构造创建独立 Context；不另建全局 Context 索引                         |
| 共享 Recorder 中 Runtime 的记录归属  | RecordingInstallation.root + RecordTree                                   |
| 下一条边界序号及单调时间检查         | InvocationBoundaryRecordHelper 按实际计时范围查询                         |

InvocationRecordIndex、旧 Runtime 索引持有字段和 RecordIndex 均已退出。调用对象不因记录查询而持有 Recorder；记录关系与局部查询留在记录安装及树中。边界查询不预设交付游标，Transcript 变化也不复用调用边界记录。
