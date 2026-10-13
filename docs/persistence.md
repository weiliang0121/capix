# 对话持久化

按 Conversation 保存独立的 Transcript、Memories 和可选记录预设产物，参见 [对话身份与切换](conversations.md)。重新启动时恢复内容实体及只读历史记录，再装配新的 Provider、REOA 绑定、记录安装和交付连接，允许开始新 QA。

Invocation、Context、未完成步骤、本地等待队列与服务提交身份不恢复。独立 Interaction 另行保存固定模型请求与已接收反馈，允许按 ID 读取，不恢复原调用或自动重发。历史记录用于解释已经观测到的过程，不能用于驱动旧执行。暂不新增 Thread、任务账本或后台工作队列。

## 依赖与位置

服务使用项目固定 Node 22.23.2 自带的 `node:sqlite` / `DatabaseSync`；没有新增 ORM、第三方原生依赖或独立数据库服务。该 Node 版本的 SQLite API 仍带实验性提示。SQLite 实现位于 `services/observer/src/persistence`，不进入 runtime 内核或跨端协议。

`pnpm start` 默认使用仓库 `.capix/observer.sqlite`；`CAPIX_DATA_DIR` 可覆盖目录。目录自动创建，数据库与已有 SQLite sidecar 文件设为 `0600`，新目录为 `0700`。数据目录必须位于 `CAPIX_FILES_ROOT` 之外，避免对话文件能力访问消息、记忆和记录存储。`.capix/` 已被 Git 忽略。

数据库启用 WAL、`synchronous=FULL` 和外键检查，当前保持独占锁，一个数据库只支持一个写服务。第二个服务启动明确失败，不用各自内存副本竞争写入。数据库格式使用 `user_version=3`，v1 先增加独立 interactions 表，再由 v2 迁移对话目录和来源归属。旧内容成为默认对话，保留原实体与记录身份；未知版本及内容损坏拒绝加载，不静默清空或创建空对话替代。恢复接口分为 `ObserverStoredContent`（version 1）和 `ObserverStoredRecording`，与数据库格式版本分别维护。

程序化装配保持显式：

```ts
import { ObserverConversations, SqliteObserverStore } from '@capix/observer-service/assembly';

const persistence = SqliteObserverStore.open('/private/capix-data/observer.sqlite');
const conversations = new ObserverConversations(provider, [], { persistence });

// 在没有活动调用或外部交互时关闭；封存本次记录来源并释放存储。
conversations.close();
```

不传 persistence 时保持原有内存行为。宿主初始化失败时，由创建 store 的启动代码负责关闭；默认启动入口已处理这一点。不能同时传入恢复库和新增启动消息，以免重启无意重复追加。

## 内容正式成立的顺序

```text
Transcript.append / startSegment，Memories.apply
    → 实体预检查、复制冻结、准备下一状态与变化
    → persistence.commit（同步 SQLite 事务）
    → 安装已经准备好的内存状态
    → 被动进展、变化捕获、可选观测
```

内容实体只知道自己的窄持久端口：`TranscriptPersistence` 接受追加或切段，`MemoriesPersistence` 接受整批 upsert。两者携带实体身份及期望 revision/sequence；存储检查当前版本并原子保存。commit 必须同步结束且返回 undefined，不能将异步任务交给变化消费者后就宣称内容已保存。

Transcript 保存稳定 id、消息绝对 index、正文、revision 和分段起点。Memories 保存集合 id、transcriptId、sequence，以及每个 Memory 的稳定 id、正文、消息来源和不可变 sourceResults。更新保留身份与列表次序；无变化不写库、不占顺序。

记忆整批预检查、整批提交、整批安装，然后逐项发布事实。某条通知失败不会使已提交批次只有前半段存在；仍尝试发布剩余项，并报告单个或聚合失败。观测失败不回滚内容，也不重新执行工作。

数据库提交失败时内存不改变，不发布 accepted / answer 或内容变化。启用持久化的内容存储失效后，服务接纳状态变成 unavailable，拒绝后续新提交；不默默退化为仅内存模式。回答已经保存而记忆失败时，回答仍保留。

## 独立交互保存

`store.interactions` 提供 create/commit/read。Interaction 先保存 prepared 请求，再保存 started 发送意图，最后保存反馈或失败；反馈保存后才允许 A 解释。请求与已接收反馈不可替换，更新检查 expectedRevision。存储不依赖记录安装，也不要求先初始化对话内容。

已保存的 ModelOutput 包含未经业务 JSON 接纳的 content；因此模型内容解释失败后仍可读取它。恢复读取不创建 Provider，不继续旧 QA；只有发送意图而无反馈时明确不可恢复等待。模型发送与 SQLite 不是跨系统事务，也没有进程重启后重新发送的承诺。独立生命周期、取消及读者边界见 [外部交互](interactions.md)。

## 记录保存与历史读取

Recorder 产出确定性的 RecordChangeEvent。服务在交给 ChangeBuffer 前同步保存其 added/replaced/过程/关系/终态变更；不比较全量快照。新增记录、父 childIds 和记录来源 revision 在同一 SQLite 事务中更新。

记录保存发生在观测载体更新之后，不参与业务内容接纳。记录保存失败让该观测来源失效；已经成立的回答和记忆不撤销。若只是记录写入契约失败，内容仍可用；数据库本身不可用则同时影响内容接纳资格。

`RecordBook.exportState()` / `RecordBook.restore()` 保存并重建具体记录类型。恢复检查身份、正文、归属、父子引用和局部顺序，不调用 add/finish 重演活动，也不发出新增通知。恢复记录为只读历史，当前调用不能挂在旧调用或旧安装根下。

每次启动建立新的 Recorder 与 RecordingInstallation。旧来源带以下归档信息：

| 字段               | 含义                                       |
| ------------------ | ------------------------------------------ |
| sourceId / rootIds | 原记录来源及安装根                         |
| revision           | 最后保存的记录变化位置，不是交付游标       |
| sealed             | 宿主在无活动调用时确认该来源封存           |
| open               | 尚未确认封存，可能因进程中断而只保存了前缀 |
| incomplete         | 已明确发生记录缺失                         |

历史 running 不改写成 failed/completed；应用展示“上次运行未取得结束记录”，不持续增加耗时或加入当前活动记录基线。详情允许归档前缀缺少调用边界尾部，现存身份、关系与顺序仍须有效。sealed 表示记录来源被封存，不代表其中每次业务调用都成功。

## 重启与客户端边界

对话按需通过 `loadContent(id)` 一致读取消息与记忆；只查询消息不会加载记录。运行或观测装配复用已经恢复的实体，通过 `loadRecording(id)` 独立读取记录及来源。注入内容按一次点查核对 Transcript 和 Memories 两个身份，既不重读正文，也不遍历整个对话目录。消息、记忆保持原身份与顺序；有效历史记录沿原 id 可查询。当前 SelectionUsage 是进程内统计，不从历史记录重算业务输入。

历史记录正文、关系或归档元数据损坏时，保留原始存储，当前对话观测明确返回 `SOURCE_INCOMPLETE`；健康内容仍可恢复并开始新 QA，其他对话不受影响。本次安装产生的新记录可以继续保存，但不把缺损历史包装成空的健康基线。没有自动删除或修复损坏记录。正常保存的 open/incomplete 归档前缀仍按既有规则读取。内容自身恢复失败、真实 SQLite 查询或提交失败仍使服务不可接纳，不退化为仅内存。

客户端通过现有配置、消息基线、观测基线加载恢复内容。观测基线携带历史来源标记，当前增量仅属于新来源；服务不承诺旧 SSE 游标继续重放。绑定层在替换基线时清理过期详情缓存，防止旧 live 记录覆盖归档状态。

旧 submissionId 在重启后不可查询，不表示其输入未接纳或副作用未发生。现有客户端不会因此自动重 POST；保存了跟踪定位的客户端刷新后仍会查询原身份，结果不可用时继续阻止新提交。用户需先撤回等待项，再明确结束本地跟踪，才能开启新的提交；这不表示取消旧业务。恢复已知内容与恢复旧提交是不同能力。

## 崩溃窗口与验证

| 中断位置                         | 本轮保证                                                   |
| -------------------------------- | ---------------------------------------------------------- |
| 内容事务提交前                   | 变更没有成立，整批不留下部分行                             |
| 提交后、内存安装或通知前         | 重启恢复已提交内容，不重放旧通知或业务                     |
| 内容已保存、记录未保存完整       | 内容仍在；记录展示真实保存前缀及归档状态                   |
| 文件已经发布、回执或记忆尚未保存 | 不保证可恢复该回执；不从缺少记录推断文件未创建，不自动重做 |
| 调用未完成或结束边界未保存齐     | 不恢复执行、不伪造终态；允许新的 QA                        |

文件发布与 SQLite 不是跨系统事务。本轮没有补偿、执行去重或恰好一次承诺；需要这类能力时再设计持久任务与外部反馈处理。

回归覆盖真实临时 SQLite 的关闭重开、稳定身份和来源、事务失败、独占写入、格式/关系损坏、记录失效隔离、HTTP 重启及独立子进程 SIGKILL。模型使用 fixture，不访问真实供应商。重启后明确断言不调用旧业务，再验证新 QA 可继续。
