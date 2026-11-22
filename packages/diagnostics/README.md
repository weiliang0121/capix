# @weiliang0121/capix-diagnostics

将异常转换为有界诊断值，并标识必要持久化端口的失败。

## 安装与入口

包使用 ESM，附带 TypeScript 类型声明。完整回归在 Node.js 22.23.2 上运行，支持范围为 Node.js `>=22.23.2`。其他 JavaScript 宿主按使用的入口配置所需能力。[宿主能力与验证范围](https://github.com/weiliang0121/capix/blob/main/docs/host-platforms.md)

```sh
npm install @weiliang0121/capix-diagnostics
```

- `@weiliang0121/capix-diagnostics` 导出 RuntimeErrorHelper、PersistenceError，以及 contracts 的 RuntimeError 和诊断值类型。

## 用法

```ts
import { PersistenceError, RuntimeErrorHelper } from '@weiliang0121/capix-diagnostics';

const failure = new PersistenceError('notes.commit', new Error('存储连接中断'));
const diagnostic = RuntimeErrorHelper.format(failure);
```

`failure.operation` 标识失败的端口操作，原始异常保留在 `failure.cause`。记录或展示层可以读取有界的诊断值。

## 契约与版本记录

- [详细契约](https://github.com/weiliang0121/capix/blob/main/docs/exceptions.md)
- [按版本查阅 CHANGELOG](https://github.com/weiliang0121/capix/blob/main/packages/diagnostics/CHANGELOG.md)
- [MIT 许可证](LICENSE)
