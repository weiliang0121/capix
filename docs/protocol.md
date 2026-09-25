# Observer 跨端契约

## 包边界

`@capix-observer/protocol` 是唯一跨端依赖。只公开可序列化数据、记录引用解析与完整性校验；不包含运行实体、HTTP 实现、模型供应商格式或图谱投影。所有跨包导入使用公开出口。

`@capix-observer/runtime` 持有 EOA、Context、Invocation、RecordBook、Transcript 与 Memory 等现有运行对象，不依赖服务或应用。`services/observer` 装配当前筛选、回答、提取场景及模型适配器。`client/runtime` 通过 protocol 读取和提交，保存本地提交状态与已观测数据，不依赖 React 或服务端。`client/http` 的 HttpTransport 基类处理 HTTP，ObserverHttpTransport 子类通过公开接口实现 ClientTransport，接纳具体响应与 NDJSON 消息，客户端 Runtime 不反向依赖它。`apps/observer` 装配客户端 Runtime 与 HTTP 实现，负责 React 界面与前端投影，不导入服务端。此次抽离不改变 HTTP 契约，见 [客户端 Runtime](client-runtime.md)。

## HTTP

- GET `/api/config` → ConfigurationResponse（配置与 configured，绝不返回 key）。
- GET `/api/transcript` → TranscriptResponse。数组位置仍是全量 Transcript 的绝对 index。
- GET `/api/executions` → ObserverOverview：完整消息索引用于文本搜索，执行列表包含 InvocationSummary（计时和身份，不含 IO/processes）、固定 transcriptRange、availableMemoryIds 和 memoryChanges 简介。
- GET `/api/execution?id=记录ID` → RuntimeSnapshot。仅在打开详情时请求；返回当前完整记录。
- GET `/api/memory` → MemoryObservation。记忆正文、来源与已生成的变更记录。
- GET `/api/source?file=路径` → SourceResponse。路径为仓库相对源文件路径，服务端白名单验证。
- POST `/api/run` 接受 ExecutionRequest；200 返回 NDJSON RunUpdate。每行 `snapshot` 表示同一次执行的完整观测快照，前端按 execution.id 替换；`error` 表示发布或调用链的非正常结束，不能假装成功。没有增量合并、重放或自动重试。
- HTTP 非 2xx 返回 ErrorResponse。忙碌时 409，拒绝追加消息；接纳/配置错误 400；内部错误 500。不改变现有运行失败的事实记录。

## 身份、顺序与时间

Record.id、Context.id 和运行实例 ID 互不替代。executionId/operationId/parentOperationId 指向记录；消息 index 永不随切段重排。resultOf 只引用同一记录内先前的 execute/receive return 正文，消费者使用 readOutput，不复制存储正文。

执行列表按实际登记顺序。边界事件 sequence 与单调 offsetMs 是执行内部时序依据；occurredAt/startedAt 是展示用墙钟。未结束调用没有 durationMs；不得补造耗时。跨 QA 只有先后关系，前端使用等宽列，轮内才按计时比例布局。

availableMemoryIds 来自本轮输入快照，只表示可见，不能宣称模型实际采用。selections 是选择操作结果；容量裁剪后的最终原文与候选有区别，详情必须以实际请求记录为准。response 即使后处理失败也可以存在。

## 前端分工接口

`features/explorer/RuntimeExplorer.tsx` 默认/具名导出 RuntimeExplorer，props 在该目录 types.ts：overview: ObserverOverview，selectedId: string，onSelect(id): void，onInspect(executionId, callId?): void。图谱内部持有搜索、密度、滚动状态。外层只加载 overview 与详情，不预取所有快照。
