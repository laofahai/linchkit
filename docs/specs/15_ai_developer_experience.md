# AI 开发者体验设计规范

## 1. 定位

LinchKit 不只是"AI 能用"，而是"AI 天然知道怎么在上面开发"。

通过自动生成的项目上下文、专业化 Agent、开发技能包、MCP 工具，让任何 AI 编码工具（Claude Code、Cursor 等）打开 LinchKit 项目就能高效开发。

## 2. 自动生成的项目上下文

### 2.1 CLAUDE.md（自动生成）

框架根据当前系统状态自动生成并维护，每次 Capability 变更后自动更新。

内容包括：
- 项目类型和框架约定
- 已安装的 Capability 清单及版本
- Schema 概览（字段、关系）
- Action 清单
- Rule 清单
- 可用的 MCP 工具说明
- 开发流程说明
- 命名约定和最佳实践

```markdown
# CLAUDE.md (自动生成)

## 项目类型
这是一个 LinchKit 项目。

## 框架约定
- 使用 defineSchema / defineAction / defineRule / defineState / defineView 定义能力
- Action 是唯一写入口，命名用 verb_noun 格式
- Rule 声明式条件用 { field, operator, value } 格式
- 所有变更通过 Proposal → PR → 部署

## 当前 Capability
- purchase_management (v1.2.0)
  - schemas: purchase_request, purchase_item
  - actions: create_request, submit_request, approve_request, ...
  - rules: amount_check, department_budget_check, ...

## 可用 MCP 工具
- list_capabilities, get_schema, get_actions, execute_action, create_proposal, ...
```

### 2.2 AGENTS.md（可自定义）

> 注：AGENTS.md 同时作为标准化文件使用，见 §2.3。

定义专业化 AI Agent：

```markdown
## capability-designer
专门设计新 Capability 的 Agent。
工作流：理解需求 → 设计 Schema → 定义 Action → 设计 Rule → 定义 State → 生成 View

## rule-writer
专门编写 Rule 的 Agent。
优先用声明式 condition，复杂逻辑才用代码式。

## debugger
分析 Execution Log、Event 链路、Rule 拦截原因。

## evolver
分析运行数据，发现异常模式，建议新 Rule，优化流程。
```

### 2.3 AGENTS.md（标准化）

AGENTS.md 遵循 https://agents.md/ 开放标准（60,000+ 项目采用），让所有 AI 编码工具（Claude Code、Cursor、GitHub Copilot、OpenAI Codex、Gemini CLI 等）理解 LinchKit 项目。

由框架自动生成，与 CLAUDE.md 互补：CLAUDE.md 面向 Claude 特定指令，AGENTS.md 是通用标准。

### 2.4 协议层次架构

LinchKit 通过多层协议与 AI 生态集成。每层协议解决不同问题，互补而非竞争：

```
知识层    Agent Skills / AGENTS.md / CLAUDE.md    ← 静态上下文，AI 理解项目
          ↕
接口层    OpenAPI Spec / Function Calling          ← 接口定义标准
          ↕
工具层    MCP (Agent ↔ Tool/Resource)              ← AI 调用工具，cap-adapter-mcp
          ↕
编排层    A2A (Agent ↔ Agent)                      ← Agent 间协作，cap-adapter-a2a
          ↕
用户层    AG-UI (Agent ↔ UI)                       ← Agent 与前端交互，cap-adapter-ag-ui
```

| 层次 | 协议 | LinchKit 实现 | 优先级 |
|------|------|---------------|--------|
| 知识层 | AGENTS.md + CLAUDE.md | 框架自动生成 | P0 |
| 工具层 | MCP | cap-adapter-mcp（adapter capability） | P0 |
| 接口层 | OpenAPI Spec | Elysia 自动生成 | P1 |
| 用户层 | AG-UI | cap-adapter-ag-ui（adapter capability） | P2 |
| 编排层 | A2A | cap-a2a（adapter capability） | P3 |

所有协议适配器都是 Capability（type: adapter, category: integration），通过 `extensions.transports` 注册，Core 不需改动。详见 20_extension_mechanism.md §8.5。

## 3. MCP 工具

> MCP 在 LinchKit 中以 Capability 形式提供（`cap-adapter-mcp`，type: adapter），而非 Core 内置。安装 cap-adapter-mcp 后自动注册 MCP transport，卸载后系统不受影响。

MCP 工具直接复用统一 Command Layer（详见 16_command_layer_and_api.md），CLI / MCP / API 共享同一套 Command，MCP 只是传输适配器。

### 3.1 查询 — AI 理解系统

| Command | 作用 |
|---------|------|
| `list_capabilities` | 查看已安装的所有 Capability |
| `get_capability(name)` | 查看某个 Capability 的完整定义 |
| `get_schema(name)` | 查看 Schema 定义 |
| `get_actions(capability)` | 查看某模块的所有 Action |
| `get_rules(capability)` | 查看某模块的所有 Rule |
| `get_state_machine(name)` | 查看状态机定义 |
| `get_views(capability)` | 查看某模块的所有 View |
| `get_dependencies(capability)` | 查看依赖关系图 |
| `query(graphql)` | 用 GraphQL 查业务数据 |
| `get_execution(id)` | 查看某次执行的完整链路 |
| `get_recent_errors(capability?)` | 查看最近的错误 |

### 3.2 操作 — AI 执行动作

| Command | 作用 |
|---------|------|
| `execute_action(name, input)` | 执行 Action |
| `create_proposal(changes)` | 创建 Proposal（生成 TS 文件 + 创建 PR） |
| `validate_proposal(id)` | 验证 Proposal |
| `get_proposal(id)` | 查看 Proposal 状态 |

### 3.3 脚手架 — AI 快速生成

| Command | 作用 |
|---------|------|
| `scaffold_capability(description)` | 根据描述生成 Capability 骨架 |
| `scaffold_rule(description)` | 根据描述生成 Rule 定义 |
| `scaffold_action(description)` | 根据描述生成 Action 定义 |
| `scaffold_view(schema, type)` | 根据 Schema 生成 View 定义 |

## 4. Skills（AI 开发技能包）

类似 Claude Code 的 slash commands，提供结构化的开发流程：

| Skill | 作用 |
|-------|------|
| `/linch new-capability` | 交互式创建新 Capability |
| `/linch add-field` | 给 Schema 加字段 |
| `/linch add-rule` | 给 Action 加规则 |
| `/linch add-action` | 新增 Action |
| `/linch add-view` | 新增 View |
| `/linch diagnose` | 分析最近的错误和异常 |
| `/linch explain` | 解释某个 Capability 的完整结构 |
| `/linch impact` | 分析某个变更的影响范围 |
| `/linch status` | 系统当前状态概览 |

每个 Skill 是一段结构化的 prompt + 预设的工具调用序列：

```typescript
export const addRuleSkill = defineSkill({
  name: 'add-rule',
  description: '给已有 Action 添加业务规则',
  steps: [
    { prompt: '请描述你要添加的规则', collectInput: true },
    { tool: 'list_capabilities', purpose: '了解现有模块' },
    { tool: 'get_actions', purpose: '找到目标 Action' },
    { tool: 'get_rules', purpose: '了解现有规则，避免冲突' },
    { generate: 'rule_definition', purpose: '生成 Rule 定义' },
    { tool: 'create_proposal', purpose: '创建 Proposal' },
  ],
})
```

## 5. Prompt 管理

### 5.1 三类 Prompt

| 类型 | 谁维护 | AI 能改吗 |
|------|--------|----------|
| 自动生成 | 框架 | 不能（每次部署自动更新） |
| 人维护 | 开发者/团队 | 可以建议，走 PR 审批 |
| 业务知识 | 业务人员/团队 | 可以建议，走 PR 审批 |

### 5.2 目录结构

```
.linchkit/
  prompts/
    system/                          ← 框架自动生成（不要手动编辑）
      claude_md_template.ts          ← CLAUDE.md 的生成模板
      capability_spec_template.ts    ← Capability Spec 的生成模板
      mcp_tool_descriptions.ts       ← MCP 工具描述的生成模板

    agents/                          ← 人维护（AI 可建议修改，走 PR）
      capability_designer.md         ← 设计 Agent 的 system prompt
      rule_writer.md                 ← Rule 生成 Agent 的 system prompt
      debugger.md                    ← 调试 Agent 的 system prompt
      evolver.md                     ← 进化 Agent 的 system prompt

    skills/                          ← 人维护（AI 可建议修改，走 PR）
      new_capability.md              ← /linch new-capability 的 prompt
      add_rule.md                    ← /linch add-rule 的 prompt
      add_action.md
      diagnose.md

  methodology/                       ← 框架层方法论（人维护）
    schema_design.md
    action_design.md
    rule_design.md
    ...

  knowledge/                         ← 业务层知识（人/业务人员维护）
    company/                         ← 公司制度
    industry/                        ← 行业规范
    domain/                          ← 领域知识
    software/                        ← 软件方法论
```

所有 prompt 和知识文件都在 Git 中版本管理。AI 想改任何 prompt/知识，都要走 Proposal → PR → 审批。

### 5.3 CLAUDE.md 的自动组装

CLAUDE.md 由以下内容自动组装：

```
CLAUDE.md =
  framework_conventions          ← 从 methodology/ 提取
  + current_capabilities         ← 从 capabilities/ 扫描
  + relation_graph               ← 自动推断
  + mcp_tools                    ← 从 Command Registry 提取
  + knowledge_summary            ← 从 knowledge/ 提取摘要
  + agent_definitions            ← 从 prompts/agents/ 提取
  + skill_list                   ← 从 prompts/skills/ 提取
```

每次部署后自动更新。

## 6. 项目结构

```
LinchKit 项目
  ├── CLAUDE.md                      ← 自动生成，AI 完整上下文
  ├── AGENTS.md                      ← 从 prompts/agents/ 自动生成
  ├── .linchkit/
  │   ├── prompts/                   ← Prompt 管理
  │   │   ├── system/                ← 自动生成模板
  │   │   ├── agents/                ← Agent prompt（人维护）
  │   │   └── skills/                ← Skill prompt（人维护）
  │   ├── methodology/               ← 框架层方法论
  │   ├── knowledge/                 ← 业务层知识
  │   │   ├── company/
  │   │   ├── industry/
  │   │   ├── domain/
  │   │   └── software/
  │   ├── mcp-server.ts
  │   └── ai-context-generator.ts
  ├── capabilities/
  │   ├── purchase_management/
  │   └── ...
  └── ...
```

## 6. AI 完整开发流程示例

```
用户："我需要给采购模块加一个预算控制功能"
    ↓
AI 读取 CLAUDE.md → 理解当前系统
    ↓
AI 通过 MCP 工具：
  1. get_schema('purchase_request') → 了解数据结构
  2. get_rules('purchase_management') → 了解现有规则
  3. query_data → 了解实际数据分布
    ↓
AI 生成：
  - 新的 Rule（预算检查）
  - 新的 computed field（部门本月累计）
  - View 调整（显示预算使用情况）
    ↓
AI 调用 create_proposal
    ↓
自动创建 PR → CI 检查 → 用户审批 → 部署
    ↓
CLAUDE.md 自动更新（包含新 Rule 的信息）
```

### 6.5 未来协议支持

#### AG-UI (Agent-User Interaction Protocol)

CopilotKit 团队推出的开放标准，定义 AI Agent 与前端 UI 的双向实时通信。

LinchKit 场景：
- AI 辅助填写表单（AutoForm 实时建议）
- 审批流程中的 Human-in-the-Loop（AI 提交 Proposal → UI 展示 → 用户确认）
- Agent 操作进度的实时流式展示

实现方式：`cap-adapter-ag-ui`（adapter capability），基于 SSE 与 cap-adapter-ui-react 集成。

#### A2A (Agent-to-Agent Protocol)

Google 发起、Linux Foundation 托管的 Agent 间通信协议。

LinchKit 场景：
- LinchKit 作为"一个 Agent"被外部 Agent 编排系统调用
- 多个 LinchKit 实例之间的跨系统协作

实现方式：`cap-adapter-a2a`（adapter capability）。当前优先级低，等协议成熟后实现。

#### Agent Skills

将 LinchKit 的 Schema + Action + Rule 打包为可移植的技能模块，让 AI 编码工具理解如何在 LinchKit 上开发。

实现方式：框架自动生成 skill 文件到 `.linchkit/skills/` 目录。

## 7. 与里程碑的关系

### M0
- CLAUDE.md 自动生成（基础版）
- 基础 MCP 工具（list_capabilities, get_schema, execute_action）
- AGENTS.md 自动生成

### M1
- cap-adapter-mcp 完整实现（Tools + Resources + Prompts）
- Skills 基础框架
- OpenAPI Spec 自动生成

### M2
- AGENTS.md + 专业化 Agent
- 完整 Skills 包
- scaffold 工具
- create_proposal → PR 自动化
- cap-ag-ui 基础实现（AI ↔ UI 实时交互）

### M3
- evolver Agent（自动优化建议）
- AI 上下文随系统演进自动增强
- cap-a2a（Agent 间协作，视协议成熟度）
