# @weiliang0121/capix-measurement

按消息对象身份统计材料使用次数，并提供受调用窗口控制的计数写入端点。

## 安装与入口

包使用 ESM，附带 TypeScript 类型声明。完整回归在 Node.js 22.23.2 上运行，支持范围为 Node.js `>=22.23.2`。其他 JavaScript 宿主按使用的入口配置所需能力。[宿主能力与验证范围](https://github.com/weiliang0121/capix/blob/main/docs/host-platforms.md)

```sh
npm install @weiliang0121/capix-measurement
```

- `@weiliang0121/capix-measurement` 导出 MessageUsage 和 MessageUsageResource.record。

## 用法

```ts
import { MessageUsage } from '@weiliang0121/capix-measurement';

const usage = new MessageUsage();
const message = { role: 'user', content: '你好' } as const;
usage.add([message, message]);
usage.get(message); // 1
usage.add([message]);
usage.get(message); // 2
```

`add` 接受 Transcript 包公开的 Message 类型。每次调用内按对象身份去重，正文相同的不同对象分别计数。每个 MessageUsage 实例维护自己的计数。

## 契约与版本记录

- [详细契约](https://github.com/weiliang0121/capix/blob/main/docs/content-entities-packages.md)
- [按版本查阅 CHANGELOG](https://github.com/weiliang0121/capix/blob/main/packages/measurement/CHANGELOG.md)
- [MIT 许可证](LICENSE)
