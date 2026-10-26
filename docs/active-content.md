# 活跃材料、准备与维护

这是 P02 的服务侧实现。正式消息由 Transcript 持有，记忆由 Memories 持有；`@capix/observer-content` 中的 ActiveView 组合 `@capix/view` 的通用成员与来源机制，说明这些既有内容中哪些值参与下一次材料准备。ActiveView 的业务策略和保存形状仍由 Observer 解释，不是内核的容量策略或通用上下文平台。

## 归属与三个时机

| 组成                            | 决定什么                                         | 不承担什么                          |
| ------------------------------- | ------------------------------------------------ | ----------------------------------- |
| Scene 的普通资源动作            | 校验服务输入、正式追加消息，取得 messageIndex    | 不维护模型容量、不替任务选择历史    |
| 任务 Group 的普通输入与来源捕获 | message/messageIndex；固定本次模型配置和原文定位 | 不隐式读取最终工作材料              |
| prepareContext Group            | 可选维护后捕获本次消息、记忆值，返回固定材料     | 不默认裁剪、不调用选择模型          |
| maintainContext Group           | 在明确边界执行注入策略、接纳决定并落实索引       | 不递归监听每一次实体写入            |
| ActiveView                      | 活跃成员、复合依据、受控 capture/apply           | 不拥有消息/记忆，不产生独立内容身份 |

```text
Scene 正式 append
  → 任务 Group 普通输入 { message, messageIndex, fileTask? }
  → prepareContext Group
      → 可选 maintainContext Group（before-request）
      → capture 固定材料
  → 决策 / 回答或文件能力
  → 正式回答、记忆收尾
  → 可选 maintainContext Group（after-content）
```

澄清结论正式落实后也可进入 after-content。前序步骤失败不会无条件执行后处理；已落实消息、回答或记忆不因后续维护失败回滚。每个合法边界调用一次，没有自动重试、递归维护或框架预设的容量压缩。

## 索引与固定值

```ts
interface ActiveViewState {
  transcriptId: string;
  memoriesId: string;
  revision: number;
  messageIndexes: readonly number[];
  memoryIds: readonly string[];
}

interface ActiveViewBasis {
  transcriptId: string;
  memoriesId: string;
  indexRevision: number;
  transcriptRevision: number;
  memorySequence: number;
}

interface ActiveViewSnapshot {
  basis: ActiveViewBasis;
  messages: readonly { index: number; message: Readonly<Message> }[];
  memories: readonly MemoryState[];
}

interface ActiveViewSelection {
  basis: ActiveViewBasis;
  messageIndexes: readonly number[];
  memoryIds: readonly string[];
}
```

索引允许非连续成员和明确顺序。成员必须真实存在且不重复；不能用名称代替记忆身份。apply 检查完整 basis，任何相关源版本或索引版本变化都会使旧决定失效；冲突返回 `ACTIVE_CONTENT_CONFLICT`。同一成员及顺序不产生新索引修订。

capture 返回冻结值，不返回以后可能读到新内容的句柄。消息正文不可变；记忆更新替换正文，因此旧 MemoryState 保留当时值。索引成员不变但记忆更新时，indexRevision 可以不变，memorySequence 仍区分新的视图内容。不能仅用索引修订判断材料相同。

新追加消息和新建记忆默认纳入；更新已有记忆不改变它当前是否活跃。退出索引不删除实体、不清空历史、不要求摘要或替代记忆。默认初始化使用当前消息段和全部已有记忆；之后正常写入纳入新增内容，不自动切段。

## 通用机制与 Observer 策略

ActiveView 的成员状态由 View 持有；实际捕获通过 `TranscriptViewSource` 与 `MemoryViewSource` 的 whole 范围读取。View 核对来源身份、范围、版本和成员，并形成固定值；ActiveView 仍负责源增量游标、新内容默认纳入、旧 basis 转换和保存格式。

自动纳入发生在源变更已正式落实后，内存同步不再单独提交第二次持久写入。显式 apply 则把通用 View 的待安装状态转换为现有 ActiveViewState，经同步持久端口提交后才安装。没有新成员的正文更新不会推进 indexRevision；相同成员与顺序也不产生保存。

`active_content` SQL 表、保存字段 `active`、准备结果与 CP 中的业务 state 均保持。通用 View 不自动纳入新内容、不定义维护阶段，也不创建来源实体。它不缓存来源端点；ActiveView 由宿主持有固定来源适配器，资源访问仍只透出当前窗口允许的 read/manage 操作。通用来源契约与一致性限制见 [View 包](view-package.md)。

## 资源与维护装配

`ActiveViewResource.read` 只提供 capture；manage 提供 capture/apply。两者在 access 时通过当前调用的受控端点访问，不在任务 Group 的来源捕获时提前读取材料。绑定供应 ActiveView 引用，业务只取得声明申请的端点。索引与必要内容同步独立于 Recorder，关闭观测不会停止索引更新。

`maintenance` 宿主配置接受普通函数，或 `{ create(): ContextMaintenanceOperation }` 工厂。输入包含 phase、当前 material 和本次 settings。普通函数适合纯数据规则；需要模型或其他能力时由工厂为 before-request、after-content 两个位置分别建立 Group，由该结构直接申请资源。两个位置不共享同一个结构实例；独立构造 MaintainConversationContent 时仍可传入只属于该维护边界的具体策略 Group。绑定解算保留子树供给；维护 Group 和准备 Group 不为透传而申请子层资源。它继续遵守 Scene/Group 可组合 Group/Node、Node 无成员的结构规则，不要求内核认识维护业务。

以下是程序化装配示例。保留最近十二条只是一项显式业务策略，**不是框架默认行为，也不保证下次请求容量充足**：

```ts
import { initializeObserver } from '@capix/observer-service/assembly';

const environment = initializeObserver(provider, [], {
  maintenance({ phase, material }) {
    const messages = phase === 'after-content' ? material.messages.slice(-12) : material.messages;
    return {
      basis: material.basis,
      messageIndexes: messages.map(({ index }) => index),
      memoryIds: material.memories.map(({ id }) => id),
    };
  },
});
```

若策略 Group 自己追加消息或更新记忆，其输入 basis 会过期；它必须通过声明的 read 资源明确取得新 basis，再返回决定。维护自身的写入不再次调度维护。基础机制不判断保留哪些材料、是否必须生成替代内容，完整请求容量由实际模型请求构造再次检查。

未配置 maintenance 时，prepareContext 直接 capture，也没有空维护节点。独立历史选择与分段辅助仍可显式组合，但默认链不通过它们隐式截断材料。

## 下游只有一份材料依据

prepareContext 返回：

```ts
{
  material, // 完整活跃快照，含复合依据
  context: { message, selectedMessages },
  selection: { historyIndexes },
}
```

`selectedMessages` 来自 material.messages，排除当前 messageIndex，保留其余全部成员及顺序。当前输入仍来自任务 Group 的正式输入，策略把它退出活跃索引不等于取消本次输入。selection 只复用既有观测索引形状，不代表额外调用了选择模型。

理解请求接收固定 history；回答/文档接收固定 context；记忆提取接收同一份固定历史和记忆，并补充本轮 QA 及真实接纳的操作结果。模型请求检查提示、Schema、正文、历史与记忆的完整容量，不跳过或截短长消息。容量估算仍是 UTF-8 字节估算，不是精确 tokenizer。

活跃索引给出的成员顺序同样是本次材料的一部分。理解、回答和记忆请求保持该顺序，不再隐式按消息索引重新排序。

任务 Group 的原文 fixedRange 继续用于定位及恢复核验，不参与材料再次装载。MessageUsage 使用窄资源核对固定材料对应的真实 Transcript 消息，避免 CP 解码值的对象身份变化造成错误计数，也不把 任务 Group 创建之后的维护追加排除在计数外。

准备、维护及相应父层关系的记录映射只保留 basis、消息索引和当时的记忆值，不重复消息正文。记忆值用于解释当时的材料，不能改读更新后的实体。实际业务输出和 CP 仍保存完整材料；自定义策略 Group 的记录内容由它自己的观测声明决定。

## 保存与恢复边界

SQLite v6 保存 active_content。源消息追加、新记忆创建及新活跃成员在同一事务中成立；显式索引决定也先同步持久化再安装内存。v5 迁移只以原当前消息段和全部记忆初始化一次，不重新激活历史归档。源写入失败不会留下只更新了一半的索引。详见 [持久化](persistence.md)。

普通重启恢复索引，供新的工作捕获。旧工作 CP 恢复则使用已保存材料，不用当前活跃索引重建原输入。Observer 的 Scene/任务 Group 契约为 version 4/6，Frame 为 v4；旧恢复格式和旧声明版本明确拒绝，历史内容仍可读取；宿主暂拒自定义维护的恢复，需先有稳定的策略配置与实现版本契约。

维护预设具有局部 waiting（子策略有 CP 时）、accepted 和 completed 点，准备预设具有等待和固定结果点。当前 ActiveView.apply 没有固定效果凭据：若索引已落实但 completed 尚未保存，较早 accepted 点发现依据变化就拒绝，不根据目标成员相同猜测完成；completed 续接直接使用已保存结果。局部预设支持不等于任意时刻、任意自定义策略都能恢复。详见 [Checkpoint](checkpoints.md)。

本轮没有增加活跃索引的 HTTP 管理/UI、后台压缩、召回、通用超限调度、跨工作并行写入或新恢复平台。类型因式分解的其他维度继续讨论，见 [讨论及实施记录](codex-type-factorization.md#14-p02-最小闭环的实施结果)。
