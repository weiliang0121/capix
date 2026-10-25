# 资源包与调用装配边界

`@capix/resources` 独立提供资源定义、登记、固定接线和本次访问。Runtime 使用资源包打开端点，再把端点交给 Work；阶段选择、恢复和调用退出属于 Runtime。

```text
Resource + ResourceOffer
          │ register
          ▼
       Resources
          │ bind(deps)             固定登记与申请的对应关系
          ▼
    ResourceBinding
          │ open(owner)            每次建立访问
          ▼
     ResourceAccess ───────────→ endpoints
          ▲                         │
          │ 检查本次窗口             │ 操作委托
          └──── ResourceActivity ←──┘
                      │
                作者资源方法
```

## 对象与归属

| 对象                                 | 所属                     | 职责与寿命                                                    |
| ------------------------------------ | ------------------------ | ------------------------------------------------------------- |
| Resource                             | resources                | 包裹宿主持有的原实体，不冻结实体状态、不接管实体生命周期      |
| ResourceOffer                        | resources                | 固定资源操作方法、捕获、收窄及描述；签发申请                  |
| ResourceRequest                      | resources                | 类型化身份引用，不查找供给或保存端点                          |
| Resources                            | resources                | 登记 Resource 与 Offer，按 deps 建立固定接线                  |
| ResourceBinding                      | resources                | 固定申请与供给入口；每次 open 建立独立访问，不回查可变注册表  |
| ResourceProvider                     | resources                | 从宿主来源取得材料，固定选取函数                              |
| ResourceSupply / ResourceSupplyEntry | resources                | 持有已选定的材料入口；同一捕获可供不同子树或窗口使用          |
| ResourceAccess                       | resources                | 持有一个不可重新打开的访问窗口，以及本窗口的端点缓存          |
| ResourceActivity                     | resources                | 一个窗口共享的操作执行机制；操作状态各自局部保存              |
| ResourceEndpointActivity             | resources                | 为精确 expose 固定当前资源身份，委托同一 Activity，不另建窗口 |
| ResourceOwner                        | resources 定义，宿主实现 | 调用来源、有效性检查、故障策略、信号与事实出口                |
| Resources / CapturedResources        | runtime                  | 组合资源登记与结构作用域、成组捕获、收窄和 Interaction 接线   |
| ResourceInstallation                 | runtime                  | 解算结构供给路线，为本次调用建立固定材料供给                  |
| InvocationResources                  | runtime                  | 选择调用阶段与轮次的窗口，连接 owner，关闭阶段和调用访问      |
| ResourceRecord                       | runtime/recording        | 资源事实的可选记录投影                                        |

资源包不导入 Scene、Callable、Invocation、Context、CP、Recorder 或 Interaction。访问窗口不递归查询祖先调用，不因父层状态改变重新解算申请。

## 独立使用

```js
import { Resource, ResourceOffer, Resources } from '@capix/resources';

const lookup = new ResourceOffer({
  methods: {
    translate(dictionary, word) {
      return dictionary.get(word) ?? word;
    },
  },
});
const resources = new Resources();
resources.register(new Resource(new Map([['hello', '你好']])), lookup);

const binding = resources.bind({ dictionary: lookup.request() });
const access = binding.open();
try {
  const result = await access.endpoints.dictionary.translate('hello');
} finally {
  access.close();
}
```

`bind` 核对全部 deps 并固定登记快照，不捕获材料或执行资源方法。由登记建立的 Binding 每次 open 取得新的捕获；`ResourceBinding.fromSupply(deps, supply)` 则显式复用已经建立的供给，适合调用的不同阶段或已收窄子树。两者建立相同的 ResourceAccess。

ResourceOffer 有独立 UUID `id`；`name` 用于解释和既有资源观测，不承担唯一性约束。申请和供给仍按准确的 Offer 身份匹配，复制 UUID 或名称不能伪装为原申请。同一 Offer 的不同 deps 别名在一个窗口中取得相同端点；不同窗口不共享端点。

`ResourceSupplyEntry.readMaterial()` 只返回材料。端点由 `entry.offer.createEndpoint(material, activity)` 建立，ResourceRequest 不再通过同名 `get/read` 混合材料和端点。普通 methods 的建立仅生成包装，首次调用才执行作者方法；精确 expose 仍支持同步值、订阅及固定写入凭据。

## 操作与访问窗口

普通方法只按需接收第三参数 `{ signal, emit }`。`signal` 供资源适配协作取消，`emit` 发布本次操作增量；方法返回后 emit 永久失效。业务端通过 `delta/result` 接收，不取得原始实体或 Activity。

```text
检查窗口 → 发布 started → 再检查 → 执行资源方法
                                      │
                                 固定 Outcome
                                      │
                            发布真实 returned / threw
                                      │
                                 检查访问资格
                                      │
                             succeeded / failed 接收
                                      │
                           再检查 → 返回接收结果
```

方法失败和结果接收失败有独立边界：回调错误不再次进入同一个 failed。业务成功处理普通失败时，不把共享窗口标记为失败；取消、必要捕获、窗口关闭、严格观测等机制故障不可通过 fallback 转成成功。

窗口关闭以后，已开始的操作仍可能真实完成。保留真实返回事实，然后拒绝新接收；如果方法失败同时窗口失效，保留两个原因。异步接收回调正在等待时关闭，也会拒绝它后续的资源访问和最终结果。增量消费者是被动预览，失败仅停用本次消费。

`close()` 只结束访问资格，幂等且不可重新打开；不调用原实体的 close，不回滚外部效果，不自动取消独立 Interaction，也不保证排空未 await 的资源操作。宿主应使用 `try { return await execute(...) } finally { access.close() }`，避免在异步工作完成前关闭。

## Runtime 接入

场景宿主仍从 `@capix/server-runtime` 取得 Resources 和 Runner。这个 Resources 负责结构范围的组合登记，并使用资源包的 Provider、Supply、Binding 与 Access；业务结构不接触这些装配对象。

```js
import { Resource, ResourceOffer } from '@capix/resources';
import { Scene, Node, Resources, Runner } from '@capix/server-runtime';

const dictionary = new ResourceOffer({
  methods: {
    translate(origin, word) {
      return origin.get(word) ?? word;
    },
  },
});
const translate = new Node({
  deps: { dictionary: dictionary.request() },
  run: (work) => work.resources.dictionary.translate(work.input),
});
const scene = new Scene().add({ translate });
scene.run = (work) => work.children.translate.invoke(work.input);
const resources = new Resources();
resources.register(new Resource(new Map([['hello', '你好']])), dictionary);
const runner = new Runner(scene, resources).build();
await runner.run('hello');
```

可运行版本见 [dictionary.mjs](../examples/dictionary.mjs)。

`InvocationResources` 持有调用侧阶段选择，依据已有供给打开 ResourceAccess；切换阶段、CP 恢复和调用退出明确关闭相应窗口。供给与窗口分开：恢复或收窄仍依据固定材料，不能借父层供给扩大 Work 的 deps。观测处理也取得本次窗口，处理返回后关闭，不复用已失效端点。

`@capix/resources/operation` 提供 OperationOutcome、Reception、OperationOptions、OperationResult 和 receiveOperation。子调用共用这组正常／异常接收契约，实际子接纳、关系归属和 CP 留在 Runtime。

## 宿主故障接缝

资源包不能识别任意宿主的错误类。有 owner 的访问必须提供完整策略：

```ts
interface ResourceFailurePolicy {
  isProtected(error: unknown): boolean;
  isCancellation(error: unknown, signal: AbortSignal): boolean;
  describe(error: unknown): unknown;
}
```

打开访问前校验并固定策略函数和 receiver；失效 owner 不能先触发材料捕获。策略判定抛错或返回非法值属于机制失败，保留原操作错误；非法异步判定的迟到拒绝也被消费。validate、故障报告、接纳来源和观测端口同样要求同步完成；保留 void 回调的普通同步返回值，异步返回会被拒绝并消费迟到拒绝。ResourceAccessClosed 和 ResourcePortError 在资源包及 Runtime 中均属于受保护故障，包含在 AggregateError 中也不能进入业务 fallback。Runtime 提供自己的策略，Runner 使用者不必配置它。

无 owner 的独立访问没有调用归属，仍受本地窗口控制；它不能替其他宿主判断控制错误。`ResourceOwner` 的 transcript/memory 事实端口暂以 protocol 类型保留，不为这两处关联新增通用事件注册机制。

## 验证范围

验证包括：独立包链路与类型拒绝、固定登记、每次捕获、同一窗口别名、不同窗口隔离、关闭后晚到返回、接收回调重入与关闭、并发增量、严格观测、同步端点、跨作用域收窄，以及 Runtime CP、固定效果和交互生命周期回归。资源包与生成声明无 Runtime 反向依赖；不把未 await 操作的访问关闭误称为后台任务完成。
