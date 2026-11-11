# 外部交互与调用等待

`Interaction<Request, Reply>` 保存一笔固定请求及其外部反馈，独立于 Invocation、Context 和记录。调用可以发起交互、有限等待或读取既有反馈。调用或父层取消只终止本地等待，不取消独立发送、不删除反馈，也不让旧调用因晚到反馈复活。

## 包与运行接线

`@weiliang0121/capix-interaction` 提供 Interaction、Interactions 及请求、反馈、持久与观察契约；不依赖 Runtime、Invocation、结构、资源或 Recorder。共享 PersistenceError 由 diagnostics 提供，错误是否可以业务降级仍由 invocation 决定。

Runtime 根据结构固定申请和资源接线。`new Runner(scene, resources, interactions, capabilities).build()` 可接受独立 Interactions；`Resources.registerInteraction` 在构建时取得准确契约通道并兑现资源供给，不发送请求，也不取得交互实体所有权。业务只使用当前窗口的资源端点，不能复用已经结束的 Work 端点。

## 固定契约与一次发送

```ts
const contract = { key: 'app.echo.v1', request: String, reply: String };
const interactions = new Interactions().register(contract, {
  send(request) {
    return `reply: ${request}`;
  },
});
const channel = interactions.bind(contract);
const reference = channel.start('hello');
const status = await channel.wait(reference, { waitMs: 1000 });
// status 为 received 或 pending；pending 不表示发送失败。
```

注册按准确契约对象匹配，key 也必须唯一。bind 不创建请求；同 key 的另一个对象不能替代已登记契约。参考值含 id 和 contract，用于准确读取，不自动授权某次业务恢复。

请求及反馈在契约转换前后都捕获为有界 JSON 数据（深度 64、100000 值、文本与键合计 16 Mi UTF-16 代码单元），复制冻结；拒绝 getter、Proxy、函数、活实体、循环和非 JSON 数据。固定请求经同步 persistence.create 成功后实体才可用；start 保存发送登记后仅调用一次发送者。发送返回后固定并检查反馈，持久提交成功才通知等待者。started 只表达本地意图，不能证明远端执行完成。

反馈非破坏读取，多个读者不争抢消费槽位。同内容反馈确认不覆盖结果；不同反馈拒绝。业务解释失败不会删除已保存反馈。PersistenceError 保留准确故障身份，不能通过重新执行外部工作来修复未知保存结果。

## 局部等待与宿主关闭

`wait` 的 waitMs 只限制这次等待，signal 只终止当前读者。等待到期得到 pending；取消后发送仍可保存晚到反馈。发送者自身的总超时和停止机制由宿主实现，不能将 Invocation.signal 隐式用作独立发送的所有权。

Interactions.active 表达准备或发送仍在进行；pendingCount 统计已经安装且未 settled 的交互，包含反馈校验与持久化，不含只读恢复。它们不构成并发限额或队列。默认保留每个注册最近 128 个已结束交互，活动交互不淘汰；可配置 retained。内存淘汰后的 unknown 不证明从未发送。

宿主先停止入口，再 `await interactions.settled()` 等待自己持有的发送。`close()` 遇到 active 明确拒绝，不能放弃发送；调用退出不执行宿主等待。进程直接退出只保留已经持久保存的事实，不承诺完成清理。

## 保存与恢复

同步持久端口负责固定请求、contract、revision 和反馈状态；提交使用 expectedRevision，不能改变原请求或已收反馈。注册可以提供 `persistence.read(id)` 按准确引用静默载入，不重新调用发送者。

已保存反馈可交给新调用读取解释；旧调用的失败或取消仍保留。只有 prepared/started 而没有反馈的历史交互明确报告 restored-pending，不无限等待已经不存在的发送者，也不重新发送。保存失败诊断不等于获得活 Error 或远端回查能力。

单次启动检查和版本条件写入分别保护本地不变量，不承诺跨进程租约、接管或远端恰好一次。响应已到达但尚未保存时退出可能丢失反馈；发送登记成立而父 CP 尚未保存引用时也可能缺少关联。缺失引用、反馈或无法确认外部效果都不能猜测补造。

## 可选观测

Interaction 的 observation 是被动窄端口，经 ProgressChannel 隔离消费者错误。安装后发布 changed，必要保存失败时发布 unavailable 并保留最后已提交 revision。恢复读取不伪造新变化。观测不依赖 Recorder，也不能成为请求重发依据。跨端展示应由宿主投影必要元数据，不能默认输出请求、回复或密钥。

## 通用交互的过程反馈

`Interactions` 注册可以使用 `InteractionContract<Request, Reply, Delta>` 的可选 `progress(value)` 契约。发送者的第二个参数提供 `publish(delta)`；它属于独立交互，不持有 Invocation、Work 或某次资源操作的 emit。无订阅者仍继续生产，读取者离开不取消发送。低层 `Interaction<Request, Reply>` 继续只持有固定请求、最终反馈及其持久版本；注册层在同一条交互缓存记录中组合可选过程反馈，不改变 `InteractionState` 格式或 revision。

```ts
const contract = {
  key: 'example.text.v1',
  request: String,
  reply: String,
  progress: String,
};
const interactions = new Interactions().register(contract, {
  send(request, progress) {
    progress.publish('候选片段');
    return `正式结果：${request}`;
  },
});
const channel = interactions.bind(contract);
const ref = channel.start('输入');
const reader = channel.openProgress(ref);
try {
  let item = await reader.next({ waitMs: 1000 });
  while (item.kind === 'item') {
    console.log(item.cursor, item.value);
    item = await reader.next({ waitMs: 1000 });
  }
  const reply = await channel.wait(ref, { waitMs: 1000 });
} finally {
  reader.close();
}
```

过程反馈只有一份共享完整历史。条目复制冻结，并分配 `{ interactionId, sequence }`；每个 reader 只持位置和至多一个在途 next，不复制片段队列。历史回放与实时跟随共用按位置读取；内部变化版本、等待登记及再次检查避免漏掉交接期间的发布、封闭、失效或取消。每个 next 的 waitMs 是本次等待期限；组合操作应自行固定总截止时间并传剩余时长。signal 只结束当前等待，reader.close 明确结束读取器；两者都不会重发或取消交互。

生产结束先 seal，reader 读完保留的条目后才得到 `{kind:'sealed',lastSequence}`；随后最终反馈仍须完成契约校验与保存。因此 sealed 不表示最终成功。`publish` 返回 published、sealed 或 unavailable；容量或数据契约失败使临时反馈失效，不自动破坏最终反馈。发布的数据契约必须同步，重入发布使过程数据失效，封闭后不能重新打开。

每份历史默认最多 4 MiB JSON UTF-8 内容、16,384 条目和 64 个读者，通过 registration.progress 配置；宿主 Interactions 的 progress 配置共享预算，默认 32 MiB 内容与 256 个读者。字节数限制不包含引擎对象开销，条目和读者限制另行约束数量；也不限制 Provider 内存或在途外部请求数量。已读内容仍保留以支持后来者从头读取。超限整体 unavailable，不静默截断前缀。完成缓存淘汰和宿主关闭主动使缓冲失效、释放预算并唤醒读者，不能只从 Map 删除引用。

`openProgress(ref, cursor?)` 可从已知位置之后继续；位置必须属于同一交互且不能超过已产生序号。未配置、已淘汰或跨进程载入的过程反馈明确 unavailable，读取过程数据不会访问持久反馈、重建空历史、从最终文本伪造片段或触发发送。未知的合法形状引用也只能得到 not-retained，不能证明该请求从未发送。

游标是读取位置，不是业务接纳或展示确认。next 返回后业务仍可能失败；资源 emit 的返回同样不是确认凭据。有状态解码器续接必须具有对应状态，否则从头回放重建。过程历史不进入持久化、CP 或逐片记录；最终反馈仍独立保存。

注册可选 `progressObservation` 接收 created、sealed、unavailable、reader-opened、reader-closed 元数据，只有身份、计数、位置与原因，不含请求或片段正文。created 在交互登记可见之后发布；观察者故障和递归反馈隔离，不影响生产或最终反馈，普通发布不会逐片触发此观察。

## 验证入口

[Interaction 实体](../packages/interaction/test/interaction/interaction.test.mjs)、[注册](../packages/interaction/test/interaction/registry.test.mjs)、[过程反馈](../packages/interaction/test/interaction/progress.test.mjs) 验证固定、独立发送、取消、未知恢复、预算与读取；[Runtime 接线](../packages/runtime/test/interaction/runner.test.mjs) 验证准确登记和运行窗口；[独立包](../packages/interaction/test/interaction/package.test.mjs) 验证依赖边界。测试不调用真实模型。
