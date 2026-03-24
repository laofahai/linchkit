# 初始化与引导设计规范

## 1. 新项目创建

```bash
linch init my-project
cd my-project
```

生成的项目结构：

```
my-project/
  ├── linchkit.config.ts         # 项目配置
  ├── package.json
  ├── tsconfig.json
  ├── capabilities/
  │   └── .gitkeep
  ├── migrations/
  │   └── .gitkeep
  ├── tests/
  │   └── .gitkeep
  ├── CLAUDE.md                  # 自动生成
  └── AGENTS.md                  # 模板
```

### linchkit.config.ts

```typescript
import { defineConfig } from '@linchkit/core'

export default defineConfig({
  // 数据库
  database: {
    url: process.env.DATABASE_URL || 'postgres://localhost:5432/my_project',
  },

  // 系统 Capability
  system: {
    auth: true,           // 启用认证
    permission: true,     // 启用权限
    notification: false,  // 暂不启用通知
    audit: true,          // 启用审计日志
  },

  // 服务
  server: {
    port: 3000,
    host: '0.0.0.0',
  },

  // 队列
  queue: {
    pollInterval: 1000,
    batchSize: 10,
  },

  // GitHub 集成（Proposal 用）
  github: {
    repo: 'myorg/my-project',
    token: process.env.GITHUB_TOKEN,
  },
})
```

## 2. 首次启动引导

```bash
linch dev
```

首次启动时框架自动：

```
1. 检查数据库连接
2. 创建系统表（events, outbox, executions, versions 等）
3. 安装系统 Capability（auth, permission 等）
4. 检测到没有管理员用户 → 进入初始化向导
```

### 初始化向导

```
> LinchKit 首次启动，需要创建管理员账户
>
> 用户名: admin
> 密码: ********
> 确认密码: ********
>
> ✓ 管理员账户已创建
> ✓ admin 已分配 system_admin 权限组
> ✓ 系统初始化完成
>
> 管理界面: http://localhost:3000
> GraphQL:  http://localhost:3000/api/graphql
> API:      http://localhost:3000/api
```

## 3. 种子数据

Capability 可以定义种子数据，首次安装时自动导入：

```typescript
// capabilities/purchase_management/seed.ts
import { defineSeed } from '@linchkit/core'

export default defineSeed({
  // 只在首次安装时运行
  runOnce: true,

  data: {
    department: [
      { id: 'dept_sales', name: '销售部' },
      { id: 'dept_tech', name: '技术部' },
      { id: 'dept_finance', name: '财务部' },
    ],
  },
})
```

## 4. 系统管理员权限组

框架内置 `system_admin` 权限组，拥有所有权限：

```typescript
// 框架内置，不需要用户定义
const systemAdmin = definePermissionGroup({
  name: 'system_admin',
  label: '系统管理员',
  builtin: true,

  // 所有 Capability 的所有操作
  permissions: { '*': { actions: { '*': true }, data: { '*': { read: 'all' } } } },

  // 所有治理操作
  governance: {
    proposal: { create: true, approve: true, reject: true },
    version: { release: true, rollback: true },
  },
})
```

## 5. Capability 安装流程

当开发者在 capabilities/ 下创建了新的 Capability 并重启（或部署）：

```
框架启动
    ↓
扫描 capabilities/ 目录
    ↓
发现新 Capability: purchase_management
    ↓
1. 验证定义合法性
2. 生成并执行 DB migration（创建表）
3. 注册 Action / Rule / State / View / EventHandler
4. 导入种子数据（如果有）
5. 注册 GraphQL types + queries
6. 注册 HTTP API 路由
7. 更新 CLAUDE.md
    ↓
Capability 安装完成，可用
```

## 6. 开发模式 vs 生产模式

| | 开发模式 (linch dev) | 生产模式 |
|--|-----|------|
| 启动 | 直接启动，hot reload | 蓝绿部署 |
| Migration | 自动检测变化并执行 | 必须通过部署流程 |
| 种子数据 | 每次可重置 | 只跑一次 |
| 初始化向导 | CLI 交互 | 环境变量 / 配置文件 |
| 错误显示 | 详细堆栈 | 简洁错误码 |
| CLAUDE.md | 实时更新 | 部署后更新 |
