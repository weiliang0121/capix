# @weiliang0121/capix-tool

`Tool` 是组织原生模型工具调用的普通 Group 预设，与 Sequence、Dynamic 使用同一结构和调用机制。模型选择已登记的 Node / Group，成员使用自己的资源，结果回填同一个交换起点后继续请求模型。

ESM、TypeScript；Node.js ≥ 22.23.2。该包已纳入分发配置，尚未随此前的 17 包首发发布。

## 定义处理结构

```ts
import { z } from 'zod';
import { Node, Scene } from '@weiliang0121/capix-structure';
import { Tool } from '@weiliang0121/capix-tool';

const lookup = new Node<{ word: string }, string>({
  run: (work) => (work.input.word === 'hello' ? '你好' : work.input.word),
});
const answer = new Tool({
  policyVersion: 'dictionary.v1',
  tools: {
    lookup: {
      node: lookup,
      description: 'Look up a Chinese translation.',
      input: z.strictObject({ word: z.string() }),
      result: { succeeded: (text) => ({ status: 'ok', content: [{ kind: 'text', text }] }) },
    },
  },
});
const scene = new Scene(answer);
```

`tools` 的键同时是模型工具名和成员选择名，不再逐项调用 `tool()` 工厂或重复 `add`。`input` 必须与成员输入类型匹配，成功映射参数从成员输出推导为 `Stable<Output>`。提前定义登记项时可用 `satisfies ToolMember<typeof lookup>` 保持类型检查。

参数 Schema 只校验，不做默认填充、转换或移除字段。非法 JSON、未知工具和 Schema 不匹配形成明确错误反馈，不创建工具子调用。Schema 自身故障及改变参数的解析结果会终止推进。工具的普通业务失败只有提供 `result.failed` 才转成反馈；取消、CP、资源持久化等受保护故障不进入业务失败映射。映射必须纯、无副作用；允许异步，但恢复可能重新执行尚未保存接纳的映射。

构造时固定登记和配置，一棵结构内每个成员实例唯一。`policyVersion` 由作者维护，覆盖 JSON Schema 无法表示的细化判断和映射行为。目录摘要还包含 Schema、成员顺序/种类/CP 契约及预算。Zod 升级可能改变摘要并拒绝原 CP 恢复。

## 普通资源登记

```ts
import { Resource } from '@weiliang0121/capix-resources';
import { Resources, Runner } from '@weiliang0121/capix-runtime';
import { Interactions } from '@weiliang0121/capix-interaction';
import { requireModelRequest, requireModelReply } from '@weiliang0121/capix-model-provider';
import { ModelExchanges, ModelExchangeResource } from '@weiliang0121/capix-model-exchanges';
import { ToolModelResource } from '@weiliang0121/capix-tool';

// provider 是宿主配置的 ModelProvider，例如 ChatCompletionsProvider。
const contract = { key: 'app.model.v1', request: requireModelRequest, reply: requireModelReply };
const interactions = new Interactions().register(contract, { send: (request) => provider.complete(request) });
const exchanges = new ModelExchanges();
const resources = new Resources().register(new Resource(exchanges), ModelExchangeResource).register(new Resource({ exchanges, channel: interactions.bind(contract) }), ToolModelResource);
const runner = new Runner(scene, resources, interactions).build();
const text = await runner.run({ request: { messages: [{ role: 'user', content: 'Translate hello.' }] } });
```

交换资源管理固定内容；模型资源使用该实体重建请求，经独立 Interaction 发送/等待。两次登记必须使用同一个实体。没有父输入 capture、专用 installer 或隐藏的按次供给对象。每次 Tool 调用创建独立起点，多个调用可共享实体而不混用交换顺序；共享实体的存量上限仍共同计费。

输入 `{ request }` 保留初始消息、toolChoice、maxTokens、responseFormat、temperature、stream；不能替换 `tools` 或 `exchanges`。每次模型子调用仅接收 `{ origin, exchanges }` 引用，发送资源才展开累计请求。`stream` 可供 Provider 读取 SSE，但本预设只交付最终正文，不转交候选模型正文。`stages` 提供内部模型与工具的结构 ID，供宿主按真实观测事件投影进度。

离线例子：`pnpm build && node examples/tool.mjs`，输出 `你好`。完整代码见 [examples/tool.mjs](../../examples/tool.mjs)。

## 预算与等待

首版工具串行执行，1–32 个登记成员；`maxModelCalls` 默认 8，允许 1–32；`waitMs` 默认 30000。预算按完整 JSON 的 UTF-8 字节计量。

| 配置                          | 默认值 | 检查位置                                            |
| ----------------------------- | ------ | --------------------------------------------------- |
| `budgets.maxReplyBytes`       | 64 KiB | 模型回复接纳及恢复                                  |
| `budgets.maxFeedbackBytes`    | 4 KiB  | 包含 callId 的反馈；派发前保守预留                  |
| `budgets.maxRequestBytes`     | 2 MiB  | 展开请求、发送前及工具派发前                        |
| `budgets.maxWireRequestBytes` | 不设置 | 显式设置时必须登记 inspection，按实际 wire 编码检查 |
| `budgets.maxCollectionBytes`  | 8 MiB  | 当前实体所有起点、交换与待写入预留                  |
| `tools[name].maxOutputBytes`  | 不设置 | 成员返回后核对；成员应在自身 CP 前主动限制输出      |

`ToolModelSource.inspection` 可直接使用提供同步 `inspectRequest` 的 Provider。显式 wire 限制但缺少测量能力会拒绝发送。集合预算是预设的保守检查，实体和 Provider 的独立上限仍然成立；共享并发调用没有跨实体预留事务。集合核算与累计请求构造目前读取完整材料，不宣称常数成本，也不自动删除历史。

`ToolModelPending` 携带原交互引用。局部等待超时或取消不会重发、取消原模型请求；超时后的失败调用不会因为引用仍存在就自动变成可恢复调用。宿主关闭时须等待自己持有的独立发送完成。

## 显式恢复

默认不开 CP。`checkpoint: true` 为 Tool 和内部模型节点声明恢复点，并要求所有工具成员已有 CP 契约；还需宿主提供 CP Store、持久 ModelExchanges、Interaction 持久化及 `ToolModelSource.recovery.read(id)` 原始交互查询。`new Scene(answer)` 本身不自动创建 Scene 的恢复契约；从根恢复时，上层仍需显式保存准确子调用引用并声明恢复入口。

| 保存边界      | 恢复依据                                           |
| ------------- | -------------------------------------------------- |
| prepared      | 固定起点 ID 与目录摘要先保存；随后幂等建立相同起点 |
| model-waiting | 准确模型子调用引用；原交互请求与已保存反馈         |
| tools         | 当前交换、游标及派发前保存的准确工具引用           |
| completed     | 最终回复、全部接纳依据与原交互；不再执行模型或工具 |

恢复重新核对输入、目录、交换前缀、模型回复、工具返回/接纳与效果凭据。内部模型交付保留 `{ reference, reply }`，父层已接纳后也能确认原交互。缺失原交互/反馈/起点/必要子 CP、目录变化或失败终态都会拒绝，不尝试重发探测。

CP 使用有序增量选择登记子引用；预设的 point.check 仍检查完整引用关系，交换前缀 state 仍完整编码。它不把已有的内核增量保存保证扩大成整个模型循环的恒定成本承诺。

工具自身的外部效果确认仍归其资源和业务契约；多个实体提交与父 CP 不构成统一事务。当前格式与契约变化拒绝旧依据，没有旧 ToolLoop 别名或数据升级路径。

## 验证与维护

`pnpm --filter @weiliang0121/capix-tool test` 独立构建依赖并运行本包测试，覆盖普通/CP 调用、错误分流、预算、取消、共享实体、多步推进、类型负例，以及新 Runner/Store 的恢复和缺失依据拒绝。夹具只使用公开包，无 Lab 服务或测试依赖。参考服务及其 SQLite 接入仍在 capix-lab 单独维护。

MIT. Copyright (c) 2026 wei.liang. See [LICENSE](LICENSE).
