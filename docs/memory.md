# 记忆体与记忆记录

## 当前串行运行链路

```text
正式输入 + ActiveContent → prepareContext O（可先维护）→ 固定消息 / 记忆材料
固定材料                 → 决策 / GenerateAnswerDefinition → 正式回答
固定记忆 + 本轮 QA + 固定历史 + 已接纳的保存凭据 → ExtractMemoryDefinition → 记忆落实
已落实内容               → 可选 after-content 维护 → 下次准备时捕获
```

E 的准备 O 在可选维护之后捕获活跃消息及记忆值。该输出是本次理解、回答和提取的唯一基础材料，不从 E 建立时的旧固定范围或当前实体再次装载。记忆正文已有不可变语义，后续 Memory.update 不会改写已经捕获的内容；当前工作继续使用原快照，下次准备才读取届时活跃的内容。材料不从记录恢复或查询。

默认 `prepareContext` 输出 `material/context/selection`；其中 selection 只为观测保留实际材料索引，不表示运行了模型筛选。理解请求接收固定 history，回答接收固定 context，提取使用同一份历史与记忆，并加入本轮正式 QA 和已接纳结果。所有请求检查完整实际材料的容量，不自动分段、截断或丢弃记忆；超限明确失败。显式维护策略可让消息或记忆退出活跃索引，不要求生成替代内容，也不删除实体。详见 [活跃材料与维护](active-content.md)。

## 两种对象

Memory 是当前可消费的理解。它有持续身份及原文归属；正文更新保持同一个实例和 ID。内部当前内容为不可变值，通过 update 一次替换，不允许外部零散改写。

```ts
Memory {
  id: string;
  transcript: Transcript;
  topic: string;
  content: string;
  sourceIndexes: readonly number[];
  sourceResults?: readonly MemoryResultSource[];
}
```

MemoryRecord 是本次已经落实的变化，继承 BaseRecord。记录自身有独立 ID，正文生成后不可改写。

```ts
MemoryRecord extends BaseRecord<{
  action: 'create' | 'update';
  change: string;                  // 本次明确发生了什么，不从两份正文推断
  sourceIndexes: readonly number[]; // 本次变化依据
  sourceResults?: readonly MemoryResultSource[]; // 本次采用的已接纳操作结果
  result: MemoryContent;           // 落实之后的完整内容快照
}> {
  memoryId: string;
  executionId?: string;            // 有记录的调用来源：ExecutionRecord.id
  operationId?: string;            // 有记录的调用来源：OperationRecord.id
}
```

例如同一个 M：第一次创建预算200元，第二次改为150元。M 的当前正文是150元；记录A保存创建说明和200元快照，记录B保存“200改为150”的说明及150元快照。变化说明由本次处理明确给出，不在观测时猜测。记录按实际登记顺序查询，不保存前后指针。

记忆体没有关系数组；“记忆之记忆”本轮不设计。topic 是可变场景名称，不是身份，也不以字符串相同自动合并记忆。

## 提取与落实

```text
准备固定材料 → 决策 / 组装 → 生成 → 追加正式 assistant 消息
                         ↓
固定活跃记忆 + 本轮 QA + 固定历史原文 + 本轮已接纳保存结果（如有）
                         ↓
ExtractMemoryDefinition
  → PrepareModelRequestDefinition：准备请求并检查容量
  → RequestModelDefinition：通过 A 发起/读取模型交互，保留原始返回
  → AcceptModelOutputDefinition：解析与整批接纳
  → ApplyMemoryDefinition
      ├─ Memories.apply 审查、创建/更新并发布当前事实
      └─ 可选记录预设消费事实并登记 MemoryRecord
```

输出示例：

```json
{
  "memories": [
    {
      "action": "update",
      "memoryId": "已有记忆体ID",
      "change": "聚餐预算从200元改为150元，其余条件不变",
      "sourceIndexes": [4],
      "result": {
        "topic": "聚餐安排",
        "content": "周日晚上，北京海淀，人均150元，清汤涮羊肉，不吃辣。",
        "sourceIndexes": [0, 4]
      }
    }
  ]
}
```

创建使用 action=create、memoryId=null；无需变化则返回空数组。最多四项。更新必须引用当前可见、同 Transcript 的记忆 ID，同批不能重复更新一个目标。本次依据至少包含一条本轮消息，完整内容依据必须包含本次依据。本次依据必须是可见原文；更新的 result.sourceIndexes 还可以保留该目标记忆的已有来源，不借用其他记忆的未加载来源。Schema 在提示词中声明，并有对应本地检查，不是供应商强制 Schema 输出。

接纳先检查候选结构、目标与引用合法性，以及原始候选是否重复更新同一 ID。若 update 的 result 与本轮旧记忆的 topic/content/sourceIndexes 完全相同（索引顺序也相同），将其作为无操作过滤，不要求它额外引用本轮消息，不修改 Memory 或新增 MemoryRecord。是否无变化不依据 change 的文字，不做语义相似判断；正文、主题或来源发生变化时仍必须提供本轮依据。未知引用、正文依据不包含变化依据等错误不能借无操作绕过。剩余变更整批检查通过后才落实，仍不接受部分有效批次。

模型原始候选保留在 RequestModelDefinition 的返回记录；独立 Interaction 也保存未经业务解释的 ModelOutput。AcceptModelOutputDefinition 保留实际接纳的变更，ApplyMemoryDefinition 成功后返回这些变更作为操作最终输出。因此可以核对哪些候选被过滤，以及失败发生在接纳还是落实，不新增跳过事件。未增加错误反馈或自动重试。

## 已接纳的保存结果

文件能力返回真实创建凭据，E 经子调用接纳后保存到本轮 `state.saved`。进入记忆提取时，服务从该凭据复制一份 `MemoryResultSource`，给它一次生成的来源 ID；提取输入的 `results` 提供这些值。不从调用记录、客户端投影、候选路径或助手文本反推文件创建。

```ts
MemoryResultSource {
  id: string;                  // 来源值身份，不是记录 ID
  kind: 'file-created';
  answerIndex: number;          // 此 Memory 所属 Transcript 内的回答位置
  receipt: { path; bytes; digest };
}
```

`answerIndex` 说明来源关联到哪次回答，不把回答文本当成文件创建凭据。凭据只证明当时创建了对应字节；以后文件可能被删除或修改，再次操作必须按当时环境检查。来源值只保存不可变数据，不持有文件句柄或调用实例。

模型在变更及 `result` 中分别使用可选 `sourceResultIds` 引用来源，不能返回或重写凭据。变更引用只能来自本次 `results`；完整结果还可继承目标记忆已有来源，不能借用其他记忆的来源。接纳端将 ID 解析为对应真实 `sourceResults`，变化所用来源必须完整包含于结果中。未知、重复或不在允许集合的 ID 拒绝整批提案；继承旧来源不表示本轮重新访问了文件。无操作比较包含结果来源，因此新增来源本身也属于变化。

本轮保留原有 `sourceIndexes` 及本轮消息依据规则，结果来源作为补充，不设计脱离消息的纯操作记忆。Memories 在统一落实入口校验来源结构、回答位置、变化依据包含关系以及同一来源身份不可改写，并复制冻结正文。来源所述操作是否确实发生，由传入已接纳结果的服务契约保证；实体不读取文件系统，也不建立证据注册表。

来源随当前记忆、变化事件和可选记忆记录同步，客户端基线、增量及详情都保留相同内容。关闭 Recorder 不影响保存结果进入提取及后续记忆使用。没有操作来源的普通记忆保持原有结构。

记忆仍是可取舍的理解，提取可以返回空数组；本功能不保证每次保存生成记忆，也不承担全部操作事实的可靠留存。记忆提取失败不撤销已创建的文件或正式回答。没有增加通用证据系统或新的受理/审查实体；持久化只保存已经正式接纳的内容和来源，见 [持久化](persistence.md)。

提取请求装载当前记忆内容及来源索引，不沿引用加载来源原文，不消费 MemoryRecord。原文仍只增不改删。固定历史是提取可用依据，不宣称模型实际使用了每条材料。更新完整正文仍可能遗漏条件或错误理解；结构校验不证明变化说明与语义正确。

## 归属与边界

- 环境独立建立 Memories；它绑定一个 Transcript，提供 get/values/snapshot/apply，统一审查、落实并发布正式变化。R 仅绑定其正式资源，不拥有实体生命周期。业务没有原集合引用或 Memory.update 旁路。
- ApplyMemoryDefinition 通过本层 memory.apply 资源提交已接纳提案，不传递记录来源、不自行修改内容或补写记录。资源绑定注入本次调用的来源。
- Memories 发布确定的 MemoryEvent，实体自身不持有 Recorder。必要捕获与可选观察独立消费事件；调用中的资源绑定提供 origin 与本次观察端口，记录预设在自己内部形成 RecordChangeSource 及 MemoryRecord。独立变化使用环境端口，不虚构调用来源。
- MemoryRecord 保存在同一个 Book；按 memoryId 过滤，沿登记顺序返回。不另加索引；memoriesId/sequence 表达集合内正式变化顺序。
- E/O/A 记录继续记录提取输入、模型原始返回和接纳候选；MemoryRecord 保存具体记忆体已落实的变化，二者不是重复对象。MemoryRecord 不持有调用 Context 实例、调用状态或虚构事件。
- GET /api/memory 返回当前事实和变化记录的只读投影，原文依据使用 transcriptId/index 定位。客户端从独立消息副本组合原文，未加载时按需取得；页面展示记录正文、依据、结果快照、执行与操作 ID，不做差异推断。本轮保留 MemoryRecord 的不可变结果证据，不扩展记忆历史实体仓库。

无 Recorder 时事实照常变化，不产生记录。接纳及批次预检查失败不改变记忆。整批预检查通过后，先经可选 persistence 端口提交，再整批安装内存状态，最后逐项通知；提交失败不改变内存。通知异常发生在整个批次成立之后，仍尝试其余项的事实发布，按安装的 isolate/propagate 处理并保留真实变更，不虚构回滚。已经生成的回答同样不会被删除。请求超预算直接失败，不自动裁剪、重试或压缩。

Memories.exportState / restore 保存并静默恢复集合和 Memory 身份、sequence、正文及来源。没有实现记忆召回、关系组织、并发更新、用户审核或记录补偿。有限 CP 恢复只核对原快照和准确子树中的固定落实凭据，见 [Checkpoint](checkpoints.md)。

## 观测展示

QA 是一次 E 调用的观测视角，不新增运行实体。导航对应执行轮次，主图上下文行聚合选中历史、可见记忆与变化入口，全文由右侧对话和详情提供。用户输入、生成结果和原文关联来自既有事实，不按相邻文本猜测配对；提取失败仍展示已经正式追加的回答。

记忆详情区分当前 Memory 正文与 MemoryRecord 当时的结果快照，沿调用 ID 查看本轮变化和依据。累计选择次数不代表过去某一时刻的热度，也不代表生成模型实际使用。GET /api/executions 提供轻量关联与计时，GET /api/execution?id=... 按需取得记录详情，GET /api/memory 组合当前正文与历史变化。查询不新建事实；切换详情时丢弃过期响应。UI 布局由应用负责，不作为实体或记录契约。

## 提取目标与表达边界

提取目标是维护准确、可延续的理解：吸收有效信息，修正过时认识，保留有效条件与不确定性，减少无意义重复。如何划分、采用什么粒度、是否综合已有理解由模型判断，不预设主题分类或抽象层级，也不为“记忆之记忆”增加一种实体。现有结构和索引校验保留；create/update 是当前可落实的操作范围，不是对模型知识组织方式的要求。当前尚无删除或合并旧记忆的实体操作；退出活跃索引只改变后续材料成员，不销毁 Memory。维护策略与提取策略都不保证语义一定达到最优收敛。

运行与内容生命周期的完整边界见 [runtime-boundaries.md](runtime-boundaries.md)。

## 变化捕获

Memories 可注入 ChangeCapture<MemoryEvent>。整批语义检查并固定不可变事件后，先提交并安装整个批次，再逐项尝试必要捕获与可选观察；记录预设消费观察事实生成 MemoryRecord。空批次、无变化和预检查失败不占序号。必要捕获失败或 propagate 观察失败保留已经落实的完整批次，仍尝试剩余通知后报告错误；isolate 观察失败停用对应观察者，业务可继续。通知不构成跨项事务或回滚。

MemoryEvent 与 MemoryRecord 通过 memoriesId/sequence 对应；前者同步当前事实，后者提供变化依据及调用归属。客户端分别更新当前记忆与历史记录，不重复落实内容。无 Recorder 时仍可捕获变化，无捕获器时仍可正常使用记忆。网络交付规则见 [观测增量](observation-increments.md)。
