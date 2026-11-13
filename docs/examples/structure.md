# 结构与资源

字典是最小受控资源；Sequence 固定完整步骤，Dynamic 由普通成员决定下一步。预设导出工厂，需调用返回的 Runner。

先执行 `pnpm build`，再执行下列命令。所有示例均在本机 Node.js 中运行。

## 把字典查询开放为受控操作

沿 Offer、节点 deps 和宿主登记看一条最小资源接线。工厂返回已构建的 Runner；调用 `run('hello')` 得到「你好」，字典中没有的词保留原值。

由 `pnpm examples:check` 显式调用工厂并检查结果。

<<< ../../examples/dictionary.mjs{js}

## 复用同一结构执行多次调用

观察同一个 Runner 如何先翻译已知词，再处理未知词。运行后终端打印「你好」，断言同时核对第二次返回原词，以及执行结束后 Runner 已释放占用。

```sh
node examples/runner.mjs
```

<<< ../../examples/runner.mjs{js}

## 组合固定步骤与按结果选择的步骤

Sequence 将读取、转大写和保存串起来；Dynamic 由决策节点选择下一步，并为每次组合调用捕获新的临时材料。工厂验证核对内存文档写入大写结果，以及 Dynamic 连续两次运行分别返回各自输入的大写形式。

由 `pnpm examples:check` 显式调用工厂并检查结果。

<<< ../../examples/presets.mjs{js}
