# @weiliang0121/capix-view

按版本组织多个独立来源的有序成员，并按成员读取摘要或捕获内容。

## 安装与入口

包使用 ESM，附带 TypeScript 类型声明。完整回归在 Node.js 22.23.2 上运行，支持范围为 Node.js `>=22.23.2`。其他 JavaScript 宿主按使用的入口配置所需能力。[宿主能力与验证范围](https://github.com/weiliang0121/capix/blob/main/docs/host-platforms.md)

```sh
npm install @weiliang0121/capix-view
```

- `@weiliang0121/capix-view` 导出 View、来源契约、createViewSource 适配器及受控访问接口。

## 用法

`createViewSource` 用 version、keys、inspect 和 read 四个同步回调将应用已有的数据接入 View。应用继续管理数据及其持久化，访问窗口由资源层管理。

```ts
import { createViewSource, View } from '@weiliang0121/capix-view';

const documents = new Map<string, { title: string; text: string }>([['guide', { title: 'Guide', text: 'Read this first.' }]]);
let revision = 0;
const requireDocument = (key: string) => {
  if (!documents.has(key)) throw new RangeError('Document is missing or outside scope');
  return documents.get(key)!;
};
const source = createViewSource({
  id: 'local-documents',
  scope: 'whole',
  version: () => String(revision),
  keys: () => [...documents.keys()],
  inspect: (key) => ({ title: requireDocument(key).title }),
  read: (key) => requireDocument(key),
});
const sources = { documents: source };
const view = new View<typeof sources>({ revision: 0, sources: { documents: { id: source.id, scope: source.scope } }, members: [{ source: 'documents', key: 'guide' }] });
const index = view.indexSync(sources);
const snapshot = view.captureSync(sources, index);

documents.set('guide', { title: 'Guide', text: 'Updated instructions.' });
revision++; // 可观察的变化须推进版本。
```

适配器在创建时固定 id、scope 和回调函数，调用时保留各回调的原始接收者。`version()` 必须覆盖该来源与范围内的目录顺序、成员、摘要及正文变化，使用过的版本不可重用。适配器在调用前和隔离结果后比较版本戳，拒绝版本变化及重入访问，不自动重试。作者须确保可观察的变化都推进版本。

`keys()` 提供范围内的完整目录。键只能是非空字符串或非负安全整数，且不得重复。`index()` 核验整个目录，逐项调用 inspect 取得摘要。`inspect(keys)` 仅读取选中项的元数据，`read(keys, expected)` 检查预期版本后仅读取选中项的正文。两项选读操作均不枚举目录，其成本随请求键和结果大小变化。

作者在 inspect 和 read 中均须核验键是否存在及其所属范围，无权访问或缺项时抛出 RangeError。undefined 是合法摘要或正文。所有回调必须同步完成，适配器拒绝 Promise 和 thenable 并观察异步拒绝。

摘要和正文可使用被动标量、稠密数组或普通数据对象。适配器逐层核验数据，对可变内容创建冻结副本。已通过校验且深冻结的值可复用原引用。来源、配置和作者持有的可变对象保持原状态。访问器、代理、活对象、函数、环及不支持的标量均被拒绝。`ViewSourceData<T>` 描述只读结果的形状，持久化和恢复仍需各自的依据。

作者也可以直接实现 `SyncViewSource` 或异步 `ViewSource`，沿用已有身份和来源类型。资源适配器通过 `openView` 或 `openViewManager` 核验操作窗口，创建来源本身不授予资源权限。

## 契约与版本记录

- [详细契约](https://github.com/weiliang0121/capix/blob/main/docs/view-package.md)
- [按版本查阅 CHANGELOG](https://github.com/weiliang0121/capix/blob/main/packages/view/CHANGELOG.md)
- [MIT 许可证](LICENSE)
