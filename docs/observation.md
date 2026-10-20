# 观测迭代方案

> 本文的 REOA、E entry 与旧记录层次是历史方案，已被 [Callable / Scene / Group / Node 运行结构](callable-structures.md) 替代；保留下文仅供理解当时的设计过程。

> 这是已实施迭代的设计与审查材料，包含当时的缺口、伪代码和迁移过程；不作为当前公开 API 清单。当前定位与命名见 [项目组织](organization.md)，运行契约见 [运行边界](runtime-boundaries.md)，记录与交付见 [记录机制](recording.md) 和 [增量观测](observation-increments.md)。

状态：已实施并通过整仓验证。本轮补齐 R 的运行声明、绑定及本次调用，使 REOA 使用一致的调用与直接子关系机制；以运行结构的类型化观测出口为中心，解决子调用返回与父层接纳过程无法完整被观测的问题。同时将记录收敛为内置可选的观测预设，并明确观测声明、绑定、多种结果载体及 Service 消费辅助的边界。

下文保留设计推演中的类型与伪代码；实际公开 API 与实施差异见文末“实施落点”。现有 EOA 工作、异常处理、资源访问与消息接纳职责继续保留；本轮替代了“R 只持有唯一 E，不具有自身调用”“观测只描述记录 IO”和“记录观测失败无条件影响运行”的旧约定。相关现状文档与 AGENTS.md 已同步修订。

## 本轮目标与边界

必须完成的内核目标是：关闭记录后，运行关系仍然成立，任意满足契约的观测能力都能区分子工作结束、子调用实际返回以及父层接纳。观测事实在真实转换点产生，不能从两份快照、相邻记录或 UI 状态推断。

本轮同时完成以下配套改造：

- R 声明可用的 E 与自身运行内容，通过本次 Invocation 选择、调用并接纳 E；当前服务仍只配置一个 E。
- 声明中的观测能力可以使用正式窄端口，产生一种或多种数据结果。
- 观测失败支持隔离与传播，影响范围由事件所属结构确定。
- 内置记录预设消费运行事实，不再作为观测的绑定前提。
- 记录载体提供配套变化来源适配，Service 通过消费辅助完成基线接续与增量交付。
- 现有记录详情可以解释父子返回与接纳关系；不重做图谱布局。

不增加抽象 Carrier 基类、全局事件总线、动态插件注册、跨载体事务、自动补写与回放、调度器、持久化或恢复系统。不展开消息与记忆自身实现形式的泛化。统计与报告只作为多结果能力的验证样例，不建设新的生产子系统。

## 概念与职责

| 概念                       | 职责                                                 | 明确不承担                                     |
| -------------------------- | ---------------------------------------------------- | ---------------------------------------------- |
| 运行结构及内容实体         | 维护真实状态、关系和约束，在正式边界产生事实         | 为某种记录格式改变工作语义                     |
| 事件出口                   | 提供确定的事实类型、身份、归属和局部顺序             | 推进业务、推测变化、规定观测结果形式           |
| 观测声明                   | 解释所声明的事实，使用端口形成结果                   | 越过绑定取得活 Context、原实体或运行控制权     |
| 观测绑定                   | 检查依赖，形成局部观测实例、端口及失败策略           | 业务编排、规定所有结果的统一形状               |
| 载体                       | 对观测能力产生的数据结果的称呼                       | 必须实现某个基类、公共 write 或 snapshot       |
| 内置记录预设               | 解释调用关系、过程、资源访问及现有内容变化，形成记录 | 成为所有观测的前置依赖                         |
| 缓冲                       | 接纳固定数据，转交给后续消费者                       | 权威历史、交付确认、业务事务                   |
| Service 来源适配及消费辅助 | 读取结果、接续变化、公开映射和发送                   | 重新解释内核发生了什么、通过快照 diff 生成增量 |

这里的“运行时”指结构在活动中的状态，不等于 R 类。Transcript、Memories、Book、模型供给等仍是独立对象，R 不成为世界根节点。

```text
运行事实出口
  ├─ 必要的同步投影接纳 → 缓冲 → 消息等独立同步通道
  └─ 可选的观测绑定
       ├─ 调用记录预设 → 记录数据
       └─ 其他观测声明 → 自己的数据结果

结果的正式变化 → 来源适配 → Service 消费辅助 → 客户端
```

一个事件可以被多个观测能力消费；一个观测能力也可以写入多个结果。观测与载体不是一对一关系。

## 实施前的缺口与修复位置

当前 InvocationRelation 已保存父轮次、工作位置、实际返回及 reception 的 pending、receiving、accepted、failed 状态，但转换没有对应的事件出口。InvocationEvent 目前只有 started、process、finished。

现有 ProcessRecord.receive 表示本调用接纳自己的 execute 输出。Sequence 在父 execute 内调用 children.accept，表达的是父层接纳某个子调用结果；这两者必须保留不同语义。

当前 Invocation、ResourceActivity、Transcript 和 Memories 仍直接接入 Recorder 或记录 Helper。记录关闭时已有部分运行独立能力，但类型依赖、数据描述和错误接线仍需要分离。

当前 RuntimeDefinition 只有 execution 字段，assembleRuntime 直接建立唯一 E，Runtime.run 负责占用和转发。E 没有父调用，ChildDefinition 与 BindingEnvironment 只覆盖 O/A。该特化需要从声明、绑定和调用建立处一并移除，不能仅增加一个 RE 专用通知。

对应实施位置：

| 位置                                                     | 本轮变化                                                        |
| -------------------------------------------------------- | --------------------------------------------------------------- |
| definition/runtime.ts、runtime、binding/runtime.ts       | 补齐 R 运行声明、本次调用与根入口，移除 sole execution 结构约束 |
| definition/children.ts、binding/environment.ts、E 构造器 | 声明与绑定支持 E 子节点，E 调用直接归属本次 R Invocation        |
| invocation/children.ts、relation.ts                      | 从真实关系转换处生产事实，按父范围归属观测错误                  |
| invocation/invocation.ts、cycle.ts                       | 统一类型化出口，区分工作结果、观测处理和实际交付                |
| invocation/recording.ts、records/invocation              | IO 描述移入记录预设，局部记录句柄移入预设绑定                   |
| definition、binding、initialization                      | 观测声明的依赖检查、按范围惰性绑定及失效                        |
| resource/activity.ts、bindings.ts                        | 访问事实独立于记录，落实状态后发布，保持原工作异常分类          |
| transcript、memory                                       | 实体只生产真实变化，通过局部观测端口关联结果                    |
| services/observer 的 feed 与适配                         | 抽出共用消费职责，分离消息同步与记录观测生命周期                |
| protocol、client/runtime、app binding                    | 只增加真正跨端的契约、接纳与详情投影                            |

## REOA 的统一运行模式

R 与 EOA 都有声明、绑定、固定运行结构，以及按次建立的 Invocation 和 Context。R 的工作负责选择已声明的 E、发起调用和接纳结果。当前只有一个 E 是服务的声明内容，不再是运行内核的结构限制。

| 层面     | R 的对应职责                                                                             |
| -------- | ---------------------------------------------------------------------------------------- |
| 声明     | children 声明可用 E；run、exceptions、observation 平级，分别表达工作、异常处理和观测内容 |
| 绑定     | 检查资源供给与子声明，惰性建立 E 节点，按本次调用兑现端口                                |
| 结构     | 维护实例、占用约束、调用入口和构造能力                                                   |
| 本次调用 | 独立的 RuntimeContext、通用 Invocation、直接子关系、局部顺序和结果                       |

Runtime 实例持有跨调用的占用状态；现有仅保存 running 的 RuntimeContext 不能直接复用为本次调用上下文。占用状态留在实例结构内，RuntimeContext 按调用建立，继承现有调用现场机制。每次结束只关闭本次现场，不结束 Runtime 实例；本次错误不带入下次调用。

```text
R 实例
├─ run(input1) → R 调用 r1
│                 └─ E 调用 e1 → O → A
└─ run(input2) → R 调用 r2
                  └─ E 调用 e2 → O → A
```

R 的首版声明保持简单：

```ts
const runtimeDefinition = {
  children: [conversation],

  run: {
    requires: {},
    uses: [conversation],

    async execute(context, invocation, children) {
      const selected = conversation;
      const child = children.get(selected).create(invocation, context.currentInput, {
        key: 'conversation',
      });
      const output = await child.run();
      return children.accept(child, () => output);
    },
  },
};
```

这里的选择是工作内容。绑定只兑现已声明子项，不替业务选择。调用一个未声明的 E 仍被正式入口拒绝；未选中的 E 不提前实例化。首版一次 R 调用选择并等待一个 E，R 不自动重试，不增加调度、并行、队列或动态注册。

R 的绑定可以掌握后代需要的供给范围，R 工作只取得自己声明的资源端口。校验 E 的供给不等于把 E 的资源授予 R 工作。Transcript、模型供给等独立实体的生命周期和原始引用仍在装配环境，不能借补齐 R 将它们变成 R 的业务属性。

### 入口与交付时序

本轮采用以下顺序：取得实例占用 → 建立 R Context 与 Invocation → 执行 R 声明 → 进入所选 E 的正式入口 → E 接纳与分段 → 捕获 E 资源 → 建立 E Context 与 Invocation → 调用和接纳 E → 结算 R 调用 → 释放占用。释放由 finally 覆盖全部建立、执行与结算路径。

E 的接纳、分段和 capture 仍按现有顺序执行，不能将历史范围提前固定在 R Context 初始化时。E 入口未完成时可能已经有 R 调用，但还没有 E Context；此时错误归当前 R 的正式子入口，不伪造 E 的 attached 或 returned。占用拒绝、静态装配失败等发生在 R 调用建立前，只保留真实结构事实。

R 复用通用调用的取消检查。相应入口行为明确为：R 工作开始前已经取消，不进入 E 接纳，不追加消息；进入 E 接纳后已经落实的消息或分段不回滚，随后在正式检查点停止。这是相对于当前可能先追加消息再检查取消的明确时序调整，应有回归用例，不引入主动取消 UI 或取消恢复机制。

E 的实际返回通过 R→E 的普通 returned 事实表达。R 可以接纳、转换该结果，也可能接纳失败。R Context 成功后终态观测或根出口结算仍可能失败，Service 必须消费 R.run 的实际 Promise 结果。根入口继续把未处理的声明异常转成既有出口错误，不伪造更上一层调用，也不递归生产“最终返回”事件。

Runtime.run 的契约不再直接以 ExecutionCallbacks 表达自身回调。服务需要的 E 接纳与开始通知留在 E 的正式绑定出口，R 调用通知描述 R 自己；现有业务流中的 QA 身份仍指向 E，不被 R 调用身份替换。

## 类型化事实出口

每种生产者定义自己的事实契约。通用的发布机制不使用 type:string、payload:any 代替这些契约，也不建立包含所有未来实体的内核大联合类型。需要同时消费多个来源时，在实际装配位置组合类型。

| 所属位置                 | 本轮覆盖的事实                                               | 产生时机与约束                                                                          |
| ------------------------ | ------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| R 实例结构               | 建立、占用取得与释放、调用建立前的入口拒绝或失败             | 描述实例结构，不与本次 R 调用的终态混合                                                 |
| E 入口                   | 正式接纳、分段落实与入口失败                                 | 尚无 E Context 时使用已经存在的 R 调用来源，不伪造 E 调用；分段仍由 Transcript 变化表达 |
| R、E、O、A 的 Invocation | 开始，execute 返回或抛错，正常接纳，异常处理的决定，工作终态 | 共用调用结构契约，不按业务动作名称增添内核事件分支                                      |
| 直接父子关系             | attached、returned、receiving、accepted、failed              | 在关系转换落实后发布，归属父调用范围                                                    |
| 资源访问                 | bound、available、unavailable、started、returned、threw      | 来源与访问声明独立；观察失败不伪装为资源操作抛错                                        |
| Transcript、Memories     | 既有正式内容变化                                             | 先检查并落实实体和局部顺序，再发布；正文中没有记录 ID                                   |
| Recorder                 | 登记、更新及自身关系变化                                     | 只表达记录载体的变化，不自动反馈到生成这些记录的观测能力                                |

静态声明和装配元数据在范围建立时固定，不为每个构造函数制造运行事件。结构建立前的装配失败由该初始化边界处理，不能制造一个实际上不存在的调用。

Runtime 结构有自身只读实例 ID，由自身建立时生成，用于实例结构事实；REOA 各次调用使用自己的 Context ID。两者都不使用 RecordingRootRecord.id 作为运行身份。实例结构顺序与各次调用顺序分别维护，不引入新的 Run 层。

RE、EO、OA 都使用相同的直接父子关系事实。先前拟议的 execution-returned 特化不再保留；E 的成功不会因 R 后续失败而被改写。

### 父子关系事实

以下只展示核心关系契约；FailureView 表示运行层的已分类失败视图，而非记录正文：

```ts
interface ChildRelationIdentity {
  readonly parentContextId: string;
  readonly childContextId: string;
  readonly parentRound: number;
  readonly key?: string;
}

type RelationChange = { readonly kind: 'attached' } | { readonly kind: 'returned'; readonly result: InvocationResult<unknown> } | { readonly kind: 'receiving' } | { readonly kind: 'accepted'; readonly output: unknown } | { readonly kind: 'failed'; readonly failure: FailureView };

interface RelationFact {
  readonly identity: ChildRelationIdentity;
  readonly sequence: number;
  readonly occurredAt: string;
  readonly change: RelationChange;
}
```

这些事实使用父调用的事件顺序，和父范围其他事件可对照。既有调用过程序号、资源访问序号和实体 revision 保留自己的语义；发送者游标另行维护。时间只表达实际时刻或耗时，不替代归属与顺序。

已建立但未运行的子调用只产生 attached，不产生 started、returned 或 accepted。普通直接 call 成功不等于显式接纳，reception 仍保持 pending。子异常被父处理也不改变该关系的正常接纳状态；异常处理事件通过失败来源关联对应子调用。

### 数据读取与固定

内部运行事实与跨端事件不直接等同。身份、状态和顺序是固定元数据；普通 IO 和异常依据可在同步观测边界只读借用，不修改、冻结或替换业务值。只读类型不是安全沙箱，也不保证任意 JavaScript 不会违反契约。

记录预设在同步处理期间完成描述、检查和数据固定。缓冲只接收已经固定的投影，不保存活 Context，不在异步发送时重新读取业务对象。关闭观测时不执行记录描述，也不对任意 IO 施加 JSON 约束。

大实体继续用 UID、范围、版本等受控定位方式表达，正文按实体接口独立读取。事件基础词汇归生产者；移除 InvocationEvent 对 ProcessRecord 阶段与动作定义的反向类型依赖。

## 观测声明与装配

观测是所属整体声明的平级部分，不挂在 run 内部。观察者不取得可启动 REOA 的工作端点，只取得所声明事实和正式访问端口。

```ts
interface ObservationDefinition<F, P extends object> {
  readonly requires: ResourceRequirements<P>;
  observe(fact: F, ports: Readonly<P>): undefined;
}
```

本轮端口严格同步。返回 undefined 用于拒绝 TypeScript 中被 void 签名意外接纳的 async 函数；不可信 JS 返回 Promise 也按错误声明处理，不悄悄支持异步观察工作。每次处理结束后，本次写端口窗口关闭。真正的异步发送放在缓冲之后。

绑定时保留 F 与 P 的类型配对，并兑现对应端口；绑定完成后，运行结构只拿到接收 F 的发布端口及故障结果。不同观察者可以使用不同 P，不要求内核持有它们的资源大联合或了解结果类型。失败策略属于安装选项，保持与观察内容分离。

REOA 的 observation 可以包含多个声明，未声明时为空，各次调用按相同方式安装。结构实例与独立实体的事实按各自类型和生命周期绑定，不混入单次调用现场。关闭观测安装时，不兑现其依赖、不执行描述；明确开启后，缺失正式依赖属于装配错误，不能静默降级成未安装。

默认没有观测，选择安装后的默认失败策略为 isolate。Service 显式安装现有记录预设，并可为某项安装选择 propagate；不通过“是否用了记录”决定策略。

```ts
const definition = {
  run: workDeclaration,
  exceptions: exceptionDeclaration,
  observation: [
    callRecording({
      input: describeInput,
      output: describeOutput,
    }),
  ],
};
```

callRecording 是内置的具体观测声明工厂；目前 observation.input/output 的规则迁入这里。安装记录预设但没有自定义描述时仍使用其默认描述。运行结构不提供隐藏的第二条记录路径。

资源申请继续使用已有 offer/request/provider 身份匹配与窄端口机制。观测输出端口的执行窗口由观测绑定维护，不能原封不动复用正常工作端点的自观测接线。观测写入可以产生面向 Service 的载体变化，但不自动产生回到同一观察者的资源观测事件。

### 一次观测写入多种结果

```ts
interface DiagnosticPorts {
  readonly records: InvocationRecordWriter;
  readonly totals: WorkDurationWriter;
  readonly report: DiagnosticReportWriter;
}

const diagnosticObservation: ObservationDefinition<CallFact, DiagnosticPorts> = {
  requires: diagnosticRequests,

  observe(fact, ports) {
    recordInvocation(fact, ports.records);

    if (fact.kind === 'work-returned') {
      ports.totals.add(fact.durationMs);
      ports.report.append({ contextId: fact.contextId, durationMs: fact.durationMs });
    }
  },
};
```

diagnosticRequests 中的端口由对应能力公布，不是观察者自行创造访问等级。上例产生调用记录、统计数据和报告条目三种结果，不要求它们实现共同接口，也不把它们打包成统一 ObservationResult。统计和报告在本轮只用于测试。

其中 InvocationRecordWriter 是本次调用绑定生成的窄端口，持有局部记录句柄及父预设关联；它不是依赖全局反查的通用 Book 写入器。声明可复用、端口按调用建立、Book 可以共享，这三个生命周期分开。

一份声明是一个处理边界。第一份结果写入后第二份失败，已写数据保留，剩余语句不自动继续，也不重跑整份声明。若不同结果应独立失败，应拆成独立观察声明，或由复合声明明确处理局部失败。

## 局部状态与生命周期

| 对象                         | 生命周期与持有位置                                 |
| ---------------------------- | -------------------------------------------------- |
| 观测声明                     | 可复用定义，不存本次调用状态                       |
| REOA 本次调用的观测实例      | 调用绑定持有，包含处理窗口、启用或失败状态         |
| 结构实例及独立实体的观测安装 | 随对应结构或实体的安装范围存在，不混合各次调用状态 |
| 本次记录句柄与父记录关联     | 内置记录预设自己的局部绑定                         |
| Book 等跨调用结果对象        | 外部装配环境，解除某次观测不清空结果               |
| 完整性与来源接续状态         | 具体 Service 来源适配器，寿命覆盖它公开的载体范围  |
| 消费连接与缓冲               | Service 消费绑定，关闭连接不销毁载体或停止运行     |

各次调用的绑定独立，共享 Book 不共享本次处理状态。不建立全局 Context→Record 反查。创建局部观测端口与实际写记录分开；静态绑定不产生调用记录，开始事实到达后才形成相应记录。

记录预设在 R、E、O、A 的安装要求完整父结构，装配时检查。根实例范围下新增 R 本次调用记录，E 记录归属对应 R 调用，不能仍直接挂到实例根。其他观察者不受该约束。第一版不支持任意只记录 A 而省略其 O/E/R 调用记录的配置。

静态配置完整不保证运行时父记录句柄一定形成。若父记录预设已失败，依赖它的子记录绑定沿该预设的局部子树停用，保留来源不完整状态；不创建孤儿记录，不全局查找补父，不在每层重新制造结构错误。其他独立观察者不受影响。父预设选择 propagate 时，所属运行仍按既定错误边界停止。

## 发布顺序与错误归属

必要同步接纳、可选观测处理、网络交付是不同边界。

1. 生产者落实真实变化及自己的顺序。
2. 如有必要同步出口，先受控接纳其稳定投影并保留故障；继续保留当前捕获失败不回滚、不得重做业务的规则。
3. 同步分发给已经安装的观测实例，各实例在自己的边界捕获处理错误。
4. 结构在规定检查点处理需要传播的观测故障。
5. 缓冲后的编码与网络消费在 Service 中进行。

生产者通过受控发布端口获取故障结果，不允许任意观察者异常直接穿过当前 JavaScript 调用栈决定错误归属。一个实例失败后停用；本次事实仍可分发给其他健康观察者，随后由所属结构处理汇集的 propagate 故障。没有跨观察者事务。

必要同步捕获失败也不能跳过已安装的可选观测：事实已经发生，各出口分别接纳，最后由固定错误边界收敛故障。同步捕获仍按现有严格失败处理；这一点不因观测选择 isolate 而改变。捕获故障与观测故障同时发生时保留两者，不回滚事实，也不重做原操作。

继续分发的是已经成立的事实，不是继续业务。发布期间保持所属结构的错误或重入约束；观测没有正式工作端口，不能借这段分发再启动工作。对 failed 事实的剩余观测再次失败时只收敛故障，不递归生产新的 failed。

| 策略      | 观测实例及已写结果                             | 所属运行                                       |
| --------- | ---------------------------------------------- | ---------------------------------------------- |
| isolate   | 停用失败实例，保留已写数据，处理公开来源完整性 | 不改变原工作结果或异常类别                     |
| propagate | 同样停用并保留数据                             | 在所属结构的正式边界归入错误，阻止后续正式动作 |

不要求隔离失败必须再产生日志、记录或 UI 提示。错误诊断不递归调用失败的观察者。错误收敛机制自身失效属于实现缺陷，不建立无限补救链。

### 子返回事实归父范围

returnedWith 由子调用栈触发，但关系属于父调用。这里发生观测故障，不能把已经提交的成功 returned 改成失败，也不能再次调用 returnedWith。

```ts
returnedWith(result) {
  this.requireNotReturned();
  this.returned = fixedResult(result);
  this.parent.acceptChildFailure(result);

  const fault = this.events.returned(result);
  this.parent.acceptObservationFault(fault);
  // 不把父观测故障抛回子 run。
}
```

isolate 不影响父运行；propagate 将故障归入父范围。父层的健康检查阻止接纳、后续正式资源访问和子调用，最终父出口交付错误。不能承诺禁止任意业务 JavaScript 在其自行捕获错误后执行普通语句。

### 父接纳的工作与发布分开

```ts
async accept(work) {
  this.requireAcceptable();
  this.reception = receiving();
  const startFault = this.events.receiving();

  if (startFault) {
    this.reception = failedByObservation(startFault);
    const finishFault = this.events.receptionSettled(this.reception);
    const failure = combineObservationFaults(startFault, finishFault);
    this.parent.acceptObservationFault(failure);
    throw failure;
  }

  // 这个辅助只捕获 work 的返回或抛错，不包含观测代码。
  const result = await performWorkOnly(work);

  this.reception = result.ok
    ? accepted(result.output)
    : failedByWork(result.error);

  const fault = this.events.receptionSettled(this.reception);

  if (!result.ok && fault) {
    // 这是固定错误收敛：保留两者原因，分类必须是 error。
    const failure = observationFailure(fault, { cause: result.error });
    this.parent.acceptObservationFault(failure);
    throw failure;
  }

  this.parent.acceptObservationFault(fault);
  this.parent.requireHealthy();
  return resultOrThrow(result);
}
```

上述 events 方法已经隔离各观察者，返回值只表示需要传播的故障。receiving 阶段若被观测故障阻断，不执行接纳工作；应保留接纳因 observation 而失败的事实，并仅向仍健康的消费者发布一次终结信息。

accepted 已落实后发生观测故障，只影响父最终交付，不把接纳改写成 failed。业务失败与 propagate 观测故障同时存在时，保留原失败事实和原因，最终交付分类为 error；不能仍把原 DeclaredException 送入业务处理器而绕过传播策略。BoundChildren.accept 中识别业务抛错的标记只覆盖 work，不包含观测发布。

### 其他必须保持的顺序

- Context 成功后本调用的终态观测失败：Context 继续成功；propagate 使实际调用交付错误，父关系收到该真实错误。根 R 没有父调用，由 Service 消费实际交付结果。
- R 取得占用后的发布失败：整个范围仍受 finally 保护，释放占用；不因报告失败把 R 卡在忙碌状态。
- 资源 bound、available 的去重标记先落实再发布；通知被隔离时不重新初始化资源或重复生产事实。
- 资源操作的返回或抛错由实际操作决定；返回后的观测失败不能进入资源 work 的 catch，伪装成资源操作失败。
- 原工作失败后结算又出现观测故障：保留两者原因，不覆盖原事实，也不调用坏观察者重复报告其失败。

## 实体变化与局部观测来源

Transcript 和 Memories 保留正式变更与独立同步出口，不在内部创建特化记录。资源绑定为本次写入提供来源与可选局部观测端口；业务只看到原来的 append/apply 等正式接口。

```ts
interface MutationOptions<E> {
  readonly origin?: InvocationOrigin;
  readonly observation?: EventConsumer<E>;
}

appendFrom(messages, options = {}) {
  this.requireWritable();
  const accepted = this.validate(messages);
  const event = this.createEvent(accepted, options.origin);

  this.commit(accepted, event.revision);
  const syncFault = captureSafely(this.capture, event);
  const observationFault = this.publishObservation(event, options.observation ?? this.defaultObservation);
  settlePublication(syncFault, observationFault);
}
```

示意中的消费端口是已绑定端口，包含失败策略和来源归属，不是任意业务回调。captureSafely 与 settlePublication 仅表示接纳和固定错误收敛两个步骤，不是新的业务处理器。局部端口替换默认观测，不替换实体的固定同步出口；显式静默端口区别于未提供参数，不能意外回退到默认记录。

共享实体不保存 currentScope。两个调用交错写入同一个集合时，各次操作携带自己的内部端口，端口闭包持有对应记录预设的局部句柄。一个实体事实只捕获一次，不因记录写入而重发同一个实体事件。发布期间对同一实体重入写入，在再次修改前拒绝。

调用外变更允许没有运行来源，使用实体的默认安装；不虚构某个 R/E/O/A。必要消息同步与可选记录观测分别装配，关闭后者不会关闭前者。

## 内置记录预设

现有 Book、RecordTree、Recorder 和特化记录规则作为可选实现保留在当前包中的独立职责模块。本轮不为迁移拆新包，也不把通用消费机制写入 Book。

Invocation 不再持有 CallRecord、Recorder 或 source() 的记录关联。局部记录预设维护本次记录及直接父关联，资源和实体使用绑定生成的窄观测端口。RecordTree 继续只解释记录关系，不参与运行关系维护。

调用关系事实先作为父调用记录的 relationChanges 条目保留，不新建 RelationRecord 实体。本轮不将它们插入已有 processes 数组，以免破坏本调用 execute/receive 的过程顺序和 resultOf 约束。

relationChanges 保存固定后的身份、结果描述、发生时间和 eventSequence，后者来自父范围事实顺序。既有过程条目也保存对应 eventSequence 用于展示对照，其 sequence 仍是过程自身序号；resultOf 仍只引用本记录内的过程结果。记录变化增加明确的 relation-appended 增量，由实际追加生产，不以替换整个调用快照或事后 diff 代替。

关系条目保留运行父子身份、父轮次、工作位置和结果描述。已建立但未运行的子只有运行身份，不能为了得到子记录 ID 提前制造 started 或调用记录；子记录后来形成时，预设利用局部绑定的关系补充关联。不得新增全局 Context→Record 索引。

RecordingRootRecord 仍描述跨调用的实例范围。R 本次调用由单独的调用记录表达，共用 InvocationRecord 的过程与终态机制；不能把长期根记录反复结束或复用为各次调用记录。

```text
Runtime 实例范围记录
├─ R 调用记录 r1
│    └─ E 调用记录 e1 → O/A
└─ R 调用记录 r2
     └─ E 调用记录 e2 → O/A
```

记录登记和树规则应随真实直接归属调整。R 调用有自己的计时起点；通用调用边界记录不再强制依赖 executionId 或执行内计时起点。E 内的展示偏移仍可按 E 的事实和归属得到，R 在 E 建立前或结束后的过程不得借用、填造 E 身份。既有边界记录可以继续作为预设输出，但须写清描述的是工作边界还是实际交付，不能根据 Context 终态冒充成功返回。

大实体正文策略、记录正文冻结规则和错误格式化保留在记录实现中。它们不是内核所有事件的通用序列化限制。

## Service 变化消费辅助

载体无需公共基类。需要基线与增量消费的载体，可以直接提供约定结构，也可以使用配对适配器。仅查询或仅事件推送的结果，不为使用本轮辅助而伪造基线。

```ts
class SourceIncomplete extends Error {
  readonly code = 'SOURCE_INCOMPLETE';

  constructor(
    readonly sourceId: string,
    message: string,
  ) {
    super(message);
  }
}

interface SourceReceiver<D> {
  change(change: { revision: number; value: D }): void;
  incomplete(error: SourceIncomplete): void;
}

interface ObservationSource<S, D> {
  // 已失效时同步抛出 SourceIncomplete，且不留下订阅。
  open(receiver: SourceReceiver<D>): {
    baseline: {
      sourceId: string;
      revision: number;
      value: S;
    };
    close(): void;
  };
}

const source = recordSource(book);
const recordingInstallation = bindRecording(book, {
  invalidate: (failure) => source.invalidate(failure),
});
// 在允许 R 运行前，将 recordingInstallation 接入观测绑定。

const delivery = bindDelivery(source, {
  project: recordPublicView,
  send: recordConnection.send,
});
```

open 负责一致接续：返回基线对应确定来源位置，后续变化完整接上该位置。运行中的 incomplete 至多一次，之后不再接纳 change；close 幂等，不伪造失效。失效信号是接续控制信息，不增加载体 revision，也不是一条载体变化或业务声明异常。SourceIncomplete 是 Service 辅助的本地错误类型，对外只映射公开 code 与允许暴露的说明。

辅助先打开来源并把变化接纳到缓冲，再交付固定基线，随后排空后续变化。当前同进程来源可在无 await、无外部业务回调的同步边界中落实。若底层存在待分发旧事件，适配器必须先排空，或依据基线位置排除已经覆盖的变化。普通 snapshot 与 subscribe 的任意组合不自动获得此保证。

来源只给出稳定值。source listener 只入队，投影、编码、发送在消费阶段执行。关闭时解除订阅并释放连接状态，不清空载体。一处破坏性 take 只能有一个排空者，再由它分发；本轮沿用单一环境消费入口，不让消息 Feed 和观测 Feed 竞争队列。

incomplete 回调同步使本连接的消费绑定失效，不直接发送网络。尚未发送的健康基线不得继续交付，未发送增量可以丢弃，不承诺排空前缀；连接可写时发送 SOURCE_INCOMPLETE 控制信息并结束，不可写时由下一次 open 的明确拒绝表达。失效不等待普通增量全部排空。普通投影或连接错误不能反向使来源变为不完整。

来源 revision 与交付 scopeId/sequence 各自保留。一批变化不代表跨源事务；多来源基线也不自动具有跨来源原子性。必要的内核词汇与真正跨端的 DTO 进入 protocol；内部观察端口、适配器及处理函数不自动进入 protocol。

通用消费辅助先放 services/observer 的独立辅助模块，记录适配只调用公开记录 API，runtime 不反向依赖它。现有 ObservationFeed 中来源读取、固定映射、公共发送逻辑逐步拆开，TranscriptFeed 独立于是否开启记录观测。

### 失败后的完整性

isolate 允许业务继续，不表示结果仍完整。某个观察实例漏掉事实后，载体的连续 revision 只能证明其自身成功写入连续，不能证明观察输入没有缺口。

需要完整历史的记录来源由配套适配器保留完整性状态，寿命覆盖它公开的共享记录范围。失败实例停用时，绑定通过内部固定通知使关联来源失效；不要求给所有载体增加字段。多产物声明无法确定哪些产物完整时，保守使它关联的完整性来源失效。

装配顺序固定为：创建载体与长期来源适配 → 将来源失效端口接入记录观测安装 → 建立 R 与调用绑定 → 允许产生运行事实。故障关联必须早于第一次观测，不能等首次客户端订阅时才建立，否则会把此前已漏写的载体误判为完整。运行包只调用绑定提供的窄失效端口，不导入 Service 类型。

本轮默认记录来源公开一个共享范围：缺口发生后结束该范围的连续交付，后续 open 明确报告不完整。已形成的数据保留；需要读取它时，通过明确表示不完整的查询结果提供，不能伪装为健康基线或缺少条目的完整快照。未受影响的新调用仍可以产生结果，但不会清除旧缺口。

不能通过重新快照、重置游标、换 sourceId 或重新建立观察实例，宣称同一历史已经修复。需要恢复完整性的修复或重建不在本轮范围内。允许遗漏的统计来源可选择不同契约，但本轮不建设这套产品功能。

网络或单个客户端失败只结束对应消费连接，不使载体数据失效。健康来源可以按现有规则重新建立基线；观察处理漏写造成的来源不完整不能用同样规则自愈。来源不完整信号不再进入客户端自动基线重试循环。

必要同步捕获漏掉增量时，先终止受影响的连续交付；能否重新建立基线取决于源本身。若实体仍保有契约要求的完整权威状态，可以从其新基线恢复当前投影。若缺失事实本来只由观察者生成并保存，载体快照就无法补回。本轮只区分这两种已有依据，不建立通用修复器，也不把一次缓冲失败一律升级为实体历史损坏。

## 客户端与最小展示

client/runtime 只接纳公开基线、增量与明确来源状态，不读取服务端活对象。app binding 从已接纳数据形成展示结构，不猜测父层已经接纳。

默认记录详情增加关系过程，至少区分子成功返回、父接纳中、父接纳成功、父接纳失败、没有显式接纳。保留原结果与接纳后结果的区别。新的关系条目不被显示成父调用自己的 receive。

E 继续作为 QA 展示范围，R 调用不增加 QA 轮次。通过现有详情入口提供其父 R 调用及关系；概览遍历按记录种类与归属识别 E，不再假定 RecordingRootRecord 的直接孩子全是 E。

父层在异步接纳期间重连时，基线需要包含该父关系的当前事实及已完成子调用的必要关联，不能仅从“活动子调用最新事件”恢复。这也覆盖 R 正在接纳已完成 E 的阶段。已完成 E 的详细正文继续按需加载，不扩大首次加载为所有历史完整快照。

这部分是默认观测能力的集成验收。内核的第二优先目标单独通过无 Recorder 的消费者验证，不以记录和客户端存在为前提。

## 迁移顺序

| 步骤                 | 可检查的结果                                       | 本步停止条件                                         |
| -------------------- | -------------------------------------------------- | ---------------------------------------------------- |
| 1 补齐 R 运行侧      | R 声明、绑定、按次调用和子 E 关系成立              | 无记录可运行；两次调用现场隔离；E 入口和捕获时机明确 |
| 2 明确事实契约与出口 | 调用及关系事实与记录类型解耦，补齐 REOA 父关系出口 | 无 Recorder 的探针完整分辨返回与接纳                 |
| 3 建立声明与局部绑定 | 同步观察、正式依赖、独立实例、多结果与有限失败策略 | 不同来源不能误接、缺依赖被拒绝、失败按正确范围处理   |
| 4 迁移内置记录预设   | 移出直接记录接线，补 R 调用记录并调整归属和计时    | 现有记录能力保留，无隐藏 Recorder 依赖或全局反查     |
| 5 接入来源与消费辅助 | 基线接续、来源完整性、独立消息通道                 | 重连不漏不重，观测失效不冒充可通过重连修复           |
| 6 接通默认详情       | 客户端接纳关系条目并展示                           | QA仍按E展示，不从活关系对象或其他记录推测接纳事实    |

每一步形成可检查的小闭环。R 的无记录验证可以先完成；默认服务切换到新 R 结构时，必须同时具备对应记录归属、计时和消费接线，不能把运行树已经变更但记录仍假设 E 直属实例根的版本交付为可用状态。不一次性重写其他事件或客户端能力。测试中的统计和报告证明多载体能力即可，不成为额外生产交付。更名和文件拆分服从上述职责，先复用现有包与公开出口。

实施后同步更新 runtime-boundaries、exceptions、recording、observation-increments、protocol、client-runtime 和 AGENTS.md；移除已替代的 InvocationRecording 接线及记录专属 observation 类型，检查所有正式调用与资源路径。设计文档不作为兼容旧入口的理由。

## 验收矩阵

| 场景                                 | 必须成立的结果                                             |
| ------------------------------------ | ---------------------------------------------------------- |
| 无 Recorder、无观测                  | 调用、父子关系、资源和对话同步正常，不执行描述             |
| 无 Recorder、只装探针                | 能观察真实关系变化，不读取活关系对象补事实                 |
| 子已创建但未运行                     | 仅有建立关系事实，不伪造执行或返回                         |
| 子返回 2，父接纳为 4                 | 两个结果及身份、顺序明确                                   |
| 子成功，父接纳失败                   | 子成功保留，错误归父，不开始后续子项                       |
| 直接 call 成功，无显式接纳           | reception 保持 pending                                     |
| 子工作成功，终态观测 propagate       | 子 Context 成功、实际交付错误分别成立                      |
| E 工作成功，终态观测 propagate       | R→E 的 returned 保留 E 实际交付错误，R 按通用机制结算      |
| R 工作成功，终态观测 propagate       | R Context 保留成功，R.run 实际失败，Service 不发送成功完成 |
| 同一 Runtime 连续两次调用            | 两个 R Context 独立，第一次失败不污染第二次                |
| 声明两个 E，本次只选择一个           | 仅创建选中 E 的调用，未选中的节点保持惰性，不绕过声明范围  |
| E 接纳或 capture 在建立调用前失败    | 当前 R 失败，不伪造 E Context、attached 或 returned        |
| E 成功返回，R 接纳失败               | E 成功保留，R 失败，重连可以解释这两个结果                 |
| R 工作开始前取消                     | 不进入 E 接纳，不追加消息；已发生的后续取消不回滚消息      |
| R 调用记录和 E 轮内计时              | R 有独立起点和归属；E 的 QA 编号及展示语义保留             |
| 父观测 child returned 时 propagate   | 子实际返回不被改写，父停止正式后续动作，无重复 returned    |
| receiving 观测 propagate             | 接纳工作未执行，接纳终止原因明确                           |
| accepted 观测 propagate              | accepted 保留，父最终交付 error                            |
| 子声明异常被父处理                   | 正常接纳未被伪造，异常来源与父决定可关联                   |
| 原业务异常与传播型观测故障同时发生   | 原事实保留，最终为 error，不进入业务异常重试               |
| 同一 key 跨父轮次与嵌套 O            | 父轮次、子身份与顺序不会混淆                               |
| R 取得占用后发布或建立调用失败       | 占用仍释放；已建立的调用真实结算，尚未建立的不伪造         |
| 资源可用通知被隔离                   | 不重复初始化，不重复 bound/available，不伪装资源失败       |
| 两调用交错写共享实体                 | 实体顺序正确、来源分别归属、一次事实不双写                 |
| 已提交事实的必要同步捕获失败         | 可选观测仍收到该事实，最终严格失败，不回滚或重复业务       |
| 观察声明写多结果，中途失败           | 已写保留，不自动继续剩余语句，不重跑整份声明               |
| 独立观察者之一失败                   | 其余健康观察者仍消费已发生事实，传播按所属范围处理         |
| 父记录句柄未形成                     | 该记录预设的依赖子树停用，不造孤儿、不影响独立观察者       |
| 错误事件类型、缺端口、async 观察函数 | 类型或装配拒绝，不静默执行未受控工作                       |
| 记录变化发布                         | 不再次触发生成自身的记录观察者                             |
| 父正在接纳时重新连接                 | 基线包含关系，后续 accepted/failed 无缺口或重复            |
| 隔离观测失败后重新连接共享来源       | 明确不完整，不因新快照或新调用而伪恢复                     |
| 首次订阅前已漏写，或基线待发送时失效 | 不返回或继续交付健康基线，SOURCE_INCOMPLETE 不触发自动续接 |
| 编码、慢连接或客户端失败             | 仅影响相应交付，不回写工作和载体                           |

验证使用现有 Node 测试与类型检查，不接入真实模型、数据库或外部服务。前两项及父子关系用例是原第二优先项的内核验收；记录、Service 和客户端用例验证默认预设的完整可用性。

## 实施落点

- `RuntimeDefinition` 与 EOA 一样声明 `run/exceptions/observation`，通过 `children` 选择 E。`R.run` 每次建立独立 RuntimeContext 与 Invocation；Runtime 实例保留占用及稳定装配。E 入口回调收敛到 `options.execution`。
- `observation/facts.ts` 提供 CallFact、RuntimeFact 与 ResourceObservation。父层关系明确发布 attached、returned、receiving、accepted、failed；E 尚未创建时的 accept、notification、admit、capture 成败发布到父 R 的 entry 出口。无记录消费者可以直接验证这些事实。
- `defineObservation` 声明同步消费者及正式资源需求；绑定按观察窗口开放端口。`InvocationCapabilities.observations` 省略时关闭观测，显式 `[]` 启用声明且不附加预设，`[bindRecording(recorder)]` 安装记录所需的局部写端口。工作和异常处理不能申请此局部端口。
- `callRecording({input, output})` 是明确的记录声明，`RecordingInstallation` 和每调用 `RecordingCall` 持有载体关系。结构绑定通过安装提供的检查端口验证记录父声明；内核不识别此规则。无记录声明不产生空调用记录。
- 调用可能在父运行前附接子项；记录预设仅暂存此类 attached 事实，父记录建立后保留原事件序号与发生时间，展示偏移最低为零。事实生产不延后；父始终未启动则不补造记录。entry 事实不重复生成调用记录，入口产生的实体和资源变化仍由各自观测处理。
- 记录树为 RecordingRootRecord → RuntimeCallRecord → ExecutionRecord → OperationRecord/AttemptRecord；R 与 E 分别计时。边界 `scope=work` 与父层 returned 分开，`relationChanges` 与本调用 `processes` 分开。
- 当前服务采用默认 isolate。漏写使提前建立的 `RecordSource` 永久标记不完整，客户端收到 `SOURCE_INCOMPLETE` 后不自动重建同一历史；正常网络断开不损坏来源。消息实体同步独立于记录来源。
- `ChangeConsumer` 是共享捕获器唯一排空者，来源按基线水位排除重入产生的旧事件。客户端逐项接纳 R 终态及边界，父 R 仍运行时不会把已完成 E 的详情永久缓存；QA 仍按 E 展示。
- Service 的 `observation/delivery.ts` 提供结构契约 `ObservationSource/SourceReceiver` 与 `bindDelivery`。记录适配通过 `open` 委托接续、缓冲、优先失效和连接清理；Feed 只组合公开映射及独立来源的水位，不发明跨源统一 revision。该辅助不进入内核，也不要求载体继承基类。

测试覆盖入口失败、无记录运行、父子返回与接纳、重生成、观测故障隔离和传播、多个消费结果、资源窗口、来源失效、重连、真实逐条增量与客户端详情。未引入新依赖，未接入真实模型、外部服务、持久化或业务恢复。

最终验证：Node 22.23.2、pnpm 10.7.1、TypeScript 6.0.3；`pnpm check` 通过，包括全部包构建与类型检查、448 项测试、整仓格式检查。另有独立子 Agent 审查与修复验证。Vite 仍提示既有主包超过 500 kB，本轮未改变页面打包策略。
