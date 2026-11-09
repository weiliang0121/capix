# 文档导航

当前契约、使用说明和历史推演分开阅读。历史报告中的“下一步”“未迁移”及版本号描述当时的实验，不自动成为今天的待办或兼容承诺。

## 当前入口

| 要了解的内容               | 阅读入口                                                                                                                                 |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| 项目对象、包和协作边界     | [项目组织](organization.md)、[契约与协议](contracts-protocol.md)                                                                         |
| 结构和资源怎样装配         | [结构包](structure-package.md)、[可调用结构](callable-structures.md)、[资源包](resources-package.md)                                     |
| 调用、稳定数据、接纳及退出 | [运行边界](runtime-boundaries.md)、[错误与异常](exceptions.md)、[调用退出](invocation-exit-contract.md)                                  |
| CP 保存和有限恢复          | [Checkpoint](checkpoints.md)、[增量引用选择](checkpoint-selection.md)                                                                    |
| 支持哪些旧数据             | [开发期兼容](development-compatibility.md)：只接收当前格式，不迁移旧库或保留旧 CP 解码支路                                               |
| 独立外部交互与模型         | [交互](interactions.md)、[ModelProvider](../server/model-provider/README.md)、[工具预设](../services/conversation/src/tools/README.md)   |
| 内容、视图与策略           | [实体包](content-entities-packages.md)、[消息](transcript.md)、[记忆](memory.md)、[View](view-package.md)、[活跃材料](active-content.md) |
| 记录、观测和运行出口       | [记录](recording.md)、[增量观测](observation-increments.md)、[运行出口](runtime-ports.md)                                                |
| 客户端与跨端协议           | [客户端运行能力](client-runtime.md)、[协议](protocol.md)                                                                                 |

CP 当前是 **Frame v6**；Conversation 数据库是 **schema 8**；Observer 是 **schema 6 加完整当前表形状**。格式版本、业务声明版本和实体修订分别核验，不能互相替代。恢复只消费已保存依据，不恢复草稿、任意执行栈或未确认的外部效果。

## 使用和服务装配

- npm 发布：[分发范围、产物验证、版本 PR 与手动发布](npm-publishing.md)。当前 `@capix` 仅为占位，须确定可用的新品牌与 scope 后再发布。
- 最小资源／结构示例：[dictionary.mjs](../examples/dictionary.mjs)；Runner：[runner.mjs](../examples/runner.mjs)。
- 新内核的典型服务：[Conversation README](../services/conversation/README.md)、[宿主与持久化](conversation-host.md)、[浏览器体验](conversation-web.md)、[显式恢复](conversation-recovery.md)。
- 原 Observer 参考服务：[装配](service-assembly.md)、[对话身份](conversations.md)、[持久化](persistence.md)。两个服务的数据库和业务恢复资格独立。
- 原生工具：[可运行示例](../examples/tool-conversation.mjs)、[工具预设](../services/conversation/src/tools/README.md)。设计过程保留在[协议设计](native-tool-integration.md)和[宿主设计](native-tool-host-integration.md)，现行存储以服务文档为准。

## 实验与实施记录

这些材料解释为什么选择现行契约，保留可复现反例和当轮成本。它们不是并行 API，也不承诺所有实验候选都已进入生产。

| 议题                  | 历史证据与后续实现                                                                                                                                                                                                |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 保存范围和计算成本    | [容量调查](checkpoint-capacity-investigation.md) → [复用边界](checkpoint-reuse-validation.md) → [基准设计](checkpoint-computation-benchmark.md)与[结果](checkpoint-computation-results.md)                        |
| 稳定交付值与事实表示  | [稳定值验证](stable-delivery-validation.md) → [事实与 head](stable-facts-head-validation.md) → [生产接入设计](checkpoint-facts-integration-design.md) → [首次生产迁移](checkpoint-facts-migration.md)             |
| 作者检查、refs 与布局 | [作者契约](checkpoint-author-contract-validation.md)、[真实 ToolLoop 对照](checkpoint-tool-policy-validation.md)、[按需查询](saved-facts-view-validation.md)、[跨点布局](checkpoint-point-layout-validation.md)   |
| 事实成立与资源边界    | [推进事实](invocation-facts-progress-validation.md)、[生命周期](invocation-lifecycle-facts-validation.md)、[action／资源](action-resource-boundaries-validation.md)、[接纳契约](reception-contract-validation.md) |
| 恢复承诺              | [切点覆盖](checkpoint-recovery-coverage.md)、[重放对照](recovery-replay-comparison.md)、[运行恢复验证](recovery-runtime-validation.md)                                                                            |
| 性能演进              | [首次迁移测量](stable-facts-migration-performance.md) → [关系解析复用](checkpoint-relation-query-validation.md) → [增量选择与最新测量](checkpoint-selection.md)                                                   |
| 工具宿主              | [首轮宿主验证](native-tool-host-validation.md)，当前边界见[宿主](conversation-host.md)与[恢复](conversation-recovery.md)                                                                                          |

更早的 [REOA 声明](definition-author-contract.md)、[类型推演](codex-type-factorization.md)、[Checkpoint 设计历史](checkpoint-design-history.md)、[恢复研究](recovery.md)、[总体评审](review.md)与[观测推演](observation.md)保留讨论语境。遇到旧名称、旧格式或已删除入口，先回到上面的当前契约，不据历史伪代码添加兼容路径。
