# 错误处理与分类规范

> HTTP 状态码映射策略和统一响应格式见 [16_command_layer_and_api](16_command_layer_and_api.md) §2.3–2.5。

## 1. 定位

框架级统一错误模型。Action 执行流程、Rule 评估、权限校验、GraphQL 查询——每一层都会产生错误，必须有统一的分类、错误码和前端展示策略。

## 2. 错误分类

### 7 类框架级错误

| 类别 | 说明 | HTTP 状态码 | 前端展示 |
|------|------|-----------|---------|
| `ValidationError` | 输入不合法（字段类型错误、必填缺失、格式不符） | 400 | 字段级标红 + 错误提示 |
| `NotFoundError` | 目标不存在（Action / 记录 / Schema 不存在） | 404 | 提示"目标不存在"或 404 页面 |
| `AuthenticationError` | 未登录（token 缺失 / 过期 / 无效） | 401 | 跳转登录页 |
| `AuthorizationError` | 已认证但无权限（无 Action 权限、数据权限拒绝） | 403 | 提示"权限不足" |
| `BusinessRuleError` | Rule 拦截（block / require_approval） | 422 | Toast 显示 Rule message，多条合并展示 |
| `ConflictError` | 并发冲突（乐观锁版本不匹配、状态机非法迁移） | 409 | 提示"数据已被修改，请刷新后重试" |
| `SystemError` | 基础设施故障（数据库连接失败、Outbox 异常等） | 500 | 通用错误页，不暴露内部细节 |

**关键区分**：401（Authentication）= "你是谁？"；403（Authorization）= "我知道你是谁，但你没权限"。

### 错误继承关系

```
LinchKitError (基类)
  ├── ValidationError
  │     ├── FieldValidationError     — 单字段校验失败
  │     └── InputValidationError     — 整体输入校验失败
  ├── NotFoundError                  — Action / 记录 / 资源不存在
  ├── AuthenticationError            — 未登录 / token 过期（401）
  ├── AuthorizationError             — 有身份但无权限（403）
  ├── BusinessRuleError
  │     ├── RuleBlockError           — Rule block
  │     └── ApprovalRequiredError    — require_approval
  ├── ConflictError
  │     ├── OptimisticLockError      — 乐观锁冲突
  │     └── StateTransitionError     — 状态机非法迁移
  └── SystemError
```

## 3. 错误码规范

格式：`DOMAIN.CATEGORY.SPECIFIC`

| 错误码示例 | 错误类型 | HTTP | 含义 |
|-----------|---------|------|------|
| `ACTION.VALIDATION.FIELD_REQUIRED` | validation | 400 | Action 输入缺少必填字段 |
| `ACTION.VALIDATION.FIELD_TYPE` | validation | 400 | Action 输入字段类型错误 |
| `ACTION.VALIDATION.FIELD_FORMAT` | validation | 400 | 格式不符（如 email 格式） |
| `ACTION.NOT_FOUND.ACTION` | not_found | 404 | Action 不存在 |
| `RECORD.NOT_FOUND.{schema}` | not_found | 404 | 记录不存在 |
| `AUTH.AUTHENTICATION.TOKEN_EXPIRED` | authentication | 401 | Token 过期 |
| `AUTH.AUTHENTICATION.TOKEN_INVALID` | authentication | 401 | Token 无效 |
| `AUTH.AUTHENTICATION.INVALID_CREDENTIALS` | authentication | 401 | 用户名密码错误 |
| `AUTH.PERMISSION.ACTION_DENIED` | authorization | 403 | 无权执行此 Action |
| `AUTH.PERMISSION.DATA_DENIED` | authorization | 403 | 无权访问此条数据 |
| `RULE.BLOCK.{rule_name}` | business_rule | 422 | 被某条 Rule 拦截 |
| `RULE.APPROVAL_REQUIRED.{rule_name}` | business_rule | 422 | 需要审批 |
| `STATE.TRANSITION.INVALID` | conflict | 409 | 当前状态不允许此迁移 |
| `STATE.TRANSITION.CONFLICT` | conflict | 409 | 乐观锁冲突 |
| `SYSTEM.DATABASE.CONNECTION` | system | 500 | 数据库连接失败 |
| `SYSTEM.OUTBOX.HANDLER_FAILED` | system | 500 | EventHandler 执行失败 |

错误码在框架内唯一，可用于：前端差异化展示、i18n 错误消息映射、日志检索、监控告警。

## 4. 统一错误结构

此结构与 [16_command_layer_and_api](16_command_layer_and_api.md) §2.3 的 `CommandResponse.error` 对齐。

```typescript
interface LinchKitErrorResponse {
  success: false
  error: {
    code: string                    // 错误码，如 'ACTION.VALIDATION.FIELD_REQUIRED'
    type: 'validation' | 'not_found' | 'authentication' | 'authorization' | 'business_rule' | 'conflict' | 'system'
    message: string                 // 人类可读消息
    details?: object                // 额外信息

    // ValidationError 专用
    fields?: Record<string, {       // 字段级错误
      code: string
      message: string
    }>

    // BusinessRuleError 专用
    rules?: Array<{                 // 多 Rule 合并
      rule: string                  // Rule 名称
      message: string
      effect: string                // block / require_approval
    }>

    // ApprovalRequiredError 专用
    approvalId?: string             // 审批请求 ID

    // ConflictError 专用
    currentVersion?: number         // 当前版本号（乐观锁）
    currentState?: string           // 当前状态（状态机冲突）
  }
}
```

## 5. 多 Rule 错误聚合

同一次 Action 可能被多条 Rule block。聚合策略：

- 收集所有 block 的 Rule，合并到 `rules` 数组
- 所有 block message 合并展示（不只返回第一条）
- 如果同时有 block 和 require_approval，block 优先（Action 直接失败，不进审批）
- 如果只有 warn，不算错误，warn 信息通过 `warnings` 字段返回

## 6. GraphQL 错误映射

GraphQL 错误使用 `extensions` 字段携带框架错误信息：

```json
{
  "errors": [{
    "message": "采购金额超过10000需要总监审批",
    "extensions": {
      "code": "RULE.APPROVAL_REQUIRED.amount_check",
      "type": "BusinessRuleError",
      "approvalId": "apr_001"
    }
  }]
}
```

## 7. 错误消息 i18n

错误码自动映射到翻译 key：

```
ACTION.VALIDATION.FIELD_REQUIRED → t:error.action.validation.field_required
RULE.BLOCK.amount_check → t:error.rule.block.amount_check
```

翻译文件中可按错误码提供多语言消息，未配置则 fallback 到 Rule/Action 定义中的 message。

## 8. 日志中的错误记录

- `ValidationError` → 日志级别 `warn`（预期内的输入拦截）
- `NotFoundError` → 日志级别 `warn`（可能是前端传了无效 ID）
- `AuthenticationError` → 日志级别 `warn`（可能是 token 过期）
- `AuthorizationError` → 日志级别 `warn`（可能是权限配置问题）
- `BusinessRuleError` → 日志级别 `info`（Rule 正常工作）
- `ConflictError` → 日志级别 `warn`（需要关注频率）
- `SystemError` → 日志级别 `error`（需要立即处理）
- 敏感字段（password、token）在错误详情中自动脱敏
