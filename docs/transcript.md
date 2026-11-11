# Transcript：正式消息与分段

Transcript 是环境独立创建的内容实体，具有自己的 UID 和 revision，不属于 Scene 的内部数据范围。它保留全部正式 user/assistant 消息；`get/ref/snapshot/length` 面向全部消息，绝对索引不变。正式消息只增不改；是否进入下一次模型材料，由独立于正文的活跃索引决定。

`TranscriptResource.append.append` 返回每条正式追加消息的 `{ transcriptId, index, message }`，来源由实体提供，index 是稳定原文位置；调用方按业务或持久契约显式投影字段。模型材料选择和容量处理由使用者决定；View 可以组织消息范围，退出 View 不删除消息。见 [View](view-package.md)。

## 领域类型与 wire

`@weiliang0121/capix-transcript` 根出口持有 Message、MessageLocator、TranscriptRangeLocator、TranscriptSnapshot 和 TranscriptEvent。定位只表达准确集合和位置／范围，不携带实体访问能力；快照和事件描述固定版本。Transcript 不依赖 protocol，MessageUsage 从 transcript 公开 Message 类型消费消息，按对象身份计数。

protocol 根的 TranscriptWireMessage、TranscriptWireSnapshot、TranscriptWireEvent 是明确的跨端副本，TranscriptFrame/Update 组织单份基线、增量或错误。acceptTranscriptUpdate 固定并校验单份输入，不保存集合状态或核对连续 revision。连续性、替换归属、传输和有限重建由同步消费者负责；wire 不能作为实体恢复或固定追加的凭据。

## 分段能力

Transcript 仍保留 `activeStart`、`segments()` 和正式 `startSegment` 能力，历史分段继续恢复和观测。段之间共享同一份不可变消息，不复制正文、不删除旧段。分段是正式消息内容，View 成员维护不靠改写段边界表达。

Transcript 的 append/appendFrom/startSegment 在审查与落实后通知必要捕获器与可选观察端口，记录预设再产生记录。空追加、非法消息和无效分段不产生变化记录；记录失败保留已发生的内容变化。调用外接纳不虚构执行归属。

## 可选的消息算法

`@weiliang0121/capix-transcript/presets` 提供 `groupAdjacentPairs`。输入是同一个 Transcript 内按绝对索引升序排列的 `{ index, message }` 值，可以来自固定范围或视图快照；不接受重复、倒序或非法索引。相邻的 user/assistant 两项组成一组，其余项各自保留。原文索引存在缺口时不配对；不隐式排序，不丢弃任何输入项，不推断提交或业务因果。输出只创建冻结的分组容器，消息沿用传入的引用，因此通常应传入实体或视图已接纳的不可变消息值。

```ts
import { groupAdjacentPairs } from '@weiliang0121/capix-transcript/presets';
import { TranscriptResource } from '@weiliang0121/capix-transcript';
import { Node } from '@weiliang0121/capix-structure';

// 普通策略节点：读取已授权范围，返回分组建议。
const grouping = new Node({
  deps: { messages: TranscriptResource.fixedRange.request() },
  run: (work) => groupAdjacentPairs(work.resources.messages.entries()),
});
```

节点的结构归属和资源供应仍由作者明确装配。得到分组不自动调用 `startSegment` 或变更活跃视图；展示、汇总或保留选择由后续处理决定。算法只依赖消息值，不依赖 Node、Runner 或活实体；单独使用函数不需要建立调用。

## 变化事实与捕获

Transcript 自身负责消息和段边界的接纳、落实，以及本地 revision。一次非空批量追加或有效切段推进一次 revision；消息 index 仍只定位正文。没有捕获器、没有 Recorder 时，revision 同样推进；它不是网络交付游标。

`new Transcript(messages, { changes, observation: recording.transcript })` 在接纳初始消息前固定两个可选出口；宿主分别建立实体与运行结构，并负责接线。runner.build 不创建内容实体。另有可选 persistence 端口，在内存变更和两个发布出口之前同步提交；restore 不执行该端口或重发事件。Transcript 的 changes 只要求 `ChangeCapture<TranscriptEvent>`。一个 `ChangeBuffer<A | B>` 可以共享给只产生 A 和只产生 B 的来源，不要求每个对象独占捕获器。宿主可将消息、记忆、调用及记录变化接入同一捕获器。

```text
整批接纳 → 固定事件正文 → 正式更新集合及 revision
                          ├─ 必要捕获 TranscriptEvent
                          └─ 可选观察（记录预设可生成 TranscriptRecord）
```

TranscriptEvent 固定 transcriptId、revision、occurredAt 与 change；messages-appended 保存 start 和已接纳的不可变消息，segment-started 保存 previousStart/start/end。事件及其正文、消息数组均冻结；消息正文复用 Transcript 已冻结的对象。事件不携带活的 Transcript 或调用记录，不从后来的状态反推。通过工作资源端点发生的变化携带 origin.contextId，即使未开启记录也保留来源；调用外变更允许没有 origin。内部可选 RecordChangeSource 只用于对应 TranscriptRecord 的记录归属。记录保存 transcriptId/revision 与追加/分段范围，不携带消息正文；它与携带消息正文的变化事件是两个不同出口。

ChangeBuffer 只暂存尚未取走的事实。capture 不调用消费者；take 转移当前批次、返回冻结数组并清空待取集合。不同来源的事件按捕获顺序放在一个批次中，但批次不表示业务事务。来源负责正文不可变，缓冲器不解释或复制泛型正文。宿主可通过 wait/take 持续消费；wait 只唤醒异步消费，不在 capture 内运行消费者。缓冲不持有已取出历史，不承诺持久化、消费确认、失败重投或重放。慢网络连接的缓存上限由发送者处理。

ChangeCapture 的实现契约是同步完整接纳或在接纳前抛错，不运行下游消费者、不重入来源。自定义实现须遵守此约定，接口不能替代实现保证。捕获失败包装为 ChangeCaptureError，保留已发生的不可变事件及 cause；集合与 revision 保持已落实状态；同一事实的可选观察仍会独立尝试，多个故障汇总后交付。调用循环将该错误视为必须停止，避免通过重做工作重复追加。记录失败则保留已捕获事件；两者不构成事务。既有 snapshot(end) 的原文读取语义不变。同步基线与网络增量由服务组织，详见 [观测增量](observation-increments.md)。

## 资源访问与跨端组合

`TranscriptResource.fixedRange` 在资源绑定时固定范围和 revision，业务得到窄 TranscriptRangeReader：locate 返回纯定位数据，read/entries 读取不可变消息，slice 只收窄。资源内部可以保留 TranscriptRangeRef，但业务拿不到原实体或 MessageRef；记录通用复制机制不认识这些内部引用。

工作中的每次正式读取或写入由资源访问契约形成资源事实，归属本次调用；写入端点自动附加运行来源 origin 与本次观察端口，业务不传入记录来源。供给可向下共享，端点和活动守卫按本调用重新建立。调用及父级结束后，保存的端点不能继续访问实体。端点受所属阶段和调用活动约束；已取得的 locate 数据没有读取原实体的能力，可继续作为普通值使用。

宿主可将一致基线与后续事件组合为同步出口。基线和订阅之间的交接、集合身份、连续 revision、重复交付与连接替换，均须由消费者明确核验。消息集合 revision、记录 revision 与网络交付 sequence 分别表达不同顺序，不能互换。框架提供 [wire 单帧接纳](protocol.md)，不附带 HTTP 路由或客户端副本。

消息只增不改，因此同一 UID 的旧绝对索引仍指向原内容；版本与固定范围不能因为后续追加扩大。可变实体的历史内容不能用同样规则推断，本方案不预设通用版本仓库或实体释放后的内容可恢复保证。
