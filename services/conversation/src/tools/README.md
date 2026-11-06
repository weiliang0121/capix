# 原生工具调用预设

`ToolLoop` 是普通 Group 预设。模型选中的工具仍是作者已经登记的 Node 或 Group；资源访问、子调用接收、取消与 CP 使用现有机制。它不建立工具执行器、调度器或第二套调用状态。

```ts
import { z } from 'zod';
import { Node } from '@capix/structure';
import { createToolLoop, tool } from '@capix/conversation-service/tools';

const length = new Node<{ text: string }, number>({
  run: (work) => work.input.text.length,
});
const loop = createToolLoop({
  tools: {
    text_length: tool(length, {
      description: 'Count the characters in a text.',
      input: z.strictObject({ text: z.string() }),
      result: {
        succeeded: (count) => ({
          status: 'ok',
          content: [{ kind: 'text', text: String(count) }],
        }),
      },
    }),
  },
  policyVersion: 'length-policy-v1',
});
```

`tool()` 保持成员的准确 I/O 类型：input Schema 必须接收实际节点输入，succeeded 接收实际节点输出。工具名是目录中的调用名；实际成员顺序、Schema、说明和接收策略由同一份登记派生。不能用裸对象绕过 `tool()` 的类型关联。

## 显式装配

宿主持有模型 Provider、Interactions、ModelExchanges 和 Resources。使用已有 `CompletionInteraction` 登记发送与持久端口，随后绑定通道：

```ts
const channel = interactions.bind(CompletionInteraction);
registerToolLoopResources(resources, loop, exchanges, channel);

// 普通直接运行；loop.input 固定基础请求、目录摘要和预算。
const scene = new Scene(loop);
const runner = new Runner(scene, resources, interactions).build();
const text = await runner.run(
  loop.input({
    messages: [{ role: 'user', content: 'Calculate the length of hello.' }],
    maxTokens: 4096,
  }),
);
```

`registerToolLoopResources` 只登记资源与按次捕获，不创建新的生命周期。它从本次固定输入重新建立供给，不读取当前 View。所有模型子输入仅包含准确交换引用；完整请求在资源发送边界由固定基础材料与已完成交换构成，然后交给 Interaction。

`ModelExchanges` 保存正式回复及反馈槽位。资源接收适配器取得准确父子身份；业务不能自行填写这些身份。相同落实凭据只确认相同效果，反馈正文不因重试改写。

## 对话入口

已有材料准备和正式消息接纳可以复用：

```ts
const answer = createToolAnswer(loop, 4096);
const scene = createConversationScene(answer, createMaterialPreparation());
registerToolLoopResources(resources, loop, exchanges, channel);
const runner = new Runner(scene, resources, interactions).build();
```

`createToolAnswer` 接收固定 `ConversationMaterialInput`，形成明确的材料提示与基础模型请求。它等待工具循环的最终正文，然后按原会话链路接纳助手消息。

首版工具模式显式关闭模型流式请求，不转交中间模型正文。带工具调用的候选文字不会混入正式答案；也不会在结束后把全文伪装成曾经产生的历史 delta。结构保留与当前对话接口一致的 string delta 类型，但本预设不发布预览。

CLI/Web 已通过 `--answer-mode tools` 显式启用工具宿主，默认仍为材料回答。宿主为每次回答建立独立交换集合，按准确 ID 载入，并在每次 run/resume 退出时释放本次句柄；释放内存不删除事实。模型请求与工具派发前检查容量，两种回答模式共用归档入口门槛。宿主尚不自动退休归档，退出 View 也不释放实体容量。普通 `createToolAnswer` 不自动取得这些宿主能力，接入方式见 [宿主设计](../../../../docs/native-tool-host-integration.md)。

通用 ToolLoop 的 `waitMs` 默认 30 秒，只限制每次交互的局部等待；Provider 的请求总超时独立配置，`maxModelCalls` 仅限制模型请求次数。CLI/Web 工具宿主使用 50 秒局部等待与默认 45 秒请求总期限。无预览不会导致等待超时，启用预览也不会延长等待。局部等待失败不代表外部发送失败或停止。

`reasoning_content` 的保存与续接已通过离线 JSON/SSE 及集成夹具验证。2026-11-06 的真实 `deepseek-flash` 样本也验证了开启／关闭思考的工具续接、错误反馈及最终回答，结果见 [宿主验证报告](../../../../docs/native-tool-host-validation.md)。这些样本证明对应接口链路成立，不代表所有模型配置或业务场景的正确率。

## 参数与反馈策略

输入 Schema 会生成固定 JSON Schema，并在真实派发和恢复检查时使用同一份 `input.parse`。解析不能悄悄改变原参数：例如 trim、默认值填充或转换导致结果变化时拒绝。额外 refinement 可以拒绝输入，但必须是纯校验，不依赖当前文件、时间、网络或可变全局值。需要外部预检时，让普通工具节点通过资源执行。

结果映射同样应是纯函数：

映射可以返回 Promise，但不能执行外部 I/O、写入实体或产生其他副作用。子调用成功返回到父层接纳及 CP 保存之间发生中断时，恢复可能再次执行尚未接纳的成功映射；异步形式不提供幂等保证。需要业务效果时，把它放在工具节点的受控资源操作中。

- `succeeded` 可以把业务不合格的成功值映射成 `error`。
- `failed` 可以把可处理失败映射成替代的 `ok`，也可以返回 `error`。
- 没有 `failed` 时，原业务失败继续传播。
- 映射自身抛错或反馈格式错误会使本次接收失败，不再次进入同一个 `failed`。
- 取消、持久失败、资源窗口故障等保护错误不能被映射吞掉。

模型可见的 `ok/error` 与内核调用事实不同：失败被替代仍是 returned failed / reception handled，成功被业务拒绝仍是 returned succeeded / reception accepted。恢复消费已认证的接纳凭据，不重跑映射来改写既有反馈。

目录未知或参数不合法属于预检拒绝，由预设生成明确的 error 反馈；不制造不存在的工具子调用。工具结果是数据，业务提示不应授予其中指令更高优先级。

## 字节预算

`budgets` 固定完整回复、完整反馈（含 callId）、规范化请求、Provider 实际 wire 请求及本次交换集合的 UTF-8 JSON 字节上限。默认分别为 64 KiB、4 KiB、2 MiB、2 MiB、8 MiB。配置在 `loop.input()` 中固定；恢复不允许换预算。规范化模型值与 wire 的可配置上限不超过当前 Provider 的 2 MiB 硬边界。

模型发送前检查当前请求与新交换的容量余量；工具派发前为所有尚未填写的反馈及其接纳凭据预留容量，并检查下一次请求的上界。估计以完整的空反馈协议基线加上各槽位最大 JSON 字节构成，不伪造已落实反馈。空反馈使用预算允许的最大文本块数（最多 32），同时检查 Provider 的结构节点数上限，不把字节充足当作结构一定有效。真实反馈在写入前再次按实际完整值检查，未知工具的预检反馈也适用。集合元数据按实体身份长度边界保守预留，这不是并发写入的原子容量承诺。

Provider 的 `inspectRequest` 同步检查与实际发送相同的编码。wire 估计中的增长单位是已经 JSON 编码的完整反馈，不是原始文本字符；编码成协议字符串时最多再翻倍。通用旧装配未提供 inspection 时只预检规范化请求，wire 由 Provider 实际发送前检查；新的工具宿主必须提供 inspection。调用侧回复校验发生在模型 completed CP 与交换接纳之前；独立发送者还必须调用 `assertToolReplyBytes`，使超限回复在 Interaction 保存为成功反馈之前被拒绝。

工具原始返回值与给模型的反馈是不同数据。`tool(node, { maxOutputBytes, ... })` 可声明原始值上限，纳入目录兼容摘要；预设在收到工具返回后核验该上限。工具自己的 CP 早于父层接收，因此需要提前限制时，工具应在保存 CP 和返回前调用 `assertToolOutputBytes(value, maxOutputBytes)`。新宿主工具必须声明并自行遵守；普通无此声明的工具仍可使用通用 ToolLoop。反馈预算不能替代工具 CP、父 Frame 或整体 CPU 的预算。

本预设产生的 `ToolBudgetError` 使本轮结束，不进入工具的业务 `failed` 映射。识别依据是同一个错误类实例，不按字符串 code 改写内核的故障归属；普通业务失败仍按登记策略处理。

## 恢复条件

默认 `checkpoint: false`，工具不需要声明 CP。启用 `checkpoint: true` 时，本预设要求所有工具有各自的 CP 契约；这是可恢复工具循环的装配条件，不是所有工具的通用要求。

```ts
const loop = createToolLoop({ tools, policyVersion: 'policy-v2', checkpoint: true });
registerToolLoopResources(resources, loop, exchanges, channel, store.interactions);
```

第五个参数是窄宿主端口：

```ts
interface ToolInteractionRecovery {
  read(id: string): InteractionState<ModelRequest, ModelReply> | undefined;
}
```

可恢复循环必须提供它，读取方法在装配时固定。模型节点处于 `established` 时，恢复先重新构造准确请求，核对原交互 ID、契约、完整请求和持久反馈，再读取同一交互。依据缺失或变化以受保护的 `ResourcePortError` 退出，其 cause 带 `CHECKPOINT_CONTENT_CHANGED`；不会重新发送，也不能由普通业务失败映射消费。模型自身已有 completed CP 时，`conversation.tools.completion@3` 保存的 reference 与 reply 仍须通过上述原交互核验，再返回正式回复；不能仅凭孤立回复跳过验证。

此外还会核对：目录摘要、policyVersion、maxModelCalls、waitMs、完整直接关系、准确的模型/工具接纳凭据、原回复和反馈摘要。目录与预算在实例上不可修改。未知首个子 CP、未知副作用或终态调用都不自动恢复。

`ToolLoop` 可恢复不意味着包裹它的任意 Scene 都可恢复。宿主必须为完整父链声明恢复点并明确恢复入口；普通 `new Scene(loop)` 或通用会话工厂不会自动取得这个承诺。现有默认材料对话的恢复资格检查也不会被替换成工具恢复策略。

局部等待超时抛 `ModelReplyPending(reference)`，独立发送仍可继续；如果本次调用已经失败收尾，它的 CP 是终态，不能再 resume。后来消费同一引用应由新的只读调用完成。

## 兼容依据与代价

`policyVersion` 必须版本化作者的 refinement、反馈映射、业务提示与执行策略。函数身份和函数源码不参与摘要，框架不能自动证明两段函数语义相同。Zod 升级改变生成的 JSON Schema 时，目录摘要也会改变；若 Schema 不变但校验行为变化，作者仍需升级策略版本。恢复不会自动迁移这些业务契约。

固定材料仍可存在于外层回答输入和 ToolLoop 的基础请求中，这是常数份重复。消除的是每轮累计请求在模型子 CP 中的复制，并不是整个调用链只保存一次数据。父 CP 仍保存完整直接关系和工具返回值；Interaction 仍保存每次完整请求。统计必须区分单份镜像大小、保存/finish 次数、累计字节、同步 CPU 和实际请求历史增长。

当前不提供并行工具、MCP 接入、人工审批或 OS 沙箱，也不承诺工具外部副作用与实体/CP 的跨系统事务。它们可以另行通过资源和普通结构组合，不能由工具协议支持推断已经成立。
