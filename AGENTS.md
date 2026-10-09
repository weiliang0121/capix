# CAPiX Observer

这是独立的运行链路实验，不依赖或修改 CAPiX Runtime。

## 工程边界

- 根 pnpm Workspace 下六个实际包：protocol、server/runtime、client/runtime、client/http、services/observer、apps/observer。包身份为 @capix-observer/protocol、runtime、client-runtime、client-http、service、app；跨包仅通过公开出口导入。protocol 无 Node/HTTP/UI 依赖；runtime 不依赖 service/app；client/runtime 只依赖 protocol 与通用工具，不依赖 React、服务端或应用；client/http 分别实现 ConversationTransport 与 ObservationTransport，只通过公开出口依赖 client/runtime 的接口及 protocol；app 依赖 protocol、client-runtime 和 client-http，不读取服务端内部类型。详细接口见 docs/protocol.md。
- 核心 REOA、Context、调用循环、Transcript、Memory 与记录保留在 server/runtime；具体筛选/回答/提取、模型请求/适配器、配置接纳与 HTTP 在 services/observer 组装。不为本次迁移提前重构运行语义或泛化现有 Context 配置。
- apps/observer 使用 React + Vite + Tailwind 和按需引入的 shadcn/ui 源码组件。基础 UI 组件只放应用内部，定制图谱自行实现；不建空壳组件包。协议只表达运行事实与记录，Trace、坐标、颜色、搜索和视口是应用内部投影。
- client/runtime 定义 ConversationTransport(config/run)、TranscriptTransport(transcript/observeTranscript) 与可选 ObservationTransport。ClientRuntime 以 conversation/transcripts/observation 具名装配；HTTP 仍只有两个子类，ConversationHttpTransport 同时提供业务与消息实体端点。initialize 取配置并同步当前消息集合，消息副本按 ID/revision 维护；业务流只推进提交状态，不重复追加权威消息。startObservation 显式开启记录流，停止观测不停止消息同步。binding 组合实体定位符与已加载正文，Store 持有应用读模型，React 不解析快照。详情/源码按需加载，未加载、错误、缺失与空值分开。详见 docs/client-runtime.md。
- GET /api/executions 是轻量 ObserverOverview，首次绘图不能循环读取所有完整快照；详情按 execution.id 加载。POST /api/run 使用 ConversationUpdate 的 started/answer/completed/error，回答在追加消息后交付、记忆后处理前可见；业务身份是 Context ID，不依赖记录。GET /api/observe 使用独立 ObservationUpdate 的 baseline/delta/error，连接结束不表示业务完成。不引入导入、导出、回放或持久化。
- 问答导航固定块宽且独立横向滚动；主图每轮等宽并有最低阅读宽度，密度不改变导航。轮内 EOA 才按时间比例，轮间不作统一时间比例。搜索完整 Q/A 正文，输入只高亮，显式导航才定位。上下文行展示消息与记忆关联，避免重复全文。
- 保留下面运行语义约定；文中未带包前缀的相对路径指各自所属包 src，具体操作与 observer 属于服务，核心类属于 runtime。

- Web 字号统一为 10/12/14/16px，页面与弹层主标题可用 20px；通过 CSS 字号变量复用，窄屏不再引入额外字号。
- Web 使用黑灰深色主题；EOA 仅以轮内宽度表达耗时；操作类别可使用稳定淡色，意图沿用父操作色，颜色不表达耗时。消息累计被选次数通过数字和局部短条展示，不使用整块热度填色。失败、运行中、选中以文字 tag 表达，不用彩色节点描边覆盖数值含义。图中节点不设置原生 title 提示，正文通过点击详情查看；保留 aria-label 与键盘可访问性。

- Transcript 是原始交流内容的持有者，位于 server/runtime/src/transcript/transcript.ts，包含当前输入。提供 append/current(role)/get/ref/length/snapshot，只增不改删。写入时检查并复制冻结每条消息；get/current 返回同一不可变消息，snapshot(end) 只复制固定前缀数组。批量追加先全部检查再写入，不截断或改写原文。按角色 current 表示最新消息，不表示问答配对。MessageRef 用 Transcript 实例和绝对 index 定位消息，TranscriptRangeRef 表达固定的 [start,end)；读取不受后续追加影响。不继承 BaseRecord、不直接依赖 Book；持有自身 ID、必要变化捕获与可选观察端口，append/appendFrom/startSegment 在落实后独立发布事实；记录预设消费事实生成 TranscriptRecord，不增加多环境仓库或持久化。
- Observer 的 Execution.input 是接纳后的只读 Message。E entry 声明接纳与分段资源；bindObserver 在分段之后固定 TranscriptRangeRef [activeStart,end) 及配置快照，原实体只用于内部绑定。业务从本层 resources.values 取得正式接口；E Record 不再保存 settings/transcriptRange 特化字段，运行访问由资源契约描述为独立 ResourceFact。后续追加不会扩大本次范围。

- 前端在 apps/observer 内处理消息编辑、展示和提交数据，只依赖 protocol 的 Message 契约，不导入服务端 Transcript。前端检查仅提供编辑提示，正式接纳仍由服务端完成。不因两端复用而将运行实体移入 shared。

- 先有具体特性和可运行函数，再提炼复用；不提前引入 TRS、调度器或数据库。
- UI 必须消费执行产生的记录，不伪造真实模型结果或计时。
- Key 仅从服务端环境读取，不输出、导出或发送到前端；不读取其他项目凭证。
- 记录装载、容量检查、调用、解析、校验的真实输入、输出和停止位置。
- 保留输入契约、失败出口和必要测试；除下述生成回答的明确声明外，不自动重试；不静默截断。
- 使用固定 Node/pnpm 与精确依赖版本；不推送、部署或发布。
- 每条变量声明只声明一个变量；循环直接表达继续或结束条件，避免 `while (true)` 再依赖内部 break 退出。流读取以 reader 的 done 状态结束，异常和提前退出仍释放资源。
- 格式偏好：不按 100 字符强制拆行。Prettier 使用 printWidth: 1000，近似不限制常规代码行宽；保留代码块等结构换行，不为满足窄行宽拆散函数签名和调用参数。
- 通用数据操作采用 es-toolkit@1.52.0，按公开分类入口直接具名导入（es-toolkit/object、array、predicate 等）；后续遇到字段投影、排序、分组、去重、比较等需求先查已有能力，不再自建通用 Utils 类、转发层或内部工具库。不统一改写成链式或 fp 风格。基础类型判断只要库有同语义方法就统一使用，分类入口缺少的方法使用 compat 具名导入；简单展开、解构、原生 Map/Set 与领域类 instanceof 保留。
- 服务端标准类型分类统一优先使用 es-toolkit/predicate（isString/isNumber/isBoolean/isNull/isUndefined/isSymbol/isDate/isMap/isSet/isError），覆盖错误转换、Provider、消息/记忆接纳和记录正文。错误固定字段表与类型一起定义，zipObject 组合读取结果；仍逐字段安全读取，允许继承的 name，捕获访问异常。isNativeError 保留跨 realm 的原生错误识别；领域类身份仍用 instanceof。null/undefined 判断使用 isNull/isUndefined，不混用严格相等判断；数组、非空对象、有限数和安全整数使用 compat 的 isArray/isObjectLike/isFinite/isSafeInteger。isObjectLike 的库声明仅返回 boolean，value/object.ts 保留同一库函数引用并补充类型谓词，不重写实现。bigint 与严格原型规则没有同语义方法，保留原生判断，不改变接纳范围。任意诊断对象的属性转换不直接使用会触发 getter 的 mapValues/pick，保留描述符读取和特殊字段处理。
- 库未提供的重复组合判断归 server/runtime/src/value：isNonBlankString 检查字符串类型与非空白，不修改正文；非空白正则同时用于模型 Schema。isNonEmptyArray 检查数组与非空，hasUniqueItems 检查元素唯一（空数组合法，对象按引用比较）；元素类型和引用有效性仍归具体契约及实体。不为每个检查建立包装，不将纯判断与抛错、解析或数据整理混合。
- pick 用于明确的同名字段白名单，只读取自身属性；类的 status/value 等原型 getter 显式读取，字段重命名、条件缺省也显式表达。不用 Object.assign 批量初始化类以绕过只读字段及构造语义。sortBy/uniq 用于数据整理，不把非法重复索引静默去重后接纳。isEqual 只比较已明确的正文范围，记忆无变化仍要求 topic/content/有序 sourceIndexes 全部相同，不比较 Memory 实例身份或全部元数据。
- 保留领域方法的语义：记录快照维持 copy/check/freeze、活实体/引用及循环拒绝规则，错误转换保留访问器与预算规则；通用 cloneDeep/merge/isPlainObject 不直接替换它们。当前 isObject 不等同于库中的 isPlainObject。深合并必须在实际需求中明确覆盖、数组和可变性规则后使用。库的存在不提前引入 retry、调度或自动恢复。浏览器模块交由 Vite 构建，使用公开依赖，不复制库源码或暴露 node_modules。

- HTTP 接收 ExecutionRequest {messages}，R.run 先取得占用，检查配置，再由 E entry.accept 经正式 append 端点接纳 1–501 条消息，最后一条 user 作为本次输入。输入审查失败不部分追加；已落实变更后的记录/捕获错误不会回滚。R 调用开始后才进入 E 接纳；accepted 回调发送 HTTP 成功头，随后 admit 分段、捕获资源、E Context/Invocation、started、可选观测、工作。R 开始前已取消不接纳消息，已发生变更不回滚。入口端点在 accept/admit 结束时失效；尚未建立调用不伪造来源。忙碌返回409，不排队。
- 移除集中式 contracts.ts。observer/accept.ts 组合提交规则、Transcript 消息接纳和输入消息确定；消息规则仍归 Transcript，批量数量与末条 user 限制归提交边界。历史选择与回答生成在各自 output.ts 声明 { schema, accept } 配对输出契约，ModelOutputContract 类型位于 model/contract.ts。AcceptModelOutput 组合结束检查、JSON 解析和具体输出接纳。选择结果分别检查结构、引用并复制，保留模型给出的优先级顺序，回答严格检查 kind、不改写原内容。保持模型请求的 Schema，本地更严格的安全整数、非空白要求和动态引用范围由对应操作维护。value/object.ts 仅提供通用对象和字段判断；不建立审查管理器或新的结果实体类。
- 回答输出契约使用 zod@4.6.5 的 strictObject，同时生成 JSON Schema 与执行 safeParse；非空白 regex 同时进入提示 Schema 与本地检查，不改写正文。拒绝未知字段，不使用 coerce、default 或 trim 转换掩盖契约错误。成功返回新普通对象，失败映射为现有 RuntimeError(OUTPUT_SHAPE)，detail.issues 保留字段路径及原因。GenerationOutput 保持跨端纯数据声明，Schema 通过 ZodType 类型约束检查兼容性；不让 protocol 反向依赖服务端。记忆提取也使用 Zod：create/update 判别联合、严格正文、长度和非空白、非负安全整数与来源去重；uniqueItems 元数据与去重 refine 配对，MemoryExtraction 从 Schema 推导。目标 ID 的格式/动作组合错误为 OUTPUT_SHAPE，合法 ID 不存在或批内重复更新为 MEMORY_TARGET；来源范围/包含关系为 MEMORY_SOURCE。解析成功后再检查语义、过滤无变化、检查本轮依据，最后才落实变更；不重复复制已解析正文。历史筛选同样用 Zod 严格接纳，再检查本轮 Transcript 范围，保留优先级顺序与空结果；移除手写 Schema 和多余数组复制。model/schema.ts 仅复用模型输出的非空白文本和唯一索引规则，不建立校验管理器。settings.ts 用 Zod 接纳配置，保持只选取已知字段和原有数值边界，错误仍为 INVALID_SETTINGS；配置可忽略额外字段与模型输出严格拒绝额外字段的规则分开。不把动态引用、无变化过滤、运行实体或恢复策略塞进 Schema，不重复解析 Context、Transcript 或记录图。

- Operation<I,O> 是固定结构，持有声明、惰性直接子节点、构造器和稳定实例ID；SelectHistory/GenerateAnswer/ExtractMemory 提供 OperationDefinition。绑定负责形成节点，不提供重复的运行包装类。Sequence 负责业务编排，输入构造和结果接纳由业务声明提供。
- Attempt<I,O> 是固定底层结构，持有 AttemptDefinition 与构造器。业务只声明描述、资源和执行内容；内部绑定建立 Context/Invocation，Record 由可选观测声明产生。A 不继续分层；工作接收 AttemptScope 与 InvocationView，不取得实体、记录或生命周期修改入口。
- Execution<I,O> 是已装配的 E 节点，持有声明、资源装配与直接子节点；R.run 通过本次 R Invocation 选择并接纳已声明 E。ObserverExecutionDefinition 以 entry/Sequence 组织接纳、分段、选择、生成和提取，不持有 Runtime 或子层运行实例。assembleRuntime 将声明及外部供给接到固定结构；R 声明 children 及 run/exceptions/observation，模型和供应实例由环境建立。
- `BaseRecord<T>` 持有 id/value 和只读直接归属 parentId。ExecutionRecord、OperationRecord 和 AttemptRecord 具有顶层只读状态 running/succeeded/failed，基类不增加状态。操作关系 executionId/operationInstanceId/parentOperationId 位于顶层；每次调用有独立操作 ID。输入输出为记录正文，普通消息复制冻结，不为每个中间值生成 Record。
- 开启记录预设时，一次 Operation 子调用创建一条 OperationRecord，每次实际 Attempt 子调用创建一条 AttemptRecord。AttemptRecord 继承 BaseRecord，顶层 operationId/name/label/source/caller/callee，正文 input/output/error；name 为动作名称字符串，不限于固定阶段集合。动作描述创建记录时从绑定提供的定义固化，Context 不携带描述。parentOperationId 仅用于真正的嵌套操作。AttemptRecordHelper 与 record.ts 配对，按操作需要显式接收 Recorder 或 Book。手工 Helper 可检查下级记录完整性；观测预设按本层真实终态写入，不把漏写的下级记录状态当作运行约束。一次 Attempt 失败不自动结束父操作；父操作仍按实际调用链处理异常。相同动作可以被显式调用多次，每次有独立 Context 和 Record；不自动重试。InvocationBoundaryRecord.callId 可指向 REOA 四类调用记录，投影使用 recordType 区分并展示动作名称与标签。
- `RecordBook` 仅提供 add/get/values，保存原记录引用、拒绝重复 ID。Book 不认识记录种类、索引、时钟、状态转换、事件、通知或导出。不得把特化流程重新放回 Book。
- `ExecutionRecordHelper`、`OperationRecordHelper`、`AttemptRecordHelper` 是各子记录的配对静态操作，显式接收 Recorder、Book 等参数，组合创建、登记、关系查询、检查及结果写入。记录按概念分组，execution/record.ts 与 execution/helper.ts 配对，operation/record.ts 与 operation/helper.ts 配对，避免跨概念循环导入。实例 complete/fail 只负责正文与自身状态的原子顺序更新；跨对象归属和子操作检查位于配对操作；RecordingCall 在可选声明的局部写端口内组合这些操作，Recorder 不做类型分派。
- 运行关系查询归 Invocation，记录句柄归 RecordingCall，正式归属查询由 RecordTree 承担；InvocationRecordIndex、通用 RecordIndex 与登记索引接口均已移除，不为了旧 Context 重复登记检查保留全局映射。事件的前项查询在 InvocationBoundaryRecordHelper 中遍历执行子树，取 sequence 最大值；不把事件顺序策略放进通用树。
- 具体调用记录通过 InvocationRecord 共用状态、终态登记与内部 processes 追加；BaseRecord 基类持有 id/value/parentId，CompositeRecord 提供冻结的直接下级 childIds。具体记录在输入、输出及错误边界复制冻结普通正文，不保留活实体引用；正文成功写入后才切换状态，拒绝重复结束。保留当前不支持 undefined、循环引用、Map、函数等正文的限制。基类不施加冻结策略，执行过程普通值不被修改。
- records/value/snapshot.ts 只组合 copyContent → assertRecordContent → freezeContent；check.ts 承担记录正文类型及循环检查，freeze.ts 只冻结已检查的普通内容。保持先复制再检查的语义，不把正文类型策略混入冻结机制，不将业务契约检查放入快照函数。机制暂留 records/value/，不建立全局工具框架。
- `Clock` 通过 now() 提供现实时间、tick() 提供单调时间，独立于记录，由装配共享。调用事实携带生产时刻，RecordingCall 按本次 R 或 E 范围计算偏移；R 调用与 E 轮内计时各有起点。调用边界的顺序由记录 Helper 沿范围查询，调用过程及父子关系则保留生产者 eventSequence。测试可注入 Clock，不引入后台计时器。
- 调用边界记录统一为 records/invocation-boundary/record.ts 的 InvocationBoundaryRecord，继承 BaseRecord<InvocationBoundaryValue>，value.type 为 call/return/throw。scopeId/callId 指向计时范围及被描述的 REOA Record，executionId 仅在 E 范围内存在；scope=work 表示工作终态而非实际交付。边界有自身 UUID、sequence/occurredAt/offsetMs，没有 Context、运行状态或执行能力。InvocationBoundaryRecordHelper 负责创建、归属检查、登记及查询；Book 持有正文，不保存第二份事件记录。
- Invocation 位于 invocation/invocation.ts，接收已经建立的 Context 与具名调用选项，统一入口检查、局部循环及终态。REOA 对应 InvocationBuilder 组合各层 ContextBuilder 与类型化观测绑定，不导入记录 Helper；声明提供平级 run/exceptions/observation。run 是工作与正常接纳，exceptions 是匹配声明异常的处理，observation 消费确定的事实。调用机制不按层派生子类。

- 调用上下文位于 server/runtime/src/context/：InvocationContext<I, O> 基类持有自身 UUID、input 与 running/succeeded(output)/failed(error) 状态联合；ExecutionContext、OperationContext、AttemptContext 分别对应完整运行、Operation 调用和一次具名动作执行。失败状态可携带 failure 分类事实；普通 IO 与异常保留原引用，允许非 JSON 值，不克隆或冻结正文；state 包装只读，complete/fail 拒绝重复结束。上下文实例字段只读，子类实例冻结不影响私有状态更新。操作辅助函数不创建上下文。
- ExecutionContext 持有本次信号、正式 ResourceBindings 和私有构造归属，不保存配置/历史实体或来源 WeakMap。O/A 私有持有直接父 Context 用于归属及活动检查，不公开祖先取数入口。每层只使用本层当前阶段的 resources.values；子关系与 ChildCall 只公开运行事实，不暴露子层资源。IO、状态与记录独立。Runtime 不提供 getExecutionContext/getOperationContext，记录来源仅在记录预设内部由局部句柄解析。
- Invocation 组合调用生命周期；Runtime 持有已装配声明与内部能力并管理唯一占用，每次调用有独立 RuntimeContext，不持有通用关系表、活动子调用集合或 Context 成员资格登记。当前固定串行流程由 Sequence 按约定逐项执行并等待父层接收完成；保留父级已结束、嵌套操作属于不同执行及 Context 重复结束的直接检查。不提供手动提前结束父调用的通用保护，由 ExecutionContextBuilder 绑定的调用现场拒绝跨构造范围使用，不扩展为权限隔离体系。已有 RecordHelper 的记录完整性检查与登记错误传播保持不变，不把它们当作运行调度。无队列、权限体系、调度、重试或并行策略。
- Recorder 位于 records/recorder.ts，组合 Book、RecordTree、同步 RecordRegistration、Clock 和通用订阅者，提供 add/update/subscribe。add 统一检查并落实记录及直接父子引用，失败清理本次登记；update 检查对象登记身份后执行特化更新。Recorder 不依赖 Context、E/O/A、消息、记忆或 RuntimeSnapshot，不执行工作、不修改 Context。Context 身份到 Record 的局部句柄归 RecordingCall，计时和过程规则归记录预设；各层 Helper 组合本层创建与结束规则。详见 docs/recording.md。
- 不安装记录预设时 REOA 仍可执行，不受 JSON 记录正文限制。观测安装默认 isolate，也可声明 propagate；前者停用失败观察者并通知对应来源不完整，后者由所属结构归属错误。已落实工作和 Context 终态不回滚，不以观测失败触发业务重试；原错误与观测故障同时发生时保留 AggregateError。未完成记录不能冒充完整历史，不补造终态，不承诺补偿或恢复。

- 错误仍内嵌于 value.error，没有独立 ID。errors/error.ts 定义 RuntimeError，支持 ErrorOptions.cause；protocol/src/errors.ts 定义 RuntimeErrorValue、JSON 正文 RuntimeErrorDetail 及 InvocationFailureFact 分类事实，不镜像异常类。formatError 保留 code/message/name/stack、cause、复合 errors；无 code 的原生异常使用 INTERNAL_ERROR，复合异常使用 AGGREGATE_ERROR，非 Error 抛出值使用 NON_ERROR_THROWN。detail 中不可记录的值转为带标记的普通数据，不执行 detail 的 getter/toJSON，不共享源引用。限制转换深度 12、值预算 2048、每集合 100 项、每字符串 16384 字符，超限有明确标记。记录 Helper 只消费正文，不依赖 RuntimeError。错误不建立独立 ID 或可替换业务声明；处理边界由所属结构固定，详情见 docs/exceptions.md。

- 错误转换的调用入口为 errors/helper.ts 的 RuntimeErrorHelper.format。format.ts 组合识别、提取和字段映射；detail.ts 处理诊断内容，嵌套异常转换由参数提供。ErrorTraversal 仅管理一次转换共享的预算与递归路径，各调用独立，不是运行 ctx。限制集中于 traversal.ts，沿用现有格式化规则。主流程用输入输出明确的函数表达职责，状态显式传入，函数保持同一抽象层次；不逐行包装或引入通用转换框架。

- 文件按概念与动作分层，不用连字符拼接文件名，也不机械改成 camelCase：例如 operations/history/select.ts、attempt/context/assemble.ts、apps/observer/src/observation/project.ts。记录容器在 records/container/，正文操作在 records/value/，Runtime 支撑文件在 runtime/。工具规定的 pnpm-lock.yaml 等名称保持不变；已保存的运行记录不因源码整理被重写。测试命令使用 Node 内置测试运行器，按 test/**/*.test.mjs 递归匹配测试，排除辅助模块。

- 观测选择统一使用调用记录 ID，不为它另设节点 ID 别名；operationInstanceId 表示实际 Operation 实例的身份。时序事件直接使用 InvocationBoundaryRecord，错误正文直接使用 RuntimeErrorValue，不另维护相同形状的视图契约。失败调用没有 output，诊断内容保留在 error.detail，不将错误详情伪装成操作输出。

- 观测服务于理解当前运行。不提供记录文件导入、导出和重放，不以独立解释、跨进程恢复或未来持久化要求增加当前链路不存在的对象。允许从已存在工作链路中提炼职责，避免由假设功能反向制造复杂度。
- ExecutionRecord.value 只包含调用输入、过程、结果/错误与开始时间。settings、固定历史范围和其他资源访问事实由 ResourceRecord 表达，parentId 指实际 E/O/A 调用记录，access/supplyId 关联访问契约与共享供给，sequence 为调用局部资源顺序。资源声明自己的正文；核心不按实体类型解释。ResourceFact 包含 bound/available/unavailable/started/returned/threw，方法阶段以 interactionId 配对。
- ExecutionRecordHelper.snapshot 从 Recorder 的 Book 与 RecordTree 组织快照，事件显式按执行内 sequence 排序；InvocationBoundaryRecord.toJSON 新建外层数据，正文不可变。RuntimeSnapshot.events 是 InvocationBoundaryRecord 的查询输出，不是第二份存储。validateSnapshot 检查事件记录独立身份、执行归属、时间与边界一致性；不承担文件导入契约。
- 记录不持有 MessageRef/TranscriptRangeRef 活引用，普通正文按既有策略复制冻结；消息实体以 transcriptId+index/范围+revision 定位，不在HTTP序列化时自动展开。GET /api/transcript 与 /api/transcript/observe 提供受控集合查询和同步，仅接受当前装配集合ID。观测概览与原文变化记录不带消息正文，客户端独立取得副本后组合。当前完整集合基线，不实现分页/回放/持久化。

- 必要变化捕获保持严格失败；可选记录观测按安装策略隔离或传播。业务工作已落实的结果不撤销，不以记录失败触发业务重试。记录与观测消费分离，网络/UI消费异常隔离。Context 与 Record 各有职责；operationInstanceId 仍关联实际O节点。

- initializeObserver 独立创建 Transcript、Memories、SelectionUsage、Book/Clock/Recorder/ChangeObserver，再通过 bindObserver 将正式供给与声明装配到R。本次 RContext 持有调用状态、信号与正式资源，无内容实体引用；占用由 Runtime 实例维护。模型Initializer惰性兑现；空环境只有RuntimeRecord，不调用模型。内容实体不因绑定到R而由R定义生命周期。
- 固定结构与 Context 为 1:N，开启记录时 Context 与对应层 Record 为 1:1。同一声明可绑定不同 Runtime；每个绑定位置独立缓存 O/A 结构与稳定操作 ID，本次输入/输出/信号/资源/状态不保存到声明或绑定。InvocationBoundaryRecord 与调用 Record 为 N:1，不为边界记录虚构 Context。
- Recorder.subscribe 订阅记录 add/update 通知，隔离订阅者异常并返回解除函数；observer/observe.ts 的 subscribeExecutions 负责从调用边界和过程更新组织执行快照，不将内容变化伪装为调用事件。observer/observe.ts 通过 R.run 的 options.execution.started 回调获得本次 Context ID，随后按执行记录 contextId 筛选并在 finally 解除订阅，不依赖 input 对象身份。started 在执行上下文建立后、首条记录发布前调用，用于绑定本次调用，不执行业务处理。直接 R.run 仍返回工作输出并传播工作异常。
- 删除通用 Answer 类型，GenerationOutput 归生成操作的共享输出契约；不改变 kind/content 的模型输出，也不把分类强行加入 Message。过程变量按对应操作命名，例如 selectionOutput/generationOutput。GenerationInput 使用 selection 与 memories；内部 AssembleContext 产生 message 与 selectedMessages，分别表达本次消息和选中消息；模型装载保留 message 的 role/content。

- BCA 仅作为分析动作的视角，不作为运行接口、阶段枚举或记录分类。运行结构为 R → E → O → A，OperationDefinition.execute 组织任意数量的具名子声明，IO 可以异构。配置、范围等通过正式资源申请取得，需要的校验依据显式作为子输入组织；不从祖先 Context 强转读取。普通辅助函数不创建 Context。

- 历史选择要求模型按相关性与必要性从高到低输出索引；本地校验引用合法性，不宣称可验证排序质量。组装保留优先级与完整原文。GenerateAnswer 通过 AssembleContext 取得选中原文，再在请求装载时按优先级纳入完整消息，遇到首条超限即停止，不跳过长消息凑容量；第一条就超限则失败。选定前缀在最终请求中按原始索引升序呈现，不改变 Transcript。当前输入、系统提示、Schema 与输出预留不能裁剪。候选请求与最终检查共用 model/capacity.ts 的完整请求 UTF-8 字节估算，非精确 tokenizer；容量处理不增加摘要、额外模型调用或策略框架。选择操作装载当前段历史；下一轮开始前必要时切段，当前输入与记忆本身超限仍失败。生成 PrepareModelRequest 的 input/output 分别记录裁剪前候选与实际请求，不另存一份裁剪观测记录。

- 内部筛选结果只作为操作 IO 与运行记录保存，不自动追加为 Transcript 消息。Transcript 只接纳 user/assistant 原始消息；筛选不生成 summary，不建立摘要到原文的替换链路。后续方向为 Jev 筛选与使用计数，Jev 接入和热区装载尚未实现；不因这次撤销增加兼容或迁移层。

- 热区是已有记录的只读投影：observer/selection.ts 从指定 Transcript 的 ExecutionRecord 与selection 角色的 OperationRecord 推导每条消息被选次数及每次选择的索引。只计算成功筛选的已接纳 output，一次选择每个索引 +1；后续生成失败不撤销次数，失败/未结束的筛选不计入。空选择保留为空结果。计数不等于实际生成采用或回答正确，不写入 Transcript、不存第二份计数记录。GET /api/executions 的只读概览汇总当前进程筛选记录；apps/observer 的上下文行与详情展示计数和本轮引用，刷新可重新查询。未增加持久化、衰减、热区候选策略或模型调用。

- SelectionUsage 由环境建立，以不可变Message作为WeakMap键。E在选择子调用accept中经资源端点累计；无Recorder仍生效，后续失败不撤销。计数不进入模型请求或Message正文；观测计数从选择记录投影。资源供给范围和实体存活不由RContext决定。

- 回答后处理：ObserverExecutionDefinition 经本层消息资源追加回答并交付，再执行 ExtractMemory。它经 AcceptModelOutput 接纳候选，ApplyMemory 通过本层 memoryWriter.apply 落实。实体自行检查、变更、捕获与发布，记录预设独立消费；写端点自动绑定实际调用来源，业务不传record/source参数。记忆提取保持同步等待、无后台队列和自动重试。
- Memory 是持续身份的运行内容，不继承 BaseRecord，不包含关系或历史版本列表。Memories 绑定一个独立 Transcript，独占正式创建与更新入口 apply，先检查整批动作、目标、正文与依据再落实。对外 Memory 只有只读内容与 snapshot/toJSON；包内更新保留对象和 ID，当前正文复制冻结。同批不重复更新目标，无变化不登记，不跨集合更新。删除 MemoryCollection 和 MemoryHelper。
- 提取输出 memories 是零到四项明确变更，每项 action(create/update)、memoryId(创建为null，更新为已有ID)、change(本次变化说明)、sourceIndexes(本次依据)、result(完整变更后 topic/content/sourceIndexes)。变化依据必须包含本轮消息；result 的依据包含本次依据；更新还可以继承该目标记忆的原有来源索引。检查和 Schema 配对归 operations/memory/output.ts。记忆体只接收 result，不持有 action/change 或调用记录 ID。不做模型生成内容的真假认证。
- 记忆候选接纳先校验结构、目标、引用和原始候选的重复更新；update.result 的 topic/content/sourceIndexes（含索引顺序）与本轮旧记忆完全一致时过滤为无操作，不修改记忆、不登记 MemoryRecord。不根据 change 声称“没变化”判等，不做措辞或语义归一化。仅剩余真实变更要求本轮依据；其他引用、目标与结构限制不放宽。InvokeModel 保留原始候选，AcceptModelOutput/操作输出仅含接纳变更。记忆提取不增加错误反馈与再次生成；回答生成仅使用下文明确声明的有限处理。
- MemoryRecord 继承 BaseRecord<MemoryRecordValue>，持有 memoryId，value 为 action/change/sourceIndexes/result。由 Memories 在变化落实后调用共享 Recorder 登记；可选 contextId/callId/executionId/operationId 表示实际因果调用，调用外变化不伪造归属。InvocationRecordHelper.source 在调用侧解析来源链接，ChangeSource 携带已确定的 contextId/callId/executionId/operationId；内容审查和通用 Recorder 不查询调用关系。MemoryRecordHelper 负责构造记录与按 memoryId 查询，Memories 自行交给 Recorder 登记。
- 运行事实与记录独立：不注入 Recorder 仍能创建/更新记忆，不产生 MemoryRecord。记录失败沿当前错误链传播，不假装事实回滚；整批语义/引用检查失败不改变任何记忆，但不承诺登记异常时批次原子性、补偿或恢复。提取失败仍保留之前已生成的回答。没有运行成功变更的候选只留在操作 IO 中，不产生 MemoryRecord。
- 下一次提取发送当前记忆体及来源索引，不沿引用加载旧原文，不读取历史 MemoryRecord，不把记录混进运行输入。MemoryInput 还包括本轮消息、正式回答和筛选候选原文；候选不宣称全部用于生成。每轮开始由 ObserverExecutionDefinition 取得已绑定的 memories 正文快照 previousMemories；SelectionInput 显式包含 message/memories，SelectHistory 的目标导向短提示词及实际请求使用这些记忆和原始 history。生成使用当前 message、选中原文和同一份 previousMemories，允许有限继承旧段理解。prepareMemoryInput 接收同一份 previousMemories（不重新读取更新中的实例），提取完成后更新 Memories，下一轮筛选读取新的记忆。记忆不插入 Transcript，不从 MemoryRecord 消费；全部内容纳入现有容量检查，整个请求超预算直接失败，不裁剪或压缩。
- GET /api/memory 只读投影当前记忆体和 Book 中已有 MemoryRecord，页面直接展示每次登记的变化说明、依据、结果快照和执行/操作记录 ID。MemoryRecord 不虚构 Context 或调用事件，不加入 E/O/A 时序节点；实际落实发生在提取操作的 ApplyMemory，沿该操作记录可以追踪。详细结构见 docs/memory.md。本轮不增加记忆层级分类或记忆之间的关系协议，不实现召回、持久化或恢复。

- QA 仅是执行观测视角：独立导航对应等宽主图列，轮内 E/O/A 按计时布局；上下文行是关联信息聚合，不按时间缩放原文。单一 QA 选择联动弹层中的 IO、MemoryRecord 和调用详情。inspectExecutions 从既有操作读取回答，提取输入中的 currentIndexes 定位原消息；不按相邻索引或文本配对。失败轮保留空位；历史 QA 读当时的记忆记录快照。查询接口不创建记录，不引入 QA 运行实体、持久化或重放。

- 记忆提取以准确、可延续、修正过时认识、保留有效条件与不确定性、减少无意义重复为目标。理解的划分、粒度和综合方式由模型判断，不预设主题分类或抽象层级，不禁止基于已有记忆形成更综合的理解。保持现有 create/update 输出 Schema、ID 与原文索引校验；不把当前操作集合的局限当作知识组织原则。不承诺模型一定收敛到最优划分。

- Transcript 分段使用稳定绝对索引的边界，activeStart 指向当前段，segments() 返回历段。消息仍只有一份，不复制正文、不删除旧段。E entry.admit 的业务分段策略在创建本轮 Context 前，若完整筛选请求超限、仅当前输入和记忆可以容纳，则优先从最近两轮完整 QA 的起点开启新段，预算不足降为一轮、零轮；只调整边界，不复制消息。observer/segment.ts 仅从本次输入向前识别紧邻的 user/assistant 对，遇到不完整或非交替内容停止，不跨缺口或旧段补齐。旧 Context/Record 范围不变。提取只加载本轮 QA 与当前段选中原文；更新 result 可保留该目标记忆已有的旧来源，本次变化依据必须来自可见原文并包含本轮消息。不开后台压缩，不额外调用模型。详见 docs/transcript.md。

- REOA 的 Binding 将平级 run/exceptions/observation 内容接到固定结构，委托对应 InvocationBuilder 建立调用。ContextBuilder 构造现场与检查归属；InvocationBuilder 注入观测/变化捕获和运行控制；Invocation.run 驱动 execute、正常 accept、异常 handle 与终态。run.accept 缺省时直接接纳成功输出，旧 receive 混合入口已删除；内部记录阶段仍用 receive 表达正常接纳，handling 表达异常处理。maxRounds 默认 1，只允许 1 或 2；正常 accept 可用 continueWith，异常 handle 返回 return/continue/unhandled，继续均由结构检查。绑定一次完成，不新建独立异常装配链或通用恢复策略。
- 同一次本地循环复用一个 Context；开启记录预设时对应一个调用 Record。Context.input 保留初始引用，currentInput 是当前轮输入；progress 只保留 round/phase/当前输入与本轮 execute 结果，不维护历史，不复制 IO。现有具体 execute 消费 currentInput，接纳契约读取所属操作的 currentInput。继续操作不复活已结束的子 Context，子调用仍每次创建独立 Context/Record。
- 调用记录 value.processes 按顺序追加 execute start/return/throw、receive return/throw/continue、handling start/return/continue/unhandled/throw、control stop。每项包含记录内 sequence、round、occurredAt、执行内 offsetMs 和对应正文，失败可携带 failure 的类别、阶段和归属。没有独立 ID、RecordBook 条目或跨过程索引；正文登记时复制冻结，旧快照不随后续追加变化。过程不是第四层执行实体，InvocationBoundaryRecord 仍只描述整个调用的 call/return/throw。
- 每轮及正式端点检查取消、活动范围和既有错误。ExceptionContract 按对象身份匹配，只有本层 raises 或直接子调用已经确认的异常才能进入匹配 exceptions.handle；未处理异常可按调用关系交付，R.run 出口转为 UNHANDLED_EXCEPTION 并保留 cause。结构、绑定、调用机制、未声明抛出、处理器抛错或非法结果均为错误，不递归进入业务处理。正式错误一旦归属，即使业务 catch 或换抛异常也不恢复成功，后续正式端点停止接纳。RecordingError 和 ChangeCaptureError 保留已发生事实，不重做工作；固定诊断路径可保留 AggregateError。错误收敛机制自身失败按 bug 暴露，不增加第二层处理、自动修复或进程恢复保证。

- 单条调用记录内复用成功结果：execute.return 保存正文快照，默认 receive.return 用 resultOf 引用同轮紧邻 execute.return。自定义 run.accept 与 exceptions.handle 的返回分别记录正文，即使返回同一对象也不按身份去重。最终结果引用最后一次 receive.return 或 handling.return 接纳的直接正文，不形成链、不跨记录或轮次；消费者使用 protocol 的 readOutput。callRecording({input,output}) 只投影记录，不改变 Context/业务 IO；关闭观测时不执行描述。安装默认 isolate，可显式 propagate；当前服务采用 isolate，完整性来源独立失效。

- 调用图 E/O/A 只在同一问答列内按共同耗时比例定位，问答列等宽，轮首可读实际开始时间；等待时长不占宽度。独立导航位于搜索区下方，固定块宽、独立横向滚动；主图纵向滚轮调密度、横向平移，锚定鼠标位置，导航不会跟着缩放。左侧固定标签为问答、上下文、执行、操作、意图。上下文行聚合所选历史、可见记忆与变更入口；全文归对话或详情，不再保留底部摘要和重复状态栏。Attempt 的 processing/provider 是 target 描述，不伪造额外 Provider 调用层。弹层展示既有 IO、内部过程、上下文记录、记忆变化及当前源码，不创建观测专属运行记录。

## 本轮运行边界

- 具体结构见 docs/runtime-boundaries.md 与 docs/observation.md。Runtime 实例持有占用；每次 R.run 建立独立 RuntimeContext/Invocation。环境独立建立消息、记忆、供给、Recorder 与来源适配。RuntimeRecord 是记录安装的跨调用根，RuntimeCallRecord 是单次 R 调用；实例寿命与数据范围分开，不实现恢复或实例完成状态。
- 顶层占用由 Runtime 实例维护，R.run 经自身声明选择 E；HTTP 不维护重复 executing 标志。REOA 都拒绝跨构造范围现场。占用取得后无论构造、工作或观测失败都释放。
- Recorder 由环境装配；调用、资源与实体只发布类型化事实，不依赖 Recorder。callRecording 声明申请本次写端口，RecordingCall 局部持有记录句柄与父预设关系；实体通过 observation 端口独立接入。无记录运行必须成立。

- 对话业务交付通过本次 options.deliver；绑定将其作为 ConversationResource.delivery 交给 E，回答接纳后发 answer。HTTP 在 started 回调与 R 完成后交付 started/completed。回调不写入 Context 正文，不保存在可复用定义，也不维护 Context→回调表。回答后处理错误仍保留已落地消息；观测失败不回写对话结果。未增加 token/part、外部协议或业务恢复。

- 构造边界：核心 Context 只处理现场、信号、本层资源与私有归属；bindObserver 处理来源捕获，E entry.admit 处理分段业务策略。Runtime 让渡构造能力到 BindingEnvironment，业务工作不持有它。构造不登记记录，run 才登记；运行前及 execute/正常接纳/异常处理阶段检查父级活动与正式错误状态。手工 Context 仍可用于低层测试，不扩展为权限或状态机。详见 docs/runtime-boundaries.md。

- 记录树本轮：parentId 在构造时确定，CompositeRecord.childIds 只由统一登记内部替换，不对业务开放挂接/迁移入口。RecordTree 只查询归属及准备关系变更，不持有另一份关系集合；具体类型关系规则归 records/tree/relation.ts。RecordRegistration 同步落实并在失败时清理本次登记，成功后一次 add 通知附带 related 父记录。它不回滚消息或记忆事实、不承诺持久化事务。调用索引已移除；不把调用绑定、事件时序和记忆语义搬进 RecordTree。详见 docs/recording.md。

- 局部顺序本轮：Invocation 为已有内部过程分配 sequence，重试继续递增，无 Recorder 也推进；记录只接纳并检查顺序。Memories 对正式变化递增 sequence，MemoryRecord 保留 memoriesId/sequence/memoryId；无变化与预检查失败不占号，登记失败不回滚已落实变化及序号。消息仍使用原有 index。范围查询、快照收集、下级结束检查已使用 RecordTree，记录范围隔离使用独立 RuntimeRecord 与 RecordTree.root。前一事件查询已迁移到 InvocationBoundaryRecordHelper.last，调用索引及旧 Context 映射、重复登记限制已移除。观测基线与增量已接通，见 docs/observation-increments.md；不得通过快照 diff 反推变化或将局部 sequence 当作交付游标。

- 调用与观测绑定：Invocation 不持有记录、记录来源或 Context→Record 查询。BoundCallObservation 持有已安装观察者及其失败状态；RecordingCall 是可选预设的局部记录句柄。业务视图只见本层资源和只读关系。实体接收 origin 与本次观察端口，ChangeSource 仅在记录预设内部构造。未声明记录预设的范围不制造空记录。

- Runtime 记录：BaseRecord/CompositeRecord 为通用载体；RuntimeRecord 为跨调用根，RuntimeCallRecord/ExecutionRecord/OperationRecord/AttemptRecord 为调用载体。归属为根→R调用→E→O/A。R调用独立计时，边界记录 scope=work，不伪装实际交付；E仍是QA展示根，详情可看父R及关系。

- started 接线使用 InvocationStarted 公共类型和 ExecutionStarted 执行特化，入口与 Builder 不重复声明签名。同步回调在 validate 后、记录登记前执行，Context 已建立但尚未发布 started；E 回调失败通过父 R 的 entry 事实解释，不伪造 E 工作记录。保持原时机，不增加异步钩子或生命周期管理器。

- 变化生产与捕获：Transcript、Memories、Invocation 和 Recorder 分别在正式变化处产生不可变事实，窄接口 ChangeCapture<E> 由环境共享的 ChangeObserver<RuntimeChange> 实现。内容和调用进度不依赖 Recorder。capture 不执行消费者；wait 唤醒异步消费，take 转移当前批次，不赋予业务原子性或持久化保证。捕获失败保留已落实事实，ChangeCaptureError 禁止调用循环重做工作；记录失败不抹去已捕获的内容变化。
- Service 的 ChangeConsumer 独占共享捕获器的 take。RecordSource 在首次观察前建立并接入 invalidate，open 原子提供基线及订阅。记录漏写则 SOURCE_INCOMPLETE 永久终止该历史来源的连续交付，不靠重基线假装修复；网络连接失败不损坏来源。基线保留活动R及其已完成E子关联。消息同步独立。
- Service observation/delivery.ts 以 ObservationSource/SourceReceiver 结构契约接受来源委托；bindDelivery 负责基线接续、入队、增量投影、失效优先和关闭。Feed 组合公开映射与其他来源的独立水位，不制造跨源原子性或统一 revision；辅助不进入内核，不引入载体基类。
- 客户端 ObservationReplica 原子接纳整批增量，检查传输与来源位置；普通序号缺口最多自动重建一次健康来源基线，SOURCE_INCOMPLETE 不自动重建。runtime-call、relation-appended 与工作边界纳入校验，详情显示父子接纳，QA数量仍只算E。没有重放、ACK或业务恢复。

- 入口主体、稳定能力与本次参数分开。InvocationCapabilities 提供 observations/changes/clock；省略 observations 关闭声明，显式 [] 启用声明但不附加预设。clock 独立于 Recorder，可由环境共享。调用输出事实的 eventSequence 与过程 sequence 分开，cycle 不感知消费者。实体 provenance 只传 origin/observation，不传记录身份。

- ChildBindings 按已声明直接子项建立 ChildCall（窄InvocationView加run），父调用内部持有真实 InvocationRelation；业务只见关系只读投影、实际返回、failure 和接收状态，不经子调用 Context 取得资源端点。关系不限EOA，不成为新调用实体，无Recorder仍建立。普通IO和异常保留原身份，供有限重生成证据使用；不暴露 accept/returnedWith/record 或上下文状态修改入口。
- Sequence 是可复用的顺序组合定义，step 声明 use/input/可选 accept，类型约束子输入输出与已完成前项输出。每次 run 的输出容器独立；key 是组合工作位置，不是行为实例身份或记录 ID。Observer E→O 与三个 O→A 使用同一机制，O→O 也遵守原有层级约束，A 不继续分层。输入构造只组织数据，父层选择计数、回答追加与业务交付在明确 accept 中处理；accept 返回父层接收后的值供后项使用。任一失败立即停止，不建立后续子调用，不重试、回滚或恢复，不增加动态规划、并行调度、持久化或新的协议/记录类型。详见 docs/runtime-boundaries.md。

- GenerateAnswer 最多两轮：首轮完整模型返回因 INVALID_JSON、EMPTY_OUTPUT 或 OUTPUT_SHAPE 被拒绝时，AcceptModelOutput 显式生产 modelOutputRejected 契约异常并由 A.raises 允许交付，父层 exceptions.handle 依据契约与直接子调用关系决定再次生成。InvokeModel.regeneration 声明 completed-output-rejected、最多一次追加调用及允许的错误；entry.accept 再查直接归属、实际返回/接纳状态、次数与完整反馈请求。再次生成保留原请求、原始返回和错误反馈，经过 PrepareModelRequest 容量检查后建立新的模型/接纳 A，不重跑筛选/上下文组装，不重复追加回答。判断不查询 Recorder，GenerationInput 不夹带调用引用。超时、网络错误、取消、非 stop 返回、记录/变化捕获错误及内容落实后的错误不自动重试。此能力是服务内当前无工具模型调用的明确入口，不是通用重放策略或对任意父层代码的权限约束。详见 docs/runtime-boundaries.md。

- 组合负责构造子调用输入，能力内部继续完成请求组装、容量检查和输出接纳。AcceptModelOutput 输入显式携带 output 与按需的 basis：历史选择为有效索引范围，记忆提取为本轮 MemoryInput，回答只有 output。不从父操作 currentInput 强转校验依据。resources.values 不纳入调用记录 IO；父 Context 引用为私有直接关系，仅保留框架归属与活动检查；移除 Runtime 的 getExecutionContext/getOperationContext，不作为业务资源查找链。
- 资源机制在 resource/。ResourceOffer 由资源公布来源类型、访问接口、capture 与 describe；业务以request正式申请，provider供应独立实体。装配按offer身份及唯一供应者检查，同一装配不同offer不能使用相同正式name。共享供给、固定捕获和惰性失败缓存；逐调用创建本地端点、来源及资源事实序号。静态装配不记录；关闭观测不运行描述/输入输出映射，不强制兑现lazy模型。
- TranscriptResource 公布 fixedRange/append/segmentation，MemoryResource 公布 snapshot/apply，SelectionUsageResource 公布 record，服务公布配置及模型访问。Context建立后attach本次来源，调用started发布后start资源事实；正式方法保持同步/异步形式，调用或入口窗口结束后旧端点也拒绝访问。返回数据仅是约定快照/值，不返回原实体或记录能力。原文定位与读取方法分开，slice只收窄。

- 声明/绑定/结构：REOA 平级包含 run/exceptions/observation，R 声明 E children，当前服务配置一个E。工作与异常处理分别申请资源及子能力；观测声明是严格同步的类型化消费者，端口按处理窗口失效。安装局部资源只满足观测请求，不赋予工作或处理器；缺失已启用的依赖为装配错误。默认静默、安装默认isolate、服务采用isolate并使不完整来源终止；观察者失败后停用，健康消费者仍收到本事实。

- 父关系事实为 attached/returned/receiving/accepted/failed，统一用父调用 eventSequence。returned 描述子真实交付；接纳状态单独保存。父观测失败不能进入子run的catch；accepted已成立后观察失败不改成failed。记录载体的relationChanges独立于processes，保证resultOf仍引用同轮紧邻结果。
- Runtime结构事实建立/占用/释放/入口错误沿实例顺序发布，不借用任何一次调用身份。必要捕获与可选观察对同一已落实事实分别尝试；故障汇集后结算，不回滚实体、不重复工作、不递归观察自己写出的载体。消息与记忆同实体发布期间拒绝重入变更。
