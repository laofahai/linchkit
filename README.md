# LinchKit

> **AI Native 的软件能力运行时。任何以数据、规则、状态为核心的软件系统，都可以在这个框架上通过 AI 与人协作逐步"生长"出来，并在统一的治理体系下安全运行和持续演进。**

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

## 里程碑

### M0a — 开发基础设施 + UI 壳子（先造锤子）

**目标：** 搭建 AI 辅助开发环境 + 可视化管理界面骨架。

**验证标准：** AI 有完整类型和 CLAUDE.md。浏览器打开能看到 LinchKit 管理界面壳子。

- [ ] Monorepo 骨架（Bun workspace）
- [ ] tsconfig strict + biome.json + Git hooks
- [ ] 完整类型定义（defineXxx 接口，不实现）
- [ ] CLAUDE.md 手写第一版
- [ ] 基础 CLI（linch init + linch dev）
- [ ] Bun test + 第一个测试
- [ ] GitHub Actions 基础 CI
- [ ] App Shell UI（顶栏 + 侧边栏 + 主内容区 + 登录占位）

---

### M0b — 核心运行时（每做完一块，UI 同步跟上）

**目标：** 用 AI 辅助开发核心引擎，UI 跟引擎同步推进。采购管理场景端到端跑通。

**验证标准：** 浏览器看到采购管理完整界面 — 列表、表单、状态流转、操作按钮、日志。Rule 能拦截超额申请。

- [ ] Schema 引擎（多产物生成）+ Schema 浏览页
- [ ] Action 引擎 + Command Layer + API + GraphQL + Action 测试页
- [ ] Rule 引擎（Level 1-2）+ Rule 列表 + 评估日志
- [ ] State Machine + 状态流转图
- [ ] Event + EventHandler + Outbox + 事件时间线
- [ ] 自动生成业务 UI（list + form + 导航）— 采购管理完整界面
- [ ] cap-auth + cap-permission + 管道插槽 + 登录页 + 权限控制
- [ ] Execution Log + tenant_id + i18n + CLAUDE.md 升级 + 管理 Dashboard

**不做：** Proposal / Validation / Version、蓝绿部署、Bridge / Adapter、AI / MCP、Temporal / Flow、多租户完整、通知 / 定时任务。

---

### M1 — 治理体系 + 部署

**目标：** 变更走 Proposal → GitHub PR → CI → 审批 → 蓝绿部署。

**验证标准：** Proposal 新增 Rule → 自动创建 PR → CI 通过 → 审批 merge → Webhook 触发蓝绿部署 → 可回滚。

- [ ] Proposal 模型 + Validation
- [ ] Version 管理（Git tag、diff、回滚）
- [ ] 审批机制（require_approval 完整流程）
- [ ] 单机蓝绿部署 + Nginx
- [ ] GitHub 集成（PR + CI + Webhook）
- [ ] DB Migration（up + down）
- [ ] Temporal 引入 + defineFlow 基础
- [ ] Bridge 模块支持
- [ ] Execution Log 完善
- [ ] Metrics + Dashboard
- [ ] 完整 CI Pipeline + AI Review

---

### M2 — AI 接入 + 多租户

**目标：** AI 通过 MCP 调用 Action、生成 Proposal。多租户基础可用。

- [ ] MCP 适配器
- [ ] CLAUDE.md + AGENTS.md 完整版
- [ ] AI Skills 包
- [ ] AI 辅助生成 Proposal
- [ ] Rule Context Level 3-4
- [ ] 多租户（Standalone + SaaS 双模式）
- [ ] AI 安全（权限限制 + 速率 + 审计）

---

### M3 — 系统能"长"

**目标：** AI 协助设计和生成完整 Capability，系统持续自我优化。

- [ ] AI 生成完整 Capability
- [ ] Rule Context Level 5（跨模块）
- [ ] Evolution System（Observe → Propose）
- [ ] Flow AI 步骤 + 条件分支 + 并行
- [ ] Capability Hub 基础

---

### M4 — 生产级

- [ ] 多租户完整（Schema/DB 级隔离、计费）
- [ ] 多机 Rolling Update
- [ ] OpenTelemetry 接入
- [ ] 已有系统迁移工具
- [ ] Capability Hub 完整市场

---

## 架构全景

```
                    ┌─────────────────────────────┐
                    │         入口层                │
                    │  CLI / MCP / HTTP API / UI   │
                    └──────────┬──────────────────┘
                               ↓
                    ┌─────────────────────────────┐
                    │      Command Layer           │
                    │  slot: pre → auth →          │
                    │  exposure → permission →     │
                    │  tenant → pre-action         │
                    └──────────┬──────────────────┘
                               ↓
          ┌────────────────────┼────────────────────┐
          ↓                    ↓                     ↓
   ┌─────────────┐    ┌──────────────┐    ┌──────────────┐
   │ Action      │    │ GraphQL      │    │ Proposal     │
   │ Engine      │    │ Query Engine │    │ Engine       │
   │ (写)        │    │ (读)         │    │ (变更治理)    │
   └──────┬──────┘    └──────────────┘    └──────────────┘
          ↓
   ┌─────────────┐
   │ Rule Engine │ ← Trigger + Context + Condition + Effect
   └──────┬──────┘
          ↓
   ┌─────────────┐    ┌──────────────┐    ┌──────────────┐
   │ State       │    │ Event Bus    │    │ Temporal     │
   │ Machine     │    │ + Outbox     │    │ (Flow 编排)  │
   └─────────────┘    └──────┬───────┘    └──────────────┘
                             ↓
                    ┌──────────────────┐
                    │  EventHandler    │
                    │  (同步 + 异步)    │
                    └──────────────────┘
                             ↓
                    ┌──────────────────┐
                    │   PostgreSQL     │
                    │  业务数据 + Event │
                    │  + Outbox + Log  │
                    └──────────────────┘
```

---

## 开发记录

[devlog/](devlog/) — 每次开发会话的记录，包含进度、决策、问题、下次接续点。新 AI 会话先读 devlog 最新记录了解当前状态。

---

## 成功率判断

| 路径 | 可行性 |
|------|--------|
| 终局全做 | 10%~20% |
| 收敛到 M0~M2 | 60%~70% |
| 单场景 M0 跑通 | **80%+** |
