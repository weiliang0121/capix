---
prev:
  text: 第 1 课：谁拥有便签
  link: /guide/notes-entities
next:
  text: 第 3 课：让 Node 完成一次工作
  link: /guide/notes-nodes
---

# 第 2 课：把操作交给资源

Notes 同时有 `read` 和 `append`，读取节点却只需要前者。直接把整个 Notes 交给每个节点，会让每处业务都依赖实体的全部方法。资源让我们把“实体拥有内容”与“这段逻辑可以执行什么操作”分别表达。

## 先定义两种操作

<<< ../../examples/notes/assistant.mjs#resources{js:line-numbers}

两个 `ResourceOffer` 分别开放 `read` 与 `append`。方法的第一个参数 `notes` 是绑定到的业务对象，后面的 `id` 或 `value` 才来自这次操作。Offer 描述操作，创建 Offer 本身不读取、不写入便签。

为什么再包一层已有方法？这里能明确每种能力的范围，也能组合宿主行为：读取成功后才调用 `onRead`，追加成功后才调用 `onWrite`。它们是示例主动安排的日志回调；这些日志帮助我们核对任务，不等同于内核记录系统。

两个回调都发生在实体方法返回之后。尤其 `onWrite` 被调用时，便签已经追加了。如果以后把回调改成可能失败的工作，就必须理解这个先后关系，不能因为回调出错便认定写入没有发生。

## 申请操作，再绑定实体

<<< ../../examples/notes/assistant.mjs#nodes{js:line-numbers}

先只看 `deps`。`reading.request()` 声明读节点对这一种 Offer 的请求，`writing.request()` 则属于写节点。`notes` 是节点给依赖起的局部名字，因而两个节点都能写 `work.resources.notes`，却各自得到不同的操作集合。

请求还需要实际供应。下面装配代码的前两次 `register`，把同一个 Notes 分别绑定到两种 Offer：

<<< ../../examples/notes/assistant.mjs#assembly{js:line-numbers}

`new Resource(notes)` 把宿主对象纳入资源绑定；`register(..., reading)` 和 `register(..., writing)` 提供可匹配的能力。这里创建了两个包装，底层仍是同一个 `notes`，因此写入后能从同一集合读回。其余两次登记是模型所需能力，第 5 课再解释。

依赖和登记要一起读：`deps` 说明节点需要什么，`Resources` 说明宿主提供什么。只起一个相同的属性名，并不能凭空取得操作；也不能因为宿主有写能力，就推导所有后代都应获得它。本层依赖与子树供应的完整规则见[资源契约](../resources-package.md)。

## 练习：沿读路径找一次接线

打开 `assistant.mjs`，依次找到 `reading`、读节点的 `reading.request()`、`register(new Resource(notes), reading)`，然后运行：

```sh
node examples/notes-assistant.mjs
```

预期仍是两次读取和一次写入。对着输出，指出每条日志在哪个 Offer 中产生，以及该节点能调用哪个操作。这次练习不需要改代码：能完整追到这三个位置，才算理解接线。

接下来把注意力从依赖移到 `run`，看输入和结果如何流动：[第 3 课：让 Node 完成一次工作](./notes-nodes.md)。
