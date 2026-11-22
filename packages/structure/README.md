# @weiliang0121/capix-structure

定义可组合的 Scene、Group、Node，以及作者使用的成员、资源和恢复声明。

## 安装与入口

包使用 ESM，附带 TypeScript 类型声明。完整回归在 Node.js 22.23.2 上运行，支持范围为 Node.js `>=22.23.2`。其他 JavaScript 宿主按使用的入口配置所需能力。[宿主能力与验证范围](https://github.com/weiliang0121/capix/blob/main/docs/host-platforms.md)

```sh
npm install @weiliang0121/capix-structure
```

- `@weiliang0121/capix-structure` 提供 `Callable`、`Scene`、`Group`、`Node`、`Sequence`、`Dynamic` 和作者声明。
- `@weiliang0121/capix-structure/construction` 提供宿主构建时使用的结构配置状态、成员名检查和资源依赖读取。

## 用法

字典示例从本包导入 `Node` 和 `Scene`。Node 在 `deps` 声明字典操作，在 `run(work)` 读取本次输入和资源端点。`new Scene(translate)` 登记该节点、把场景输入交给它，并使用它的结果。宿主通过 `@weiliang0121/capix-runtime` 的 `Runner` 构建并运行场景。[字典资源工厂](https://github.com/weiliang0121/capix/blob/main/examples/dictionary.mjs) · [运行示例](https://github.com/weiliang0121/capix/blob/main/examples/runner.mjs)

Group 可以登记成员并声明如何调用它们。每个结构实例在树中只有一个位置，多处使用同一逻辑时为各位置创建实例。Sequence 按固定次序运行成员，Dynamic 由决策成员选择调用已登记的候选或交付最终结果。[预设示例](https://github.com/weiliang0121/capix/blob/main/examples/presets.mjs)

## 契约与版本记录

- [可调用结构与作者声明](https://github.com/weiliang0121/capix/blob/main/docs/callable-structures.md)
- [结构包与宿主构建边界](https://github.com/weiliang0121/capix/blob/main/docs/structure-package.md)
- [按版本查阅 CHANGELOG](https://github.com/weiliang0121/capix/blob/main/packages/structure/CHANGELOG.md)
- [MIT 许可证](LICENSE)
