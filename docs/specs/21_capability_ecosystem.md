# Capability 生态系统设计规范

## 1. 概述

本文档定义 LinchKit Capability 生态系统的全生命周期架构：仓库策略、命名规范、分发机制、信任层级、商业模型、元数据 Schema、安装机制、质量保障、版本兼容性。

生态系统的设计基于对 Obsidian、Strapi、Shopify、WordPress、VSCode、Grafana、Terraform 等项目的调研。

**相关文档：**
- `01_capability_structure.md` — Capability 结构与组织
- `14_system_capabilities.md` — 系统内置 Capability 清单
- `20_extension_mechanism.md` — 扩展机制
- `21_capability_hub.md` — Hub 产品细节（M3+）

## 1.1 Capability 可选性原则

框架核心（`@linchkit/core`）可以在**零 Capability** 的状态下独立运行。所有 Capability —— 包括 cap-auth 和 cap-permission —— 都是可选的：

- **零 Capability 运行**：`linch init --bare` 创建的项目不安装任何 Capability，框架以匿名模式 + 无权限控制的方式运行
- **认证/权限可选**：cap-auth 和 cap-permission 是"推荐安装"而非"必装"。未安装时功能降级（匿名模式 / 无权限控制），不影响框架运行
- **启动包是便利包**：starter-minimal 等启动包打包了推荐的 Capability 组合，方便快速上手，但不是必须的
- **业务 Capability 弱依赖 auth**：业务模块（如采购管理）应将 cap-auth 声明为弱依赖（`required: false`），确保在无认证环境下也能运行

这种设计支持渐进式开发：先装业务 Capability 开始构建，后续按需添加认证、权限、审计等系统能力。

## 1.2 合约/实现分离原则（Contract/Implementation Split）

当一个 Capability 需要对接**可替换的外部引擎**时，应将合约层和实现层拆分为独立的包：

```
cap-xxx           ← 合约层：Schema + Action 签名 + Provider 接口 + Factory
cap-xxx-engine    ← 实现层：具体引擎集成，实现 Provider 接口
```

**适用条件**（满足任一即拆分）：
- 存在多种可能的实现引擎（如认证：better-auth / Lucia / 自研）
- 实现层引入重量级第三方依赖（如 better-auth 100KB+）
- 实现层可能需要独立发版周期

**不适用条件**：
- 实现逻辑在 core 中（如 cap-permission 的权限评估在 core 的 `checkActionPermission` 中）
- 只有一种合理的实现方式，且无重量级外部依赖

**当前实例**：
| 合约 | 实现 | 原因 |
|------|------|------|
| `cap-auth` | `cap-auth-better-auth` | 认证引擎可替换，better-auth 是重依赖 |
| `cap-permission` | 不拆分 | 评估逻辑在 core，管理逻辑简单 |

**设计模式**：
```typescript
// 合约层定义 Provider 接口
interface AuthProvider {
  login(ctx, input): Promise<LoginResult>
  resolveToken(token): Promise<Actor | null>
  // ...
}

// 合约层提供工厂函数
function createCapAuth(options: { provider: AuthProvider }): CapabilityDefinition

// 实现层导出具体 provider
function createBetterAuthProvider(config): AuthProvider
```

## 2. 仓库策略（分阶段）

### 2.1 三层架构回顾

```
@linchkit/core                    ← 框架内核（不是 Capability）
@linchkit/cap-*                   ← 官方基础能力
@linchkit/starter-*               ← 官方启动包
linchkit-cap-*                    ← 社区能力
```

Capability 类型：standard, bridge, adapter
分类：system, infrastructure, integration, business, ui, utility, starter

### 2.2 M0-M1：主仓库内独立包

所有官方 Capability 放在主 monorepo 的 `packages/cap-*` 目录下，但 **以独立包的形式编写**：

- 每个 Capability 有自己的 `package.json`
- 只依赖 `@linchkit/core` 的公开 API（不用内部路径）
- 独立可测试（`bun test packages/cap-auth`）
- 共享 CI/CD、Biome 配置、TypeScript 配置

```
linchkit/                                ← 主 monorepo
  packages/
    core/                                ← @linchkit/core
    cli/                                 ← @linchkit/cli
    devtools/                            ← @linchkit/devtools
  capabilities/
    cap-adapter-server/                  ← @linchkit/cap-adapter-server
    cap-adapter-mcp/                     ← @linchkit/cap-adapter-mcp
    cap-adapter-ui-react/                ← @linchkit/cap-adapter-ui-react
    cap-auth/                            ← @linchkit/cap-auth
    cap-auth-better-auth/                ← @linchkit/cap-auth-better-auth
    cap-permission/                      ← @linchkit/cap-permission
    cap-purchase-demo/                   ← @linchkit/cap-purchase-demo (demo)
```

**优势：** 开发效率高，类型检查即时反馈，统一 CI 管道。
**约束：** Capability 代码不能 import core 的内部模块，必须走公开 API。

### 2.3 M2：官方能力独立仓库

将官方 Capability 迁移到独立 monorepo `linchkit-capabilities/`：

```
linchkit-capabilities/            ← 官方能力仓库
  packages/
    cap-auth/
    cap-permission/
    cap-audit/
    cap-notification/
    starter-minimal/
    starter-business/
    starter-saas/
```

**迁移条件：**
- `@linchkit/core` 公开 API 稳定（breaking change 频率 < 1次/月）
- CI 管道模板成熟，可独立运行
- 版本兼容性校验工具就绪

### 2.4 M3+：自建 Capability Hub

在独立仓库的基础上，增加 Web UI 市场：

- 搜索、安装、评分、文档
- 社区提交、审核流程
- 签名验证
- 详见 `21_capability_hub.md`

## 3. 命名规范

| 类型 | npm scope | 示例 | 说明 |
|------|-----------|------|------|
| 官方系统级 | `@linchkit/cap-*` | `@linchkit/cap-auth` | LinchKit 团队维护 |
| 官方启动包 | `@linchkit/starter-*` | `@linchkit/starter-business` | 打包一组基础能力 |
| 社区（约定） | `linchkit-cap-*` | `linchkit-cap-crm` | 无 scope，前缀约定 |

**规则：**
- 官方包使用 `@linchkit/` scope，保证品牌辨识
- 社区包使用 `linchkit-cap-` 前缀（无 scope），降低发布门槛
- 企业内部包可使用自有 scope：`@my-company/linchkit-cap-*`
- 包名使用 kebab-case，不使用 `capability-` 全称（历史命名如 `21_capability_hub.md` 中的 `@linchkit/capability-sms-service` 已废弃，统一为 `cap-` 短前缀）

## 4. 分发机制

### 4.1 M0-M2：npm 注册表

- 发布到 npmjs.com（公开）或 npmmirror.com（国内镜像）
- 企业内部可使用私有 npm registry（Verdaccio 等）
- 标准 npm 发布流程：`npm publish` / `bun publish`

### 4.2 M2：GitHub 注册表

参考 Obsidian 的 `community-plugins.json` 模式：

```json
// capability-registry.json (GitHub repo)
[
  {
    "name": "linchkit-cap-crm",
    "repo": "user/linchkit-cap-crm",
    "description": "CRM management capability",
    "trustLevel": "community",
    "npm": "linchkit-cap-crm"
  }
]
```

**流程：**
1. 开发者提交 PR 到注册表仓库
2. 自动化检查（lint、类型、依赖、安全扫描）
3. 人工审核（可选，仅 Verified 级别）
4. 合并后自动出现在 CLI 搜索结果中

**优势：** 零基础设施成本，社区驱动，Git 作为 audit trail。

### 4.3 M3+：自建 Hub

Web UI 市场，详见 `21_capability_hub.md`。

## 5. 信任层级

| Level | 标识 | 说明 | 获取方式 |
|-------|------|------|----------|
| `official` | ✦ | LinchKit 团队维护 | `@linchkit/` scope |
| `verified` | ✓ | 已审核的第三方 | 人工 review + 签名 |
| `community` | ○ | 基本自动化检查通过 | PR 合并到注册表 |
| `unverified` | — | 未经审核 | 直接 npm install |

**安装时提示：**

```
$ linch install linchkit-cap-crm
⚠ Trust level: community
  This capability has passed automated checks but has not been
  manually reviewed. Install anyway? [y/N]

$ linch install some-random-package
⚠ Trust level: unverified
  This capability is not in the LinchKit registry.
  We cannot guarantee its safety. Install anyway? [y/N]
```

**信任层级与系统权限的关系：**
- `unverified` 的 Capability 不允许声明系统权限
- `community` 的 Capability 只允许 `database.create_table` 和 `database.create_index`
- `verified` 和 `official` 无限制

## 6. Open Core 商业模型

### 6.1 免费层（MIT 许可）

| 类别 | 内容 |
|------|------|
| 框架 | `@linchkit/core`, `@linchkit/cli`, `@linchkit/devtools` |
| 官方适配器 | `cap-adapter-server`, `cap-adapter-mcp`, `cap-adapter-ui-react` |
| 基础能力 | `cap-auth`, `cap-auth-better-auth`, `cap-permission` |
| 社区生态 | 所有社区 Capability |

### 6.2 付费层（Enterprise 许可）

| 类别 | 内容 | 定价策略 |
|------|------|----------|
| 高级能力 | 多租户增强、高级审计分析、SSO/SAML | 订阅制 |
| 企业启动包 | `starter-saas`、行业启动包 | 订阅制 |
| 市场佣金 | M4+ Capability 市场交易抽成 | 15% 参考 Shopify |
| 托管服务 | 云端 LinchKit 实例 | 按用量 |

### 6.3 参考模型

参考 Strapi 的做法：
- 核心框架 MIT 开源
- `ee/` 目录下的企业功能独立许可
- 插件生态开放

**原则：**
- 独立开发者和小团队可以免费使用所有核心功能
- 企业级功能（多租户、SSO、高级分析）付费
- 不会把社区已有的功能变成付费功能

## 7. Capability 元数据 Schema

每个 Capability 必须在 `package.json` 或独立的 `capability.json` 中声明元数据：

### 7.1 package.json 中的 linchkit 字段

```json
{
  "name": "@linchkit/cap-auth",
  "version": "1.0.0",
  "peerDependencies": {
    "@linchkit/core": "^0.1.0"
  },
  "linchkit": {
    "minCoreVersion": "^0.1.0",
    "type": "standard",
    "category": "system",
    "trustLevel": "official",
    "systemPermissions": ["database.create_table"]
  }
}
```

### 7.2 capability.json（独立文件，优先级高于 package.json）

```json
{
  "name": "@linchkit/cap-auth",
  "minCoreVersion": "^0.1.0",
  "type": "standard",
  "category": "system",
  "trustLevel": "official",
  "systemPermissions": ["database.create_table"],
  "dependencies": [
    { "capability": "@linchkit/cap-permission", "required": true }
  ],
  "optionalDependencies": [
    { "capability": "@linchkit/cap-notification", "required": false }
  ],
  "extensions": {
    "fieldTypes": [],
    "viewTypes": [],
    "ruleEffects": [],
    "services": ["auth"],
    "middlewares": ["auth-middleware"],
    "hooks": []
  }
}
```

### 7.3 字段说明

| 字段 | 类型 | 必填 | 说明 |
|------|------|:----:|------|
| `name` | string | ✓ | 包名（与 npm 包名一致） |
| `minCoreVersion` | semver range | ✓ | 要求的 core 最低版本 |
| `type` | enum | ✓ | `standard` / `bridge` / `adapter` |
| `category` | string | ✓ | 分类，见 `01_capability_structure.md` |
| `trustLevel` | enum | — | `official` / `verified` / `community` / `unverified` |
| `systemPermissions` | string[] | — | 需要的系统权限 |
| `dependencies` | array | — | 强依赖声明 |
| `optionalDependencies` | array | — | 弱依赖声明 |
| `extensions` | object | — | 提供的框架级扩展 |

## 8. 安装机制

### 8.1 安装命令

```bash
# 安装官方 Capability
linch install @linchkit/cap-auth

# 安装社区 Capability
linch install linchkit-cap-crm

# 安装多个
linch install @linchkit/cap-auth @linchkit/cap-permission

# 安装启动包（安装包本身 + 其所有 dependencies）
linch install @linchkit/starter-business

# 更新
linch update @linchkit/cap-auth

# 卸载（有依赖保护）
linch uninstall @linchkit/cap-audit

# 搜索
linch search "CRM"
```

### 8.2 安装流程

```
linch install linchkit-cap-crm
  │
  ├── 1. 解析 npm 包 → 下载
  ├── 2. 读取 capability.json / package.json linchkit 字段
  ├── 3. 检查信任层级 → 提示用户确认
  ├── 4. 检查 minCoreVersion 兼容性 → 不兼容则警告/中止
  ├── 5. 检查 systemPermissions → 提示用户确认
  ├── 6. 解析依赖树 → 自动安装缺失的强依赖
  ├── 7. 检测循环依赖 → 有则报错
  ├── 8. 注册到项目配置 (linchkit.config.ts)
  └── 9. 运行 Capability 的 setup hook（如果有）
```

### 8.3 脚手架命令

```bash
# 创建新的 Capability 项目
linch create capability my-capability

# 交互式选择模板
linch create capability my-capability --template=standard
linch create capability my-capability --template=bridge
linch create capability my-capability --template=adapter
```

生成的目录结构：

```
my-capability/
  package.json                 # npm 包配置 + linchkit 元数据
  capability.json              # Capability 元数据（可选，优先于 package.json）
  capability.ts                # defineCapability() 入口
  schema/
  actions/
  rules/
  states/
  views/
  tests/
  README.md
```

## 9. 质量保障

### 9.1 自动化检查（所有 Capability）

| 检查项 | 工具 | 说明 |
|--------|------|------|
| 代码规范 | Biome | lint + format |
| 类型安全 | TypeScript strict | 编译检查 |
| 依赖检查 | 自定义 | 不依赖 core 内部模块，依赖声明完整 |
| 安全扫描 | 自定义 | 检查 systemPermissions 与实际代码匹配 |
| 元数据校验 | 自定义 | capability.json / linchkit 字段完整性 |
| 基本测试 | Bun test | 必须有测试，覆盖率 > 0 |

### 9.2 人工审核（Verified 级别）

提交到注册表 PR 后，审核员检查：
- 代码质量和安全性
- 是否滥用系统权限
- 是否遵循 Capability 设计规范
- 用户体验（如果有 UI 扩展）

### 9.3 签名机制（M3+）

参考 Grafana 的 plugin signatures：

| 签名类型 | 说明 |
|----------|------|
| `official` | LinchKit 团队签名 |
| `commercial` | 付费 Capability，经过额外安全审计 |
| `community` | 社区签名（基本身份验证） |
| `unsigned` | 无签名 |

**运行时行为：**
- 默认只加载 `official` 和 `commercial` 签名的 Capability
- `community` 签名需要配置 `allowCommunityCapabilities: true`
- `unsigned` 需要配置 `allowUnsignedCapabilities: true`（开发模式默认 true）

## 10. 版本兼容性

### 10.1 Core 版本要求

通过两种方式声明：

1. **peerDependencies**（npm 标准）：
```json
{
  "peerDependencies": {
    "@linchkit/core": "^0.1.0"
  }
}
```

2. **linchkit.minCoreVersion**（元数据）：
```json
{
  "linchkit": {
    "minCoreVersion": "^0.1.0"
  }
}
```

两者都要声明。peerDependencies 用于 npm 安装时的版本解析，minCoreVersion 用于运行时校验。

### 10.2 CLI 行为

```
$ linch install linchkit-cap-crm
⚠ Version warning:
  linchkit-cap-crm requires @linchkit/core ^0.3.0
  You have @linchkit/core 0.2.5
  Some features may not work. Continue? [y/N]
```

### 10.3 破坏性变更协议

参考 `38_release_compatibility.md`：
- Core 公开 API 变更必须提供迁移指南
- 废弃的 API 保留至少一个 minor 版本周期
- Capability 可以通过 `migrate()` hook 处理数据迁移

## 11. 与里程碑的关系

### M0（当前）
- 框架内核（可独立运行，零 Capability 也能跑）
- cap-auth + cap-permission 作为推荐安装
- 所有代码在主 monorepo
- 手动安装（bun add）

### M1
- 增加 cap-audit, cap-proposal, cap-file-storage, cap-search
- CLI `linch install` 命令（npm wrapper）
- CLI `linch create capability` 脚手架
- capability.json 元数据校验

### M2
- 官方 Capability 迁移到独立仓库
- GitHub 注册表（capability-registry.json）
- `linch search` 从注册表查询
- 信任层级系统生效
- cap-notification, cap-comment, cap-user-profile, cap-import-export

### M3
- 自建 Capability Hub Web UI
- 签名机制
- cap-report, cap-dashboard, cap-tag, cap-scheduler
- starter-saas, 行业启动包

### M4+
- 市场交易（佣金模式）
- 付费 Capability 分发
- 高级分析和推荐

## 12. 参考项目

| 项目 | 借鉴点 | LinchKit 采纳情况 |
|------|--------|-------------------|
| **Obsidian** | GitHub JSON 注册表，community-plugins.json，零基础设施 | M2 采用类似模式 |
| **Strapi** | monorepo 官方插件，npm 分发，`ee/` 目录企业功能 | M0-M1 主仓库策略，Open Core 模型 |
| **Grafana** | 插件签名（community/commercial/enterprise），grafana-cli | M3+ 签名机制 |
| **VSCode** | Verified Publisher，extension marketplace | 信任层级参考 |
| **Terraform** | Provider Registry，official/partner/community 信任层级 | 三级信任层级（加 unverified） |
| **WordPress** | 插件目录 | **反面教材** — 2025 年 11K 漏洞，缺乏签名和强制审核 |
| **Shopify** | App Store，15% 佣金 | M4+ 市场佣金参考 |

### 关键教训

1. **从 WordPress 学到：** 必须有签名机制和系统权限控制，不能让插件随意访问系统资源
2. **从 Obsidian 学到：** 早期阶段不需要复杂基础设施，GitHub JSON + PR 足矣
3. **从 Strapi 学到：** 官方插件放 monorepo 有利于保持 API 一致性
4. **从 Grafana 学到：** 签名分级（而非二元的签名/未签名）更实用
5. **从 Terraform 学到：** 信任层级应该是渐进的，从 unverified 到 official
6. **从 Shopify 学到：** 市场佣金是可持续的商业模式，但需要足够的生态规模
