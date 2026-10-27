# 操作失败与错误边界

状态：2026-10-25，普通调用只执行一次 run。结构不声明 accept/exceptions/raises/maxRounds，没有独立异常处理阶段。业务在需要的操作处使用统一 result 接收；此前有限两轮异常解释器已删除，不作为隐藏兼容路径继续运行。

## 一种操作接收结构

```ts
const content = await work.children.translate.invoke(text, {
  result: {
    succeeded: checkTranslation,
    failed: (failure) => work.children.backup.invoke(text),
  },
});
return content;
```

资源方法与子调用采用相同 `delta/result` 形状。成功默认返回原引用；失败默认继续交付。业务操作的普通 Error 或 DeclaredException 均可由明确的 failed 接收，不要求在结构上先登记 raises/accepts。ExceptionContract 仍可构造有明确业务含义的异常，但它不是内核捕获资格表。

result 是本次操作的处理规则。成功或失败仅选对应分支，分支抛错不再进入同一 failed。只配置 failed 时，类型包含原成功值与备用值。备用操作要自行登记为成员或资源并受自己的窗口和失败规则约束，不隐式重试。

## 允许业务处理的失败与机制故障

| 情形                                            | 处理                                               |
| ----------------------------------------------- | -------------------------------------------------- |
| 资源方法体抛错或子 run 交付业务失败             | 有明确 failed 时接收；否则继续传播                 |
| succeeded/failed/delta 结果转换失败             | 依各自接收/被动输出契约处理，不递归进入同一 failed |
| 创建、捕获、暴露、绑定或访问窗口失败            | 技术故障，不允许业务 fallback 清除                 |
| 取消、必要变化捕获、CP 提交、propagate 观测失败 | 保留内核故障归属，不重做已完成工作                 |
| isolate 观测消费者失败                          | 停用相应消费者，业务事实不回滚                     |

捕获或 expose 即使抛出 DeclaredException，也仍然是技术边界故障。资格来自发生故障的真实机制边界，不根据错误名称、文本、cause 或“最近一次异常”猜测。

交互反馈与固定文件凭据在实际持久端口失败时产生 `PersistenceError`，保留原始 cause。该故障不能进入资源或子调用的业务 failed 分支；普通 Provider 失败和文件业务拒绝仍按操作结果处理。标记发生在存储边界，不把整个模型或文件操作笼统视为存储故障，也不因保存失败重发或重写。

未被明确操作接收处理的正式子调用、资源或机制错误，按所属调用记账。归属后，业务用普通 JavaScript catch 捕获并返回正常值，也不能清除此故障或重新使用正式端点。此约束不阻止任意 JS 在 catch 内执行自己的代码；已落实内容及外部效果不回滚。

## 子失败来源和父接收事实

`ChildCallFailure` 是带准确关系凭据的交付错误，exception/cause 保留原始业务异常。并行子调用即使复用同一个异常对象，也有独立交付凭据，不会串源。原样 catch/rethrow 保留关系；解包或换抛是新的业务传播，不通过扫描关系追认旧来源。直接 catch 不应假设一定拿到原 DeclaredException 实例。

普通 `children.invoke(...,{result:{failed}})` 在接收边界核验凭据，将原始错误交给业务 failed 回调；精确 create/run/accept 保持原有显式交付边界。已鉴权的来源不能跨父调用或过期窗口复用。

子 returned failed 与父 reception handled 是两个事实。failed 回调返回备用值不改写子失败，handled 值可成为本层后续依据。正常成功交付经接收记 accepted；接收回调失败另记 reception failed。原始返回和转换后值分别保留，不能用最后显示的文本代替真实事实。

## 本层流程、输出和恢复

run 可以写明确的有限循环。Observer 的回答生成只在完整模型输出因格式/形状被拒绝时再生成一次，循环状态保存原拒绝依据与尝试次数；网络、取消或技术错误不触发同一备用逻辑。第二次模型调用是新的子调用，不是同一个 Invocation 的第二轮执行。不会重新筛选历史，也不会重复正式追加回答。

生产者的 output.result/output.delta 检查本层交付。消费端 result/delta 处理下层交付，两者不是两个节点级正常/异常阶段。一个候选失败后已有预览可能需要丢弃，输出协议明确表达候选替换，不能把多次候选增量拼成一个回答。

CP 保存父接纳与业务循环进度。Frame v5 保留 handled 事实及必要诊断，恢复不重跑已经成功的 failed 回调；需要编码接收值时在 checkpoint.receptions 登记。新执行拒绝旧 round 2/continuation 镜像，不复活删除的异常解释器。详见 [Checkpoint](checkpoints.md)。

## 观测与历史

Invocation.failure 表达真实最终交付，Context 保存已经成立的语义状态。业务已成功但最终观测失败时，不覆盖成功 Context，也不能把失败交付冒充成功。必要错误结算自身损坏是实现故障，不引入递归补救循环。

当前调用过程只发布 execute 的 start/return/throw；输出完成检查与调用控制可以产生失败事实，但不构成独立过程阶段。failure.phase 的 control 描述故障归属，不等于存在 control 过程。父子接收事实归 relationChanges，新运行不产生独立 receive/handling/control 过程或 continue。历史记录中的这些阶段及轮次保留只读解释，不能驱动当前执行。记录消费者由宿主安装，描述规则不改变业务 IO；关闭观测不执行正文描述。见 [记录机制](recording.md)。

未引入通用自动补偿、任意重试、跨进程调度或权限平台。内容保存失败仍使服务按真实存储健康决定后续接纳，不由备用分支重提事务。

## 通用诊断与调用故障策略

`@capix/diagnostics` 独立持有 PersistenceError 和 RuntimeErrorHelper，后者把异常转换为有界的诊断纯值。算法保留原来的循环处理、跨 realm 原生错误识别、大小预算和字段读取行为。RuntimeError 基类及 RuntimeErrorValue/Detail 仍来自 contracts；contracts 不因此引入 Node 依赖。

诊断包不决定取消、异常来源、接收资格或重试。Invocation 在自己的操作故障策略中识别真实 PersistenceError，并拒绝业务 failed 回调掩盖必要持久化失败；同一 code 的普通错误不获得该身份。调用与 Runtime 兼容出口重导同一个类和格式化对象，不建立平行错误层次。
