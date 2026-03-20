# 扩展机制设计规范

## 1. 核心原则

**没有 Plugin 概念，所有东西都是 Capability。** 部分 Capability 可以额外提供框架级扩展能力。

```
Capability
  ├── 业务能力：Schema, Action, Rule, State, Event, EventHandler, View, Flow, Navigation
  └── 框架扩展（可选）：extensions { fieldTypes, viewTypes, ruleEffects, services, hooks, middlewares }
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
  },
})
```

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
