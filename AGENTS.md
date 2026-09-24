# CAPiX Observer

这是独立的运行链路实验，不依赖或修改 CAPiX Runtime。

- Transcript 是原始交流内容的持有者，位于 server/transcript/transcript.ts，包含当前输入。提供 append/current(role)/get/ref/length/snapshot，只增不改删。写入时检查并复制冻结每条消息；get/current 返回同一不可变消息，snapshot(end) 只复制固定前缀数组。批量追加先全部检查再写入，不截断或改写原文。按角色 current 表示最新消息，不表示问答配对。MessageRef 用 Transcript 实例和绝对 index 定位消息，TranscriptRangeRef 表达固定的 [start,end)；读取不受后续追加影响。不继承 RuntimeRecord、不依赖 Book，不增加全局 Transcript ID、多环境仓库或持久化。
- Observer 的 Execution.input 是接纳后的只读 Message（role/content），不带 MessageRef、Transcript 或集合入口。ExecutionContext.transcriptRange 为进入执行时固定的 TranscriptRangeRef [activeStart,end)，包含本次输入；历史选择排除末条输入，执行期间追加内容不扩大范围。ExecutionContext.settings 固定本次配置的不可变浅快照，三次模型调用使用同一份；外部更新仅在下一次执行捕获。GenerationOutput 只是生成操作的 IO 契约。

- 前端临时使用 web/messages/draft.ts 的 MessageDraft 处理消息编辑、展示和提交数据，只依赖共享 Message 契约，不导入服务端 Transcript。前端检查仅提供编辑提示，正式接纳仍由服务端完成。不因两端复用而将运行实体移入 shared。

- 先有具体特性和可运行函数，再提炼复用；不提前引入 TRS、调度器或数据库。
- UI 必须消费执行产生的记录，不伪造真实模型结果或计时。
- Key 仅从服务端环境读取，不输出、导出或发送到前端；不读取其他项目凭证。
- 记录装载、容量检查、调用、解析、校验的真实输入、输出和停止位置。
- 保留输入契约、失败出口和必要测试；不要自动重试或静默截断。
- 使用固定 Node/pnpm 与精确依赖版本；不推送、部署或发布。
- 格式偏好：不按 100 字符强制拆行。Prettier 使用 printWidth: 1000，近似不限制常规代码行宽；保留代码块等结构换行，不为满足窄行宽拆散函数签名和调用参数。

- HTTP 接收 ExecutionRequest { messages }，先检查本次配置，再由 observer/accept.ts 的 acceptExecutionInput 向已有 Transcript 接纳 1–501 条新消息，最后一条 user 消息对象成为本次输入。接纳失败不部分追加、不创建执行记录。入口正在执行时返回 409，不排队也不追加消息。环境初始化、消息接纳和执行触发分别归属 observer/environment.ts、observer/accept.ts 与 Execution.call。
- 移除集中式 contracts.ts。observer/accept.ts 组合提交规则、Transcript 消息接纳和输入消息确定；消息规则仍归 Transcript，批量数量与末条 user 限制归提交边界。历史选择与回答生成在各自 output.ts 声明 { schema, accept } 配对输出契约，ModelOutputContract 类型位于 operations/model.ts。公共模型 after 只组合结束检查、JSON 解析、具体输出接纳。选择结果分别检查结构、引用并复制，保留模型给出的优先级顺序，回答严格检查 kind、不改写原内容。保持模型请求的 Schema，本地更严格的安全整数、非空白要求和动态引用范围由对应操作维护。value/object.ts 仅提供通用对象和字段判断；不建立审查管理器或新的结果实体类。

- Operation<I,BeforeOutput,CommitOutput,O> 为抽象类，持有 Runtime 和稳定实例 ID，提供 call 与抽象 before/commit/after；名称、说明和源码位置由具体类表达，构造不接收外部定义对象。ModelOperation 为模型 BCA 的抽象父类，接收 Runtime 和 Provider；SelectHistory、GenerateAnswer、ExtractMemory 子类自带 purpose/task/output 契约与 prepare 方法。AssembleContext 直接继承 Operation。输出契约继续在对应 output.ts 配对声明，由具体类采用，不由装配方注入。ObserverExecution 直接 new 四个具体操作。call 建立 OperationContext，按顺序建立 AttemptContext；输入、状态、结果只在每次调用的 Context 中。
- Execution<I,O> 为抽象类，call 通过公共 invoke/Runtime 建立 ExecutionContext，再调用具体 execute。ObserverExecution 是实验场景的固定流程实现，构造时持有 selection/assembly/generation/extraction 四个 Operation。操作构造依赖不再含 settings/signal；BCA 显式接收自己的 AttemptContext，使用 Runtime.getExecutionContext 取得所属执行的配置与信号，实例不保存 currentContext。不引入动态规划、Task、启动器、Pipeline 类或调度器。OperationRecordDefinition 仅用于记录创建。运行顺序为创建 Context → 创建 Record → 执行工作；beginOperation 直接读取现场 Operation 实例与父 Context，beginAttempt 接收阶段源码与参与者描述，创建记录时固化这些信息。不在 Context 保存 declaration，不增加实例关联表；完成/失败只根据 Context 找对应记录更新结果。
- `RuntimeRecord<T>` 只有 id/value。ExecutionRecord、OperationRecord 和 AttemptRecord 具有顶层只读状态 running/succeeded/failed，基类不增加状态。操作关系 executionId/operationInstanceId/parentOperationId 位于顶层；每次调用有独立操作 ID。输入输出为记录正文，不可变消息引用保留实例，不为每个中间值生成 Record。
- 一次 Operation.call 只创建一条 OperationRecord。BCA 每次阶段执行创建独立 AttemptRecord，继承 RuntimeRecord 而非 OperationRecord；顶层 operationId/phase/source/caller/callee，正文 input/output/error，不重复保存所属操作已有的 executionId/operationInstanceId/operation。OperationRecord 不再有 phase；parentOperationId 仅用于真正的嵌套操作。AttemptRecordHelper 位于 records/attempt/helper.ts，与 record.ts 配对，显式接收 Book 和按 operationId 装配的 RecordIndex。OperationRecord 结束前拒绝运行中的 AttemptRecord；Attempt 失败不自动结束操作。同阶段可有多条记录，但当前仍只执行一次串行 BCA，不实现自动重试。Context 与 Record 按三层对应，运行句柄使用 Context；Record 保存边界快照。EventRecord.callId 可指向三类记录；投影用 recordType 区分。
- `RecordBook` 仅提供 add/get/values，保存原记录引用、拒绝重复 ID。Book 不认识记录种类、索引、时钟、状态转换、事件、通知或导出。不得把特化流程重新放回 Book。
- `ExecutionRecordHelper`、`OperationRecordHelper`、`AttemptRecordHelper` 是各子记录的配对静态操作，显式接收 Book、索引等参数，组合创建、登记、关系查询、检查及结果写入。记录按概念分组，execution/record.ts 与 execution/helper.ts 配对，operation/record.ts 与 operation/helper.ts 配对，避免跨概念循环导入。实例 complete/fail 只负责正文与自身状态的原子顺序更新；跨对象归属和子操作检查位于配对操作，RuntimeRecorder 使用配对入口。
- `RecordIndex<R>` 是通用 selector → string key → IDs 实现；add 显式登记或重新索引、get 返回 ID 副本、remove 使用旧 key 清理。不持有正文、不调用 Book、不自动监听，不创建索引子类。当前由 observer/environment.ts 装配按 operation.executionId、attempt.operationId 的索引并传给 RuntimeRecorder/配对操作；查询和结束检查使用索引，不遍历 Book。状态索引暂不增加。
- 具体记录在输入、输出及错误边界复制冻结普通正文，保留不可变消息引用；正文成功写入后才切换状态，拒绝重复结束。保留当前不支持 undefined、循环引用、Map、函数等正文的限制。基类不施加冻结策略，执行过程普通值不被修改。
- records/value/snapshot.ts 只组合 copyContent → assertRecordContent → freezeContent；check.ts 承担记录正文类型及循环检查，freeze.ts 只冻结已检查的普通内容。保持先复制再检查的语义，不把正文类型策略混入冻结机制，不将业务契约检查放入快照函数。机制暂留 records/value/，不建立全局工具框架。
- `Clock` 通过 now() 提供现实时间、tick() 提供单调时间，由装配处传给 RuntimeRecorder；ExecutionRecordHelper.create 使用 now() 写 startedAt，EventRecordHelper 使用 now() 写 occurredAt、tick() 计算执行内偏移；单调计时起点仅由 RuntimeRecorder 按执行记录 ID 保存，序号取已登记事件记录，不维护事件正文副本。测试可以注入 Clock 子类，不默认引入定时器或后台循环。
- 调用边界记录统一为 records/event/record.ts 的 EventRecord，继承 RuntimeRecord<EventValue>，value.type 为 call/return/throw。id 是事件记录自身的 UUID；executionId/callId 指向执行及被描述的 E/O/A Record，sequence/occurredAt/offsetMs 是顶层只读元数据。它没有 Context、运行状态或执行能力。EventRecordHelper 配对负责创建、归属检查、登记及按执行查询；RecordBook 统一持有正文，eventIndex 只存 ID。删除 runtime/events.ts 和 ExecutionEvents 数组，不保存第二份事件记录。
- InvocationLifecycle 位于 invocation/lifecycle.ts，通用 invoke 位于 invocation/invoke.ts。begin/succeed/fail 同步处理边界，execute 可以异步；只有工作异常进入 fail，成功登记异常直接传播，失败登记再失败时 AggregateError 保留两个异常。observer/observe.ts 对已登记的工作失败返回快照，其余异常传播。handle 已改为 Context；记录是否完整另由 RuntimeRecorder.hasOutcome 判断，不用于决定工作状态。

- 运行上下文位于 server/context/：RuntimeContext<I, O> 基类持有自身 UUID、input 与 running/succeeded(output)/failed(error) 状态联合；ExecutionContext、OperationContext、AttemptContext 分别对应完整运行、Operation 调用和一次阶段函数执行。普通 IO 与异常保留原引用，允许非 JSON 值，不克隆或冻结正文；state 包装只读，complete/fail 拒绝重复结束。上下文实例字段只读，子类实例冻结不影响私有状态更新。操作辅助函数不创建上下文。
- ExecutionContext 持有配置浅快照、固定 TranscriptRangeRef 与本次 AbortSignal，范围包含输入末条，后续追加不改变 end。OperationContext 直接持有 executionContext: ExecutionContext；AttemptContext 直接持有 operationContext: OperationContext 与 phase。它们不重复保存归属 ID、配置或范围，不持有操作名称、源码、参与者描述或实例 ID。Runtime.getExecutionContext/getOperationContext 只读取这些引用，完成后仍可读取，不查询记录或登记表。Record 创建时从上下文引用取得 Context ID，再转换为 Record ID；parentOperationId 仅由创建现场传入的父 Context 形成记录关联。
- Runtime 组合调用生命周期，不持有 通用关系表、活动子调用集合或 Context 成员资格登记。当前固定串行流程通过逐层 await 保证结束顺序；保留父级已结束、嵌套操作属于不同执行及 Context 重复结束的直接检查。不提供手动提前结束父调用的通用保护，也不提供跨 Runtime 隔离。已有 RecordHelper 的记录完整性检查与登记错误传播保持不变，不把它们当作运行调度。无队列、权限体系、调度、重试或并行策略。
- RuntimeRecorder 位于 records/recorder.ts，持有 Book、索引、Clock 和记录事件；以 contextId 索引建立 Context → Record 映射。三种 Record 顶层增加 contextId，自身 ID 与 Context ID 不同；Record 的 executionId/operationId/parentOperationId 仍指对应 Record。记录查询归 Recorder/Book，不放入 Context/Operation。Recorder 不执行工作、不修改 Context。
- Runtime 可以不注入 Recorder，此时三层调用仍可执行，不受 JSON 记录正文限制。注入时 begin 登记失败阻止工作；工作完成先写 Context，再登记记录。结果登记失败向外抛出，不能把已成功的 Context 改为失败；原始工作异常留在 Context，仅在记录侧格式化。失败登记也失败由 invoke 的 AggregateError 保留二者。未完成记录不能冒充完整记录；不补造结束事件。仍未提供登记补偿、进程恢复或持久化。

- 错误仍内嵌于 value.error，没有独立 ID。errors/error.ts 定义 RuntimeError，支持 ErrorOptions.cause；shared/errors.ts 仅定义 RuntimeErrorValue 与 JSON 正文 RuntimeErrorDetail，不镜像异常类。formatError 保留 code/message/name/stack、cause、复合 errors；无 code 的原生异常使用 INTERNAL_ERROR，复合异常使用 AGGREGATE_ERROR，非 Error 抛出值使用 NON_ERROR_THROWN。detail 中不可记录的值转为带标记的普通数据，不执行 detail 的 getter/toJSON，不共享源引用。限制转换深度 12、值预算 2048、每集合 100 项、每字符串 16384 字符，超限有明确标记。记录 Helper 只消费正文，不依赖 RuntimeError。本轮不扩展独立错误记录、登记失败后的终止、发布或 HTTP 错误出口。

- 错误转换的调用入口为 errors/helper.ts 的 RuntimeErrorHelper.format。format.ts 组合识别、提取和字段映射；detail.ts 处理诊断内容，嵌套异常转换由参数提供。ErrorTraversal 仅管理一次转换共享的预算与递归路径，各调用独立，不是运行 ctx。限制集中于 traversal.ts，沿用现有格式化规则。主流程用输入输出明确的函数表达职责，状态显式传入，函数保持同一抽象层次；不逐行包装或引入通用转换框架。

- 文件按概念与动作分层，不用连字符拼接文件名，也不机械改成 camelCase：例如 operations/history/select.ts、operations/context/assemble.ts、shared/execution/project.ts。记录容器在 records/container/，正文操作在 records/value/，Runtime 支撑文件在 runtime/。工具规定的 pnpm-lock.yaml 等名称保持不变；已保存的运行记录不因源码整理被重写。测试命令使用 Node 内置测试运行器，按 test/**/*.test.mjs 递归匹配测试，排除辅助模块。

- 观测选择统一使用调用记录 ID，不为它另设节点 ID 别名；operationInstanceId 表示实际 Operation 实例的身份。时序事件直接使用 EventRecord，错误正文直接使用 RuntimeErrorValue，不另维护相同形状的视图契约。失败调用没有 output，诊断内容保留在 error.detail，不将错误详情伪装成操作输出。

- 观测服务于理解当前运行。不提供记录文件导入、导出和重放，不以独立解释、跨进程恢复或未来持久化要求增加当前链路不存在的对象。允许从已存在工作链路中提炼职责，避免由假设功能反向制造复杂度。
- ExecutionRecord.value 保存 input、settings 和可选 transcriptRange 范围引用；配置与普通消息正文按原记录策略复制冻结，TranscriptRangeRef 保留不可变范围引用，不复制整个集合。OperationRecord/AttemptRecord 不重复保存配置或范围，通过已有记录归属追溯。模型实际请求仍是 Attempt IO 的记录内容，不因执行配置已记录而省略。选中消息以普通内容和 index 组织为生成操作输入，不再包 MessageRef。
- ExecutionRecordHelper.snapshot 从 Book 与 operation/attempt/event 索引组织快照；EventRecord.toJSON 新建外层数据，正文不可变。RuntimeSnapshot.events 是 EventRecord 的查询输出，不是第二份存储。validateSnapshot 检查事件记录独立身份、执行归属、时间与边界一致性；不承担文件导入契约。
- HTTP 发布时用 transcript/observe.ts 的 observeTranscript 读取引用：输入 Message 直接显示 role/content，执行范围显示 start/end/messages。该函数无状态、不创建记录、不保存消息副本；浏览器收到的是本次观测所需的数据。前端继续提问只提交新消息；刷新从 GET /api/transcript 读取服务端消息。未引入引用解析服务、独立消息仓库或恢复机制。发布仍为完整观测更新，传输去重尚未实现。

- 反馈根和记录失败是否影响运行仍待共同设计，不更改现有异常传播策略。Context 与 Record 继续独立，Operation 实例的 id 在 Record 中以 operationInstanceId 关联，不保留 nodeId 别名。

- initializeObserver 在 HTTP 服务开始接收请求前创建进程内单个环境，持有 Transcript、Book、索引、Clock、Recorder、Runtime 和 ObserverExecution。允许传入已装载的 Transcript；初始化不接纳本次提交，不创建 Context/Record，不调用模型。环境与记录在多次请求间保留，退出进程后丢失；本轮不实现持久化、恢复、多环境管理或清空接口。
- 可调用实例与 Context 为 1:N，开启记录时 Context 与对应层 Record 为 1:1。ObserverExecution 与四个固定 Operation 跨调用复用，输入/输出/状态/配置/固定消息范围/取消信号属于本次 ExecutionContext。未来操作可以按需创建，本轮不提前抽象动态实例管理。 EventRecord 与被描述的调用 Record 为 N:1，不为事件记录虚构 Context；统计 Context 映射时仅包含 E/O/A。
- RuntimeRecorder.subscribe 只订阅已有观测发布，返回解除订阅函数。observer/observe.ts 通过 Execution.call 的可选 started 回调获得本次 Context ID，随后按执行记录 contextId 筛选并在 finally 解除订阅，不依赖 input 对象身份。started 在执行上下文建立后、首条记录发布前调用，用于绑定本次调用，不执行业务处理。直接 execution.call 仍返回工作输出并传播工作异常。
- 删除通用 Answer 类型，GenerationOutput 归生成操作的共享输出契约；不改变 kind/content 的模型输出，也不把分类强行加入 Message。过程变量使用 selectionOutput/assemblyOutput/generationOutput，GenerationInput 使用 message 与 selectedMessages，分别表达本次消息和选中消息；模型装载保留 message 的 role/content。

- BCA 统一为阶段 input 与对应 IO 类型的 AttemptContext；before 输出传给 commit，commit 输出直接传给 after，不组合 `{ raw, input }`。需要操作原始输入时通过 Runtime.getOperationContext 查询，执行配置与消息范围通过 getExecutionContext 查询。阶段内部辅助函数不创建上下文；不引入权限控制。

- 历史选择要求模型按相关性与必要性从高到低输出索引；本地校验引用合法性，不宣称可验证排序质量。组装保留优先级与完整原文。GenerateAnswer 在请求装载时按优先级纳入完整消息，遇到首条超限即停止，不跳过长消息凑容量；第一条就超限则失败。选定前缀在最终请求中按原始索引升序呈现，不改变 Transcript。当前输入、系统提示、Schema 与输出预留不能裁剪。候选请求与最终检查共用 operations/model/capacity.ts 的完整请求 UTF-8 字节估算，非精确 tokenizer；容量处理不增加摘要、额外模型调用或策略框架。选择操作装载当前段历史；下一轮开始前必要时切段，当前输入与记忆本身超限仍失败。现有生成 before 的 input/output 分别记录裁剪前候选与实际请求，不另存一份裁剪观测记录。

- 内部筛选结果只作为操作 IO 与运行记录保存，不自动追加为 Transcript 消息。Transcript 只接纳 user/assistant 原始消息；筛选不生成 summary，不建立摘要到原文的替换链路。后续方向为 Jev 筛选与使用计数，Jev 接入和热区装载尚未实现；不因这次撤销增加兼容或迁移层。

- 热区是已有记录的只读投影：observer/selection.ts 从指定 Transcript 的 ExecutionRecord 与指定筛选实例的 OperationRecord 推导每条消息被选次数及每次选择的索引。只计算成功筛选的已接纳 output，一次选择每个索引 +1；后续生成失败不撤销次数，失败/未结束的筛选不计入。空选择保留为空结果。计数不等于实际生成采用或回答正确，不写入 Transcript、不存第二份计数记录。GET /api/selection 按需从当前进程全部记录重算；web/selection/view.ts 提供累计颜色、按执行高亮及消息原文/调用来源，刷新可重新查询。未增加持久化、衰减、热区候选策略或模型调用。

- 消息关联计数由 operations/history/usage.ts 的 SelectionUsage 保留，用不可变 Message 实例作为 WeakMap 键，不在 Message 加字段，不读取 RecordBook。SelectHistory 实例持有 usage；ObserverExecution 在 selection.call 成功返回后按所选原始消息各累计一次，再进入组装/生成。后续失败不撤销次数；无 Recorder 时同样生效。计数不传给筛选或生成模型，提示词不解释或使用计数，不改变候选范围、索引排序或容量截断策略。观测累计次数仍从筛选记录推导；没有记录的独立运行不在热图中体现。新选择实例从零开始，不从旧记录恢复计数，不增加持久化、热切换或迁移。回答后的记忆提取按下述独立小闭环实现。

- 回答后处理：ObserverExecution 持有 MemoryCollection 和 ExtractMemory，正式 assistant 消息追加后同步调用 extraction，最后返回 generationOutput。ExtractMemory.after 先解析并接纳整批候选，再经 MemoryHelper 落实创建/更新，并在每次成功变更后记录。三次模型调用使用同一 ExecutionContext 的配置与信号；无后台队列、自动重试或吞错。
- Memory 是持续身份的运行事实，不继承 RuntimeRecord，不包含关系数组或历史版本列表。持有 Transcript 引用与当前 topic/content/sourceIndexes；update 保留同一实例和 ID，整份当前正文复制冻结后替换。只读 getter 不允许外部零散改写。MemoryCollection 仅 add/get/values 管理实例；MemoryHelper 显式接收容器、Transcript 和候选，先检查整批目标/正文，再落实变更。一个批次不重复更新同一记忆，不能跨 Transcript 更新。
- 提取输出 memories 是零到四项明确变更，每项 action(create/update)、memoryId(创建为null，更新为已有ID)、change(本次变化说明)、sourceIndexes(本次依据)、result(完整变更后 topic/content/sourceIndexes)。变化依据必须包含本轮消息；result 的依据包含本次依据；更新还可以继承该目标记忆的原有来源索引。检查和 Schema 配对归 operations/memory/output.ts。记忆体只接收 result，不持有 action/change 或调用记录 ID。不做模型生成内容的真假认证。
- 记忆候选接纳先校验结构、目标、引用和原始候选的重复更新；update.result 的 topic/content/sourceIndexes（含索引顺序）与本轮旧记忆完全一致时过滤为无操作，不修改记忆、不登记 MemoryRecord。不根据 change 声称“没变化”判等，不做措辞或语义归一化。仅剩余真实变更要求本轮依据；其他引用、目标与结构限制不放宽。commit 保留原始候选，after/操作输出仅含接纳变更。错误反馈与多次 attempt 的执行逻辑仍待设计，本轮不引入。
- MemoryRecord 继承 RuntimeRecord<MemoryRecordValue>，顶层 memoryId/executionId/operationId，value 为 action/change/sourceIndexes/result 的不可变快照。记录自身 ID 与记忆 ID、Context ID 分开；不增加前后记录指针，不用事后正文差异生成变化。records/memory/helper.ts 在变更落实后从现场 OperationContext 经 Recorder 找到对应调用记录，检查归属并登记到通用 RecordBook；Book 和 RuntimeRecorder 不增加记忆特化流程。按 memoryId 查询按 Book 实际登记顺序返回记录，目前没有专用索引。
- 运行事实与记录独立：不注入 Recorder 仍能创建/更新记忆，不产生 MemoryRecord。记录失败沿当前错误链传播，不假装事实回滚；整批语义/引用检查失败不改变任何记忆，但不承诺登记异常时批次原子性、补偿或恢复。提取失败仍保留之前已生成的回答。没有运行成功变更的候选只留在操作 IO 中，不产生 MemoryRecord。
- 下一次提取发送当前记忆体及来源索引，不沿引用加载旧原文，不读取历史 MemoryRecord，不把记录混进运行输入。MemoryInput 还包括本轮消息、正式回答和筛选候选原文；候选不宣称全部用于生成。每轮开始由 ObserverExecution 读取当前 Transcript 的 Memory.toJSON 正文快照 previousMemories；SelectionInput 显式包含 message/memories，SelectHistory 的短 C 提示词及实际请求使用这些记忆和原始 history。生成使用当前 message、选中原文和同一份 previousMemories，允许有限继承旧段理解。prepareMemoryInput 接收同一份 previousMemories（不重新读取更新中的实例），提取完成后更新 MemoryCollection，下一轮筛选读取新的记忆。记忆不插入 Transcript，不从 MemoryRecord 消费；全部内容纳入现有容量检查，整个请求超预算直接失败，不裁剪或压缩。
- GET /api/memory 只读投影当前记忆体和 Book 中已有 MemoryRecord，页面直接展示每次登记的变化说明、依据、结果快照和执行/操作记录 ID。MemoryRecord 不虚构 Context 或调用事件，不加入 E/O/A 时序节点；实际落实发生在提取操作的 after，沿该操作记录可以追踪。详细结构见 docs/memory.md。本轮不增加记忆层级分类或记忆之间的关系协议，不实现召回、持久化或恢复。

- QA 仅是执行观测视角：三行用户/助手/记忆体按执行对齐，单一 QA 选择同时控制 IO 详情、MemoryRecord 和调用时序。inspectExecutions 从既有操作读取回答，提取输入中的 currentIndexes 定位原消息；不按相邻索引或文本配对。失败轮保留空位；历史 QA 读当时的记忆记录快照。查询接口不创建记录，不引入 QA 运行实体、持久化或重放。

- 记忆提取以准确、可延续、修正过时认识、保留有效条件与不确定性、减少无意义重复为目标。理解的划分、粒度和综合方式由模型判断，不预设主题分类或抽象层级，不禁止基于已有记忆形成更综合的理解。保持现有 create/update 输出 Schema、ID 与原文索引校验；不把当前操作集合的局限当作知识组织原则。不承诺模型一定收敛到最优划分。

- Transcript 分段使用稳定绝对索引的边界，activeStart 指向当前段，segments() 返回历段。消息仍只有一份，不复制正文、不删除旧段。ObserverExecution.call 在创建本轮 Context 前，若完整筛选请求超限、仅当前输入和记忆可以容纳，则优先从最近两轮完整 QA 的起点开启新段，预算不足降为一轮、零轮；只调整边界，不复制消息。observer/segment.ts 仅从本次输入向前识别紧邻的 user/assistant 对，遇到不完整或非交替内容停止，不跨缺口或旧段补齐。旧 Context/Record 范围不变。提取只加载本轮 QA 与当前段选中原文；更新 result 可保留该目标记忆已有的旧来源，本次变化依据必须来自可见原文并包含本轮消息。不开后台压缩，不额外调用模型。详见 docs/transcript.md。
