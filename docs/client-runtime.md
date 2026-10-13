# 客户端 Runtime

ClientRuntime 装配提交跟踪、消息同步与可选观测消费，协调它们的已接纳状态并发布快照，不依赖 React、HTTP 实现或服务端对象。client/runtime 公开 ConversationTransport、TranscriptTransport 和 ObservationTransport 三个契约；应用通过 conversation / transcripts / observation 具名参数接入。

接口分类不等于 HTTP 实例拆分。ConversationHttpTransport 同时实现业务交付和消息实体契约；ObservationHttpTransport 提供独立的观测接口，两者共用通用 HttpTransport。

## 内部职责归属

| 对象                | 自己维护的范围                                             | 与 ClientRuntime 的接缝                                                                               |
| ------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| ClientSubmission    | 一笔提交的固定输入、身份、累计事实、反馈连接及取消请求状态 | 队列选择 POST 或 follow，授予已初始化的 transcriptId；对象报告局部变化，Runtime 在发布后通知 accepted |
| ConversationQueue   | 本地消息顺序、当前提交、容量及服务接纳条件                 | Runtime 提供当前环境资格，队列接纳本地输入并串行发送；不会以断流或取消请求确认释放占用                |
| TranscriptReceiver  | 各消息集合的订阅、基线、副本和同步状态                     | 报告已接纳的集合状态；Runtime 协调初始化与当前对话正文                                                |
| ObservationReceiver | 可选观测连接、来源副本、详情缓存和旧响应隔离               | 报告完整 ObservationState；不取得 Runtime，也不操作提交或消息                                         |
| ClientRuntime       | 初始化门控、队列装配、跨来源协调、公开快照与通知顺序       | 保持应用入口，不直接维护连接控制器或第二份当前提交占用                                                |

ObservationReplica 只接纳观测基线与增量，连接生命周期在 observation/receiver.ts；两者按职责组织在 observation/ 下。Receiver 是包内实现，不增加应用装配入口。初始化要协调配置与消息，快照发布要协调多个来源，二者仍留在 Runtime；没有增加通用连接管理器、事件总线或调度框架。

ClientSubmission.connect 接收连接函数和窄的 SubmissionReception（transcriptId、changed），不持有整个 Runtime。它自行校验集合归属、隔离旧连接、解释反馈结束与断开；队列决定何时发送下一笔，并为发送、查询和取消操作传入 transport。stopFollowing 先完成本地状态转移再解除连接，由调用方协调这次停止的状态发布，避免停止过程重复通知。

替换或释放跟踪时，先确定新的本地归属，再 abort 捕获的旧连接；abort 监听器可能同步重入，之后仍需核对当前身份。服务结果已经出现但反馈连接尚未结束时，新提交也会解除旧反馈连接。关闭交付始终不代表取消服务端业务。

## 只使用对话

```ts
const conversation = new ConversationHttpTransport();
const runtime = new ClientRuntime({
  conversation,
  transcripts: conversation,
});
await runtime.initialize();
await runtime.submit({ messages: [{ role: 'user', content: '你好' }] });
// 结束客户端订阅，不取消服务端已经接纳的业务。
runtime.stopTranscript();
```

ConversationTransport 提供 conversations/createConversation/conversation、config、admission、submit、follow、read 和 cancel；TranscriptTransport 提供 transcript(id, signal?) 查询与 observeTranscript(id, accept, signal) 订阅。transcripts 是必需接入：对话正文由消息实体副本提供，不从观测记录生成。

initialize 并行取得配置和当前集合订阅的首帧基线。同一次进行中的初始化返回同一 Promise；失败不会永久缓存 rejected Promise，之后显式 initialize 会建立新尝试。初始化尝试本身不自动重建，消息连接在接收器内部有限重试。配置与实体各自成功时分别保留已经确认的内容，后续尝试复用配置和健康实体连接；不能因为保留了部分配置就提前允许 submit。配置慢于实体流时，最终采用已经接纳的最新消息副本，不能把首帧旧内容覆盖到新增量之上。初始化结束前再次确认实体同步仍然有效。初始化不会请求执行概览、记忆或记录详情。

state.initialization 表达本次环境初始化的 idle、running、succeeded、failed 或 stopped；开始后携带本地 attempt 序号，failed 保留原错误。InitializationAttempt 只管理这个有限过程的状态与 Promise 结束权，不依赖服务端 Invocation，也不引入全局环境管理者。配置失败或消息同步终止会结束本次尝试；消息接收器尚在有限恢复期间则继续等待本次有效基线。该状态只表示初始化结果，后续实体连接是否持续有效仍由 TranscriptState 表达。

stopTranscript 停止当前集合或全部集合时，也结束正在进行的初始化；已确认的配置和消息副本保留。旧尝试随后返回的配置被忽略，停止的实体连接回调也不能写入，新 initialize 可以明确建立下一次尝试。这不等于取消服务端工作，也不改变服务端 Initializer 的一次构造及失败缓存规则。

业务状态包含 messages、transcriptId、transcripts、submission、submissions 和初始化错误。messages 是当前集合已接纳 snapshot.messages 的便利引用；权威副本保存在按 UID 索引的 transcripts 中。submission 保存本地 id/pending、已确认的 remote 累计投影及 feedback 连接状态；busy/pending/contextId/answered 只从 submission 派生，不另外维护一套执行真相。

1. enqueue 同步检查并固定本地输入，固定 conversationId 并放入等待队列；一次实际 POST 另生成 submissionId；本地接纳不代表服务端已经接纳。submit 保留明确的立即发送入口与连接 Promise；有未结束提交或等待项时拒绝，不能插队。每次服务提交身份只发送一次 POST；明确未接纳的接纳重试建立新身份，结果未知不能重发。
2. remote.input 来自正式消息写入位置，首次确认后在公开状态发布阶段调用一次 accepted(submission)。HTTP 200、收到首帧或建立 E 都不等于输入已接纳。回调接收该提交的不可变快照，必须同步返回 undefined；抛错或意外返回 Promise 只保存 notificationError，不停止接收或改写服务结果。
3. remote.executions 保存服务选择关联的 E Context 身份，可以为空或多项；输入在 E Context 建立前也能正式落实。remote.answer 只指向已落实回答，正文来自独立实体同步，不从记录或提交反馈重复追加。
4. remote.result 是服务任务 completed / failed / rejected / cancelled。后处理失败或取消保留已确认回答；completed 只表示任务返回，不凭空补造 input/answer。remote.cancelRequested 只表示服务端已接收取消要求，不能替代实际结束结果。remote.integrity 说明服务进展解释是否完整，与任务结果分开。
5. feedback 表示 idle（尚未发送）、connecting / following / ended / interrupted。断流、网络失败或投影不完整都不能证明服务执行失败；保留所有已确认事实。消息实体和观测同步失败各自保存在对应范围，不撤回提交结果。
6. reconnectSubmission 只 follow 同一 submissionId，不重新发送输入；若有未确认的取消意图，可同时重发取消控制。refreshSubmission 单次查询同一身份，接纳事实而不改变反馈连接状态。新连接接收当前累计投影，允许 revision 跳跃；忽略旧修订，同版本冲突、事实回退或更改必须拒绝。旧连接回调不能写入新连接状态。
7. stopFollowing 只停反馈连接；releaseSubmission 不能释放已发送但结果未知的当前提交。服务端未知、已淘汰或重启后丢失的 submissionId 仍表示结果无法确认，不能推断“没有执行”，也不能为了推进等待项丢弃当前身份。

`remote.activities` 单独保存服务投影的 REOA 过程元数据。HTTP 检查格式，ClientSubmission 接纳调用身份、直接归属、轮次、终态和父层接纳事实，拒绝回退；`activities.integrity` 不代替提交结果，也不改写正文可用性。明确的过程来源失效保留最后事实；畸形反馈仍按协议错误拒绝，不把坏数据补成完成。

反馈基线与增量分别接纳：baseline 完整检查后建立副本；submission 按 fromRevision/revision 安装已知变化字段和 activity upsert，仅检查变化调用并复用其他条目。控制响应覆盖部分在途批次时可幂等合并重叠部分，缺口不强行越过。同修订增量逐项核对其声明事实，矛盾仍拒绝。answer 只更新候选，不重新接纳完整调用图；先到达的已接纳候选在 input 尚未同步时等待关联核对，不因不同来源的交付顺序提前失败。

可选 `fileTask` 与消息一起在本地接纳时复制冻结，等待期间修改草稿不会改变已排队路径；实际内容在服务执行时读取。`remote.task` 表达服务选定的本轮任务，客户端验证其稳定性及显式本地约束；自然语言可由服务确定文件任务。`remote.fileOutput` 是独立文件事实，客户端校验目标与远端已选任务一致、回执字段完整、终态不可变以及与提交结果的兼容性。不从模型回答推断文件已保存，也不因 failed/cancelled 撤销已确认的 created。应用绑定保留任务元数据与输出事实，文件结果组件不依赖正文打字进度或观测连接。服务没有输出事实时只展示计划路径，不补造 pending 或失败。

`state.submissions` 以 submissionId 保留最近 32 笔已发送提交的不可变快照；不保留旧连接和原始请求，不包含未发送的队列项。新提交开始不删除上一笔过程，超过上限时只移除最早的本地快照，不改动消息集合。它是当前对话的有限保留，切换对话时清理，刷新页面后不自动重建历史过程。

本轮只恢复反馈，不恢复执行。服务端保留是有界进程内状态，不提供幂等重提、持久化、离线重放或重启后的任务恢复。实体同步和可选观测有独立连接与接纳规则。

## 本地消息队列与取消

```ts
const first = runtime.enqueue({ messages: [{ role: 'user', content: '介绍一下北京' }] });
const next = runtime.enqueue({ messages: [{ role: 'user', content: '周末适合去哪里？' }] });
await runtime.cancelSubmission(next.id); // 尚未发送：撤回这一条本地等待消息
await runtime.cancelSubmission(first.id); // 已发送：请求停止当前处理
// 控制请求返回不等于运行退出；退出并确认服务接纳条件后，剩余消息自动发送。
```

ConversationQueue 是单个客户端的内存 FIFO，不是服务调度或多客户端互斥。入队时复制冻结完整 messages/contextBudget；等待期间的编辑不修改它。默认按 32 条等待项、等待输入合计 16 MiB 限制新消息入队，并检查每笔输入的 HTTP 容量边界；满时整笔拒绝，不丢弃已有输入。在途项明确未被接纳时可退回队首，因此等待量可能暂时多出这一项，但已接纳的输入总量不增加。ClientRuntimeOptions.queue 可以设置等待容量，应用暂不提供额外设置。

本地等待消息的 id 在接纳重试期间保持稳定。ClientSubmission.id 则对应一次 POST 的 submissionId，queueId 指回本地消息。enqueue 返回的 id、waiting[].id 和撤销使用同一本地身份；反馈 read/follow/cancel 使用具体提交身份。服务明确未接纳且允许再次尝试时，保留原消息、顺序和输入，下一次尝试生成新的 submissionId，不重 POST 已存在的身份。

queue.waiting 公开待发送项的 id/pending，blocked 说明当前不能推进的原因。队列没有手动暂停/恢复状态；应用等待项只提供撤销。单轮失败、拒绝或取消不会清空后续消息，也不会永久阻挡对话。只有当前 result 已确认结束，且服务接纳条件允许，才自动发送下一条。回答已写入、正文同步完成、取消要求已收到都不代替运行结束；正文同步和可选观测滞后本身不阻止发送。

服务提供独立 ConversationAdmission：ready、busy 或 unavailable，带 conversationId 与 transcriptId；unavailable 携带明确原因。它是服务当前占用、配置和已知必要能力状态的投影，不由客户端错误码或观测记录推断，也不保证下一次模型调用成功。提交反馈可附带当时的接纳状态，客户端在已有可信提示足够时直接推进，信息不足或忙碌时按需查询并退避等待。ready 不预占入口，正式 POST 仍可能因竞争被拒绝。

只有 rejected + retry:admission 且未形成输入/执行事实，才允许自动再次尝试接纳。失败的 QA 不自动重做；用户再次输入相同文字仍是新的消息。服务明确不可用时保留等待消息，显示原因并检查接纳条件；查询不触发 Provider 初始化或模型探测，修复需要重建环境的条件不会被客户端隐式重置。

反馈中断且结果未知时，客户端恢复的是原提交的查询/反馈，不重新发送输入。即使服务接纳查询返回 ready，也不能据此释放未知当前项。自动检查从 250ms 退避至最长 8 秒，单次查询超时为 10 秒；持有自己的取消与身份边界，旧查询不能覆盖新当前项或撤销后的队列。停止跟踪关闭原提交的自动确认，不意味着取消业务，也不暂停其他已明确未受理的等待项。

控制操作不排进消息 FIFO：

- cancelSubmission(id)：尚未发送时本地撤回；当前项已发送时独立请求取消，等待真实终态后继续剩余消息。
- clearQueue()：只撤回等待项，不改变当前业务；cancelAll()：先清空等待项，再请求取消当前项。应用只暴露逐条撤回和停止当前回答。
- reconnectSubmission()/refreshSubmission()：分别 follow 原身份或单次查询；不会重新 POST，也不重新追加输入。

submission.cancellation 表达 requested / sending / acknowledged / uncertain。请求响应丢失时保留取消意图；已知 cancelRequested 后等待真实终态，不能提前释放当前项。首次取消可能早于服务登记，未知响应不能证明不会执行；之后取得新证据可以再次发送取消控制，始终不重发业务输入。

停止反馈不会取消业务，也不会清空等待消息。页面刷新或丢弃整个实例不会保存等待项，也无法保证恢复已发送的身份；本轮没有持久化队列、幂等执行或离线重放。

## 接纳、协调与发布

连接负责交付，消费建立在连接之上。TranscriptReplica 与 ClientSubmission 分别校验并接纳实体增量、提交累计事实；ClientRuntime 内部 sources 保存已接纳状态。coordinateConversation 只组合这些事实，提供当前消息和提交读模型，不请求数据、不制造执行结果，也不要求两条连接同时到达。

inputAvailability / answerAvailability 独立表达引用对应的正文：

| 值          | 含义                                 |
| ----------- | ------------------------------------ |
| unconfirmed | 尚未确认输入或回答定位               |
| unloaded    | 已知定位，但本地没有对应消息集合基线 |
| pending     | 已有基线，其范围还未覆盖定位         |
| available   | 本地消息副本已包含所指正文           |

当前提交必须属于初始化的消息集合，正常路径已有基线，因此常见的是 unconfirmed → pending / available。available 不代表连接仍健康；断线后已取得的内容依然可用。completed + pending 和 failed + available 都是有效组合。正文先到只更新消息，不凭正文反推本次提交的 answer 定位。

每条增量仍即时、按顺序接纳；对外发布用微任务合并同批变化。getSnapshot 返回最近一次发布的稳定对象，发布前先整体替换，再逐个通知订阅者。内部占用、连接归属与详情竞争检查读取即时状态，不等待公开快照更新。已发布消息、分段数组和配置在接纳时复制，后续接收不修改旧快照；ReadonlyMap 是只读使用契约，不承诺对任意运行时强制修改提供代理拦截。

本地初始化、提交身份建立、停止和结束跟踪在明确命令边界主动发布；订阅通知期间发生的重入操作只改变内部状态，下次发布生效，保证同批订阅者读取同一快照。初始化 Promise 结束后公开状态已更新。没有增加原始帧队列、业务事务或通用调度器。

accepted 不再在网络接纳函数内调用。待通知提交独立保留到发布阶段，避免合并更新漏掉一次接纳通知。普通情况下回调对应当前公开提交；如果订阅者已在同批通知中明确释放或替换跟踪，回调参数仍标明原提交，不能通过 getSnapshot 猜测历史通知归属。回调产生的新状态和 notificationError 在下一批发布；回调失败不重新办理业务。

消息同步错误留在 TranscriptState，初始化错误留在 ClientState.error，提交反馈错误留在 submission.feedback，可选观测错误留在 observation。它们不相互覆盖，也不撤销已经成立的服务结果。

## 对话目录与切换

ClientRuntime 提供 refreshConversations、createConversation（创建并打开）、openConversation。初始化读取目录并打开稳定默认对话。快照 conversation 是当前元信息，conversations 是目录，switching/canSwitchConversation/conversationError 表达切换。提交与队列归属固定；仅当前提交已确认结束且等待队列为空才可切换。目标有效基线到达前保留旧对话，成功后替换提交与观测作用域；代次保护旧回调，观测失败不阻止对话使用。详细边界见 [对话身份与切换](conversations.md)。

## 消息实体的按需加载与同步

```ts
await runtime.loadTranscript(transcriptId); // 首次获取原子基线，随后持续同步
runtime.stopTranscript(transcriptId); // 保留副本，停止这个集合的连接
await runtime.loadTranscript(transcriptId); // 建立新基线，不声称能重放离线增量
```

每个 TranscriptState 保存 snapshot 和 sync。snapshot 为 `{ id, revision, start: 0, end, starts, messages }`；revision 覆盖消息追加和分段变化。sync 明确区分 connecting（本次连接尚未取得基线）、live、retrying（attempt、retryAt、error）、failed（error）和 stopped，不再并列维护 loading/syncing/error。初连 attempt 为 0，恢复计数从 1 开始。当前会话初始化时主动同步，只有被记录提及的其他集合默认不加载、不积压未订阅的增量；默认集合身份尚未确认时由初始化状态表达准备进度，不建立伪造的集合 UID。

GET /api/transcript/observe 首先交付 baseline，随后交付带完整消息正文的 TranscriptEvent。服务端在同步临界区内衔接快照和订阅；客户端不通过先 GET 再订阅推测这个接缝。GET /api/transcript 是明确的按需查询与补取接口。

TranscriptReplica 检查身份、revision 和范围：重复版本忽略，新增版本必须连续；追加必须从已知 end 开始；分段必须衔接已知 starts。接纳失败不部分修改旧副本。集合版本与观测交付 sequence 完全独立。

TranscriptReceiver 为已知 UID 复用订阅。所有订阅从已取得的对话信息或实体引用明确 UID，同一 UID 复用连接和有效基线等待。每次连接有独立 AbortController；结束时先转移归属和等待状态，再通知与 abort，过期回调不能覆盖新连接。

网络中断、意外 EOF、明确的临时 HTTP 状态及修订缺口，按 500/1500/4000ms 最多自动重连三次；每次重新取得原子基线。连接连续 live 至少 30 秒后再断开才重置预算，收到 baseline 本身不清零，避免 baseline→EOF 无限循环。超过预算转为 failed，保留副本并允许显式重连。主动 stop 清除连接和重试计时器、拒绝尚未就绪的等待者，只有显式 watch/initialize 才恢复；当前不根据浏览器 online/visibility 事件自动开启已停止的同步。

HTTP 适配只将网络失败、408/429/500/502/503/504 和意外 EOF 标为 TranscriptConnectionError，cause 保留原始诊断；这个类型属于本地收发边界，不是服务 wire 字段。其他传输实现也应明确标注可恢复连接中断。接收回调错误、身份变化、基线内容冲突、协议无效、访问拒绝及来源失效不会自动重试；修订缺口由接收层自身判定。恢复期间再次 watch 或 initialize 等待本次有效基线，不复用首次已经兑现的 ready；已经初始化成功的客户端不会因消息重连重新判定服务接纳资格。同步不修改提交结果或队列，不重新 POST，也不取消业务执行。

快照查询与流增量可能交错：接收层只让较新有效内容更新副本，旧基线不覆盖新状态，同修订复用已接纳副本。恢复基线检查已知正文与分段前缀，旧流追平时核对重叠增量；冲突终止同步，不通过反复拉取掩盖。停止后的回调被忽略。stopTranscript 与 startObservation 返回的解除函数互不取消；观察停止不会停止消息同步或当前业务。这里没有离线事件 replay、ACK、持久化或执行恢复。

## 按需接入观测

```ts
const conversation = new ConversationHttpTransport();
const runtime = new ClientRuntime({
  conversation,
  transcripts: conversation,
  observation: new ObservationHttpTransport(),
});
await runtime.initialize();
const stopObservation = runtime.startObservation();
stopObservation(); // 只关闭观测连接
```

ObservationTransport 提供 overview、memory、execution、source、observe。仅传入此能力不会开始观测；startObservation 显式打开独立连接，由首帧一起取得概览、记忆与来源游标，不通过多个查询拼接基线，不预取已完成执行的全部详情。

观测基线中的消息是 `{ index, count }` 与 transcriptId，消息追加通知是 start/end；记忆来源是 `{ transcriptId, index }`。它们不携原文正文。Record 的调用输入输出和资源证据仍按各自契约保留，不能用于回填对话副本。

Runtime 的本地 subscribe 消费者逐个通知；抛错的消费者被移除，不阻断其他订阅者、已接纳的实体变化或后续源同步。这个隔离仅位于下游通知边界，不吞掉协议、版本或副本校验错误。

观测状态保存在 state.observation：enabled、loading、error、overview、memory、records、updates，以及 cursor、invocationEvents、transcriptRecords。观测初始化或刷新失败只影响这个范围，不拒绝对话初始化或提交。

ObservationReplica 在新结构中整批接纳 delta，失败不部分修改已接纳状态。重复交付忽略，范围和顺序缺口拒绝。记录新增与父级引用同步接纳；过程和父层接纳关系分别只追加新条目，并以 eventSequence 对照。资源事实作为独立 record entry 接收，按所属调用收集进 ExecutionRecordSnapshot.resources；待调用记录和对应边界齐备后提供执行视图。客户端不从资源事实反推实际业务状态。

loadExecution 按需查询，E 与其父 R 均结束时才复用终态缓存；查询期间收到更新时保留新快照。ObservationReceiver 用本地连接代次检查详情响应：即使请求发起时未开启观测，中间开启又关闭，也不能让旧请求进入新范围。代次只标识本地交付生命周期，不是协议游标或业务版本。详情不进入 updates，不用历史详情覆盖概览。source 保留按需源码查询，不承诺执行时源码归档。

观测连接仅接受一个首帧基线。顺序缺口最多自动取得一次新基线，连续失败明确报错。`ObservationConnectionError` 只由传输确认的网络中断、EOF 或无来源错误码的暂时 HTTP 失败产生；此时 `ObservationState.reconnectable` 为 true，应用提供“重新连接观测”，重连中保留已取得图谱。`SOURCE_INCOMPLETE`、协议身份/归属及消费者错误为终止错误，refresh/start/组件重挂不能绕过同一对话的失败；不同对话重新建立独立范围。健康连接保留显式刷新用途。旧连接回调和详情响应不得覆盖新连接。关闭观测不停止服务端记录。

增量接纳只为受影响且边界齐备的执行重建快照，Receiver 的 updates 仍累计保留各 E 最新事实，供按帧合并的 binding 消费。Binding 按消息、选择计数和记忆来源依赖复用轮次、详情及图；没有把增量到达速度直接变成 React 更新频率。

## HTTP 包边界

HttpTransport 只处理地址、HTTP 状态、JSON 读取和错误，不感知业务、实体或记录。

- ConversationHttpTransport：对话目录及创建/读取、config、POST /api/run、GET /api/submissions/:id 与 /follow、POST /api/submissions/:id/cancel、transcript 查询和 GET /api/transcript/observe。提交响应逐行接纳 ConversationSubmissionSnapshot，HTTP 拒绝也可能携带正式投影；取消响应同样接纳累计事实，不把控制确认当成执行结束。实体流接纳 baseline/delta/error，不将断流当作业务完成。
- ObservationHttpTransport：overview、memory、execution、source、GET /api/observe，以及按调用关联查询和订阅 Interaction 元数据。记录观测流可覆盖多次执行，结束不代表业务完成。
- 普通响应由 Zod 接纳；记录详情由 validateExecutionRecordSnapshot 验证并核对请求身份；消息实体还由接收层检查范围与版本。

readLines 只负责 UTF-8 解码与行拆分。回调同步执行，失败后关闭 reader；HttpError 保留 HTTP 响应，HttpTransportError 区分 contract / remote / delivery，网络异常保留原异常。取消实体或观测连接只解除对应交付。发送缓存有限，慢消费者断开后通过新基线接续，不承诺离线追赶。

## 应用绑定与 Store

- binding/application.ts 装配 Store 和命令，独立开启观测及对话初始化。初次连接立即投影，后续 Runtime 通知合并到 requestAnimationFrame，执行时读取最新公开快照，完成投影后一次写入 Store；这与 Runtime 的接纳和微任务发布是不同边界。卸载取消待处理帧并分别停止观测和实体订阅；重新挂载恢复实体同步，保留已取得的配置与 UI 编辑。投影失败只显示本地提示，后续成功投影可继续更新。
- binding/submit.ts 解析并提交本次草稿与追加历史；enqueue 成功立即清理对应编辑，失败保留原输入。界面统一使用发送动作，忙碌时由 Runtime 自动排队，不要求用户选择发送模式。仅成功接纳的即时发送写入应用 conversationFocus；等待、自动派发和队列恢复不会抢回阅读位置。
- binding/data.ts 组织业务消息、队列与进度，并组合可选观测；binding/submission.ts 将已确认事实、取消要求与反馈状态转换成提示和当前控制按钮。结果未知时提供重新同步/请求取消，不提供释放占用。当前提交失败或拒绝且没有输入定位时，保留本地输入占位与助手区域的说明；它们不进入正式消息集合。MessageQueue 仅在有等待项时显示，只提供逐条撤回及不能推进的原因，不提供暂停或恢复操作。Composer 承担当前取消：空草稿时停止替换发送，有草稿时发送和停止并存，Enter 始终只发送。接纳重试通过稳定的 queueId 维持同一助手区域，不重复展示未接纳的失败消息；撤回后清除该本地占位。
- binding/observation.ts 按 UID/index 组合消息、上下文和记忆来源，明确区分未加载、加载中、缺失与错误；实体到达时即便记录未变化也重建对应读模型。
- binding/resources.ts 解释应用约定的配置与历史范围资源事实；details.ts 为各调用组织资源事实列表，React 不解析原始 ExecutionRecordSnapshot。
- projectConversation 仅给当前同一消息集合中的已有消息添加执行链接，不能用相同 index 跨集合猜测关联。
- Store 保存应用读模型及草稿、预算、搜索、选择和弹层状态。组件持有局部 DOM、滚动和加载提示；未知原文提供加载入口。binding/data.ts 将消息连接状态投影为 conversationSync：连接中或自动重试只显示同步进度，明确失败或停止后提供重新连接入口；已取得的正文保持可读，不把网络或协议原始诊断直接展示在对话区。尚未确认消息集合身份或配置准备失败时，使用 initialization 显示通用对话连接提示。初始化 Promise 的 catch 不写提示，避免旧连接失败覆盖新连接状态。

对话用 Streamdown 渲染助手回答，用户输入保持纯文本；presentation/conversation/scroll.ts 在 use-stick-to-bottom 上约束对话的定位、跟随与留白。消息图片只显示说明及显式链接，不自动加载外部资源。

### 文本呈现与消费节奏

正式消息仍整条追加，有限流式回答另走提交反馈中的 answer 帧。ClientSubmission 的 AnswerPreviewReceiver 保存候选副本，不向 Transcript 写入临时消息；generation 区分真正的再次生成，revision/offset 检查候选增量。缺口可查询同一提交基线，身份或正文冲突停止候选消费，不重 POST，也不阻断正式结果。

绑定层先按正式消息定位关联候选，再复核预览是否为正式正文前缀。前缀成立时以相同内容 key 接管，保留展示游标；不一致时切换正式全文，不拼接错误前缀。取消/失败的候选标明未正式接纳，重试使用新 generation。ClientRuntime 不管理播放速度；TextReveal 消费持续增长的正文、追上后等待，最终确认完整后使用既有受控速度。展示时钟不参与接纳、取消或队列推进，下一条助手区域仍等待上一条展示完毕。

`binding/reveal.ts` 在投影连接建立后识别新增的本地跟踪提交，只通过 `remote.answer` 的消息集合 UID/index 关联新回答。初始历史、已有提交、集合切换及已识别的同步中断后的历史补齐默认静态。消息连接离开 live 后清除尚未开始的动画资格，已展示正文的播放不被中断；恢复中的缺失正文保持 pending，不以旧快照断言 missing。正文先于回答定位跨帧到达时，直接显示全文，定位到达后不倒退重播，因此不保证每条新增回答都有动画。消息 key 包含集合 UID 与 index，不依赖 Observer 或正文匹配。

`presentation/text/reveal.ts` 是无框架依赖的展示时钟。接收只更新可用正文；tick 按经过时间与字素游标推进，避免切开 emoji/组合字符。来源未结束时固定每秒 40 个字素，追平后等待且不积累时间额度；来源结束时按剩余量/8 秒一次选速，范围为每秒 40–120 个字素，不在尾部反复降速。当前完整消息从开始就确定一次速度。单帧最多消费 100ms 的额度，暂停后不补偿后台时间；极长正文不承诺 8 秒结束，可由用户立即显示全文。非追加的内容替换直接静态显示，不建立文本 diff 或内容恢复机制。

`presentation/text/react.tsx` 负责浏览器帧、可见性和减少动态效果偏好。TextRevealProvider 在视图内按正文身份保留独立游标，子组件临时重挂载可继续；已完成的计时对象释放，视图重新打开时历史直接完整显示。输入更新不重建时钟。逐字更新只作用于对应正文组件，不写整个 AppData，也不增加服务端或客户端同步队列。完成通知单独供对话展示协调使用，不逐字通知父层。

`presentation/conversation/reveal.ts` 在视图内协调助手区域的顺序：已有回答播放未结束时，后续新助手区域暂不挂载；自然播放完成或点击立即全文后，再呈现下一助手区域的最新事实。已发送的用户输入与真实当前提交的取消控制不等待播放，Runtime 发送和接收也不等待。已经显示的区域不会被晚到正文重新隐藏，较早区域的晚到正文直接静态展示；初始历史与减少动态效果不会阻塞后续区域。该状态随视图存在，不是第二条业务提交队列。

MessageContent 的 `format` 与 `complete` 分别决定纯文本/Markdown及完整/未闭合解析，不控制速度。未展示完的 Markdown 使用 Streamdown 的不完整语法处理，不修改原文，不叠加其文字动画；完成后回到静态渲染。AnswerContent 组合已落实正文与渐显 hook，提供“立即显示全文”，正文逐字变化不作为 live region 播报，只在展示完成时提示。现有底部跟随保留，上滚阅读不被打字时钟强制拉回。

确定性控制器与 binding 回归纳入 `pnpm check`。React 浏览器回归可启动 `pnpm dev` 后打开 `/test/reveal.html`，覆盖 StrictMode、独立游标、子组件重挂载、等待、身份替换、后台与减少动态效果，不连接服务或调用模型。

### 对话中的处理过程

`binding/responses.ts` 将正式消息与已开始提交的事实组合为 ConversationItem：正式消息、本地输入占位、助手回应区域。助手区域的读模型从 connecting 起建立，无需等 activities 或正式回答；可见时机再由展示层衔接前一回答的播放，以 queueId 保持身份，用 input 定位排列位置、answer 定位收纳正文，不按文本或 Observer 记录推断。等待队列不创建助手区域。区域并非正式 assistant 消息，不计入消息数。无跟踪关系的历史消息照常静态显示。

`binding/activities.ts` 只将 REOA 过程转换为当前提示；`binding/submission.ts` 解释结果、取消与反馈状态。responses 将这些提示归入助手区域，区分正文未确认、未加载、同步中、可用、缺失和错误。正式回答已经落实时，后续记忆等处理失败不在对话区追加内部诊断；Runtime 的失败结果与 Observer 诊断保持真实，不改成成功，也不依赖记忆错误码判断。未生成回答的失败或明确拒绝显示用户可理解的提示，不直接拼接服务错误正文。正文未取得、同步失败、取消及未知结果仍分别提示。正文先到时先展示，定位后到时收进同一区域、消重且不重新播放。历史过程仅来自客户端仍保留的已跟踪提交，不从已有消息推导执行历史。

对话只显示本次提交的一条当前进度，服务事实推进时原位替换文案；不展开 REOA 树，也不累积每一步的提示。binding 沿直接父子关系确定当前操作目的和正在工作的意图，例如“正在生成回答 · 调用模型”；同一模型调用进入记忆操作后会替换为“正在提取记忆体 · 调用模型”，不通过中文名称匹配猜测业务。再次尝试根据调用及祖先 round 明确提示，不推断重试原因。短阶段可能在一帧内结束，不为展示人为回放或延迟后续事实。

调用返回、父层接纳与提交结果仍是不同事实：子调用完成但结果待接纳时提示正在处理结果，只有 submission.result 才确定最终完成、失败或取消。当前过程提示替换通用的“等待回答”提示，避免同一次提交出现两个 loading。回答已落实但后处理仍在运行时，继续展示真实阶段；结束后不再保留过程提示或拼接内部过程诊断，正文尚未同步则保留独立的正文同步提示；未生成回答的失败和取消说明留在对应回应区域。

消息复制属于组件的局部交互，不进入 ClientRuntime 或全局 Store。用户和助手消息复制完整原文，助手保留 Markdown；打字显示游标只限制可见文本，不截断复制内容，也不复制进度、错误提示或按钮文字。本地输入占位可以复制自身输入；没有正式正文的助手区域没有复制入口。剪贴板失败只反馈本次复制失败，允许重试，不改变提交或正文状态。浏览器回归 `/test/copy.html` 使用模拟剪贴板，不改动系统剪贴板。

反馈连接中断、过程来源不完整时停止运行中 loading，说明状态待确认并标注最后收到的进展；重新连接不能提前恢复运行确信。过程来源故障不改写消息和提交结果。React 只消费精简的 `ConversationProcess` 读模型，不接收完整调用列表。客户端仍保留已有调用事实，展示变化不改动协议、运行状态或观测详情。过程提示不计入消息数量，不发回模型，也不驱动队列。

### 对话滚动与回应空间

最新回应自身持有按视口、输入块和间距测量的最小高度；正文逐步填充空间，不依据完整文本长度提前展开。短回答完成时保留空间，下一回应出现时转移。若有尚未关联的正式内容在其后，则不在内容前插入留白。

presentation/conversation/scroll.ts 只维护 DOM 几何和阅读意图，不消费服务协议。用户上滚后保持自主阅读，正文播放、过程更新和自动派发不会恢复跟随；主动即时发送、点击回到最新或手动向下滚至实际底部可以恢复。尺寸变化使位置被动夹到新底部不表示用户要求恢复跟随。显式发送的定位在用户输入出现时消费，不因延迟挂载助手区域而再次定位。转移留白和调整输入区/视口尺寸时，依据此前保存的可见行身份和偏移保持阅读锚点。正文播放完成、服务处理完成、反馈结束都不决定滚动状态。

真实浏览器回归可打开 `/test/conversation.html`，检查助手区域复用、占位到正式输入、短回答留白、长正文跟随、自主阅读、队列自动派发和 Enter/取消交互；不连接服务或调用模型。

### 记录来源完整性与父调用详情

外部交互详情走独立、按需的 `interactionLinks` / `observeInteraction`：先取得所选调用资源记录明确关联的 ID，再订阅交互元数据。`InteractionObserver` 持有这些短期连接，检查身份、不可变描述和修订单调；切换对话取消旧范围，晚到响应不能进入新范围。它不重发模型，不写提交结果，不合并进入全局记录 Feed。组件关闭即停止消费。

`binding/interactions.ts` 将本次返回、外部反馈与父层 relation 组合成 InteractionView，卡片只渲染明确的展示字段。分别解释本次返回 pending、外部 pending/received/unavailable、父层接纳。received 只说明反馈信封已取得，不能证明业务内容通过校验；仅启用持久化时显示已保存。观测断开保留最后事实并明确提示，不把连接错误改写为交互失败。独立浏览器 fixture `/test/observation.html` 验证重连资格与迟到反馈展示，不访问服务或真实模型。

记录流每次连接通过服务端来源的 `open({ change, incomplete })` 建立一致基线，再按连接自己的 `scopeId/sequence` 接收增量；连接重建会更换交付范围，不改变来源 `recorder.id/revision`。`SOURCE_INCOMPLETE` 表示记录来源已经缺失事实，不是客户端落后。该错误终止本次记录流，不触发自动基线重试，已接纳的记录保留并与观测错误共同展示。重新连接同一个失效来源也不能生成健康基线。消息实体同步有独立消费出口，记录失效不会停止消息同步或禁止对话。

副本接纳 `runtime-call`、`relation-appended` 及所属父调用的 E 入口阶段元数据，调用过程和父层关系历史分别保存，通过调用内 `eventSequence` 对照先后；它们不代替来源 revision 或连接 sequence。活动 R 调用的基线保留其已结束但仍待父层接纳的 E 子树。单轮快照必含 `runtimeCall/runtimeEvents`，表达父运行调用及其独立计时范围；执行 E 仍对应一个 QA。应用绑定把父调用、关系变化和资源事实整理进详情，主图不会把 R 计成新问答，也不会用 E 成功推断 R 接纳成功。
