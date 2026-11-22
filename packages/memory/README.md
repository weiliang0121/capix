# @weiliang0121/capix-memory

保存可独立修订的总结条目，并通过资源端点提供受控读写。

## 安装与入口

包使用 ESM，附带 TypeScript 类型声明。完整回归在 Node.js 22.23.2 上运行，支持范围为 Node.js `>=22.23.2`。其他 JavaScript 宿主按使用的入口配置所需能力。[宿主能力与验证范围](https://github.com/weiliang0121/capix/blob/main/docs/host-platforms.md)

```sh
npm install @weiliang0121/capix-memory
```

- `@weiliang0121/capix-memory` 导出 Memories、固定写入与持久化契约、MemoryViewSource 及 memoryResources。

## 用法

`Memories<Metadata = never>` 是集合的写入者。每个不可变 MemoryItem 都有独立 UUID 和 `value: { content: string; metadata?: Metadata }`。更新保留条目 ID，替换整个 value，包括可选的 metadata。应用负责选择、提取、验证来源及决定保留哪些条目。

```ts
import { Memories } from '@weiliang0121/capix-memory';

const memories = new Memories<{ topic?: string }>();
const created = memories.apply([{ action: 'create', value: { content: 'Prefer concise answers', metadata: { topic: 'preference' } } }]);
const first = memories.read(created.changed[0]!.id)!;
memories.apply([{ action: 'update', memoryId: first.id, value: { content: 'Explain complex questions in detail' }, reason: 'Clarified preference' }], { expected: first.basis });
// first 保留更新前的值，当前条目已移除 metadata。
```

把集合登记为资源时，示例还需要资源包。

```sh
npm install @weiliang0121/capix-resources
```

```ts
import { memoryResources } from '@weiliang0121/capix-memory';
import { Resource, Resources } from '@weiliang0121/capix-resources';

const memory = memoryResources<{ topic?: string }>();
const resource = new Resource(memories);
const resources = new Resources().register(resource, memory.read).register(resource, memory.apply);
// 作者从同一组 Offer 申请 memory.read.request() 或 memory.apply.request()。
```

`read(id)` 返回 `{id,basis:{memoriesId,sequence},value}`，条目不存在时返回 undefined。`values()` 枚举固定条目，`snapshot()` 返回 `{basis,items}`。`apply(changes, {expected?})` 返回 `{before,after,changed}`，changed 仅列出实际内容变化。需要防止过期写入时应提供 expected。可选的 reason 描述操作，单独改变 reason 不推进 sequence。

`memoryResources<Metadata>()` 创建一对类型一致的 Offer。read 端点提供 `read(id)` 和显式的 `snapshot()`，apply 端点提供 `apply(changes, expected?)` 与 `applyFixed({position,changes}, expected?)`。绑定时不捕获集合。`MemoryViewSource<Metadata>` 可覆盖全集或固定的有序子集，以集合 sequence 检查版本，返回固定的 `{id,value}`，摘要为 undefined。实体更新和视图成员变更各自提交。

## 固定写入与持久化

`applyFixed(request)` 和 `confirmFixed(request)` 接受 memories.apply v2 请求。资源端点从实际调用取得 contextId，作者提供 position、changes 及可选的变更原因。实体在同一写入保护内固定完整命令及 expected。

在同一集合内，固定写入键是 `(operation.contextId, command.position)`。同一调用可在不同位置发出独立命令。同键重试须匹配完整原请求，包括内容契约、expected、changes 和 reason。命中时返回原回执 `{memoriesId,startSequence,sequence,changes:[{commandIndex,memoryId}]}`，后续内容更新不影响确认。首次固定写入即使没有内容变化，也持久化确认依据，此时不推进 sequence 或发布内容事件。

```ts
const request = {
  contract: { key: 'memories.apply', version: 2 } as const,
  contentContract: memories.contentContract,
  memoriesId: memories.id,
  operation: { contextId }, // 宿主已取得的本次调用身份
  command: { position: 'remember-answer', changes: [{ action: 'create' as const, value: { content: '用例需离线运行' } }] },
  expected: memories.snapshot().basis,
};
const receipt = memories.applyFixed(request);
```

`exportState()` 导出当前 v2 格式，`Memories.restore(state, options?)` 拒绝旧格式。恢复核验身份、内容契约、请求、回执及可证明的序号和条目顺序，静默载入，不重新执行写入或发布事件。使用自定义 `contentContract: {key,version,check?}` 时，恢复选项须给出匹配的 key 和 version，并重新提供应用依赖的同步 check。TypeScript 泛型只描述静态类型。

导出状态、提交载荷、事件和读取结果都包含 Stable 值。持久化适配器须忠实编解码所支持的 undefined、负零及空原型对象，固定请求和回执也遵循相同规则。外部写入前应检查编码和容量。Checkpoint 作者须提供保留这些区别的 codec。

`persistence.commit` 同步提交增量写入和相应的固定确认。若端口抛错或违反同步返回契约，提交结果不确定。此后须从权威存储重新载入才可读取当前状态和继续写入。先前交付的材料仍然有效，完全匹配的已知回执仍可确认，未知回执不能证明未执行。发布通知失败发生在内容和确认安装之后，两者均保留。

## 领域事件与展示投影

每个 `MemoryEvent<Metadata>` 包含 memoriesId、sequence、时间、可选 origin 和 `{action,memoryId,value,reason?}`。`MemoryFacts` 转交类型化事实。没有 origin 的独立变化保持无来源。

默认记录只投影 content 与可选 reason。基线与增量展示使用相同的内容投影。应用需要 topic、来源链接或其他 metadata 时，自行定义投影和编码。持久化适配器与传输 DTO 也由应用提供，展示投影不足以重建实体。

## 契约与版本记录

- [详细契约](https://github.com/weiliang0121/capix/blob/main/docs/memory.md)
- [按版本查阅 CHANGELOG](https://github.com/weiliang0121/capix/blob/main/packages/memory/CHANGELOG.md)
- [MIT 许可证](LICENSE)
