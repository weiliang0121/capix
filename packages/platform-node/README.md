# @weiliang0121/capix-platform-node

提供 Node.js `>=22.23.2` 的原生平台实现。CAPiX 在 Node 和 Electron 主进程的 Node 条件下自动选择此实现。其他 JavaScript 宿主从 `@weiliang0121/capix-platform` 接入。[宿主能力与验证范围](https://github.com/weiliang0121/capix/blob/main/docs/host-platforms.md)

```sh
npm install @weiliang0121/capix-platform-node
```

`@weiliang0121/capix-platform-node` 提供系统 UUID 函数和引擎对象检查谓词。对象检查使用 Node 的原生类型判断识别 Proxy、Error 和 Promise。`@weiliang0121/capix-platform-node/equal` 提供 Node 原生深比较，保留已发布包对自定义 schema 结果的比较行为。
