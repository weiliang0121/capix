# Observer 跨端契约

## 包边界

`@capix-observer/protocol` 是唯一跨端依赖。只公开可序列化数据、记录引用解析与完整性校验；不包含运行实体、HTTP 实现、模型供应商格式或图谱投影。所有跨包导入使用公开出口。

`@capix-observer/runtime` 持有 EOA、Context、Invocation、RecordBook、Transcript 与 Memory 等现有运行对象，不依赖服务或应用。`services/observer` 装配当前筛选、回答、提取场景及模型适配器。`client/runtime` 通过 protocol 读取和提交，保存本地提交状态与已观测数据，不依赖 React 或服务端。`client/http` 的 HttpTransport 基类处理 HTTP，ConversationHttpTransport 与 ObservationHttpTransport 两个子类分别通过公开接口实现 ConversationTransport 与 ObservationTransport，接纳具体响应与 NDJSON 消息，客户端 Runtime 不反向依赖它。`apps/observer` 装配客户端 Runtime 与 HTTP 实现，负责 React 界面与前端投影，不导入服务端。对话交付与观测分别接入，见 [客户端 Runtime](client-runtime.md)。

## HTTP

- GET `/api/config` → ConfigurationResponse（配置与 configured，绝不返回 key）。
- GET `/api/transcript` → TranscriptResponse。数组位置仍是全量 Transcript 的绝对 index。
- GET `/api/executions` → ObserverOverview：完整消息索引用于文本搜索，执行列表包含 InvocationSummary（计时和身份，不含 IO/processes）、固定 transcriptRange、availableMemoryIds 和 memoryChanges 简介。
- GET `/api/execution?id=记录ID` → RuntimeSnapshot。仅在打开详情时请求；返回当前完整记录。
- GET `/api/memory` → MemoryObservation。记忆正文、来源与已生成的变更记录。
- GET `/api/source?file=路径` → SourceResponse。路径为仓库相对源文件路径，服务端白名单验证。
- POST `/api/run` 接受 ExecutionRequest；200 返回 NDJSON ConversationUpdate。started 携带 contextId/inputIndex，answer 携带 contextId/index/完整 GenerationOutput，completed 表示后处理也已完成，error 表示处理异常。回答在追加 Transcript 后立即交付，不等待记忆提取；没有记录订阅也能完整使用。
- GET `/api/observe` 独立返回 NDJSON ObservationUpdate：baseline 建立当前事实与来源游标，delta 携带 scopeId/sequence 和明确变化，error 表示观测异常。关闭连接仅解除订阅，不中断对话执行。基线与订阅同步衔接；序号缺口最多自动重建一次基线，不提供历史重放或跨查询一致性承诺。
- HTTP 非 2xx 返回 ErrorResponse。忙碌时 409，拒绝追加消息；接纳/配置错误 400；内部错误 500。不改变现有运行失败的事实记录。

## 身份、顺序与时间

业务流的 contextId 来自调用现场，即使不启用 Recorder 也存在；观测记录通过 contextId 与业务关联，对话不需要先查询记录。Record.id、Context.id 和运行实例 ID 互不替代。executionId/operationId/parentOperationId 指向记录；消息 index 永不随切段重排。resultOf 只引用同一记录内先前的 execute/receive return 正文，消费者使用 readOutput，不复制存储正文。

执行列表按实际登记顺序。边界事件 sequence 与单调 offsetMs 是执行内部时序依据；occurredAt/startedAt 是展示用墙钟。未结束调用没有 durationMs；不得补造耗时。跨 QA 只有先后关系，前端使用等宽列，轮内才按计时比例布局。

availableMemoryIds 来自本轮输入快照，只表示可见，不能宣称模型实际采用。selections 是选择操作结果；容量裁剪后的最终原文与候选有区别，详情必须以实际请求记录为准。response 即使后处理失败也可以存在。

## 前端分工接口

`features/explorer/RuntimeExplorer.tsx` 默认/具名导出 RuntimeExplorer，props 在该目录 types.ts：overview: ObserverOverview，selectedId: string，onSelect(id): void，onInspect(executionId, callId?): void。图谱内部持有搜索、密度、滚动状态。外层只加载 overview 与详情，不预取所有快照。

## 内容变化记录

MemoryRecord 的 executionId/operationId 改为可选，contextId/callId 可选并标识实际来源调用；由运行外部直接接纳的记忆变化没有虚构调用归属。TranscriptRecord 表达追加或分段，包含 transcriptId、revision、occurredAt 与可选调用来源。transcriptId/revision 将内容事件与其记录关联；MemoryRecord 使用 memoriesId/sequence。内容记录通过观测增量传输，但不加入 RuntimeSnapshot 的 EOA 节点列表。

## Runtime 根记录与通用命名

BaseRecord 表达身份、直接 parentId 与正文；CompositeRecord 增加 childIds。RuntimeRecord 是具体根记录，value 当前只有 createdAt；InvocationValue 是 E/O/A 共用调用正文。Recorder 是服务端环境登记机制，不属于跨端协议。RuntimeContext 是运行现场，也不加入协议。

执行记录的 parentId 现在指向 RuntimeRecord。当前 RuntimeSnapshot 仍为一次执行的 E/O/A/事件视图，不附带 Runtime 根正文；响应外的 parentId/childIds 引用不意味着已完整装载整棵树。观测基线另外携带 Runtime 根与活动执行的记录；已完成正文按需查询。交付游标与各来源顺序分开，不承诺持久化或业务恢复。

## 变化与交付

RuntimeChange 是已知来源的联合：TranscriptEvent、MemoryEvent、InvocationEvent、RecordChangeEvent。生产者仅依赖本类的 ChangeCapture<E>；联合类型用于装配与跨端接纳，不赋予公共捕获器业务分派职责。InvocationEvent 只包含身份、直接父级、进度和终态元数据；任意业务 IO 留在业务通道或记录中。

RecordMutation 分为 added、process-appended、finished、replaced。added 携带新记录与直接父级新增引用；process-appended 不重复旧过程；finished 保持 resultOf 正文复用。replaced 是通用显式更新的后备形式，不是快照 diff。record entry 的 kind 由具体记录类声明。

ObservationBaseline 的 sequence 是发送者已消费到的位置，另带 Transcript revision、Memories sequence 和 Recorder revision。ObservationDelta.changes 保留捕获顺序，整批交付不等于跨源事务。客户端先检查交付位置，再检查各来源顺序，整批成功才公开新状态。

服务当前为一个环境装配一个发送者；多个连接共享发送范围，各自取得基线。HTTP 连接的待发数据与 writableLength 合计上限为 16 MiB，超限断开连接，不等待慢客户端拖住运行。捕获器不持有已交付历史，不支持游标重放、消费确认或持久化恢复。
