# 客户端 Runtime

ClientRuntime 装配提交跟踪、消息同步与可选观测消费，协调它们的已接纳状态并发布快照，不依赖 React、HTTP 实现或服务端对象。client/runtime 公开 ConversationTransport、TranscriptTransport 和 ObservationTransport 三个契约；应用通过 conversation / transcripts / observation 具名参数接入。

接口分类不等于 HTTP 实例拆分。ConversationHttpTransport 同时实现业务交付和消息实体契约；ObservationHttpTransport 提供独立的观测接口，两者共用通用 HttpTransport。

## 内部职责归属

| 对象                | 自己维护的范围                                           | 与 ClientRuntime 的接缝                                                                                   |
| ------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| ClientSubmission    | 一笔提交的身份、累计事实、当前反馈连接及通知状态         | Runtime 选择 POST 或 follow，授予已初始化的 transcriptId；对象报告局部变化，Runtime 在发布后通知 accepted |
| TranscriptReceiver  | 各消息集合的订阅、基线、副本和同步状态                   | 报告已接纳的集合状态；Runtime 协调初始化与当前对话正文                                                    |
| ObservationReceiver | 可选观测连接、来源副本、详情缓存和旧响应隔离             | 报告完整 ObservationState；不取得 Runtime，也不操作提交或消息                                             |
| ClientRuntime       | 初始化门控、当前提交选择、跨来源协调、公开快照与通知顺序 | 保持应用已有入口，不再直接维护各消费对象的连接控制器                                                      |

ObservationReplica 只接纳观测基线与增量，连接生命周期在 observation/receiver.ts；两者按职责组织在 observation/ 下。Receiver 是包内实现，不增加应用装配入口。初始化要协调配置与消息，快照发布要协调多个来源，二者仍留在 Runtime；没有增加通用连接管理器、事件总线或调度框架。

ClientSubmission.connect 接收连接函数和窄的 SubmissionReception（transcriptId、changed），不持有整个 Runtime 或 transport。它自行校验集合归属、隔离旧连接、解释反馈结束与断开；由 Runtime 决定何时允许新提交、重连或释放跟踪。stopFollowing 先完成本地状态转移再解除连接，由调用方协调这次停止的状态发布，避免停止过程重复通知。

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

ConversationTransport 提供 config、submit、follow；TranscriptTransport 提供 transcript(id?, signal?) 查询与 observeTranscript(id, accept, signal) 订阅。transcripts 是必需接入：对话正文由消息实体副本提供，不从观测记录生成。

initialize 并行取得配置和当前集合订阅的首帧基线。同一次进行中的初始化返回同一 Promise；失败不会永久缓存 rejected Promise，之后显式 initialize 会建立新尝试，不自动重试。配置与实体各自成功时分别保留已经确认的内容，后续尝试复用配置和健康实体连接；不能因为保留了部分配置就提前允许 submit。配置慢于实体流时，最终采用已经接纳的最新消息副本，不能把首帧旧内容覆盖到新增量之上。初始化结束前再次确认实体同步仍然有效。初始化不会请求执行概览、记忆或记录详情。

state.initialization 表达本次环境初始化的 idle、running、succeeded、failed 或 stopped；开始后携带本地 attempt 序号，failed 保留原错误。InitializationAttempt 只管理这个有限过程的状态与 Promise 结束权，不依赖服务端 Invocation，也不引入全局环境管理者。当前场景没有声明可恢复的业务异常，配置与同步失败直接结束本次尝试，不交给伪造的异常 handler。该状态只表示初始化结果，后续实体连接是否持续有效仍由 TranscriptState 表达。

stopTranscript 停止当前集合或全部集合时，也结束正在进行的初始化；已确认的配置和消息副本保留。旧尝试随后返回的配置被忽略，停止的实体连接回调也不能写入，新 initialize 可以明确建立下一次尝试。这不等于取消服务端工作，也不改变服务端 Initializer 的一次构造及失败缓存规则。

业务状态包含 messages、transcriptId、transcripts、submission 和初始化错误。messages 是当前集合已接纳 snapshot.messages 的便利引用；权威副本保存在按 UID 索引的 transcripts 中。submission 保存本地 id/pending、已确认的 remote 累计投影及 feedback 连接状态；busy/pending/contextId/answered 只从 submission 派生，不另外维护一套执行真相。

1. submit 为本次提交生成 submissionId，复制输入，仅调用一次 POST。正在跟踪且尚无 result 时拒绝新提交，不排队、不自动重发。
2. remote.input 来自正式消息写入位置，首次确认后在公开状态发布阶段调用一次 accepted(submission)。HTTP 200、收到首帧或建立 E 都不等于输入已接纳。回调接收该提交的不可变快照，必须同步返回 undefined；抛错或意外返回 Promise 只保存 notificationError，不停止接收或改写服务结果。
3. remote.executions 保存服务选择关联的 E Context 身份，可以为空或多项；输入在 E Context 建立前也能正式落实。remote.answer 只指向已落实回答，正文来自独立实体同步，不从记录或提交反馈重复追加。
4. remote.result 是服务任务 completed / failed / rejected。后处理失败保留已确认回答；completed 只表示任务返回，不凭空补造 input/answer。remote.integrity 说明服务进展解释是否完整，与任务结果分开。
5. feedback 表示 connecting / following / ended / interrupted。断流、网络失败或投影不完整都不能证明服务执行失败；保留所有已确认事实。消息实体和观测同步失败各自保存在对应范围，不撤回提交结果。
6. reconnectSubmission 只 follow 同一 submissionId，不重新发送输入。新连接接收当前累计投影，允许 revision 跳跃；忽略旧修订，同版本冲突、事实回退或更改必须拒绝。旧连接回调不能写入新连接状态。
7. stopFollowing 只停反馈连接，releaseSubmission 明确结束本地跟踪并允许后续提交；两者都不是取消服务端运行。服务端未知、已淘汰或重启后丢失的 submissionId 仍表示结果无法确认，不能推断“没有执行”。

本轮只恢复反馈，不恢复执行。服务端保留是有界进程内状态，不提供幂等重提、持久化、离线重放或重启后的任务恢复。实体同步和可选观测有独立连接与接纳规则。

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

## 消息实体的按需加载与同步

```ts
await runtime.loadTranscript(transcriptId); // 首次获取原子基线，随后持续同步
runtime.stopTranscript(transcriptId); // 保留副本，停止这个集合的连接
await runtime.loadTranscript(transcriptId); // 建立新基线，不声称能重放离线增量
```

每个 TranscriptState 保存 snapshot、loading、syncing 和 error。snapshot 为 `{ id, revision, start: 0, end, starts, messages }`；revision 覆盖消息追加和分段变化。当前会话初始化时主动同步，只有被记录提及的其他集合默认不加载、不积压未订阅的增量。

GET /api/transcript/observe 首先交付 baseline，随后交付带完整消息正文的 TranscriptEvent。服务端在同步临界区内衔接快照和订阅；客户端不通过先 GET 再订阅推测这个接缝。GET /api/transcript 是明确的按需查询与补取接口。

TranscriptReplica 检查身份、revision 和范围：重复版本忽略，新增版本必须连续；追加必须从已知 end 开始；分段必须衔接已知 starts。接纳失败不部分修改旧副本。集合版本与观测交付 sequence 完全独立。

TranscriptReceiver 为已知 UID 复用订阅。默认集合与显式 UID 在首帧前并发订阅时，身份确认后合并连接，并正常兑现等待者。一次连接的顺序缺口、提前结束或网络断开最多自动重建一次基线；再次失败保留最后副本、停止同步并暴露错误。协议/远端拒绝不会被无限重试。显式重新加载可以再次建立基线；没有 replay、ACK、持久化或历史版本仓库。

快照查询与流增量可能交错：接收层只让较新或同版本的有效快照更新副本，旧响应不覆盖新状态。停止后的回调被忽略。stopTranscript 与 startObservation 返回的解除函数互不取消；观察停止不会停止消息同步或当前业务。

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

观测连接仅接受一个首帧基线。顺序缺口最多自动取得一次新基线，连续失败明确报错；SOURCE_INCOMPLETE 则直接停止，不自动重连。普通断线不无限重连，refreshObservation 可显式重建健康来源的连接，不能修复已失效来源。旧连接回调和详情响应不得覆盖新连接。关闭观测不停止服务端记录。

## HTTP 包边界

HttpTransport 只处理地址、HTTP 状态、JSON 读取和错误，不感知业务、实体或记录。

- ConversationHttpTransport：config、POST /api/run、GET /api/submissions/:id 与 /follow、transcript 查询和 GET /api/transcript/observe。提交响应逐行接纳 ConversationSubmissionSnapshot，HTTP 拒绝也可能携带正式投影；实体流接纳 baseline/delta/error，不将断流当作业务完成。
- ObservationHttpTransport：overview、memory、execution、source 和 GET /api/observe。观测流可覆盖多次执行，结束不代表业务完成。
- 普通响应由 Zod 接纳；记录详情由 validateExecutionRecordSnapshot 验证并核对请求身份；消息实体还由接收层检查范围与版本。

readLines 只负责 UTF-8 解码与行拆分。回调同步执行，失败后关闭 reader；HttpError 保留 HTTP 响应，HttpTransportError 区分 contract / remote / delivery，网络异常保留原异常。取消实体或观测连接只解除对应交付。发送缓存有限，慢消费者断开后通过新基线接续，不承诺离线追赶。

## 应用绑定与 Store

- binding/application.ts 装配 Store 和命令，独立开启观测及对话初始化。初次连接立即投影，后续 Runtime 通知合并到 requestAnimationFrame，执行时读取最新公开快照，完成投影后一次写入 Store；这与 Runtime 的接纳和微任务发布是不同边界。卸载取消待处理帧并分别停止观测和实体订阅；重新挂载恢复实体同步，保留已取得的配置与 UI 编辑。投影失败只显示本地提示，后续成功投影可继续更新。
- binding/data.ts 组织业务消息与进度，并组合可选观测；binding/submission.ts 将已确认事实和反馈状态转换成提示，提供重新同步和结束跟踪入口。对话正文只来自消息实体副本。
- binding/observation.ts 按 UID/index 组合消息、上下文和记忆来源，明确区分未加载、加载中、缺失与错误；实体到达时即便记录未变化也重建对应读模型。
- binding/resources.ts 解释应用约定的配置与历史范围资源事实；details.ts 为各调用组织资源事实列表，React 不解析原始 ExecutionRecordSnapshot。
- projectConversation 仅给当前同一消息集合中的已有消息添加执行链接，不能用相同 index 跨集合猜测关联。
- Store 保存应用读模型及草稿、预算、搜索、选择和弹层状态。组件持有局部 DOM、滚动和加载提示；未知原文提供加载入口，消息同步失败提供明确提示和重新连接入口。

对话仍用 Streamdown 静态渲染助手完整回答，用户输入保持纯文本；use-stick-to-bottom 处理滚动。消息图片只显示说明及显式链接，不自动加载外部资源。

### 记录来源完整性与父调用详情

记录流每次连接通过服务端来源的 `open({ change, incomplete })` 建立一致基线，再按连接自己的 `scopeId/sequence` 接收增量；连接重建会更换交付范围，不改变来源 `recorder.id/revision`。`SOURCE_INCOMPLETE` 表示记录来源已经缺失事实，不是客户端落后。该错误终止本次记录流，不触发自动基线重试，已接纳的记录保留并与观测错误共同展示。重新连接同一个失效来源也不能生成健康基线。消息实体同步有独立消费出口，记录失效不会停止消息同步或禁止对话。

副本接纳 `runtime-call`、`relation-appended` 及所属父调用的 E 入口阶段元数据，调用过程和父层关系历史分别保存，通过调用内 `eventSequence` 对照先后；它们不代替来源 revision 或连接 sequence。活动 R 调用的基线保留其已结束但仍待父层接纳的 E 子树。单轮快照必含 `runtimeCall/runtimeEvents`，表达父运行调用及其独立计时范围；执行 E 仍对应一个 QA。应用绑定把父调用、关系变化和资源事实整理进详情，主图不会把 R 计成新问答，也不会用 E 成功推断 R 接纳成功。
