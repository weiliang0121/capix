# Scene、Group、Node 与共同调用

本次结构调整将原 REOA 的位置规则与公共调用机制分开。Scene、Group、Node 表达可复用结构的角色；调用、资源、异常、输出、接纳与 checkpoint 不按三个名字各实现一套。

## 对象与切面

| 对象／切面         | 负责什么                               | 不负责什么                         |
| ------------------ | -------------------------------------- | ---------------------------------- |
| CallableDefinition | 输入、输出、本体处理及可选机制声明     | 不持有一次调用的进度               |
| Composite          | 声明可用成员                           | 不自动遍历、调度或接纳成员         |
| NodeDefinition     | 基础可调用节点                         | 不取得成员调用端口                 |
| GroupDefinition    | 组合成员，完成自己的整体处理           | 不限定固定顺序、并行或模型决策方式 |
| SceneDefinition    | 向宿主表达整体场景，自身可调用         | 不持有入口占用，不代替驱动者       |
| CallableBinder     | 解算声明、资源申请与显式来源绑定       | 不执行业务，不缓存当前输入         |
| BoundCallable      | 持有固定接线和惰性成员结构             | 不持有运行中的 Context             |
| Driver             | 提供绑定入口，按绑定结构管理占用和启动 | 不替业务选择成员                   |
| Invocation         | 协调一次调用的工作阶段、控制与交付     | 不识别“对话任务”之类的业务角色     |
| CallableContext    | 本次输入、进度、终态与资源窗口         | 不引用祖先 Context 来获取资源      |
| Work               | 本阶段业务可用的资源与动作             | 不暴露 Invocation 或构造绑定       |

Scene 和 Group 具有成员组合能力。Node 在类型和绑定阶段均拒绝成员声明。空 Group 仍具有组合能力，不能用成员数量判断对象种类。当前 Scene 用作宿主入口，成员为 Group 或 Node；嵌套 Scene 不在本轮范围。

`members` 是定义中的可用成员。`work.children` 是本次调用在当前阶段获得的子调用端口。声明中没有调用顺序；每个组合体自己的 `execute` 决定何时创建、运行与接纳子调用。

## 声明、绑定、运行

```ts
import { Driver, defineScene, defineGroup, defineNode } from '@capix/server-runtime';

const length = defineNode<string, number>()({
  run: { execute: (work) => work.input.length },
});

const measure = defineGroup<string, number>()({
  members: [length],
  run: {
    async execute(work) {
      const child = work.children.create(length, work.input);
      await child.run();
      return child.accept();
    },
  },
});

const scene = defineScene<string, number>()({
  members: [measure],
  run: {
    async execute(work) {
      const child = work.children.create(measure, work.input);
      await child.run();
      return child.accept();
    },
  },
});

const driver = new Driver();
const boundScene = driver.bind(scene, {
  providers: [],
  source: { capture: () => undefined },
});

const result = await driver.run(boundScene, 'CAPiX', {}); // 5
```

处理函数消费阶段 Work。成功返回保持真实引用，子返回和父接纳分别记录。注册身份、阶段行动范围、恢复引用和资源申请仍独立检查。

宿主显式创建 Driver。Driver 固定时钟、观测和 checkpoint 等机制接入，`bind` 委托 CallableBinder，返回归属于此 Driver 的 BoundCallable；`run` 和 `resume` 显式接收该绑定结构，不保存“当前场景”。每个绑定入口独立占用，`isRunning(boundScene)` 查询该入口；其他 Driver 或直接由 Binder 创建的结构不能混入。

绑定提前解算声明树并固定函数入口，保留业务方法 receiver。每次 bind 建立独立构造安装，统一 Binder 惰性建立成员的 BoundCallable；统一 Builder 为每次调用建立 CallableContext 和 Invocation。调用循环消费同一个工作契约，不根据 Scene／Group／Node 分派执行流程。每个绑定的 I/O 与宿主参数类型独立保留，Driver 本身不绑定一种业务签名。

普通使用可以省略 Driver 的机制配置：时钟使用系统实现，观测和 checkpoint 不安装。显式安装的机制在该 Driver 内固定；需要不同安装时由宿主创建不同 Driver。注入不转移实体、记录载体或数据库的关闭责任。

## 资源与宿主接线

资源实体由宿主建立。静态绑定检查申请、唯一供给、显式来源边界与收窄规则；调用期间使用已经解算好的接线建立本次端点。

根入口取得一次来源。普通成员沿用已经捕获的供给，为本层和阶段建立自己的访问窗口。宿主可以通过准确的声明身份注册新的捕获边界；例如 Observer 的对话任务 Group 在建立时固定本次模型配置。该规则来自显式绑定，不来自 Group 的结构种类。

本层 Work 仅获得本阶段申请的端点。子树供给需求不扩张父 Work。固定构造绑定沿调用链传递，Context 不保存祖先或来源解析器；Builder 不保存单次输入。

进入新阶段需要新的动作资格。已签发端点不能跨越原窗口继续使用；父层终止通过固定控制关系限制在途子调用，不递归重新解算祖先的可变状态。

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

Checkpoint Frame v4 使用实际调用身份、结构种类、成员位置及父接纳契约。旧 v1／v2／v3 不自动迁移或续接；消息、记忆和健康历史记录的读取不依赖旧 checkpoint 可以恢复。新的树结构仍要求准确直接归属、声明版本与注册位置，不能以名称、角色或相同输入代替身份。

本次不增加全局调度、自动收集执行循环、运行期能力注册、任意位置恢复或外部副作用重放。
