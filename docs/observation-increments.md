# 变化捕获与观测增量

当前已经接通生产、捕获、发送、接收和应用绑定。观测不再以重复完整执行快照作为实时消息；初次加载或重新同步使用基线，后续直接发送生产者明确声明的变化。不在 service 比较两份快照，也不从运行记录反推所有业务变化。

## 生产者与出口

| 来源       | 正式变化                         | 局部顺序                                | 记录关系                                            |
| ---------- | -------------------------------- | --------------------------------------- | --------------------------------------------------- |
| Transcript | 新消息批次、段边界               | transcriptId + revision；index 定位消息 | TranscriptRecord 使用同一 revision                  |
| Memories   | 创建、更新及完整结果             | memoriesId + sequence                   | MemoryRecord 使用同一 sequence                      |
| Invocation | 开始、内部进度、结束             | contextId + sequence                    | 调用记录用 contextId 关联；进度保留 processSequence |
| Recorder   | 新登记、过程追加、终态、显式替换 | recorderId + revision                   | 捕获记录自身的正式变化                              |

内容来源先校验并固定事件正文，落实状态后同步捕获，再按需登记运行记录。内容和调用进度不依赖 Recorder。捕获失败保留已落实事实并停止当前调用重做；记录失败不能抹去已捕获的内容变化。整个业务流程并非事务。

一次记录登记包含新记录及父级新增 childId；RecordRegistration 仍只保证 Book 与直接关系的同步登记。InvocationRecord 逐步补齐一次调用，InvocationBoundaryRecord 只表达进入、返回或抛错。两者登记后都可以产生 RecordChangeEvent，不能将变化通知再次自动登记成调用边界。

## 共享捕获与发送

```text
Transcript ── TranscriptEvent ─┐
Memories ──── MemoryEvent ─────┤
Invocation ── InvocationEvent ├→ ChangeObserver<RuntimeChange>
Recorder ──── RecordChangeEvent┘        │ wait / take
                                      ↓
                               ObservationFeed
                                      │ baseline / delta
                                      ↓
                              ObservationReplica
                                      │ 本地事实
                                      ↓
                              binding → Store → UI
```

各来源只持有 ChangeCapture<自己的事件>。共享 ChangeObserver 只保留捕获顺序；capture 不调用消费者，wait 唤醒异步消费，take 转移当前批次。一个环境由一个 ObservationFeed 消费，向多个订阅者交付。批次是消费边界，不是跨源事务；局部顺序不是网络游标。

## 基线与交付位置

ObservationFeed 为本次发送范围生成 scopeId，每个非空变化批次递增 sequence。connect 同步取走已有变化，再固定基线并登记订阅，中间没有 await；因此后续增量从基线位置继续。

基线包含完整消息索引与执行简介、当前记忆及已有记忆记录、各来源游标、Runtime 根记录、活动执行记录和活动调用进度。已完成执行的详细 IO 与过程不预取，仍通过详情接口按需加载。根 childIds 可以引用尚未加载的记录，不代表关系丢失。

后续 delta 仅包含新事实。调用过程追加只发送新条目，终态发送结果或 resultOf，新记录与父级引用一起发送。通用 Recorder.update 未给出特化描述时发送该记录的显式 replaced，正常调用过程使用特化增量。服务不解析动态业务正文来猜测变化。

每个 HTTP 连接以 16 MiB 限制待发数据和流缓冲总量，过慢的连接断开；消费者异常不回写业务。捕获器不留已取走历史，交付序号不表示客户端已确认。当前没有持久化日志、ACK、任意游标重放或多 Runtime 路由。

## 接收与展示

客户端首帧必须是基线；之后检查 scopeId 与交付 sequence，重复交付忽略，缺口拒绝。每个来源也检查自己的顺序；在新结构中完成整批变更后才替换已接纳状态，失败不暴露半条父子关系。

调用记录的状态更新与边界登记是两个事实，接收端保留暂未齐备的原始条目，边界齐备后才生成通过 validateSnapshot 的本地执行视图。业务对话仍只由独立 ConversationUpdate 和消息查询驱动，观测不会生成或重复追加回答。

顺序异常最多自动重建一次基线，连续异常停止并提示；普通断线不无限重连，可显式刷新重新连接。旧连接回调、旧详情响应不得覆盖新范围。binding 负责从已观测事实组织轮次、来源与记忆关联，UI 几何与选择状态不进入 Runtime。

## 调用索引退出清单

| 现有用途                               | 替代位置                                        | 状态                                                     |
| -------------------------------------- | ----------------------------------------------- | -------------------------------------------------------- |
| 执行范围内的操作查询                   | RecordTree.descendants + 类型筛选               | 已迁移                                                   |
| 操作下的意图查询                       | RecordTree.children + 类型筛选                  | 已迁移                                                   |
| 父级结束前的活动下级检查               | 上述树查询                                      | 已迁移                                                   |
| 快照的 E/O/A/事件收集                  | RecordTree，事件显式按 sequence 排序            | 已迁移                                                   |
| Context 到调用记录的反查               | 本次 Invocation 的记录绑定                      | 已迁移：过程、终态、子调用及内容来源直接使用绑定记录     |
| Context 重复登记约束                   | 正常构造创建独立 Context；单次绑定归 Invocation | 旧防御约束随索引删除，不另建全局检查                     |
| 共享 Recorder 中 Runtime 的执行归属    | RuntimeRecord + RecordTree.root                 | 已迁移：hasExecution 已删除                              |
| 下一条事件序号与单调时间检查的前一事件 | 事件记录逻辑                                    | 已迁移：InvocationBoundaryRecordHelper.last 查询执行子树 |

InvocationRecordIndex、Runtime 持有字段、Helper 索引参数与登记接线已全部移除。RecordIndex 没有剩余生产使用者，其实现及专属测试一并删除；Recorder.add 仅接收记录，RecordRegistration 只同步提交 Book 与直接父级关系。前一事件由 InvocationBoundaryRecordHelper.last 在执行子树中按最大 sequence 查找，事件序号和时间检查仍归事件记录逻辑。当前查找为执行子树的线性遍历，不预设新的顺序状态或交付游标。调用边界记录仍仅表达调用进入和退出；新的 Transcript 变化事件不复用这套记录。
