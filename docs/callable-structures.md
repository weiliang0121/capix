# Scene、Group、Node 与共同调用

状态：2026-10-25，统一操作模型、独立结构包与共同契约。结构持有配置，`run` 组织操作，Invocation 协调本次活动与真实交付。当前契约替代此前的 setter、独立接纳阶段及调用级异常声明，迁移范围见 [全仓迁移](callable-operation-migration.md)，包边界见 [结构包](structure-package.md)。

## 对象与切面

| 对象／切面                       | 负责什么                                   | 不负责什么                          |
| -------------------------------- | ------------------------------------------ | ----------------------------------- |
| Callable / CallableContract      | 结构公共配置 / 只读 I/O/Delta 签名         | 本次输入或进度                      |
| Composite                        | 登记可用成员与名字                         | 自动遍历或调度                      |
| Node                             | 直接处理                                   | 成员调用端口                        |
| Group                            | 组合成员，实现自己的整体处理               | 限定顺序、并行或决策方式            |
| Scene                            | 向宿主表达整体场景，自身也可调用           | 入口占用                            |
| Resources / Interactions         | 固定资源供给 / 可选交互登记                | 本次调用状态                        |
| CallableBinder / CallableBuilder | 解算接线 / 完整构建后安装到原结构          | 执行业务或捕获本次输入              |
| Runner                           | 固定场景、资源与机制，管理构建、启动和占用 | 替业务选择成员                      |
| Invocation / CallableContext     | 本次活动协调 / 本次语义状态                | 可复用业务结构                      |
| Work                             | 业务在当前窗口可用的输入与操作端点         | 内部 Invocation、Context 或绑定对象 |

`@capix/structure` 持有结构及作者配置，`@capix/contracts` 持有两侧共用的端口；运行装配、Invocation 与恢复实现由 `@capix/server-runtime` 提供。Runtime 根入口重导相同结构对象，既有导入不产生第二套类或身份。

Scene 和 Group 具有成员组合能力，Node 在类型和构建检查中都拒绝成员。Scene 用作根，Group/Node 是合法成员。空 Group 仍是组合体。结构共享处理函数和资源实体，一个 Group/Node 实例只占据一个父位置；重复加入同一父去重，跨父共享和循环拒绝。

## 配置、构建、调用

```ts
import { Scene, defineNode } from '@capix/structure';
import { Runner, Resources } from '@capix/server-runtime';
import { Resource, ResourceOffer } from '@capix/resources';

const dictionary = new Resource(new Map([['hello', '你好']]));
const lookup = new ResourceOffer({
  methods: {
    translate(words: ReadonlyMap<string, string>, text: string) {
      return words.get(text) ?? text;
    },
  },
});
const translate = defineNode<string, string>()({
  deps: { dictionary: lookup.request() },
  run: (work) => work.resources.dictionary.translate(work.input),
});
const scene = new Scene(translate);
const resources = new Resources().register(dictionary, lookup);
const runner = new Runner(scene, resources).build();
const result = await runner.run('hello'); // 你好
```

可运行版本见 [dictionary.mjs](../examples/dictionary.mjs)。作者可以用构造器传完整配置，也可以先构造、逐项赋值，再注册成员。两个入口表达同一组字段：可选 name/label/source、deps、run、output、checkpoint。赋值只改变指定字段，没有整份配置替换或隐式清空语义。

`Node<Input, Output, Resources, Delta>`、Group、Scene 保留相同的四个类型参数。资源从明确的第三泛型检查；需要就地推导 deps/成员/Delta 时用 `defineNode/defineGroup/defineScene`，它们创建同一个结构类型，不建立平行 Definition 树。`*Definition` 是普通配置类型。类子类和函数工厂都可使用，内核不要求继承组织业务。

`new Scene(child)` 显式配置单子委托，推导本层 I/O 并沿正常 invoke 接纳最终结果；不继承子资源申请、增量声明或 CP。后续 add 不改变该目标，build 前仍可配置同签名 run。

`add` 只登记成员，不自动调用。普通 run 可以操作所有已登记成员，无需重复写 uses；同签名未登记对象仍被准确身份检查拒绝。`add({translate})` 的返回值携带名字类型；接住返回值后，后续赋值的 run 可直接使用 `work.children.translate`。名字便于访问，不是恢复身份，也不能覆盖保留的机制方法名。

结构包可以独立构造并检查成员关系，构造与 add 都不执行业务。Runtime 使用结构包 `/construction` 的配置状态端口协调全树构建；具体接线和构造能力不进入结构包。

`runner.build()` 提前解算全树，检查资源供给、成员、输出和 CP，完整成功后将固定接线及调用构造能力安装到原结构。固定函数入口、配置容器和成员位置，保留业务 receiver 及闭包；没有 BoundCallable 或第二棵结构树。build 不捕获本次资源、不执行业务、不创建 Context。

成功后配置字段不可赋值、成员不可新增、不可再次 build；失败不发布部分运行能力，允许修正后重建。构建期间拒绝 add/重入，检查解释字段是否被宿主回调修改；Proxy 结构和不能固定的字段也被拒绝。业务不能把单次输入、Work、资源端点或进度存在共享结构字段。需要改变结构或供应规则时建立新结构，仍可复用原有独立实体。

宿主使用 `new Runner(scene, resources, interactions?, options?).build()`，build 返回原 Runner。`runner.run(input, options?)` 创建一次调用，`runner.resume(contextId, options?)` 进入明确恢复点；`runner.isRunning` 表示这个 Runner 的入口占用。普通运行只执行一次 run；业务的循环或备用来源由 run 显式组织，每次子调用都有新身份。

Runner 自身提供输出消费与当前运行控制，不要求宿主建立另一个 Run 对象：

```ts
const unsubscribe = runner.output.subscribe({
  receive(event) {
    if (event.kind === 'delta') console.log(event.delta);
  },
});

const result = await runner.run(input);
// 需要停止正在执行的调用时：runner.cancel(reason?)
unsubscribe();
```

订阅持续到解除或接收器失败，可以跨多次 run/resume；只接收 Scene 根输出，不自动收集所有子输出。Result/Delta 直接从 Scene 推导，不额外经过资源 Options 或 callableHooks。订阅不缓存历史，中途加入从下一条事件开始；事件保留 contextId/round/sequence，并新增 entryId 标识本次入口请求。恢复保留原 contextId，并开始本次新的输出段，entryId 则每次重新生成。接收器同步返回 undefined；同步抛错或返回 Promise 会停用该订阅并隔离故障，其他订阅和执行继续。输出 completed 表达输出段完成，最终交付仍以本次 Promise 为准。

运行观察使用并列的只读出口：

```ts
const stopObserving = runner.observation.subscribe({
  receive(event) {
    if (event.source === 'entry' && event.fact.kind === 'settled') {
      console.log(event.entryId, event.fact.status);
    }
  },
});
```

事件为 `{runnerId, entryId, source, fact}`，source 区分入口、调用、资源、CP 和业务注释。只提供固定元数据与有界诊断，不带输入输出正文、Frame、活实体或资源 describe；业务注释只取事件名。订阅不安装 Recorder、不重建场景，也不回放历史；无人消费时跳过投影，后来仍可订阅。建立前失败与忙碌拒绝也有自己的 entryId；attached 关联实际根调用，settled 在包括严格释放观察在内的交付处理后报告最终状态。恢复从独立 CP 反馈路径取得事实，不伪造普通调用重新开始。

entryId 仅关联反馈，不是公开 Run 对象、submissionId、恢复地址或幂等凭据。独立交互晚到反馈仍由交互自身提供。端口边界与实现见 [运行出口](runtime-ports.md)。

`runner.cancel(reason?)` 请求取消当前运行；新发出请求返回 true，空闲或已取消返回 false。它不解除输出订阅、不取消独立 Interaction，也不提前释放未退出的业务。每次入口使用独立取消控制，结束时解除外部 signal 监听；外部信号与 Runner 取消按首次来源生效。宿主 options 保留原 signal，实际 Work 使用本次有效控制信号；外部导致的准确取消在 Runner 交付边界仍归属原外部 signal，不改变业务错误或复合故障。连续运行及释放回调中的重入不会继承上一轮取消状态。

可运行示例见 [runner-output.mjs](../examples/runner-output.mjs)。

## 资源和操作接收

`Resources.register(new Resource(entity), offer)` 将实体与公开方法配对。Resource 不转移实体的关闭责任，offer 不自动授予所有节点权限；Work 只取得本层 deps。`ResourceOffer({methods})` 的方法取得 source、业务参数和本次 operation 控制端口，内核签发受控资源方法。

固定实体外，需要按次材料时用 `resources.capture(structure, fn).register(offer, select)`。局部 scope 仅覆盖登记的 offer；其余继承本次已收窄供给。`resources.refine` 根据准确子输入收窄资源，资源自行检查不可扩大。捕获位置与 kind 无关，子树供给需求不扩张父 Work。同步返回、订阅清理或固定写入凭据仍可使用低层 expose/capture/refine/timing，不能为统一外观丢掉真实时序和凭据。

资源方法和子调用共用操作接收形状：

```ts
const content = await work.children.translate.invoke(work.input, {
  delta: (part) => work.output.emit(part),
  result: {
    succeeded: checkTranslation,
    failed: (failure) => work.children.backup.invoke(work.input),
  },
});
work.observation({ event: 'translation-received', length: content.length });
return content;
```

成功默认保留原引用，失败默认继续交付。只执行对应分支；回调失败不再次进入同一 failed。只提供 failed 时，返回类型保留原成功类型与备用值类型。`result` 是这一次操作的接收，不是全节点错误扫描器；取消、越界、必要捕获、CP 和严格观测失败不允许 fallback 掩盖。

子成功返回与父 accepted 分开；子失败经 failed 处理后仍 returned failed，父关系记 handled。资源方法不变成子 Invocation，仍用资源事实表达。输出 delta 的消费故障隔离；生产者 output.result/output.delta 负责验证最终值和增量，消费侧 result/delta 负责这次接收，两者不混用。

`work.output.emit` 发出本层增量，操作的 delta 接收下层增量，需要明确转发。切换备用来源不会自动撤销已经显示的预览，替换、丢弃和正式输出要有明确协议。

## Group 预设与公共申请

Sequence 以 `new Sequence([node, {node, input?, result?, delta?}, …])` 一次配置固定推进，默认传递前一步接收值，末步作为整体结果。复杂回调用参数标注或 satisfies SequenceStep 提供类型，构造核验完整链路。Dynamic 以 `new Dynamic({options, decide, maxSteps?})` 一次配置候选及决策成员，整体I/O由决策输入与finish分支推导；决定通过类型关联的call/finish表达，默认最多8个候选动作。两者复用普通 Group、真实子调用与失败接收，不改变内核位置或运行机制。

`withDependencies(common)` 的 node/group/scene 工厂在配置处理函数时就合并公共申请，供给仍显式由 Resources.capture/register 兑现，不在运行期追加未知字段。共享材料是普通资源，每次 Group 调用可有独立材料，各成员取得自身窗口的端点。预设当前不自动保存或恢复材料，也不自动建立 CP。API 与迁移差异见 [结构包](structure-package.md)，可执行例子见 [presets.mjs](../examples/presets.mjs)。

## Work、观测与恢复

普通 CallableWork 只有 input/resources/signal、组合体 children、可选 output、checkpoint 和 observation。没有普通 round/initialInput/continuation、return/continue/unhandled 或独立异常阶段。资源与子调用端点随当前调用/恢复窗口有效，窗口关闭后不可复用；父子活动约束不重新解算祖先的可变配置。

`work.observation({event,...})` 是业务事实，内核补充身份、时间与序号；它不能伪造生命周期。宿主通过 observer.business 消费，默认不写入 Recorder/UI。生命周期和资源观测由机制发布。结构没有 observation 消费者配置；宿主的 ObservationInstallation.declarations 在 build 时选择声明并固定到接线。记录使用 `bindRecording(...).describe(structure, projection)` 登记描述、角色和脱敏规则。

输入转换使用普通业务函数，不再有 InvocationEntry/defineChildEntry 或 children.entry。转换本身不是受控端点；实际 create/invoke 与资源操作各自检查活动窗口。

通常使用 invoke。需要“创建→保存 waiting CP→启动/接收”的边界时，可用 create→checkpoint→call.invoke；需要更细中间步骤时保留 create/run/accept/open/facts。ChildCall.invoke 的接收选项不能晚改创建时已经固定的 output/delta/key。

恢复点使用 `work.checkpoint?.({point,state,refs})`，checkpoint 配置含 key/version、codecs、points 和可选 receptions。具名 reception 是恢复编码契约，属于 checkpoint；普通接收不要求它，也不增加全节点 accept 阶段。恢复点的 resume.deps/uses 明确当前恢复行动，ResumeWork 保留历史事实查询接口。Frame v5 仍可读取历史诊断格式，但新运行只有一轮；旧 round 2/continuation 执行恢复明确拒绝。详情见 [Checkpoint](checkpoints.md)。

保留的边界是：返回、父接纳、实体落实和 CP 提交各自独立；接纳排空后才关闭窗口；最终交付等待已启动子调用退出；未启动关系不阻塞；不自动接纳或停止兄弟。Interaction 独立生存，本地取消不重发请求、不取消外部发送。记录和恢复不能替代实体自己的固定效果凭据。

当前没有配置热更新、动态注册、全局调度、任意位置恢复或外部效果自动重放。
