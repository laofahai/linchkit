# AI 服务层设计规范

## 1. 定位

LinchKit 需要调用 AI 的场景：
- Flow 的 `type: 'ai'` 步骤
- Evolution System（AI 分析运行数据、建议优化）
- LinchKit Review Bot（AI 审查代码）
- AI 辅助生成 Proposal
- Action handler 中的 AI 辅助判断（如工单分类、内容审核）

框架提供统一的 AI 服务层，集中管理 provider、API Key、模型选择、用量控制。

## 2. 配置

```typescript
// linchkit.config.ts
export default defineConfig({
  ai: {
    defaultProvider: 'anthropic',

    providers: {
      anthropic: {
        apiKey: '$env.ANTHROPIC_API_KEY',
        defaultModel: 'claude-sonnet-4-20250514',
        models: {
          fast: 'claude-haiku-4-5-20251001',
          standard: 'claude-sonnet-4-20250514',
          advanced: 'claude-opus-4-20250514',
        },
      },
      openai: {
        apiKey: '$env.OPENAI_API_KEY',
        defaultModel: 'gpt-4o',
        models: {
          fast: 'gpt-4o-mini',
          standard: 'gpt-4o',
          advanced: 'o3',
        },
      },
      // 自定义 provider（本地模型、其他 API 兼容服务）
      local: {
        endpoint: 'http://localhost:11434/v1',
        apiKey: '',
        defaultModel: 'llama3',
        models: {
          fast: 'llama3',
          standard: 'llama3',
        },
      },
    },

    // 全局限制
    limits: {
      maxTokensPerRequest: 8192,
      maxRequestsPerMinute: 60,
      maxCostPerDay: 10.00,            // USD，防止意外跑飞
    },
  },
})
```

### 模型别名

使用别名（`fast` / `standard` / `advanced`）而不是写死模型 ID：
- 升级模型只改配置，不改代码
- 不同 provider 映射到相同别名
- Capability 代码不依赖具体模型

## 3. 在 Action handler 中使用

通过 `ctx.ai` 调用，不直接 import SDK：

```typescript
defineAction({
  name: 'ai_classify_ticket',
  handler: async (ctx) => {
    const result = await ctx.ai.complete({
      model: 'fast',
      messages: [
        { role: 'system', content: '你是一个工单分类器，返回 JSON...' },
        { role: 'user', content: ctx.input.description },
      ],
      responseFormat: {
        type: 'json',
        schema: z.object({
          category: z.enum(['bug', 'feature', 'question']),
          priority: z.enum(['low', 'medium', 'high']),
        }),
      },
    })

    await ctx.update('ticket', ctx.input.id, {
      category: result.category,
      priority: result.priority,
    })
  },
})
```

### ctx.ai 接口

```typescript
interface AiService {
  // 单次完成
  complete(options: AiCompleteOptions): Promise<AiResponse>

  // 流式输出
  stream(options: AiCompleteOptions): AsyncIterable<AiChunk>
}

interface AiCompleteOptions {
  provider?: string              // 默认用 defaultProvider
  model?: string                 // 别名（fast/standard/advanced）或完整模型 ID
  messages: AiMessage[]
  temperature?: number           // 默认 0
  maxTokens?: number             // 默认从全局配置
  responseFormat?: {
    type: 'text' | 'json'
    schema?: ZodSchema           // json 模式下用 Zod 校验和类型推导
  }
  timeout?: number               // ms
}

interface AiMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

interface AiResponse {
  content: string                // text 模式
  data?: any                     // json 模式（已解析 + Zod 校验）
  usage: {
    inputTokens: number
    outputTokens: number
    cost?: number                // 估算成本（USD）
  }
  model: string                  // 实际使用的模型 ID
  provider: string
  duration: number               // ms
}
```

## 4. 在 Flow 中使用

```typescript
defineFlow({
  name: 'ai_evolution_analysis',
  trigger: { schedule: '0 2 * * 1' },

  steps: [
    {
      name: 'collect',
      type: 'action',
      action: 'collect_execution_stats',
    },
    {
      name: 'analyze',
      type: 'ai',
      model: 'standard',
      prompt: '分析以下系统执行数据，发现异常模式和优化机会...',
      input: '$steps.collect.output',
      timeout: '5m',
      maxTokens: 4096,
    },
    {
      name: 'generate',
      type: 'ai',
      model: 'advanced',
      prompt: '根据分析结果，生成具体的 Rule/Schema 变更建议...',
      input: '$steps.analyze.output',
      responseFormat: { type: 'json' },
    },
  ],
})
```

## 5. 框架统一管理的好处

| 好处 | 说明 |
|------|------|
| API Key 集中配置 | 不散落在代码中，环境变量统一管理 |
| 用量统计 | 所有 AI 调用记录到 Execution Log（tokens、成本、耗时） |
| 成本控制 | 每日/每月成本上限，超限自动阻止 |
| 速率限制 | 防止意外循环调用导致跑飞 |
| 模型别名 | 升级模型只改配置，代码不动 |
| Provider 可切换 | Claude → GPT → 本地模型，只改配置 |
| 租户级配置 | SaaS 模式下不同租户不同 provider / 额度 / 模型 |
| 审计 | 所有 AI 调用的 prompt 和 response 可记录（按需） |

## 6. 租户级 AI 配置（SaaS 模式）

```typescript
// tenant_overrides 或 tenants/tenant_a/config.ts
defineTenantConfig({
  tenant: 'tenant_a',
  ai: {
    // 租户 A 自带 API Key（BYOK - Bring Your Own Key）
    providers: {
      anthropic: { apiKey: '$tenant.ANTHROPIC_API_KEY' },
    },
    limits: {
      maxRequestsPerMinute: 30,
      maxCostPerDay: 5.00,
    },
  },
})
```

## 7. 安全

- API Key 通过环境变量注入，不存代码
- AI 调用受 Action 的 `limits.maxExecutionTime` 约束
- AI 返回的 JSON 通过 Zod schema 校验（防止注入/格式错误）
- AI 调用日志可选记录 prompt/response（敏感场景可关闭）
- 租户的 AI 调用隔离（BYOK 模式下互不影响）

## 8. 底层实现：Vercel AI SDK

**不自己造轮子，基于 Vercel AI SDK（`ai` 包）封装。**

Vercel AI SDK 提供：
- 统一的多 provider 接口（Anthropic / OpenAI / Google / 本地模型）
- `generateText()` — 文本生成
- `generateObject()` — 结构化输出（JSON + Zod 校验，直接复用我们的 Zod schema）
- `streamText()` / `streamObject()` — 流式输出
- Tool calling / Function calling — 统一协议
- Token 用量统计

LinchKit 的 `ctx.ai` 是对 Vercel AI SDK 的薄封装，只额外做：
1. **模型别名解析** — fast/standard/advanced → 具体 provider + model ID
2. **用量统计 + 成本控制** — 记录每次调用的 tokens 和估算成本
3. **租户级配置** — SaaS 模式下按 tenant 选择 API Key / provider
4. **集成到 ActionContext** — `ctx.ai.complete()` / `ctx.ai.stream()`
5. **Execution Log 记录** — AI 调用纳入审计

### Tool Calling

Capability 可以把 Action 暴露为 AI 的 tool：

```typescript
// 在 Flow 的 AI 步骤中，自动把相关 Action 注册为 tools
defineFlow({
  steps: [
    {
      name: 'ai_agent',
      type: 'ai',
      model: 'advanced',
      prompt: '根据用户需求，执行相应操作...',
      // 允许 AI 调用的 Action（作为 tools）
      tools: ['create_request', 'query_inventory', 'send_notification'],
      // 框架自动把这些 Action 转换为 Vercel AI SDK 的 tool 格式
      maxToolCalls: 10,
    },
  ],
})
```

框架自动将 Action 的 input schema（Zod）转换为 tool 的 parameters，Action 的 description 作为 tool 的 description。AI 调用 tool 时，框架执行对应的 Action（走完整的 Rule/State/Event 链路）。

### 技术栈

| 层面 | 方案 |
|------|------|
| 核心 | `ai`（Vercel AI SDK） |
| Anthropic | `@ai-sdk/anthropic` |
| OpenAI | `@ai-sdk/openai` |
| Google | `@ai-sdk/google` |
| 本地/自定义 | `@ai-sdk/openai-compatible`（兼容 OpenAI API 的任何服务） |

## 9. 不直接 import SDK 的原因

```typescript
// ❌ 不要这样
import Anthropic from '@anthropic-ai/sdk'
const client = new Anthropic({ apiKey: '...' })

// ✅ 通过 ctx.ai
const result = await ctx.ai.complete({ model: 'fast', messages: [...] })
```

直接 import SDK：
- API Key 散落各处
- 无法统一计量和限制
- 换 provider 要改代码
- 无法做租户级隔离
- Execution Log 里没有 AI 调用记录

通过 ctx.ai：
- 框架统一控制一切
- Capability 代码干净，只关心 prompt 和 response

## 9. 与里程碑的关系

### M0
- 不涉及 AI 调用

### M1
- AI 配置结构（linchkit.config.ts 中的 ai 字段）
- ctx.ai.complete 基础实现
- LinchKit Review Bot 使用 AI

### M2
- Flow 的 type: 'ai' 步骤
- AI 辅助生成 Proposal
- 租户级 AI 配置（BYOK）
- 用量统计 + 成本控制

### M3
- Evolution System（AI 分析 + 自动 Proposal）
- 流式输出
- 高级 prompt 管理
