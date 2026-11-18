# @weiliang0121/capix-transcript

按追加顺序保存对话消息，提供固定位置引用、分段与按版本读取。

## 安装与入口

运行环境为 Node.js `>=22.23.2`。包使用 ESM，附带 TypeScript 类型声明。

```sh
npm install @weiliang0121/capix-transcript
```

- `@weiliang0121/capix-transcript` 导出 Transcript 实体、消息及范围引用、资源端点、视图来源和事件类型。
- `@weiliang0121/capix-transcript/presets` 提供 groupAdjacentPairs，按原始索引将紧邻的用户消息与助手消息配对，保留间隙和独立条目。

## 用法

```ts
import { Transcript } from '@weiliang0121/capix-transcript';

const transcript = new Transcript();
transcript.append({ role: 'user', content: '能总结一下吗？' });
const messages = transcript.snapshot();
```

`MessageLocator` 用实体 ID 和索引定位一条消息，`TranscriptRangeLocator` 定位半开区间。两者都只保存位置。`TranscriptSnapshot` 与 `TranscriptEvent` 描述来源的具体修订，修订也计入分段变更。传输帧的编码与接纳由 protocol 负责，实体恢复依赖自己的持久材料。

## 契约与版本记录

- [详细契约](https://github.com/weiliang0121/capix/blob/main/docs/transcript.md)
- [按版本查阅 CHANGELOG](https://github.com/weiliang0121/capix/blob/main/packages/transcript/CHANGELOG.md)
- [MIT 许可证](LICENSE)
