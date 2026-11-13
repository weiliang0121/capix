---
prev:
  text: 第 4 课：接起模型与工具循环
  link: /guide/notes-model
next:
  text: 第 6 课：用失败检查理解边界
  link: /guide/notes-failures
---

# 第 5 课：装配、运行与收尾

内容、能力和节点都准备好了，现在由宿主把它们接成可运行的一棵结构。`createNotesAssistant` 接收 Provider 和 Notes，而不是自己偷偷选择模型或创建另一份数据。这让同一套业务既能离线验证，也能显式接入外部服务。

## 接起两种模型职责

<<< ../../examples/notes/assistant.mjs#model{js:line-numbers}

`contract` 声明此通道的请求与回复校验。`Interactions.register` 把发送动作接到 `provider.complete`，`bind` 产生给 Tool 使用的通道。另一边，`new ModelExchanges()` 创建本次宿主持有的交换实体，用来保存模型循环材料。

资源登记把两者接给 Tool：`ModelExchangeResource` 提供交换操作，`ToolModelResource` 把交换实体、发送通道和可选请求检查能力组合起来。这样 Tool 能推进模型工作，而不必自己持有某个具体服务的 Key。

最后，`new Scene(assistant)` 建立根结构，Runner 接收结构、资源和交互宿主。`build()` 固定配置和接线，此时还未执行读取或发送。工厂返回 Runner 与 Interactions，是因为宿主既要发起调用，也要照管独立发送的生命周期。

## 发起一次任务，等待退出

<<< ../../examples/notes-assistant.mjs#run{js:line-numbers}

`runner.run({ request })` 才开始这一次任务。两个回调记录真实操作，末尾检查读过两张原便签且只写入一次，再输出最终回答。检查发生在执行之后，不能充当写入之前的业务门禁。

注意 `finally`：Runner 会等待本次已经启动的子调用退出并完成接纳，但 Interaction 与调用独立存活。局部等待结束并不取消独立发送。因此这个只有一次入口的 CLI 停止发起新调用后，还会 `await interactions.settled()`，再 `close()`。关闭通道不是提前中止网络请求的替代品。

## 在入口选择 Provider

<<< ../../examples/notes-assistant.mjs#provider{js:line-numbers}

默认分支实例化离线脚本。`--live` 分支要求显式提供三个配置，然后创建 Chat Completions Provider；它只读当前进程环境，不读取 `.env`。

```sh
export MODEL_ENDPOINT='https://your-provider.example/v1/chat/completions'
export MODEL_NAME='your-model'
export MODEL_API_KEY='your-key'
node examples/notes-assistant.mjs --live
```

这条命令会调用真实服务，需要替换为你实际使用的服务配置；密钥留在终端环境中。业务实体和节点接线都不变，但真实模型的调用次数、选择和回答可能不同。不要用默认四轮脚本的断言承诺真实模型行为。

## 练习：验证入口选择

```sh
node examples/notes-assistant.mjs --help
node examples/notes-assistant.mjs
```

第一条只打印使用说明并退出，不创建材料或调用模型；第二条走默认离线链路。预期看到正常答案，进程完成退出。再沿入口源码找出 Provider 选择、`createMaterials`、工厂调用、`run` 与 `finally`，你就能说明哪些工作属于宿主装配，哪些发生在单次调用内。

成功路径已完整，下一步看失败留下什么：[第 6 课：用失败检查理解边界](./notes-failures.md)。独立发送与局部等待的细节见[交互契约](../interactions.md)。
