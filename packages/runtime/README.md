# @weiliang0121/capix-runtime

装配 CAPiX 场景、资源和运行机制，提供构建并执行场景的 Runner。

## 安装与入口

运行环境为 Node.js `>=22.23.2`。包使用 ESM，附带 TypeScript 类型声明。

```sh
npm install @weiliang0121/capix-runtime
```

- `@weiliang0121/capix-runtime` 提供 `Runner`、场景装配用的 `Resources`、结构声明、交互和运行观测入口。
- `@weiliang0121/capix-runtime/construction` 提供定制宿主使用的底层结构构建、调用与子关系接线。
- `@weiliang0121/capix-runtime/recording` 提供可选记录预设和观测安装。记录实体及数据契约由 `@weiliang0121/capix-records` 提供。

## 用法

从 Runtime 根入口导入 `Runner` 和 `Resources`，用 `new Runner(scene, resources).build()` 固定场景配置、成员与资源接线，再用 `await runner.run(input)` 发起一次独立调用并等待最终结果。字典示例把 `'hello'` 翻译为 `'你好'`，未登记的词原样返回。[字典资源工厂](https://github.com/weiliang0121/capix/blob/main/examples/dictionary.mjs) · [Runner 示例](https://github.com/weiliang0121/capix/blob/main/examples/runner.mjs)

`build()` 返回同一个 Runner。按次资源捕获和 Invocation 建立在 `run()` 中发生。运行期间可通过 `runner.isRunning` 查询占用状态；运行结果在调用退出和收尾完成后交付。运行观测使用 `@weiliang0121/capix-invocation/events` 的进度词汇；可选内容记录通过 `@weiliang0121/capix-records/data` 的公开契约和 records 的领域适配接入。

## 契约与版本记录

- [构建、运行与调用边界](https://github.com/weiliang0121/capix/blob/main/docs/runtime-boundaries.md)
- [业务输出与机制观测](https://github.com/weiliang0121/capix/blob/main/docs/runtime-ports.md)
- [可选记录](https://github.com/weiliang0121/capix/blob/main/docs/recording.md)
- [按版本查阅 CHANGELOG](https://github.com/weiliang0121/capix/blob/main/packages/runtime/CHANGELOG.md)
- [MIT 许可证](LICENSE)
