# CAPiX Observer

这是独立的运行链路实验，不依赖或修改 CAPiX Runtime。

- Transcript 是原始交流内容的持有者，位于 server/transcript/transcript.ts，包含当前输入。提供 append/current(role)/get/ref/length/snapshot，只增不改删。写入时检查并复制冻结每条消息；get/current 返回同一不可变消息，snapshot(end) 只复制固定前缀数组。批量追加先全部检查再写入，不截断或改写原文。按角色 current 表示最新消息，不表示问答配对。MessageRef 用 Transcript 实例和绝对 index 定位消息，TranscriptRangeRef 表达固定的 [start,end)；读取不受后续追加影响。不继承 RuntimeRecord、不依赖 Book，不增加全局 Transcript ID、多环境仓库或持久化。
- Observer 的 Execution.input 是固定 MessageRef，output 是生成操作的 GenerationOutput；后者只是操作 IO 契约，不是独立运行实体。SelectionInput 为 query/historyRange，范围由 query.index 确定为 [0,index)；选择结果为绝对索引。GenerationInput 为 query/messages 引用，只有模型 before 装载时解析正文。EOA 使用共同的泛型 Context，但 IO 按各自语义异构；不把整个 Transcript 复制进各层，不重复增加 query/answer 字段。

- 前端临时使用 web/messages/draft.ts 的 MessageDraft 处理消息编辑、展示和提交数据，只依赖共享 Message 契约，不导入服务端 Transcript。前端检查仅提供编辑提示，正式接纳仍由服务端完成。不因两端复用而将运行实体移入 shared。

- 先有具体特性和可运行函数，再提炼复用；不提前引入 TRS、调度器或数据库。
- UI 必须消费执行产生的记录，不伪造真实模型结果或计时。
- Key 仅从服务端环境读取，不输出、导出或发送到前端；不读取其他项目凭证。
- 记录装载、容量检查、调用、解析、校验的真实输入、输出和停止位置。
- 保留输入契约、失败出口和必要测试；不要自动重试或静默截断。
- 使用固定 Node/pnpm 与精确依赖版本；不推送、部署或发布。
- 格式偏好：不按 100 字符强制拆行。Prettier 使用 printWidth: 1000，近似不限制常规代码行宽；保留代码块等结构换行，不为满足窄行宽拆散函数签名和调用参数。

- HTTP 接收 ExecutionRequest { messages }，先检查本次配置，再由 observer/accept.ts 的 acceptExecutionInput 向已有 Transcript 接纳 1–501 条新消息，最后一条 user 消息的 MessageRef 成为本次输入。接纳失败不部分追加、不创建执行记录。入口正在执行时返回 409，不排队也不追加消息。不再使用 acceptQuery/runQuery 或 query/ 组织启动职责。
- 移除集中式 contracts.ts。observer/accept.ts 组合提交规则、Transcript 消息接纳和 MessageRef 创建；消息规则仍归 Transcript，批量数量与末条 user 限制归提交边界。历史选择与回答生成在各自 output.ts 声明 { schema, accept } 配对输出契约，ModelOutputContract 类型位于 operations/model.ts。公共模型 after 只组合结束检查、JSON 解析、具体输出接纳。选择结果分别检查结构、引用并复制排序，回答严格检查 kind、不改写原内容。保持模型请求的 Schema，本地更严格的安全整数、非空白要求和动态引用范围由对应操作维护。value/object.ts 仅提供通用对象和字段判断；不建立审查管理器或新的结果实体类。

- Operation<I,P,R,O> 已改为抽象类，自身持有静态定义、Runtime 和稳定实例 ID，提供 call 及抽象 before/commit/after；不另设 Node 或包装器。call 建立 OperationContext，按顺序为 BCA 建立 AttemptContext。具体 ModelOperation/AssembleContext 实现阶段方法，原工厂返回 ModelOperation 实例。输入、状态、结果只在每次调用的 Context 中。
- Execution<I,O> 为抽象类，call 通过公共 invoke/Runtime 建立 ExecutionContext，再调用具体 execute。ObserverExecution 是实验场景的固定流程实现，构造时持有 selection/assembly/generation 三个 Operation。操作构造依赖不再含 settings/signal；BCA 显式接收本次 ExecutionContext，读取该次配置与信号，实例不保存 currentContext。不引入动态规划、Task、启动器、Pipeline 类或调度器。静态 OperationDefinition 与记录创建用 OperationRecordDefinition 不混用。
- `RuntimeRecord<T>` 只有 id/value。ExecutionRecord、OperationRecord 和 AttemptRecord 具有顶层只读状态 running/succeeded/failed，基类不增加状态。操作关系 executionId/operationInstanceId/parentOperationId 位于顶层；每次调用有独立操作 ID。输入输出为记录正文，不可变消息引用保留实例，不为每个中间值生成 Record。
- 一次 Operation.call 只创建一条 OperationRecord。BCA 每次阶段执行创建独立 AttemptRecord，继承 RuntimeRecord 而非 OperationRecord；顶层 operationId/phase/source/caller/callee，正文 input/output/error，不重复保存所属操作已有的 executionId/operationInstanceId/operation。OperationRecord 不再有 phase；parentOperationId 仅用于真正的嵌套操作。AttemptRecordHelper 位于 records/attempt/helper.ts，与 record.ts 配对，显式接收 Book 和按 operationId 装配的 RecordIndex。Operation 结束前拒绝运行中的 Attempt；Attempt 失败不自动结束操作。同阶段可有多条记录，但当前仍只执行一次串行 BCA，不实现自动重试。Context 与 Record 按三层对应，运行句柄使用 Context；Record 保存边界快照。RecordEvent.callId 可指向三类记录；投影用 recordType 区分。
- `RecordBook` 仅提供 add/get/values，保存原记录引用、拒绝重复 ID。Book 不认识记录种类、索引、时钟、状态转换、事件、通知或导出。不得把特化流程重新放回 Book。
- `ExecutionRecordHelper`、`OperationRecordHelper`、`AttemptRecordHelper` 是各子记录的配对静态操作，显式接收 Book、索引等参数，组合创建、登记、关系查询、检查及结果写入。记录按概念分组，execution/record.ts 与 execution/helper.ts 配对，operation/record.ts 与 operation/helper.ts 配对，避免跨概念循环导入。实例 complete/fail 只负责正文与自身状态的原子顺序更新；跨对象归属和子操作检查位于配对操作，RuntimeRecorder 使用配对入口。
- `RecordIndex<R>` 是通用 selector → string key → IDs 实现；add 显式登记或重新索引、get 返回 ID 副本、remove 使用旧 key 清理。不持有正文、不调用 Book、不自动监听，不创建索引子类。当前由 observer/environment.ts 装配按 operation.executionId、attempt.operationId 的索引并传给 RuntimeRecorder/配对操作；查询和结束检查使用索引，不遍历 Book。状态索引暂不增加。
- 具体记录在输入、输出及错误边界复制冻结普通正文，保留不可变消息引用；正文成功写入后才切换状态，拒绝重复结束。保留当前不支持 undefined、循环引用、Map、函数等正文的限制。基类不施加冻结策略，执行过程普通值不被修改。
- records/value/snapshot.ts 只组合 copyContent → assertRecordContent → freezeContent；check.ts 承担记录正文类型及循环检查，freeze.ts 只冻结已检查的普通内容。保持先复制再检查的语义，不把正文类型策略混入冻结机制，不将业务契约检查放入快照函数。机制暂留 records/value/，不建立全局工具框架。
- `Clock` 通过 now() 提供现实时间、tick() 提供单调时间，由装配处传给 RuntimeRecorder；ExecutionRecordHelper.create 使用 now() 写 startedAt，事件辅助函数使用 tick() 计算执行内偏移。测试可以注入 Clock 子类，不默认引入定时器或后台循环。
- 删除 ExecutionEntries 和 active 状态副本。事件尚未完整建模：暂以 runtime/events.ts 的 ExecutionEvents 保留时间起点和原 RecordEvent 数组，由 RuntimeRecorder 按执行记录 ID 持有。它没有记录副本或索引。配对静态操作只处理记录，RuntimeRecorder 在记录边界追加事件并发布快照；不把 RecordEvent 当作推进指令或引入事件总线。该结构是保留旧行为的明确临时落点，不是已经确认的新领域对象。
- InvocationLifecycle 位于 invocation/lifecycle.ts，通用 invoke 位于 invocation/invoke.ts。begin/succeed/fail 同步处理边界，execute 可以异步；只有工作异常进入 fail，成功登记异常直接传播，失败登记再失败时 AggregateError 保留两个异常。observer/observe.ts 对已登记的工作失败返回快照，其余异常传播。handle 已改为 Context；记录是否完整另由 RuntimeRecorder.hasOutcome 判断，不用于决定工作状态。

- 运行上下文位于 server/context/：RuntimeContext<I, O> 基类持有自身 UUID、input 与 running/succeeded(output)/failed(error) 状态联合；ExecutionContext、OperationContext、AttemptContext 分别对应完整运行、Operation 调用和一次阶段函数执行。IO 与异常保留原引用，允许非 JSON 值，不克隆或冻结正文；state 包装只读，complete/fail 拒绝重复结束。上下文实例字段只读，子类实例冻结不影响私有状态更新。操作辅助函数不新增 scope。
- ExecutionContext 持有固定的 settings 浅复制冻结快照（当前配置字段均为标量），及 Transcript/AbortSignal 原引用。模型依赖使用该 settings/signal；查询执行持有 query MessageRef，不保留 QueryInput 运行适配。OperationContext 持有 executionId、可选 parentOperationId 及声明；AttemptContext 只持有 operationId 和阶段声明。这里的归属 ID 均指 Context；不添加 prepared/raw，中间内容在各 Attempt 的 IO 中。局部变量仍用于顺序传递，不另存第二份结果。
- Runtime 只协调 live scope 与调用边界，用 WeakMap 保留归属和当前未结束子 scope 的引用；不遍历 Record、不维护运行内容仓库、不推导恢复流程。父级 Context 显式传入，拒绝外部 Runtime 的 Context、已结束父级和仍有子调用的结束操作。没有队列、调度、重试或并行策略。
- RuntimeRecorder 位于 records/recorder.ts，持有 Book、索引、Clock 和记录事件；以 contextId 索引建立 Context → Record 映射。三种 Record 顶层增加 contextId，自身 ID 与 Context ID 不同；Record 的 executionId/operationId/parentOperationId 仍指对应 Record。记录查询归 Recorder/Book，不放入 Context/Operation。Recorder 不执行工作、不修改 Context。
- Runtime 可以不注入 Recorder，此时三层调用仍可执行，不受 JSON 记录正文限制。注入时 begin 登记失败阻止工作；工作完成先写 Context，再登记记录。结果登记失败向外抛出，不能把已成功的 Context 改为失败；原始工作异常留在 Context，仅在记录侧格式化。失败登记也失败由 invoke 的 AggregateError 保留二者。未完成记录不能冒充完整记录；不补造结束事件。仍未提供登记补偿、进程恢复或持久化。

- 错误仍内嵌于 value.error，没有独立 ID。errors/error.ts 定义 RuntimeError，支持 ErrorOptions.cause；shared/errors.ts 仅定义 RuntimeErrorValue 与 JSON 正文 RuntimeErrorDetail，不镜像异常类。formatError 保留 code/message/name/stack、cause、复合 errors；无 code 的原生异常使用 INTERNAL_ERROR，复合异常使用 AGGREGATE_ERROR，非 Error 抛出值使用 NON_ERROR_THROWN。detail 中不可记录的值转为带标记的普通数据，不执行 detail 的 getter/toJSON，不共享源引用。限制转换深度 12、值预算 2048、每集合 100 项、每字符串 16384 字符，超限有明确标记。记录 Helper 只消费正文，不依赖 RuntimeError。本轮不扩展独立错误记录、登记失败后的终止、发布或 HTTP 错误出口。

- 错误转换的调用入口为 errors/helper.ts 的 RuntimeErrorHelper.format。format.ts 组合识别、提取和字段映射；detail.ts 处理诊断内容，嵌套异常转换由参数提供。ErrorTraversal 仅管理一次转换共享的预算与递归路径，各调用独立，不是运行 ctx。限制集中于 traversal.ts，沿用现有格式化规则。主流程用输入输出明确的函数表达职责，状态显式传入，函数保持同一抽象层次；不逐行包装或引入通用转换框架。

- 文件按概念与动作分层，不用连字符拼接文件名，也不机械改成 camelCase：例如 operations/history/select.ts、operations/context/assemble.ts、shared/execution/project.ts。记录容器在 records/container/，正文操作在 records/value/，Runtime 支撑文件在 runtime/。工具规定的 pnpm-lock.yaml 等名称保持不变；已保存的运行记录不因源码整理被重写。测试命令使用 Node 内置测试运行器，按 test/**/*.test.mjs 递归匹配测试，排除辅助模块。

- 观测选择统一使用调用记录 ID，不为它另设节点 ID 别名；operationInstanceId 表示实际 Operation 实例的身份。时序事件直接使用 RecordEvent，错误正文直接使用 RuntimeErrorValue，不另维护相同形状的视图契约。失败调用没有 output，诊断内容保留在 error.detail，不将错误详情伪装成操作输出。

- 观测服务于理解当前运行。不提供记录文件导入、导出和重放，不以独立解释、跨进程恢复或未来持久化要求增加当前链路不存在的对象。允许从已存在工作链路中提炼职责，避免由假设功能反向制造复杂度。
- EOA 记录直接持有不可变 MessageRef/TranscriptRangeRef，与运行共享同一份消息事实，不复制 Transcript 或保存独立来源范围。records/value/copy.ts 复制普通正文、保留这两类引用；检查和冻结将其视为不可变叶子，不遍历或冻结 Transcript。其他内容仍遵循原快照限制。
- ExecutionRecordHelper.snapshot 组合当前记录及边界事件，记录正文不可变，因此只新建外层结构和事件副本，不深复制已登记正文。RuntimeSnapshot 不包含 schemaVersion、implementation 或重放字段。validateSnapshot 只检查当前记录的身份、状态与事件一致性，不承担文件导入契约。
- HTTP 发布时用 transcript/observe.ts 的 observeTranscript 读取引用：消息显示 index/message，范围显示 start/end/messages。该函数无状态、不创建记录、不保存消息副本；浏览器收到的是本次观测所需的数据。前端继续提问只提交新消息；刷新从 GET /api/transcript 读取服务端消息。未引入引用解析服务、独立消息仓库或恢复机制。发布仍为完整观测更新，传输去重尚未实现。

- 本轮仅收敛可调用类的归属。反馈根和记录失败是否影响运行仍待共同设计，不更改现有异常传播策略。Context 与 Record 继续独立，Operation 实例 ID 使用 operationInstanceId，不保留 nodeId 别名。

- initializeObserver 在 HTTP 服务开始接收请求前创建进程内单个环境，持有 Transcript、Book、索引、Clock、Recorder、Runtime 和 ObserverExecution。允许传入已装载的 Transcript；初始化不接纳本次提交，不创建 Context/Record，不调用模型。环境与记录在多次请求间保留，退出进程后丢失；本轮不实现持久化、恢复、多环境管理或清空接口。
- 可调用实例与 Context 为 1:N，开启记录时 Context 与对应层 Record 为 1:1。ObserverExecution 与三个固定 Operation 跨调用复用，输入/输出/状态/配置/取消信号属于本次 Context。未来操作可以按需创建，本轮不提前抽象动态实例管理。
- RuntimeRecorder.subscribe 只订阅已有观测发布，返回解除订阅函数；不引入推进事件总线。observer/observe.ts 以本次新接纳 MessageRef 的引用身份筛选记录，finally 解除订阅；这是当前提交链路的观测适配，不是任意输入的通用执行接口。直接 execution.call 仍返回工作输出并传播工作异常。
- 删除通用 Answer 类型，GenerationOutput 归生成操作的共享输出契约；不改变 kind/content 的模型输出，也不把分类强行加入 Message。过程变量使用 selectionOutput/assemblyOutput/generationOutput，query 仅是局部内容字段。
