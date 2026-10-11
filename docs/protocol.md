# Observer 跨端契约

## 包边界

`@capix/protocol` 是唯一跨端依赖。只公开可序列化数据、记录引用解析与完整性校验；不包含运行实体、HTTP 实现、模型供应商格式或图谱投影。所有跨包导入使用公开出口。

`@capix/server-runtime` 持有 REOA、Context、Invocation、RecordBook、Transcript 与 Memory 等现有运行对象，不依赖服务或应用。`services/observer` 装配当前筛选、回答、提取场景及模型适配器。`client/runtime` 通过 protocol 读取和提交，保存本地提交状态与已观测数据，不依赖 React 或服务端。`client/http` 的 HttpTransport 基类处理 HTTP，ConversationHttpTransport 与 ObservationHttpTransport 两个子类分别通过公开接口实现 ConversationTransport 与 ObservationTransport，接纳具体响应与 NDJSON 消息，客户端 Runtime 不反向依赖它。`apps/observer` 装配客户端 Runtime 与 HTTP 实现，负责 React 界面与前端投影，不导入服务端。对话交付与观测分别接入，见 [客户端 Runtime](client-runtime.md)。

## HTTP

- GET `/api/conversation/admission` → ConversationAdmission（当前集合身份及 ready/busy/unavailable；不预占、不探测模型）。
- GET `/api/config` → ConfigurationResponse（配置与 configured，绝不返回 key）。
- GET `/api/transcript?id=集合ID` → TranscriptSnapshot（id/revision/start/end/starts/messages）。不指定 ID 表示当前对话集合；未知 ID 返回 404，服务只暴露装配进来的集合。数组位置仍是全量 Transcript 的绝对 index。
- GET `/api/transcript/observe?id=集合ID` → 独立 TranscriptUpdate（baseline/delta/error）。首帧是同一同步边界的消息基线，后续仅传实体增量，不带调用记录；该订阅独立于观测。
- GET `/api/executions` → ObserverOverview：仅含 transcriptId 与消息索引/计数，不含消息正文；搜索由客户端消息副本提供，执行列表包含 InvocationSummary（计时和身份，不含 IO/processes）、固定 transcriptRange、availableMemoryIds 和 memoryChanges 简介。
- GET `/api/execution?id=记录ID` → ExecutionRecordSnapshot。仅在打开详情时请求；返回当前完整记录。
- GET `/api/memory` → MemoryObservation。记忆正文、来源与已生成的变更记录。
- GET `/api/source?file=路径` → SourceResponse。路径为仓库相对源文件路径，服务端白名单验证。
- POST `/api/run` 接受 ConversationSubmissionRequest `{ submissionId, input: ConversationRequest }`。首次发送建立服务提交对象并启动运行，200 返回 NDJSON，每行是完整的 ConversationSubmissionSnapshot；输入已落实、任务已结束或投影失效时即可开始交付。客户端生成 submissionId，使首个响应丢失后仍可查询；该身份不提供幂等重提承诺。
- GET `/api/submissions/:id` 返回当前累计提交投影；GET `/api/submissions/:id/follow` 同步衔接当前投影与后续变化。关闭任意反馈连接仅解除消费，不取消已启动的服务运行。终态或进展解释不完整时本次连接结束；后者仍可显式查询最终任务结果。
- POST `/api/submissions/:id/cancel` 以同源 JSON 请求取消已登记的运行，返回累计提交投影。重复请求在保留期内幂等；未知身份仍返回 SUBMISSION_UNAVAILABLE，不登记取消标记，也不能据此认为原请求不会执行。取消控制不关闭原反馈或消息同步。
- 提交投影包含 submissionId、revision、可选 input 范围、可选 answer 定位、executions Context 身份数组、可选 cancelRequested、result 和 integrity。输入与回答来自实体正式写入点；executions 来自选定声明的调用现场；result 在 R.run 实际返回或抛错后形成。投影不包含原文、Record 或运行对象。cancelRequested 只表示已请求停止；result 为 completed/failed/rejected/cancelled，只有本次运行实际以可识别的取消原因退出才报告 cancelled。已有输入、回答和记忆不回滚，取消与完成竞争可以得到 cancelRequested + completed；单纯信号已取消不能遮蔽独立故障。
- 可选 activities 是本次提交的有界 REOA 过程投影，包含 calls 和独立 integrity。Observer 默认启用；不安装 Recorder 也可使用。每项仅含 contextId、直接 parentContextId、level、label、status、phase、round、可选开始/结束时间以及父层 relation。过程、内容落实、提交结果分别判断；活动来源失效不关闭提交反馈，也不影响消息同步或运行结果。
- 明确的输入拒绝返回 400、忙碌拒绝返回 409，响应体可以是保留下来的提交投影，客户端应接纳其中的 rejected 事实。已经接纳输入后的失败通过累计投影表达，回答不会因后处理失败撤销。仅有网络状态码不能替代正式运行事实。
- GET `/api/observe` 独立返回 NDJSON ObservationUpdate：baseline 建立当前事实与来源游标，delta 携带 scopeId/sequence 和明确变化，error 表示观测异常。关闭连接仅解除订阅，不中断对话执行。基线与订阅同步衔接，每个连接都有独立 scopeId，首帧 sequence 为 0。序号缺口最多自动重建一次基线；SOURCE_INCOMPLETE 是记录来源已缺失事实的终止控制，不自动重试，也不能通过重连同一来源补救。不提供历史重放或跨查询一致性承诺。
- 除上述正式提交拒绝外，HTTP 非 2xx 返回 ErrorResponse。无保留项时提交查询返回 404 / SUBMISSION_UNAVAILABLE，不能据此断言未执行；相同身份仍保留时 POST 返回 409 / SUBMISSION_EXISTS，不启动第二次工作。记录来源失效后，观测流及 executions/execution/memory 查询明确返回 SOURCE_INCOMPLETE；实体查询与订阅不依赖记录完整性。不改变现有运行失败的事实记录。

## 可选文件任务

`ConversationRequest.fileTask` 为 `{ sourcePath, output?: { path } }` 或 `{ output: { path } }`，路径相对于服务端显式配置的工作目录。`ConfigurationResponse.files` 存在时表示支持此任务，给出 `maxReadBytes/maxWriteBytes`；不公开宿主绝对路径。合法路径、结构和启用条件在追加输入前检查，文件预检先检查命名来源、目标及元数据；实际读写仍独立检查存在性、UTF-8、字节上限及禁止覆盖。自然语言候选中的配置根内绝对路径可由服务规范为相对路径，正式 fileTask 契约仍只使用相对路径。原文和结果仍以正式 user/assistant 消息同步，文件正文不进入提交反馈。

服务在 E 接纳任务后发布 `task`：`reply`、`file { task: FileTask }`、`clarify` 或 `unsupported`。决策候选和预检结果不发布为 task，只有正式执行分支启动或最终澄清/不支持时发布。它是本轮稳定的分支选择，不能更换或消失；出现前必须已有正式输入。普通自然语言也可得到 file 任务，客户端不从文本识别路径。显式 fileTask 是完整约束，远端不能偷偷扩大或换成普通回答。首次累计快照可以同时含 input、task、回答及终态。

提交的 `fileOutput` 独立表达结果文件：`pending`、`created`（path/bytes/SHA-256 digest 回执）、`not-created`（not-started/cancelled/failed）或 `unconfirmed`。requested 来自 E 正式选择含输出的文件任务；started 与发布结果来自实际文件端点。端点完成发布后立即发出 created，即使稍后取消、父层接纳或记忆处理失败也保留。工作结束时，完整来源证实尚未开始的输出为 not-started；已经开始但缺少可信结果的输出只能是 unconfirmed。

没有 `fileOutput` 只表示尚未收到该项事实，不等价于未创建；输入拒绝、尚未进入受理通知等情况可以没有该字段。客户端保留本地路径意图，与服务事实区分。已确认终态不可回退；任务终态不能携带 pending，受理拒绝不能同时携带文件执行事实。文件投影失效不改写执行结果或已经确认的创建回执；缺失任务归属时不发布无归属的文件结果，并标记反馈解释不完整。回答先正式落实，再执行保存；保存失败和记忆失败都保留正文，文件组件独立显示保存结果。

文件任务复用提交查询和 follow，不另建文件同步集合，也不因反馈断线重做。SHA-256 标识本次实际读取/发布的字节，不承诺外部文件今后不变化。当前仅提供结果路径与回执，没有下载、任意路径浏览、覆盖、追加或删除接口。`/api/source` 仍是独立源码白名单端点。

## 身份、顺序与时间

submissionId 是服务请求的关联身份，Context.id 是一次内核调用身份，Record.id 是可选观测载体身份，三者互不替代。一次提交可关联零个或多个 E；即使不启用 Recorder 也能取得消息落实和调用进展。投影 revision 仅表达该提交解释状态的变化，允许连接合并中间状态后交付更高修订；它不是调用顺序、消息 revision 或观测游标。累计事实不可回退，同修订必须等值。

executionId/operationId/parentOperationId 指向记录；消息 index 永不随切段重排。resultOf 只引用同一记录内先前的 execute/receive/handling return 正文；最终结果必须由最后一次 receive.return 或 handling.return 接纳，消费者使用 readOutput，不复制存储正文。

服务提交对象拥有运行任务、独立取消控制器与投影，反馈连接只读取。运行信号传给 R.run，不借用 HTTP 连接信号；能力不合作时继续等待，不提前释放占用。当前最多保留 128 项，结束项按 5 分钟 TTL 或容量淘汰，活动项不淘汰；容量不足拒绝登记，不隐含排队。一个连接最多保留一个待发最新投影，慢连接不反向等待业务。此保留不保证重启恢复、幂等执行或历史重放。

## 接纳条件与下一笔提交

ConversationSubmissionSnapshot.result 只说明这一笔已经完成、失败、取消或未被接纳；其发布在 runtime.run 实际返回/抛错和占用释放之后。admission 是附带的当时服务接纳提示，与不可变结果分开。旧提交的 read/follow 不能充当当前服务可用性查询；需要时 GET /api/conversation/admission 读取实时条件。辅助提示读取失败不能阻断运行进展或结果发布。

ConversationAdmission 只公开 transcriptId、status，以及 unavailable 时的 error。服务从实际 runtime.running、配置、已知模型构造/能力不可用和保留容量取得依据；查询不主动兑现惰性 Provider。ready 表示允许尝试接纳，不能保证之后模型成功，也不保证查询到 POST 之间没有竞争。最终受理检查仍在服务端。

rejected.retry:admission 是明确未接纳且允许再次尝试受理的声明，当前用于忙碌、保留容量不足或已知环境不可用造成的未接纳；不能带已经落实的 input、answer 或 execution。它不表示重新执行失败业务。客户端保留同一本地队列项，再次尝试时创建新的 submissionId；旧身份仅用于其结果查询。同身份重复 POST 仍拒绝，不增加幂等执行承诺。

单轮输出失败和后处理失败不等于服务失去接纳能力；相反，服务空闲也不证明某个反馈丢失的提交没有执行。结果未知必须继续确认原身份，不能依据 admission 自动重发。等待项不因前一笔失败被清空，服务不可接纳时也不应逐条消耗后续输入。

## 对话处理过程

被动 InvocationProgress 由调用结构发布，运行绑定在每次 R 调用选择全 REOA 来源，服务直接投影明确事实；不从记录、消息数量或两份快照差异反推。ConversationSubmission 的 activity 与内容 progress 通道独立隔离。活动关闭或消费者失败不参与业务接纳，不影响运行。

ConversationActivity 使用 Context 身份，status 为 running/succeeded/failed/cancelled，phase 为 setup/execute/receive/handling/control，round 为本调用处理轮次（0–2）。同一次 O 继续处理时保留自身身份并更新轮次，新建 A 有独立身份。短调用完成后仍保留条目。started 之前的建立失败可只有 finishedAt，不补造开始时间。

relation 描述父层处理该子调用的 attached/returned/receiving/accepted/failed，并保留真实返回 succeeded/failed/cancelled。子调用成功与父层接纳不是同一事实；子调用工作成功但交付失败时可以同时出现 status:succeeded 与 relation.returned:failed。取消请求 ACK 不结束任何条目，只有已发生的调用退出更新其状态。调用进展不替代提交 result，异常重试中的子失败也不推断整轮失败。

活动仅公开名称、归属和进展元数据，不传输入输出、诊断正文、模型思考、源码或资源对象。label 最多 120 字符，每次提交最多保留 512 个调用位置（包括等待子调用开始的关系）。超限或来源顺序/关系失效后保留已知前缀，activities.integrity 永久变为 ACTIVITY_INCOMPLETE；后续内容与最终 result 继续更新。调用局部 eventSequence 用于服务接纳，不混入交付 revision。查询与 follow 返回同一有界累计状态，不承诺完整过程事件回放。

执行列表按实际登记顺序。边界事件 scopeId 确定计时范围，sequence 与单调 offsetMs 是范围内部时序依据；R 调用和每个 E 分别计时，EOA 共用 E 范围。occurredAt/startedAt 是展示用墙钟。未结束调用没有 durationMs；不得补造耗时。跨 QA 只有先后关系，前端使用等宽列，轮内才按计时比例布局。

availableMemoryIds 来自本轮输入快照，只表示可见，不能宣称模型实际采用。selections 是选择操作结果；容量裁剪后的最终原文与候选有区别，详情必须以实际请求记录为准。response 即使后处理失败也可以存在。

## 异常处理过程与失败分类

ProcessRecord 的 stage 包含 execute、receive、handling、control。receive 仅表示正常结果接纳，handling 表示异常声明的 start/return/continue/unhandled/throw；继续仍属于同一次调用，不新增执行层次。InvocationEvent 的过程 stage/action 与记录契约对应，不携带任意业务 IO。过程条目的 sequence 仅用于过程及 resultOf 引用，eventSequence 则与同调用的关系事实对照先后。

InvocationFailureFact 表达 kind(exception/error)、phase(setup/execute/receive/handling/control/observation)、contextId，以及仅异常适用的 contract。调用失败正文、过程和相应增量可携带这组解释事实；错误正文仍由 RuntimeErrorValue 表达。contract 是服务端契约名称的说明，跨端字符串不赋予处理、重试或恢复资格。

Context 的业务完成状态与调用交付失败可能不同，例如工作成功之后终态记录失败。客户端不能因为最终失败就撤回消息实体中已经成立的回答，也不能把未知状态解读为尚未发生。业务流、记录流和消息实体同步保持各自职责，当前不新增通用恢复指令。

UI 的读模型和组件接口不属于本协议，见 [客户端与应用绑定](client-runtime.md#应用绑定与-store)。

## 内容变化记录

MemoryRecord 的 executionId/operationId 改为可选，contextId/callId 可选并标识实际来源调用；由运行外部直接接纳的记忆变化没有虚构调用归属。TranscriptRecord 的 append 仅含 start/end，不附带原文；它表达追加或分段，包含 transcriptId、revision、occurredAt 与可选调用来源。transcriptId/revision 将内容事件与其记录关联；MemoryRecord 使用 memoriesId/sequence。内容记录通过观测增量传输，但不加入 ExecutionRecordSnapshot 的 EOA 节点列表。

## 记录安装根记录与通用命名

BaseRecord 表达身份、直接 parentId 与正文；CompositeRecord 增加 childIds。RecordingRootRecord 是具体根记录，value 当前只有 createdAt；RuntimeCallRecord 表达单次 R 调用，InvocationValue 是 R/E/O/A 共用调用正文，分别保留 processes 与 relationChanges。Recorder 是服务端环境登记机制，不属于跨端协议。RuntimeContext 是运行现场，也不加入协议。

记录树为 RecordingRootRecord → RuntimeCallRecord → ExecutionRecord → OperationRecord → AttemptRecord，其他记录依自己的产生位置挂接。每层直接 parentId 指向对应父记录，不因下游查询方便把全量祖先身份塞进基类。

ExecutionRecordSnapshot 仍以一个 E 为查询范围，包含其 E/O/A、边界与资源事实；同时包含必填父层 runtimeCall、runtimeEvents 及 R 直属资源事实，不附带 记录安装根正文或 R 的其他 E 子树。runtimeCall/runtimeEvents 缺失的旧快照不再接纳；runtimeEvents 仅包含 R 自身的边界，不能混入 E 的 events。响应外的 parentId/childIds 引用不意味着已完整装载整棵树。观测基线携带 记录安装根与活动 R 的局部子树；E 已完成但 R 仍在接纳时，该 E 子树继续保留。其余已完成正文按需查询，R 不作为新 QA 计数。

relationChanges 保留父层真实发生的 attached、returned、receiving、accepted、failed，含父子 Context、父轮次、可选 key/子记录 ID 和 eventSequence。returned 是子层结果，accepted 才是父层完成接纳；failed.source 区分接纳工作与观测故障，不能从 E 成功推断 R 成功。交付游标与各来源顺序分开，不承诺持久化或业务恢复。

## 变化与交付

ObserverChange 是已知来源的联合：TranscriptEvent、MemoryEvent、InvocationEvent、RecordChangeEvent。生产者仅依赖本类的 ChangeCapture<E>；联合类型用于装配与跨端接纳，不赋予公共捕获器业务分派职责。InvocationEvent 只包含身份、直接父级、进度、子关系、入口阶段和终态元数据；E 尚未建立时，所属父调用可发布 entry，标明目标实例、accept/notification/admit/capture 阶段及结果，不伪造 E Context 或记录。任意业务 IO 留在业务通道或记录中。

RecordMutation 分为 added、process-appended、relation-appended、finished、replaced。added 携带新记录与直接父级新增引用；process-appended 与 relation-appended 分别只携带本次新增过程或关系条目；finished 保持 resultOf 正文复用。replaced 是通用显式更新的后备形式，不是快照 diff。record entry 的 kind 由具体记录类声明。

ObservationBaseline 的 sequence 固定为本连接的 0，另带独立的 Transcript revision、Memories sequence 和 Recorder revision。后续非空批次递增连接 sequence。ObservationDelta 使用 ObservationChange：原文 append 转为 start/end 通知，原文正文只走实体通道；其余确定性变化保持原契约。ObservationDelta.changes 保留捕获顺序，整批交付不等于跨源事务。客户端先检查交付位置，再检查各来源顺序，整批成功才公开新状态。

服务环境只由一个 ChangeConsumer 排空变化捕获器，记录来源与消息实体出口共享消费结果。RecordSource 在事实产生前建立，并经 open({ change, incomplete }) 固定基线和来源水位；每条连接有独立交付范围，重连更换 scopeId，不重置来源 revision。失效来源永久拒绝新基线，发送层丢弃尚未发送的普通批次，等待连接可写后发送 SOURCE_INCOMPLETE 并结束；不会撤回已经交给网络的字节。HTTP 连接的待发数据与 writableLength 合计上限为 16 MiB，超限断开连接，不等待慢客户端拖住运行。捕获器不持有已交付历史，不支持游标重放、消费确认或持久化恢复。

## 资源事实与实体同步

`ExecutionRecordSnapshot.resources` 为 ResourceRecord 数组。每条事实具有自身 id、直接 parentId（R/E/O/A 调用记录）、access、supplyId、sequence、occurredAt、phase 和由资源契约定义的 value。sequence 在所属调用的资源事实范围内递增；bound 先于 available/unavailable，started 与 returned/threw 以 interactionId 配对。运行与异常处理阶段的端点共享此序列，同一供给的 bound/available 不因阶段切换重复发送。资源顺序、调用过程 sequence、实体 revision 和发送者 sequence 各有边界，不互相替代。

静态申请/供给不产生记录。调用内资源端点兑现及方法执行才产生事实。描述函数不会在关闭记录时运行；供给失败与已完成工作后的记录失败保持不同证据，不把后者重新解释成业务失败。

消息定位使用 MessageLocator / TranscriptRangeLocator，记录不包含活 Ref。范围可带捕获时的 revision；客户端允许用更新的追加型消息副本读取旧范围，但不能因此扩大原范围。没有加载、加载失败、版本/位置缺失与空消息分别表达。MemoryObservation.sources 同样只提供消息定位符；记忆变更结果保持既有不可变记录。

客户端 TranscriptReplica 在首基线之后检查集合身份、严格连续 revision 和追加/分段边界；重复版本不推进副本。消息连接中断与修订缺口由 TranscriptReceiver 有限退避重建基线，主动停止后须显式再次订阅；策略见客户端文档。基线不能改写已接纳正文或分段前缀，身份/内容冲突及来源失效停止自动恢复。不对未加载集合缓存无限增量。当前端点提供完整集合基线，不实现分页、历史重放、持久化或跨集合事务。
