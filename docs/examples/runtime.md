# 工具、输出与记录

Tool 使用本地离线模型选择已登记工具并消费真实反馈。输出和记录分别订阅真实运行；调用退出探针核对关闭故障与占用释放。

先执行 `pnpm build`，再执行下列命令。所有示例均在本机 Node.js 中运行。

## tool

```sh
node examples/tool.mjs
```

<<< ../../examples/tool.mjs{js}

## runner-output

```sh
node examples/runner-output.mjs
```

<<< ../../examples/runner-output.mjs{js}

## records

```sh
node examples/records.mjs
```

<<< ../../examples/records.mjs{js}

## invocation-exit

```sh
node examples/invocation-exit.mjs
```

<<< ../../examples/invocation-exit.mjs{js}
