# @weiliang0121/capix-invocation

Invocation 管理一次调用的资源窗口、子调用关系、接纳、检查点活动与最终交付。

## 安装与入口

运行环境为 Node.js `>=22.23.2`。包使用 ESM，附带 TypeScript 类型声明。

```sh
npm install @weiliang0121/capix-invocation
```

- `@weiliang0121/capix-invocation` 提供 `Invocation`、CallableContext、活动窗口及调用事件类型。
- `@weiliang0121/capix-invocation/events` 提供 `InvocationEvent` 纯数据类型以及阶段、动作和关系状态词汇，可独立于活调用实现和 Node API 使用。

Node 条件入口通过共享的异步上下文，在并发和嵌套接纳中识别当前直接子调用。所有宿主都可从子结果回调的第二个参数取得本次接纳的临时凭据，将其显式传给固定实体操作。默认条件入口在未传凭据时拒绝查询接纳身份。具体调用及凭据有效期见[返回、接纳与实体落实](https://github.com/weiliang0121/capix/blob/main/docs/runtime-boundaries.md#返回接纳与实体落实)。

## 用法

[调用退出示例](https://github.com/weiliang0121/capix/blob/main/examples/invocation-exit.mjs) 组合 CallableContext、Invocation 与检查点存储，验证迟到的资源结果、关闭故障和最终交付。在仓库根目录构建后运行 `node examples/invocation-exit.mjs`。

## 契约与版本记录

- [调用退出与最终交付契约](https://github.com/weiliang0121/capix/blob/main/docs/invocation-exit-contract.md)
- [按版本查阅 CHANGELOG](https://github.com/weiliang0121/capix/blob/main/packages/invocation/CHANGELOG.md)
- [MIT 许可证](LICENSE)
