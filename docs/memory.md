# 记忆体与记忆记录

## 两种对象

Memory 是当前可消费的理解。它有持续身份及原文归属；正文更新保持同一个实例和 ID。内部当前内容为不可变值，通过 update 一次替换，不允许外部零散改写。

```ts
Memory {
  id: string;
  transcript: Transcript;
  topic: string;
  content: string;
  sourceIndexes: readonly number[];
}
```

MemoryRecord 是本次已经落实的变化，继承 RuntimeRecord。记录自身有独立 ID，正文生成后不可改写。

```ts
MemoryRecord extends RuntimeRecord<{
  action: 'create' | 'update';
  change: string;                  // 本次明确发生了什么，不从两份正文推断
  sourceIndexes: readonly number[]; // 本次变化依据
  result: MemoryContent;           // 落实之后的完整内容快照
}> {
  memoryId: string;
  executionId: string;             // ExecutionRecord.id
  operationId: string;             // OperationRecord.id
}
```

例如同一个 M：第一次创建预算200元，第二次改为150元。M 的当前正文是150元；记录A保存创建说明和200元快照，记录B保存“200改为150”的说明及150元快照。变化说明由本次处理明确给出，不在观测时猜测。记录按实际登记顺序查询，不保存前后指针。

记忆体没有关系数组；“记忆之记忆”本轮不设计。topic 是可变场景名称，不是身份，也不以字符串相同自动合并记忆。

## 提取与落实

```text
选择 → 组装 → 生成 → 追加正式 assistant 消息
                         ↓
当前记忆 + 其原文依据 + 本轮QA + 筛选候选原文
                         ↓
ExtractMemory.before → commit(模型) → after
                                     ├─ 解析与整批接纳
                                     ├─ MemoryHelper 创建/更新当前事实
                                     └─ 每项落实后登记 MemoryRecord
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

创建使用 action=create、memoryId=null；无需变化则返回空数组。最多四项。更新必须引用当前可见、同 Transcript 的记忆 ID，同批不能重复更新一个目标。本次依据至少包含一条本轮消息，完整内容依据必须包含本次依据；所有索引都在提取输入中。Schema 在提示词中声明，并有对应本地检查，不是供应商强制 Schema 输出。

提取请求只装载当前记忆内容及来源，不消费 MemoryRecord。原文仍只增不改删。筛选候选是提取可用证据，不宣称全部用于回答。更新完整正文仍可能遗漏条件或错误理解；结构校验不证明变化说明与语义正确。

## 归属与边界

- MemoryCollection 只持有实例，提供 add/get/values。
- MemoryHelper 组合运行事实的创建和更新；可传入落实后的通知，不依赖记录体系。
- MemoryRecordHelper 组合记录创建与归属查询，利用已有 Recorder 的 Context→Record 映射，关联实际执行和操作记录 ID。RecordBook 保持通用。
- MemoryRecord 保存在同一个 Book；按 memoryId 过滤，沿登记顺序返回。本轮不另加索引或排序元数据。
- E/O/A 记录继续记录提取输入、模型原始返回和接纳候选；MemoryRecord 保存具体记忆体已落实的变化，二者不是重复对象。MemoryRecord 无 Context、调用状态或虚构事件。
- GET /api/memory 返回当前事实和变化记录的只读投影。页面展示记录正文、依据、结果快照、执行与操作 ID，不做差异推断。

无 Recorder 时事实照常变化，不产生记录。接纳及批次预检查失败不改变记忆。登记异常发生在事实变更之后，异常传播、保留真实已发生变更，不虚构回滚；尚无事务或恢复。已经生成的回答同样不会被删除。请求超预算直接失败，不自动裁剪、重试或压缩。

本轮未实现记忆召回、关系组织、并发更新、持久化、恢复、用户审核或记录补偿。

## 观测展示

QA 是一次执行的观测视角，不新增运行实体或记录。上方按实际执行顺序排列三行：用户、助手、记忆体，每列属于同一执行，超宽横向滚动。用户从执行范围读取，助手来自该次生成操作；原消息索引从提取操作已有的 currentIndexes 取得，不按相邻消息或重复文本配对。失败且未生成回答时保留空位，提取失败也保留已成功生成的回答。

同一个选中执行 ID 控制 QA 详情、记忆卡片和调用时序。用户输入与助手回答并列展示；记忆区按 executionId 展示本轮 MemoryRecord，卡片横向滚动，正文是记录当时的结果快照。全部入口仅显示当前记忆总览，不展示某次时序。热度仍为全部执行累计，金框标记选中轮选择过的历史，不把累计次数当成过去时刻的热度。

GET /api/executions 从已有记录投影轮次、消息关联及选择结果，GET /api/execution?id=... 查询该轮已有 E/O/A 和事件记录。查询不新增事实或记录，刷新后仍可查询本进程的历史执行；不包含持久化、导入或重放。快速切换时丢弃过期的前端请求结果，防止旧时序覆盖新选择；执行期间暂不可切换观察轮。

## 提取目标与表达边界

提取目标是维护准确、可延续的理解：吸收有效信息，修正过时认识，保留有效条件与不确定性，减少无意义重复。如何划分、采用什么粒度、是否综合已有理解由模型判断，不预设主题分类或抽象层级，也不为“记忆之记忆”增加一种实体。现有结构和索引校验保留；create/update 是当前可落实的操作范围，不是对模型知识组织方式的要求。当前尚无退役、删除或合并旧记忆的操作，不宣称结果一定达到最优收敛。
