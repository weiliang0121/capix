# 工具、输出与记录

Tool 使用本地离线模型选择已登记工具并消费真实反馈。输出订阅交付业务内容，记录安装保存调用事实；调用退出探针核对关闭故障与占用释放。

先执行 `pnpm build`，再执行下列命令。所有示例均在本机 Node.js 中运行。

## 让模型选择工具并依据真实反馈回答

跟随两轮离线请求：第一轮选择翻译节点，第二轮读取工具反馈形成回答。运行后得到「你好」，断言核对请求恰好两次，且第二次请求包含节点实际产生的反馈。

```sh
node examples/tool.mjs
```

<<< ../../examples/tool.mjs{js}

## 跨多次运行消费输出，再解除订阅

同一个输出订阅接收前两次调用的逐字增量，解除后第三次调用仍能返回最终值。运行后核对事件中的调用身份各不相同、解除订阅后不再新增事件，以及空闲取消返回 false。

```sh
node examples/runner-output.mjs
```

<<< ../../examples/runner-output.mjs{js}

## 同时写业务记录与记录真实调用

节点通过资源写一条自定义记录，可选的 `bindRecording` 安装另行记录实际调用。运行后核对自定义正文与输入一致，并看到 Scene 和 Node 两条成功调用记录；本例没有配置磁盘持久化。

```sh
node examples/records.mjs
```

<<< ../../examples/records.mjs{js}

## 核对关闭故障与占用释放

这是一组诊断探针：主动制造正文与清理错误，检查两者都被保留，并核对 Runner 占用及本地 CP 占用释放。运行后 JSON 中的 checks 应全部为 true；低层身份复用只用于检查占用，不是业务恢复写法，也没有保存可恢复的 point。

```sh
node examples/invocation-exit.mjs
```

<<< ../../examples/invocation-exit.mjs{js}
