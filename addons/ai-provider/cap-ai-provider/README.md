# @linchkit/cap-ai-provider

AI provider capability for LinchKit — Vercel AI SDK-based implementations with Anthropic (Claude) and OpenAI support. Provides cost estimation, response caching, fallback chains, and model routing.

## Installation

```bash
bun add @linchkit/cap-ai-provider
```

## Peer Dependencies

- `@linchkit/core` ^0.1.0

## Usage

### Create AI Service

```ts
import { createAIService } from "@linchkit/cap-ai-provider";

const ai = createAIService({
  providers: {
    anthropic: { apiKey: process.env.ANTHROPIC_API_KEY! },
    openai: { apiKey: process.env.OPENAI_API_KEY! },
  },
  defaultModel: "anthropic:claude-sonnet-4-20250514",
});
```

### Cost Estimation

```ts
import { CostEstimator } from "@linchkit/cap-ai-provider";

const estimator = new CostEstimator();
const cost = estimator.estimate({ model: "claude-sonnet-4-20250514", inputTokens: 1000, outputTokens: 500 });
```

### Response Caching

```ts
import { AIResponseCache } from "@linchkit/cap-ai-provider";

const cache = new AIResponseCache();
```

## Links

- [Repository](https://github.com/laofahai/linchkit)
