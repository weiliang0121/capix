# CAPiX

CAPiX 是从实际对话链路逐步演进的可观测 Agent 框架，包含服务端运行能力、无 UI 的客户端运行能力与传输适配。**Observer 是同仓库的参考服务与应用**：装配对话能力、可选记录预设和观测交付，用真实使用验证内核。

本仓库原名 `capix-observer`，现在是 CAPiX 的实现主线。原 `capix` 已移至相邻的 `capix-explorations`，保留独立 Git 历史和概念探索；不合并其 Graph/TRS 实现，也不把探索方案作为本内核的约束。

## 从哪里开始

- [项目组织与命名](docs/organization.md)：框架、应用、实体和记录的定位；对象角色、公开入口与本轮迁移表。
- [运行边界](docs/runtime-boundaries.md)：REOA 声明、绑定结构、单次调用、资源、父子接纳。
- [异常与错误](docs/exceptions.md)：声明异常和内核错误的不同处理出口。
- [记录机制](docs/recording.md)、[增量观测](docs/observation-increments.md)：可选记录预设、变化生产、来源完整性与交付。
- [跨端协议](docs/protocol.md)、[客户端运行能力](docs/client-runtime.md)：独立对话交付、实体同步、观测接收、应用绑定与 Store。
- [消息与分段](docs/transcript.md)、[运行记忆](docs/memory.md)：内容实体的当前行为。
- [对话身份与切换](docs/conversations.md)：新建、历史、明确提交目标与资源归属。
- [对话持久化](docs/persistence.md)：内容提交、历史记录与重启边界。
- [外部交互](docs/interactions.md)：独立请求与反馈、A 的本地等待、再次读取和持久化边界。

`docs/review.md` 和 `docs/observation.md` 保留设计推演过程，文首明确标为历史材料；当前契约以以上专题文档和实现为准。

[REOA Checkpoint 与执行恢复设计](docs/checkpoints.md) 说明可选 CP 声明、父子续接、消息固定写入及恢复观测。Observer 的新调用默认保存 CP，现有对话、决策、文件与记忆声明提供有限的宿主显式续接，并通过进程中断验证；没有自动恢复旧 QA 或旧提交反馈。[恢复机制研究](docs/recovery.md) 保留外部机制对照与早期候选路径，不作为当前 API。

## 对象与活动

“运行时”表示系统实际协作的活动状态，不等同于 R 层，也不是某个世界根对象。

```text
独立实体：Transcript、Memories、SelectionUsage、模型供给、记录容器……
                      │ 通过资源契约提供受控访问
业务声明 A → O → E → R
                      │ 绑定
        BoundRuntime → BoundExecution → BoundOperation → BoundAttempt
                      │ 每次使用建立
                 Invocation + 本层 Context
                      │ 发布已经发生的事实
           变化捕获                 可选观测声明
               │                   ├─ 记录预设
               │                   └─ 其他同步消费者
               └──────── 环境消费与服务交付
```

- `*Definition` 声明契约与内容；`run`、`exceptions`、`observation` 是平级部分。
- `Bound*` 是可复用的绑定结构，不是一次调用。R 当前持有占用，拒绝同时提交；每次 `run` 建立新的 R Context/Invocation，再由 R 声明选择和接纳 E。
- `Invocation` 统一调用过程、直接子关系和顺序；`*Context` 保存本次现场。业务只取得 `*ContextView`、`InvocationView` 和自己声明的资源端点。
- 独立实体由环境建立。R 绑定其访问形式，不拥有整个实体世界；调用工作不取得原实体或记录容器。
- 观测消费类型化事实，记录是内置的可选结果形式。没有记录，业务调用与内容变化仍然成立。

记录预设的归属是 `RecordingRootRecord → RuntimeCallRecord → ExecutionRecord → OperationRecord → AttemptRecord`。根属于一次记录安装，R 调用记录属于一次 R 调用；二者不是 R 实例和调用上下文的替代品。完整 E 详情契约名为 `ExecutionRecordSnapshot`，不表示整个系统的快照。

## 同一个服务中的两种职责

```text
services/observer/src/
  conversation/    对话 R/E、O/A 声明、模型契约、资源绑定、消息同步
  files/           可选工作目录实体与受控文本读写资源
  observation/     记录来源、查询投影、观测交付
  persistence/     多对话的 SQLite 存储与历史记录保存
  assembly/        独立实体、供给、配置与共享变化消费的装配
  http/            对话、实体、观测端点与静态资源
```

`ConversationRuntimeDefinition` / `ConversationExecutionDefinition` 定义对话；`initializeObserver` 装配单个对话的运行环境，`ObserverConversations` 管理参考服务中的对话目录与按对话装配。`TranscriptFeed` 同步消息实体，`ObservationFeed` 交付观测，它们可以独立连接和关闭。对话使用 `ConversationRequest`，不把它当成通用 E 输入契约。

```ts
import { initializeObserver } from '@capix/observer-service/assembly';

const environment = initializeObserver(provider);
const output = await environment.runtime.run({ messages: [{ role: 'user', content: '你好' }] }, { settings, signal, progress });
```

上例的 provider、settings、signal 由宿主提供；progress 是为本次请求创建的 `ProgressChannel<ConversationProgress>`，接收可选进展，不参与工作接纳。使用者也可从 `/conversation` 组合已有 R/E/O/A 声明，或直接用 `@capix/server-runtime` 的声明与 `assembleRuntime` 建立自己的结构，不必使用 Observer 的装配。

回答在正式追加消息后交付，随后处理记忆。启用持久化时，正式追加先提交到数据库。后处理失败保留已成立的回答。当前只有生成回答明确声明的、针对完整模型输出被拒绝的一次再次生成；没有通用自动重试、后台补偿、动态调度或默认服务未完成调用恢复。

模型请求通过独立 Interaction 发出。请求模型 O 接纳 A1 的有限等待结果，必要时建立 A2 读取同一交互；不会因为本地等待结束而重发。反馈先保存再交给业务解释，已保存反馈可按 ID 再次读取，与恢复旧调用分开。

## 包与公开入口

| 包                        | 当前职责                                                                       |
| ------------------------- | ------------------------------------------------------------------------------ |
| `@capix/protocol`         | 跨端内容、调用元数据、记录、对话与 Observer 契约，内部按领域分组               |
| `@capix/server-runtime`   | REOA 机制、声明与绑定、资源和观测出口；同时提供独立内容实体与可选记录预设      |
| `@capix/client-runtime`   | 无 UI 的提交、消息同步、观测接收与按需详情；当前组合仍针对对话和 Observer 契约 |
| `@capix/client-http`      | HTTP 基础收发及对话、观测适配                                                  |
| `@capix/observer-service` | 参考服务的业务、观测和环境装配                                                 |
| `@capix/observer-app`     | React 观测应用、视图投影、Store 与交互                                         |

服务端的 `/content`、`/recording`、`/construction` 分别提供内容实体、可选记录和底层构造入口。服务包的 `/conversation`、`/observation`、`/assembly`、`/http` 对应装配职责。根入口仍提供按职责分组的导出；不为减少对象数量新增统一门面。所有跨包导入必须经过公开出口。

服务端与客户端不互相依赖；HTTP 适配依赖客户端端口；UI 通过应用绑定将客户端状态投影到 Store。实体实例、网络契约和 UI 读模型不互相替代。

## 本地启动与检查

固定工具链：Node **22.23.2**、pnpm **10.7.1**、TypeScript **6.0.3**。一个根 Workspace 和锁文件，六个实际包，没有新建空壳功能包。

```sh
pnpm install --frozen-lockfile
cp .env.example .env
# 在本机填写服务需要的模型配置，不提交凭证。
pnpm build
pnpm start
```

默认服务为 `http://127.0.0.1:4317`，提供构建后的界面和 API。开发时先在另一个终端运行 `PORT=4320 pnpm start`，再运行 `pnpm dev`；Vite 的 API 代理可通过 `OBSERVER_API_ORIGIN` 调整。服务端更改后需要重新构建和重启。

`pnpm start` 默认把各对话的消息、记忆、记录和独立模型交互保存到 `.capix/observer.sqlite`，目录已被 Git 忽略。可用 `CAPIX_DATA_DIR` 指定其他目录；它必须位于模型文件工作区之外。同一数据库只允许一个服务进程写入。重启恢复内容与历史记录，并建立新运行环境；不会继续旧 QA、重发模型或文件操作，也不恢复旧提交身份。已有进程的纯内存对话不会自动迁入新库。程序化 `initializeObserver(provider)` 仍默认为内存模式，接入方式见 [持久化](docs/persistence.md)。

设置 `CAPIX_FILES_ROOT` 为一个已存在、由宿主管理的本地工作目录可启用文件任务。可在对话中直接说明相对路径和读写要求，也可展开文件任务输入，填写来源和/或结果路径。当前支持最多 64 KiB 的 UTF-8 普通文本，按实际执行时的内容读取；结果仅新建，目录需预先存在。自然语言通过请求理解 O 提出普通回答、文件、澄清或不支持候选，E 接纳后选择已声明的分支；显式文件任务跳过理解。路径缺失时在当前 QA 提问，下一轮重新理解；不以“继续”自动重放历史写入。支持读文件、读后保存、直接生成后保存。明确回答先追加为正式消息，然后才保存；保存失败保留回答。

`WorkspaceFiles` 是独立服务实体，通过 read/create 资源端点提供访问；绑定层在所选 O 创建时按输入收窄到具体路径，资源自行检查不可扩大既有约束。文件能力未启用时普通对话不受影响。发布回执独立于本轮结果：后续取消或记忆失败仍保留已创建文件；反馈断线只恢复同一提交，不重做文件操作。这不是持久化或通用工具平台。

文件目录须由宿主控制。实现检查路径、符号链接、目录身份并独占发布完整文件，但不是对抗其他进程恶意替换目录的操作系统沙箱，也不承诺网络文件系统或进程崩溃后的恢复。临时文件清理是尽力执行；不确定发布结果会明确报告，不能依据调用失败认定文件未创建。

```sh
pnpm check
```

检查覆盖包构建/类型、运行和 HTTP 回归、跨包公开入口、客户端接收、UI 纯逻辑与格式。普通检查使用注入的模型返回，不访问真实模型。真实模型场景是单独显式运行的 `test/live/memory.mjs`。

## Observer 的阅读方式

问答导航固定宽度、独立滚动；主图各轮等宽，密度仅影响主图。默认按直接归属与同级顺序展示可折叠调用树，耗时是独立辅助视图。上下文行展示选中历史、可见记忆和变化关联；全文属于对话或详情。搜索使用客户端已同步的完整消息。

来源完整性、交付顺序和实体版本分别表达。当前记录来源不完整时明确停止观测交付，不能用重新拉快照伪装成修复；消息同步和对话仍独立。重启后以历史归档展示旧来源及其完整性；未结束的旧记录显示“未取得结束记录”，不会一直显示运行中。回答与文档正文已支持有限流式预览，正式消息仍在完整校验和接纳后追加；候选来源、正式消息定位与内容一致性分别确认。有限 checkpoint 恢复是可选内核能力，尚未接入旧对话自动恢复；没有外部能力平台或动态能力注册。
