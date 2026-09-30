# CAPiX Observer

这是独立的运行链路实验，不依赖或修改 CAPiX Runtime。

## 工程边界

- 根 pnpm Workspace 下六个实际包：protocol、server/runtime、client/runtime、client/http、services/observer、apps/observer。包身份为 @capix-observer/protocol、runtime、client-runtime、client-http、service、app；跨包仅通过公开出口导入。protocol 无 Node/HTTP/UI 依赖；runtime 不依赖 service/app；client/runtime 只依赖 protocol 与通用工具，不依赖 React、服务端或应用；client/http 分别实现 ConversationTransport 与 ObservationTransport，只通过公开出口依赖 client/runtime 的接口及 protocol；app 依赖 protocol、client-runtime 和 client-http，不读取服务端内部类型。详细接口见 docs/protocol.md。
- 核心 EOA、Context、调用循环、Transcript、Memory 与记录保留在 server/runtime；具体筛选/回答/提取、模型请求/适配器、配置接纳与 HTTP 在 services/observer 组装。不为本次迁移提前重构运行语义或泛化现有 Context 配置。
- apps/observer 使用 React + Vite + Tailwind 和按需引入的 shadcn/ui 源码组件。基础 UI 组件只放应用内部，定制图谱自行实现；不建空壳组件包。协议只表达运行事实与记录，Trace、坐标、颜色、搜索和视口是应用内部投影。
- client/runtime 分别定义 ConversationTransport（config/transcript/run）和可选 ObservationTransport（overview/memory/execution/source/observe）。ClientRuntime.initialize 只加载业务配置与消息；业务状态为 messages/busy/pending/contextId/answered/error，observation 子状态保存 enabled/loading/error/overview/memory/records/updates。仅传入观测能力不自动使用；startObservation 显式开启，返回解除函数；取消观测不取消对话。client/http 的 HttpTransport 保持通用收发，ConversationHttpTransport 与 ObservationHttpTransport 两个子类分别接纳业务流与观测流。ClientRuntime 通过 conversation / observation 具名参数显式装配两种能力，挂载时开启观测。binding/data.ts 组织业务展示，binding/observation.ts 解释可选记录；projectConversation 只为已有消息关联观测入口，不从记录生成回答。Store 持有应用读模型与交互状态，React 不直接解析 RuntimeSnapshot。详情、源码按需加载，DOM 与弹层局部状态仍留组件。观测错误在图谱区域显示，不影响对话初始化、提交和消息刷新。详见 docs/client-runtime.md。
- GET /api/executions 是轻量 ObserverOverview，首次绘图不能循环读取所有完整快照；详情按 execution.id 加载。POST /api/run 使用 ConversationUpdate 的 started/answer/completed/error，回答在追加消息后交付、记忆后处理前可见；业务身份是 Context ID，不依赖记录。GET /api/observe 使用独立 ObservationUpdate 的 baseline/delta/error，连接结束不表示业务完成。不引入导入、导出、回放或持久化。
- 问答导航固定块宽且独立横向滚动；主图每轮等宽并有最低阅读宽度，密度不改变导航。轮内 EOA 才按时间比例，轮间不作统一时间比例。搜索完整 Q/A 正文，输入只高亮，显式导航才定位。上下文行展示消息与记忆关联，避免重复全文。
- 保留下面运行语义约定；文中未带包前缀的相对路径指各自所属包 src，具体操作与 observer 属于服务，核心类属于 runtime。

- Web 字号统一为 10/12/14/16px，页面与弹层主标题可用 20px；通过 CSS 字号变量复用，窄屏不再引入额外字号。
- Web 使用黑灰深色主题；EOA 仅以轮内宽度表达耗时；操作类别可使用稳定淡色，意图沿用父操作色，颜色不表达耗时。消息累计被选次数通过数字和局部短条展示，不使用整块热度填色。失败、运行中、选中以文字 tag 表达，不用彩色节点描边覆盖数值含义。图中节点不设置原生 title 提示，正文通过点击详情查看；保留 aria-label 与键盘可访问性。

- Transcript 是原始交流内容的持有者，位于 server/runtime/src/transcript/transcript.ts，包含当前输入。提供 append/current(role)/get/ref/length/snapshot，只增不改删。写入时检查并复制冻结每条消息；get/current 返回同一不可变消息，snapshot(end) 只复制固定前缀数组。批量追加先全部检查再写入，不截断或改写原文。按角色 current 表示最新消息，不表示问答配对。MessageRef 用 Transcript 实例和绝对 index 定位消息，TranscriptRangeRef 表达固定的 [start,end)；读取不受后续追加影响。不继承 BaseRecord、不直接依赖 Book；持有自身 ID 与环境注入的 Recorder，append/appendFrom/startSegment 在落实后登记 TranscriptRecord，不增加多环境仓库或持久化。
- Observer 的 Execution.input 是接纳后的只读 Message（role/content），不带 MessageRef、Transcript 或集合入口。ExecutionContext.transcriptRange 为进入执行时固定的 TranscriptRangeRef [activeStart,end)，包含本次输入；历史选择排除末条输入，执行期间追加内容不扩大范围。ExecutionContext.settings 固定本次配置的不可变浅快照，三次模型调用使用同一份；外部更新仅在下一次执行捕获。GenerationOutput 只是生成操作的 IO 契约。

- 前端在 apps/observer 内处理消息编辑、展示和提交数据，只依赖 protocol 的 Message 契约，不导入服务端 Transcript。前端检查仅提供编辑提示，正式接纳仍由服务端完成。不因两端复用而将运行实体移入 shared。

- 先有具体特性和可运行函数，再提炼复用；不提前引入 TRS、调度器或数据库。
- UI 必须消费执行产生的记录，不伪造真实模型结果或计时。
- Key 仅从服务端环境读取，不输出、导出或发送到前端；不读取其他项目凭证。
- 记录装载、容量检查、调用、解析、校验的真实输入、输出和停止位置。
- 保留输入契约、失败出口和必要测试；不要自动重试或静默截断。
- 使用固定 Node/pnpm 与精确依赖版本；不推送、部署或发布。
- 每条变量声明只声明一个变量；循环直接表达继续或结束条件，避免 `while (true)` 再依赖内部 break 退出。流读取以 reader 的 done 状态结束，异常和提前退出仍释放资源。
- 格式偏好：不按 100 字符强制拆行。Prettier 使用 printWidth: 1000，近似不限制常规代码行宽；保留代码块等结构换行，不为满足窄行宽拆散函数签名和调用参数。
- 通用数据操作采用 es-toolkit@1.52.0，按公开分类入口直接具名导入（es-toolkit/object、array、predicate 等）；后续遇到字段投影、排序、分组、去重、比较等需求先查已有能力，不再自建通用 Utils 类、转发层或内部工具库。不统一改写成链式或 fp 风格。基础类型判断只要库有同语义方法就统一使用，分类入口缺少的方法使用 compat 具名导入；简单展开、解构、原生 Map/Set 与领域类 instanceof 保留。
- 服务端标准类型分类统一优先使用 es-toolkit/predicate（isString/isNumber/isBoolean/isNull/isUndefined/isSymbol/isDate/isMap/isSet/isError），覆盖错误转换、Provider、消息/记忆接纳和记录正文。错误固定字段表与类型一起定义，zipObject 组合读取结果；仍逐字段安全读取，允许继承的 name，捕获访问异常。isNativeError 保留跨 realm 的原生错误识别；领域类身份仍用 instanceof。null/undefined 判断使用 isNull/isUndefined，不混用严格相等判断；数组、非空对象、有限数和安全整数使用 compat 的 isArray/isObjectLike/isFinite/isSafeInteger。isObjectLike 的库声明仅返回 boolean，value/object.ts 保留同一库函数引用并补充类型谓词，不重写实现。bigint 与严格原型规则没有同语义方法，保留原生判断，不改变接纳范围。任意诊断对象的属性转换不直接使用会触发 getter 的 mapValues/pick，保留描述符读取和特殊字段处理。
- 库未提供的重复组合判断归 server/runtime/src/value：isNonBlankString 检查字符串类型与非空白，不修改正文；非空白正则同时用于模型 Schema。isNonEmptyArray 检查数组与非空，hasUniqueItems 检查元素唯一（空数组合法，对象按引用比较）；元素类型和引用有效性仍归具体契约及实体。不为每个检查建立包装，不将纯判断与抛错、解析或数据整理混合。
- pick 用于明确的同名字段白名单，只读取自身属性；类的 status/value 等原型 getter 显式读取，字段重命名、条件缺省也显式表达。不用 Object.assign 批量初始化类以绕过只读字段及构造语义。sortBy/uniq 用于数据整理，不把非法重复索引静默去重后接纳。isEqual 只比较已明确的正文范围，记忆无变化仍要求 topic/content/有序 sourceIndexes 全部相同，不比较 Memory 实例身份或全部元数据。
- 保留领域方法的语义：记录快照维持 copy/check/freeze、Ref 身份及循环拒绝规则，错误转换保留访问器与预算规则；通用 cloneDeep/merge/isPlainObject 不直接替换它们。当前 isObject 不等同于库中的 isPlainObject。深合并必须在实际需求中明确覆盖、数组和可变性规则后使用。库的存在不提前引入 retry、调度或自动恢复。浏览器模块交由 Vite 构建，使用公开依赖，不复制库源码或暴露 node_modules。

- HTTP 接收 ExecutionRequest { messages }，先检查本次配置，再由 observer/accept.ts 的 acceptExecutionInput 向已有 Transcript 接纳 1–501 条新消息，最后一条 user 消息对象成为本次输入。接纳失败不部分追加、不创建执行记录。入口正在执行时返回 409，不排队也不追加消息。环境初始化、消息接纳和执行触发分别归属 observer/environment.ts、observer/accept.ts 与 Execution.call。
- 移除集中式 contracts.ts。observer/accept.ts 组合提交规则、Transcript 消息接纳和输入消息确定；消息规则仍归 Transcript，批量数量与末条 user 限制归提交边界。历史选择与回答生成在各自 output.ts 声明 { schema, accept } 配对输出契约，ModelOutputContract 类型位于 model/contract.ts。AcceptModelOutput 组合结束检查、JSON 解析和具体输出接纳。选择结果分别检查结构、引用并复制，保留模型给出的优先级顺序，回答严格检查 kind、不改写原内容。保持模型请求的 Schema，本地更严格的安全整数、非空白要求和动态引用范围由对应操作维护。value/object.ts 仅提供通用对象和字段判断；不建立审查管理器或新的结果实体类。
- 回答输出契约使用 zod@4.6.5 的 strictObject，同时生成 JSON Schema 与执行 safeParse；非空白 regex 同时进入提示 Schema 与本地检查，不改写正文。拒绝未知字段，不使用 coerce、default 或 trim 转换掩盖契约错误。成功返回新普通对象，失败映射为现有 RuntimeError(OUTPUT_SHAPE)，detail.issues 保留字段路径及原因。GenerationOutput 保持跨端纯数据声明，Schema 通过 ZodType 类型约束检查兼容性；不让 protocol 反向依赖服务端。记忆提取也使用 Zod：create/update 判别联合、严格正文、长度和非空白、非负安全整数与来源去重；uniqueItems 元数据与去重 refine 配对，MemoryExtraction 从 Schema 推导。目标 ID 的格式/动作组合错误为 OUTPUT_SHAPE，合法 ID 不存在或批内重复更新为 MEMORY_TARGET；来源范围/包含关系为 MEMORY_SOURCE。解析成功后再检查语义、过滤无变化、检查本轮依据，最后才落实变更；不重复复制已解析正文。历史筛选同样用 Zod 严格接纳，再检查本轮 Transcript 范围，保留优先级顺序与空结果；移除手写 Schema 和多余数组复制。model/schema.ts 仅复用模型输出的非空白文本和唯一索引规则，不建立校验管理器。settings.ts 用 Zod 接纳配置，保持只选取已知字段和原有数值边界，错误仍为 INVALID_SETTINGS；配置可忽略额外字段与模型输出严格拒绝额外字段的规则分开。不把动态引用、无变化过滤、运行实体或恢复策略塞进 Schema，不重复解析 Context、Transcript 或记录图。

- Operation<I,O> 为抽象执行类，持有注入的 OperationInvocationBuilder 和稳定实例 ID，提供 call 与特化 execute。具体操作直接组织具名 Attempt，没有固定数量、阶段枚举或阶段模板。SelectHistory 组织 PrepareModelRequest → InvokeModel → AcceptModelOutput；GenerateAnswer 先调用 AssembleContext 再组织这三个动作；ExtractMemory 在接纳后继续 ApplyMemory。ObserverExecution 持有 selection/generation/extraction 三个操作。输入、状态、结果只在每次调用的 Context 中。任务提示、请求构造和输出契约由具体操作定义，通用动作通过组合复用。
- Attempt<I,O> 为 attempt/attempt.ts 的抽象执行类，提供 call 和特化 execute，每次 call 自行创建 Invocation。具体类位于 attempt/model、attempt/context、attempt/memory，name/label/source/callee 由类自身声明；它们持有稳定依赖，不持有本次输入、Context 或结果。Operation 构造时创建所需实例，后续调用复用。每次 call 创建独立 AttemptContext，开启记录时对应独立 AttemptRecord。Attempt 是 E/O/A 最底层执行边界，只接受操作的 Invocation 作为父调用，由其 OperationContext 构造下级现场；内部函数不建立子 Attempt 或第四层执行实体/Context/Record。三层调用已接入 execute/receive 本地处理；当前具体业务仍默认一轮，不自动重发模型请求，不实现恢复或调度。
- Execution<I,O> 为抽象类，call/submit 在 Runtime.run 占用内通过 Invocation 建立 ExecutionContext，再调用具体 execute。ObserverExecution 是实验场景的固定流程实现，构造时持有 selection/generation/extraction 三个 Operation。操作构造依赖不再含 settings/signal；每个动作显式接收自己的 AttemptContext，使用 Runtime.getExecutionContext 取得所属执行的配置与信号，实例不保存 currentContext。不引入动态规划、Task、启动器、Pipeline 类或调度器。OperationRecordDefinition 仅用于记录创建。运行顺序为创建 Context → 创建 Record → 执行工作；beginOperation 直接读取现场 Operation 实例与父 Context，beginAttempt 从现场 Attempt 实例读取动作名称、标签、源码与参与者描述，创建记录时固化这些信息。不在 Context 保存 declaration，不增加实例关联表；完成/失败使用 Invocation 绑定的记录更新结果，不再按 Context ID 反查。
- `BaseRecord<T>` 持有 id/value 和只读直接归属 parentId。ExecutionRecord、OperationRecord 和 AttemptRecord 具有顶层只读状态 running/succeeded/failed，基类不增加状态。操作关系 executionId/operationInstanceId/parentOperationId 位于顶层；每次调用有独立操作 ID。输入输出为记录正文，不可变消息引用保留实例，不为每个中间值生成 Record。
- 一次 Operation.call 创建一条 OperationRecord，每次实际 Attempt.call 创建一条 AttemptRecord。AttemptRecord 继承 BaseRecord，顶层 operationId/name/label/source/caller/callee，正文 input/output/error；name 为动作名称字符串，不限于固定阶段集合。动作描述创建记录时从实例固化，Context 不携带描述。parentOperationId 仅用于真正的嵌套操作。AttemptRecordHelper 与 record.ts 配对，按操作需要显式接收 Recorder 或 Book。OperationRecord 结束前拒绝运行中的 AttemptRecord。一次 Attempt 失败不自动结束父操作；父操作仍按实际调用链处理异常。相同动作可以被显式调用多次，每次有独立 Context 和 Record；不自动重试。InvocationBoundaryRecord.callId 可指向三类记录，投影使用 recordType 区分并展示动作名称与标签。
- `RecordBook` 仅提供 add/get/values，保存原记录引用、拒绝重复 ID。Book 不认识记录种类、索引、时钟、状态转换、事件、通知或导出。不得把特化流程重新放回 Book。
- `ExecutionRecordHelper`、`OperationRecordHelper`、`AttemptRecordHelper` 是各子记录的配对静态操作，显式接收 Recorder、Book 等参数，组合创建、登记、关系查询、检查及结果写入。记录按概念分组，execution/record.ts 与 execution/helper.ts 配对，operation/record.ts 与 operation/helper.ts 配对，避免跨概念循环导入。实例 complete/fail 只负责正文与自身状态的原子顺序更新；跨对象归属和子操作检查位于配对操作；各层 Helper 组装 InvocationRecording，调用侧使用这些接线，Recorder 不做类型分派。
- 调用查询由 Invocation 的临时绑定与 RecordTree 的正式归属查询承担；InvocationRecordIndex、通用 RecordIndex 与登记索引接口均已移除，不为了旧 Context 重复登记检查保留全局映射。事件的前项查询在 InvocationBoundaryRecordHelper 中遍历执行子树，取 sequence 最大值；不把事件顺序策略放进通用树。
- 具体调用记录通过 InvocationRecord 共用状态、终态登记与内部 processes 追加；BaseRecord 基类持有 id/value/parentId，CompositeRecord 提供冻结的直接下级 childIds。具体记录在输入、输出及错误边界复制冻结普通正文，保留不可变消息引用；正文成功写入后才切换状态，拒绝重复结束。保留当前不支持 undefined、循环引用、Map、函数等正文的限制。基类不施加冻结策略，执行过程普通值不被修改。
- records/value/snapshot.ts 只组合 copyContent → assertRecordContent → freezeContent；check.ts 承担记录正文类型及循环检查，freeze.ts 只冻结已检查的普通内容。保持先复制再检查的语义，不把正文类型策略混入冻结机制，不将业务契约检查放入快照函数。机制暂留 records/value/，不建立全局工具框架。
- `Clock` 通过 now() 提供现实时间、tick() 提供单调时间，由装配处传给 Recorder；ExecutionRecordHelper.create 使用 now() 写 startedAt，InvocationBoundaryRecordHelper 使用 now() 写 occurredAt、tick() 计算执行内偏移；单调计时起点由 Runtime.recording 的 InvocationRecordHelper 私有保存，终态边界登记后释放；Observer 沿记录树判断执行归属，序号取已登记事件记录，不维护事件正文副本。测试可以注入 Clock 子类，不默认引入定时器或后台循环。
- 调用边界记录统一为 records/invocation-boundary/record.ts 的 InvocationBoundaryRecord，继承 BaseRecord<InvocationBoundaryValue>，value.type 为 call/return/throw。id 是事件记录自身的 UUID；executionId/callId 指向执行及被描述的 E/O/A Record，sequence/occurredAt/offsetMs 是顶层只读元数据。它没有 Context、运行状态或执行能力。InvocationBoundaryRecordHelper 配对负责创建、归属检查、登记及按执行查询；RecordBook 统一持有正文，事件查询沿执行子树进行。删除 runtime/events.ts 和 ExecutionEvents 数组，不保存第二份事件记录。
- Invocation 位于 invocation/invocation.ts，接收已经建立的 Context 与具名调用选项，一次性 run 统一入口检查、开始、局部循环、终态及记录错误边界。E/O/A 构造时分别注入复用的 Execution/Operation/AttemptInvocationBuilder；对应构造器组合各层 ContextBuilder 与记录 Helper，工作类只提供 execute/receive。Runtime 装配构造器并让渡明确能力，不增加分层 Invocation 子类。旧 invoke/InvocationLifecycle 已移除，调用测试同样使用 Invocation。observer/observe.ts 对已登记的工作失败返回快照，其余异常传播。

- 调用上下文位于 server/runtime/src/context/：InvocationContext<I, O> 基类持有自身 UUID、input 与 running/succeeded(output)/failed(error) 状态联合；ExecutionContext、OperationContext、AttemptContext 分别对应完整运行、Operation 调用和一次具名动作执行。普通 IO 与异常保留原引用，允许非 JSON 值，不克隆或冻结正文；state 包装只读，complete/fail 拒绝重复结束。上下文实例字段只读，子类实例冻结不影响私有状态更新。操作辅助函数不创建上下文。
- ExecutionContext 持有配置浅快照、固定 TranscriptRangeRef 与本次 AbortSignal，范围包含输入末条，后续追加不改变 end。OperationContext 直接持有 executionContext: ExecutionContext；AttemptContext 直接持有 operationContext: OperationContext。它们不重复保存归属 ID、配置或范围，不持有操作名称、源码、参与者描述或实例 ID。Runtime.getExecutionContext/getOperationContext 只读取这些引用，完成后仍可读取，不查询记录或登记表。Record 创建时从上下文引用取得 Context ID，再转换为 Record ID；parentOperationId 仅由创建现场传入的父 Context 形成记录关联。
- Invocation 组合调用生命周期；Runtime 管理持续内容与顶层运行占用，不持有通用关系表、活动子调用集合或 Context 成员资格登记。当前固定串行流程通过逐层 await 保证结束顺序；保留父级已结束、嵌套操作属于不同执行及 Context 重复结束的直接检查。不提供手动提前结束父调用的通用保护，由 ExecutionContextBuilder 绑定的调用现场拒绝跨构造范围使用，不扩展为权限隔离体系。已有 RecordHelper 的记录完整性检查与登记错误传播保持不变，不把它们当作运行调度。无队列、权限体系、调度、重试或并行策略。
- Recorder 位于 records/recorder.ts，组合 Book、RecordTree、同步 RecordRegistration、Clock 和通用订阅者，提供 add/update/subscribe。add 统一检查并落实记录及直接父子引用，失败清理本次登记；update 检查对象登记身份后执行特化更新。Recorder 不依赖 Context、E/O/A、消息、记忆或 RuntimeSnapshot，不执行工作、不修改 Context。Context → Record 绑定归 Invocation，计时和过程记录规则归 records/invocation；各层 Helper 组合本层创建与结束规则。详见 docs/recording.md。
- Runtime 可以不注入 Recorder，此时三层调用仍可执行，不受 JSON 记录正文限制。注入时 begin 登记失败阻止工作；工作完成先写 Context，再登记记录。结果登记失败向外抛出，不能把已成功的 Context 改为失败；原始工作异常留在 Context，仅在记录侧格式化。失败登记也失败由 Invocation 的 AggregateError 保留二者。未完成记录不能冒充完整记录；不补造结束事件。仍未提供登记补偿、进程恢复或持久化。

- 错误仍内嵌于 value.error，没有独立 ID。errors/error.ts 定义 RuntimeError，支持 ErrorOptions.cause；protocol/src/errors.ts 仅定义 RuntimeErrorValue 与 JSON 正文 RuntimeErrorDetail，不镜像异常类。formatError 保留 code/message/name/stack、cause、复合 errors；无 code 的原生异常使用 INTERNAL_ERROR，复合异常使用 AGGREGATE_ERROR，非 Error 抛出值使用 NON_ERROR_THROWN。detail 中不可记录的值转为带标记的普通数据，不执行 detail 的 getter/toJSON，不共享源引用。限制转换深度 12、值预算 2048、每集合 100 项、每字符串 16384 字符，超限有明确标记。记录 Helper 只消费正文，不依赖 RuntimeError。本轮不扩展独立错误记录、登记失败后的终止、发布或 HTTP 错误出口。

- 错误转换的调用入口为 errors/helper.ts 的 RuntimeErrorHelper.format。format.ts 组合识别、提取和字段映射；detail.ts 处理诊断内容，嵌套异常转换由参数提供。ErrorTraversal 仅管理一次转换共享的预算与递归路径，各调用独立，不是运行 ctx。限制集中于 traversal.ts，沿用现有格式化规则。主流程用输入输出明确的函数表达职责，状态显式传入，函数保持同一抽象层次；不逐行包装或引入通用转换框架。

- 文件按概念与动作分层，不用连字符拼接文件名，也不机械改成 camelCase：例如 operations/history/select.ts、attempt/context/assemble.ts、apps/observer/src/observation/project.ts。记录容器在 records/container/，正文操作在 records/value/，Runtime 支撑文件在 runtime/。工具规定的 pnpm-lock.yaml 等名称保持不变；已保存的运行记录不因源码整理被重写。测试命令使用 Node 内置测试运行器，按 test/**/*.test.mjs 递归匹配测试，排除辅助模块。

- 观测选择统一使用调用记录 ID，不为它另设节点 ID 别名；operationInstanceId 表示实际 Operation 实例的身份。时序事件直接使用 InvocationBoundaryRecord，错误正文直接使用 RuntimeErrorValue，不另维护相同形状的视图契约。失败调用没有 output，诊断内容保留在 error.detail，不将错误详情伪装成操作输出。

- 观测服务于理解当前运行。不提供记录文件导入、导出和重放，不以独立解释、跨进程恢复或未来持久化要求增加当前链路不存在的对象。允许从已存在工作链路中提炼职责，避免由假设功能反向制造复杂度。
- ExecutionRecord.value 保存 input、settings 和可选 transcriptRange 范围引用；配置与普通消息正文按原记录策略复制冻结，TranscriptRangeRef 保留不可变范围引用，不复制整个集合。OperationRecord/AttemptRecord 不重复保存配置或范围，通过已有记录归属追溯。模型实际请求仍是 Attempt IO 的记录内容，不因执行配置已记录而省略。选中消息以普通内容和 index 组织为生成操作输入，不再包 MessageRef。
- ExecutionRecordHelper.snapshot 从 Recorder 的 Book 与 RecordTree 组织快照，事件显式按执行内 sequence 排序；InvocationBoundaryRecord.toJSON 新建外层数据，正文不可变。RuntimeSnapshot.events 是 InvocationBoundaryRecord 的查询输出，不是第二份存储。validateSnapshot 检查事件记录独立身份、执行归属、时间与边界一致性；不承担文件导入契约。
- HTTP 发布时用 transcript/observe.ts 的 observeTranscript 读取引用：输入 Message 直接显示 role/content，执行范围显示 start/end/messages。该函数无状态、不创建记录、不保存消息副本；浏览器收到的是本次观测所需的数据。前端继续提问只提交新消息；刷新从 GET /api/transcript 读取服务端消息。未引入引用解析服务、独立消息仓库或恢复机制。首次观测发送基线，后续发送已明确捕获的增量；引用序列化不负责发现变化。

- 反馈根和记录失败是否影响运行仍待共同设计，不更改现有异常传播策略。Context 与 Record 继续独立，Operation 实例的 id 在 Record 中以 operationInstanceId 关联，不保留 nodeId 别名。

- initializeObserver 在接收请求前装配一个共享 Recorder、Book 与 Clock，再创建 Runtime 和 ObserverExecution；Runtime.recording 使用共享 Recorder 组织调用记录。可提供初始消息数组，经 runtime.context.transcript 正常接纳并记录；不接受已有 Transcript 实例，不将初始化当作恢复导入。transcript 仅为 runtime.context.transcript 的同一引用。默认空环境建立一条 RuntimeRecord，没有执行记录，不调用模型。
- 可调用实例与 Context 为 1:N，开启记录时 Context 与对应层 Record 为 1:1。ObserverExecution、三个具体 Operation 及各自所需 Attempt 实例跨调用复用，输入/输出/状态/配置/固定消息范围/取消信号属于本次 ExecutionContext。未来操作可以按需创建，本轮不提前抽象动态实例管理。 InvocationBoundaryRecord 与被描述的调用 Record 为 N:1，不为事件记录虚构 Context；统计 Context 映射时仅包含 E/O/A。
- Recorder.subscribe 订阅记录 add/update 通知，隔离订阅者异常并返回解除函数；observer/observe.ts 的 subscribeExecutions 负责从调用边界和过程更新组织执行快照，不将内容变化伪装为调用事件。observer/observe.ts 通过 Execution.submit 的可选 started 回调获得本次 Context ID，随后按执行记录 contextId 筛选并在 finally 解除订阅，不依赖 input 对象身份。started 在执行上下文建立后、首条记录发布前调用，用于绑定本次调用，不执行业务处理。直接 execution.call 仍返回工作输出并传播工作异常。
- 删除通用 Answer 类型，GenerationOutput 归生成操作的共享输出契约；不改变 kind/content 的模型输出，也不把分类强行加入 Message。过程变量按对应操作命名，例如 selectionOutput/generationOutput。GenerationInput 使用 selection 与 memories；内部 AssembleContext 产生 message 与 selectedMessages，分别表达本次消息和选中消息；模型装载保留 message 的 role/content。

- BCA 仅作为分析一系列动作的视角，不作为运行接口、阶段枚举或记录分类。运行结构为 E → O → A，Operation.execute 显式组织任意数量的具名动作，IO 可以异构。需要操作原始输入时通过 Runtime.getOperationContext 查询，执行配置与消息范围通过 getExecutionContext 查询。普通辅助函数不创建上下文；不引入权限控制。

- 历史选择要求模型按相关性与必要性从高到低输出索引；本地校验引用合法性，不宣称可验证排序质量。组装保留优先级与完整原文。GenerateAnswer 通过 AssembleContext 取得选中原文，再在请求装载时按优先级纳入完整消息，遇到首条超限即停止，不跳过长消息凑容量；第一条就超限则失败。选定前缀在最终请求中按原始索引升序呈现，不改变 Transcript。当前输入、系统提示、Schema 与输出预留不能裁剪。候选请求与最终检查共用 model/capacity.ts 的完整请求 UTF-8 字节估算，非精确 tokenizer；容量处理不增加摘要、额外模型调用或策略框架。选择操作装载当前段历史；下一轮开始前必要时切段，当前输入与记忆本身超限仍失败。生成 PrepareModelRequest 的 input/output 分别记录裁剪前候选与实际请求，不另存一份裁剪观测记录。

- 内部筛选结果只作为操作 IO 与运行记录保存，不自动追加为 Transcript 消息。Transcript 只接纳 user/assistant 原始消息；筛选不生成 summary，不建立摘要到原文的替换链路。后续方向为 Jev 筛选与使用计数，Jev 接入和热区装载尚未实现；不因这次撤销增加兼容或迁移层。

- 热区是已有记录的只读投影：observer/selection.ts 从指定 Transcript 的 ExecutionRecord 与selection 角色的 OperationRecord 推导每条消息被选次数及每次选择的索引。只计算成功筛选的已接纳 output，一次选择每个索引 +1；后续生成失败不撤销次数，失败/未结束的筛选不计入。空选择保留为空结果。计数不等于实际生成采用或回答正确，不写入 Transcript、不存第二份计数记录。GET /api/executions 的只读概览汇总当前进程筛选记录；apps/observer 的上下文行与详情展示计数和本轮引用，刷新可重新查询。未增加持久化、衰减、热区候选策略或模型调用。

- 消息关联计数由 server/runtime/src/transcript/usage.ts 的 SelectionUsage 保留，用不可变 Message 实例作为 WeakMap 键，不在 Message 加字段，不读取 RecordBook。RuntimeContext 持有 selectionUsage；ObserverExecution 在 selection.call 成功返回后按所选原始消息各累计一次，再进入组装/生成。后续失败不撤销次数；无 Recorder 时同样生效。计数不传给筛选或生成模型，提示词不解释或使用计数，不改变候选范围、索引排序或容量截断策略。观测累计次数仍从筛选记录推导；没有记录的独立运行不在热图中体现。同一 RuntimeContext 更换选择实例保留计数，createRuntime 新建范围从零开始；不从旧记录恢复计数，不增加持久化或迁移。回答后的记忆提取按下述独立小闭环实现。

- 回答后处理：Runtime 通过 context 持有 Transcript、Memories 和累计选择观测值；ObserverExecution 持有 ExtractMemory，正式 assistant 消息追加后同步调用 extraction，最后返回 generationOutput。ExtractMemory 先通过 AcceptModelOutput 接纳整批候选，再通过独立 ApplyMemory 动作调用 runtime.context.memories.apply 落实创建/更新，Memories 在每次成功变更后自行记录。接纳成功与落实失败可分别观察，合法候选保留在接纳动作输出中。三次模型调用使用同一 ExecutionContext 的配置与信号；无后台队列、自动重试或吞错。
- Memory 是持续身份的运行内容，不继承 BaseRecord，不包含关系或历史版本列表。Memories 绑定 Runtime 的 Transcript，独占正式创建与更新入口 apply，先检查整批动作、目标、正文与依据再落实。对外 Memory 只有只读内容与 snapshot/toJSON；包内更新保留对象和 ID，当前正文复制冻结。同批不重复更新目标，无变化不登记，不跨 Runtime 更新。删除 MemoryCollection 和 MemoryHelper。
- 提取输出 memories 是零到四项明确变更，每项 action(create/update)、memoryId(创建为null，更新为已有ID)、change(本次变化说明)、sourceIndexes(本次依据)、result(完整变更后 topic/content/sourceIndexes)。变化依据必须包含本轮消息；result 的依据包含本次依据；更新还可以继承该目标记忆的原有来源索引。检查和 Schema 配对归 operations/memory/output.ts。记忆体只接收 result，不持有 action/change 或调用记录 ID。不做模型生成内容的真假认证。
- 记忆候选接纳先校验结构、目标、引用和原始候选的重复更新；update.result 的 topic/content/sourceIndexes（含索引顺序）与本轮旧记忆完全一致时过滤为无操作，不修改记忆、不登记 MemoryRecord。不根据 change 声称“没变化”判等，不做措辞或语义归一化。仅剩余真实变更要求本轮依据；其他引用、目标与结构限制不放宽。InvokeModel 保留原始候选，AcceptModelOutput/操作输出仅含接纳变更。错误反馈与多次 attempt 的执行逻辑仍待设计，本轮不引入。
- MemoryRecord 继承 BaseRecord<MemoryRecordValue>，持有 memoryId，value 为 action/change/sourceIndexes/result。由 Memories 在变化落实后调用共享 Recorder 登记；可选 contextId/callId/executionId/operationId 表示实际因果调用，调用外变化不伪造归属。InvocationRecordHelper.source 在调用侧解析来源链接，ChangeSource 携带已确定的 contextId/callId/executionId/operationId；内容审查和通用 Recorder 不查询调用关系。MemoryRecordHelper 负责构造记录与按 memoryId 查询，Memories 自行交给 Recorder 登记。
- 运行事实与记录独立：不注入 Recorder 仍能创建/更新记忆，不产生 MemoryRecord。记录失败沿当前错误链传播，不假装事实回滚；整批语义/引用检查失败不改变任何记忆，但不承诺登记异常时批次原子性、补偿或恢复。提取失败仍保留之前已生成的回答。没有运行成功变更的候选只留在操作 IO 中，不产生 MemoryRecord。
- 下一次提取发送当前记忆体及来源索引，不沿引用加载旧原文，不读取历史 MemoryRecord，不把记录混进运行输入。MemoryInput 还包括本轮消息、正式回答和筛选候选原文；候选不宣称全部用于生成。每轮开始由 ObserverExecution 读取当前 Transcript 的 Memory.toJSON 正文快照 previousMemories；SelectionInput 显式包含 message/memories，SelectHistory 的目标导向短提示词及实际请求使用这些记忆和原始 history。生成使用当前 message、选中原文和同一份 previousMemories，允许有限继承旧段理解。prepareMemoryInput 接收同一份 previousMemories（不重新读取更新中的实例），提取完成后更新 Memories，下一轮筛选读取新的记忆。记忆不插入 Transcript，不从 MemoryRecord 消费；全部内容纳入现有容量检查，整个请求超预算直接失败，不裁剪或压缩。
- GET /api/memory 只读投影当前记忆体和 Book 中已有 MemoryRecord，页面直接展示每次登记的变化说明、依据、结果快照和执行/操作记录 ID。MemoryRecord 不虚构 Context 或调用事件，不加入 E/O/A 时序节点；实际落实发生在提取操作的 ApplyMemory，沿该操作记录可以追踪。详细结构见 docs/memory.md。本轮不增加记忆层级分类或记忆之间的关系协议，不实现召回、持久化或恢复。

- QA 仅是执行观测视角：独立导航对应等宽主图列，轮内 E/O/A 按计时布局；上下文行是关联信息聚合，不按时间缩放原文。单一 QA 选择联动弹层中的 IO、MemoryRecord 和调用详情。inspectExecutions 从既有操作读取回答，提取输入中的 currentIndexes 定位原消息；不按相邻索引或文本配对。失败轮保留空位；历史 QA 读当时的记忆记录快照。查询接口不创建记录，不引入 QA 运行实体、持久化或重放。

- 记忆提取以准确、可延续、修正过时认识、保留有效条件与不确定性、减少无意义重复为目标。理解的划分、粒度和综合方式由模型判断，不预设主题分类或抽象层级，不禁止基于已有记忆形成更综合的理解。保持现有 create/update 输出 Schema、ID 与原文索引校验；不把当前操作集合的局限当作知识组织原则。不承诺模型一定收敛到最优划分。

- Transcript 分段使用稳定绝对索引的边界，activeStart 指向当前段，segments() 返回历段。消息仍只有一份，不复制正文、不删除旧段。ObserverExecution.submit 的业务接纳回调在创建本轮 Context 前，若完整筛选请求超限、仅当前输入和记忆可以容纳，则优先从最近两轮完整 QA 的起点开启新段，预算不足降为一轮、零轮；只调整边界，不复制消息。observer/segment.ts 仅从本次输入向前识别紧邻的 user/assistant 对，遇到不完整或非交替内容停止，不跨缺口或旧段补齐。旧 Context/Record 范围不变。提取只加载本轮 QA 与当前段选中原文；更新 result 可保留该目标记忆已有的旧来源，本次变化依据必须来自可见原文并包含本轮消息。不开后台压缩，不额外调用模型。详见 docs/transcript.md。

- E/O/A 的 call 委托对应 InvocationBuilder 建立本次调用；构造器长期复用，不保存当前输入、Context 或 signal。ContextBuilder 构造并检查归属，InvocationBuilder 注入调用机制所需的记录与控制能力；Invocation.run 驱动调用生命周期及 execute/receive。Runtime.run 通过绑定函数让渡给 ExecutionInvocationBuilder，负责顶层执行互斥。E/O/A 继承 InvocationBehavior，统一声明 execute、可选 receive 和 maxRounds，通过 work 绑定当前行为实例。默认接收仅由公共调用循环提供，原样返回成功结果或传播原错误；具体类可声明 receive 自行定义分支，不使用原型方法身份判断。context.continueWith(nextInput, reason) 明确要求下一轮，不提供通用业务策略枚举。maxRounds 默认 1，仅允许 1 或 2，包含首次执行；具体类明确设为 2 才能进行第二轮。未开启的模型调用、筛选、生成与记忆操作不自动重试。
- 同一次本地循环复用一个 Context 和一个调用 Record。Context.input 保留初始引用，currentInput 是当前轮输入；progress 只保留 round/phase/当前输入与本轮 execute 结果，不维护历史，不复制 IO。现有具体 execute 消费 currentInput，接纳契约读取所属操作的 currentInput。继续操作不复活已结束的子 Context，子调用仍每次创建独立 Context/Record。
- 调用记录 value.processes 按顺序追加内部过程条目：execute start/return/throw、receive return/throw/continue、control stop。每项包含记录内 sequence、round、occurredAt 与执行内 offsetMs，以及相应输入、结果、错误或继续原因；没有独立 ID、RecordBook 条目或跨过程索引。正文登记时复制冻结，旧 value/数组快照不随后续追加变化。过程不是第四层执行实体，InvocationBoundaryRecord 仍只描述整个调用的 call/return/throw。页面在同一调用详情内展开 processes，不生成额外时序调用节点。
- 每轮开始检查执行取消信号。达到轮次上限、无效继续原因或接收处理自身异常，明确停止并记录原因；限制不依赖模型判断。接收直接传播本轮原错误时保留原错误。记录失败以 RecordingError 保留 cause，绕过本地恢复，不重做工作；工作/处理失败与其登记失败同时存在时保留 AggregateError。调用终态登记仍是 Context 先结束、Record 后登记，登记失败不回滚事实。进程内过程记录失败时保留已有条目与 Context.progress，不承诺补偿。现有模型单次超时不变，未增加通用抢占、总时限、外部结果查询、幂等、迟到响应处理或持久化恢复。

- 单条调用记录内复用成功结果：execute.return 保存正文快照；框架默认 receive.return 用 resultOf 引用同轮紧邻 execute.return 的 sequence，最终成功结果引用最后一次 receive 接纳的正文。引用只指本记录内直接持有 output 的条目，不形成链、不跨记录或轮次。自定义 receive 即使返回同一对象也保存独立快照，避免原地修改被漏记；不按对象身份或内容哈希去重。protocol/src/records/invocation.ts 的 readOutput 按需解析最终结果，观测投影才展开，不在快照序列化时重新填充 output。直接调用生命周期/记录辅助方法而没有过程时仍登记独立 output；输入和错误正文暂不复用。

- 调用图 E/O/A 只在同一问答列内按共同耗时比例定位，问答列等宽，轮首可读实际开始时间；等待时长不占宽度。独立导航位于搜索区下方，固定块宽、独立横向滚动；主图纵向滚轮调密度、横向平移，锚定鼠标位置，导航不会跟着缩放。左侧固定标签为问答、上下文、执行、操作、意图。上下文行聚合所选历史、可见记忆与变更入口；全文归对话或详情，不再保留底部摘要和重复状态栏。Attempt 的 processing/provider 是 target 描述，不伪造额外 Provider 调用层。弹层展示既有 IO、内部过程、上下文记录、记忆变化及当前源码，不创建观测专属运行记录。

## 本轮运行边界

- 具体结构与限制见 docs/runtime-boundaries.md。RuntimeContext 持有跨执行 Transcript、Memories 与 SelectionUsage 的原引用；RuntimeRecord 描述运行数据范围，InvocationContext 描述本次调用现场。createRuntime 建立新的现场与可选根记录，Runtime 构造器仅接管它们。实例存活不等于数据范围生命跨度；不实现导入恢复或 Runtime 完成状态。
- 顶层运行占用由 Runtime.run 管理，Execution.submit 在占用后接纳输入，HTTP 不自行维护 executing 标志。直接执行同样受限制；EOA 拒绝来自其他 Runtime 的现场。
- Recorder 由环境装配，Transcript、Memories 和 Invocation 的记录接线共享同一登记入口，各自在事实边界登记一次。调用记录与内容记录分别表达，不虚构回滚、重放或跨实例恢复。

- 对话业务交付通过 ObserverExecution.converse 的本次调用回调，按 Context 临时关联，在 finally 清理；不将回调放入 Context 正文或记录。服务端记录失败处理不变，观测订阅/查询失败不回写对话结果。对话流只交付完整 GenerationOutput，不提前实现 token/part、外部能力动态 schema 协议或业务恢复。已接纳请求结束仅等待消息刷新，观测由独立的基线和增量连接维护；回答后发生后处理错误仍保留已经交付的消息。

- 构造边界本轮：ExecutionContext 不再持有完整 Runtime，私有构造器身份仅用于归属检查；O/A Context 直接持有本次 signal 引用，保留既有父 Context 引用。具体业务的全部信息与能力投影尚未迁移，不增加动态能力注册、权限系统或 Context 状态机。手工创建且未绑定构造器的 Context 保留既有使用方式。构造不登记调用记录，run 才开始登记；O/A 在运行前复查父级有效性。Observer 的切段策略留在具体 submit 内，核心 Execution 的 prepare 钩子移除。详见 docs/runtime-boundaries.md。

- 记录树本轮：parentId 在构造时确定，CompositeRecord.childIds 只由统一登记内部替换，不对业务开放挂接/迁移入口。RecordTree 只查询归属及准备关系变更，不持有另一份关系集合；具体类型关系规则归 records/tree/relation.ts。RecordRegistration 同步落实并在失败时清理本次登记，成功后一次 add 通知附带 related 父记录。它不回滚消息或记忆事实、不承诺持久化事务。调用索引已移除；不把调用绑定、事件时序和记忆语义搬进 RecordTree。详见 docs/recording.md。

- 局部顺序本轮：Invocation 为已有内部过程分配 sequence，重试继续递增，无 Recorder 也推进；记录只接纳并检查顺序。Memories 对正式变化递增 sequence，MemoryRecord 保留 memoriesId/sequence/memoryId；无变化与预检查失败不占号，登记失败不回滚已落实变化及序号。消息仍使用原有 index。范围查询、快照收集、下级结束检查已使用 RecordTree，Runtime 范围隔离已改用 RuntimeRecord 与 RecordTree.root。前一事件查询已迁移到 InvocationBoundaryRecordHelper.last，调用索引及旧 Context 映射、重复登记限制已移除。观测基线与增量已接通，见 docs/observation-increments.md；不得通过快照 diff 反推变化或将局部 sequence 当作交付游标。

- 调用绑定本轮：Invocation 持有 Context 与可选调用 Record 的临时关系；begin 登记记录后立即绑定，再登记 call 事件。绑定要求 contextId 一致且不可重复，process/finish 显式使用绑定记录。execute(context, invocation) / receive(context, result, invocation) 按需使用调用参数；O/A call 接收直接父 Invocation，ContextBuilder 仍只处理现场，Context 不持有记录或反向调用引用。内容变化从 invocation.source 取得 ChangeSource，无记录时为 undefined。InvocationRecordHelper.get 与旧索引均已删除，不恢复运行路径上的反查，也不新增全局关联表。

- Runtime 记录本轮：通用记录基类为 BaseRecord，组合记录基类为 CompositeRecord；RuntimeRecord 与 InvocationRecord 分别扩展，不让 Runtime 假装一次调用。通用登记器为 Recorder；EOA 共用正文为 InvocationValue。RuntimeRecord 目前只有 createdAt 和 childIds；E 的 parentId 指向 RuntimeRecord，O/A 和内容记录原有描述身份不作重设计。Recorder 仍由环境共享。树查找负责 Runtime 归属，不增加全局 runtimeId 冗余；RuntimeSnapshot 仍按单次 E 返回，暂不包含 Runtime 根正文，不宣称完整树导出。无记录运行仍可使用 RuntimeContext。不以某个 E 的结束关闭 Runtime 数据范围。

- started 接线使用 InvocationStarted 公共类型和 ExecutionStarted 执行特化，入口与 Builder 不重复声明签名。同步回调在 validate 后、记录登记前执行，Context 已建立但 Record 尚未绑定；回调异常原样传播并停止调用，不由 writeRecord 包装。保持原时机，不增加异步钩子或生命周期管理器。

- 变化生产与捕获：Transcript、Memories、Invocation 和 Recorder 分别在正式变化处产生不可变事实，窄接口 ChangeCapture<E> 由环境共享的 ChangeObserver<RuntimeChange> 实现。内容和调用进度不依赖 Recorder。capture 不执行消费者；wait 唤醒异步消费，take 转移当前批次，不赋予业务原子性或持久化保证。捕获失败保留已落实事实，ChangeCaptureError 禁止调用循环重做工作；记录失败不抹去已捕获的内容变化。
- 观测发送由 service 的 ObservationFeed 单独消费捕获器：基线包含概览、当前记忆、来源游标、Runtime 根和活动执行记录；已完成详情按需查询。后续发送 scopeId/sequence 标识的 delta，不比较两份快照。一次记录登记的新记录与父级 childId 同批；过程更新仅发送新条目，终态仅发送结果。每条 HTTP 连接限制待发字节，慢消费者断开，不阻塞业务执行。
- client runtime 的 ObservationReplica 原子接纳整批增量，检查交付位置与来源顺序，重复交付忽略；范围或序号缺口最多自动重建一次基线，再失败明确报错。普通断线不无限重连；无持久化重放、消费 ACK 或业务恢复。binding 从本地事实组织 UI，不能从记录生成回答。调用过程记录与 InvocationBoundaryRecord 区别于变化通知，详见 docs/observation-increments.md。

- 入口参数按职责分类：主体依赖与稳定能力分开构造；调用 Builder 的 request 只装配本次输入、Context 参数、工作与 started，不传 Recorder/捕获器。E Builder 的 run 是专有能力，O/A 仅共享 recording/changes。短入口 call(parent,input)、apply(changes,source) 不机械包装 options。记录 definition 与正文 value 分开，身份/顺序/来源具名；Clock 由 Recorder 统一提供，不再双重注入。InvocationChangeEmitter 仅构造每次调用的变化事件与来源序号，Invocation 保留触发点、记录绑定和错误顺序，cycle 的 onProcess 不感知具体消费者。见 docs/runtime-boundaries.md。
