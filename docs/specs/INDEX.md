# LinchKit 规范索引

> 63 篇规范按领域分组。格式：`[编号] 标题 — 一句话摘要（里程碑，状态）`。
>
> **状态说明**：`完成` = 已实现并测试，`部分` = 核心完成/细节待补，`设计` = 仅有规范未实现，`已废弃` = 被更新版本取代。
>
> **使用方式**：先读本索引定位相关规范，不要一次性读所有 spec——按领域按需读取。

---

## 愿景与基础

| # | 标题 | 摘要 | 里程碑 | 状态 |
|---|------|------|--------|------|
| [00](./00_tech_stack.md) | 技术栈 | Bun、Elysia、Drizzle、React 19、graphql-yoga、Restate — 全栈技术选型 | M0 | 完成 |
| [00a](./00a_product_vision.md) | 产品愿景 | "用户说，要有光" — 系统从使用中生长，五层生命系统 | — | 设计 |

## 元模型 — 骨架

LinchKit 的 9 个一等公民构建块。

| # | 标题 | 摘要 | 里程碑 | 状态 |
|---|------|------|--------|------|
| [03](./03_schema.md) | Schema | `defineSchema()` — 字段定义、系统字段、展示配置、用途 | M0 | 完成 |
| [04](./04_action.md) | Action | `defineAction()` — CRUD + 自定义操作、handler、限流、幂等 | M0 | 完成 |
| [05](./05_rule.md) | Rule | `defineRule()` — 校验/门控/副作用/审批，条件表达式，优先级 | M0 | 完成 |
| [06](./06_state.md) | State | `defineState()` — 状态机、转移、守卫 | M0 | 完成 |
| [07](./07_event.md) | Event | `defineEvent()` — 领域事件、命名规范、Payload 定义 | M0 | 完成 |
| [08](./08_event_handler_and_queue.md) | EventHandler 与队列 | `defineEventHandler()` — 同步/异步、重试、死信、顺序保证 | M0 | 完成 |
| [46](./46_link_type.md) | Link 类型 | `defineLink()` — 关系作为一等公民，FK/中间表，双向导航 | M2 | 完成 |
| [47](./47_schema_interface.md) | Schema 接口 | `defineSchemaInterface()` — 可复用字段契约，合规校验 | M2 | 完成 |
| [48](./48_derived_properties.md) | 派生属性 | `derived` 配置的计算字段，查询时求值 | M2 | 完成 |
| [49](./49_schema_inheritance.md) | Schema 继承 | 单父继承 `extends`，字段/Action/Rule/State 继承链 | M2 | 完成 |

## 元模型 — 生命系统

五层进化模型（Sense → Memory → Awareness → Insight → Proposal）。

| # | 标题 | 摘要 | 里程碑 | 状态 |
|---|------|------|--------|------|
| [55](./55_evolution_system.md) | 进化系统 | 活的软件：传感器、基线、重要性图谱、证据链洞察、渐进式 Proposal | M3–M6+ | 设计 |

## 运行时引擎

元模型在运行时如何执行。

| # | 标题 | 摘要 | 里程碑 | 状态 |
|---|------|------|--------|------|
| [02](./02_runtime_change.md) | 运行时变更 | 三层 Source of Truth（设计时/部署时/运行时），租户覆写 | M0 | 完成 |
| [09](./09_proposal_validation_version.md) | Proposal 与校验 | Proposal 治理流水线（draft→validated→approved→committed→deployed），4 阶段校验 | M0 | 完成 |
| [16](./16_command_layer_and_api.md) | CommandLayer 与 API | 7 槽中间件管线，REST `/api/*`，GraphQL `/graphql`，错误映射 | M0 | 完成 |
| [23](./23_rule_engine_and_flow.md) | 规则引擎与 Flow | 规则求值顺序，Flow 引擎（Restate），步骤类型，Saga 补偿 | M1 | 完成 |
| [26](./26_transaction_model.md) | 事务模型 | Action 级事务，Flow 级 Saga 模式，补偿机制 | M1 | 部分 |
| [32](./32_state_machine_implementation.md) | 状态机实现 | 转移校验、守卫求值、自动转移、历史记录 | M0 | 完成 |
| [39](./39_execution_contract.md) | 执行契约 | 输入/输出契约，执行生命周期，幂等，父子执行 | M0 | 完成 |
| [40](./40_rule_execute_action_boundary.md) | Rule-Action 边界 | 规则何时触发 Action vs 何时仅做被动检查 | M1 | 完成 |
| [45](./45_reactive_automation.md) | 响应式自动化 | AutomationEngine + TriggerBinding — event/fieldChange/stateChange/schedule/flowCompleted 触发 | M2 | 完成 |

## Capability 体系

Capability 的定义、扩展、组合与分发。

| # | 标题 | 摘要 | 里程碑 | 状态 |
|---|------|------|--------|------|
| [01](./01_capability_structure.md) | Capability 结构 | `defineCapability()` — standard/adapter/bridge 类型，生命周期，依赖 | M0 | 完成 |
| [14](./14_system_capabilities.md) | 系统 Capability | 内置 Capability（auth、permission、MCP、UI），冷启动包（职能包 + 行业包） | M0 | 部分 |
| [20](./20_extension_mechanism.md) | 扩展机制 | `extensions` — schemas/actions/rules/views/middlewares/transports/fieldTypes/services/hooks | M0 | 完成 |
| [21](./21_capability_ecosystem.md) | Capability 生态 | Capability 生命周期，发布，版本管理，兼容性矩阵 | M1 | 部分 |
| [21b](./21_capability_hub.md) | Capability Hub | 发现、注册、安装、依赖解析 | M2+ | 设计 |

## 配置

| # | 标题 | 摘要 | 里程碑 | 状态 |
|---|------|------|--------|------|
| [42](./42_config_center.md) | 配置中心 | 静态配置（linchkit.config.ts + Zod）已完成；动态 KV（DB + 作用域级联）待实现 | M0a/M1 | 部分 |

## 数据、存储与多租户

| # | 标题 | 摘要 | 里程碑 | 状态 |
|---|------|------|--------|------|
| [11](./11_execution_log.md) | 执行日志 | ExecutionLogger 接口，内存 + Drizzle 后端，审计链 | M0 | 完成 |
| [30](./30_multi_tenancy.md) | 多租户 | tenant_id 隔离，行级安全，租户配置覆写 | M0 | 完成 |
| [34](./34_cache_strategy.md) | 缓存策略 | 内存缓存，失效策略，TTL，租户隔离 | M1 | 设计 |
| [41a](./41_data_security_and_masking.md) | 数据安全与脱敏 | 字段级脱敏规则，MaskedValue 组件，基于权限的显示 | M1 | 完成 |
| [51](./51_data_i18n.md) | 数据多语言 | JSONB 翻译存储，共享 i18n 包，messageKey API（取代 spec 41 i18n） | M1 | 部分 |

> **注意**：`41_data_i18n.md` 已被 `51_data_i18n.md` 取代，仅保留作为历史参考。

## AI

| # | 标题 | 摘要 | 里程碑 | 状态 |
|---|------|------|--------|------|
| [15](./15_ai_developer_experience.md) | AI 开发者体验 | Builder/Evolver Agent，MCP 工具，AI 辅助 Capability 开发 | M1 | 部分 |
| [22](./22_ai_rule_boundary.md) | AI-Rule 边界 | AI 能/不能修改什么，护栏，人在回路要求 | M1 | 设计 |
| [27](./27_ai_security.md) | AI 安全 | Prompt 注入防御，输出校验，审计链，限流 | M1 | 设计 |
| [36](./36_ai_service.md) | AI 服务层 | `ctx.ai.complete()` — 多 Provider、模型别名、成本控制、BYOK、Vercel AI SDK | M1 | 完成 |
| [52](./52_ai_deep_integration.md) | AI 深度集成 | AI 作为主要交互界面 — 自然语言 → defineXxx()，意图解析，对话式 Flow | M2+ | 设计 |
| [58](./58_mcp_client_registry.md) | MCP Client Registry | AI Agent 接入管理 — Client 注册、per-client 授权、工具可见性策略、管理 UI | M2 | 设计 |

## 前端与视图

| # | 标题 | 摘要 | 里程碑 | 状态 |
|---|------|------|--------|------|
| [13](./13_view_and_ui.md) | 视图与 UI | `defineView()` — AutoList、AutoForm、Widget 注册表、SearchBar、状态配色 | M0 | 完成 |
| [44](./44_realtime_subscription.md) | 实时订阅 | GraphQL SSE 订阅，PersistentEventBus 集成，按 Schema 的变更流 | M2 | 完成 |
| [53](./53_chatter_and_collaboration.md) | 统一记录时间线 | Chatter — 字段审计 + 执行日志 + 评论 + AI 对话的统一时间线（Capability） | M3 | 设计 |
| [54](./54_advanced_ui_features.md) | 高级 UI 特性 | 看板、日历、时间线视图，拖拽，仪表盘构建器 | M2+ | 设计 |

## 认证与权限

| # | 标题 | 摘要 | 里程碑 | 状态 |
|---|------|------|--------|------|
| [10](./10_actor_permission.md) | Actor 与权限 | Actor 模型，RBAC，权限组，字段级控制，CommandLayer 集成 | M0 | 完成 |
| [10a](./10a_authentication.md) | 认证 | Better Auth Provider，JWT，会话，OAuth，多租户认证 | M0 | 完成 |
| [35](./35_approval_mechanism.md) | 审批机制 | 审批引擎，多级审批，超时策略，权限集成 | M1 | 完成 |

## 可观测性与质量

| # | 标题 | 摘要 | 里程碑 | 状态 |
|---|------|------|--------|------|
| [28](./28_observability.md) | 可观测性 | 结构化日志，指标，链路追踪，健康检查 | M1 | 部分 |
| [33](./33_error_handling.md) | 错误处理 | 7 种错误类型 → HTTP 状态码，LinchKitError 层级，错误编码 | M0 | 完成 |
| [18](./18_testing.md) | 测试 | bun test，测试工具集，Fixture 辅助，Capability 测试模式 | M0 | 完成 |
| [31](./31_code_quality.md) | 代码质量 | Biome，TypeScript strict，提交规范，pre-commit hooks | M0 | 完成 |

## 治理与流程

| # | 标题 | 摘要 | 里程碑 | 状态 |
|---|------|------|--------|------|
| [25](./25_documentation.md) | 文档 | 自动生成 API 文档、Schema 文档、Capability 文档 | M1 | 设计 |
| [29](./29_methodology_and_sop.md) | 方法论与 SOP | 开发方法论，Capability 开发 SOP，发布流程 | M0 | 完成 |
| [37](./37_documentation_governance.md) | 文档治理 | 文档标准、评审流程、版本化生命周期 | M1 | 设计 |
| [38](./38_release_compatibility.md) | 发布兼容性 | 语义版本规则，迁移指南，破坏性变更策略 | M1 | 设计 |
| [56](./56_core_slimming.md) | 核心瘦身 | 三方审查共识：~17 文件安全移出，生命系统引擎留核心，接口+实现分离模式 | M3 | 设计 |

## 部署与迁移

| # | 标题 | 摘要 | 里程碑 | 状态 |
|---|------|------|--------|------|
| [12](./12_deployment.md) | 部署 | 部署策略，环境配置，生产就绪检查 | M1 | 设计 |
| [17](./17_legacy_system_migration.md) | 遗留系统迁移 | 数据导入，渐进式迁移，共存策略 | M2+ | 设计 |

## 语义层

| # | 标题 | 摘要 | 里程碑 | 状态 |
|---|------|------|--------|------|
| [24](./24_relation_graph.md) | 关系图谱 | 实体关系可视化，图遍历，影响分析 | M2 | 部分 |
| [43](./43_ontology_layer.md) | 本体层 | OntologyRegistry — 统一只读门面，describe()、searchSchemas()、toJSON() | M2 | 完成 |

## 初始化

| # | 标题 | 摘要 | 里程碑 | 状态 |
|---|------|------|--------|------|
| [19](./19_initialization.md) | 初始化 | `linch init` 模式（bare/minimal/pack），启动流程，管理员创建 | M0 | 完成 |

## 里程碑

| # | 标题 | 摘要 | 里程碑 | 状态 |
|---|------|------|--------|------|
| [50](./50_milestone_m1_plan.md) | M1 计划 | M1 范围、交付物、任务拆解 | M1 | 完成 |

---

## 文件命名说明

- `21_capability_hub.md` 在本索引中标记为 **21b**（Hub 是生态的子主题）
- `41_data_i18n.md` **已废弃**，被 `51_data_i18n.md` 取代 — 不要基于 41 实现
- `41_data_security_and_masking.md` 在本索引中标记为 **41a**（与 41 i18n 区分）

## 快速查找：按任务定位规范

| 你要做的事 | 应该读的规范 |
|-----------|-------------|
| 开发新 Capability | 01, 20, 42, 39, 04 |
| Schema/字段变更 | 03, 46, 47, 48, 49 |
| 规则与自动化 | 05, 23, 40, 45 |
| API/GraphQL 变更 | 16, 44 |
| UI 组件开发 | 13, 54 |
| AI 功能 | 36, 15, 22, 27, 52 |
| 认证/权限 | 10, 10a, 35 |
| 多租户 | 30, 42 |
| 进化系统 | 00a, 55 |
| 核心瘦身/模块拆分 | 56, 01, 20 |
| Chatter/记录时间线/字段审计 | 53, 11 |
| 数据安全 | 41a, 30 |
| 测试 | 18, 31 |
| 部署 | 12, 19 |

## 统计

| 状态 | 数量 |
|------|------|
| 完成 | 33 |
| 部分 | 9 |
| 设计 | 18 |
| 已废弃 | 1 |
| **总计** | **61**（去重后，含 00a、55、56） |
