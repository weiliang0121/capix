# @weiliang0121/capix-changes

为 CAPiX 实体提供类型化领域事实、变更捕获与转交。

## 安装与入口

包使用 ESM，附带 TypeScript 类型声明。完整回归在 Node.js 22.23.2 上运行，支持范围为 Node.js `>=22.23.2`。其他 JavaScript 宿主按使用的入口配置所需能力。[宿主能力与验证范围](https://github.com/weiliang0121/capix/blob/main/docs/host-platforms.md)

```sh
npm install @weiliang0121/capix-changes
```

`@weiliang0121/capix-changes` 是唯一公共入口，提供 `FactType`、`Fact`、`ChangeBuffer`、`captureChange`、`publishFact` 和 `ProgressChannel` 等捕获与消费工具。

## 用法

```ts
import { FactType } from '@weiliang0121/capix-changes';

const changed = new FactType<{ revision: number }>('note.changed');
const other = new FactType<{ revision: number }>('note.changed');
const fact = changed.create({ revision: 1 });

const matched = changed.match(fact, (event) => console.log(event.revision)); // 输出 1
const unmatched = other.match(fact, () => console.log('未执行'));
console.log(matched, unmatched); // true false
```

`FactType.create` 固定正文并返回不可变的进程内载体。创建该事实的 `FactType` 实例同步调用消费者并返回 `true`；其他实例即使同名，也直接返回 `false`，跳过消费者。消费者抛错会传播，返回 thenable 会触发 `TypeError`。载体的正文依据由私有 `WeakMap` 保存，复制其 symbol 标记无法读取正文。需要持久化或传输时，先通过 `match` 读取 `Stable<Event>` 正文，再显式编码；对载体调用 `stableValue` 会被拒绝。

`ChangeBuffer` 暂存待转交事实，`take()` 取出当前批次并开始下一批。生产者可以在变更落实后用 `publishFact` 分别尝试必要捕获与可选消费。

## 契约与版本记录

- [领域事实与准确操作](https://github.com/weiliang0121/capix/blob/main/docs/resources-package.md#领域事实与准确操作)
- [内容实体与独立包](https://github.com/weiliang0121/capix/blob/main/docs/content-entities-packages.md)
- [按版本查阅 CHANGELOG](https://github.com/weiliang0121/capix/blob/main/packages/changes/CHANGELOG.md)
- [MIT 许可证](LICENSE)
