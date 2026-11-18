# @weiliang0121/capix-checkpoint

本包定义检查点帧、固定值、增量存储和提交回执，供调用层验证恢复依据。

## 安装与入口

运行环境为 Node.js `>=22.23.2`。包使用 ESM，附带 TypeScript 类型声明。

```sh
npm install @weiliang0121/capix-checkpoint
```

- `@weiliang0121/capix-checkpoint` 提供检查点契约、固定值复制、回执验证和内存存储。
- `@weiliang0121/capix-checkpoint/storage` 提供面向宿主存储适配器的编码、增量提交准备与检查点读取工具。

## 用法

宿主存储适配器可将已固定的检查点值编码为文本；解码时保留负零等需要精确还原的值。

```js
import { cloneCheckpointValue } from '@weiliang0121/capix-checkpoint';
import { encodeCheckpointData, decodeCheckpointData } from '@weiliang0121/capix-checkpoint/storage';

const fixed = cloneCheckpointValue({ offset: -0 });
const saved = encodeCheckpointData(fixed);
console.log(Object.is(decodeCheckpointData(saved).offset, -0)); // true
```

## 契约与版本记录

- [检查点格式、保存与恢复契约](https://github.com/weiliang0121/capix/blob/main/docs/checkpoints.md)
- [按版本查阅 CHANGELOG](https://github.com/weiliang0121/capix/blob/main/packages/checkpoint/CHANGELOG.md)
- [MIT 许可证](LICENSE)
