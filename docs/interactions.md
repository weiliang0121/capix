# 外部交互与调用等待

`Interaction<Request, Reply>` 表达一笔固定请求及其外部反馈，独立于 Callable 的 Invocation、Context 和可选记录。Node 可以发起交互并等待，也可以只读取此前交互。调用与交互之间只有发起、引用、收发等待关系；Node 或父调用取消不取消外部发送，也不删除反馈。Group 根据子调用真实交付决定是否再建立一个 Node。

当前用模型能力验证这一边界，并提供按调用关联读取元数据的 Observer 端点，不增加外部能力平台或恢复调度。

## 实体、契约与装配

| 对象                      | 职责                                                                  |
| ------------------------- | --------------------------------------------------------------------- |
| Interaction               | 固定身份与请求、一次发送、反馈接纳、非破坏读取和局部等待              |
| InteractionContract       | 有版本的请求/反馈数据契约，不承担业务结果接纳                         |
| InteractionPersistence    | 同步 create/commit，固定请求与版本，不依赖 Recorder                   |
| ModelSource               | 惰性建立 Provider，保存构造失败                                       |
| ModelInteractions         | 服务持有交互实例、调用 Provider、控制外部自身超时、按 ID 读取保存状态 |
| ModelResource.create/read | 绑定本次调用的受控创建与读取端点                                      |
| RequestModel              | Group 的组合：接纳发起 Node 的交付，必要时建立读取 Node               |

```ts
const model = new ModelSource(provider);
const interactions = new ModelInteractions(model, { persistence: store.interactions });
const resources = new Resources<ConversationRunOptions>();
const capture = new ConversationCallCapture(structure.scene, entities, { checkpoints });
registerConversationResources(resources, structure, entities, interactions, capture);
const runner = new Runner(structure.scene, resources, undefined, {
  ...capabilities,
  validate: (options) => capture.validate(options),
  hooks: conversationCallHooks(structure, capture),
}).build();
```

Observer 的 ModelInteractions 作为普通资源注册，继续负责 SSE、模型超时与固定请求校验；它不冒充通用 Interactions。通用交互注册是另一种可选接法，见 [Runner / Resources](runner-resources-pilot.md)。

业务只取得资源端点。`create.start(request, purpose, { timeoutMs })` 返回 `{ id }`，不接收 Invocation 的取消信号；`read.wait` 返回 `received | pending`，`read.result` 取得已接收反馈或抛出真实失败。读取端点没有发送方法，不能凭缺少结果自动重发。读取 Node 使用自己的 Context 和资源端点；不能复用已经结束的发起 Node 端点。

`InteractionContract` 前后都执行固定数据捕获：只接纳受预算约束的 JSON 形态数据，复制冻结，不执行 getter，不接受 Proxy、活实体、函数或循环。模型契约保存 Provider 返回的 ModelOutput 信封；其中 `content` 仍是未经业务 JSON 接纳的原始字符串。业务解释失败不删除该反馈。

## 当前实际调用路径

```text
选择历史 / 理解请求 / 生成回答 / 提取记忆 Group
└─ 请求模型 Group
   ├─ 发起 Node：发起一笔 Interaction，进行有限本地等待
   │    ├─ received → Group 接纳并返回 ModelOutput
   │    └─ pending  → Group 接纳交互 ID
   └─ 读取 Node：读取同一 Interaction，等待既有发送结束
        └─ Group 接纳 ModelOutput

Interaction → Provider → 固定反馈 → 可被多个 Node 读取
```

当前 发起 Node 本地等待为配置 `timeoutMs` 的一半，最少 1 ms；这只是服务第一版策略。Provider 的总超时从唯一一次发送开始计时，读取 Node 不延长超时、不再次构造请求。快速反馈不创建 读取 Node。慢反馈返回 pending 是正常交付，不虚构 发起 Node 失败或增加 Invocation 重试轮次。

回答的有限再次生成仍是另一条路径：完整模型返回被业务接纳拒绝后，父 Group 根据正式异常和直接子调用证据，使用 `RequestModel.regeneration` 创建新请求和新交互。超时、取消和网络错误不进入这条路径。读取旧反馈与生成新反馈必须显式区分。

## 时序与失败

```text
创建：捕获请求 → 保存 prepared → 实体可用
发送：保存 started → 调用 Provider（一次）
返回：捕获并检查反馈 → 保存反馈 → 通知等待者 → Node 解释 → 父层接纳
```

`started` 是本地发送意图，不能证明远端已经执行。反馈身份与正文固定；相同反馈重复接纳是空操作，不同反馈不能覆盖已有结果。读取不移除反馈，多个读者不会争抢一个消费槽位。

| 情况                        | 当前处理                                                              |
| --------------------------- | --------------------------------------------------------------------- |
| Node 的本地等待到期         | 返回 pending，外部发送继续，Group 可建立读取 Node                     |
| 读者或本次运行取消          | 结束调用自身的等待，不取消发送、不等待发送者退出；迟到反馈仍可保存    |
| 发起/读取 Node 交接期间取消 | 不再建立后续 Node；调用结构完成自身收尾后发布 cancelled，外部交互继续 |
| Provider 总超时             | 发出超时信号，真实发送退出后报告 MODEL_TIMEOUT，不重发                |
| 父层结构/观测传播失败       | 原调用失败；已发交互可以独立保存迟到反馈，不重开 Context、不追加回答  |
| 必要持久化失败              | 不把未保存反馈作为成功交付，也不重做外部工作                          |

局部等待结束不代表发送已经结束。Provider 只接收交互自身的超时信号，不继承调用的 signal；不响应该信号的 Provider 仍可能继续运行。服务接纳依据 Runner 占用、提交容量与已知服务故障，不因为先前已取消调用的交互仍在进行而标记 busy。当前没有另设外部并发容量上限，active 只表达实际在途状态，不冒充容量不足。已经可读取的交互错误或已归属的结构错误不因同时取消而改写为 cancelled；等待结束后才到达的错误独立保留在交互上，不反向改写旧调用。

宿主 `settled()` 用于等待当前全部活动交互，不接受调用 owner。环境关闭拒绝仍有活动交互；宿主应在停止接纳后独立等待外部工作收尾，再关闭存储。调用取消不执行这项宿主等待，也不能关掉反馈保存。进程实际退出只能保留已保存事实，不承诺完成清理。关闭记录不改变以上行为。

## 保存与恢复边界

SQLite `interactions` 独立保存 ID、contract、revision、固定请求与反馈/失败状态。没有调用 ID 外键；对话内容不必先存在。提交带 expectedRevision，存储检查请求和已收反馈不可更改。格式 v1 到 v2 在事务中迁移，保留原消息、记忆和历史记录。

按已知 ID 读取时，宿主可以惰性载入保存状态，不建立 Provider：

```ts
const restored = new ModelInteractions(new ModelSource(providerFactory), {
  persistence: store.interactions,
});
const output = await restored.result({ id: savedInteractionId }, { signal });
```

已保存反馈可以再次交给新的调用解释；原调用仍保持自己的取消或失败终态，不因迟到反馈复活，也不自动追加消息。只有 prepared/started、没有反馈的历史交互返回 `INTERACTION_RESTORED_PENDING`，不会重发，也不会无限等待一个已不存在的发送者。保存的失败按诊断返回。恢复实例只读，不恢复原 Invocation、QA 或提交身份，也没有恢复后的自动编排。

宿主默认保留最近 128 笔已结束交互，活动交互不淘汰。持久化交互可按 ID 重载；纯内存交互被淘汰后明确 unknown，不能据此推断“未发送”。数据库历史暂不自动清理。

当前只有一个发送者，发起 Node/读取 Node 是顺序调用，读取也非破坏性，因此无需租约。单次 start 检查和版本条件写入各自保护本地不变量，不承诺跨进程接管或远端恰好一次。外部响应已到达但尚未保存时进程退出，仍可能丢失反馈；本轮没有持久 Inbox 或远端回查能力。发送已经登记但调用尚未保存交互 ID 时中断，没有额外的发起关联可供查询；恢复仍须有原 ID，不能猜测关联或重新发送。

## 按需观测

Interaction 可接收可选 `observation` 窄端口，通过 ProgressChannel 隔离消费者错误。成功安装状态后发布 changed；必要保存失败时发布 unavailable，保留最后已提交 revision。恢复读取不伪造新变化。此出口不依赖 Recorder，事实与发送、反馈本身同生命周期。

ModelInteractions 提供只读 observe，返回一致的当前状态、读取结果及解除函数，后续跟随该实体事实；不构造 Provider 或重新发送。Observer 服务将其投影为 `InteractionObservation`，仅含身份、契约、模型用途、发送登记、保留方式及反馈可用状态，不提供请求或回复正文。

客户端先通过 conversationId + callId 查询资源访问记录中的真实关联，再订阅对应交互。资源记录自身的 interactionId 是资源动作 ID，不能拿来充当外部交互 ID；这里明确读取 start 的 output.id 或 wait/result/subscribe 的 input.id。禁止按任意全局 ID 查询其他调用或对话。记录完整性失效时，关联入口也明确失败，但不影响交互实体自身继续接收。

每条连接先发累计 snapshot，后续变化合并到微任务交付，不在实体变更栈上写网络；取得 received/unavailable 后结束本次订阅，不提供自动追赶或重发。以后再次打开详情会重新读当前事实。未持久化且被淘汰的交互明确 unknown。图中 发起 Node 的 pending 返回和父层接纳保留为历史事实，晚到反馈只更新交互卡片，不改变 发起 Node 结果，不据此判定回答或父层业务接纳成功。

## 临时输出消费

只有 stream=true 的固定请求建立 ModelTextBuffer。Provider 的第四个被动进展参数发布原始文本增量；ModelInteractions 保存最多 4 MiB 的临时前缀，read.subscribe(ref, receiver) 同步回放已有前缀并继续消费，不执行新请求、不改变 Interaction revision。它不是持久化反馈，也不替代 observe 的实体元数据。

InvokeModel Node 在启动后通过自己的输出声明交付交互身份；RequestModel Group 收到身份后，在本层正式申请的 read 资源上订阅原始文本，跨越首次 pending 和后续 Node 读取，finally 解除消费。资源只记录一次订阅操作和交互身份，不把每片正文重复写入记录。订阅注册后若严格资源观测失败，立即撤销本次订阅；已发起的外部工作仍按原交互生命周期处理。

Provider 完成或自身超时退出后停止生产；调用取消只解除该调用的消费，交互仍可继续生产并保存完整反馈。临时前缀不持久化，已恢复的完整反馈仍可读取，临时输出不可恢复时明确独立失效。下游预览可退化为前缀或不可用，不能因此重发模型。最终仍只有完整 ModelOutput 进入交互反馈保存与业务接纳。
