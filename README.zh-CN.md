# LinchKit

> **AI Native 的软件能力运行时。** 任何以数据、规则、状态为核心的软件系统，都可以在这个框架上通过 AI 与人协作逐步"生长"出来，并在统一的治理体系下安全运行和持续演进。

[English](./README.md)

---

## 核心主张

1. **统一元模型** — Schema + Action + Rule + State + Event + EventHandler + View + Flow
2. **AI 深度参与** — 设计、生成、优化，但不能直接改生产
3. **模块化组织** — Capability（standard / bridge / adapter），可独立演进、按需组合
4. **统一入口** — Command Layer 统一 CLI / MCP / API / UI，Action 是唯一写入口，GraphQL 读取
5. **变更治理** — Proposal → GitHub PR → CI → 审批 → 蓝绿部署
6. **方法论驱动** — 框架层规范 + 业务层知识，AI 遵循 SOP 生成代码

## 适用范围

电商、SaaS、项目管理、CMS、ERP、预约系统、IoT 管理平台 — 只要核心是数据 + 规则 + 状态的软件。

不适用于：计算密集型、实时系统、底层系统。

---

## 技术栈

| 层面 | 选型 |
|------|------|
| 语言 | TypeScript |
| 运行时 | Bun（不兼容 Node） |
| 后端 | Elysia |
| 数据库 | PostgreSQL |
| ORM | Drizzle |
| GraphQL | graphql-yoga + Pothos (code-first) |
| 状态机 | 自研纯 TS（XState 可选升级） |
| 工作流 | Temporal（M1 引入） |
| 前端 | React + Vite + TanStack Router |
| UI | Shadcn + Lucide + Tailwind |
| 代码质量 | Biome + TypeScript strict |

---

## 包结构

```
@linchkit/core       — 核心运行时（Action/Rule/State/Event/Schema 引擎）
@linchkit/cli        — CLI 工具（基于 citty）
@linchkit/server     — HTTP 服务（Elysia + graphql-yoga + Pothos）
@linchkit/mcp        — MCP 适配器（可选安装）
@linchkit/ui         — 前端 UI 组件 + Headless hooks
@linchkit/migrate    — 迁移工具
@linchkit/devtools   — 测试工具 + 开发调试
```

---

## 里程碑

### M0a — 开发基础设施 + UI 壳子

**目标：** 搭建 AI 辅助开发环境 + 可视化管理界面骨架。

- [x] Monorepo 骨架（Bun workspace）
- [x] tsconfig strict + biome.json + Git hooks
- [x] 完整类型定义（defineXxx 接口，不实现）
- [x] CLAUDE.md 手写第一版
- [x] 基础 CLI（linch init + linch dev）
- [x] Bun test + 第一个测试
- [x] GitHub Actions 基础 CI
- [x] App Shell UI（顶栏 + 侧边栏 + 主内容区 + 登录占位）

*M0a 已完成。*

### M0b — 核心运行时

**目标：** 采购管理场景端到端跑通。

*(核心引擎已提前实现，UI 组件待完成)*

- [ ] Schema 引擎（多产物生成）+ Schema 浏览页 *（Schema 展示元数据类型已加入 core：`SchemaPresentation`、`FieldUIHints`、workspace `ViewType`）*
- [ ] Action 引擎 + Command Layer + API + GraphQL + Action 测试页
- [x] Rule 引擎（Level 1-2）核心 ~~+ Rule 列表 + 评估日志~~
- [x] State Machine 核心 ~~+ 状态迁移图~~
- [ ] Event + EventHandler + Outbox + 事件时间线
- [ ] 自动生成业务 UI（列表 + 表单 + 导航）— 采购管理
- [ ] cap-auth + cap-permission + pipeline slots + 登录 + 访问控制
- [ ] Execution Log + tenant_id + i18n + CLAUDE.md 升级 + 管理 Dashboard

### M1 — 治理体系 + 部署

Proposal → GitHub PR → CI → 审批 → 蓝绿部署

### M2 — AI 接入 + 多租户

MCP 适配器 + AI Skills + 多租户

### M3 — 系统能"长"

AI 生成完整 Capability + Evolution System

### M4 — 生产级

多租户完整 + 多机部署 + OpenTelemetry

---

## 开发

```bash
bun install          # 安装依赖
bun test             # 运行测试
bun run dev          # 启动开发服务器
bun run check        # Biome 检查
bun run typecheck    # TypeScript 类型检查
```

## 许可

MIT
