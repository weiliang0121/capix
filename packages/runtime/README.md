# @weiliang0121/capix-runtime

装配 CAPiX 场景、资源和运行机制，提供构建并执行场景的 Runner。

## 安装与入口

包使用 ESM，附带 TypeScript 类型声明。完整回归在 Node.js 22.23.2 上运行，支持范围为 Node.js `>=22.23.2`。其他 JavaScript 宿主按使用的入口配置所需能力。[宿主能力与验证范围](https://github.com/weiliang0121/capix/blob/main/docs/host-platforms.md)

```sh
npm install @weiliang0121/capix-runtime
```

- `@weiliang0121/capix-runtime` 提供 `Runner`、场景装配用的 `Resources`、结构声明和运行观测入口。
- `@weiliang0121/capix-runtime/construction` 提供定制宿主使用的底层结构构建、调用与子关系接线。

调用记录预设现由独立包 `@weiliang0121/capix-recording` 提供。原先从 Runtime 导入的 `bindRecording` 等符号改从该包根入口导入。

## 用法

从 Runtime 根入口导入 `Runner` 和 `Resources`，用 `new Runner(scene, resources).build()` 固定场景配置、成员与资源接线，再用 `await runner.run(input)` 发起一次独立调用并等待最终结果。字典示例把 `'hello'` 翻译为 `'你好'`，未登记的词原样返回。[字典资源工厂](https://github.com/weiliang0121/capix/blob/main/examples/dictionary.mjs) · [Runner 示例](https://github.com/weiliang0121/capix/blob/main/examples/runner.mjs)

`build()` 返回同一个 Runner。按次资源捕获和 Invocation 建立在 `run()` 中发生。运行期间可通过 `runner.isRunning` 查询占用状态；运行结果在调用退出和收尾完成后交付。运行观测使用 `@weiliang0121/capix-invocation/events` 的进度词汇；可选记录预设通过 Runner 的 `observations` 安装。

### 迁移旧版交互装配

宿主从 `@weiliang0121/capix-interaction` 导入 `Interactions`，继续负责登记交互实现和管理渠道。若资源已通过 `resources.register(offer, channel)` 或其他已登记的资源提供渠道，保留原登记，只改 Runner 调用。

| 旧调用                                                | 当前调用                                |
| ----------------------------------------------------- | --------------------------------------- |
| `new Runner(scene, resources, interactions)`          | `new Runner(scene, resources)`          |
| `new Runner(scene, resources, interactions, options)` | `new Runner(scene, resources, options)` |
| `new Runner(scene, resources, undefined, options)`    | `new Runner(scene, resources, options)` |

若原来使用 `resources.registerInteraction(offer, contract)` 依赖 Runner 传入宿主，将这项登记改为 `resources.registerBinding(offer, () => interactions.bind(contract))`。构建时仅对场景实际申请的供给调用同步工厂。

底层 `CallableBuilder.build(structure, resources, options?)` 和 `CallableBinder.bind(structure, resources, options?)` 同样将配置放在第三位。三者均支持通过配置对象的原型提供 `validate` 和 `hooks`。如果现有对象兼有完整的交互宿主接口和构建配置，请将配置提取为独立对象再传入。

## 契约与版本记录

- [构建、运行与调用边界](https://github.com/weiliang0121/capix/blob/main/docs/runtime-boundaries.md)
- [业务输出与机制观测](https://github.com/weiliang0121/capix/blob/main/docs/runtime-ports.md)
- [可选记录](https://github.com/weiliang0121/capix/blob/main/docs/recording.md)
- [按版本查阅 CHANGELOG](https://github.com/weiliang0121/capix/blob/main/packages/runtime/CHANGELOG.md)
- [MIT 许可证](LICENSE)
