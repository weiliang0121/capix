---
prev:
  text: 第 6 课：用失败检查理解边界
  link: /guide/notes-failures
next: false
---

# 第 7 课：加一个查询，再回看全局

现在你已经能从输入追到真实写入。接下来给助手增加一种用途：按关键词查找便签。先让普通 Node 独立工作，能把业务查询本身与模型是否选择它分别验证。

## 用同一份 Notes 增加能力

```sh
node examples/notes/search.mjs
```

这个可运行入口创建材料，运行原助手，再用新的查询节点搜索同一份 Notes。预期能查到助手刚创建的「待办」，而原来的两张便签也仍然存在。查询不应追加或改写便签。

<<< ../../examples/notes/search.mjs{js:line-numbers}

阅读时把代码对应到前面三课：新的 `ResourceOffer` 开放查询操作；Node 用 `deps` 申请它，并从本次输入取关键词；宿主把该 Offer 登记到已有 Notes，再建立 Scene 和 Runner 执行查询。它复用的是内容实体，不是把同一个结构实例挂到两棵树上。

为什么此时不先改提示？普通节点的运行结果可以直接核对。查询是否正确，与模型在一次对话中是否愿意查找，是两个不同问题。先独立验证前者，再把它加入模型选择范围，出问题时更容易定位。

## 从普通节点走到新工具

如果要让模型使用查询，下一步应当在创建 Tool 时增加登记：选择工具名称，给出 description 和严格的输入 schema，把新 Node 与结果映射放入条目，同时供应它需要的资源。目录来自登记成员，提示里提到“搜索”不会自动产生工具。

当前离线 Provider 只实现两次读、一次写和最终回复，不会因为你登记新工具就自动改用搜索。要验证新的调用顺序，需要给它明确的新决策和反馈检查，或另写专门的离线验证；接入真实模型时，也仍要检查实际调用和结果。

## 练习：检验实体确实共享

运行查询入口，对照源码中传给原助手和查询资源的 Notes 是否是同一个对象，再找出查询对新便签的断言。预期查询能够读取运行中新增的内容，查询前后集合大小不变。

这一点区别于再次调用 `createMaterials()`：后者会产生新的集合和新的便签 ID，不能读到先前助手写入的材料。扩展一项能力时，先决定复用哪个内容所有者，再建立独立的操作和结构。

## 完整源码，回看接线

下面保留完整文件，方便从头核对导入、参数与清理。逐章片段与这里的实现来自同一份源码。

::: code-group

<<< ../../examples/notes/assistant.mjs{js:line-numbers} [assistant.mjs]

<<< ../../examples/notes-assistant.mjs{js:line-numbers} [notes-assistant.mjs]

<<< ../../examples/notes/materials.mjs{js:line-numbers} [materials.mjs]

<<< ../../examples/notes/offline-provider.mjs{js:line-numbers} [offline-provider.mjs]

<<< ../../examples/entities/domain.mjs{js:line-numbers} [domain.mjs]

:::

`domain.mjs` 里的 Plan 属于其他实体示例，本教程只用 Notes。把完整项目连起来看：实体拥有内容，资源开放操作，Node 完成单步工作，Tool 把登记成员组成模型循环，宿主提供模型通道并负责运行与收尾。新增查询沿用这些已有职责，不需要把查询逻辑塞进 Provider。

## 接下来深入哪一层

想把这些经验整理成可复用的判断方法，可以读[核心概念](../concepts/index.md)：围绕同一个助手，分别理解实体、资源、结构、调用与交互，再决定观测和恢复如何加入。

想组合固定顺序或动态子任务，继续看[结构与资源示例](../examples/structure.md)；想组织更多材料的读取范围，看[实体与视图](../examples/content.md)。需要解释运行过程时，可以从[输出与记录](../examples/runtime.md)接入观测。

希望失败后继续执行，则先读[Checkpoint](../checkpoints.md)与[恢复选择](../checkpoint-selection.md)。本例没有配置 CP、Store 或持久化，也没有把 JavaScript 栈保存下来；正式恢复需要作者选择的 point 和完整依据。便签重启后仍存在，也需要业务实体自己的存储支持，不能单靠给 Runner 加一个开关实现。
