# 消息分段与有限继承

Transcript 保留全部原始 user/assistant 消息，用段边界区分当前加载范围。`get/ref/snapshot/length` 仍面向全部消息，绝对索引不变；`activeStart` 与 `segments()` 表达当前段和历段。段之间共享同一份不可变消息，不复制正文、不删除旧段。

```text
旧段 [0, 12)        保存，可观测，正常模型请求不再加载
当前段 [12, end)    当前执行的原文候选
        + 当前记忆 → 筛选 → 当前段所选原文
        + 当前记忆 + 当前输入 → 回答
        + 本轮 QA、当前段筛选原文 → 提取并更新记忆
```

ObserverExecution.prepare 在 Runtime 占用内、创建执行 Context 前检查 SelectHistory 的完整请求预算。容量计算与实际筛选共用正文、提示词和 Schema，使用现有 UTF-8 字节保守估算。若当前段历史导致超限，而仅本次输入加记忆可以容纳，则优先保留本次输入之前最近两轮完整 QA，从所保留轮次的起点开启新段；仍放不下时依次降为一轮、零轮。只调整边界，不复制消息，也不生成额外摘要。

本轮 ExecutionContext 捕获切换后的 `[activeStart,end)`，执行中不再换段。新回答追加到当前段；旧 Context 和 Record 的范围引用不随切换改变。原始消息仍能通过绝对索引读取，热区与历史 QA 观测继续使用全部消息。已有时序详情中的执行范围会显示实际 start/end，分段由 Transcript 正式登记为 TranscriptRecord，不作为 EOA 调用节点。

筛选只能返回当前段候选索引。回答直接接收同一份旧记忆快照，因此即使旧原文退出候选集合，也能使用保留下来的理解。提取不再沿记忆来源加载旧原文；更新可以在 result.sourceIndexes 保留该目标记忆的原有来源，本次变更依据仍须来自当前可见原文并包含本轮消息。保留来源不代表重新验证原文。

这是有限继承，不承诺完整还原旧段或保证记忆语义正确。记忆或单条输入自身超限仍失败，不会通过不断创建空段绕过；回答和提取各自的实际请求仍执行容量检查，模型返回长度及所选内容可能使后续阶段超限。本轮没有自动重试、提前压缩、旧段召回、取消、并行或持久化。切段已发生后若后续阶段失败，不自动回退当前段，也不删掉已接纳消息。

## 最近轮次的保留

observer/segment.ts 只为当前串行对话提出候选范围。它从本次输入向前识别最多两组紧邻的 user → assistant；遇到未回答消息或非交替内容就停止，不跨过缺口凑轮数，也不从旧段重新拉回消息。这里是当前消息形态的保留策略，不是新增 QA 实体，不依赖调用记录。

候选按两轮、一轮、零轮依次检查完整筛选请求预算，只选择第一个可容纳且向前推进的边界。原对象、绝对索引和过去 Context/Record 捕获的范围不变。保留两轮表示它们进入筛选候选，不强制筛选和回答采用全部四条消息。

单轮过大时整轮退出活动范围，不从中间截消息；当前输入自身过大仍失败。轮内工具调用、长任务的材料细分不在本次范围。

Transcript 由 Runtime 持有，append/appendFrom/startSegment 在审查与落实后调用共享 Recorder。空追加、非法消息和无效分段不产生变化记录；记录失败保留已发生的内容变化。调用外接纳不虚构执行归属。

## 变化事实与捕获

Transcript 自身负责消息和段边界的接纳、落实，以及本地 revision。一次非空批量追加或有效切段推进一次 revision；消息 index 仍只定位正文。没有捕获器、没有 Recorder 时，revision 同样推进；它不是网络交付游标。

`new Transcript(messages, { changes, recorder })` 在接纳初始消息前固定两个可选出口；`createRuntime({ messages, changes, recorder })` 负责相同装配。Transcript 的 changes 只要求 `ChangeCapture<TranscriptEvent>`；createRuntime 接受已知来源的联合 RuntimeChange。一个 `ChangeObserver<A | B>` 可以共享给只产生 A 和只产生 B 的来源，不要求每个对象独占捕获器。服务已将消息、记忆、调用及记录登记接入同一捕获器。

```text
整批接纳 → 固定事件正文 → 正式更新集合及 revision
                          → 同步捕获 TranscriptEvent
                          → 按需登记 TranscriptRecord
```

TranscriptEvent 固定 transcriptId、revision、occurredAt 与 change；messages-appended 保存 start 和已接纳的不可变消息，segment-started 保存 previousStart/start/end。事件及其正文、消息数组均冻结；消息正文复用 Transcript 已冻结的对象。事件不携带活的 Transcript 或调用记录，不从后来的状态反推。事件不虚构调用来源；既有 ChangeSource 用于对应 TranscriptRecord 的归属，记录同时保存 transcriptId/revision，与内容事件关联。

ChangeObserver 只暂存尚未取走的事实。capture 不调用消费者；take 转移当前批次、返回冻结数组并清空待取集合。不同来源的事件按捕获顺序放在一个批次中，但批次不表示业务事务。来源负责正文不可变，观察者不解释或复制泛型正文。服务已默认装配并通过 wait/take 持续消费；wait 只唤醒异步消费，不在 capture 内运行消费者。缓冲不持有已取出历史，不承诺持久化、消费确认、失败重投或重放。慢网络连接的缓存上限由发送者处理。

ChangeCapture 的实现契约是同步完整接纳或在接纳前抛错，不运行下游消费者、不重入来源。自定义实现须遵守此约定，接口不能替代实现保证。捕获失败包装为 ChangeCaptureError，保留已发生的不可变事件及 cause；集合与 revision 保持已落实状态，后续运行记录登记尚未执行。调用循环将该错误视为必须停止，避免通过重做工作重复追加。记录失败则保留已捕获事件；两者不构成事务。既有 snapshot(end) 的原文读取语义不变。同步基线与网络增量由服务组织，详见 [观测增量](observation-increments.md)。
