# 部署架构设计规范

## 1. 整体架构

```
┌──────────────────────────────────────────────────────┐
│                   LinchKit 服务器                      │
│                                                       │
│   ┌───────────────────┐    ┌───────────────────────┐ │
│   │  Control           │    │  Runtime               │ │
│   │  ─ Git 仓库（本地） │    │  ─ Instance A (运行中)  │ │
│   │  ─ Builder (Bun)   │    │  ─ Instance B (待命)    │ │
│   │  ─ Deployer        │    │                         │ │
│   │  ─ Webhook 接收    │    │                         │ │
│   └───────────────────┘    └───────────────────────┘ │
│                                                       │
│   ┌───────────────────────────────────────────────┐  │
│   │  PostgreSQL                                     │  │
│   └───────────────────────────────────────────────┘  │
│                                                       │
│   ┌───────────────────────────────────────────────┐  │
│   │  Nginx（反向代理，蓝绿切换 upstream）            │  │
│   └───────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────┘
         │
         │  push / pull
         ▼
   GitHub / GitLab
     ├── 代码托管
     ├── PR Review（diff、评论、AI Review）
     ├── CI（类型检查、Validation、测试）
     └── Webhook（merge 后通知服务器）
```

## 2. 两条发布路径

### 路径 A：开发者改代码

```
开发者本地开发 → Push to GitHub → 创建 PR
    → CI 检查 → Review → Merge
    → Webhook 通知服务器
    → 服务器 pull → 构建 → 蓝绿切换
```

### 路径 B：AI / Proposal 驱动（系统生长）

```
服务器上：
  1. AI 生成/修改 TS 文件
  2. git checkout -b proposal/xxx
  3. git commit + git push

GitHub 上：
  4. LinchKit 调 GitHub API 创建 PR
  5. CI 自动运行（类型检查、Validation、测试）
  6. 可选：AI Code Review
  7. 用户在 LinchKit UI 看到 Proposal，链接到 PR
  8. 用户 Approve（LinchKit 调 API merge，或用户在 GitHub merge）

服务器上：
  9. 收到 Webhook
  10. git pull
  11. 本地构建
  12. 蓝绿切换
  13. 更新 Proposal 状态为 deployed
```

## 3. 各组件职责

### LinchKit 服务器

| 组件 | 职责 |
|------|------|
| Git 仓库 | AI 写代码的工作目录 + 部署时 pull 最新代码 |
| Builder | pull 后本地构建（Bun build） |
| Deployer | 蓝绿切换（启动新实例、健康检查、Nginx 切 upstream、停旧实例） |
| Webhook 接收 | 接收 GitHub merge 事件，触发 pull + build + deploy |

### GitHub / GitLab

| 职责 | 说明 |
|------|------|
| 代码托管 | 唯一的远程 source of truth |
| PR | 变更的 Review 界面（diff、评论） |
| CI | 自动化检查（类型检查、Validation、测试） |
| AI Review | 可选，GitHub Copilot 或其他 AI Review 工具 |
| Branch Protection | 强制要求 CI 通过 + Review 才能 merge |
| Webhook | merge 后通知服务器部署 |

### Nginx

蓝绿切换的核心：

```nginx
upstream linchkit {
    server 127.0.0.1:3000;  # Instance A
    # server 127.0.0.1:3001;  # Instance B（切换时注释/取消注释）
}
```

Deployer 通过修改 Nginx 配置 + reload 实现流量切换。

## 4. 蓝绿切换流程

```
1. git pull origin main
2. bun install（如果依赖变了）
3. 执行 DB migration（如果有）
4. 启动待命实例（新版本，新端口）
5. 健康检查（GET /health 返回 200）
6. 修改 Nginx upstream → 新端口
7. nginx reload
8. 等旧实例处理完进行中的请求（graceful shutdown）
9. 停止旧实例
10. 旧实例变为下次部署的待命实例
```

## 5. DB Migration

### 5.1 正向和反向

每个 migration 必须有 up 和 down：

```typescript
// migrations/20260320_001_add_inbound_status.ts
export const up = async (db) => {
  await db.schema.alterTable('purchase_request', (t) => {
    t.addColumn('inbound_status', 'varchar')
  })
}

export const down = async (db) => {
  await db.schema.alterTable('purchase_request', (t) => {
    t.dropColumn('inbound_status')
  })
}
```

AI 生成 Proposal 时必须同时生成 up 和 down。CI 阶段验证 down 是否存在。

### 5.2 Migration 安全策略

#### 加东西（加字段、加表）
```
先跑 migration → 再部署新代码
```

#### 删东西（删字段、删表）
分两个版本：
```
版本 N: 部署新代码（不再使用该字段，但字段保留）
版本 N+1: 跑 migration 删字段
```

#### 不可逆 Migration
Validation 标记为 major 变更，PR 中明确警告，必须人工确认。

## 6. 回滚

### 快速回滚（旧实例还在）
```
Nginx 切回旧实例 upstream → reload
秒级完成
```

### 完整回滚（旧实例已停）
```
git revert → push → PR（标记为 rollback，可快速 merge）
→ Webhook → pull → build → deploy
同时执行 migration down（如果需要）
```

## 7. 多机部署（M4）

```
Control 服务器（1台）
    ├── Git 仓库
    ├── 构建
    ├── 分发构建产物到各 Runtime 服务器
    └── 协调 Rolling Update

Runtime 服务器（N台）
    ├── 蓝绿实例
    ├── Nginx
    └── 接收 Control 部署指令

共享：PostgreSQL
```

Rolling Update 流程：
```
1. Control 构建新版本
2. 执行 DB migration（向后兼容部分）
3. 逐台：分发产物 → 启动新实例 → 健康检查 → 切流量 → 停旧实例
4. 全部完成 → 成功
5. 任何一台失败 → 暂停，决定回滚
```

## 8. 与里程碑的关系

### M0
- 开发环境，手动重启
- 无蓝绿，无 CI/CD

### M1
- 单机蓝绿部署
- GitHub PR 审批流程
- CI 自动检查（GitHub Actions）
- Webhook 触发自动部署
- DB migration up/down

### M2
- AI Proposal → 自动创建 PR → 用户审批 → 自动部署
- LinchKit UI 中展示 Proposal + PR 链接

### M4
- 多机 Rolling Update
- Control 协调部署
