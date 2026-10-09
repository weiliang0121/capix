# Observer 跨端契约

## 包边界

`@capix-observer/protocol` 是唯一跨端依赖。只公开可序列化数据、记录引用解析与完整性校验；不包含运行实体、HTTP 实现、模型供应商格式或图谱投影。所有跨包导入使用公开出口。

`@capix-observer/runtime` 持有 EOA、Context、Invocation、RecordBook、Transcript 与 Memory 等现有运行对象，不依赖服务或应用。`services/observer` 装配当前筛选、回答、提取场景及模型适配器。`client/runtime` 通过 protocol 读取和提交，保存本地提交状态与已观测数据，不依赖 React 或服务端。`client/http` 的 HttpTransport 基类处理 HTTP，ConversationHttpTransport 与 ObservationHttpTransport 两个子类分别通过公开接口实现 ConversationTransport 与 ObservationTransport，接纳具体响应与 NDJSON 消息，客户端 Runtime 不反向依赖它。`apps/observer` 装配客户端 Runtime 与 HTTP 实现，负责 React 界面与前端投影，不导入服务端。对话交付与观测分别接入，见 [客户端 Runtime](client-runtime.md)。

## HTTP

- GET `/api/config` → ConfigurationResponse（配置与 configured，绝不返回 key）。
- GET `/api/transcript?id=集合ID` → TranscriptSnapshot（id/revision/start/end/starts/messages）。不指定 ID 表示当前对话集合；未知 ID 返回 404，服务只暴露装配进来的集合。数组位置仍是全量 Transcript 的绝对 index。
- GET `/api/transcript/observe?id=集合ID` → 独立 TranscriptUpdate（baseline/delta/error）。首帧是同一同步边界的消息基线，后续仅传实体增量，不带调用记录；该订阅独立于观测。
- GET `/api/executions` → ObserverOverview：仅含 transcriptId 与消息索引/计数，不含消息正文；搜索由客户端消息副本提供，执行列表包含 InvocationSummary（计时和身份，不含 IO/processes）、固定 transcriptRange、availableMemoryIds 和 memoryChanges 简介。
- GET `/api/execution?id=记录ID` → RuntimeSnapshot。仅在打开详情时请求；返回当前完整记录。
- GET `/api/memory` → MemoryObservation。记忆正文、来源与已生成的变更记录。
- GET `/api/source?file=路径` → SourceResponse。路径为仓库相对源文件路径，服务端白名单验证。
- POST `/api/run` 接受 ExecutionRequest；200 返回 NDJSON ConversationUpdate。started 携带 transcriptId/contextId/inputIndex，answer 携带 transcriptId/contextId/index/完整 GenerationOutput，completed 表示后处理也已完成，error 表示处理异常。回答在追加 Transcript 后立即交付，不等待记忆提取；没有记录订阅也能完整使用。
- GET `/api/observe` 独立返回 NDJSON ObservationUpdate：baseline 建立当前事实与来源游标，delta 携带 scopeId/sequence 和明确变化，error 表示观测异常。关闭连接仅解除订阅，不中断对话执行。基线与订阅同步衔接；序号缺口最多自动重建一次基线，不提供历史重放或跨查询一致性承诺。
- HTTP 非 2xx 返回 ErrorResponse。忙碌时 409，拒绝追加消息；接纳/配置错误 400；内部错误 500。不改变现有运行失败的事实记录。

## 身份、顺序与时间

业务流的 contextId 来自调用现场，即使不启用 Recorder 也存在；观测记录通过 contextId 与业务关联，对话不需要先查询记录。Record.id、Context.id 和运行实例 ID 互不替代。executionId/operationId/parentOperationId 指向记录；消息 index 永不随切段重排。resultOf 只引用同一记录内先前的 execute/receive return 正文，消费者使用 readOutput，不复制存储正文。

执行列表按实际登记顺序。边界事件 sequence 与单调 offsetMs 是执行内部时序依据；occurredAt/startedAt 是展示用墙钟。未结束调用没有 durationMs；不得补造耗时。跨 QA 只有先后关系，前端使用等宽列，轮内才按计时比例布局。

availableMemoryIds 来自本轮输入快照，只表示可见，不能宣称模型实际采用。selections 是选择操作结果；容量裁剪后的最终原文与候选有区别，详情必须以实际请求记录为准。response 即使后处理失败也可以存在。

## 前端分工接口

`features/explorer/RuntimeExplorer.tsx` 默认/具名导出 RuntimeExplorer，props 在该目录 types.ts：overview: ObserverOverview，selectedId: string，onSelect(id): void，onInspect(executionId, callId?): void。图谱内部持有搜索、密度、滚动状态。外层只加载 overview 与详情，不预取所有快照。

## 内容变化记录

MemoryRecord 的 executionId/operationId 改为可选，contextId/callId 可选并标识实际来源调用；由运行外部直接接纳的记忆变化没有虚构调用归属。TranscriptRecord 的 append 仅含 start/end，不附带原文；它表达追加或分段，包含 transcriptId、revision、occurredAt 与可选调用来源。transcriptId/revision 将内容事件与其记录关联；MemoryRecord 使用 memoriesId/sequence。内容记录通过观测增量传输，但不加入 RuntimeSnapshot 的 EOA 节点列表。

## Runtime 根记录与通用命名

BaseRecord 表达身份、直接 parentId 与正文；CompositeRecord 增加 childIds。RuntimeRecord 是具体根记录，value 当前只有 createdAt；InvocationValue 是 E/O/A 共用调用正文。Recorder 是服务端环境登记机制，不属于跨端协议。RuntimeContext 是运行现场，也不加入协议。

执行记录的 parentId 现在指向 RuntimeRecord。当前 RuntimeSnapshot 为一次执行的 E/O/A/调用边界/资源事实视图，不附带 Runtime 根正文；响应外的 parentId/childIds 引用不意味着已完整装载整棵树。观测基线另外携带 Runtime 根与活动执行的记录；已完成正文按需查询。交付游标与各来源顺序分开，不承诺持久化或业务恢复。

## 变化与交付

RuntimeChange 是已知来源的联合：TranscriptEvent、MemoryEvent、InvocationEvent、RecordChangeEvent。生产者仅依赖本类的 ChangeCapture<E>；联合类型用于装配与跨端接纳，不赋予公共捕获器业务分派职责。InvocationEvent 只包含身份、直接父级、进度和终态元数据；任意业务 IO 留在业务通道或记录中。

RecordMutation 分为 added、process-appended、finished、replaced。added 携带新记录与直接父级新增引用；process-appended 不重复旧过程；finished 保持 resultOf 正文复用。replaced 是通用显式更新的后备形式，不是快照 diff。record entry 的 kind 由具体记录类声明。

ObservationBaseline 的 sequence 是发送者已消费到的位置，另带 Transcript revision、Memories sequence 和 Recorder revision。ObservationDelta 使用 ObservationChange：原文 append 转为 start/end 通知，原文正文只走实体通道；其余确定性变化保持原契约。ObservationDelta.changes 保留捕获顺序，整批交付不等于跨源事务。客户端先检查交付位置，再检查各来源顺序，整批成功才公开新状态。

服务当前为一个环境装配一个发送者；多个连接共享发送范围，各自取得基线。HTTP 连接的待发数据与 writableLength 合计上限为 16 MiB，超限断开连接，不等待慢客户端拖住运行。捕获器不持有已交付历史，不支持游标重放、消费确认或持久化恢复。

## 资源事实与实体同步

`RuntimeSnapshot.resources` 为 ResourceFact 数组。每条事实具有自身 id、直接 parentId（E/O/A 调用记录）、access、supplyId、sequence、occurredAt、phase 和由资源契约定义的 value。sequence 在所属调用的资源事实范围内递增；bound 先于 available/unavailable，started 与 returned/threw 以 interactionId 配对。资源顺序、调用过程 sequence、实体 revision 和发送者 sequence 各有边界，不互相替代。

静态申请/供给不产生记录。调用内资源端点兑现及方法执行才产生事实。描述函数不会在关闭记录时运行；供给失败与已完成工作后的记录失败保持不同证据，不把后者重新解释成业务失败。

消息定位使用 MessageLocator / TranscriptRangeLocator，记录不包含活 Ref。范围可带捕获时的 revision；客户端允许用更新的追加型消息副本读取旧范围，但不能因此扩大原范围。没有加载、加载失败、版本/位置缺失与空消息分别表达。MemoryObservation.sources 同样只提供消息定位符；记忆变更结果保持既有不可变记录。

客户端 TranscriptReplica 在首基线之后检查集合身份、严格连续 revision 和追加/分段边界；重复版本忽略，缺口最多重建一次，停止后再次订阅重新获得基线。不对未加载集合缓存无限增量。当前端点提供完整集合基线，不实现分页、历史重放、持久化或跨集合事务。
