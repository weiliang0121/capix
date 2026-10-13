# 外部交互与调用等待

`Interaction<Request, Reply>` 表达一笔固定请求及其外部反馈，独立于 REOA 的 Invocation、Context 和可选记录。A 可以发起交互并等待，也可以只读取此前交互；A 结束不会删除反馈。O 根据子调用真实交付决定是否再建立一个 A。

本轮用现有模型能力验证这一边界，不增加外部能力平台、恢复调度或跨端协议。

## 实体、契约与装配

| 对象                      | 职责                                                                   |
| ------------------------- | ---------------------------------------------------------------------- |
| Interaction               | 固定身份与请求、一次发送、反馈接纳、非破坏读取和局部等待               |
| InteractionContract       | 有版本的请求/反馈数据契约，不承担业务结果接纳                          |
| InteractionPersistence    | 同步 create/commit，固定请求与版本，不依赖 Recorder                    |
| ModelSource               | 惰性建立 Provider，保存构造失败                                        |
| ModelInteractions         | 服务持有交互实例、调用 Provider、控制外部超时/取消、按 ID 读取保存状态 |
| ModelResource.create/read | 绑定本次调用的受控创建与读取端点                                       |
| RequestModelDefinition    | O 的组合：接纳 A1 交付，必要时建立 A2                                  |

```ts
const model = new ModelSource(provider);
const interactions = new ModelInteractions(model, { persistence: store.interactions });
const runtime = bindConversation(definition, entities, interactions, observation);
```

业务只取得资源端点。`create.start` 返回 `{ id }`；`read.wait` 返回 `received | pending`，`read.result` 取得已接收反馈或抛出真实失败。读取端点没有发送方法，不能凭缺少结果自动重发。A2 用自己的 Context 和资源端点；不能复用已经结束的 A1 端点。

`InteractionContract` 前后都执行固定数据捕获：只接纳受预算约束的 JSON 形态数据，复制冻结，不执行 getter，不接受 Proxy、活实体、函数或循环。模型契约保存 Provider 返回的 ModelOutput 信封；其中 `content` 仍是未经业务 JSON 接纳的原始字符串。业务解释失败不删除该反馈。

## 当前实际调用路径

```text
选择历史 / 理解请求 / 生成回答 / 提取记忆 O
└─ 请求模型 O
   ├─ A1：发起一笔 Interaction，进行有限本地等待
   │    ├─ received → O 接纳并返回 ModelOutput
   │    └─ pending  → O 接纳交互 ID
   └─ A2：读取同一 Interaction，等待既有发送结束
        └─ O 接纳 ModelOutput

Interaction → Provider → 固定反馈 → 可被多个 A 读取
```

当前 A1 本地等待为配置 `timeoutMs` 的一半，最少 1 ms；这只是服务第一版策略。Provider 的总超时从唯一一次发送开始计时，A2 不延长超时、不再次构造请求。快速反馈不创建 A2。慢反馈返回 pending 是正常交付，不虚构 A1 失败或增加 Invocation 重试轮次。

回答的有限再次生成仍是另一条路径：完整模型返回被业务接纳拒绝后，父 O 根据正式异常和直接子调用证据，使用 `RequestModelDefinition.regeneration` 创建新请求和新交互。超时、取消和网络错误不进入这条路径。读取旧反馈与生成新反馈必须显式区分。

## 时序与失败

```text
创建：捕获请求 → 保存 prepared → 实体可用
发送：保存 started → 调用 Provider（一次）
返回：捕获并检查反馈 → 保存反馈 → 通知等待者 → A 解释 → 父层接纳
```

`started` 是本地发送意图，不能证明远端已经执行。反馈身份与正文固定；相同反馈重复接纳是空操作，不同反馈不能覆盖已有结果。读取不移除反馈，多个读者不会争抢一个消费槽位。

| 情况                  | 当前处理                                                                     |
| --------------------- | ---------------------------------------------------------------------------- |
| A 的本地等待到期      | 返回 pending，外部发送继续，O 可建立 A2                                      |
| 独立读者取消          | 结束自己的等待，不取消发送、不等待发送者退出                                 |
| 本次运行取消          | Provider 收到宿主取消信号；活跃读取等待真实发送退出                          |
| A1/A2 交接期间取消    | REOA 可以已经结束；服务仍等待同一宿主的取消收尾，保持 busy，再发布 cancelled |
| Provider 总超时       | 发出超时信号，真实发送退出后报告 MODEL_TIMEOUT，不重发                       |
| 父层结构/观测传播失败 | 原调用失败；已发交互可以独立保存迟到反馈，不重开 Context、不追加回答         |
| 必要持久化失败        | 不把未保存反馈作为成功交付，也不重做外部工作                                 |

合作式取消不能保证不响应信号的 Provider 立即退出。普通读取中的取消不使用 Promise.race 假装发送已结束。服务接纳还根据交互宿主的取消收尾状态判断；这与 R 是否占用分别表达。已经归属的结构错误不因同时取消而改写为 cancelled。

宿主 `settled()` 用于等待活动交互；带 owner 时只等该宿主信号对应的交互。环境关闭拒绝仍有活动交互；进程实际退出只能保留已保存事实，不承诺完成清理。关闭记录不改变以上行为。

## 保存与恢复边界

SQLite `interactions` 独立保存 ID、contract、revision、固定请求与反馈/失败状态。没有调用 ID 外键；对话内容不必先存在。提交带 expectedRevision，存储检查请求和已收反馈不可更改。格式 v1 到 v2 在事务中迁移，保留原消息、记忆和历史记录。

按已知 ID 读取时，宿主可以惰性载入保存状态，不建立 Provider：

```ts
const restored = new ModelInteractions(new ModelSource(providerFactory), {
  persistence: store.interactions,
});
const output = await restored.result({ id: savedInteractionId }, { signal });
```

已保存反馈可以再次交给新的调用解释。只有 prepared/started、没有反馈的历史交互返回 `INTERACTION_RESTORED_PENDING`，不会重发，也不会无限等待一个已不存在的发送者。保存的失败按诊断返回。恢复实例只读，不恢复原 Invocation、QA 或提交身份；本轮没有恢复后的自动编排与客户端交互查询接口。

宿主默认保留最近 128 笔已结束交互，活动交互不淘汰。持久化交互可按 ID 重载；纯内存交互被淘汰后明确 unknown，不能据此推断“未发送”。数据库历史暂不自动清理。

当前只有一个发送者，A1/A2 是顺序调用，读取也非破坏性，因此无需租约。单次 start 检查和版本条件写入各自保护本地不变量，不承诺跨进程接管或远端恰好一次。外部响应已到达但尚未保存时进程退出，仍可能丢失反馈；本轮没有持久 Inbox 或远端回查能力。
