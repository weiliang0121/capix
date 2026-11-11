# CAPiX 协作约定

本文件维护协作边界、共同不变量及当前文档入口。具体模块契约归对应文档；设计推演和实验报告记录当时结论，不自动成为当前 API。文档导航见 [docs/README.md](docs/README.md)。

## 仓库边界与工作方式

- CAPiX 是独立的 C/S 可观测 Agent 框架。仓库承载框架、可复用集成、预设、策略及 UI；可复用包统一位于 packages/。实验、Observer／Conversation 参考服务及应用已交接到独立的 capix-lab；未来产品另建仓库。参考业务策略不自动上升为内核规则。
- **CAPiX 独立维护并验证自身契约，capix-lab 是实验与参考装配仓，不是框架测试仓。** 不将 Lab 检出、测试、夹具或候选验收设为 CAPiX 构建、合入与发布的前置条件。Lab 发现的框架违约应提炼为 CAPiX 自身可执行的回归；具体宿主实现与实验仍维护自己的验证。
- **外部业务装配项目可以只读参考 CAPiX 的代码、文档和公开包，不能因业务任务自行修改 CAPiX 的源码、测试、配置、文档或 AGENTS.md。** 发现内核缺口时先在业务项目记录复现与建议，由用户在 CAPiX 的任务中明确决定并授权变更。业务装配任务的授权不包含回写框架。
- 外部业务项目的凭证、环境路径、交付规则与工作约定留在各自仓库，不写入 CAPiX，不作为框架依赖。不读取其他项目凭证，不从外部配置或 Git 历史取得隐式运行环境。CAPiX 自身配置正常维护。
- 相邻 capix-explorations 只在用户需要时只读参考；不复制旧工程的整套模块或治理配置，不作为运行依赖或当前设计约束。
- 人参与关键对象、职责和调用关系的决定。按已确定的小闭环推进，核心对象维护自身不变量；helper 组合明确操作，独立生命周期才构成新增实体的依据。不要因整理目录提前建立平台。
- 修改前检查并保留已有未提交工作。整体实施得到授权后完成实现、审查、必要验证与修复。不推送、部署或发布；普通测试不调用真实模型。
- **当前开发阶段不维护旧存量升级路径。** 新库直接创建当前格式，只打开当前格式；旧库、旧 CP 或旧业务契约明确拒绝，不自动升级、清空、降级读取或伪造缺失依据。使用新路径或由用户明确重置本地数据；拒绝打开不得修改旧库。当前版本重启载入、交互读取和显式 CP 恢复仍是正式能力。
- 不推进 TRS、动态调度、外部能力平台、权限系统或强制 continue-as-new；新增需求需独立论证。不要把性能优化扩大成新的恢复或事务承诺。

## 包与依赖边界

品牌保持 CAPiX，packages/ 中 18 个公开包统一使用 @weiliang0121 scope 和 capix- 前缀，此前首发名称不变，新增 tool 尚未发布。两个 @capix/* 私有客户端包及其测试已迁至 capix-lab/packages，由 Lab 维护。capix-lab 可通过明确的 18 包 tarball 批次开展实验，不能读取相邻框架私有源码；候选分发不形成两仓测试依赖。发布契约见 [npm 发布](docs/npm-publishing.md)。

一个根 pnpm Workspace 与锁文件。包按职责划分，跨包只使用公开出口，不导入其他包的 src/dist 私有路径；包独立不意味着新增实体生命周期。

| 包／目录                                                                | 职责与边界                                                                                                                                      | 当前文档                                                                                                             |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| packages/contracts、packages/protocol                                   | contracts 是进程内共同契约及唯一 RuntimeError；protocol 仅维护 Transcript 的明确 wire 与单帧接纳，无 Node/HTTP/UI 实现；领域不反向依赖 protocol | [契约与协议](docs/contracts-protocol.md)                                                                             |
| packages/resources                                                      | Resource、Offer、Request、登记、固定绑定与单次访问；不依赖 Runtime、结构、调用实现                                                              | [资源](docs/resources-package.md)                                                                                    |
| packages/structure                                                      | Callable/Scene/Group/Node、配置与成员、作者类型、Sequence/Dynamic；只依赖 resources/contracts                                                   | [结构](docs/structure-package.md)                                                                                    |
| packages/invocation                                                     | 单次 Context/Invocation、Control/Execution、关系、接收、输出、窗口及 CP 活动；不依赖结构、Runtime、记录、内容实体                               | [运行边界](docs/runtime-boundaries.md)                                                                               |
| packages/checkpoint                                                     | Frame v6、固定值块、增量关系/选择认证、Store；不持有活调用或资源                                                                                | [Checkpoint](docs/checkpoints.md)                                                                                    |
| packages/runtime                                                        | 结构绑定、资源范围、运行装配、Runner、作者 Work 适配；不建立平行 Bound 树                                                                       | [可调用结构](docs/callable-structures.md)                                                                            |
| packages/interaction                                                    | 固定请求、独立发送、持久反馈、局部等待及可选有界过程流；不依赖 Invocation/Runtime                                                               | [交互](docs/interactions.md)                                                                                         |
| packages/transcript、memory、view、measurement                          | 独立消息、记忆、视图与使用计数及资源契约；不反向依赖 Runtime                                                                                    | [实体包](docs/content-entities-packages.md)、[View](docs/view-package.md)                                            |
| packages/records、changes、diagnostics                                  | 记录实体；变化捕获/转交；PersistenceError 与有界诊断。真实故障归属仍由 Invocation 决定                                                          | [记录](docs/recording.md)、[异常](docs/exceptions.md)                                                                |
| packages/model-provider、model-exchanges                                | 原生模型协议适配；完整回复、工具反馈槽位及固定接纳凭据实体。模型只是资源能力之一                                                                | [工具接入](docs/native-tool-integration.md)                                                                          |
| packages/tool                                                           | 原生工具调用的普通 Group 预设；固定起点、目录、串行推进及可选 CP；不依赖 Runtime 实现                                                           | [Tool](packages/tool/README.md)                                                                                      |
| capix-lab/services/observer-content                                     | Observer 参考内容组合、ActiveView 策略及同步；实现和测试由 Lab 维护                                                                             | [活跃材料](docs/active-content.md)                                                                                   |
| capix-lab/services/conversation、observer                               | 参考业务装配、宿主持久化、HTTP/CLI、恢复资格；SQLite 和业务策略留在服务                                                                         | [Conversation](../capix-lab/services/conversation/README.md)、[Observer 装配](../capix-lab/docs/service-assembly.md) |
| capix-lab/packages/client-runtime、client-http；capix-lab/apps/observer | 无 UI 的会话/消费生命周期；HTTP 接纳；React 投影与展示。服务端与客户端不互相依赖                                                                | [客户端](docs/client-runtime.md)、[协议](docs/protocol.md)                                                           |

Message／定位／领域变化归 transcript；InvocationEvent 与阶段词汇归 invocation/events；记录值、归档与核验归 records/data，两者有不加载机制或实体的纯数据出口。Conversation／Observer DTO 和业务端点接纳归 Lab 私有 lab-protocol。共同类型按实际协作需要从包内晋级 contracts；进入 protocol 还需明确序列化、接纳和版本。源码目录先表达对象或能力归属，不等同于创建者或持有者。

## 结构、资源与调用

- 作者起点是 Scene、Resources、Runner，可选 Interactions。宿主 `new Runner(scene, resources, interactions?, capabilities).build()`，然后 `run(input)`；Runner 固定场景和机制，不暴露第二个 readyScene/Run 实体。
- 结构配置是 deps/run/output/checkpoint。Scene/Group 组合 Group/Node，Node 无 members；类型和绑定均拒绝非法位置。结构在一个树内唯一，复用业务函数、定义或资源，不共享结构实例。build 只固定声明/成员位置/接线，不执行按次 capture，不创建 Invocation。
- Builder/Binder 将运行能力安装到原结构，不建立平行 BoundCallable 树。结构不持有单次输入、信号或执行状态；Runner 独立管理入口占用，失败和取消都须真实释放，不隐含排队。
- 普通 run 执行一次，处理函数只接收当前阶段 Work；成员来自 add，不重复声明 uses。恢复点另声明 resume.deps/uses。facts/open 提供历史依据，不授权创建或恢复；准确身份和窗口仍须运行期核验。
- Sequence 以完整步骤数组构造，Dynamic 的 options/decide 都是普通成员；配置构造时固定，不引入新 kind 或 Runner 分支，不自动提供 CP 恢复。
- `Resources.register(new Resource(origin), offer)` 固定供给，Offer UUID 和准确对象身份用于区分，name 仅描述。Offer 使用 methods，特殊固定凭据、同步值或订阅清理可用低层 expose。Request 只表达类型化申请，不保存端点。
- 本层 deps 与子树 supply 分开。显式 capture/refine 选择结构位置和输入，不由 kind 推断资源捕获边界。子树供给不扩大父 Work；收窄不能扩大授权，不影响兄弟及父供给，不是动态能力注册。
- 资源绑定打开不可重开的访问窗口，各次操作保持局部状态。端点核验本地调用/阶段/固定信号，不递归查询祖先可变状态。业务不取得 origin、Invocation 或内部 Context；关闭观察不触发资源描述或惰性模型构造。
- 领域事实使用 changes 的 FactType 精确匹配与稳定正文；operation.facts(type) 固定本次资源操作，关闭后不可发布。ResourceFact 的调用／操作来源证明转交关联，不自动证明造成效果；不把它作为 wire 或 CP 数据。Invocation 与 CP 活动只转交通用事实，记录解释由显式适配承担；strict/isolate 与已发生效果分别保留。
- 普通资源与子调用共用 `delta/result:{succeeded?,failed?}` 操作接收结构。invoke 提供便捷调用，create→checkpoint→invoke、run/accept/open/facts 保留精细边界。returned 与 accepted/handled 分开，不自动接纳。
- Invocation 协调正文、接纳排空、Work/资源关闭及最终交付；等待已启动子调用真实退出，不等待未启动关系或独立 Interaction，不自动停止兄弟。资源 Promise 不因未 await 自动成为子调用。
- 取消只请求停止，不以 Promise.race 提前释放。收尾不恢复资源权限，纯计算接纳与访问已关闭资源的接纳可能结果不同。正文/关闭/持久故障分别保留，不能用普通 catch 清除已归属故障。详见 [退出契约](docs/invocation-exit-contract.md)。
- ChildCallFailure 绑定准确关系来源；原样 rethrow 保留凭据，解包换抛不扫描错误追认来源。业务 Error/DeclaredException 可按明确 failed 分支接收；取消、装配、捕获、CP、严格观测和持久故障受保护。接收回调失败不再次进入同一 failed。
- Runner.output 是 Scene 整体输出的宿主出口，子输出显式转交；observation 发布固定运行元数据。每次 run/resume 有独立 entryId，恢复可复用 contextId。订阅不安装机制、不改变交付、不自动记录或回放；坏消费者隔离。详见 [运行出口](docs/runtime-ports.md)。

## 稳定事实与有限恢复

- `stableValue` / `Stable<T>` 支持 undefined、null、布尔、字符串、有限数（含 -0）、密集数组和普通/null 原型记录；缺失与显式 undefined 不混同。函数、Date/Map/Set/Error 实例、能力对象、访问器、隐藏/symbol 字段、稀疏数组、循环拒绝。
- 输入在 capture/refine 前固定；返回候选在取得后、关闭/最终成功前固定；accepted/handled 在接收回调返回后、安装前固定。CP 开关不改变含义，修改原对象不能改写历史。真实 Error 仍传递原引用，只固定失败诊断；不冻结实体、端点、Work 或闭包。
- 固定内容、正式交付成功、持久保存是不同事实。进程内仅复用经过认证的不可变子图，冷恢复重新验证，不承诺对象身份/DAG 拓扑相同。稳定值限额：深度64、展开1000000值、文本与键合计64 Mi UTF-16代码单元；不是堆配额、CP额度或Proxy沙箱。
- reception 是固定接纳值的恢复编码契约，不是额外业务阶段；绑定准确成员/位置/方法，不能事后补标签。check 只依赖固定值及绑定参数，在成立边界同步校验，返回值不替换原值；异步/thenable 拒绝。首次发布执行 codec 并验证往返，后续复用，冷恢复重新解码校验。
- CP 仅恢复显式 point 及完整依据，不恢复 JavaScript 栈、草稿、任意位置或外部效果。失败子调用不复活；已保存 handled 直接恢复，不重跑已处理回调。新执行只有 round 1，无 continuation；旧业务契约与旧 Frame 拒绝，不自动转义或升级。
- Context/Relation 持有事实，CP 消费已成立稳定依据。Frame v6 逻辑仍有完整直接关系与作者 state/refs；物理提交为新增固定值块、变化关系、选择变化及 head。Store 同事务比较 revision、owner/contract/input 和不可逆终态；准确回执才推进热依据，提交不确定不能冒充失败未提交。
- state 每次完整编码，point.check 每次执行且只允许同步查询窗口；已取出的稳定事实可保留。refs 是作者选择的恢复角色，不由接纳关系自动派生。many 支持完整数组替换，或 `work.checkpoint.select(definition, saved?)` 的有序增量选择；重复出现独立，remove 不删关系，跨点必须显式传入，准确恢复数组才接续原选择身份。
- 热保存只处理新事实/变化与新增或删除出现项；冷恢复完整重建核验。查询按实际读取计费，主动遍历仍有成本。完整逻辑限额8 MiB／100000值／深度64／4096直接关系不因物理去重放宽。选择墓碑与历史身份保留拒重，无自动整树退休或分段。详见 [增量选择](docs/checkpoint-selection.md)。
- Store 的关系解析缓存按连接共享，owner/child 隔离，默认4096项/16 MiB；多会话可相互淘汰，每次仍核对准确SQL行，淘汰只增加解析成本。持久引用与进程内身份不是同一证明。
- 恢复前核对结构版本、准确父子关系、原输入、资源接线及宿主实体/交互依据；通过资格前不得执行资源方法。缺首子CP、失败终态、未知交互反馈或无法确认效果均拒绝，不能重发试探。本地排他不是跨进程租约。
- 实体固定写入由各自资源契约明确采用准确调用或接纳来源，业务只补 position；Memory 使用实际调用 contextId，ModelExchanges 使用真实 reception，不把二者隐式互换。实体可以把效果和凭据同事务提交；这不构成资源、接纳与CP的统一事务。固定文件创建pending表示未知，不凭文件存在猜成功。内核不替任意外部资源承诺幂等或安全重做。

## 实体、交互和参考服务

- Transcript 正式消息只追加；Memories 独立于 Transcript，以集合统一写入固定的 `{id,value:{content,metadata?}}`，更新保留单项 UUID，不保留 topic 或强制来源；`memoryResources<Metadata>()` 创建一次供作者与宿主共享的准确 Offer。View 仅保存来源范围、成员及派生索引，不持有实体或活动端点。has/members 本地查，include 仅核验新增项，exclude 不读来源，apply 依据完整版本核验。退出视图不删除实体、不强制替代内容或来源累加。
- Memory 的领域类型与变化事实归 memory，不依赖 protocol；状态与固定请求使用当前 v2。完整 Stable 材料不等于 JSON，持久／CP 适配需明确保真 codec；默认 records／wire 仅投影 content 与可选 reason，不冒充实体恢复依据。持久端口异常后该 Memory 实例拒绝新写入及当前查询，准确旧回执仍可确认；由宿主从权威存储重新载入，不自动重试。发布失败不撤销已安装内容，也不使实例进入提交不确定。
- 实体同步变更先检查、持久成功后安装，再发布变化；无变化也应完成要求的依据核验。持久异常和同步契约违规属于 PersistenceError，不凭本地未安装推断外部未提交。读取快照不隐含全局事务，版本不可复用，冲突不自动重试。
- ActiveView、ConversationContent 及内容同步整体归 capix-lab/services/observer-content 参考装配，尚未作为通用公开预设发布。Transcript、Memory、View、Resources 等共享机制继续由 CAPiX 维护。内容策略、材料选择、记忆提取与压缩是业务可替换 Node/Group 或实体预设，不把模型判断和默认策略固化成内核职责。完整材料和供模型查看的活跃视图分别表达。
- Interaction 固定请求只发送一次，与调用独立存活；signal只终止局部等待，晚到反馈可保存并再次读取。宿主关闭先停止本地入口，再等其持有的外部发送 settled。未知反馈不自动重发。
- 可选过程流由发送侧发布、本次资源操作订阅转交；有界临时回放和游标有序读取，不承诺持久增量或跨调用恰好消费一次。流超限/失效不能伪造完整前缀，结束不等于反馈校验、持久或父层接纳完成。
- 工具是已登记成员；公开 Tool 是普通 Group 预设，作者用 tools 对象登记节点、参数 Schema 和结果映射，普通资源登记 ModelExchangeResource / ToolModelResource，不要求 capture 或专用 installer；默认不开 CP，恢复显式依赖成员 CP 和原交互查询。目录/成员同源，固定policyVersion、Schema摘要与预算；Zod升级可能改变目录摘要并拒绝恢复。结果映射必须纯且无副作用，异步映射不获得幂等保证。model-exchanges独立持有固定起点（初始请求与模型可见目录）、归属于起点的完整回复、反馈槽位及固定接纳凭据，不依赖调用/结构/服务；快照v2，资源直接登记实体。起点不包含执行节点或授权，目录兼容由执行方核验，准确引用不授权重发。当前接口见[ModelExchanges](packages/model-exchanges/README.md)。
- capix-lab首版参考工具串行，CLI/Web显式选择 material/tools，默认材料链不变；工具模式提供真实阶段和最终回答，不转交候选正文。旧装配的ToolAnswer/Loop分别capture，entry管理ToolExchangeUse；尚未适配固定起点，不能据此给新实体添加capture要求。列表只给unchecked候选，终态不复活。
- 模型子输入可只保存起点与交换前缀引用；完整请求在资源发送边界形成并交给Interaction保存。反馈槽闭合与协议续接资格分别核验，历史前缀重建不自动取得恢复资格。模型协议适配不重试，响应有界；SSE需固定回复身份、完整终态和DONE，仅选用正文增量，原生续接材料完整保存。Key只由宿主配置，不能输出、记录或传给客户端。
- 联合归档门槛覆盖材料/工具及resume，读查询不门控；参考上限2 GiB、经验缓冲512 MiB、在途交互估计2 MiB，仅是入口门槛，不是硬配额或任意执行上界。ToolLoop、存储与模型各自限额分别成立。
- 新服务默认维护仅在正式助手消息后提取；可处理的提取失败可按明确 failed 策略跳过，保存/捕获/依据故障仍传播。消息、记忆、View各自保留真实结果，不伪造跨实体事务。Scene等待维护再最终交付，已落实回答不因后续失败消失。
- 记录是可选实体与观测消费，业务/恢复不依赖Recorder。Web主动start/stop/clear，默认idle；stop等待已选入口释放，不取消业务、不等待独立交互。隔离漏记标为不完整，不能重拉基线伪装修复；恢复产生新活动而不伪造过去调用树。
- HTTP提交独立于连接；断线只停止消费，查询/follow不恢复执行，POST不自动重发。未知/淘汰身份不等于没执行。正式消息、输出预览、入口最终交付、连接健康分别表达；持久内容恢复不恢复旧提交/队列。服务端最终接纳检查仍必要，ready不预占。
- 客户端连接替换先转移归属再abort，重入核对身份；可恢复传输缺口有限重建基线，身份/正文冲突终止自动恢复。UI微任务/帧合并发布不能跳过真实增量接纳。服务配置、SQL、模型和前端投影不进入protocol。

## 编码与验证

- 测试按被维护的契约跟随包；跨包组合归真实协调者，不能因使用多个包就放入全局。公共测试工具可放根目录，但不得隐式装配 Runtime 或反向引入上层包；包之间不导入彼此测试夹具。根部仅保留必要的 workspace／测试发现／分发检查。18 个框架包测试位于 packages/*/test；客户端测试位于 Lab 的对应包内，公共工具位于 testing/support，仓库检查位于 testing/repository。单包 test 构建依赖后运行；全仓 check 只构建一次，空测试范围、缺产物或未声明依赖不能静默通过。归属与命令见 [包内测试与框架自证设计](docs/testing-organization-design.md)。
- Node22.23.2、pnpm10.7.1、TypeScript6.0.3；外部依赖精确版本、内部workspace:*。Prettier printWidth1000，不为窄行宽拆散签名。
- 每条变量声明一个变量。循环直接表达继续/结束条件，不用while(true)再内部break；流异常或提前结束也释放资源。
- 类自身ID直接生成，不为ID造无意义别名；不为一次new建立空壳Builder，不为每次检查建立包装层。真实构造协调与对象不变量保留明确归属。
- 通用操作优先使用es-toolkit@1.52.0公开入口；对象身份、严格值域、getter隔离、循环/预算保留专门语义，不用通用克隆覆盖正式接纳。RuntimeError和PersistenceError各保持唯一实现。
- 不保留同义旧API/空壳包装来掩盖概念问题，也不因文件名含legacy就删除仍有真实调用方的能力。删除前核对引用；历史实验须标明范围，不能当生产保证。
- Observer沿用黑灰主题、10/12/14/16px正文/20px主标题；颜色表达操作类别，状态用文字tag。Trace布局和搜索归应用；React+Vite+Tailwind，保留键盘访问，不用原生title遮挡节点。
- 运行与修改相称的构建、类型、回归和格式检查。组织迁移需干净产物构建并验证公开出口；依赖身份变化更新锁文件并frozen-lockfile验证。普通测试离线；性能计时独立进程，不与构建/测试并行，不把采样/计数开销混入结果。
- 完成后报告实际变化、验证和限制。仓库收尾提交包含已验证代码与对应当前契约；不把仅有假设的设计写成已实现，不把历史数据升级混入普通启动。
