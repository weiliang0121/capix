# 消息分段与有限继承

Transcript 是环境独立创建的内容实体，具有自己的 UID 和 revision，不属于 R 的内部数据范围。它保留全部原始 user/assistant 消息，用段边界区分当前加载范围。`get/ref/snapshot/length` 仍面向全部消息，绝对索引不变；`activeStart` 与 `segments()` 表达当前段和历段。段之间共享同一份不可变消息，不复制正文、不删除旧段。

```text
旧段 [0, 12)        保存，可观测，正常模型请求不再加载
当前段 [12, end)    当前执行的原文候选
        + 当前记忆 → 筛选 → 当前段所选原文
        + 当前记忆 + 当前输入 → 回答
        + 本轮 QA、当前段筛选原文 → 提取并更新记忆
```

R.run 占用后先由 E.entry.accept 接纳消息，再发 accepted 通知；E.entry.admit 通过正式入口资源，在创建执行 Context 前检查 SelectHistory 的完整请求预算。容量计算与实际筛选共用正文、提示词和 Schema，使用现有 UTF-8 字节保守估算。若当前段历史导致超限，而仅本次输入加记忆可以容纳，则优先保留本次输入之前最近两轮完整 QA，从所保留轮次的起点开启新段；仍放不下时依次降为一轮、零轮。只调整边界，不复制消息，也不生成额外摘要。

bindObserver 在本轮 Context 建立前捕获切换后的 `[activeStart,end)`，执行中不再换段。新回答追加到当前段；旧调用的固定范围不随切换改变；记录保存 transcriptId/start/end/revision 普通定位数据，不保存实体对象引用。原始消息仍能通过绝对索引读取，热区与历史 QA 观测继续使用全部消息。已有时序详情中的执行范围会显示实际 start/end，分段由 Transcript 正式登记为 TranscriptRecord，不作为 EOA 调用节点。

筛选只能返回当前段候选索引。回答直接接收同一份旧记忆快照，因此即使旧原文退出候选集合，也能使用保留下来的理解。提取不再沿记忆来源加载旧原文；更新可以在 result.sourceIndexes 保留该目标记忆的原有来源，本次变更依据仍须来自当前可见原文并包含本轮消息。保留来源不代表重新验证原文。

这是有限继承，不承诺完整还原旧段或保证记忆语义正确。记忆或单条输入自身超限仍失败，不会通过不断创建空段绕过；回答和提取各自的实际请求仍执行容量检查，模型返回长度及所选内容可能使后续阶段超限。分段没有自动重试、提前压缩、旧段召回、并行或持久化；既有调用取消仍由 Invocation 处理，不因此回滚分段。切段已发生后若后续阶段失败，不自动回退当前段，也不删掉已接纳消息。

## 最近轮次的保留

observer/segment.ts 只为当前串行对话提出候选范围。它从本次输入向前识别最多两组紧邻的 user → assistant；遇到未回答消息或非交替内容就停止，不跨过缺口凑轮数，也不从旧段重新拉回消息。这里是当前消息形态的保留策略，不是新增 QA 实体，不依赖调用记录。

候选按两轮、一轮、零轮依次检查完整筛选请求预算，只选择第一个可容纳且向前推进的边界。原对象、绝对索引和过去调用固定的范围及记录定位不变。保留两轮表示它们进入筛选候选，不强制筛选和回答采用全部四条消息。

单轮过大时整轮退出活动范围，不从中间截消息；当前输入自身过大仍失败。轮内工具调用、长任务的材料细分不在本次范围。

Transcript 由环境建立并持有，E/O/A 业务只通过本层声明的资源端点访问；append/appendFrom/startSegment 在审查与落实后独立通知必要捕获器与可选观察端口；记录预设再产生记录。空追加、非法消息和无效分段不产生变化记录；记录失败保留已发生的内容变化。调用外接纳不虚构执行归属。

## 变化事实与捕获

Transcript 自身负责消息和段边界的接纳、落实，以及本地 revision。一次非空批量追加或有效切段推进一次 revision；消息 index 仍只定位正文。没有捕获器、没有 Recorder 时，revision 同样推进；它不是网络交付游标。

`new Transcript(messages, { changes, recorder })` 在接纳初始消息前固定两个可选出口；initializeObserver 在环境层分别建立 Transcript、Memories、R 和所需接线。createRuntime 不创建内容实体。Transcript 的 changes 只要求 `ChangeCapture<TranscriptEvent>`。一个 `ChangeObserver<A | B>` 可以共享给只产生 A 和只产生 B 的来源，不要求每个对象独占捕获器。服务已将消息、记忆、调用及记录登记接入同一捕获器。

```text
整批接纳 → 固定事件正文 → 正式更新集合及 revision
                          → 同步捕获 TranscriptEvent
                          → 按需登记 TranscriptRecord
```

TranscriptEvent 固定 transcriptId、revision、occurredAt 与 change；messages-appended 保存 start 和已接纳的不可变消息，segment-started 保存 previousStart/start/end。事件及其正文、消息数组均冻结；消息正文复用 Transcript 已冻结的对象。事件不携带活的 Transcript 或调用记录，不从后来的状态反推。通过工作资源端点发生的变化携带 origin.contextId，即使未开启记录也保留来源；入口接纳或调用外变更允许没有 origin。内部可选 ChangeSource 只用于对应 TranscriptRecord 的记录归属。记录保存 transcriptId/revision 与追加/分段范围，不携带消息正文；它与携带消息正文的变化事件是两个不同出口。

ChangeObserver 只暂存尚未取走的事实。capture 不调用消费者；take 转移当前批次、返回冻结数组并清空待取集合。不同来源的事件按捕获顺序放在一个批次中，但批次不表示业务事务。来源负责正文不可变，观察者不解释或复制泛型正文。服务已默认装配并通过 wait/take 持续消费；wait 只唤醒异步消费，不在 capture 内运行消费者。缓冲不持有已取出历史，不承诺持久化、消费确认、失败重投或重放。慢网络连接的缓存上限由发送者处理。

ChangeCapture 的实现契约是同步完整接纳或在接纳前抛错，不运行下游消费者、不重入来源。自定义实现须遵守此约定，接口不能替代实现保证。捕获失败包装为 ChangeCaptureError，保留已发生的不可变事件及 cause；集合与 revision 保持已落实状态，后续运行记录登记尚未执行。调用循环将该错误视为必须停止，避免通过重做工作重复追加。记录失败则保留已捕获事件；两者不构成事务。既有 snapshot(end) 的原文读取语义不变。同步基线与网络增量由服务组织，详见 [观测增量](observation-increments.md)。

## 资源访问与跨端组合

`TranscriptResource.fixedRange` 在资源绑定时固定范围和 revision，业务得到窄 TranscriptRangeReader：locate 返回纯定位数据，read/entries 读取不可变消息，slice 只收窄。资源内部可以保留 TranscriptRangeRef，但业务拿不到原实体或 MessageRef；记录通用复制机制不认识这些内部引用。

工作中的每次正式读取或写入由资源访问契约形成资源事实，归属本次调用；写入端点自动附加运行来源 origin 与本次观察端口，业务不传入记录来源。供给可向下共享，端点和活动守卫按本调用重新建立。调用及父级结束后，保存的端点不能继续访问实体。分段入口端点只在 accept/admit 窗口有效；已取得的 locate 数据没有读取原实体的能力，可继续作为普通值使用。

服务提供 `GET /api/transcript?id=...` 快照与 `GET /api/transcript/observe?id=...` 同步入口；当前服务仍只有本环境的一份消息集合，不是通用实体仓库。同步连接提供一次一致基线，再接续该集合后续事件，避免先 GET 后订阅之间漏消息。消息集合的 revision 与记录 revision、观测交付 sequence 分开。

客户端在当前对话初始化时加载消息并持续同步；其他观测定位可以先只展示 UID/范围，需要原文时显式加载。接收层验证集合身份和连续 revision，重复增量忽略，缺口按现有有限策略重新建立基线；普通断线不无限重连。记录与消息副本分别持有，由应用 binding 按身份和固定范围组合，不让组件从记录里猜测原文，也不从记录生成回答。

消息只增不改，因此同一 UID 的旧绝对索引仍指向原内容；版本与固定范围不能因为后续追加扩大。可变实体的历史内容不能用同样规则推断，本方案不预设通用版本仓库或实体释放后的内容可恢复保证。
