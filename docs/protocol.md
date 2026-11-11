# Observer 跨端契约

## 包边界

`@weiliang0121/capix-protocol` 是跨端协议入口。共同的种类与诊断纯值从零实现依赖的 `@weiliang0121/capix-contracts` 显式重导；进程内 Work/子调用端口不会进入协议出口。只公开可序列化数据、记录引用解析与完整性校验；不包含运行实体、HTTP 实现、模型供应商格式或图谱投影。所有跨包导入使用公开出口。

`@weiliang0121/capix-structure` 持有 Callable/Scene/Group/Node，`@weiliang0121/capix-runtime` 负责结构构建与调用运行，宿主分别持有 RecordBook、Transcript、Memories 等独立实体；这些实体不进入 protocol，也不因装配而由 Runtime 统一拥有。Lab 的 `services/observer` 装配当前筛选、回答、提取场景及模型适配器。Lab 的 `packages/client-runtime` 通过 packages/protocol 读取和提交，保存本地提交状态与已观测数据，不依赖 React 或服务端。Lab 的 `packages/client-http` 的 HttpTransport 基类处理 HTTP，ConversationHttpTransport 与 ObservationHttpTransport 两个子类分别通过公开接口实现 ConversationTransport 与 ObservationTransport，接纳具体响应与 NDJSON 消息，客户端 Runtime 不反向依赖它。Lab 的 `apps/observer` 装配客户端 Runtime 与 HTTP 实现，负责 React 界面与前端投影，不导入服务端。对话交付与观测分别接入，见 [客户端 Runtime](client-runtime.md)。

## 记忆展示 DTO 与 P3 边界

Memory 的领域内容、变化与持久材料归 `@weiliang0121/capix-memory`，protocol 不导入或重导该服务端包。当前默认 wire 明确采用较窄的展示值：

- `MemoryViewValue = {content}`。
- `MemoryChangeEvent.change = {action,memoryId,value:MemoryViewValue,reason?}`，外层保留 memoriesId、sequence、occurredAt 和可选 origin。
- `MemoryObservation.items = [{id,value:MemoryViewValue,records}]`；`ConversationInspection.memories.items` 同样使用 `{id,value}`。
- `MemoryRecordValue = {action,reason?,result:MemoryViewValue}`；执行简介的 memoryChanges 使用可选 reason。

baseline 与增量必须采用相同投影，更新替换 value，不能保留旧项已经去掉的可选字段。默认 DTO 不包含 topic、消息来源、文件来源或未知 metadata；旧记忆记录正文拒绝。需要展示其他字段由业务显式定义投影和接纳契约。该投影不是完整实体快照、固定效果确认或 CP 恢复依据；完整 Stable 内容与请求需要自己的保真 codec，普通 JSON 不能保留 undefined、-0 或 null 原型差异。

P3 已更新 CAPiX 的实体、记录和协议。下述 HTTP 与客户端章节描述 Lab 参考服务的既有装配职责；其提取策略、持久 codec、HTTP decoder 与副本需后续独立迁移，本文不宣称 P4 已完成。

## HTTP

- GET `/api/conversations` → ConversationListResponse（目录与稳定默认身份）。
- POST `/api/conversations` 接受空 JSON 对象，返回新建 ConversationDescriptor。
- GET `/api/conversations/:id` → 指定对话元信息；未知身份明确失败。
- GET `/api/conversations/:id/submission` → ConversationSubmissionDiscovery `{ conversationId, transcriptId, submission?: ConversationSubmissionBaseline }`。只发现当前未结束的提交，不列历史、不创建运行环境、不兑现 Provider。没有活动项时省略 submission；保存了旧身份的客户端仍需 read 原 ID 确认结果，不能把本接口为空当作原提交未执行。

- GET `/api/conversation/admission?conversationId=对话ID` → ConversationAdmission（当前对话与集合身份及 ready/busy/unavailable；不预占、不探测模型）。
- GET `/api/config` → ConfigurationResponse（配置与 configured，绝不返回 key）。
- GET `/api/transcript?id=集合ID` → TranscriptSnapshot（id/revision/start/end/starts/messages）。ID 必须明确；未知 ID 返回 404，服务只暴露已登记对话的集合。数组位置仍是全量 Transcript 的绝对 index。
- GET `/api/transcript/observe?id=集合ID` → 独立 TranscriptUpdate（baseline/delta/error）。首帧是同一同步边界的消息基线，后续仅传实体增量，不带调用记录；该订阅独立于观测。
- GET `/api/executions?conversationId=对话ID` → ObserverOverview：仅含 transcriptId 与消息索引/计数，不含消息正文；搜索由客户端消息副本提供，执行列表包含 InvocationSummary（计时和身份，不含 IO/processes）、固定 transcriptRange、availableMemoryIds 和 memoryChanges 简介。
- GET `/api/execution?conversationId=对话ID&id=记录ID` → ExecutionRecordSnapshot。仅在打开详情时请求；返回当前完整记录。
- GET `/api/interactions?conversationId=对话ID&callId=调用ID` → CallInteractionLinks，仅提供该调用资源访问明确关联的外部交互 ID。
- GET `/api/interaction/observe?conversationId=对话ID&callId=调用ID&id=交互ID` → NDJSON InteractionUpdate。先读取所选调用关联，再交付累计元数据 snapshot；received/unavailable 是本次订阅终态。模型请求/回复正文不包含在此投影中，revision 属于交互已提交状态，保存失败可在同一 revision 表达 unavailable。连接失败与交互失败分别处理，不能由断流推断业务结束。恢复历史仅按 ID 读取，不触发模型或重发。
- GET `/api/memory?conversationId=对话ID` → MemoryObservation。当前 content 展示投影与该集合已生成的变更记录，不隐含来源字段。
- GET `/api/source?file=路径` → SourceResponse。路径为仓库相对源文件路径，服务端白名单验证。
- POST `/api/run` 接受 ConversationSubmissionRequest `{ conversationId, submissionId, input: ConversationRequest }`。首次发送建立服务提交对象并启动运行，200 返回 NDJSON，每行是 ConversationSubmissionFrame（baseline/submission/answer）；输入已落实、任务已结束或投影失效时即可开始交付。客户端生成 submissionId，使首个响应丢失后仍可查询；该身份不提供幂等重提承诺。
- GET `/api/submissions/:id` 返回 ConversationSubmissionBaseline（当前累计提交投影与可选预览）；GET `/api/submissions/:id/follow` 同步衔接当前投影与后续变化。关闭任意反馈连接仅解除消费，不取消已启动的服务运行。终态或进展解释不完整时本次连接结束；后者仍可显式查询最终任务结果。
- POST `/api/submissions/:id/cancel` 以同源 JSON 请求取消已登记的运行，返回 ConversationSubmissionBaseline。重复请求在保留期内幂等；未知身份仍返回 SUBMISSION_UNAVAILABLE，不登记取消标记，也不能据此认为原请求不会执行。取消控制不关闭原反馈或消息同步。
- 提交投影包含 conversationId、submissionId、revision、可选 input 范围、可选 answer 定位、executions Context 身份数组、可选 cancelRequested、result 和 integrity。输入与回答来自实体正式写入点；executions 来自选定声明的调用现场；result 在 Driver.run 实际返回或抛错后形成。投影不包含原文、Record 或运行对象。cancelRequested 只表示已请求停止；result 为 completed/failed/rejected/cancelled，只有本次运行实际以可识别的取消原因退出才报告 cancelled。已有输入、回答和记忆不回滚，取消与完成竞争可以得到 cancelRequested + completed；单纯信号已取消不能遮蔽独立故障。
- 可选 activities 是本次提交的有界 Callable 过程投影，包含 calls 和独立 integrity。Observer 默认启用；不安装 Recorder 也可使用。每项仅含 contextId、直接 parentContextId、kind、label、status、phase、round、可选开始/结束时间以及父层 relation。过程、内容落实、提交结果分别判断；活动来源失效不关闭提交反馈，也不影响消息同步或运行结果。
- `baseline` 携带完整提交状态与可选预览，只用于首次连接、查询、取消响应和慢连接追赶。正常 `submission` 帧为 `{ conversationId, submissionId, fromRevision, revision, change }`：只携带本修订区间已落实的字段、新增 execution 身份及变化的 activity 条目；`admission:null` 明确移除旧提示，省略字段表示未变化。变化由生产者安装事实时提供，微任务合并同一调用的最后状态，不比较完整快照推导增量。正文 `answer` 帧不会附带未变化的提交状态。
- 接收方从完整基线开始应用连续修订；控制查询可能取得流批次内部的基线，允许重叠区间中已知 execution 前缀与调用条目幂等合并，但不允许改变身份、顺序或回退状态。修订缺口停止当前反馈消费，重连仍取得明确完整基线，不重 POST。内部累计快照和传输增量是不同形态。
- 明确的输入拒绝返回 400、忙碌拒绝返回 409，响应体可以是保留下来的提交基线，客户端应接纳其中的 rejected 事实。已经接纳输入后的失败通过累计投影表达，回答不会因后处理失败撤销。仅有网络状态码不能替代正式运行事实。
- GET `/api/observe?conversationId=对话ID` 独立返回 NDJSON ObservationUpdate：baseline 建立当前事实与来源游标，delta 携带 scopeId/sequence 和明确变化，error 表示观测异常。关闭连接仅解除订阅，不中断对话执行。基线与订阅同步衔接，每个连接都有独立 scopeId，首帧 sequence 为 0。序号缺口最多自动重建一次基线；SOURCE_INCOMPLETE 是记录来源已缺失事实的终止控制，不自动重试，也不能通过重连同一来源补救。不提供历史重放或跨查询一致性承诺。
- 除上述正式提交拒绝外，HTTP 非 2xx 返回 ErrorResponse。无保留项时提交查询返回 404 / SUBMISSION_UNAVAILABLE，不能据此断言未执行；相同身份仍保留时 POST 返回 409 / SUBMISSION_EXISTS，不启动第二次工作。记录来源失效后，观测流及 executions/execution/memory 查询明确返回 SOURCE_INCOMPLETE；实体查询与订阅不依赖记录完整性。不改变现有运行失败的事实记录。

## 可选文件任务

`ConversationRequest.fileTask` 为 `{ sourcePath, output?: { path } }` 或 `{ output: { path } }`，路径相对于服务端显式配置的工作目录。`ConfigurationResponse.files` 存在时表示支持此任务，给出 `maxReadBytes/maxWriteBytes`；不公开宿主绝对路径。合法路径、结构和启用条件在追加输入前检查，文件预检先检查命名来源、目标及元数据；实际读写仍独立检查存在性、UTF-8、字节上限及禁止覆盖。自然语言候选中的配置根内绝对路径可由服务规范为相对路径，正式 fileTask 契约仍只使用相对路径。原文和结果仍以正式 user/assistant 消息同步，文件正文不进入提交反馈。

服务在任务 Group 接纳决定后发布 `task`：`reply`、`file { task: FileTask }`、`clarify` 或 `unsupported`。决策候选和预检结果不发布为 task，只有正式执行分支启动或最终澄清/不支持时发布。它是本轮稳定的分支选择，不能更换或消失；出现前必须已有正式输入。普通自然语言也可得到 file 任务，客户端不从文本识别路径。显式 fileTask 是完整约束，远端不能偷偷扩大或换成普通回答。首次累计快照可以同时含 input、task、回答及终态。

提交的 `fileOutput` 独立表达结果文件：`pending`、`created`（path/bytes/SHA-256 digest 回执）、`not-created`（not-started/cancelled/failed）或 `unconfirmed`。requested 来自任务 Group 正式选择含输出的文件任务；started 与发布结果来自实际文件端点。端点完成发布后立即发出 created，即使稍后取消、父层接纳或记忆处理失败也保留。工作结束时，完整来源证实尚未开始的输出为 not-started；已经开始但缺少可信结果的输出只能是 unconfirmed。

没有 `fileOutput` 只表示尚未收到该项事实，不等价于未创建；输入拒绝、尚未进入受理通知等情况可以没有该字段。客户端保留本地路径意图，与服务事实区分。已确认终态不可回退；任务终态不能携带 pending，受理拒绝不能同时携带文件执行事实。文件投影失效不改写执行结果或已经确认的创建回执；缺失任务归属时不发布无归属的文件结果，并标记反馈解释不完整。回答先正式落实，再执行保存；保存失败和记忆失败都保留正文，文件组件独立显示保存结果。

文件任务复用提交查询和 follow，不另建文件同步集合，也不因反馈断线重做。SHA-256 标识本次实际读取/发布的字节，不承诺外部文件今后不变化。当前仅提供结果路径与回执，没有下载、任意路径浏览、覆盖、追加或删除接口。`/api/source` 仍是独立源码白名单端点。

## 身份、顺序与时间

conversationId 是持续交流的身份，submissionId 是已固定目标的服务请求关联身份，Context.id 是一次内核调用身份，Record.id 是可选观测载体身份，这些身份互不替代。一次提交可关联零个或多个任务调用；即使不启用 Recorder 也能取得消息落实和调用进展。投影 revision 仅表达该提交解释状态的变化，允许连接合并中间状态后交付更高修订；它不是调用顺序、消息 revision 或观测游标。累计事实不可回退，同修订必须等值。

当前调用记录用 id、parentId 和 childIds 表达真实调用树；业务查询中的 executionId 指向选中的任务记录，旧 operationId/parentOperationId 保留历史解释。消息 index 永不随切段重排。resultOf 只直接引用同一记录内已有的 return 正文，不跨记录或形成引用链；最终结果对应最后一次 return。新调用正常从 execute.return 返回，receive.return/handling.return 仅供历史记录读取。消费者使用 readOutput，不复制存储正文。

服务提交对象拥有运行任务、独立取消控制器与投影，反馈连接只读取。运行信号传给 Runner.run，不借用 HTTP 连接信号；能力不合作时继续等待，不提前释放占用。当前最多保留 128 项，结束项按 5 分钟 TTL 或容量淘汰，活动项不淘汰；容量不足拒绝登记，不隐含排队。一个连接受背压阻塞后仅标记需要重建基线，可写时发送当时的完整基线，不丢弃任意正文片段后继续发送无效增量。慢连接不反向等待业务。此保留不保证重启恢复、幂等执行或历史重放。

## 接纳条件与下一笔提交

ConversationSubmissionSnapshot.result 只说明这一笔已经完成、失败、取消或未被接纳；其发布在 runtime.run 实际返回/抛错和占用释放之后。admission 是附带的当时服务接纳提示，与不可变结果分开。旧提交的 read/follow 不能充当当前服务可用性查询；需要时 GET /api/conversation/admission 读取实时条件。辅助提示读取失败不能阻断运行进展或结果发布。

ConversationAdmission 只公开 conversationId、transcriptId、status，以及 unavailable 时的 error。服务从实际 runtime.running、配置、已知模型构造/能力不可用和保留容量取得依据；查询不主动兑现惰性 Provider。ready 表示允许尝试接纳，不能保证之后模型成功，也不保证查询到 POST 之间没有竞争。最终受理检查仍在服务端。

rejected.retry:admission 是明确未接纳且允许再次尝试受理的声明，当前用于忙碌、保留容量不足或已知环境不可用造成的未接纳；不能带已经落实的 input、answer 或 execution。它不表示重新执行失败业务。客户端保留同一本地队列项，再次尝试时创建新的 submissionId；旧身份仅用于其结果查询。同身份重复 POST 仍拒绝，不增加幂等执行承诺。

单轮输出失败和后处理失败不等于服务失去接纳能力；相反，服务空闲也不证明某个反馈丢失的提交没有执行。结果未知必须继续确认原身份，不能依据 admission 自动重发。等待项不因前一笔失败被清空，服务不可接纳时也不应逐条消耗后续输入。

## 对话处理过程

被动 InvocationProgress 由调用结构发布，运行绑定在每次根调用选择所属 Callable 子树来源，服务直接投影明确事实；不从记录、消息数量或两份快照差异反推。ConversationSubmission 的 activity 与内容 progress 通道独立隔离。活动关闭或消费者失败不参与业务接纳，不影响运行。

ConversationActivity 使用 Context 身份，status 为 running/succeeded/failed/cancelled。当前普通调用只执行一次 run，phase 表达 setup/execute，round 在开始前为 0、执行时为 1；业务再次生成结果时建立新的子调用身份。协议仍保留 receive/handling/control 阶段和旧轮次数据的表达能力，不能据此推断当前内核还产生这些过程阶段或支持第二轮执行。短调用完成后仍保留条目。started 之前的建立失败可只有 finishedAt，不补造开始时间。

relation 描述父层处理该子调用的 attached/returned/receiving/accepted/handled/failed，并保留真实返回 succeeded/failed/cancelled。accepted 表示接纳成功返回；handled 表示父层完成失败接收，子调用仍然失败。子调用成功与父层接纳不是同一事实；子调用工作成功但交付失败时可以同时出现 status:succeeded 与 relation.returned:failed。取消请求 ACK 不结束任何条目，只有已发生的调用退出更新其状态。调用进展不替代提交 result，业务降级或重新生成过程中的子失败也不推断整次提交失败。

活动仅公开名称、归属和进展元数据，不传输入输出、诊断正文、模型思考、源码或资源对象。label 最多 120 字符，每次提交最多保留 512 个调用位置（包括等待子调用开始的关系）。超限或来源顺序/关系失效后保留已知前缀，activities.integrity 永久变为 ACTIVITY_INCOMPLETE；后续内容与最终 result 继续更新。调用局部 eventSequence 用于服务接纳，不混入交付 revision。查询与 follow 初始基线提供同一有界累计状态；后续只传变化条目，不承诺完整过程事件回放。不同边界事件若映射到相同公开 phase/round，则仍检查来源顺序，但不重复发布相同状态。

## 数据量边界

| 出口                       | 正常传输                         | 全量与计算边界                                                                       |
| -------------------------- | -------------------------------- | ------------------------------------------------------------------------------------ |
| 提交 / follow              | 提交字段与调用条目增量、正文增量 | 完整基线用于建立和追赶；预览不驱动完整调用数组构造或序列化                           |
| 原文订阅                   | 正式 append/segment 变化         | 首次和重连保留全量消息基线与前缀一致性检查；客户端复用已确认消息，不重复复制同一基线 |
| 观测订阅                   | 明确记录/记忆/选择变化           | 基线含概览、记忆与当前运行范围的记录；先按归属筛选，再物化记录正文，历史详情按需查询 |
| 执行概览 / 记忆查询        | 单次累计读模型                   | 按归属一次分组，避免每个任务/Memory 重扫完整记录集合；仍随实际历史规模增长           |
| 执行详情 / 源码            | 所选实体的完整正文               | 按需读取；记录验证使用 ID 查找，保留完整关联检查                                     |
| 外部交互订阅               | 单个交互的少量状态元数据         | 不传模型请求/反馈正文，不随正文分片频率更新                                          |
| 对话目录 / 配置 / 接纳状态 | 单次元数据响应                   | 不在正文增量上重复请求；目录当前仍完整读取                                           |

NDJSON 逐新分片扫描，整行只组装一次；客户端默认单行上限为 16 MiB，超限终止消费并释放 reader，发送积压使用有界字节预算与游标队列。客户端保留不可变副本，变化调用单独校验并复用其他调用对象；平面引用数组/Map 的浅复制、恢复基线校验及 Markdown 展示解析仍有与实际数据量相关的成本。回归以序列化次数、扫描次数、对象复用和线中字节预算验证，不使用机器耗时阈值或真实模型。

执行列表按实际登记顺序。新调用树以实际根调用作为 scopeId，全部后代共用其单调 offsetMs；sequence 是该范围内部的边界顺序，任务详情省略兄弟子树时允许间隙。旧历史计时范围保留，不跨 scope 比较 offsetMs。occurredAt/startedAt 是展示用墙钟；历史未记录的起始时间与未结束调用的耗时保持未知。跨任务不推断依赖，默认调用树按直接 parentId 连接，以父层 attached 关系的 eventSequence 表达同级顺序，不以时间反推关系。

availableMemoryIds 来自本轮输入快照，只表示可见，不能宣称模型实际采用。selections 是选择操作结果；容量裁剪后的最终原文与候选有区别，详情必须以实际请求记录为准。response 即使后处理失败也可以存在。

## 异常处理过程与失败分类

新调用的 ProcessRecord 记录 execute 的 start/return/throw；run 内各操作通过 result.succeeded/failed 接收，子调用的父层接收另记 relationChanges，不建立独立 receive/handling/control 过程阶段。记录协议保留旧 receive、handling、control 及 continue/unhandled 等过程形态供历史读取，不代表当前仍有异常声明处理器或同调用二次执行。InvocationEvent 的过程 stage/action 与记录契约对应，不携带任意业务 IO。过程条目的 sequence 仅用于过程及 resultOf 引用，eventSequence 则与同调用的关系事实对照先后。

InvocationFailureFact 表达 kind(exception/error)、phase(setup/execute/receive/handling/control/observation)、contextId，以及仅异常适用的 contract；其中 receive/handling 仍可出现在历史失败事实中。调用失败正文、过程和相应增量可携带这组解释事实；错误正文仍由 RuntimeErrorValue 表达。contract 是服务端契约名称的说明，跨端字符串不赋予处理、重试或恢复资格。

Context 的业务完成状态与调用交付失败可能不同，例如工作成功之后终态记录失败。客户端不能因为最终失败就撤回消息实体中已经成立的回答，也不能把未知状态解读为尚未发生。业务流、记录流和消息实体同步保持各自职责，当前不新增通用恢复指令。

UI 的读模型和组件接口不属于本协议，见 [客户端与应用绑定](client-runtime.md#应用绑定与-store)。

## 内容变化记录

MemoryRecord 的 executionId/operationId 改为可选，contextId/callId 可选并标识实际来源调用；由运行外部直接接纳的记忆变化没有虚构调用归属。TranscriptRecord 的 append 仅含 start/end，不附带原文；它表达追加或分段，包含 transcriptId、revision、occurredAt 与可选调用来源。transcriptId/revision 将内容事件与其记录关联；MemoryRecord 使用 memoriesId/sequence。内容记录通过观测增量传输，但不加入 ExecutionRecordSnapshot.calls 调用节点列表。

## 记录安装根记录与通用命名

BaseRecord 表达身份、直接 parentId 与正文；CompositeRecord 增加 childIds。RecordingRootRecord 是记录安装根，value 当前只有 createdAt。新实时记录统一为 CallableRecord（record entry kind 为 invocation），structureKind 为 scene/group/node；InvocationValue 分别保留 processes 与 relationChanges。可选 role 是业务用途元数据，Observer 用 conversation-task 选任务，不从结构 kind 推断。Recorder 与 CallableContext 是服务端对象，不加入协议。

新记录树为 RecordingRootRecord → 根 CallableRecord → 真实成员 CallableRecord，其他记录依产生位置挂接。Scene/Group 可组合 Group/Node；Node 无子调用。旧 RuntimeCallRecord/ExecutionRecord/OperationRecord/AttemptRecord 只保留历史读取，服务将它们只读规范化为通用调用详情，不改写原持久记录。

ExecutionRecordSnapshot 保留业务查询名称，execution 是明确选中的任务，calls 是它及其后代；rootCall 可携带实际根调用，ancestors 按根到直接父顺序提供两者之间的全部中间调用。ancestors 不重复 rootCall/execution，不允许省略中间节点后接入无关根。boundaries、resources 可包含这些祖先的正式事实，但不附带兄弟任务子树。根调用本身被选中时可省略 rootCall。transcripts/memories 是内容变化记录，消息正文仍独立同步。旧字段 runtimeCall/runtimeEvents/events/operations/attempts 属于 LegacyExecutionRecordSnapshot，不是新响应契约。

详情中的 calls 按真实 childIds 深度优先形成稳定数组；祖先路径单独表达，资源依实际产生调用收集。客户端从基线和增量构造相同关系。归属顺序不等于发生时间，实际先后继续读取调用边界、过程和资源各自的 sequence。活动根调用的基线保留已经结束但仍待父层接纳的任务子树；业务任务的展示计数不随结构深度变化。

relationChanges 保留父层真实发生的 attached、returned、receiving、accepted、handled、failed，含父子 Context、父轮次、可选 key/子记录 ID 和 eventSequence。returned 是子层结果，accepted 是父层完成成功接收，handled 是父层完成失败接收且保留子层失败；failed.source 区分接纳工作与观测故障，不能从任务成功推断根调用接纳成功。交付游标与各来源顺序分开，不承诺旧游标重放或业务恢复。

ObserverOverview 可带 archives（sourceId、rootIds、revision、state），其执行简介和 ExecutionRecordSnapshot 可带对应 archive 来源。state=open/sealed/incomplete 解释持久历史的封存状态；旧 running 不代表仍在执行。归档详情允许缺少尚未保存的边界尾部，不放宽已有身份、归属、顺序及正文规则。当前活动基线与历史来源分开，见 [持久化](../../capix-lab/docs/persistence.md)。

## 变化与交付

ObserverChange 是已知来源的联合：TranscriptEvent、MemoryChangeEvent、InvocationEvent、RecordChangeEvent。领域生产者仅依赖自身的 ChangeCapture<E>，MemoryEvent 需在装配边界显式投影成 MemoryChangeEvent；wire 联合不直接承载完整 metadata，不赋予公共捕获器业务分派职责。InvocationEvent 包含 contextId、可选 parentContextId、kind 及开始、进度、子关系和终态元数据，不再有特化 E entry 事件。成员建立前的失败保留已存在的父调用及内容事实，不伪造成员 Context 或记录。任意业务 IO 留在业务通道或记录中。

RecordMutation 分为 added、process-appended、relation-appended、finished、replaced。added 携带新记录与直接父级新增引用；process-appended 与 relation-appended 分别只携带本次新增过程或关系条目；finished 保持 resultOf 正文复用。replaced 是通用显式更新的后备形式，不是快照 diff。record entry 的 kind 由具体记录类声明。

ObservationBaseline 的 sequence 固定为本连接的 0，另带独立的 Transcript revision、Memories sequence 和 Recorder revision。后续非空批次递增连接 sequence。ObservationDelta 使用 ObservationChange：原文 append 转为 start/end 通知，原文正文只走实体通道；记忆领域变化需转换为上述 MemoryChangeEvent 展示形状，不能直接转交完整领域值。ObservationDelta.changes 保留捕获顺序，整批交付不等于跨源事务。客户端先检查交付位置，再检查各来源顺序，整批成功才公开新状态。

服务环境只由一个 ChangeConsumer 排空变化捕获器，记录来源与消息实体出口共享消费结果。RecordSource 在事实产生前建立，并经 open({ change, incomplete }) 固定基线和来源水位；每条连接有独立交付范围，重连更换 scopeId，不重置来源 revision。失效来源永久拒绝新基线，发送层丢弃尚未发送的普通批次，等待连接可写后发送 SOURCE_INCOMPLETE 并结束；不会撤回已经交给网络的字节。HTTP 连接的待发数据与 writableLength 合计上限为 16 MiB，超限断开连接，不等待慢客户端拖住运行。捕获器不持有已交付历史，不支持游标重放、消费确认或持久化恢复。

## 资源事实与实体同步

`ExecutionRecordSnapshot.resources` 为 ResourceRecord 数组。每条事实具有自身 id、直接 parentId（实际 CallableRecord）、access、supplyId、sequence、occurredAt、phase 和由资源契约定义的 value。sequence 在所属调用的资源事实范围内递增；bound 先于 available/unavailable，started 与 returned/threw 以 interactionId 配对。运行与异常处理阶段的端点共享此序列，同一供给的 bound/available 不因阶段切换重复发送。资源顺序、调用过程 sequence、实体 revision 和发送者 sequence 各有边界，不互相替代。

静态申请/供给不产生记录。调用内资源端点兑现及方法执行才产生事实。描述函数不会在关闭记录时运行；供给失败与已完成工作后的记录失败保持不同证据，不把后者重新解释成业务失败。

消息定位使用 MessageLocator / TranscriptRangeLocator，记录不包含活 Ref。范围可带捕获时的 revision；客户端允许用更新的追加型消息副本读取旧范围，但不能因此扩大原范围。没有加载、加载失败、版本/位置缺失与空消息分别表达。默认 MemoryObservation 没有 sources，只有独立集合的项及其 content 投影和不可变记录；消息跳转由业务自己的投影提供。

客户端 TranscriptReplica 在首基线之后检查集合身份、严格连续 revision 和追加/分段边界；重复版本不推进副本。消息连接中断与修订缺口由 TranscriptReceiver 有限退避重建基线，主动停止后须显式再次订阅；策略见客户端文档。基线不能改写已接纳正文或分段前缀，身份/内容冲突及来源失效停止自动恢复。不对未加载集合缓存无限增量。当前端点提供完整集合基线，不实现分页、历史重放、持久化或跨集合事务。

## 有限流式回答

提交反馈首帧为 `{ type: 'baseline', submission, preview? }`，常规进展为 `{ type: 'submission', submission }`，预览增量为 `{ type: 'answer', conversationId, submissionId, change }`。查询与取消控制响应也使用 baseline。正式消息正文仍由独立 Transcript 同步，不由临时预览生成正式消息。

预览每代从 generation 的新值与 revision=1 开始；change 为 started、appended（UTF-16 offset/text）、received、committed（message/consistency）或 discarded。received 只表示该候选完成本层处理，committed 来自任务 Group 成功追加正式回答后的明确来源关联。consistency 为 complete（全文相等）、prefix（可选预览只收到前缀）或 mismatch（正式正文胜出）；不一致不回滚合法业务结果。废弃后再次生成新代，旧流不能写入新代。

预览仅有界保留于本次进程内提交，可在 follow/read 基线恢复，不持久化每个片段。断线只解除消费，不能重新发起模型调用。预览完整性与活动、提交结果、正式内容同步相互独立；流输出接收缺口允许取基线，内容冲突停止该候选自动恢复。
