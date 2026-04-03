# 扩展机制设计规范

## 1. 核心原则

**没有 Plugin 概念，所有东西都是 Capability。** 部分 Capability 可以额外提供框架级扩展能力。

```
Capability
  ├── 业务能力：Schema, Action, Rule, State, Event, EventHandler, View, Flow, Navigation
  └── 框架扩展（可选）：extensions { fieldTypes, viewTypes, ruleEffects, services, hooks, middlewares, transports, commands }
```

## 2. 扩展能力总览

### 2.1 已有的扩展方式（Capability 间）

| 方式 | 说明 | 详见 |
|------|------|------|
| `extendSchema` | 给已有 Schema 加字段 | 03_schema.md |
| `overrideSchema` | 修改已有 Schema 字段属性 | 03_schema.md |
| `extendState` | 给状态机加状态/迁移 | 06_state.md |
| `overrideRule` | 修改已有 Rule | 05_rule.md |
| `disableRule` | 禁用已有 Rule | 05_rule.md |
| `overrideAction` | 修改已有 Action（before/after/replace） | 04_action.md |
| `extendView` | 给已有 View 加字段/列 | 13_view_and_ui.md |
| `overrideView` | 修改已有 View 布局 | 13_view_and_ui.md |
| `extendRole` | 给已有权限组加权限 | 10_actor_permission.md |

### 2.2 新增的框架级扩展

通过 Capability 的 `extensions` 字段注册：

```typescript
export default defineCapability({
  name: 'my_capability',
  version: '1.0.0',

  // ... 正常的 Schema, Action, Rule, View 定义 ...

  extensions: {
    fieldTypes: [...],
    viewTypes: [...],
    ruleEffects: [...],
    services: [...],
    hooks: [...],
    middlewares: [...],
    transports: [...],
    commands: [...],
  },
})
```

> 注：`transports` 扩展用于注册新的外部协议入口（如 MCP、A2A、AG-UI），详见 §8.5。`commands` 扩展用于注册 CLI 命令，详见 §8.6。

## 3. 自定义字段类型

Capability 可以注册新的 Schema 字段类型，安装后所有 Schema 可用。

```typescript
extensions: {
  fieldTypes: [
    {
      name: 'money',
      label: '金额',
      baseType: 'number',
      precision: 2,
      // 自动附带的额外字段
      additionalFields: {
        currency: { type: 'enum', options: ['CNY', 'USD', 'EUR'], default: 'CNY' },
      },
      // 前端渲染组件
      component: MoneyInput,
      // 显示格式化
      format: (value, currency) => `${currency} ${value.toFixed(2)}`,
    },
    {
      name: 'file',
      label: '文件',
      baseType: 'json',
      component: FileUpload,
      // 存储：{ id, name, size, type, url }
    },
    {
      name: 'address',
      label: '地址',
      baseType: 'json',
      component: AddressInput,
    },
  ],
}
```

使用：
```typescript
defineSchema({
  name: 'invoice',
  fields: {
    total: { type: 'money', label: '总金额' },           // 自动带 currency 字段
    attachment: { type: 'file', label: '附件' },          // 文件上传
    shipping_address: { type: 'address', label: '收货地址' },
  },
})
```

## 4. 自定义 View 类型

注册新的视图类型：

```typescript
extensions: {
  viewTypes: [
    {
      name: 'map',
      label: '地图视图',
      component: MapView,
      configSchema: {
        latField: { type: 'string', required: true },
        lngField: { type: 'string', required: true },
        titleField: { type: 'string' },
      },
    },
    {
      name: 'gantt',
      label: '甘特图',
      component: GanttView,
      configSchema: {
        startField: { type: 'string', required: true },
        endField: { type: 'string', required: true },
        groupField: { type: 'string' },
      },
    },
    {
      name: 'timeline',
      label: '时间线',
      component: TimelineView,
    },
  ],
}
```

使用：
```typescript
defineView({
  name: 'warehouse_map',
  schema: 'warehouse',
  type: 'map',    // 使用自定义视图类型
  config: {
    latField: 'latitude',
    lngField: 'longitude',
    titleField: 'name',
  },
})
```

## 5. 自定义 Rule Effect

扩展 Rule 可用的 effect 类型（默认有 block / warn / require_approval / enrich / execute_action）：

```typescript
extensions: {
  ruleEffects: [
    {
      name: 'send_sms',
      label: '发送短信',
      configSchema: {
        to: { type: 'string', required: true },      // 支持 $target.phone 变量
        template: { type: 'string', required: true },
      },
      handler: async (ctx, config) => {
        await ctx.execute('sms_service.send_sms', {
          phone: resolveVariable(config.to, ctx),
          template: config.template,
          data: ctx.target,
        })
      },
    },
  ],
}
```

使用：
```typescript
defineRule({
  name: 'notify_on_approve',
  trigger: { stateChange: { schema: 'purchase_request', to: 'approved' } },
  condition: null,  // 无条件触发
  effect: {
    type: 'send_sms',   // 自定义 effect
    to: '$target.requester.phone',
    template: 'purchase_approved',
  },
})
```

## 6. 服务提供者

Capability 可以注册服务，其他 Capability 可以注入使用：

```typescript
// 定义服务接口
interface StorageService {
  upload(file: Buffer, name: string): Promise<{ url: string }>
  delete(url: string): Promise<void>
  getSignedUrl(url: string, expiry?: number): Promise<string>
}

// 注册服务实现
extensions: {
  services: [
    {
      name: 'storage',
      interface: StorageService,
      // 实现在 Capability 内部
    },
  ],
}

// 其他 Capability 中使用
defineAction({
  name: 'upload_attachment',
  handler: async (ctx) => {
    const storage = ctx.service('storage')  // 注入服务
    const result = await storage.upload(ctx.input.file, ctx.input.name)
    // ...
  },
})
```

## 7. 生命周期钩子

```typescript
extensions: {
  hooks: [
    // 所有 Action 执行前
    { on: 'action.before', handler: async (ctx) => { ... } },

    // 所有 Action 执行后
    { on: 'action.after', handler: async (ctx) => { ... } },

    // Capability 安装时
    { on: 'capability.install', handler: async (ctx) => { ... } },

    // Capability 卸载时
    { on: 'capability.uninstall', handler: async (ctx) => { ... } },

    // 系统启动时
    { on: 'system.start', handler: async (ctx) => { ... } },

    // 版本发布时
    { on: 'version.release', handler: async (ctx) => { ... } },
  ],
}
```

## 8. 中间件与管道插槽

框架的 Command Layer 管道有预定义的插槽（slot），Capability 通过 middleware 填充。

### 8.1 预定义插槽

| slot | 用途 | 谁填充 |
|------|------|--------|
| `pre` | 前置处理（日志、限流） | 任何 Capability |
| `auth` | 认证 → ctx.actor | @linchkit/cap-auth（可替换） |
| `exposure` | 接口暴露检查 | 框架内置（不可替换） |
| `permission` | 权限检查 | @linchkit/cap-permission（可替换） |
| `tenant` | 租户识别 → ctx.tenantId | 多租户 Capability（可选） |
| `pre-action` | Action 执行前 | 任何 Capability |
| `post-action` | Action 执行后 | 任何 Capability |

未填充的 slot 自动跳过（如 cap-auth 未安装，auth slot 为空，所有请求匿名）。

### 8.2 注册中间件

```typescript
extensions: {
  middlewares: [
    // 填充框架预定义的 slot
    {
      name: 'jwt_auth',
      slot: 'auth',                    // 填充 auth 插槽
      handler: async (ctx, next) => {
        const token = ctx.headers.authorization?.replace('Bearer ', '')
        if (!token) throw new UnauthorizedError()
        ctx.actor = await verifyToken(token)
        return next()
      },
    },

    // 在通用 slot 中添加逻辑
    {
      name: 'rate_limiter',
      slot: 'pre',                     // 前置插槽
      order: 10,
      handler: async (ctx, next) => {
        if (await isRateLimited(ctx.actor)) throw new RateLimitError()
        return next()
      },
    },

    {
      name: 'request_logger',
      slot: 'pre',
      order: 1,                        // order 小的先执行
      handler: async (ctx, next) => {
        const start = Date.now()
        const result = await next()
        logger.info({ action: ctx.command, duration: Date.now() - start })
        return result
      },
    },
  ],
}
```

### 8.3 可替换性

同一个 slot 只能有一个"主"填充（如 auth slot 只有一个认证方案）。想换认证方式，换 Capability 即可：

```
JWT 认证 → @linchkit/cap-auth
OAuth → @linchkit/cap-auth-oauth
LDAP → @community/cap-auth-ldap
自定义 → 自己写 Capability，注册 auth slot
```

pre / pre-action / post-action 插槽可以有多个 middleware，按 order 排序执行。
```

### 8.5 传输适配器（Transport Adapter）

Capability 可以通过 `extensions.transports` 注册新的传输入口（transport），让外部系统通过新协议访问 CommandLayer。

传输适配器与中间件不同：中间件在 CommandLayer **内部**填充 slot，传输适配器在 CommandLayer **外部**接收请求并转发进入管道。

```typescript
extensions: {
  transports: [
    {
      name: 'mcp',
      label: 'Model Context Protocol',
      // Transport factory — receives runtime context, returns start/stop lifecycle
      factory: async (ctx) => {
        const server = createMcpServer({
          executor: ctx.executor,
          schemaRegistry: ctx.schemaRegistry,
          commandLayer: ctx.commandLayer,
        });
        return {
          start: () => server.listen(),
          stop: () => server.close(),
        };
      },
      // Optional: mount HTTP routes on the main server
      routes: (app) => {
        app.all('/mcp', mcpStreamableHttpHandler);
      },
      config: {
        // Transport-specific configuration schema
        bearerToken: { type: 'string', secret: true },
        enableStdio: { type: 'boolean', default: true },
        enableHttp: { type: 'boolean', default: true },
      },
    },
  ],
}
```

传输适配器的生命周期：
- 系统启动时，按注册顺序调用 `factory(ctx)` 创建实例
- 调用 `start()` 启动监听
- 系统关闭时调用 `stop()` 优雅退出
- 如果提供了 `routes`，自动挂载到主 HTTP Server

传输适配器与 CommandLayer 的关系：

```
CLI ──────────┐
cap-adapter-mcp ──────┤
cap-adapter-server ───┤──→ Command Layer ──→ Action Engine
cap-adapter-a2a ──────┤
cap-adapter-ag-ui ────┘
```

所有传输适配器共享同一个 CommandLayer 管道，认证、权限、日志等中间件自动生效。

**示例：最小化 MCP 适配器 Capability**

```typescript
export default defineCapability({
  name: 'cap-adapter-mcp',
  type: 'adapter',
  category: 'integration',
  version: '0.1.0',
  label: 'MCP Adapter',
  description: 'Expose LinchKit Actions as MCP Tools for AI agents',

  dependencies: [],
  systemPermissions: ['network.internal'],

  extensions: {
    transports: [
      {
        name: 'mcp',
        label: 'Model Context Protocol',
        factory: createMcpTransport,
        routes: mountMcpRoutes,
        config: {
          bearerToken: { type: 'string', secret: true },
        },
      },
    ],
  },
})
```

未来的协议适配器（如 A2A、AG-UI）遵循同样的模式，Core 无需修改。

### 8.6 CLI 命令注册

Capability 通过 `extensions.commands` 注册 CLI 命令。CLI 在启动时动态构建命令树。

#### 8.6.1 设计原则

1. **CLI 是 CommandLayer 的又一个入口** — 与 REST/GraphQL/MCP 并列，共享同一套中间件管道
2. **Capability-Centric** — 所有非内置命令由 Capability 注册，CLI 只是极简引导器
3. **双模输出** — 人类友好（默认）和机器友好（`--json`），所有命令必须同时支持
4. **AI Agent 一等公民** — CLI 输出对 AI Agent 友好（结构化、扁平、可过滤）

```
CLI ──────────┐
MCP ──────────┤
REST/GraphQL ─┤──→ Command Layer ──→ Action Engine
A2A ──────────┤
AG-UI ────────┘
```

#### 8.6.2 CommandExtension 类型

```typescript
interface CommandExtension {
  /** Subcommand name, e.g. 'login' */
  name: string;
  /** Namespace → linch <namespace> <name>, e.g. 'auth' → linch auth login */
  namespace: string;
  /** One-line description for help text (English) */
  description: string;
  /** Lazy-loaded handler — citty uses dynamic import for fast startup */
  handler: () => Promise<CittyCommandDef>;
  /** Positional arguments and flags (forwarded to citty defineCommand) */
  args?: Record<string, ArgDef>;
  /** Usage examples shown in --help and used by AI for discovery */
  examples?: string[];
  /** If true, `linch <namespace>` without subcommand runs this handler */
  isDefault?: boolean;
  /** Hidden in production mode (only visible with NODE_ENV=development) */
  devOnly?: boolean;
  /** Marks commands that use interactive prompts (AI agents skip these) */
  interactive?: boolean;
}

interface ArgDef {
  type: "string" | "boolean" | "positional";
  description: string;
  required?: boolean;
  default?: string;
  alias?: string;  // short flag, e.g. '-p'
}
```

#### 8.6.3 命令注册示例

```typescript
// cap-auth capability
extensions: {
  commands: [
    {
      name: 'login',
      namespace: 'auth',               // → linch auth login
      description: 'Authenticate with a LinchKit instance',
      handler: () => import('./cli/login'),
      args: {
        url: { type: 'string', description: 'Instance URL', required: true },
        token: { type: 'string', description: 'API token (non-interactive)' },
      },
      examples: [
        'linch auth login https://app.example.com',
        'linch auth login https://app.example.com --token $LINCHKIT_TOKEN',
      ],
      isDefault: true,
      interactive: true,
    },
    {
      name: 'logout',
      namespace: 'auth',
      description: 'Remove stored credentials',
      handler: () => import('./cli/logout'),
    },
    {
      name: 'status',
      namespace: 'auth',
      description: 'Show current authentication state',
      handler: () => import('./cli/status'),
    },
  ],
}
```

#### 8.6.4 命名空间规则

| Capability type | namespace convention | Example commands |
|---|---|---|
| adapter (transport) | Protocol name | `linch server dev`, `linch mcp inspect` |
| infrastructure | Feature name | `linch auth login`, `linch flow list` |
| utility / devtool | Tool name | `linch migration run`, `linch docs build` |
| business | Domain name (optional) | `linch purchase import` |

Constraints:
- One namespace per capability — no cross-capability namespace sharing
- Namespace collision: first installed wins, later registrations emit a warning
- Reserved namespaces (built-in): `init`, `dev`, `db`, `create`, `install`, `uninstall`, `search`, `update`, `publish`, `info`, `validate`, `check`, `docs`, `changelog`

#### 8.6.5 命令发现与命令树构建

CLI startup flow:

```
linch <args>
  │
  ├─ Built-in commands (statically imported, no config needed)
  │   init, create, install, uninstall, search, update,
  │   publish, info, validate, check, docs, changelog
  │
  └─ Capability commands (require linchkit.config.ts)
      │
      loadConfig()
        → collectCapabilities()
          → collectCommands()    // extract extensions.commands from all capabilities
            → buildCommandTree() // merge into citty subCommands with lazy loading
```

```typescript
// Pseudo-code for buildCommandTree
function buildCommandTree(
  builtinCommands: Record<string, CittyCommand>,
  capabilityCommands: CommandExtension[],
): Record<string, CittyCommand> {
  const tree = { ...builtinCommands };
  const byNamespace = groupBy(capabilityCommands, c => c.namespace);

  for (const [ns, commands] of Object.entries(byNamespace)) {
    if (ns in tree) {
      console.warn(`[linch] Namespace "${ns}" is reserved, skipping capability commands`);
      continue;
    }
    tree[ns] = defineCommand({
      meta: { name: ns },
      subCommands: Object.fromEntries(
        commands.map(cmd => [cmd.name, cmd.handler])  // lazy: () => import(...)
      ),
    });
  }
  return tree;
}
```

Citty natively supports `Resolvable<T>` (functions, Promises, async functions) as subcommand values, enabling lazy loading without framework changes.

#### 8.6.6 统一输出协议

All commands (built-in and capability-registered) must follow these output conventions:

**Global flags** (injected by CLI framework, not by individual commands):

| Flag | Behavior |
|---|---|
| `--json` | Output structured JSON to stdout. Errors also as JSON to stderr. |
| `--quiet` | Suppress all non-essential output. Only print the primary result. |
| `--no-interactive` | Disable all interactive prompts. Fail if required input is missing. Auto-enabled when `CI=true` or stdout is not a TTY. |
| `--no-color` | Disable ANSI color codes. Auto-enabled when `NO_COLOR=1`. |

**JSON output contract:**

```typescript
// Success
{ "ok": true, "data": <command-specific payload> }

// Error
{ "ok": false, "error": { "code": string, "message": string, "details"?: unknown } }
```

- JSON output is a stable API contract — breaking changes require semver major bump.
- Keep payloads flat when possible (avoid deep nesting to save tokens for AI agents).
- Lists output as arrays, not wrapped objects (e.g. `{ "ok": true, "data": [...] }`).

**Error messages** (human mode) must include: what failed, why, and suggested next step.

```
✗ Authentication failed: token expired

  Run `linch auth login https://app.example.com` to re-authenticate.
```

**Help text** requirements:
- Every command must have `description` and at least one `example`.
- `linch --help` lists all commands including capability-registered ones, grouped by namespace.
- `linch <namespace> --help` lists subcommands within that namespace.
- `linch <namespace> <command> --help` shows args, flags, examples for that command.

#### 8.6.7 CLI 认证

Commands that interact with a running LinchKit instance need authentication context. The CLI credential chain (highest to lowest priority):

```
1. --token <value> flag          (one-off override)
2. LINCHKIT_TOKEN env var        (CI/CD pipelines)
3. ~/.linchkit/credentials.json  (persistent login via `linch auth login`)
```

**Credential storage** (`~/.linchkit/credentials.json`):

```json
{
  "profiles": {
    "default": {
      "url": "https://app.example.com",
      "token": "lk_...",
      "expires_at": "2026-05-01T00:00:00Z",
      "actor": "admin@example.com"
    },
    "staging": {
      "url": "https://staging.example.com",
      "token": "lk_...",
      "expires_at": "2026-05-01T00:00:00Z",
      "actor": "dev@example.com"
    }
  },
  "active_profile": "default"
}
```

- File permissions: `0600` (owner read/write only).
- Future: OS keychain integration (macOS Keychain, Linux Secret Service) for token storage.
- `--profile <name>` flag to switch between stored profiles.
- `linch auth login` performs interactive OAuth or token exchange, stores result.
- `linch auth status` shows current profile, token validity, actor info.
- `linch auth logout` removes stored credentials.
- `linch auth switch <profile>` changes active profile.

Commands that need auth receive the resolved actor context via `CommandContext` — same mechanism as REST/GraphQL auth middleware.

#### 8.6.8 AI Agent 模式

CLI is designed as a first-class interface for AI agents (Claude Code, Cursor, Codex, etc.).

**Agent-friendly conventions:**
- `--json` output with flat structure — minimizes token consumption
- `--no-interactive` auto-detected when stdin is not a TTY
- Commands marked `interactive: true` print a warning and exit in non-interactive mode unless all required args are provided via flags
- Error output includes machine-parseable error codes

**Introspection** (`linch --commands`):

Returns a structured JSON manifest of all available commands, suitable for AI agent self-discovery:

```bash
linch --commands
```

```json
{
  "version": "0.0.1",
  "commands": {
    "auth": {
      "description": "Authentication management",
      "subcommands": {
        "login": {
          "description": "Authenticate with a LinchKit instance",
          "args": { "url": { "type": "string", "required": true } },
          "flags": { "token": { "type": "string" }, "profile": { "type": "string" } },
          "examples": ["linch auth login https://app.example.com --token $TOKEN"],
          "interactive": true
        }
      }
    },
    "schema": {
      "description": "Schema operations",
      "subcommands": {
        "list": { "description": "List all schemas", "examples": ["linch schema list --json"] },
        "describe": { "description": "Describe a schema", "args": { "name": { "type": "positional" } } }
      }
    }
  }
}
```

AI agents use `linch --commands` once to understand available operations, then call specific commands with `--json` output.

**Relationship with MCP:**
- MCP tools and CLI commands share the same CommandLayer backend.
- CLI is lighter (no persistent tool definitions in context, no protocol overhead).
- MCP is better for stateful, session-based AI interactions.
- Both are valid entry points; neither replaces the other.

#### 8.6.9 内置命令

Not registered via capabilities — statically defined in `@linchkit/cli`:

| Command | Purpose | Needs config? |
|---|---|---|
| `linch init [name]` | Scaffold new LinchKit project | No |
| `linch dev` | Start all transports in development mode | Yes |
| `linch db <sub>` | Database management (generate, migrate, push, studio) | Yes |
| `linch create <type>` | Scaffold new capability | No |
| `linch install <pkg>` | Install capability package | No |
| `linch uninstall <pkg>` | Remove capability package | No |
| `linch search [query]` | Search installed capabilities | No |
| `linch update [pkg]` | Update capability dependencies | No |
| `linch publish` | Validate and publish capability | No |
| `linch info` | Show project metadata | Yes |
| `linch validate` | Run comprehensive validation | Yes |
| `linch check` | Run code quality checks | No |
| `linch docs` | Generate documentation | Yes |
| `linch changelog` | Generate changelog | No |
| `linch exec <action>` | Execute an action directly from CLI | Yes |

**`linch dev` and `linch exec`** are the bridge between CLI and CommandLayer — they load config, build the full runtime context, and dispatch through the middleware pipeline.

#### 8.6.10 Capability 命令规划

Expected CLI commands from existing and planned capabilities:

| Capability | Namespace | Commands | Priority |
|---|---|---|---|
| cap-auth | `auth` | `login`, `logout`, `status`, `switch` | High — prerequisite for remote operations |
| cap-adapter-mcp | `mcp` | `inspect`, `test`, `clients` | Medium — debugging / AI integration |
| cap-flow-restate | `flow` | `list`, `trigger`, `status`, `cancel` | Medium — operational management |
| cap-migration | `migration` | `run`, `rollback`, `status`, `generate` | High — data lifecycle |
| cap-adapter-server | `server` | `start`, `status`, `routes` | Low — mostly via `linch dev` |
| future: cap-deploy | `deploy` | `push`, `status`, `rollback`, `env` | Future — remote instance management |

Each capability defines its own commands in its own `extensions.commands`. This table is a guideline, not prescriptive.

## 9. 示例：文件存储 Capability

完整示例，展示一个 Capability 如何同时提供业务能力和框架扩展：

```typescript
export default defineCapability({
  name: 'file_storage',
  version: '1.0.0',
  label: '文件存储',

  // --- 业务能力 ---
  // Schema: file_record
  // Action: upload_file, delete_file, get_download_url
  // View: file_list, file_detail

  // --- 框架扩展 ---
  extensions: {
    // 安装后所有 Schema 可以用 type: 'file'
    fieldTypes: [
      {
        name: 'file',
        baseType: 'json',
        component: FileUpload,
      },
    ],

    // 注册存储服务
    services: [
      { name: 'storage', interface: StorageServiceInterface },
    ],
  },
})
```

安装效果：
- 有了文件管理界面（View）
- 有了上传/删除/下载 Action
- 所有 Schema 可以用 `{ type: 'file' }` 字段
- 其他 Action 可以通过 `ctx.service('storage')` 使用存储服务

## 10. 与 Bridge 的关系

Bridge 是 Capability 间的连接器，extensions 是框架级扩展。两者独立：

- Bridge 不需要 extensions（只是连接两个 Capability）
- 有 extensions 的 Capability 不一定是 Bridge（如 file_storage 是 standard）
- 两者可以组合（Bridge 也可以带 extensions）

## 11. 扩展的安装与卸载

- 安装 Capability 时自动注册其 extensions
- 卸载时自动注销
- 如果其他 Capability 正在使用某个 extension（如 `type: 'file'`），不允许卸载
- Validation 检查扩展依赖
