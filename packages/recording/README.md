# @weiliang0121/capix-recording

将一次调用、子调用关系及资源观测写入宿主选定的 Recorder。Runner 通过 observations 显式安装记录预设，每次调用分别持有自己的记录句柄。

## 安装与入口

包使用 ESM，附带 TypeScript 类型声明。完整回归在 Node.js 22.23.2 上运行，支持范围为 Node.js `>=22.23.2`。其他 JavaScript 宿主按使用的入口配置所需能力。[宿主能力与验证范围](https://github.com/weiliang0121/capix/blob/main/docs/host-platforms.md)

```sh
npm install @weiliang0121/capix-recording @weiliang0121/capix-records @weiliang0121/capix-runtime
```

从 `@weiliang0121/capix-recording` 导入 `bindRecording`，将其返回值放入 Runner 选项的 `observations` 数组。需要解释调用输入、输出或接纳值时，可在构建前调用安装对象的 `describe` 方法。记录实体和存储由 `@weiliang0121/capix-records` 提供。[记录说明](https://github.com/weiliang0121/capix/blob/main/docs/recording.md)

## 迁移

原 Runtime 根入口和 recording 子路径中的记录预设及类型现从本包根入口导入，符号名称保持一致。[版本记录](CHANGELOG.md) · [MIT 许可证](LICENSE)
