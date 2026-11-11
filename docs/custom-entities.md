# 自定义实体：按能力接入

实体承载持续累积的信息，拥有内容、身份和更新规则；资源开放受控操作；View 组织本次使用的材料。实体可表示当前业务状态、追加材料或压缩总结，并不要求保留每个历史版本。CAPiX 把正式输入、交付和接纳固定下来，业务按能力契约接入，不必继承 `Entity` 或伪装成 Transcript、Memory。

完整离线例子见 [entities.mjs](../examples/entities.mjs)，业务对象见 [entities/domain.mjs](../examples/entities/domain.mjs)：可修订 Plan、只追加 Notes 和 Memory 共用 View、Resource 与 Node。运行：

```sh
pnpm build
node examples/entities.mjs
```

## 作者选择哪些能力

| 需求                   | 接入形式                                                                  | 不会因此获得的能力                |
| ---------------------- | ------------------------------------------------------------------------- | --------------------------------- |
| 在节点中操作业务对象   | `Resource` 加 `ResourceOffer.methods`                                     | 自动持久化、事务、幂等            |
| 交付一份不再变化的数据 | 普通被动数据；实体也可主动使用 `stableValue` 固定版本                     | 历史版本查询、对象身份保留        |
| 条件更新业务内容       | 实体自己的更新方法与准确 expected 依据；通过资源开放                      | 通用版本容器、冲突自动重试        |
| 被 View 选择和读取     | `ViewSource`，同步来源可用 `createViewSource`                             | 自动纳入、材料策略、写入权限      |
| 发布领域变化           | 自己的 `FactType` 和 `publishFact`，通过实际 `operation.facts(type)` 转交 | 自动推断因果、自动记录或公共 wire |
| 保存实体内容           | 实体自己的持久端口、编码和确认规则                                        | 跨实体或与 CP 的共同事务          |
| 恢复一次调用           | 显式 CP 点保存必要材料和依据                                              | 实体回滚、重做未知外部效果        |

这些能力互不要求。一个只被资源操作的对象不需要 View 适配；一个静态 Skill 来源不需要变化流；领域事实也可以没有 Recorder 消费。`id`、修订和状态的业务含义由实体负责，没有全局实体状态枚举。

## 同步来源适配

当前已复用的是来源读取约束。`createViewSource` 归 `capix-view`，把作者已有的单项读取组织成四个来源方法；它不负责实体内容固定或版本推进：

```ts
import { createViewSource } from '@weiliang0121/capix-view';

const source = createViewSource({
  id: notes.id,
  scope: 'whole',
  version: () => notes.version,
  keys: () => notes.keys(),
  inspect: (key) => ({ title: notes.read(key).value.title }),
  read: (key) => notes.read(key),
});

// source.index()             完整目录及摘要
// source.inspect([knownId])  只核验已知项，返回摘要
// source.read([knownId], stamp) 在准确依据下只读取这些项
// source.check(stamp)        检查依据，过期返回 false
```

这是实际公开 API。key、summary 和 value 分别推导，进入 View 后仍可按 `entry.source` 区分准确类型；输出深只读。`ViewSourceData<T>` 表达被动只读内容，不是额外的稳定值认证或持久 codec。

适配器固定身份和方法入口，对 key、重复项和被动数据进行检查；读取前后核对版本，把结果隔离为冻结内容。回调必须同步，Promise／thenable、访问器、Proxy 和活对象正文会被拒绝。合法的 `undefined` 正文或摘要保留，不能用它表示缺项。

作者仍负责三件事：

1. **来源完整性。** `keys()` 返回固定 scope 的完整目录；`inspect/read` 对缺项或 scope 外的 key 抛出 `RangeError`，不静默省略。适配器不为了验证单项而扫描目录。
2. **版本真实性。** version 覆盖内容、摘要和成员的变化，不能复用旧版本。适配器能发现读取期间的版本变化，不能发现作者修改了内容却谎称版本未变。
3. **实际操作。** 适配器不是授权或存储边界；读写权限由资源登记和窗口约束，业务更新由自己的方法完成。

`inspect/read` 不调用 `keys()`，`read` 不调用 `inspect()`。成本随本次选中项及其正文大小增长；显式 `index()` 才枚举完整目录。示例里的 Notes 采用 Map 点查，Plan 只提供一个 key；并不要求所有实体采用同样数据结构。输出隔离仍会检查被读取的正文，不能将其声称为任意大小正文的 O(1) 读取。

需要异步 I/O、批量数据库查询或专用范围规则时，可以直接实现既有 `ViewSource`，不必经过同步适配器。TranscriptViewSource 和 MemoryViewSource 继续由领域包维护。

## 材料与正在变化的实体

```text
Plan 的当前版本 ──读取──→ 固定材料 P0
       │                       │
       └──修订──→ P1           └──调用／接纳／可选 CP

View 成员 ──选择来源与 key──→ 本次材料集合
```

P0 已经取得后，实体更新为 P1 不改写 P0。Plan 只保存当前材料指向；旧材料在调用、CP 或其他持有者中仍有意义，但 Plan 本身没有自动历史仓库。单独保存 `{id, revision}` 不能证明以后还能找回正文。

View 的来源 stamp 是读取依据，View revision 是成员选择的版本，业务内容中的进度字段是业务状态，三者不是同一种状态。追加 Notes 后也不会自动增加 View 成员；需要显式 `include` 或业务策略选择。

## 可选 CP 和记录

CP 保存的是已取得的调用材料。作者声明一个恢复点，用明确的 state codec 保存材料，恢复函数消费解码后的材料；如果恢复要再次访问当前实体，还需自行声明资源和核验依据。CP 不代替实体持久化。

下面摘录组合回归中已经运行的接线，`codec` 只用于该例的纯 JSON 正文：

```js
const point = checkpointPoint()({
  name: 'materials',
  state: codec,
  references: {},
  resume: { deps: {}, run: (_work, state) => state },
});

// Scene 的 checkpoint 声明包含 point；prepare 是已登记的成员。
const state = await work.children.invoke(prepare, work.input);
work.checkpoint({ point, state });
return state;
```

`Stable` 与 JSON 不是同一值域：undefined、缺失字段和 -0 等需要保真编码。不能因为某个示例的正文可序列化，就用 JSON 保存任意 ViewIndex 或业务 metadata。恢复验证使用保存时的活动 CP 镜像，而非从已完成调用重新启动；恢复不重读实体、不重做写入、不把实体回滚到旧版本。

记录仍显式组合：资源适配通过 `operation.facts(type)` 发布领域事实，宿主的 `bindRecording(..., { fact })` 识别准确 FactType，写入业务自己的记录形状。调用关联来自实际操作，不从全局“当前调用”、实体身份或事件到达顺序推断。没有装配解释器时，资源访问仍可被观测，但不凭名称伪造领域记录。

## 验证与能力边界

- View 包测试覆盖同步约束、类型负例、版本变化与重入、缺项、undefined、被动内容和局部读取。
- [Runtime 组合回归](../packages/runtime/test/entity-chain.test.mjs) 覆盖普通可变业务状态、追加材料和 Memory；CP／记录四种开关组合都通过相同资源和真实调用路径。验证旧值不变、过期依据拒绝、准确操作关联、窗口关闭和显式恢复不重复效果。
- [仓库外消费](../scripts/release/fixtures/consumer.mjs)与[类型消费](../scripts/release/fixtures/consumer.ts)直接安装公开包验证上述接缝，不导入仓库测试夹具或外部项目源码。

现有可复用能力包括 `stableValue` 的被动数据固定、`createViewSource` 的同步读取与版本核验，以及资源窗口和类型化事实转交。实体的版本生成、条件更新、持久提交及固定写入确认仍由各自实现负责；当前没有通用版本容器或实体更新 helper。示例中的 Plan／Notes 写入代码是业务实现，不是已经交付的通用更新 API。

通用抽象应继续降低作者重复实现固定、版本与条件更新的负担。下一步需要比较实际重复代码、明确更新与失败契约后再设计复用能力；同步读取适配不能作为这些能力已完成或不再需要的结论。实体仍按能力组合，是否需要可选容器另行论证，不预设 Entity 基类。Memory 只承载压缩总结预设，提取与压缩由可替换策略完成，任意业务状态使用自己的实体。
