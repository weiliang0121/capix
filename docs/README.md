# 文档导航

当前契约、使用说明和历史推演分开阅读。历史报告中的“下一步”“未迁移”及版本号描述当时的实验，不自动成为今天的待办或兼容承诺。

## 当前入口

| 要了解的内容               | 阅读入口                                                                                                                                         |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 项目对象、包和协作边界     | [项目组织](organization.md)、[契约与协议](contracts-protocol.md)                                                                                 |
| 结构和资源怎样装配         | [结构包](structure-package.md)、[可调用结构](callable-structures.md)、[资源包](resources-package.md)                                             |
| 调用、稳定数据、接纳及退出 | [运行边界](runtime-boundaries.md)、[错误与异常](exceptions.md)、[调用退出](invocation-exit-contract.md)                                          |
| CP 保存和有限恢复          | [Checkpoint](checkpoints.md)、[增量引用选择](checkpoint-selection.md)                                                                            |
| 支持哪些旧数据             | [开发期兼容](development-compatibility.md)：只接收当前格式，不迁移旧库或保留旧 CP 解码支路                                                       |
| 独立外部交互与模型         | [交互](interactions.md)、[ModelProvider](../packages/model-provider/README.md)、[Tool 预设](../packages/tool/README.md)                          |
| 内容、视图与策略           | [实体包](content-entities-packages.md)、[消息](transcript.md)、[记忆](memory.md)、[View](view-package.md)、[Lab 活跃材料边界](active-content.md) |
| 业务自定义实体与可选能力   | [自定义实体](custom-entities.md)、[可运行例子](../examples/entities.mjs)                                                                         |
| 记录、观测和运行出口       | [记录](recording.md)、[增量观测](observation-increments.md)、[运行出口](runtime-ports.md)                                                        |
| 客户端与跨端协议           | [客户端运行能力](client-runtime.md)、[协议](protocol.md)                                                                                         |

CP 当前是 **Frame v6**；Conversation 数据库是 **schema 8**；Observer 是 **schema 6 加完整当前表形状**。格式版本、业务声明版本和实体修订分别核验，不能互相替代。恢复只消费已保存依据，不恢复草稿、任意执行栈或未确认的外部效果。

## 使用和服务装配

- npm 发布：[分发范围、产物验证、版本 PR 与本地发布](npm-publishing.md)。17 个 `@weiliang0121/capix-*` 包已发布 `0.1.0`；新增 [Tool 预设](../packages/tool/README.md) 已纳入分发配置但尚未发布；其余私有 workspace 不在首发范围。
- 最小资源／结构示例：[dictionary.mjs](../examples/dictionary.mjs)；Runner：[runner.mjs](../examples/runner.mjs)。
- 新内核的典型服务：[Conversation README](../../capix-lab/services/conversation/README.md)、[宿主与持久化](../../capix-lab/docs/conversation-host.md)、[浏览器体验](../../capix-lab/docs/conversation-web.md)、[显式恢复](../../capix-lab/docs/conversation-recovery.md)。
- 原 Observer 参考服务：[装配](../../capix-lab/docs/service-assembly.md)、[对话身份](../../capix-lab/docs/conversations.md)、[持久化](../../capix-lab/docs/persistence.md)。两个服务的数据库和业务恢复资格独立。ActiveView、ConversationContent、内容同步及其测试由 [Lab observer-content](../../capix-lab/services/observer-content/README.md) 维护，当前不属于框架公开预设。
- 原生工具：[可运行示例](../../capix-lab/examples/tool-conversation.mjs)、[工具预设](../../capix-lab/services/conversation/src/tools/README.md)。设计过程保留在[协议设计](native-tool-integration.md)和[宿主设计](../../capix-lab/docs/native-tool-host-integration.md)，现行存储以服务文档为准。

## 仓库组织与开源准备

- [客户端、协议与实体边界收敛计划](kernel-boundary-migration-plan.md)：近期迁移顺序、阶段完成条件和测试归属；P0／P1 已完成客户端交接，P2 已接通类型化领域事实与普通业务材料。P3 Memory 已独立，P4 领域类型与业务协议已归位；P5 已完成自定义实体入口及独立消费验证，下一步 P6 仓库与契约收尾。Lab 未升级新框架候选。
- [仓库拆分设计](repository-split-design.md)：框架与实验／参考装配两个仓库的目标目录、能力归属、验证交接和分阶段迁移。第一版已实施，后续候选仍需逐项明确边界。
- [包命名与开源准备](open-source-preparation.md)：统一 `packages/` 的长期布局、保留真实客户端职责、已发布包身份，以及公共入口、贡献说明与公开历史的逐步准备。已落实公开入口与包目录；未改变仓库可见性。

- [拆库实施记录](repository-split-implementation.md)：实际两仓边界、完整产物交接、回归与待办。
- [包内测试与框架自证设计](testing-organization-design.md)：测试随包、全局公共基础与有限仓库检查；CAPiX 独立验收，Lab 仅承担实验与参考装配。已迁移包内测试与命令；[实施与清单](testing-migration.md)。
- [本地内容审阅](open-source-content-audit.md)：Git 历史／当前树的审阅范围和未确认的公开事项。

## 实验与实施记录

- [实体能力契约盘点与迁移候选](entity-capabilities-audit.md)：共同能力、现有专用实体、固定读取、领域观测及协议归属的初始源码盘点。实施进度见迁移计划，不把历史候选当作当前 API。
- [Memory 收敛设计](memory-convergence-design.md)：记忆领域边界、固定读取、整批写入、固定凭据及持久不确定处理；保留设计推导；P3 已实施，当前 API 见记忆文档。

以下历史报告与完整参考服务已交接到相邻 `capix-lab`。跨仓链接用于本地并排检出；Lab 尚无远端地址，不将这些链接宣称为已经公开的网页。

这些材料解释为什么选择现行契约，保留可复现反例和当轮成本。它们不是并行 API，也不承诺所有实验候选都已进入生产。

| 议题                  | 历史证据与后续实现                                                                                                                                                                                                                                                                                    |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 保存范围和计算成本    | [容量调查](../../capix-lab/docs/checkpoint-capacity-investigation.md) → [复用边界](../../capix-lab/docs/checkpoint-reuse-validation.md) → [基准设计](../../capix-lab/docs/checkpoint-computation-benchmark.md)与[结果](../../capix-lab/docs/checkpoint-computation-results.md)                        |
| 稳定交付值与事实表示  | [稳定值验证](../../capix-lab/docs/stable-delivery-validation.md) → [事实与 head](../../capix-lab/docs/stable-facts-head-validation.md) → [生产接入设计](../../capix-lab/docs/checkpoint-facts-integration-design.md) → [首次生产迁移](../../capix-lab/docs/checkpoint-facts-migration.md)             |
| 作者检查、refs 与布局 | [作者契约](../../capix-lab/docs/checkpoint-author-contract-validation.md)、[真实 ToolLoop 对照](../../capix-lab/docs/checkpoint-tool-policy-validation.md)、[按需查询](../../capix-lab/docs/saved-facts-view-validation.md)、[跨点布局](../../capix-lab/docs/checkpoint-point-layout-validation.md)   |
| 事实成立与资源边界    | [推进事实](../../capix-lab/docs/invocation-facts-progress-validation.md)、[生命周期](../../capix-lab/docs/invocation-lifecycle-facts-validation.md)、[action／资源](../../capix-lab/docs/action-resource-boundaries-validation.md)、[接纳契约](../../capix-lab/docs/reception-contract-validation.md) |
| 恢复承诺              | [切点覆盖](../../capix-lab/docs/checkpoint-recovery-coverage.md)、[重放对照](../../capix-lab/docs/recovery-replay-comparison.md)、[运行恢复验证](../../capix-lab/docs/recovery-runtime-validation.md)                                                                                                 |
| 性能演进              | [首次迁移测量](../../capix-lab/docs/stable-facts-migration-performance.md) → [关系解析复用](../../capix-lab/docs/checkpoint-relation-query-validation.md) → [增量选择与最新测量](checkpoint-selection.md)                                                                                             |
| 工具宿主              | [首轮宿主验证](../../capix-lab/docs/native-tool-host-validation.md)，当前边界见[宿主](../../capix-lab/docs/conversation-host.md)与[恢复](../../capix-lab/docs/conversation-recovery.md)                                                                                                               |

更早的 [REOA 声明](../../capix-lab/docs/definition-author-contract.md)、[类型推演](../../capix-lab/docs/codex-type-factorization.md)、[Checkpoint 设计历史](../../capix-lab/docs/checkpoint-design-history.md)、[恢复研究](../../capix-lab/docs/recovery.md)、[总体评审](../../capix-lab/docs/review.md)与[观测推演](../../capix-lab/docs/observation.md)保留讨论语境。遇到旧名称、旧格式或已删除入口，先回到上面的当前契约，不据历史伪代码添加兼容路径。
