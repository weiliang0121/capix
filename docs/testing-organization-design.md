# 包内测试与框架自证设计

日期：2026-11-10。状态：已实施。原测试目录、脚本和 CI 已按本设计收敛，具体迁移与验证见[实施记录](testing-migration.md)。

本轮采用用户确定的边界：**测试跟随被维护的包；公共测试基础可以在仓库根目录；CAPiX 独立证明自己的契约；capix-lab 是实验与参考装配仓，不是框架测试仓。** 这替代此前把 Lab 集成回归列为 CAPiX 常规合入或发布前置条件的安排。运行、恢复和资源承诺不因测试整理改变。

## 1. 目标与迁移前基线

迁移前主库有 182 个 `test/**/*.test.mjs` 文件，`packages/*/test/` 尚无测试。文件数量不是断言数量或覆盖率。20 个包只有 build/typecheck 脚本；根 `test:unit` 发现整个全局 test 目录，部分类型探针和子进程依赖根目录 cwd。框架 CI 已独立执行 check 与 release:check。

现有全局夹具也并非都通用。例如 `test/fixtures/resources.mjs` 引入 Runtime 的 construction 能力；`test/fixtures/runtime.mjs` 同时包装旧执行层级、记录和运行装配。不能只把这些文件改名搬入公共 testing，就认为依赖已经清晰。

第一版拆库按服务依赖迁走了混合测试，保留了原有证据，但这不决定长期测试归属。Lab 中的 CP Store 用例同时覆盖 Memory 和两种 SQLite 实现；handled-reception 文件同时覆盖框架记录、客户端接纳与应用投影。应提炼其中属于框架的保证，放回相应包，不能以“Lab 中已经测了”代替包自身回归。

迁移后的日常体验是：修改一个包，就能在包旁找到其测试、反例、类型用例和必要夹具；只检出 CAPiX、安装本仓依赖，就能执行框架全部正式验收。

## 2. 仓库之间没有测试前置依赖

| CAPiX                                        | capix-lab                                         |
| -------------------------------------------- | ------------------------------------------------- |
| 维护公开与尚未发布包的真实契约及回归         | 探索新场景、参考装配、策略和规模表现              |
| 包内测试、包负责的组合测试、故障与跨进程反例 | 为实验和参考服务维护必要的自身回归与可复现条件    |
| 自己完成构建、类型、测试、分发验收           | 消费明确版本或候选包，记录实验条件和结论          |
| 合入、check、发布不要求存在或通过 Lab        | 不导入 CAPiX 的测试夹具，不提供框架必需的测试基础 |

Lab 可以有测试，但不承担 CAPiX 测试外包的职责。它发现的新反例若揭示框架违约，应在 CAPiX 形成能独立运行的最小回归；如果揭示的是新的能力需求，先讨论承诺，再决定实现。具体 SQLite 故障证据仍随其实现留在 Lab，不把内存测试称为 SQLite 事务证明，也不为了取回测试搬入整套服务。

候选 tarball 的生成与导入继续是可选的实验分发能力，不是两仓测试依赖。不建立跨仓测试用例包、共享 fixture 目录或联合通过状态。实验发现已知的框架错误仍须正常处理，独立验收不等于忽略外部证据。

未来若把一个预设、适配器或 UI 组件正式提取为 CAPiX 包，其实现与契约测试一起归入该包。Lab 保留使用它的实验，无须与框架发布同步更新全部研究。

## 3. 目标目录

```text
capix/
├── packages/
│   ├── resources/
│   │   ├── src/
│   │   ├── test/
│   │   │   ├── offer.test.mjs
│   │   │   ├── activity.test.mjs
│   │   │   ├── fixtures/        # 只为资源包服务
│   │   │   └── types/           # 该包的作者类型正例／负例
│   │   └── package.json
│   ├── invocation/
│   │   └── test/               # 单次调用、接纳、退出、调用侧 CP
│   ├── runtime/
│   │   └── test/               # 绑定、Runner、资源／CP／记录组合
│   └── .../
│       ├── test/
│       └── benchmarks/         # 确有该包性能基准时才创建
├── testing/
│   ├── support/                # 无框架装配的公共测试工具
│   └── repository/             # workspace、发现规则、分发等仓库检查
├── scripts/
│   ├── test/                   # 文件发现、构建协调、执行与汇总
│   ├── release/                # 现有最终发布物验证
│   └── integration/            # 可选候选分发，供实验消费
├── examples/                   # 保留最小公开用法
└── docs/
```

使用现有 node:test 与 `.test.mjs`，不为目录整理更换测试框架。fixtures、types、benchmarks 都按需要创建，不给每个包预建空目录。

根目录不再保留一个收纳所有模块行为的 test，也不另建宽泛的 integration 目录承接难归属的用例。`testing/repository` 是明确例外：它只验证工作区和分发组织，不能逐渐成为另一套全局机制测试。

## 4. 按断言确定归属

归属顺序如下：

1. 哪个包承诺被断言的行为，首先归哪个包。
2. 如果验证的是多个能力怎样被组织起来，归实际提供组织能力的包。
3. 一个文件证明多个独立包的行为，就按用例拆分；标题、首个 import 或创建对象的位置都不能代替判断。
4. 若只有 workspace／全体分发物才有这项性质，才归 testing/repository。

**跨包不等于全局。** Runner 组织 Scene、资源和 CP 的恢复流程，仍是 Runtime 的测试。不能因为下层包测试方便就引入 Runtime；同样不能把跨包失效都推到 Runtime，使下层对象没有自身的反例。

| 包               | 应在包旁维护的保证                                                         | 需要另外拆出的部分                                            |
| ---------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------- |
| contracts        | 稳定值、共同错误身份和基础契约类型                                         | 真正的调用固定时序归 invocation/runtime                       |
| protocol         | 跨端值、编码／接纳校验及伪造反例                                           | 记录生成归 records，HTTP 消费归 client-http                   |
| resources        | Offer/Request、供给、端点、Activity、关闭和操作接收                        | Runner 如何按声明接线归 runtime                               |
| structure        | Callable/Scene/Group/Node、成员位置、构造与作者类型、Sequence/Dynamic 声明 | 预设在真实 Runner 中的执行组合归 runtime                      |
| checkpoint       | Frame、块／关系／选择认证、Store 端口、MemoryStore、存储值与回执           | 调用何时捕获和提交归 invocation；结构化恢复归 runtime         |
| invocation       | Context/Relation、Control、正文与接纳排空、窗口、交付、调用侧 CP           | 需要结构绑定和 Runner 的部分归 runtime                        |
| runtime          | build、资源范围、Work、Runner、出口及结构／调用／CP／记录组合              | 不替每个依赖重写一套单包测试                                  |
| interaction      | 请求固定、独立发送、局部等待、反馈、过程流                                 | 接入 Runner 的消费方式归 runtime；供应商协议归 model-provider |
| transcript       | 消息实体、固定写入、版本、持久调用顺序、资源与 ViewSource 适配             | 多实体策略归 observer-content                                 |
| memory           | 记忆实体、批次、来源契约、持久边界、资源与 ViewSource 适配                 | 记忆提取质量归 Lab 策略实验                                   |
| view             | 成员、版本、来源验证、局部操作、资源契约                                   | 真实消息／记忆来源适配分别归其实体包                          |
| measurement      | 计数与测量实体及资源契约                                                   | 长对话统计与负载表现归 Lab                                    |
| records          | 记录实体、树、接纳与持久边界                                               | Invocation 到记录的真实接线归 runtime                         |
| changes          | 变化捕获、转交、隔离与重入                                                 | 各实体何时发布变化归实体包                                    |
| diagnostics      | PersistenceError、诊断有界性及分类                                         | 真实故障如何归属调用归 invocation/runtime                     |
| model-provider   | 请求／回复协议、工具、SSE、预算、取消及错误处理                            | 真实模型质量、策略和供应商实测归 Lab                          |
| model-exchanges  | 交换、反馈槽位、凭据、版本、资源与来源适配                                 | ToolLoop 的决策与宿主流程归 Lab；以后提包再归包               |
| client-runtime   | 消费生命周期、接纳、重连、队列与投影状态契约                               | 具体页面及服务端装配归 Lab                                    |
| client-http      | HTTP/SSE 编解码、连接替换、传输错误与接纳                                  | 完整参考服务器与浏览器流程归 Lab                              |
| observer-content | ActiveView、消息／记忆组合和默认内容策略                                   | 具体对话维护装配与真实模型实验归 Lab                          |

这张表定义责任边界，具体文件按断言拆分；当前去向见实施记录中的一次性迁移清单。

### 4.1 已发现的混合用例

- `test/checkpoint-incremental-invocation.test.mjs` 的真实 Runner 用例归 runtime；直接构造 Invocation 的用例归 invocation；纯镜像认证归 checkpoint。不能整文件按 checkpoint 前缀移动。
- `test/presets.test.mjs` 的成员形状与构造约束归 structure；在 Runner 中检查接纳、输出、取消的用例归 runtime。
- `test/content-persistence.test.mjs` 按 Transcript 与 Memories 拆入对应实体包；其共用的简单抛错函数不需要升级成公共实体持久化测试平台。
- `test/progress.test.mjs` 的 ProgressChannel 行为归 changes，Transcript 发布顺序归 transcript，调用事件与装配投影分别归 invocation/runtime。
- `test/view/fixtures.mjs` 引用了 transcript/memory，而实体包本身依赖 view。View 测试应使用满足 ViewSource 契约的最小来源假体；真实适配用例放实体包，组合策略放 observer-content，避免测试依赖形成反向环。
- `test/fixtures/resources.mjs` 通过 Runtime 构造供给，其相关用例不能直接归成底层 resources 测试。拆开底层操作与装配，不保留隐式上层依赖。

对从 Lab 提炼的框架回归也使用同一规则。无需搬回 Lab 的整个测试文件、SQLite 实现、数据库计量 helper 或应用 fixture。

## 5. 公共测试基础的范围

`testing/support` 只提供测试技术，不组织框架业务：

| 可以集中                             | 留在包内                                 |
| ------------------------------------ | ---------------------------------------- |
| 可控 Promise gate、完成顺序收集      | 具体 Invocation/Relation 的构造和断言    |
| 临时目录与清理、子进程启动／退出核验 | CP 镜像、固定事实、恢复切点与存储输入    |
| TypeScript 编译与指定诊断核对        | 具体作者类型、正例／负例和虚拟消费者正文 |
| 最小本地 HTTP 服务、字节流分段工具   | 供应商回复样本、协议值与模型错误样本     |
| 通用方法计数或失败注入工具           | 某个包的提交阶段、资源或实体语义         |

公共工具不导入 CAPiX 包，不创建 Runner，不持有跨测试业务状态，不模拟完整调用状态机。它可以使用 Node 标准库和根目录明确管理的测试工具，如 TypeScript。只有确有多个消费者且语义相同的工具才提升；几行通用代码并不自动值得共用。

包内 fixture 不能成为其他包测试的私有出口。不允许 `../other-package/test/fixtures` 导入，也不把业务 fixture 暴露为生产 exports。共享纯数据样本时先确认共同契约归属，不能把同形对象当成同义业务事实。

## 6. 测试依赖与构建边界

包测试可以使用本包及职责所需的下层公开包，但不能通过测试或公共工具反向加载上层装配，形成依赖环。组合行为放实际协调者，而不是增加一个测试专用生产包。

测试直接使用的框架依赖须在该包 dependencies/devDependencies 中明确，并遵守方向；根 devDependencies 能解析到某个包，不代表本包已经声明了依赖。全局 Node/TypeScript 测试工具可以集中维护，不要求每个包重复固定工具版本。

迁移时清理根目录不再需要的 workspace devDependencies，只保留仓库检查和示例实际使用的项；同时核对包测试的直接导入，不能仅以 Node 能解析或单包测试通过推断依赖已声明。若真实消费关系需要测试专用 devDependency，可以明确登记无环依赖；不能机械要求只使用 production dependencies，也不能借 devDependency 倒置模块边界。

默认按包名导入本包公开出口和其他包公开出口，继续测试真实编译产物。测试内部实现时只在本包内定向导入，不为测试增加公开 API；跨包私有 src/dist 导入仍拒绝。

文件定位以 `import.meta.url` 为依据，确实需要的 cwd 显式传入。迁移时同时修正类型虚拟文件位置、子进程入口、临时安装路径及相对 examples 路径，不能把“必须从旧根 test 目录启动”保留为隐含条件。

`test/` 和 `benchmarks/` 不进入生产 tsconfig 的 src 构建，不进入 exports 或 npm files。类型负例由所属包测试显式编译，不能因为主包 typecheck 未包含 test 就被漏掉。迁移时补充对误编入 dist 的测试、fixtures、benchmarks 路径的拒绝检查，保留现有 tarball 白名单和公开出口核验。

包内源码类型验证与已发布声明验证分别保留：TypeScript 可能在本包项目上下文中将自引用映射到 src，不能把这种通过当作 dist 声明已被消费。现有移除 `@ts-expect-error` 后核对诊断位置的负例保留，不降成一次普通 tsc 成功。contracts/protocol/client 包的生产 lib/types 限制不因测试需要 Node 而放宽。

## 7. 命令与执行设计

以下命令已实现。保留 pnpm Workspace、现有锁文件与 node:test，不新增测试服务。

| 入口                                                                  | 工作                                                        |
| --------------------------------------------------------------------- | ----------------------------------------------------------- |
| `pnpm --filter @weiliang0121/capix-resources --fail-if-no-match test` | 构建该包及所需依赖，再执行这个包的运行、类型及必要进程回归  |
| `pnpm test:packages`                                                  | 已完成构建后，发现并执行全部包测试，不重复构建各包          |
| `pnpm test:repository`                                                | 已完成构建后，执行 workspace、依赖边界与仓库脚本检查        |
| `pnpm test`                                                           | 构建一次，再执行 packages 与 repository 两部分              |
| `pnpm check`                                                          | 构建一次，完成源码类型、两类正式测试和格式检查              |
| `pnpm integration:check`                                              | 验证全部 21 个候选 tarball 的隔离安装、出口及运行／类型消费 |
| `pnpm release:check`                                                  | 维持最终发布 tarball 的独立消费者验收                       |

一个小的 `scripts/test` 执行器负责发现与构建协调，不承载测试语义。单包模式构建选中包及明确依赖；全仓模式先按依赖顺序构建一次，然后汇总准确测试文件交给 node:test。不要通过递归执行每个包的自带构建入口，造成一次全仓验证重复构建多个依赖闭包。

单包构建可使用 `pnpm --filter '<准确包名>...' --fail-if-no-match build`，包括自身与依赖。执行器向 `process.execPath --test` 传递发现出的文件参数数组并传播非零状态，不拼接 shell 命令或依赖 shell 展开。`test:packages` / `test:repository` 是明确的已构建入口，缺产物应报错；通常作者使用会先构建的单包 test、根 test 或 check。

根 check 的目标串联为 `pnpm build && pnpm typecheck && pnpm test:packages && pnpm test:repository && pnpm format:check`；它不再调用会重新 build 的 test。单包执行器读取当前包 manifest 的准确名称，不靠目录名猜测公开包名或 scope。

发现规则覆盖 `packages/*/test/**/*.test.mjs` 和单独的 `testing/repository/**/*.test.mjs`；不自动把 worker、纯 .ts 类型样本、benchmarks、dist 和历史文件当测试；types 目录中的 .test.mjs 编译入口会正常发现。按现有 CI 资源限制执行并发，不为搬目录同时更改并发策略。

必须能发现漏测：现有包需要明确测试入口；包的测试模式零匹配应失败，不以 `--if-present` 或静默跳过处理。类型包也有类型契约测试。运行器支持的模式及发现规则本身归仓库检查。旧 `test:unit` 在迁移完成后统一调整调用方并移除，不长期保留两套独立发现范围。

CAPiX CI 只检出本仓即可执行上述正式检查；不得读取 Lab 路径、候选 manifest、测试源码或完成状态。公开贡献者与维护者使用相同的框架通过条件，不存在“普通贡献者无法执行的隐藏 Lab 门槛”。

### 7.1 分发验证也在本仓闭合

当前新增 Tool 后，release:check 验证 18 个经过发布处理的公开包；integration:pack 构建的 21 包候选没有相同的压缩处理，不能把两种产物当成同一份证据。`integration:check` 已在 CAPiX 内为 21 包候选补独立临时消费者的安装与关键出口 smoke，覆盖三个未发布包的分发；无需启动 Lab。

打包检查除了文件白名单，还应拒绝 `dist/test`、fixture 等误编译产物。build、release:check、integration:pack 都可能重建同一批 dist，需顺序执行，不能和正在读取产物的测试并发。测试版本、源码来源与实际 tarball 摘要分别记录；候选源码摘要不自动代表已包含所有测试工具和验收依据。

## 8. 恢复与性能证据仍由框架维护

包内测试应继续覆盖：正常结果、拒绝反例、时序与清理、冷恢复、准确来源，以及适用的资源／持久故障。跨进程并不自动意味着 Lab：例如 Invocation 恢复时丢弃进程内认证、重新校验材料，就属于调用包或 Runtime 的责任。

CP Store 端口的 revision、owner/input/contract 固定、关系和选择认证、终态及回执由 checkpoint 自证；真实提交后丢回执如何影响调用热依据由 invocation/runtime 自证。MemoryStore 或端口包装只证明这些边界，不扩大为 SQLite 持久原子性、跨资源统一事务或任意外部效果的安全重做。

把核心性能分为两层：

- 确定性回归放所属包 test：旧事实重复编码次数、新增关系/选择的处理范围、查询实际读取量。规模适当，进入普通 CI。
- 时间与空间基准放所属包 benchmarks：固定变量、独立进程、记录环境与基线，显式执行。完整宿主／真实模型成本和多用户负载仍归 Lab。

不能只留一份历史性能报告，也不能把机器相关的毫秒差异直接当语义失败。现有 Lab 混合 Memory/SQLite 基准保留其完整实验价值；框架需要的确定性断言在 CAPiX 自行表达，不导入其 benchmark fixture。

## 9. 清理与迁移步骤

### 第一步：建立一次性迁移清单

对现有 182 个正式文件及其类型、JSON、worker、helper 依赖记录旧位置、断言责任、目标位置与处理方式：移动、拆分、替换 fixture、合并重复或保留仓库检查。另记录从 Lab 提炼的框架反例。它用于本次迁移审查，不发展成长期手工维护的测试注册平台。

清理不是按文件名删测试。完全重复的用例可合并，但须指明留下哪个反例；历史 API 的包装需改用当前对象表达，再确认行为一致。没有引用的样本也需检查动态路径和实验引用，不能只凭一次文本搜索删除。

### 第二步：用小包验证目录与命令

先迁 contracts/resources 中可直接独立的测试及类型探针，建立最小 support 和执行器。验证干净构建下单包测试、全仓发现、错误退出及不进入发布包。过渡阶段由明确的新旧归属清单核对覆盖，不默认跳过尚未迁移的包；20 包各自入口非空的最终规则在全部迁移后启用。同一个执行器明确收集新旧目录，禁止同一用例在两套入口重复运行；迁移完成立即去掉旧范围。

### 第三步：按对象完成迁移

分别处理 checkpoint/invocation/runtime 的混合测试、各实体、结构预设、交互和客户端。每批先保存原用例的运行证据，再迁移并核对反例与类型诊断，不一次性改名所有文件后只看总计数。

旧 `test/fixtures/runtime.mjs` 等使用旧层级词汇的包装随使用者收敛。公共 support 不接收整套旧包装；确有协调职责的 fixture 放 runtime/test/fixtures，底层用例直接构造其拥有的对象。

### 第四步：独立验收并删除旧入口

- 仅 CAPiX 检出即可 frozen install、干净构建、全部测试、类型和分发验收；没有相邻 Lab 也成立。
- 20 个包都有明确测试责任与可用入口；根部只剩公共工具与有限仓库检查。
- 包测试不导入其他包测试、不借全局 fixture 反向依赖上层、不访问 Lab 或私有配置。
- 类型负例、子进程、故障反例及复杂度断言均有去向；不以减少测试数或增加 skip 换取通过。
- 全仓发现与各包入口范围一致，不漏文件、不重复执行；测试顺序不提供隐式共享状态。
- 最终 tarball、出口与仓库外消费者继续通过；测试移动不扩大发布清单。

总测试数量可以因拆分或有依据的合并而变化。验收依据是原有保证和反例有对应结果，不是文件数必须相等。

## 10. 参与者如何工作

新增或修改包行为时，在该包维护正例与关键反例；遇到组合问题，先确定真实协调者，再放测试。修改公共 support 须验证其实际消费者，不能在 support 内增加框架特例以修补某个测试。

Lab 的实验可以独立运行、失败或暂不适配新版本；这些状态不自动决定 CAPiX 是否合格。已经确认的框架缺陷进入 CAPiX 独立复现和修复流程；业务任务不自行回写 CAPiX。两仓需要同时变更时，分别说明实现责任和验证范围，不建立相互等待的测试任务链。

上述边界已落实为包内测试、依赖与发现规则检查，以及两种独立分发验证；迁移过程中修正的路径、夹具和新增回归见[实施记录](testing-migration.md)。
