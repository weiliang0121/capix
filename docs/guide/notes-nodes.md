---
prev:
  text: 第 2 课：把操作交给资源
  link: /guide/notes-resources
next:
  text: 第 4 课：接起模型与工具循环
  link: /guide/notes-model
---

# 第 3 课：让 Node 完成一次工作

资源已经准备好，但还没有谁来执行“读这一张便签”。Node 把一次工作的输入、所需能力和执行逻辑放到明确的位置，让同一段定义能够被调用。

## 输入进入，业务材料返回

<<< ../../examples/notes/assistant.mjs#nodes{js:line-numbers}

`readNote` 的本次输入在 `work.input` 中，取出 `id` 后交给资源操作。`writeNote` 则把含标题和正文的整个输入交给 `append`。`work.resources` 是按依赖取得的操作入口，`work.input` 是这次调用的正式输入。

两段 `run` 都直接返回资源操作的结果。因此，读节点返回已有便签材料，写节点返回刚追加的便签材料；ID 由实体生成，不由节点猜测。它们无需知道提供 Notes 的宿主是谁，也不用自己挑选 Provider。

这个区分对复用很有用：Node 是结构定义，不能把某次输入或上次结果存在 Node 上。`build` 固定结构配置和接线；真正运行时，框架才建立本次调用的输入和活动窗口。把按次数据留在 `work`，就不会把一回任务混进下一回结构配置。

## 节点如何成为模型可选的工具

<<< ../../examples/notes/assistant.mjs#tool-registration{js:line-numbers}

`tools` 中的键 `readNote`、`writeNote` 是模型会看到的名称，条目里的 `node` 才是真正执行的结构成员。description 解释用途，`input` 约束参数形状。读取要求 UUID，写入要求非空标题和正文，`strictObject` 还会拒绝额外字段。

校验在这里与操作分工：UUID 格式正确并不说明 Notes 中存在该 ID，是否存在仍由 `Notes.read` 判断。schema 也没有表达“必须先读两张再写”；若这是不可违反的业务约束，就需要在业务设计中明确执行它。

再看 `result.succeeded`：它把 Node 返回的真实材料编码成 JSON 文本，交给模型作为工具反馈。节点结果和模型反馈各有用途；工具映射只转换形状，不在这里再写一次便签。模型下一轮得到的 ID、标题和正文，来自本次实际返回值。

## 练习：分辨三个相邻的结果

运行默认入口：

```sh
node examples/notes-assistant.mjs
```

在完整源码中沿写路径查找：`Notes.append` 返回材料，`writeNote.run` 原样返回它，`result.succeeded` 把它转成反馈。最后对照终端「本次新增便签」与最终回答：前者有实体 ID，后者是面向用户的文本。

预期两者的标题和事项相同，但表达形状不同。能指出这几个位置，就可以回答“模型说成功”和“节点完成写入”分别由什么证据支持。后续若要更换回答措辞，通常不必改实体；若要改变写入规则，则应检查实体和操作。

有了可执行的节点，还需要有人在多轮请求中挑选它们。进入[第 4 课：接起模型与工具循环](./notes-model.md)；Node 与结构的完整定义见[结构契约](../structure-package.md)。
