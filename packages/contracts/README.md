# @weiliang0121/capix-contracts

提供 CAPiX 各包共享的进程内契约、稳定数据和 `RuntimeError`。

## 安装与入口

包使用 ESM，附带 TypeScript 类型声明。完整回归在 Node.js 22.23.2 上运行，支持范围为 Node.js `>=22.23.2`。其他 JavaScript 宿主按使用的入口配置所需能力。[宿主能力与验证范围](https://github.com/weiliang0121/capix/blob/main/docs/host-platforms.md)

```sh
npm install @weiliang0121/capix-contracts
```

`@weiliang0121/capix-contracts` 是唯一公共入口，提供 `stableValue`、`Stable<T>`、`StableValueError`、`stableValueLimits` 和 `RuntimeError`，以及调用与关系身份、Work、操作接收、输出和 Checkpoint 端口的共享类型。

## 用法

```ts
import { stableValue } from '@weiliang0121/capix-contracts';

const draft = { tags: ['待核对'] };
const fixed = stableValue(draft);
draft.tags.push('已更新');
console.log(fixed.tags); // ['待核对']
```

`stableValue` 隔离并深度冻结数据，`Stable<T>` 在类型层表达递归只读。输入可以是 `undefined`、`null`、布尔值、字符串、有限数（含 `-0`）、密集数组，以及普通对象或 null 原型的记录。记录仅接纳自身的可枚举字符串键数据属性，保留缺失字段与显式 `undefined` 的区别。循环、访问器、隐藏属性、symbol、函数、类实例和 `Date`、`Map`、`Set` 等内建对象都会被拒绝，固定过程通过属性描述符检查数据而无需读取 getter。

每次固定最多接受 64 层深度（根深度为 0）、展开后 1,000,000 个值（含根值）以及 64 × 1024 × 1024 个 UTF-16 代码单元（字符串和记录键合计）。共享子图的每次出现都计入展开预算。超限或值域不符时抛出 `StableValueError`；需要传输或持久化时应按对应协议或编码契约处理固定值。

## 契约与版本记录

- [共享类型与协议边界](https://github.com/weiliang0121/capix/blob/main/docs/contracts-protocol.md)
- [稳定值与调用边界](https://github.com/weiliang0121/capix/blob/main/docs/runtime-boundaries.md#稳定调用数据与事实成立)
- [按版本查阅 CHANGELOG](https://github.com/weiliang0121/capix/blob/main/packages/contracts/CHANGELOG.md)
- [MIT 许可证](LICENSE)
