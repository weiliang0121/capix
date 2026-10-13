# CAPiX 协作约定

## 项目与工作方式

- 当前实现位于 `/Users/weiliang/Documents/workspace/capix`，由原 capix-observer 延续而来。相邻 capix-explorations 保留早期概念探索与独立 Git 历史；它不是本仓库的运行依赖或设计约束。旧工程只按用户需要只读参考，不复制整套模块或治理配置。
- CAPiX 是 C/S 可观测 Agent 框架；Observer 是参考服务和应用，用实际对话及观测验证内核。项目定位、对象角色和名称迁移见 [项目组织](docs/organization.md)。
- 人参与关键对象、职责与调用关系的设计。按共同确定的小闭环推进，不因目录整理提前建立新平台。用户明确授权整体实施时，完成对应实现、审查、验证与修复。
- 修改前检查并保留已有文件与未提交工作。核心对象维持自身不变量，helper 组合明确操作；独立生命周期才构成新增实体的依据。
- 当前持久化恢复各对话的消息、记忆与可选记录，再允许新 QA；独立模型交互保存固定请求与反馈，可按 ID 再次读取，但不恢复旧调用、Context、提交、队列或外部副作用。不推进 TRS、动态调度、token 流、外部能力平台或权限系统；这些需另行明确真实需求。不推送、部署或发布，不读取其他项目凭证，不为验证默认调用真实模型。

## 包与职责边界

- 一个根 pnpm Workspace 与锁文件，六个实际包：`@capix/protocol`、`@capix/server-runtime`、`@capix/client-runtime`、`@capix/client-http`、`@capix/observer-service`、`@capix/observer-app`。跨包只能使用公开出口，不导入其他包的 src/dist 私有路径，不为每个对象建包。
- protocol 只包含真实跨端契约，内部按 content/invocation/recording/conversation/observer 分组；无 Node、HTTP 实现、数据库或 UI 依赖。服务端与客户端不互相依赖。Trace、几何布局、搜索与视口属于应用投影。
- server/runtime 提供 REOA 结构、声明/绑定、Invocation/Context、资源、异常和类型化观测出口；内容实体与可选记录预设暂同包，分别有 `/content` 与 `/recording` 入口。低层构造有 `/construction` 入口；根入口按职责分组，不为减少导出数量建立门面。
- services/observer 的 conversation 提供业务 R/E/O/A、模型契约和绑定、消息同步；observation 提供来源/记录投影/观测交付；assembly 建立独立实体和共享消费；http 负责宿主交付。不得让 conversation 依赖环境初始化来取得隐式对象。
- ClientRuntime 保持无 UI：以 conversation/transcripts/observation 具名装配，初始化配置与消息同步，观测显式开启。当前依赖对话和 Observer 契约，不宣称已是任意业务的通用客户端。client/http 只做收发与协议接纳；app binding 投影后写入 Store，React 消费读模型与明确 props。内部接纳、会话协调与公开快照分开；每条增量照常消费，微任务合并发布，命令门控使用即时内部状态。正文可用性与服务结果、连接健康分别表达；app binding 按浏览器帧合并投影，一次写 Store。
- ClientSubmission 持有单次提交的反馈连接与事实，TranscriptReceiver / ObservationReceiver 各自持有同步生命周期；ClientRuntime 只协调初始化、当前提交、跨来源状态与发布。连接替换先转移本地归属再 abort 旧连接，回调重入后复核身份；停止消费不取消服务端业务。
- 消息副本与同步连接状态分开。TranscriptReceiver 对明确连接中断和修订缺口有限退避重建基线，主动停止清理定时器；身份/正文冲突、协议错误及来源失效终止自动恢复。基线不能改写既有消息前缀。恢复就绪等待本次有效基线，不复用首次 ready；已初始化客户端的同步波动不重置业务接纳资格或触发重 POST。
- 服务模型请求、Schema、Provider 适配与配置接纳留在服务。Key 仅由服务端环境获取，不输出、不写记录或传到客户端。模型能力与配置是不同对象。
- Interaction 独立于 Invocation 与 Recorder，固定请求只发送一次，反馈非破坏读取；局部等待到期不重发。服务 ModelInteractions 持有实体，资源分 create/read；请求模型 O 接纳 A1 pending 后可建立 A2 读取同一交互。Provider 总超时与局部等待分开；宿主取消的交接窗口由服务等待同 owner 交互收尾并维持 busy，R 无需伪装仍在运行。恢复有反馈只读、无反馈明确 unavailable；不引入租约、自动重放或执行恢复。详见 [外部交互](docs/interactions.md)。

## 运行结构与访问

- 运行时表示活动状态，不等同于 R。`*Definition` 是内容契约；`BoundRuntime/BoundExecution/BoundOperation/BoundAttempt` 是可复用结构；Invocation 与本层 Context 表示单次调用。业务接收 `*ContextView`、InvocationView、ChildBindings，不取得真实 Context 的生命周期修改能力。
- REOA 声明平级 run/exceptions/observation；绑定只接线与约束访问，不执行业务 Sequence。R 声明 E children 并显式选择、调用和接纳；不假定 R 与 E 唯一对应。E→O，O→O/A，A 不继续分层。原始实体通过正式资源申请使用，不向祖先 Context 取数。
- BoundRuntime 持有占用和稳定身份，构造器持续复用且不缓存单次信号/输入。每次 run 新建 RuntimeContext/Invocation；占用取得后任何失败都释放。业务不维护第二个 executing 标志，不隐含排队。
- 世界由独立实体构成：Transcript、Memories、SelectionUsage、Provider、记录容器等由环境建立。R 只绑定资源访问形式，不成为这些对象的所有者。
- ResourceOffer 声明公开访问、capture、兑现时机与 describe。绑定按对象身份、唯一供给和声明覆盖检查；业务只取得本阶段资源。资源端点检查所属调用/祖先活动，不能缓存写端点越过调用继续使用。关闭观测不触发描述或提前兑现惰性模型。
- E entry.accept 接纳输入，accepted 通知后，未取消时 entry.admit 执行分段；entry 关闭后 capture 固定工作配置/原文范围，然后创建 E Context/Invocation。入口阶段属于已有 R，不伪造 E 记录。started 是同步绑定回调，保持 Context 建立后、调用 started 发布前的时机。被动进展通过独立 ProgressChannel 隔离消费者故障，不把反馈回调当作建立钩子；消息落实定位在正式 append 时发布，不读当前集合长度反推。详细顺序见 [运行边界](docs/runtime-boundaries.md)。
- O/A 可通过 `childResources` 在创建时收窄已供应且已申请的资源；规则由 ResourceOffer.refine 签发，绑定只从输入选择范围，资源自身检查不可扩大。父层和兄弟供给不变，无关资源不重捕获；这不是动态能力注册或调度。
- BoundChildren 惰性建立直接子结构，Initializer 缓存成功或失败；不引入重置/异步管理器。Sequence 逐项构造输入、运行并接纳结果，各次输出独立。父子关系保存真实返回与接纳事实；returned 不等于 accepted。
- Context 保留真实 IO/异常引用，局部继续复用同一 Context；子调用每次新建。maxRounds 默认 1，仅允许 1/2。run.accept 只处理正常结果；exceptions.handle 按契约处理已声明异常。内核、绑定、未声明抛错、处理器错误不递归进入异常处理。已归属错误不能被业务 catch 清除。详见 [异常边界](docs/exceptions.md)。

## 内容、记录与变化

- Transcript 自行接纳并复制冻结消息，只有正式 append/startSegment 改变集合；消息 index 稳定，批量预检查失败不部分追加。Ref/RangeRef 是内部实体访问，记录只保存 UID、范围及版本，不持有活引用。原文仅含正式 user/assistant，不把选择输出当消息。详见 [原文与分段](docs/transcript.md)。
- Memories 独占 create/update 正式落实；先检查整批目标、内容和来源，再变更。更新保留 Memory 身份，无变化不占顺序号。业务依据从本轮固定快照、可见原文和 E 已接纳的保存凭据取得，不从 MemoryRecord 恢复。消息索引来源保留，文件创建来源以不可变 sourceResults 补充；模型只引用服务提供的 ID，不能构造凭据。历史创建不保证文件现状，也不强制每次保存形成记忆。下一轮使用更新后的记忆；当前不引入长期画像、召回、证据平台或记忆关系图。详见 [记忆](docs/memory.md)。
- 记录是预设的可选观测结果，不是观测唯一载体。Invocation、资源和内容生产者不依赖 Recorder；不装记录时运行仍成立。RecordingInstallation 持有 RecordingRootRecord；RuntimeCallRecord 是单次 R 调用。记录树为根→R调用→E→O/A。保留现有 wire kind:'runtime'，不因代码改名改变协议。
- Recorder 组合 RecordBook、RecordTree、同步登记与通知；Book 只持有引用并拒绝重复 ID。Tree 依据直接 parentId/childIds 查询，不重建调用索引。登记同步维护父子引用，失败只清理本次登记，不回滚业务事实。记录正文复制/检查/冻结，拒绝活实体、函数、循环等不受支持内容。
- InvocationRecording 局部持有调用记录句柄与父预设，不建立全局 Context→Record 查询。processes 与 relationChanges 分开；resultOf 只引用本记录直接正文，不跨轮/记录成链。InvocationBoundaryRecord 描述工作边界，不冒充实际交付。ResourceRecord 是写入载体的资源数据，ResourceObservation 才是实时观测事实。详见 [记录机制](docs/recording.md)。
- 生产者在变化落实时发布类型化事实；ChangeCapture<E> 是窄端口，ChangeBuffer 只缓冲/wait/take，不调用消费者。必要捕获严格失败，可选观察默认 isolate，可显式 propagate；已成立事实不回滚，也不触发重做业务。观测失败停用对应消费者，来源完整性独立处理。
- ObserverChange 只是当前服务环境的来源联合，不是内核全部事件类型。一个 ChangeConsumer 独占 take，向 RecordSource 和独立实体出口分发。记录来源缺失事实永久终止 SOURCE_INCOMPLETE，不能重拉基线假装修复；网络失败不破坏来源。不得比较全量快照反推增量。顺序、来源修订与交付游标各有边界，批次不宣称业务事务。详见 [观测增量](docs/observation-increments.md)。
- Transcript / Memories 的可选持久端口同步提交已预检查的变更，成功后才更新内存、发布进展与变化；记忆整批提交、整批落实后逐项通知，通知失败不留下半批事实。restore 静默恢复身份、顺序、分段及来源，不重放 append/create。SQLite 实现在服务 persistence 内，不进入 REOA 或 protocol。
- Observer 默认保存到被 Git 忽略的 `.capix/observer.sqlite`，可用 `CAPIX_DATA_DIR` 指定模型文件工作区之外的目录。单进程独占写入，启用 WAL/FULL；内容保存失败使服务不可接纳，不退化到仅内存。历史 RecordBook 只读，旧来源保留 open/sealed/incomplete 标记；每次启动新建记录安装与变化来源。旧 running 表示未取得结束记录，不伪造失败、不进入当前活动基线。详见 [持久化](docs/persistence.md)。

## 对话与交付

- Conversation 是服务持久内容身份，关联独立 Transcript/Memories 与可选记录来源，不等于 R 或 Submission。ObserverConversations 宿主持有共享 DB/provider/files，按对话装配运行与同步；新建内容原子保存，旧库迁成默认对话且保留原 ID/index。文件工作区仍共享。所有提交/接纳/观测明确目标，不设服务全局当前对话。
- ClientRuntime 的打开操作在目标有效基线后切换，失败保留旧对话；当前提交未确认结束或等待队列非空时不能新建/切换。入队固定对话身份，切换不取消业务、不销毁服务环境；旧消费与详情不能覆盖新作用域。App binding 同帧更新消息与图谱，草稿按对话保存；新建/历史/配置入口同区。详见 [对话](docs/conversations.md)。

- ConversationQueue 管理有界本地等待、当前提交和自动推进；本地 queueId 与一次 POST 的 submissionId 分开。ClientSubmission 接纳固定输入、远端事实并分别维护反馈和取消控制。成功入队不代表服务接纳，待发内容不进入正式消息集合；不因断流、取消 ACK、服务空闲或 release 放弃未知当前项来推进队列。
- 单轮失败或取消不暂停、清空后续消息；已确认结束后依据服务接纳事实自动推进。等待项只提供撤销，不要求用户暂停或恢复队列。服务明确未接纳且声明 retry:admission 时，保留同一本地项与顺序，确认可接纳后使用新提交身份尝试；结果未知只查询或跟随原身份，不能重 POST。
- 取消通过 submission 独立控制接口传给 R.run；cancelRequested 不等于 cancelled，运行真正退出才发布终态。停止当前只影响当前项，等待项仍自动处理。InvocationCancelled 绑定具体控制信号，已归属故障优先；既成内容保留，收尾不受取消阻断，不以 Promise.race 提前释放运行。
- ConversationRequest {messages} 是服务对话输入，不是通用 E 契约。正式接纳 1–501 条消息，末条为 user；忙碌返回409，不追加输入。回答追加后发 answer，记忆后处理前可见；completed 等 R.run 返回后发送。后处理失败保留回答。
- ConversationRuntimeDefinition / ConversationExecutionDefinition 组织选择、生成、记忆提取。业务复杂度在具体声明，绑定固定资源来源。消息同步与观测 Feed 独立连接/关闭；不观测仍能正常对话。
- 选择历史后，E 通过可替换决策 O 在已声明能力间有限推进，默认最多 8 步（允许 1–16）；目录含真实子声明的公开参数与可用条件，内部资源和输入仍由具体能力构造。默认策略仅在目标未定或候选需修正时调用理解模型；已接纳结果直接驱动下一步。文件预检 O/A 只检查命名路径元数据，显式 fileTask 跳过理解但不跳过预检；根内绝对候选可规范为相对路径。候选错误可同轮修正，真实异常不能回灌模型无限处理。task 仅在正式分支或澄清结论发布一次；回答先落实再保存，完成依赖真实交付与保存凭据，记忆是固定收尾。没有跨 QA 挂起或动态能力注册。
- 只有 GenerateAnswerDefinition 明确支持一次再次生成：完整模型返回被 INVALID_JSON/EMPTY_OUTPUT/OUTPUT_SHAPE 拒绝时，依据直接子调用证据与声明契约继续。第二轮只准备反馈请求、调用及接纳，不重复选择、上下文组装或回答追加。超时、网络、取消、非 stop 返回、捕获/记录错误不自动重试。
- 模型输出契约使用固定 Zod 严格 Schema，与 JSON Schema 同源；不 coerce/trim/default 掩盖非法输出。结构校验与动态引用/来源/容量规则分别由能力负责。选择保留模型优先级；请求装载按优先级保留完整前缀，第一条超限就失败，不跳过长消息凑容量。字节容量估算不是精确 tokenizer。
- GET /api/executions 为轻量概览，详情按需读取 ExecutionRecordSnapshot。原文独立基线与增量同步，客户端组合引用和已加载正文。未加载/缺失/错误/空值分开。来源失效不改写业务结果。详见 [协议](docs/protocol.md)、[客户端](docs/client-runtime.md)。

## 提交与反馈生命周期

- POST 对话使用 `{ conversationId, submissionId, input }`；ConversationSubmission 在服务侧持有任务和累计进展投影，连接只消费。内核只暴露被动调用/内容事实，服务绑定选择来源，服务投影解释 C/S 语义，不由记录推断业务。
- 对话过程消费被动 REOA 元数据，独立于 Recorder 和消息正文。activities 保留子调用状态与父层接纳事实，独立完整性失效不改写提交结果；单次最多 512 个调用位置。客户端最多保留 32 笔已跟踪提交快照，应用按正式输入定位关联过程，不从文本或记录反推。
- 输入与回答正式写入、R.run 实际返回/抛错、投影完整性、反馈连接和实体同步分别表达。断线只解除消费，不取消服务运行；反馈故障不回写 Context，不导致业务重做。
- 服务接纳状态 ready/busy/unavailable 与提交结果独立，由服务根据实际占用、配置和已知必要能力状态投影。结束反馈可以附带当时状态，按需查询取得当前状态；ready 不预占、不保证下次模型成功，POST 仍做最终接纳检查。查询不触发惰性 Provider 构造或真实模型请求；可选观测失效不代表对话入口失效。
- 服务仅有界保留进程内提交；查询/follow 恢复反馈，不恢复执行。内容与记录可跨重启读取，但提交身份未持久化，不承诺幂等重提或重启后继续跟踪旧提交。客户端只发送一次，重连不重新 POST；未知/淘汰提交不证明未执行。未确认结果时默认阻止新提交，用户可显式结束本地跟踪，不能称为取消。

## 编码、界面与验证

- 每条变量声明只声明一个变量；循环直接表达继续/结束条件，不使用 while(true) 再内部 break。流读取以 done 结束，异常和提前退出仍释放资源。
- 类自身 ID 直接生成；不为 ID 创建无意义别名。不为每次检查创建包装层。按概念/动作组织目录，不用连字符机械拼接功能文件名；工具固定文件名除外。
- 通用操作优先使用 es-toolkit@1.52.0 公开入口，不建通用 Utils/转发层。标准类型谓词用 predicate/compat；对象身份、严格记录正文、getter 隔离、循环和预算规则保留专用语义。只为真实需求引入深合并或克隆，不用通用函数覆盖正式接纳。
- RuntimeError 是通用诊断，不是 R 层专属错误。错误格式保留 code/message/name/stack/cause/复合 errors；标准错误字段逐项安全读取并捕获访问异常，允许继承的 name；诊断 detail 不执行 getter/toJSON。保持现有转换预算，不单独创建错误记录或无限错误恢复。错误机制自身损坏属于 bug。
- Observer 为黑灰主题；10/12/14/16px 字号，主标题20px。问答导航固定块宽并独立滚动；主图轮间等宽，默认按直接归属与同级顺序展示可折叠调用树，耗时作为独立辅助视图。离屏问答按视口卸载，详情按需加载；展开状态保留在应用层。颜色表达稳定操作类别，不映射时间；失败、运行中、选中以文字 tag 表达，不用状态彩色描边覆盖节点含义。累计被选次数用数字和局部短条，不用整块热度填色。上下文聚合关联，不重复消息全文。React + Vite + Tailwind，shadcn 源码组件留在 app 内。保留键盘可访问性，不用原生 title 遮挡节点。
- Node22.23.2、pnpm10.7.1、TypeScript6.0.3，外部直接依赖精确版本，内部 workspace:*。Prettier printWidth1000，不因窄行宽拆散签名。
- 运行改动所需检查；组织迁移需干净产物构建，验证公开出口、类型、原有回归、源码定位与格式。依赖身份变化更新锁文件并 frozen-lockfile 验证；普通测试不访问真实模型。
- 完成后报告变化、必要验证和真实限制。不要把历史方案当作当前 API，不保留同一语义的重复旧名或空壳包装来掩盖理解问题。
