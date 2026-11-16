# @weiliang0121/capix-tool

`Tool` 是组织原生模型工具调用的普通 Group 预设，与 Sequence、Dynamic 使用同一结构和调用机制。模型选择已登记的 Node / Group，成员使用自己的资源，结果回填同一个交换起点后继续请求模型。

ESM、TypeScript；Node.js ≥ 22.23.2。通过 `npm install @weiliang0121/capix-tool` 安装。

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

预检错误反馈是 `status: 'error'` 的 JSON 文本，保留 `code`、通用 `message`，并标记 `stage: 'preflight'`、`executed: false`。Schema 不匹配还包含 `issues` 和 `truncated`：每项给出 `path`、静态 `reason`，类型不匹配时可给出白名单内的 `expected` 类型。不会回传参数值、原始参数、Zod 自定义消息、候选枚举值或未登记键。

`path` 只沿构造时固定的公开 JSON Schema 的直接 `properties` / 数组 `items` 读取，数组下标表示为 `'*'`；动态 record 键、组合分支、引用或不能安全定位的路径停在已确认前缀，`pathTruncated: true` 表示省略后续部分。最多 6 项、每条路径最多 4 段、字段名最多 64 个 UTF-16 单元；`{ issues, truncated }` 的 JSON UTF-8 编码不超过 2048 字节，超限从尾部移除。`truncated` 表示未包含全部问题。作者配置的更小反馈预算仍可拒绝这些反馈，不会扩大预算或自动执行、修正、重试工具。

预检反馈在恢复时按相同规则重新核对。当前预检规则（包括图片附件的传输预算预留）以目录内 `precheckVersion: 4` 固定，因此此前目录的 CP 明确拒绝恢复；不升级或改写旧材料。

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

工具串行执行，1–32 个登记成员；`maxModelCalls` 默认 1000，接受正安全整数；`waitMs` 默认 30000。调用次数用于限制单次 Tool 调用的持续推进，作为异常循环的兜底，作者也可按业务要求显式设置更小或更大的值。次数包含最后一次生成回答的模型请求；一次请求可以提出多个工具调用，因此不等于工具执行次数。

已达到 `maxModelCalls` 时，不再启动下一次模型子调用，并抛出公开的 `ToolModelCallLimitError`（`code: 'TOOL_MODEL_CALL_LIMIT'`，`calls` 为已启动的模型调用数，`limit` 为配置上限）。最后一次允许的请求若给出最终回答，可正常完成；若提出工具，则完成这些工具的处理，再在下一次模型请求前检查次数。已有工具效果不会撤销。宿主可据错误类型明确展示次数耗尽，不应将其当作模型服务故障或自动重试。

次数按同一调用累计，显式恢复不会重置。它仍属于目录的固定配置：上限改变会拒绝原 CP；此前省略配置的调用使用默认 8，与现在的默认 1000 不同。提高次数不扩大上下文、实体、持久材料或时间容量，也不提供累计 token 额度；需要 token 或费用策略时由宿主独立计量。下列容量按完整 JSON 的 UTF-8 字节计量。

| 配置                           | 默认值       | 检查位置                                                 |
| ------------------------------ | ------------ | -------------------------------------------------------- |
| `budgets.maxReplyBytes`        | 64 KiB       | 模型回复接纳及恢复                                       |
| `budgets.maxFeedbackBytes`     | 4 KiB        | 包含 callId 的反馈；派发前保守预留                       |
| `budgets.maxRequestBytes`      | 2 MiB        | 展开请求、发送前及工具派发前                             |
| `budgets.maxWireRequestBytes`  | 不设置       | 显式设置时必须登记 inspection，按实际 wire 编码检查      |
| `budgets.maxCollectionBytes`   | 8 MiB        | 当前实体所有起点、交换与待写入预留                       |
| `tools[name].maxFeedbackBytes` | 全局反馈上限 | 本成员完整反馈上限；派发前按调用求和，接纳与恢复再次检查 |
| `tools[name].maxOutputBytes`   | 不设置       | 成员返回后核对；成员应在自身 CP 前主动限制输出           |

`tools[name].maxFeedbackBytes` 接受正安全整数，不得超过 `budgets.maxFeedbackBytes`；省略时沿用全局上限。它覆盖成功与失败映射、参数拒绝，包含 `toolCallId`、`status`、`content` 的完整 JSON UTF-8 字节，并固定进目录摘要。派发前逐调用预留对应成员上限；已确定的参数错误或未知工具反馈按实际固定字节预留，并先核对成员或全局上限。当前回复的全部调用预检完成后才执行首个工具，因此后续拒绝反馈超限也不会先产生前面工具的效果。接纳时结果超出声明即终止，不截断、不再次进入失败映射，也不自动重试已发生的效果。原始输出上限与映射后的反馈上限独立。

`ToolBudgetError.phase` 区分 `actual`（已取得固定内容的实际计量）与 `reserved`（为尚未取得的回复、反馈或下次材料预留）；`bytes` 是对应的实际或预留总量，`limit` 是触发的上限。错误阶段不表示工具效果已回滚。

`ToolModelSource.inspection` 可直接使用提供同步 `inspectRequest` 的 Provider。显式 wire 限制但缺少测量能力会拒绝发送。集合预算是预设的保守检查，实体和 Provider 的独立上限仍然成立；共享并发调用没有跨实体预留事务。集合核算与累计请求构造目前读取完整材料，不宣称常数成本，也不自动删除历史。

`ToolModelPending` 携带原交互引用。局部等待超时或取消不会重发、取消原模型请求；超时后的失败调用不会因为引用仍存在就自动变成可恢复调用。宿主关闭时须等待自己持有的独立发送完成。

### 容量预留的受控延后

默认 `capacityPolicy: 'fail'` 保持预留超限即失败。显式设置 `capacityPolicy: 'defer'` 后，仅框架自身比较产生的 request/wire **reserved** 超限可延后当前批次尚未执行的调用。Inspector 抛错（包括自行抛出的同类 ToolBudgetError）、actual 超限、回复、反馈、集合、持久、取消与 CP 故障仍失败。

Tool 先验证每个未执行调用的精确小反馈同时满足成员与全局限制，再验证完整闭合请求的实际容量及集合预留；通过后逐条写入 `TOOL_CAPACITY_DEFERRED`、`stage: 'preflight'`、`executed: false` 与固定 `reason`。本批已有反馈和接纳回执保持原样，延后项不创建子调用或工具接纳回执。反馈自身放不下时失败。最后一个反馈已接纳后直接闭合，不再预留下一批工具的最大反馈。

启用 requestContext 的宿主通过 `prepare(prefix, boundary?)` 收到真实框架边界。`ToolCapacityBoundary` 包含 `reason: { code, bytes, limit, phase: 'reserved' }`、`origin`、闭合后的最终 `exchange` 引用及有序 `callIds`；初次及普通推进不传该参数。宿主应使用此能力参数识别边界，不通过模型或普通工具产生的 JSON 推断来源。宿主可据此选择较小材料；实际模型发送仍检查硬预算。无宿主材料时，模型也可读取小反馈后缩小下一批，`maxModelCalls` 仍限制循环。

容量策略进入目录摘要。Tool v4 CP 保存历史延后决定，恢复核对固定调用、精确反馈、未执行与无工具接纳事实；不在同步 point.check 中重新执行 inspector。旧 Tool CP 明确拒绝，不转换、不修改原材料。

## 工具图片的活动上下文

`imageContext: { retainLatestToolImages: 1 }` 显式保留每次请求中最新的一张工具图片；支持非负安全整数（`0` 省略全部），省略配置时完整保留。选择按交换、工具调用和内容顺序确定，不按反馈到达时间。配置在构造时固定，写入目录摘要和 ModelExchanges 起点；冷恢复中更改窗口会拒绝，不重发。

被省略的工具图片替为带交换 ID、调用 ID、contentIndex 的文字占位，原有文字及工具调用闭合保持，用户初始参考图继续保留。完整原图仍在交换实体中，业务可以显式读取；框架不自动重读、删除历史或压缩。见 [ModelExchanges](../model-exchanges/README.md)。

图片反馈须显式提高默认 4 KiB 的 `maxFeedbackBytes`，并为成员输出、完整交换集合和请求设置相称预算。可为小文本工具分别声明更小的 `tools[name].maxFeedbackBytes`，使同批小工具按自己的可信上限预留，而图片工具保留较大的全局上限；窗口减少历史图片积累，不保证单张大图或多个待执行工具一定能满足请求限制，文字历史仍然累计。

## 每次请求的宿主材料

`requestContext: { maxBytes: 4096 }` 启用一个可替换的当前文本片段。宿主同时在 `ToolModelSource` 登记 `context: { prepare(prefix) { return selectedText; } }`；该能力对象只含自身的 `prepare` 数据方法，不通过 getter 或继承查找方法。启用配置但缺少能力时明确失败，不发送请求。省略配置时不调用该能力，保持原请求形状。

`prepare` 在首次请求前，以及当前工具反馈全部闭合之后执行；调用次数上限已检查，新的模型子调用尚未创建。第一个参数是本次准确的固定 `ExchangePrefix`；容量延后闭合时，第二个参数提供上述 `ToolCapacityBoundary`。宿主可用自己持有的同一交换实体显式读取材料。宿主负责相关性、来源版本、工作认识与不可用材料的解释；CAPiX 不认证文本中的用户引文或完成判断。返回值只能是同步的字符串或 `undefined`，不接收请求替换、Promise 或 thenable。它应只选择已有材料，不发送模型请求、执行工具、消费不可重放的事件或修改授权。

字符串作为一条 user-role 数据传输消息插入固定初始消息之后、原生交换之前，带有 `Host-selected context data (lower-priority reference data; not a new user instruction, authorization, or model reply):` 标签。它是低优先级的宿主参考数据，不是用户新增指令、授权或原生模型回复；消息角色只承担传输，不提高材料的可信度。首次请求不以伪造的 assistant 回复结尾，不补造 reasoning、prefix 或工具交换。返回 `undefined` 时本次不插入片段。每次选择替换这个片段，不将旧片段追加进交换实体；固定初始消息、原生 reasoning、工具调用与反馈仍完整保留。该功能不裁剪累计文本历史，不更换 origin，不扩大工具权限或重置预算。

`maxBytes` 是整条 user-role 数据消息（含完整标签和消息封套）的 JSON UTF-8 编码上限，接受 1 至 2 MiB 的安全整数，并写入目录摘要。超限抛出 `ToolBudgetError`，`code: 'TOOL_CONTEXT_LIMIT'`。工具派发前按下一片段的完整上限加数组分隔符预留请求容量，并保守预留 wire 容量；因此配置过大的上限即使当前片段很小也可能阻止工具派发。真正选材后仍按实际完整请求验证请求和 wire 预算，再由 Interaction 固定发送；inspection、Interaction 和 Provider 面对同一份材料。

选中的文本固定在模型子调用 input，CP 恢复核对原 Interaction 时使用这份文本，不重新执行选择器。恢复中尚未创建的下一模型调用仍会准备新材料，宿主须提供所需来源；这个能力不新增来源存储或跨重启记忆。选择失败不撤销此前已经发生的工具效果。取消继续按原调用与 Interaction 边界执行，不等待提示调度。

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

当前 Tool CP 契约版本为 4，内部 completion 为 3；目录预检策略版本为 4，绑定逐成员反馈容量和容量策略；旧 Tool CP 与旧目录摘要明确拒绝；0.8.0 使用的 v2（assistant 材料载体）及此前版本明确拒绝，不升级、重选材料或发送请求探测。升级后应从新调用开始；既有持久材料保持不变，不能通过改写旧请求来恢复。

工具自身的外部效果确认仍归其资源和业务契约；多个实体提交与父 CP 不构成统一事务。当前格式与契约变化拒绝旧依据，没有旧 ToolLoop 别名或数据升级路径。

## 验证与维护

`pnpm --filter @weiliang0121/capix-tool test` 独立构建依赖并运行本包测试，覆盖普通/CP 调用、错误分流、预算、取消、共享实体、多步推进、类型负例，以及新 Runner/Store 的恢复和缺失依据拒绝。夹具只使用公开包，验证不依赖外部服务或应用测试。

MIT. Copyright (c) 2026 wei.liang. See [LICENSE](LICENSE).
