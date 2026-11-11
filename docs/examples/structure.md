# 结构与资源

字典是最小受控资源；Sequence 固定完整步骤，Dynamic 由普通成员决定下一步。预设导出工厂，需调用返回的 Runner。

先执行 `pnpm build`，再执行下列命令。所有示例均在本机 Node.js 中运行。

## dictionary

由 `pnpm examples:check` 显式调用工厂并检查结果。

<<< ../../examples/dictionary.mjs{js}

## runner

```sh
node examples/runner.mjs
```

<<< ../../examples/runner.mjs{js}

## presets

由 `pnpm examples:check` 显式调用工厂并检查结果。

<<< ../../examples/presets.mjs{js}
