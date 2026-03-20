# LinchKit - AI 开发指令

## 项目概述

LinchKit 是 AI Native 的软件能力运行时。技术栈：TypeScript / Bun / Elysia / PostgreSQL / Drizzle / GraphQL (Pothos) / React / Vite / TanStack Router / Shadcn / Biome。

## 核心原则

- **KISS**：保持简单
- **YAGNI**：不做不需要的
- **数据结构优先**：先设计好数据结构
- **中文沟通**：始终用中文

## 技术约束

- 运行时：Bun（不兼容 Node）
- 代码质量：Biome（不用 ESLint / Prettier）
- 测试：`bun test`
- 包管理：Bun workspace（monorepo）
- TypeScript：strict 模式
- 后端框架：Elysia
- ORM：Drizzle
- GraphQL：graphql-yoga + Pothos（code-first）
- 前端路由：TanStack Router
- UI：Shadcn + Lucide + Tailwind

## 常用命令

```bash
bun install          # 安装依赖
bun test             # 运行测试
bun run dev          # 启动开发服务器
bun run build        # 生产构建
bun run check        # Biome 检查
bun run format       # Biome 格式化
```

## 开发流程

1. `/start` — 开始会话，加载上下文
2. `/plan` — 分析需求，生成设计方案
3. `/tasks` — 生成任务列表
4. `/implement` — 按任务执行实现
5. `/push` — 提交推送
6. `/review-session` — 复盘
7. `/handover` — 生成交接 prompt
