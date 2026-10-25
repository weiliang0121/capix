# Scene、Group、Node 与共同调用

本次结构调整将原 REOA 的位置规则与公共调用机制分开。Scene、Group、Node 表达可复用结构的角色；调用、资源、异常、输出、接纳与 checkpoint 不按三个名字各实现一套。

## 对象与切面

| 对象／切面                  | 负责什么                                         | 不负责什么                         |
| --------------------------- | ------------------------------------------------ | ---------------------------------- |
| Callable / CallableContract | 结构共有的调用配置 / 只读 I/O 签名               | 不持有一次调用的进度               |
| Composite                   | 声明可用成员                                     | 不自动遍历、调度或接纳成员         |
| Node                        | 基础可调用节点                                   | 不取得成员调用端口                 |
| Group                       | 组合成员，完成自己的整体处理                     | 不限定固定顺序、并行或模型决策方式 |
| Scene                       | 向宿主表达整体场景，自身可调用                   | 不持有入口占用，不代替驱动者       |
| CallableBinder              | 解算声明、资源申请与显式来源绑定                 | 不执行业务，不缓存当前输入         |
| CallableBuilder             | 协调完整构建，把固定接线与调用构造能力装入原结构 | 不创建本次 Context 或执行业务      |
| BuiltCallable               | 原结构完成构建后的类型，固定接线与调用构造能力   | 不是第二个结构，不持有本次 Context |
| Runner                      | 固定一个场景与资源供给，管理构建、占用和启动     | 不替业务选择成员                   |
| Invocation                  | 协调一次调用的工作阶段、控制与交付               | 不识别“对话任务”之类的业务角色     |
| CallableContext             | 本次输入、进度、终态与资源窗口                   | 不引用祖先 Context 来获取资源      |
| Work                        | 本阶段业务可用的资源与动作                       | 不暴露 Invocation 或构造绑定       |

Scene 和 Group 具有成员组合能力。Node 在类型和绑定阶段均拒绝成员声明。空 Group 仍具有组合能力，不能用成员数量判断对象种类。当前 Scene 用作宿主入口，成员为 Group 或 Node；嵌套 Scene 不在本轮范围。

`members` 是结构对象中已注册的可用成员，通过 `scene.add(group)`、`group.add(node)` 或 `scene.add(node)` 建立。`work.children` 是本次调用在当前阶段获得的子调用端口。声明中没有调用顺序；每个组合体自己的 `run` 决定何时调用成员。`invoke` 在本次父调用中完成创建、运行与接收，仍分别记录子返回和父接纳。

## 配置、构建、调用

业务先构造一个闭合的节点，再把节点组织成组合体或场景。业务配置仍存在，但不再另建一个有注册身份的 Definition 对象树。`NodeDefinition`、`GroupDefinition`、`SceneDefinition` 是普通配置类型；Node、Group、Scene 本身才是成员、uses、接纳契约和 checkpoint 引用的目标。

```ts
import { Runner, Resources, Resource, ResourceOffer, Scene, Node } from '@capix/server-runtime';

const dictionary = new Resource(new Map([['hello', '你好']]));
const lookup = new ResourceOffer({
  methods: {
    translate(words: ReadonlyMap<string, string>, text: string) {
      return words.get(text) ?? text;
    },
  },
});
const translate = new Node<string, string>().setRun((work) => work.resources.dictionary.translate(work.input), { dictionary: lookup.request() });
const scene = new Scene<string, string>().add({ translate }).setRun((work) => work.children.translate.invoke(work.input));
const resources = new Resources().register(dictionary, lookup);
const runner = new Runner(scene, resources).build();
const result = await runner.run('hello'); // 你好
```

可运行版本见 [examples/dictionary.mjs](../examples/dictionary.mjs)。

- 构造器配置和 `setDefinition` 表达同一组业务字段；`setDefinition` 全量替换业务配置，未提供的可选机制清除，已经 add 的成员保留。
- `setRun(fn, deps?, options?)` 全量替换 run 阶段。普通配置、结构字段和构建快照均使用平级 `deps / uses / run / accept`，内部不再转译成旧的 `run.execute`；高级 options 可设置 uses 和 accept。资源与动作类型从本次配置推导，不沿用上一阶段的资源类型。
- 构造器显式给出 I/O 后，需要资源时可提供第三泛型；希望资源就地推导时，用 `setRun` 或 `setDefinition`。I/O 和 Delta 属于节点固定签名，不随 setter 改变。
- `add` 仅注册可用成员，不推导顺序或自动执行。Scene 是根；每个 Group/Node 只能有一个父结构。同父重复添加不新增位置，跨父添加拒绝，不隐式移走。需要复用时共享处理函数、配置工厂或资源实体，并建立不同结构实例。
- `add` 整批检查 kind 与循环，失败不部分安装。未配置 run 的结构可以先组织，但不能绑定运行。Node 没有 add，也不能获得 children 或 receptions。
- `runner.build()` 完整成功后固定整棵结构的业务入口、机制配置、成员顺序和资源接线；之后拒绝 `setRun`、`setDefinition`、`add` 和再次构建。构建失败不留下部分可运行的结构，修正配置后可再次尝试。业务闭包与 receiver 不深度冻结，处理函数不能把本次输入、资源端点或进度写入共享字段。

构建期间整树暂时禁止配置修改及重入构建；完整声明入口先固定，再执行宿主的检查回调。原配置对象中的业务状态仍由业务持有，改变它不会重新选择已固定的函数入口。Proxy 结构和无法固定的结构字段在安装前拒绝，避免出现只有部分节点装配成功的状态。

构造器与 setter 的类型精度有明确差别：构造器的 I/O、Resources、ExceptionResources、Delta 固定，行动端口按结构 kind 检查；独立调用 `setRun` / `setDefinition` 才能从本次 uses 推导更窄的行动集合。两种入口都执行同样的运行期范围检查：run 省略 uses 表示全部已注册成员，exceptions 省略 uses 表示没有新增子行动。需要静态收窄的组合处理优先用 setter。

现有 `ChildCalls<Allowed>` 的泛型方法在显式手写某些 Work 注解时可能丢失列表的静态收窄；它不是注册或权限证明。内核仍在每次创建、启动和恢复时核验准确对象与本阶段 uses，违规不执行子处理。这里没有为构造方式调整顺带重写整个 Work 型变契约。

`defineNode/defineGroup/defineScene` 保留为同时推导资源、成员与输出增量的构造便捷函数，返回同样的 Node/Group/Scene 实例；没有第二套声明实体或转换身份表。

处理函数消费阶段 Work。成功返回保持真实引用，子返回和父接纳分别记录。注册身份、阶段行动范围、恢复引用和资源申请仍独立检查。

具名 `add({ translate })` 把同一个成员登记为 `work.children.translate`，没有第二份结构或调用身份。`add` 的返回值携带名字类型，因此使用链式写法或接住返回值；TypeScript 不会追溯修改之前变量的类型。省略 uses 可使用全部成员，显式 uses 限制本阶段端口。同签名不同对象的身份仍在运行期准确核验。名字不是 CP 身份，名称冲突、机制保留名与跨父共享会被拒绝。

宿主显式创建 `Runner(scene, resources, interactions?, options?)`。`runner.build()` 内部先由 CallableBinder 解算结构与资源接线，再由 CallableBuilder 将调用构造能力安装到原 Scene/Group/Node；返回 Runner 本身。内部 `BuiltCallable` 只是原结构完成构建后的类型，不增加 Bound 对象或平行结构树。

构建不执行按次捕获或业务，也不创建 Invocation。每次 `runner.run(input, options)` 才取得入口占用、固定本次宿主参数、捕获供给、建立 Invocation/CallableContext 并执行。`resume(contextId, options)` 与 `isRunning` 使用同一个固定场景。不同 Runner 入口各自占用，节点不会因为单父归属而被隐式串行化。

构建固定声明字段、业务方法入口及 receiver，并建立独立 CallableInvocationBuilder 作为安装归属。成员使用已完成的接线，单次调用仍由统一 Builder 建立 Context 和 Invocation；运行循环不根据 Scene/Group/Node 分派不同执行机制。Runner 从其 Scene 推导 I/O、从 Resources 推导宿主参数，不接受额外场景切换参数。未构建时不能运行。

一个结构只完成一次构建。改变业务结构或资源供应规则时，建立新结构并重新构建；可以继续使用同一消息、记忆或其他资源实体，不需要清空对话。每次输入、模型参数、文件路径与内容变化不是结构修改，按既有接线形成独立调用范围。

普通使用可以省略 Runner 的机制配置：时钟使用系统实现，观测和 checkpoint 不安装。显式安装的机制在该 Runner 内固定；需要不同安装时由宿主创建不同 Runner。注入不转移实体、记录载体或数据库的关闭责任。

## 资源与宿主接线

资源实体由宿主建立。静态绑定检查申请、唯一供给、显式来源边界与收窄规则；调用期间使用已经解算好的接线建立本次端点。

`Resources.register(new Resource(entity), offer)` 将资源实体与访问方法显式配对。`Resource` 固定实体归属，`ResourceOffer({ methods })` 只定义公开方法，内核签发受控方法端点。实体仍由宿主持有，包装不会撤销已经发生的外部副作用，也不会自动关闭实体。需要同步返回、订阅清理或固定写入凭据时，offer 使用具名的 `expose / capture / refine / timing / describe` 配置；登记方式仍可使用 `Resource(entity), offer`。低层精细适配保留窗口和凭据，不强制变为普通异步 methods。ResourceOffer 的声明统一为对象配置，不再接受位置参数构造。普通成员沿用已经捕获的供给，为本层和阶段建立自己的访问窗口。需要按次材料时，用 `resources.capture(structure, fn).register(offer, select)`；捕获由准确结构身份决定，不来自 Group 的结构种类。局部 scope 只覆盖登记的 offer，其余继承本次祖先已经收窄的供给。

必要登记、进展与输出使用独立 `callableHooks` 接入 Runner，资源捕获不兼任这些职责。恢复旧调用不重复 started；恢复中新建调用照常登记。详细供给与回调顺序见 [Runner / Resources](runner-resources-pilot.md)。

本层 Work 仅获得本阶段申请的端点。子树供给需求不扩张父 Work。固定构造绑定沿调用链传递，Context 不保存祖先或来源解析器；Builder 不保存单次输入。

进入新阶段需要新的动作资格。已签发端点不能跨越原窗口继续使用；父层终止通过固定控制关系限制在途子调用，不递归重新解算祖先的可变状态。

## 操作与接收

资源方法和具名子调用使用同一接收形状，省略 result 时保留原值，失败继续向上传播：

```ts
const content = await work.children.translate.invoke(work.input, {
  delta: (text) => work.output.emit(text), // 显式转发；不是自动加入本层输出
  result: {
    succeeded: (value) => checkTranslation(value),
    failed: (failure) => work.children.backup.invoke(work.input),
  },
});
work.observation({ event: 'translation-received', length: content.length });
return content;
```

`result` 是本次操作的接收规则，不是整个节点的异常扫描器。只执行对应的一条分支；分支回调的失败不会再次进入同一 result.failed。部分分支独立推导类型：只提供 failed 时，返回类型包含原成功类型与备用值类型。注册 reception codec 时，成功和失败接收值必须符合该契约。

子失败被处理后，原子调用仍是 failed，父关系成为 handled；成功交付接纳后成为 accepted。同一个 Error 被并行调用复用不会混淆来源。取消、越过窗口、必要捕获、CP 或强制观测故障不允许业务备用分支掩盖。资格来自内核实际失败边界，不依靠错误文本或仅凭发生阶段猜测。

资源方法没有变成子 Invocation，不制造父子接纳关系。资源的正常/异常接收使用相同处理协议，资源事实仍由资源活动记录。资源适配者可用本次 `operation.signal` 和 `operation.emit(delta)`；业务不必再次传入信号。可选 observation 投影明确选择记录什么，内核不自动保存参数正文。

Delta 消费者是被动出口，消费故障隔离；最终结果仍须通过声明的输出检查。父层选择备用来源时，已经展示的增量不会自动撤回，替换、清空或追加由明确的输出 Delta 契约表达。`work.output.emit` 是本层输出，operation.delta 是接收下层输出，二者方向不同。

业务注释使用 `work.observation({ event, ...detail })`，调用身份、序号、时间由内核补充，不能伪造 started/finished 等生命周期事实。宿主通过 `InvocationObserver.business` 读取；当前不会自动写入 Recorder 或 UI。CP 使用 `work.checkpoint?.({ point, state, refs })`，恢复点写 `resume: { deps, uses, run }`。详情见 [Checkpoint](checkpoints.md)。

一般调用使用 invoke。需要在子执行前保存 waiting CP、保留引用或在运行与接纳之间执行额外逻辑时，仍可显式 create → run → accept。Observer 原有这些恢复点不会因改成短写法而被删除。节点的高级 accept / exceptions 与有限两轮继续机制暂保留，特别是回答契约拒绝后的再次生成；普通资源/子调用的失败处理已经不需要它们。本轮没有把有凭据的轮次续接替换成无记录的 JavaScript 重试循环。

## 保留的运行边界

- 子调用返回、父层接纳与实体落实是不同事实。
- 正式接纳契约保留 V 的真实引用；codec 只用于 checkpoint。
- 局部继续仍复用本层 Context，新的子调用建立新 Context。
- 技术错误保持归属，不因业务 catch 被清除；声明异常通过独立交付错误保留准确来源。
- 结束阶段排空已开始的接纳，最终交付前等待已启动子调用退出；未启动关系不阻止结束。
- 输出增量只通过显式消费者传递，旧阶段 writer 退出后封口。
- Interaction 有独立生命周期；本地调用取消不重发或取消外部交互。

## 观测、历史与恢复

实时记录使用通用调用树和实际结构种类。对话任务的角色由服务明确标记，不能把每个 Group 都投影成 QA。任务位于深层 Group 时，详情显式携带中间祖先路径，保留子树与根之间的真实归属。旧 REOA 记录保留只读解释，不据此复原新的运行结构。

当前统一接收使用 Checkpoint Frame v5，新增失败子交付已被父层处理的事实；默认 Observer 的成员顺序、CP key/version、点和接纳契约保持。维护策略的前后两个位置使用独立结构，自定义维护的宿主恢复继续明确拒绝。Frame 保存实际调用身份、结构种类、成员位置及父接纳契约。旧 v1／v2／v3／v4 明确拒绝、不自动迁移或续接；消息、记忆和健康历史记录的读取不依赖旧 checkpoint 可以恢复。新的树结构仍要求准确直接归属、声明版本与注册位置，不能以名称、角色或相同输入代替身份。

本次不增加全局调度、自动收集执行循环、运行期能力注册、任意位置恢复或外部副作用重放。
