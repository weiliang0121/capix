# 正式消息、活跃材料与分段

Transcript 是环境独立创建的内容实体，具有自己的 UID 和 revision，不属于 Scene 的内部数据范围。它保留全部正式 user/assistant 消息；`get/ref/snapshot/length` 面向全部消息，绝对索引不变。正式消息只增不改；是否进入下一次模型材料，由独立于正文的活跃索引决定。

```text
Scene 正式追加输入 → 任务 Group 获得 message / messageIndex
                      ↓
            prepareContext Group（可先运行维护 Group）
                      ↓
        活跃消息值 + 活跃记忆值 + 复合版本依据
                      ↓
       理解 / 回答 / 提取使用同一份固定材料
```

默认服务由 Scene 使用普通 append 资源接纳输入；任务 Group 的显式来源绑定固定配置及原文定位，在准备 Group 中才捕获真实材料。没有特化的 E entry。当前输入单独传递，历史数组排除本次 messageIndex，避免重复装载；其他活跃消息完整进入下游请求。不再进行隐式最近轮次保留、模型选择或按容量截取前缀；实际请求超限明确失败，正式输入仍保留。

`ActiveContent` 由 `ConversationContent` 持有，只管理已有消息索引和记忆 ID，不复制、删除或修改这些实体。显式维护策略可决定哪些内容退出活跃集合，不要求先生成替代记忆；保留来源索引也不表示运行时沿引用重新加载原文。模型材料、维护边界、持久索引和恢复限制见 [活跃材料与维护](active-content.md)。

## 既有分段能力

Transcript 仍保留 `activeStart`、`segments()` 和正式 `startSegment` 能力，历史分段继续恢复和观测。段之间共享同一份不可变消息，不复制正文、不删除旧段。默认服务不再自动调用 `startSegment`；已有分段用于迁移时确定初始活跃消息，索引建立后的维护不靠改写段边界表达。

`conversation/segment.ts` 保留串行消息的 `segmentCandidates` 辅助函数，可供显式策略使用；它按相邻 user → assistant 提出最多两组完整 QA 的候选，不是通用轮次实体，也不在默认提交链中自动执行。单独的历史选择声明同样保留为可选业务能力，不再决定默认请求材料。

Transcript 的 append/appendFrom/startSegment 在审查与落实后通知必要捕获器与可选观察端口，记录预设再产生记录。空追加、非法消息和无效分段不产生变化记录；记录失败保留已发生的内容变化。调用外接纳不虚构执行归属。

## 变化事实与捕获

Transcript 自身负责消息和段边界的接纳、落实，以及本地 revision。一次非空批量追加或有效切段推进一次 revision；消息 index 仍只定位正文。没有捕获器、没有 Recorder 时，revision 同样推进；它不是网络交付游标。

`new Transcript(messages, { changes, observation: recording.transcript })` 在接纳初始消息前固定两个可选出口；initializeObserver 在环境层分别建立 Transcript、Memories、Scene 与 Runner 和所需接线。runner.build 不创建内容实体。另有可选 persistence 端口，在内存变更和两个发布出口之前同步提交；restore 不执行该端口或重发事件。Transcript 的 changes 只要求 `ChangeCapture<TranscriptEvent>`。一个 `ChangeBuffer<A | B>` 可以共享给只产生 A 和只产生 B 的来源，不要求每个对象独占捕获器。服务已将消息、记忆、调用及记录登记接入同一捕获器。

```text
整批接纳 → 固定事件正文 → 正式更新集合及 revision
                          ├─ 必要捕获 TranscriptEvent
                          └─ 可选观察（记录预设可生成 TranscriptRecord）
```

TranscriptEvent 固定 transcriptId、revision、occurredAt 与 change；messages-appended 保存 start 和已接纳的不可变消息，segment-started 保存 previousStart/start/end。事件及其正文、消息数组均冻结；消息正文复用 Transcript 已冻结的对象。事件不携带活的 Transcript 或调用记录，不从后来的状态反推。通过工作资源端点发生的变化携带 origin.contextId，即使未开启记录也保留来源；当前服务的正式输入追加归已经建立的 Scene 调用；调用外变更允许没有 origin。内部可选 RecordChangeSource 只用于对应 TranscriptRecord 的记录归属。记录保存 transcriptId/revision 与追加/分段范围，不携带消息正文；它与携带消息正文的变化事件是两个不同出口。

ChangeBuffer 只暂存尚未取走的事实。capture 不调用消费者；take 转移当前批次、返回冻结数组并清空待取集合。不同来源的事件按捕获顺序放在一个批次中，但批次不表示业务事务。来源负责正文不可变，缓冲器不解释或复制泛型正文。服务已默认装配并通过 wait/take 持续消费；wait 只唤醒异步消费，不在 capture 内运行消费者。缓冲不持有已取出历史，不承诺持久化、消费确认、失败重投或重放。慢网络连接的缓存上限由发送者处理。

ChangeCapture 的实现契约是同步完整接纳或在接纳前抛错，不运行下游消费者、不重入来源。自定义实现须遵守此约定，接口不能替代实现保证。捕获失败包装为 ChangeCaptureError，保留已发生的不可变事件及 cause；集合与 revision 保持已落实状态；同一事实的可选观察仍会独立尝试，多个故障汇总后交付。调用循环将该错误视为必须停止，避免通过重做工作重复追加。记录失败则保留已捕获事件；两者不构成事务。既有 snapshot(end) 的原文读取语义不变。同步基线与网络增量由服务组织，详见 [观测增量](observation-increments.md)。

## 资源访问与跨端组合

`TranscriptResource.fixedRange` 在资源绑定时固定范围和 revision，业务得到窄 TranscriptRangeReader：locate 返回纯定位数据，read/entries 读取不可变消息，slice 只收窄。资源内部可以保留 TranscriptRangeRef，但业务拿不到原实体或 MessageRef；记录通用复制机制不认识这些内部引用。

工作中的每次正式读取或写入由资源访问契约形成资源事实，归属本次调用；写入端点自动附加运行来源 origin 与本次观察端口，业务不传入记录来源。供给可向下共享，端点和活动守卫按本调用重新建立。调用及父级结束后，保存的端点不能继续访问实体。端点受所属阶段和调用活动约束；已取得的 locate 数据没有读取原实体的能力，可继续作为普通值使用。

服务提供 `GET /api/transcript?id=...` 快照与 `GET /api/transcript/observe?id=...` 同步入口；服务按对话提供所属消息集合，不开放任意实体仓库。同步连接提供一次一致基线，再接续该集合后续事件，避免先 GET 后订阅之间漏消息。消息集合的 revision 与记录 revision、观测交付 sequence 分开。

客户端在当前对话初始化时加载消息并持续同步；其他观测定位可以先只展示 UID/范围，需要原文时显式加载。接收层验证集合身份和连续 revision，重复增量忽略，缺口按现有有限策略重新建立基线；普通断线不无限重连。记录与消息副本分别持有，由应用 binding 按身份和固定范围组合，不让组件从记录里猜测原文，也不从记录生成回答。

消息只增不改，因此同一 UID 的旧绝对索引仍指向原内容；版本与固定范围不能因为后续追加扩大。可变实体的历史内容不能用同样规则推断，本方案不预设通用版本仓库或实体释放后的内容可恢复保证。
