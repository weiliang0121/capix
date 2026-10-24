# 声明、异常处理与错误边界

普通资源与子调用现使用统一的 `result: { succeeded?, failed? }` 接收。本文说明仍保留的高级调用级异常处理与有限轮次继续，不要求普通业务为每个操作额外声明 exceptions。Scene、Group、Node 实现共同 Callable 契约；Scene/Group 通过成员调用组织处理，Node 实现直接处理。Invocation 不按结构 kind 选择生命周期机制。

## 声明与绑定

```ts
const definition = {
  maxRounds: 2,
  raises: [outputRejected],
  deps: {/* 当前工作需要的正式资源访问 */},
  uses: [model, acceptOutput],
  run(work) {
    /* 本层工作及组合 */
  },
  accept(work) {
    /* 可选的正常结果接纳 */
  },
  exceptions: {
    deps: {/* 处理时需要的正式资源访问 */},
    uses: [],
    accepts: [outputRejected],
    handle(work) {
      return work.continue(work.input, '重新构造模型反馈请求');
    },
  },
  observation: [
    invocationRecording({
      input: (value) => describeInput(value),
      output: (value) => describeOutput(value),
    }),
  ],
};
```

这是契约形态示例，不是可直接执行的服务声明。`run`、`accept`、`exceptions.handle` 可以有业务复杂度；绑定只落实依赖、所属关系、阶段访问和结构接线。`accept` 只接收正常输出，原 `receive` 中混合的错误分支不再保留。

静态装配检查正常工作与异常处理所需资源的总覆盖，但运行时分别提供各自的具名资源和子调用端点。`uses` 缺省沿用所属节点的子声明，`exceptions.uses` 缺省为空。相同资源供应可以共享固定捕获，两个阶段的活端点分别受当前阶段约束，保存旧端点也不能跨阶段使用。已有 `timing: binding` 供应仍按其契约固定创建时事实；`timing: access` 的异常专用供应在正常路径不兑现。

子调用关系公开身份、输入、结果和进度等事实，不公开子层的资源端点。资源只从本层本阶段绑定的 Work 进入业务。

## 操作接收与本层继续

`work.children.child.invoke(input, { result: { succeeded, failed } })` 与资源方法使用同一接收协议。普通工作错误可以由已声明的操作接收者处理；子调用仍保留原失败，父关系另记 handled。返回备用值不等于重新运行原调用，也不修改其失败事实。接收回调失败不再进入同一 failed，需由外层操作处理或继续交付。

内核在实际边界确定接收资格。取消、阶段越界、未声明的声明异常、输出契约、必要变化捕获、强制观测、CP 保存错误不允许用备用业务值抹掉。资格只存在于活交付，不从历史错误正文或错误字符串重建。资源源失败与取消/关闭同时发生时保留两项错误，cause 指向源失败，禁止启动备用接收。

原显式 create/run/accept 和没有 failed 的路径继续严格传播。以下表格的“异常处理”专指 `exceptions.handle`；普通操作接收不需要先把每个 Error 包装成 DeclaredException。

## 调用级异常与错误

| 情形                                                 | 分类与处理                                            |
| ---------------------------------------------------- | ----------------------------------------------------- |
| 工作产生所属 `raises` 契约创建的 `DeclaredException` | 异常，可进入匹配的 `exceptions.handle`                |
| 直接子调用交付已经确认的异常                         | 父层可以按 `accepts` 接纳；子层保留失败状态及异常身份 |
| 未声明的异常、普通 throw、内核/绑定/调用边界错误     | 错误，不进入业务异常处理                              |
| 处理器抛错、返回非法决定、处理器使用正式端点发生错误 | 错误，不递归进入处理器                                |
| 变化捕获或显式 propagate 观测失败                    | 错误，不重做已完成工作；isolate 仅停用失败观察者      |
| 异常到达没有消费者的 Runner 根出口                   | `UNHANDLED_EXCEPTION` 错误，cause 保留原异常          |

契约按对象身份匹配；相同名字不表示相同契约。异常事实保留运行中的值和 cause，正式记录再按自己的正文规则捕获，不用错误字符串推断处理资格。

处理器返回本阶段签发的 `work.return(output)`、`work.continue(input, reason)` 或 `work.unhandled`，不能自造同形控制对象。`return` 明确提供本层输出；`continue` 仍受所属调用一轮或两轮的限制，并说明原因；`unhandled` 交还原异常。处理器可以使用声明过的业务资源及子调用，并非只能提出无副作用建议。

错误结算只落实当前 Context 终态、调用返回以及可选记录/通知，不再调用业务处理器。结算路径自身损坏属于实现缺陷；当前固定边界保留原失败与登记失败的诊断，但不建立递归补救机制，不承诺进程崩溃后的保证。

## 子交付异常的准确来源

直接子 `run / accept` 的声明异常通过独立 `ChildCallFailure` 交付；其 `exception` 和 `cause` 保留原始异常。每笔交付有自己的父关系、阶段及轮次依据，同一异常对象被多个并行子调用复用也不会串源。业务原样 catch/rethrow 该交付对象会保留来源；`exceptions.handle(work)` 收到的仍是原始异常，`work.origin` 给出已核验的 self、child-return 或 child-reception。

这改变了直接 catch 的对象身份及 `instanceof DeclaredException`；需要读取原异常时使用 `ChildCallFailure.exception`。主动解包再抛出原异常会按本层 self 异常检查 raises，不保留子来源；复制或包装交付对象也不靠扫描关系、最近异常或 cause 猜测来源。处理器中新发生的失败按实际失败交付，不能误用先前进入处理器的来源。

继续事实只在决定被内核接纳并进入下一轮时安装，记录 reason、来源和前后轮次；第二轮可读取，但不能凭事实重新获得旧阶段句柄。有限恢复只保存原异常的诊断和准确关系，不复活历史异常对象。

## 归属、状态与已产生的事实

`Invocation.failure` 表示最终失败交付的类别、阶段、归属 Context 和原错误。它与 `Context.status` 分开：工作已经成功，但最终记录失败时，Context 仍成功，调用交付错误。父层不能把该错误当作成功结果。

未被明确操作接收者处理的正式子调用与资源错误，以及子入口或机制错误，会归入所属调用。归属以后，业务即使通过普通 JavaScript catch 捕获、返回正常值或换抛一个声明异常，结构仍按错误结束；同一调用的后续正式资源及子调用入口也被阻止。已经落实的消息、记忆或外部副作用不回滚。

这只约束框架提供的端点，不声称能阻止任意 JavaScript 在 catch 后执行自己的代码。无 Recorder 时同样有调用关系、阶段约束和错误归属。

## 观测

观测声明可将运行事实写入记录或其他载体，不改变运行输入输出。关闭观测安装时不兑现其依赖；安装后默认 isolate，可显式 propagate。记录 IO 描述由 invocationRecording 提供。服务采用 isolate，传播失败归属实际观测源，不递归进入业务异常处理。详见 [记录观测](recording.md) 和 [运行结构](callable-structures.md)。

内部过程保留 `execute`、`receive`（正常接纳）、`control`，新增 `handling`（异常处理）。处理器的进入、返回、继续、未处理及失败分别可见。最终输出可以引用本调用的 `receive.return` 或 `handling.return`，不复制正文或跨记录引用。失败正文和过程可携带 `failure` 分类事实；客户端增量、快照校验和详情读取使用同一契约。

## 已验证场景

Observer 的模型输出接纳 Node 只将确定的 JSON/空输出/输出形状拒绝生产为 `modelOutputRejected`。生成回答 Group 的异常声明依据直接子调用证据，最多继续一次，保留原请求、模型返回和反馈。不重新筛选历史，不重复追加回答；超时、网络错误、取消、记录错误等保持失败。

客户端初始化验证另一个职责场景：`InitializationAttempt` 持有本次初始化的状态与结束权，同次调用复用 Promise，失败后显式初始化产生新尝试。配置和消息集合分别保留已经成立的事实，停止或过期尝试不能迟到写回。此处没有声明过的业务异常，只有初始化错误，因此没有虚构异常处理器，也不依赖服务端 Invocation。它不改变服务端 `Initializer` 的同步失败缓存语义。

本轮不增加自动补偿、通用重试、未完成调用恢复、外部幂等、跨进程调度、权限系统或高可用机制。内容保存失败作为已归属错误交付，服务存储健康决定后续接纳资格，不由异常处理器重新提交事务或重跑业务。
