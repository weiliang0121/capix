# Examples 阅读入口

这些例子沿着“实体与能力 → 资源操作 → 结构 → Runner”展开。先读最小装配，再看服务如何组合材料与业务，最后按需要阅读失败边界。它们不是一套必须全部掌握的配置。

需要完整的可持续使用入口时，直接阅读 [对话装配服务](../services/conversation/README.md)，构建后执行 `pnpm conversation --demo`。它组合这里已经验证的能力，提供连续输入、流式展示、消息／记忆／View 持久化与重载。下面的 examples 继续各自解释一个问题；服务不导入它们，也不另建一套 example 专用装配生命周期。

在仓库根目录先执行：

```sh
pnpm build
node examples/runner.mjs
```

下表的直接运行命令都使用本地数据或固定模型响应，不需要凭证。意图实验、历史总结与记忆流式验证另有显式 `--live` 入口；只有选择这些入口才会调用真实模型，配置与限制见各自说明。

## 1. 基础使用

| 阅读入口                                                    | 要看清的关系                                                                              | 运行                                |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------- |
| [dictionary.mjs](dictionary.mjs) → [runner.mjs](runner.mjs) | Resource 包裹原始对象，Offer 定义操作，Node 通过 deps 申请，Scene 组织，Runner 构建后运行 | `node examples/runner.mjs`          |
| [runner-output.mjs](runner-output.mjs)                      | Scene 声明输出；Runner 提供订阅与取消入口；订阅可跨多次运行，最终值仍从 run 返回          | `node examples/runner-output.mjs`   |
| [presets.mjs](presets.mjs)                                  | Sequence 固定步骤，Dynamic 用普通决策 Node 选择成员；公共 deps 与按次供给分别配置         | 导出两个构造函数，见下方            |
| [view.mjs](view.mjs)                                        | 消息、记忆、静态 Skill 材料经来源适配进入 View；读取固定值与维护成员是不同操作            | `node examples/view.mjs`            |
| [view-membership.mjs](view-membership.mjs)                  | 策略节点直接纳入或移除已知引用；不读取全部目录，重复决定不产生成员变更                    | `node examples/view-membership.mjs` |
| [records.mjs](records.mjs)                                  | 记录实体既可通过资源写入业务记录，也可承接可选的运行记录预设                              | `node examples/records.mjs`         |

`dictionary.mjs` 与 `presets.mjs` 是可导入模块，不会仅因加载就运行。预设可这样调用：

```sh
node --input-type=module -e 'import { createSequenceRunner, createDynamicRunner } from "./examples/presets.mjs"; const sequence = createSequenceRunner(new Map([["source", "hello"]])); console.log(await sequence.run({ source: "source", destination: "result" })); console.log(await createDynamicRunner().run("hello"));'
```

Sequence / Dynamic 仍是普通 Group 的预设。本例的共享流程材料是普通资源，不会自动保存为 checkpoint。View 只管理可见成员和捕获依据；示例移出成员不删除来源实体，也不提供自动召回或 Skill 执行。

`view.mjs` 展示基于摘要的整体筛选，通过 `apply` 核验原来的版本依据；`view-membership.mjs` 展示业务已掌握准确引用时使用 `include/exclude`。后者免去业务侧成员数组重组，但有变化时 View 仍构造完整状态；两个操作分别提交，不承诺组合事务。

## 2. 服务组合

这些入口使用并排的新装配包 [services/conversation](../services/conversation/README.md)。宿主持有实体、模型与可选交互；业务结构申请资源、形成输入并接纳结果。当前没有替换 Observer 的 HTTP 或客户端。

| 阅读入口                                                                           | 验证什么                                                                           | 运行                                                    |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------- |
| [conversation.mjs](conversation.mjs)                                               | 正式追加输入，读取固定历史，回答成功后正式追加助手消息；消费 Runner 观测元数据     | `node examples/conversation.mjs`                        |
| [conversation-streaming.mjs](conversation-streaming.mjs)                           | 资源增量经回答节点与 Scene 转交到 Runner；预览不作为正式消息保存                   | `node examples/conversation-streaming.mjs`              |
| [conversation-history.mjs](conversation-history.mjs)                               | 总结此前历史，接纳正式回答，在后续提交中改写它；本次请求与历史材料分开             | `node examples/conversation-history.mjs`                |
| [conversation-materials.mjs](conversation-materials.mjs)                           | 选装普通策略纳入正式消息；两次提交通过 View 读取前次消息与预置记忆，本次捕获不漂移 | `node examples/conversation-materials.mjs`              |
| [conversation-memory.mjs](conversation-memory.mjs)                                 | 回答后提取并写入记忆，新 ID 纳入 View；后续更新保留 ID，已退出的记忆不自动纳回     | `node examples/conversation-memory.mjs`                 |
| [conversation-interaction.mjs](conversation-interaction.mjs)                       | 本次调用取消后外部处理仍存活；新调用按同一引用回放预览、读取最终反馈，不重新发送   | `node examples/conversation-interaction.mjs`            |
| [conversation-completion-interaction.mjs](conversation-completion-interaction.mjs) | 材料回答选装完整模型交互；正式交付引用后取消读取，保留完成原因与用量再次消费       | `node examples/conversation-completion-interaction.mjs` |

材料装配建议接着 `view.mjs` 与 `view-membership.mjs` 阅读：`createConversationScene(createMaterialAnswer(), createMaterialPreparation(), createMessageInclusion())` 将准备、回答与可选维护作为普通成员组合。宿主分别登记 `ConversationViewResource.read/manage`，策略在用户正式追加后、准备前，以及助手正式追加并完成回答接纳后纳入该条消息。准备节点传递独立的本次 query 与固定材料，始终排除当前及更晚的消息；下一次调用自然看到前次已纳入的正式消息，本次捕获不会随 View 后续变化而漂移。

不装载维护节点就保持原有行为。`createMessageInclusion()` 只纳入本次正式消息，不补纳历史缺口，不提取记忆或筛选、限制材料容量；`conversation-materials.mjs` 中的记忆由宿主预置后只读。消息与 View 没有统一事务：用户消息后的维护失败不进入模型；助手消息后的维护失败保留正式回答及子接纳，但 Scene 仍失败。下一次按 View 的真实成员读取，不自动修复或重试。

`conversation-memory.mjs` 从空记忆集合开始，将 `createMessageInclusion()` 和 `createMemoryMaintenance()` 放进普通 Group 依次调用。正式助手回答后，维护读取固定前缀与记忆全集，通过固定模型替身形成提案，再以捕获的身份和序列核对后写入；仅将实际新建项的真实 ID 纳入 View。后续准备读取已纳入内容；更新保留 ID，已退出的记忆即使再次更新也不自动纳回。策略决定提案与成员维护，实体保存正式内容，View 选择材料；消息、记忆与 View 分别提交，离线示例不代表真实模型提取效果。

需要检查真实提供者时，使用 [conversation-memory-live.mjs](conversation-memory-live.mjs)：

```sh
node examples/conversation-memory-live.mjs --live --out /tmp/capix-conversation-memory.jsonl
```

宿主提供 `DEEPSEEK_API_KEY` 和可选 `DEEPSEEK_MODEL`；脚本不读取 `.env`，没有 `--live` 时只打印说明。固定三次人工提交、最多五次请求、不自动重试，输出文件不可已存在。前两次表达及更正偏好，各自执行流式回答和完整前缀记忆提取；第三次移出历史消息的 View 成员但保留原文，只验证已更新记忆的回答，不再提取。这是实验策略，不改变服务默认维护行为。JSONL 保留实际请求材料、首增量与完成耗时、模型 usage、子接纳事实、正式消息和记忆快照；不记录密钥。实体在本进程内接纳，报告文件不等同于数据库持久化，也不证明重启恢复或模型普遍准确率。

如果报告已含成功的第一次提交，可加 `--after-first previous-report.jsonl`，只补跑后两次、最多三次请求。它校验并加载第一轮正式内容快照作为测试材料，重新建立 Runner；不使用失败提交后的状态，不恢复 Invocation、流游标或外部交互。新报告记录样本来源，便于区分本次结果与已有结果。

历史总结的离线响应验证材料传递和实际执行，不代表模型识别质量。独立交互的反馈读取也不自动把晚到回答写回对话；是否接纳、写到哪里仍由业务决定。该例通过观测捕获引用以演示进程内读取，不承诺可靠的跨调用交接；正式返回与业务保存的边界见下面两个例子。

## 3. 实验与失败边界

| 阅读入口                                                       | 关注点                                                                 | 明确边界                                                                    | 运行                                          |
| -------------------------------------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------- | --------------------------------------------- |
| [意图识别](intent/README.md)                                   | 对照消息、记忆、Skill 材料对候选选择的影响                             | 人工小样本；候选返回计划，不执行真实业务；离线结果不是识别率                | `node examples/intent/run.mjs`                |
| [interaction-message-retry.mjs](interaction-message-retry.mjs) | 发送方正式返回引用；反馈已保存，消息提交前失败，新调用重读并写入       | 引用由宿主变量保留；普通 append 重复消费会产生重复消息；没有跨实体事务      | `node examples/interaction-message-retry.mjs` |
| [business-progress](business-progress/README.md)               | 业务实体保存交接与接纳依据，目标实体确认固定效果，新调用按真实事实继续 | 自定义业务规则与同步内存存储；JSON 重建不是实际进程崩溃；未知发送不自动恢复 | `node examples/business-progress.mjs`         |

`business-progress` 保留实体、资源端点与业务结构的完整实现，便于查看各方责任。它没有提取通用 Progress 实体或流程引擎；其中的操作身份、目标确认与版本比较，也不是每个普通对话都要增加的配置。

失败案例的详细判断见 [交互消费边界验证](../docs/interaction-consumption-validation.md)。这些例子区分了已保存反馈、目标效果与业务接纳，不能用一个例子的成功推导所有外部系统都能安全重试。
