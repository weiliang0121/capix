# @weiliang0121/capix-protocol

定义 Transcript 的基线、增量和错误帧的传输表示，并提供单帧接纳。

## 安装与入口

包使用 ESM，附带 TypeScript 类型声明。完整回归在 Node.js 22.23.2 上运行，支持范围为 Node.js `>=22.23.2`。其他 JavaScript 宿主按使用的入口配置所需能力。[宿主能力与验证范围](https://github.com/weiliang0121/capix/blob/main/docs/host-platforms.md)

```sh
npm install @weiliang0121/capix-protocol
```

`@weiliang0121/capix-protocol` 是唯一公共入口，提供 `acceptTranscriptUpdate` 和 `TranscriptWireMessage`、`TranscriptWireSnapshot`、`TranscriptWireEvent`、`TranscriptFrame`、`TranscriptUpdate` 类型。

## 用法

```ts
import { acceptTranscriptUpdate } from '@weiliang0121/capix-protocol';

const update = acceptTranscriptUpdate({
  type: 'baseline',
  snapshot: { id: 'chat-1', revision: 0, start: 0, end: 0, starts: [0], messages: [] },
});
if (update.type === 'baseline') console.log(update.snapshot.messages); // []
```

`acceptTranscriptUpdate` 接受 `unknown`，先固定数据再检查单帧的完整字段、消息、范围、分段和版本。固定数据失败会抛出 `StableValueError`，形状不合法（例如有未知字段）会抛出 `TypeError`。形状合法的 `{ type: 'error', code, error }` 会作为不可变数据返回。

跨帧的来源匹配、版本连续性、去重、连接替换和恢复决策由消费应用负责；HTTP、业务 DTO 和端点接纳也由宿主定义。Transcript 实体 API 位于 `@weiliang0121/capix-transcript`，调用事件位于 `@weiliang0121/capix-invocation/events`，记录数据及校验位于 `@weiliang0121/capix-records/data`，共享关系身份位于 `@weiliang0121/capix-contracts`。

## 契约与版本记录

- [消息传输契约与业务协议边界](https://github.com/weiliang0121/capix/blob/main/docs/protocol.md)
- [按版本查阅 CHANGELOG](https://github.com/weiliang0121/capix/blob/main/packages/protocol/CHANGELOG.md)
- [MIT 许可证](LICENSE)
