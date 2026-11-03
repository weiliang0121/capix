# Examples 阅读入口

这些例子沿着“实体与能力 → 资源操作 → 结构 → Runner”展开。先读最小装配，再看服务如何组合材料与业务，最后按需要阅读失败边界。它们不是一套必须全部掌握的配置。

在仓库根目录先执行：

```sh
pnpm build
node examples/runner.mjs
```

下表的直接运行命令都使用本地数据或固定模型响应，不需要凭证。意图实验与历史总结另有显式 `--live` 入口；只有选择这些入口才会调用真实模型，配置与限制见各自说明。

## 1. 基础使用

| 阅读入口                                                    | 要看清的关系                                                                              | 运行                              |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------- |
| [dictionary.mjs](dictionary.mjs) → [runner.mjs](runner.mjs) | Resource 包裹原始对象，Offer 定义操作，Node 通过 deps 申请，Scene 组织，Runner 构建后运行 | `node examples/runner.mjs`        |
| [runner-output.mjs](runner-output.mjs)                      | Scene 声明输出；Runner 提供订阅与取消入口；订阅可跨多次运行，最终值仍从 run 返回          | `node examples/runner-output.mjs` |
| [presets.mjs](presets.mjs)                                  | Sequence 固定步骤，Dynamic 用普通决策 Node 选择成员；公共 deps 与按次供给分别配置         | 导出两个构造函数，见下方          |
| [view.mjs](view.mjs)                                        | 消息、记忆、静态 Skill 材料经来源适配进入 View；读取固定值与维护成员是不同操作            | `node examples/view.mjs`          |
| [records.mjs](records.mjs)                                  | 记录实体既可通过资源写入业务记录，也可承接可选的运行记录预设                              | `node examples/records.mjs`       |

`dictionary.mjs` 与 `presets.mjs` 是可导入模块，不会仅因加载就运行。预设可这样调用：

```sh
node --input-type=module -e 'import { createSequenceRunner, createDynamicRunner } from "./examples/presets.mjs"; const sequence = createSequenceRunner(new Map([["source", "hello"]])); console.log(await sequence.run({ source: "source", destination: "result" })); console.log(await createDynamicRunner().run("hello"));'
```

Sequence / Dynamic 仍是普通 Group 的预设。本例的共享流程材料是普通资源，不会自动保存为 checkpoint。View 只管理可见成员和捕获依据；示例移出成员不删除来源实体，也不提供自动召回或 Skill 执行。

## 2. 服务组合

这些入口使用并排的新装配包 [services/conversation](../services/conversation/README.md)。宿主持有实体、模型与可选交互；业务结构申请资源、形成输入并接纳结果。当前没有替换 Observer 的 HTTP 或客户端。

| 阅读入口                                                     | 验证什么                                                                                 | 运行                                         |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------- | -------------------------------------------- |
| [conversation.mjs](conversation.mjs)                         | 正式追加输入，读取固定历史，回答成功后正式追加助手消息；消费 Runner 观测元数据           | `node examples/conversation.mjs`             |
| [conversation-streaming.mjs](conversation-streaming.mjs)     | 资源增量经回答节点与 Scene 转交到 Runner；预览不作为正式消息保存                         | `node examples/conversation-streaming.mjs`   |
| [conversation-history.mjs](conversation-history.mjs)         | 总结此前历史，接纳正式回答，在后续提交中改写它；本次请求与历史材料分开                   | `node examples/conversation-history.mjs`     |
| [conversation-materials.mjs](conversation-materials.mjs)     | 消息与预置记忆经 View 捕获为固定材料，保留真实来源；宿主调整成员后，下一次调用取得新材料 | `node examples/conversation-materials.mjs`   |
| [conversation-interaction.mjs](conversation-interaction.mjs) | 本次调用取消后外部处理仍存活；新调用按同一引用回放预览、读取最终反馈，不重新发送         | `node examples/conversation-interaction.mjs` |

材料装配建议接着 `view.mjs` 阅读：`createConversationScene(createMaterialAnswer(), createMaterialPreparation())` 将准备与回答作为普通成员组合，传递本次 `query + ViewSnapshot`。消息索引保持原值，记忆保留自己的来源与类型；宿主显式改变下一次可见成员，本次已捕获的值保持不变。它没有自动纳入新消息、提取记忆、筛选材料或处理容量的策略。

历史总结的离线响应验证材料传递和实际执行，不代表模型识别质量。独立交互的反馈读取也不自动把晚到回答写回对话；是否接纳、写到哪里仍由业务决定。该例通过观测捕获引用以演示进程内读取，不承诺可靠的跨调用交接；正式返回与业务保存的边界见下面两个例子。

## 3. 实验与失败边界

| 阅读入口                                                       | 关注点                                                                 | 明确边界                                                                    | 运行                                          |
| -------------------------------------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------- | --------------------------------------------- |
| [意图识别](intent/README.md)                                   | 对照消息、记忆、Skill 材料对候选选择的影响                             | 人工小样本；候选返回计划，不执行真实业务；离线结果不是识别率                | `node examples/intent/run.mjs`                |
| [interaction-message-retry.mjs](interaction-message-retry.mjs) | 发送方正式返回引用；反馈已保存，消息提交前失败，新调用重读并写入       | 引用由宿主变量保留；普通 append 重复消费会产生重复消息；没有跨实体事务      | `node examples/interaction-message-retry.mjs` |
| [business-progress](business-progress/README.md)               | 业务实体保存交接与接纳依据，目标实体确认固定效果，新调用按真实事实继续 | 自定义业务规则与同步内存存储；JSON 重建不是实际进程崩溃；未知发送不自动恢复 | `node examples/business-progress.mjs`         |

`business-progress` 保留实体、资源端点与业务结构的完整实现，便于查看各方责任。它没有提取通用 Progress 实体或流程引擎；其中的操作身份、目标确认与版本比较，也不是每个普通对话都要增加的配置。

失败案例的详细判断见 [交互消费边界验证](../docs/interaction-consumption-validation.md)。这些例子区分了已保存反馈、目标效果与业务接纳，不能用一个例子的成功推导所有外部系统都能安全重试。
