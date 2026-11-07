# CAPiX

CAPiX 是从实际对话链路逐步演进的可观测 Agent 框架，包含服务端运行能力、无 UI 的客户端运行能力与传输适配。**Observer 是同仓库的参考服务与应用**：装配对话能力、可选记录预设和观测交付，用真实使用验证内核。

本仓库原名 `capix-observer`，现在是 CAPiX 的实现主线。原 `capix` 已移至相邻的 `capix-explorations`，保留独立 Git 历史和概念探索；不合并其 Graph/TRS 实现，也不把探索方案作为本内核的约束。

## 从哪里开始

- [文档导航](docs/README.md)：当前契约、使用说明与历史实验分别查阅。
- [项目组织与命名](docs/organization.md)：框架、应用、实体和记录的定位；对象角色、公开入口与本轮迁移表。
- [可调用结构](docs/callable-structures.md)：Scene / Group / Node、Callable / Composite、绑定与驱动的职责。
- [运行边界](docs/runtime-boundaries.md)：统一调用、资源窗口、父子接纳与恢复。
- [异常与错误](docs/exceptions.md)：统一操作接收与不可被 fallback 清除的机制故障。
- [记录机制](docs/recording.md)、[增量观测](docs/observation-increments.md)：可选记录预设、变化生产、来源完整性与交付。
- [跨端协议](docs/protocol.md)、[客户端运行能力](docs/client-runtime.md)：独立对话交付、实体同步、观测接收、应用绑定与 Store。
- [消息与分段](docs/transcript.md)、[运行记忆](docs/memory.md)、[活跃材料与维护](docs/active-content.md)：内容实体、单次材料与维护边界。
- [对话身份与切换](docs/conversations.md)：新建、历史、明确提交目标与资源归属。
- [对话持久化](docs/persistence.md)：内容提交、历史记录与重启边界。
- [外部交互](docs/interactions.md)：独立请求与反馈、Node 的本地等待、再次读取和持久化边界。

`docs/review.md` 和 `docs/observation.md` 保留设计推演过程，文首明确标为历史材料；当前契约以以上专题文档和实现为准。

[Callable Checkpoint 与执行恢复设计](docs/checkpoints.md) 说明可选 CP 声明、父子续接、消息固定写入及恢复观测。Observer 的新调用默认保存 CP，现有对话、决策、文件与记忆声明提供有限的宿主显式续接，并通过进程中断验证；没有自动恢复旧 QA 或旧提交反馈。[恢复机制研究](docs/recovery.md) 保留外部机制对照与早期候选路径，不作为当前 API。

## 对象与活动

“运行时”表示系统实际协作的活动状态。Scene、Group、Node 是可复用结构的角色；三者都遵守共同的 Callable 契约，Scene 和 Group 另有成员组合能力。

```text
独立实体：Transcript、Memories、MessageUsage、模型供给、记录容器……
                      │ 通过资源契约提供受控访问
结构：Scene / Group / Node = Callable + 可选 Composite
                      │ runner.build：解算接线、安装调用构造能力
                 原结构（身份不变）
                      │ Runner 启动一次调用
                Invocation ↔ CallableContext
                      │ 当前阶段 Work
                业务处理与显式子调用
                      │ 发布已经发生的事实
           变化捕获                 宿主安装的观测
               │                   ├─ 记录预设
               │                   └─ 其他同步消费者
               └──────── 环境消费与服务交付
```

- `new Node/Group/Scene` 直接构造结构；普通 `*Definition` 配置可经构造器传入，也可在 build 前逐项赋值。结构保留 `deps/run/output/checkpoint`，业务正常/失败接收在操作处用 `result` 表达，观测消费者由宿主安装。
- Scene / Group 通过 `add` 注册可用的 Group / Node，组合体自己的处理函数选择、调用、接纳成员。Node 不具有成员调用端口。
- `new Runner(scene, resources, interactions?).build()` 在原结构上完成一次构建，返回运行器本身；构建后拒绝结构修改。每个成员只属于一个父结构，处理逻辑与资源实体可以复用。每个 Runner 固定一个场景并管理其入口占用，每次运行建立新的 Invocation 和 CallableContext。
- `Invocation` 统一协调调用阶段、直接子关系与交付；Context 保存本次现场。业务作者只取得本阶段 Work、具名资源与受控动作，见 [可调用结构](docs/callable-structures.md)。
- 独立实体由宿主建立，结构绑定其访问形式。资源捕获边界按准确声明身份配置，不因结构叫 Group 就自动重新捕获。
- 观测消费类型化事实，记录是内置的可选结果形式。没有记录，业务调用与内容变化仍然成立。

新记录为 `RecordingRootRecord → CallableRecord` 的真实调用树，保存 `structureKind` 和直接父子关系。Observer 用明确的 `conversation-task` 角色识别对话任务；不是所有 Group 都是一个 QA。任务详情沿用服务契约名 `ExecutionRecordSnapshot`，内部使用通用 `calls` 列表。Checkpoint 使用 **Frame v6**，稳定调用事实只在成立时固定，保存采用增量事实和显式引用选择；当前只接收 v6，不迁移或读取旧 CP 格式。宿主只打开当前数据库格式，旧库保留原文件并明确拒绝，需显式选择新数据库路径。

## 同一个服务中的两种职责

```text
services/observer/src/
  conversation/    scene/conversation、group/node 声明、模型契约、资源绑定、消息同步
  files/           可选工作目录实体与受控文本读写资源
  observation/     记录来源、查询投影、观测交付
  persistence/     多对话的 SQLite 存储与历史记录保存
  assembly/        独立实体、供给、配置与共享变化消费的装配
  http/            对话、实体、观测端点与静态资源
```

`ConversationScene` / `ConversationGroup` 组织对话，`createConversationStructure` 返回宿主需要的明确节点引用；`initializeObserver` 装配单个对话的运行环境，`ObserverConversations` 管理参考服务中的对话目录与按对话装配。`TranscriptFeed` 同步消息实体，`ObservationFeed` 交付观测，它们可以独立连接和关闭。对话使用 `ConversationRequest`，不把它当成通用 Callable 输入契约。

```ts
import { initializeObserver } from '@capix/observer-service/assembly';

const environment = initializeObserver(provider);
const output = await environment.runner.run({ messages: [{ role: 'user', content: '你好' }] }, { settings, signal, progress });
```

上例的 provider、settings、signal 由宿主提供；progress 是为本次请求创建的 `ProgressChannel<ConversationProgress>`，接收可选进展，不参与工作接纳。使用者也可从 `/conversation` 组合已有 Scene / Group / Node，或直接使用 `@capix/server-runtime`：先构造 Scene 并向 Resources 注册供给，再 `const runner = new Runner(scene, resources).build()`，最后 `runner.run(input, options)`。可选 Interactions 作为第三参数接入；无需持有另一个已绑定场景，也不必使用 Observer 的装配。可运行入口见 [examples/runner.mjs](examples/runner.mjs)，完整资源与具名子调用例子见 [examples/dictionary.mjs](examples/dictionary.mjs)。

回答在正式追加消息后交付，随后处理记忆。启用持久化时，正式追加先提交到数据库。后处理失败保留已成立的回答。当前只有生成回答业务显式组织的、针对完整模型输出被拒绝的一次再次生成；没有通用自动重试、后台补偿、动态调度或默认服务未完成调用恢复。

模型请求通过独立 Interaction 发出。请求模型 Group 接纳首个 Node 的有限等待结果，必要时建立新的 Node 调用读取同一交互；不会因为本地等待结束而重发。反馈先保存再交给业务解释，已保存反馈可按 ID 再次读取，与恢复旧调用分开。

## 包与公开入口

| 包或分组                                                                                                              | 当前职责                                                   |
| --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `@capix/contracts`、`@capix/protocol`                                                                                 | 进程内共同契约与稳定数据；真实跨端纯值契约                 |
| `@capix/resources`、`@capix/structure`                                                                                | 资源定义和受控访问；Scene / Group / Node 及作者契约        |
| `@capix/invocation`、`@capix/checkpoint`、`@capix/interaction`                                                        | 单次调用与接纳；固定事实保存和有限恢复；独立外部请求与反馈 |
| `@capix/server-runtime`                                                                                               | 结构绑定、资源装配、Runner、作者端口适配及可选记录安装     |
| `@capix/transcript`、`@capix/memory`、`@capix/view`、`@capix/measurement`、`@capix/records`、`@capix/model-exchanges` | 独立内容、视图、计量、记录和模型交换实体及其资源访问       |
| `@capix/changes`、`@capix/diagnostics`、`@capix/model-provider`                                                       | 变化交付、故障诊断、模型协议适配                           |
| `@capix/observer-content`、`@capix/observer-service`、`@capix/conversation-service`                                   | 内容策略组合、Observer 参考服务、新内核典型对话装配        |
| `@capix/client-runtime`、`@capix/client-http`、`@capix/observer-app`                                                  | 无 UI 的客户端协作、HTTP 适配、React 参考应用              |

内容实体从各自包导入，Runtime 不提供 `/content`。Runtime 的 `/recording`、`/construction` 分别提供可选记录安装和底层构造入口。服务包的 `/conversation`、`/observation`、`/assembly`、`/http` 对应装配职责。所有跨包导入经过公开出口，完整职责见 [项目组织](docs/organization.md)。资源基础对象从 `@capix/resources` 导入，操作契约从 `@capix/resources/operation` 导入；场景资源登记 `Resources` 留在 Runtime，边界见 [资源包](docs/resources-package.md)。

服务端与客户端不互相依赖；HTTP 适配依赖客户端端口；UI 通过应用绑定将客户端状态投影到 Store。实体实例、网络契约和 UI 读模型不互相替代。

## 本地启动与检查

只体验新内核的典型对话装配，可以在 `pnpm build` 后运行 `pnpm conversation --demo`：连续输入、流式回答、消息／记忆／View 保存及重启续用均走公开能力。浏览器入口用 `pnpm conversation:web --demo`，打开 `http://127.0.0.1:4318`。默认离线且使用独立演示库；真实模型需显式 `--live`，可用 `--records /path/to/new.json` 导出本进程调用记录。目录、宿主生命周期与保存边界见 [新对话服务](services/conversation/README.md)。以下命令仍启动原 Observer 界面与 API。

固定工具链：Node **22.23.2**、pnpm **10.7.1**、TypeScript **6.0.3**。所有包共用一个根 Workspace 和锁文件，按独立职责组织。

```sh
pnpm install --frozen-lockfile
cp .env.example .env
# 在本机填写服务需要的模型配置，不提交凭证。
pnpm build
pnpm start
```

默认服务为 `http://127.0.0.1:4317`，提供构建后的界面和 API。开发时先在另一个终端运行 `PORT=4320 pnpm start`，再运行 `pnpm dev`；Vite 的 API 代理可通过 `OBSERVER_API_ORIGIN` 调整。服务端更改后需要重新构建和重启。

`pnpm start` 默认把各对话的消息、记忆、记录和独立模型交互保存到 `.capix/observer.sqlite`，目录已被 Git 忽略。可用 `CAPIX_DATA_DIR` 指定其他目录；它必须位于模型文件工作区之外。同一数据库只允许一个服务进程写入。当前格式的数据库重启后恢复内容与历史记录，并建立新运行环境；不会继续旧 QA、重发模型或文件操作，也不恢复旧提交身份。旧格式数据库不自动升级、清空或覆盖，需保留原库并明确选用新的数据目录；新对话服务对应使用 `--db` 指定新路径。程序化 `initializeObserver(provider)` 仍默认为内存模式，接入方式见 [持久化](docs/persistence.md)。

设置 `CAPIX_FILES_ROOT` 为一个已存在、由宿主管理的本地工作目录可启用文件任务。可在对话中直接说明相对路径和读写要求，也可展开文件任务输入，填写来源和/或结果路径。当前支持最多 64 KiB 的 UTF-8 普通文本，按实际执行时的内容读取；结果仅新建，目录需预先存在。自然语言通过请求理解 Group 提出普通回答、文件、澄清或不支持候选，对话任务接纳后选择已声明的分支；显式文件任务跳过理解。路径缺失时在当前 QA 提问，下一轮重新理解；不以“继续”自动重放历史写入。支持读文件、读后保存、直接生成后保存。明确回答先追加为正式消息，然后才保存；保存失败保留回答。

`WorkspaceFiles` 是独立服务实体，通过 read/create 资源端点提供访问；绑定层在所选 Group 调用建立时按输入收窄到具体路径，资源自行检查不可扩大既有约束。文件能力未启用时普通对话不受影响。发布回执独立于本轮结果：后续取消或记忆失败仍保留已创建文件；反馈断线只恢复同一提交，不重做文件操作。这不是持久化或通用工具平台。

文件目录须由宿主控制。实现检查路径、符号链接、目录身份并独占发布完整文件，但不是对抗其他进程恶意替换目录的操作系统沙箱，也不承诺网络文件系统或进程崩溃后的恢复。临时文件清理是尽力执行；不确定发布结果会明确报告，不能依据调用失败认定文件未创建。

```sh
pnpm check
```

检查覆盖包构建/类型、运行和 HTTP 回归、跨包公开入口、客户端接收、UI 纯逻辑与格式。普通检查使用注入的模型返回，不访问真实模型。真实模型场景是单独显式运行的 `test/live/memory.mjs`。

## Observer 的阅读方式

问答导航固定宽度、独立滚动；主图各轮等宽，密度仅影响主图。默认按直接归属与同级顺序展示可折叠调用树，耗时是独立辅助视图。上下文行展示选中历史、可见记忆和变化关联；全文属于对话或详情。搜索使用客户端已同步的完整消息。

来源完整性、交付顺序和实体版本分别表达。当前记录来源不完整时明确停止观测交付，不能用重新拉快照伪装成修复；消息同步和对话仍独立。重启后以历史归档展示旧来源及其完整性；未结束的旧记录显示“未取得结束记录”，不会一直显示运行中。回答与文档正文已支持有限流式预览，正式消息仍在完整校验和接纳后追加；候选来源、正式消息定位与内容一致性分别确认。有限 checkpoint 恢复是可选内核能力，尚未接入旧对话自动恢复；没有外部能力平台或动态能力注册。
