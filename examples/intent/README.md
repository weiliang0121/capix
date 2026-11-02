# 意图识别小实验

这个示例研究：**同一输入在获得消息、记忆或 Skill 后，是否选择了更合适的节点？** 它只验证识别与路由，不执行翻译、写入用户记忆、订票或任何真实业务操作。

```text
Transcript ── TranscriptViewSource ──┐
Memories ──── MemoryViewSource ──────┼── View ── ResourceOffer ── decide Node
静态 Skill ── 示例自己的来源 ────────┘                           │
ChatCompletionsProvider ── ResourceOffer ────────────────────────┘
                                                               │
Scene → Group → decide → 校验决定 → 已注册的候选 Node → 动作计划
```

八个候选分为三簇：`translate / polish / summarize_text`、`recall_history / summarize_history / recall_memory / remember`、`apply_skill`。目录与实际注册使用同一份清单。Skill 是本例的静态材料来源，没有新增 Skill 平台；记忆是预先构造的有来源记忆，不测试记忆提取质量。

模型只调用一次。目录说明帮助选择，严格 JSON 契约核验节点名、字段、证据引用及所选节点需要的材料是否存在。校验通过后仍走真实子调用与接纳，候选只返回 `plan-only`。语义选择不正确、传输失败、输出契约不合法分别报告，不用自动重试掩盖。

这里采用普通 Group：一次决策、至多一次候选调用就足够。Dynamic 适用于多次决策推进；本实验无需为它额外引入可变流程材料。

## 运行

```sh
pnpm build
node examples/intent/run.mjs
```

默认使用固定响应，只验证资源、View、节点和运行器的接线。**离线结果不是模型识别准确率。** 它不是按期望答案查表的假模型，也不训练或模拟真实智能。

真实调用需要显式 `--live`。脚本只读取 `DEEPSEEK_API_KEY` 和可选 `DEEPSEEK_MODEL`，不自行打开 `.env`。请由宿主安全注入环境变量；不要把密钥写进示例、报告或命令行参数。默认模型 `deepseek-flash`，关闭 thinking，温度 0，每次超时 45 秒，不重试。

```sh
node examples/intent/run.mjs --live --out /tmp/capix-intent-report.json
# 按个别疑点挑选条件，避免重复付费：
node examples/intent/run.mjs --live --cases history-reference,memory-convention,named-skill --conditions input,full --limit 6
```

默认是真实模型前六例 × 五种条件，共 30 次串行请求。`--limit` 是本次上限（1–100），`--cases` 和 `--conditions` 接受逗号列表；`--out` 新建 JSON 文件且拒绝覆盖。无 `--out` 时 JSON 输出到 stdout，每条进度写 stderr。没有自动加载生产对话数据。

`experiment.mjs` 也公开 `runCase({fixture, condition, model})`、`runMatrix(...)`，因此宿主可注入其他模型或配置更小的组合表。

另有固定的 25 组精简研究，覆盖全部候选、有/无对应材料、旧偏好覆盖与无关材料挑战。每次结果立即写入 JSONL，遇到 Provider 失败停止后续请求：

```sh
node --env-file-if-exists=.env examples/intent/study.mjs --live --out /tmp/capix-intent-study.jsonl
```

不带 `--live` 只显示说明。已完成的首轮真实对照见 [结果与分析](results/2026-10-29-analysis.md)，保留了模型原文与一项契约拒绝，不用离线结果替代实测。

## 对照与判断

| 条件      | 决策节点收到什么   |
| --------- | ------------------ |
| `input`   | 当前输入、候选目录 |
| `history` | 加近期消息视图     |
| `memory`  | 加已落实记忆视图   |
| `skills`  | 加 Skill 正文      |
| `full`    | 加三种来源         |

每次试验创建独立实体、View、结构和 Runner，前一次结果不写回下一次材料。记忆的原始来源消息仍在 Transcript 中，但可以不属于近期消息视图；这样 `history` 条件不会暗中读到已排除的来源。模型只得到 `query/catalog/material`，看不到 case ID、条件名称、期望答案或评估规则。

默认六例分别检验：明确翻译、历史指代、记忆中的惯例、点名 Skill、查询记忆、目标不明的澄清。另有 `explicit-over-memory`、`summarize-text`、`summarize-history`、`remember-preference`、`recall-history`、`unsupported` 可选。

报告包含实际/期望、简短判断依据、证据引用、接收到的材料、实际子节点计划、原始模型文本、tokens、延迟、请求字节数。匹配标准按当前**可见材料**确定：缺少惯例定义时澄清是正确结果，并非识别失败。

同一例的某些条件可能没有对应来源，因此实际发送的材料完全相同；默认 30 次请求并不是 30 个独立样本。`fixtures.mjs` 另导出 `studyPlan`，以 25 个组合覆盖全部主意图及有意义的来源对照。

证据检查只证明引用存在，来源检查只证明某类材料存在；它们不能证明材料在语义上支持决定，也不核验 Skill 的名字或执行参数。`unrelated-memory` 与 `wrong-skill` 两例专门检查模型是否将无关记忆或错误 Skill 当成所需材料；这一点仍要对照原始文本人工分析。`matched` 只是人工设定的小样本匹配计数。不能把它推广为普遍准确率，也不能把有材料后的成功归因于消息/记忆实体“具有智能”：实体保证提供了哪些事实，解释事实和选择能力仍由模型完成。固定目录和固定 prompt 是本实验条件，没有比较模型、目录顺序或提示词，也未验证记忆提取、检索召回、多轮澄清或真正 Skill 执行。

## 文件阅读顺序

1. `catalog.mjs`：候选区分与决定契约。
2. `fixtures.mjs`：输入、材料、各条件的人工期望。
3. `material.mjs`：实体 → 来源 → 视图 → 资源的接线。
4. `experiment.mjs`：决策 Node、候选 Node、Group、Runner、结果评价。
5. `run.mjs`：离线或真实 Provider 的宿主入口。
