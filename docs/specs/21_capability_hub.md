# Capability Hub 设计规范

## 1. 定位

Capability Hub 是 LinchKit 的能力市场，用于发布、分享、安装可复用的 Capability。类似 npm 之于 Node.js。

## 2. 基本操作

```bash
# 安装
linch install @linchkit/capability-sms-service
linch install @community/capability-crm

# 发布
linch publish

# 更新
linch update @linchkit/capability-sms-service

# 搜索
linch search "库存管理"

# 查看信息
linch info @linchkit/capability-sms-service
```

## 3. Hub 上的 Capability 分类

| 类型 | 发布者 | 示例 |
|------|--------|------|
| 官方系统级 | LinchKit 团队 | auth, permission, notification, audit, proposal |
| 官方工具级 | LinchKit 团队 | file_storage, sms_service, email_service |
| 社区业务级 | 社区 | 采购管理, 库存管理, HR, CRM, 项目管理 |
| 社区扩展级 | 社区 | 地图 View, 甘特图, 支付网关, OCR 识别 |

## 4. 发布要求

Capability 发布到 Hub 需满足：

- `capability.ts` 完整（name, version, description, dependencies）
- 通过 `validateCapability` 结构验证
- 有基本的测试
- 有 README 说明
- 语义版本号（semver）

## 5. 依赖管理

```typescript
// capability.ts
export default defineCapability({
  name: 'purchase_management',
  version: '1.0.0',

  dependencies: [
    { capability: '@linchkit/capability-auth', version: '^1.0.0' },
    { capability: 'employee_management', version: '>=1.0.0' },
  ],
})
```

安装时自动解析依赖树，处理版本冲突。

## 6. 与里程碑的关系

- M0-M2：手动安装（复制 Capability 目录）
- M3：基础 Hub（发布 / 安装 / 版本管理）
- M4：完整市场（搜索 / 评分 / 文档 / 社区）
