# CAPiX 协作约定

## 项目与工作方式

- 当前实现位于 `/Users/weiliang/Documents/workspace/capix`，由原 capix-observer 延续而来。相邻 capix-explorations 保留早期概念探索与独立 Git 历史；它不是本仓库的运行依赖或设计约束。旧工程只按用户需要只读参考，不复制整套模块或治理配置。
- CAPiX 是 C/S 可观测 Agent 框架；Observer 是参考服务和应用，用实际对话及观测验证内核。项目定位、对象角色和名称迁移见 [项目组织](docs/organization.md)。
- 人参与关键对象、职责与调用关系的设计。按共同确定的小闭环推进，不因目录整理提前建立新平台。用户明确授权整体实施时，完成对应实现、审查、验证与修复。
- 修改前检查并保留已有文件与未提交工作。核心对象维持自身不变量，helper 组合明确操作；独立生命周期才构成新增实体的依据。
- 当前不推进 TRS、持久化/恢复、动态调度、token 流、外部能力平台或权限系统；这些需另行明确真实需求。不推送、部署或发布，不读取其他项目凭证，不为验证默认调用真实模型。

## 包与职责边界

- 一个根 pnpm Workspace 与锁文件，六个实际包：`@capix/protocol`、`@capix/server-runtime`、`@capix/client-runtime`、`@capix/client-http`、`@capix/observer-service`、`@capix/observer-app`。跨包只能使用公开出口，不导入其他包的 src/dist 私有路径，不为每个对象建包。
- protocol 只包含真实跨端契约，内部按 content/invocation/recording/conversation/observer 分组；无 Node、HTTP 实现、数据库或 UI 依赖。服务端与客户端不互相依赖。Trace、几何布局、搜索与视口属于应用投影。
- server/runtime 提供 REOA 结构、声明/绑定、Invocation/Context、资源、异常和类型化观测出口；内容实体与可选记录预设暂同包，分别有 `/content` 与 `/recording` 入口。低层构造有 `/construction` 入口；根入口按职责分组，不为减少导出数量建立门面。
- services/observer 的 conversation 提供业务 R/E/O/A、模型契约和绑定、消息同步；observation 提供来源/记录投影/观测交付；assembly 建立独立实体和共享消费；http 负责宿主交付。不得让 conversation 依赖环境初始化来取得隐式对象。
- ClientRuntime 保持无 UI：以 conversation/transcripts/observation 具名装配，初始化配置与消息同步，观测显式开启。当前依赖对话和 Observer 契约，不宣称已是任意业务的通用客户端。client/http 只做收发与协议接纳；app binding 投影后写入 Store，React 消费读模型与明确 props。内部接纳、会话协调与公开快照分开；每条增量照常消费，微任务合并发布，命令门控使用即时内部状态。正文可用性与服务结果、连接健康分别表达；app binding 按浏览器帧合并投影，一次写 Store。
- ClientSubmission 持有单次提交的反馈连接与事实，TranscriptReceiver / ObservationReceiver 各自持有同步生命周期；ClientRuntime 只协调初始化、当前提交、跨来源状态与发布。连接替换先转移本地归属再 abort 旧连接，回调重入后复核身份；停止消费不取消服务端业务。
- 服务模型请求、Schema、Provider 适配与配置接纳留在服务。Key 仅由服务端环境获取，不输出、不写记录或传到客户端。模型能力与配置是不同对象。

## 运行结构与访问

- 运行时表示活动状态，不等同于 R。`*Definition` 是内容契约；`BoundRuntime/BoundExecution/BoundOperation/BoundAttempt` 是可复用结构；Invocation 与本层 Context 表示单次调用。业务接收 `*ContextView`、InvocationView、ChildBindings，不取得真实 Context 的生命周期修改能力。
- REOA 声明平级 run/exceptions/observation；绑定只接线与约束访问，不执行业务 Sequence。R 声明 E children 并显式选择、调用和接纳；不假定 R 与 E 唯一对应。E→O，O→O/A，A 不继续分层。原始实体通过正式资源申请使用，不向祖先 Context 取数。
- BoundRuntime 持有占用和稳定身份，构造器持续复用且不缓存单次信号/输入。每次 run 新建 RuntimeContext/Invocation；占用取得后任何失败都释放。业务不维护第二个 executing 标志，不隐含排队。
- 世界由独立实体构成：Transcript、Memories、SelectionUsage、Provider、记录容器等由环境建立。R 只绑定资源访问形式，不成为这些对象的所有者。
- ResourceOffer 声明公开访问、capture、兑现时机与 describe。绑定按对象身份、唯一供给和声明覆盖检查；业务只取得本阶段资源。资源端点检查所属调用/祖先活动，不能缓存写端点越过调用继续使用。关闭观测不触发描述或提前兑现惰性模型。
- E entry.accept 接纳输入，accepted 通知后，未取消时 entry.admit 执行分段；entry 关闭后 capture 固定工作配置/原文范围，然后创建 E Context/Invocation。入口阶段属于已有 R，不伪造 E 记录。started 是同步绑定回调，保持 Context 建立后、调用 started 发布前的时机。被动进展通过独立 ProgressChannel 隔离消费者故障，不把反馈回调当作建立钩子；消息落实定位在正式 append 时发布，不读当前集合长度反推。详细顺序见 [运行边界](docs/runtime-boundaries.md)。
- BoundChildren 惰性建立直接子结构，Initializer 缓存成功或失败；不引入重置/异步管理器。Sequence 逐项构造输入、运行并接纳结果，各次输出独立。父子关系保存真实返回与接纳事实；returned 不等于 accepted。
- Context 保留真实 IO/异常引用，局部继续复用同一 Context；子调用每次新建。maxRounds 默认 1，仅允许 1/2。run.accept 只处理正常结果；exceptions.handle 按契约处理已声明异常。内核、绑定、未声明抛错、处理器错误不递归进入异常处理。已归属错误不能被业务 catch 清除。详见 [异常边界](docs/exceptions.md)。

## 内容、记录与变化

- Transcript 自行接纳并复制冻结消息，只有正式 append/startSegment 改变集合；消息 index 稳定，批量预检查失败不部分追加。Ref/RangeRef 是内部实体访问，记录只保存 UID、范围及版本，不持有活引用。原文仅含正式 user/assistant，不把选择输出当消息。详见 [原文与分段](docs/transcript.md)。
- Memories 独占 create/update 正式落实；先检查整批目标、内容和来源，再变更。更新保留 Memory 身份，无变化不占顺序号。业务依据从本轮固定快照和可见原文取得，不从 MemoryRecord 恢复。下一轮使用更新后的记忆；当前不引入长期画像、召回或记忆关系图。详见 [记忆](docs/memory.md)。
- 记录是预设的可选观测结果，不是观测唯一载体。Invocation、资源和内容生产者不依赖 Recorder；不装记录时运行仍成立。RecordingInstallation 持有 RecordingRootRecord；RuntimeCallRecord 是单次 R 调用。记录树为根→R调用→E→O/A。保留现有 wire kind:'runtime'，不因代码改名改变协议。
- Recorder 组合 RecordBook、RecordTree、同步登记与通知；Book 只持有引用并拒绝重复 ID。Tree 依据直接 parentId/childIds 查询，不重建调用索引。登记同步维护父子引用，失败只清理本次登记，不回滚业务事实。记录正文复制/检查/冻结，拒绝活实体、函数、循环等不受支持内容。
- InvocationRecording 局部持有调用记录句柄与父预设，不建立全局 Context→Record 查询。processes 与 relationChanges 分开；resultOf 只引用本记录直接正文，不跨轮/记录成链。InvocationBoundaryRecord 描述工作边界，不冒充实际交付。ResourceRecord 是写入载体的资源数据，ResourceObservation 才是实时观测事实。详见 [记录机制](docs/recording.md)。
- 生产者在变化落实时发布类型化事实；ChangeCapture<E> 是窄端口，ChangeBuffer 只缓冲/wait/take，不调用消费者。必要捕获严格失败，可选观察默认 isolate，可显式 propagate；已成立事实不回滚，也不触发重做业务。观测失败停用对应消费者，来源完整性独立处理。
- ObserverChange 只是当前服务环境的来源联合，不是内核全部事件类型。一个 ChangeConsumer 独占 take，向 RecordSource 和独立实体出口分发。记录来源缺失事实永久终止 SOURCE_INCOMPLETE，不能重拉基线假装修复；网络失败不破坏来源。不得比较全量快照反推增量。顺序、来源修订与交付游标各有边界，批次不宣称业务事务。详见 [观测增量](docs/observation-increments.md)。

## 对话与交付

- ConversationRequest {messages} 是服务对话输入，不是通用 E 契约。正式接纳 1–501 条消息，末条为 user；忙碌返回409，不追加输入。回答追加后发 answer，记忆后处理前可见；completed 等 R.run 返回后发送。后处理失败保留回答。
- ConversationRuntimeDefinition / ConversationExecutionDefinition 组织选择、生成、记忆提取。业务复杂度在具体声明，绑定固定资源来源。消息同步与观测 Feed 独立连接/关闭；不观测仍能正常对话。
- 只有 GenerateAnswerDefinition 明确支持一次再次生成：完整模型返回被 INVALID_JSON/EMPTY_OUTPUT/OUTPUT_SHAPE 拒绝时，依据直接子调用证据与声明契约继续。第二轮只准备反馈请求、调用及接纳，不重复选择、上下文组装或回答追加。超时、网络、取消、非 stop 返回、捕获/记录错误不自动重试。
- 模型输出契约使用固定 Zod 严格 Schema，与 JSON Schema 同源；不 coerce/trim/default 掩盖非法输出。结构校验与动态引用/来源/容量规则分别由能力负责。选择保留模型优先级；请求装载按优先级保留完整前缀，第一条超限就失败，不跳过长消息凑容量。字节容量估算不是精确 tokenizer。
- GET /api/executions 为轻量概览，详情按需读取 ExecutionRecordSnapshot。原文独立基线与增量同步，客户端组合引用和已加载正文。未加载/缺失/错误/空值分开。来源失效不改写业务结果。详见 [协议](docs/protocol.md)、[客户端](docs/client-runtime.md)。

## 提交与反馈生命周期

- POST 对话使用 `{ submissionId, input }`；ConversationSubmission 在服务侧持有任务和累计进展投影，连接只消费。内核只暴露被动调用/内容事实，服务绑定选择来源，服务投影解释 C/S 语义，不由记录推断业务。
- 输入与回答正式写入、R.run 实际返回/抛错、投影完整性、反馈连接和实体同步分别表达。断线只解除消费，不取消服务运行；反馈故障不回写 Context，不导致业务重做。
- 服务仅有界保留进程内提交；查询/follow 恢复反馈，不恢复执行。不承诺持久化、幂等重提或重启恢复。客户端只发送一次，重连不重新 POST；未知/淘汰提交不证明未执行。未确认结果时默认阻止新提交，用户可显式结束本地跟踪，不能称为取消。

## 编码、界面与验证

- 每条变量声明只声明一个变量；循环直接表达继续/结束条件，不使用 while(true) 再内部 break。流读取以 done 结束，异常和提前退出仍释放资源。
- 类自身 ID 直接生成；不为 ID 创建无意义别名。不为每次检查创建包装层。按概念/动作组织目录，不用连字符机械拼接功能文件名；工具固定文件名除外。
- 通用操作优先使用 es-toolkit@1.52.0 公开入口，不建通用 Utils/转发层。标准类型谓词用 predicate/compat；对象身份、严格记录正文、getter 隔离、循环和预算规则保留专用语义。只为真实需求引入深合并或克隆，不用通用函数覆盖正式接纳。
- RuntimeError 是通用诊断，不是 R 层专属错误。错误格式保留 code/message/name/stack/cause/复合 errors；标准错误字段逐项安全读取并捕获访问异常，允许继承的 name；诊断 detail 不执行 getter/toJSON。保持现有转换预算，不单独创建错误记录或无限错误恢复。错误机制自身损坏属于 bug。
- Observer 为黑灰主题；10/12/14/16px 字号，主标题20px。问答导航固定块宽并独立滚动；主图轮间等宽、轮内按耗时。颜色表达稳定操作类别，不映射时间；失败、运行中、选中以文字 tag 表达，不用状态彩色描边覆盖节点含义。累计被选次数用数字和局部短条，不用整块热度填色。上下文行聚合关联，不重复消息全文。React + Vite + Tailwind，shadcn 源码组件留在 app 内。保留键盘可访问性，不用原生 title 遮挡节点。
- Node22.23.2、pnpm10.7.1、TypeScript6.0.3，外部直接依赖精确版本，内部 workspace:*。Prettier printWidth1000，不因窄行宽拆散签名。
- 运行改动所需检查；组织迁移需干净产物构建，验证公开出口、类型、原有回归、源码定位与格式。依赖身份变化更新锁文件并 frozen-lockfile 验证；普通测试不访问真实模型。
- 完成后报告变化、必要验证和真实限制。不要把历史方案当作当前 API，不保留同一语义的重复旧名或空壳包装来掩盖理解问题。
