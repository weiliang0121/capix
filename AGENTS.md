# CAPiX 协作约定

CAPiX 是可组合、可观测的 Agent 框架。仓库维护框架包、可复用集成与预设、公开文档、可运行示例和独立测试。当前能力以实现、[公开契约](docs/README.md)及回归为准；历史候选不自动成为 API。

## 工作边界

- 本仓必须能独立说明、构建和验证自身；不依赖外部项目源码、凭证、配置、夹具或私有讨论。外部发现的框架问题应提炼为本仓可执行的回归。
- 外部任务的授权不自动包含修改本仓；发现框架缺口后，应在 CAPiX 任务中明确范围并取得授权再推进。
- 修改前检查并保留未提交工作。按明确的小闭环完成实现、审查、相称验证与修复；不因目录整理引入平台、权限、调度或新的恢复承诺。
- 关键对象、职责和调用关系的变化需说明问题、选择和不变量。独立生命周期才是新增实体的依据；helper 只组合清晰操作。
- 普通测试离线，不调用真实模型。未经用户明确授权，不推送、部署、发布或更改仓库可见性；不要读取其他项目的凭证或从历史取得隐式运行环境。
- 当前开发阶段只接收当前格式。旧库、旧 CP 和旧业务契约明确拒绝；拒绝不得修改原数据，不自动升级、清空、降级读取或补造依据。当前格式重启载入与显式恢复仍是正式能力。

## 包与公开边界

源码统一位于 `packages/`，18 个公开包使用 `@weiliang0121/capix-` 前缀；根 workspace 与锁文件唯一。跨包只走公开出口，不导入其他包的私有 src/dist，也不建立平行兼容门面。准确依赖由 package.json 与仓库检查维护，见[架构](docs/organization.md)。

| 所有者                                   | 职责                                                                    |
| ---------------------------------------- | ----------------------------------------------------------------------- |
| contracts / protocol                     | 共同进程内契约与唯一 RuntimeError；Transcript wire 的编码形状和单帧接纳 |
| resources / changes                      | 资源登记、固定绑定、受控操作；类型化领域事实捕获与转交                  |
| structure                                | Callable、Scene/Group/Node、成员与作者声明、Sequence/Dynamic            |
| invocation / checkpoint                  | 单次调用、关系与活动窗口；固定事实、Frame v6、有限恢复与 Store          |
| runtime                                  | 结构和机制装配、Runner、Work 适配，不建立第二棵 Bound 树                |
| interaction                              | 独立发送、持久反馈、局部等待与可选有界过程流                            |
| transcript / memory / view / measurement | 各自实体、视图成员及读取、使用计数；不依赖 Runtime                      |
| records / diagnostics                    | 记录实体与显式解释；唯一 PersistenceError 和诊断值                      |
| model-provider / model-exchanges / tool  | 原生模型协议、固定起点和交换实体、普通 Group 工具预设                   |

领域数据由其包解释；共同类型只按实际协作需要晋级 contracts。进入 protocol 必须明确编码、接纳与版本，不因“客户端可能需要”就收录领域实现或业务 DTO。

## 共同不变量

- 结构在树内唯一；复用逻辑、声明或资源，不共享结构实例。build 固定配置、成员与接线，不执行按次 capture、不创建 Invocation。结构不持有单次输入或运行状态。
- 资源本层 deps 与子树 supply 分开；收窄不扩大授权。本次窗口不可重开，端点依据准确调用、阶段和固定信号核验，不递归解算祖先可变状态。业务不取得 origin、Context 或 Invocation。
- 普通资源与子调用共用 delta/result 接收结构。returned 与 accepted/handled 分开，接收失败不再次进入同一 failed。普通错误可按明确分支接收；取消、装配、捕获、CP、严格观测和持久故障受保护。
- Invocation 等待已启动子调用真实退出并排空接纳，再关闭和最终交付。取消只请求停止，不靠 Promise.race 提前释放；收尾不恢复资源权限。不等待独立 Interaction 或未启动关系，不自动停止兄弟。
- 正式输入在 capture/refine 前固定；返回候选在取得后、关闭和最终成功前固定；接纳值在回调返回后、安装前固定。CP 开关不改变含义，原对象变更不能改写历史。真实 Error 保持原引用，仅固定诊断；不冻结能力对象或闭包。
- stableValue 支持的被动数据域和预算见[运行边界](docs/runtime-boundaries.md)。固定值不保证对象身份、历史可查、持久成功或可重做效果；冷恢复重新认证。
- reception 是固定接纳值的编码契约。check 仅依赖固定值及绑定参数，同步执行且不替换原值；thenable 拒绝。首次持久发布验证 codec 往返，冷恢复重新解码检查。
- Context/Relation 持有事实，CP 消费相同依据。仅恢复显式 point 和完整材料，不恢复 JavaScript 栈、草稿或任意外部效果；失败终态不复活。Frame v6 的逻辑范围、增量物理提交及准确回执规则见[Checkpoint](docs/checkpoints.md)。
- state 每次完整编码；point.check 在同步查询窗口内执行，按实际读取计费。refs 是作者选择的恢复角色，many 出现项有序且可重复；不由接纳关系自动派生，不靠值相等省略新事实。参见[选择](docs/checkpoint-selection.md)。
- 自定义实体按能力组合，不要求基类、统一内容状态或强制来源。实体持有内容及版本规则，资源开放操作，View 组织使用范围。Memory 是总结实体；退出视图不删除实体或强制替代材料。
- 实体的固定写入确认、持久错误与变化发布分别维护真实结果。提交不确定不等于未提交，发布失败不撤销已安装内容。内核不替资源承诺幂等、跨实体事务或安全重做。
- 领域事实用准确 FactType 和稳定正文；operation.facts 只在本操作内有效。来源证明关联而不自动证明因果，不能以全局当前调用猜归属。记录可选，恢复不依赖 Recorder，不能用展示 DTO 补恢复依据。
- Interaction 固定请求只发送一次，与调用独立存活；signal 只终止局部等待。未知反馈不自动重发，流结束不代表反馈保存或父层接纳完成。详见[交互](docs/interactions.md)。
- Tool 是普通 Group 预设，工具来自登记成员，模型只提出选择。固定起点与目录不授予执行权限；映射须纯且无副作用；协议、实体、推进和恢复资格分别核验。详见[Tool](packages/tool/README.md)。

## 编码与验证

- 使用 Node22.23.2、pnpm10.7.1、TypeScript6.0.3；外部依赖精确版本，内部 workspace:*。Prettier printWidth1000，每条变量声明一个变量。循环直接表达退出条件，流提前结束或异常也释放资源。
- 优先使用 es-toolkit@1.52.0 的通用操作；对象身份、严格值域、getter 隔离、循环和预算遵循专用语义，不用通用克隆替代正式接纳。类自行生成自身身份，不造空壳 Builder 或同义旧 API。
- 测试跟随契约所有者，跨包组合归实际协调者。公共工具在 testing/support，不隐式装配上层框架；仓库组织与分发检查在 testing/repository。不能导入别包测试夹具，不能以空范围、缺产物或未声明依赖静默通过。
- 修改包后先跑对应测试；最终使用 `pnpm check` 完成构建、类型、包内与仓库检查、可执行示例、文档站与格式验证。分发变更另按顺序运行 `pnpm release:check`、`pnpm integration:check`，不能并发重建同一 dist。
- 文档示例从 examples 的真实源码引入，不复制成另一套实现。公开文档不依赖私有背景；Node 示例与浏览器现场运行分别说明。生成的站点和运行产物不纳入 Git。
- 性能计时独立执行，不与构建或测试并发，不把采样开销混入结果。完成后报告实际变更、验证与限制，不能把候选或历史数据写成已实现保证。

详细工作方式见 [贡献说明](CONTRIBUTING.md)、[测试](docs/testing-organization-design.md)与[发布](docs/npm-publishing.md)。
