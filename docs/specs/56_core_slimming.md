# Core 包瘦身计划

> Status: Draft | Date: 2026-03-27
> 里程碑: M3
> 审查来源: Claude Code, Codex GPT-5.4, 原审计（三方独立审查）
>
> Tracking milestones:
> - `M5: Platform Maturity & AI Evolution`
>
> Related issues:
> - GitHub Issue `#77` — Core slimming: move implementations to capabilities
>
> Execution source of truth: GitHub milestones and issues.

## 1. 背景与动机

当前 `@linchkit/core` 包含 **160+ 文件**，已偏离 CLAUDE.md 中明确的 **Minimal Core** 原则：

> Core provides only engines + types + pipeline. All concrete implementations (auth, MCP, permissions) are Capabilities.

经过三方独立审查（Claude Code、Codex GPT-5.4、原审计），达成以下共识：

1. 大量工具类、文档生成、迁移逻辑不属于 core 的职责范围
2. 部分引擎的**具体实现**（如 Restate 适配、AI provider SDK）应该移出，但**接口和抽象**必须保留
3. 生命系统（Spec 55）的引擎和抽象是 AI-Native 的核心价值，不能移出

**目标**：在保持 AI-Native 愿景的同时，将 core 精简到只包含引擎 + 类型 + 管道 + 生命系统抽象。

## 2. 指导原则

### "Minimal Core" 不等于 "只剩 CRUD"

Core 必须保留生命系统的引擎和抽象。一个零 capability 安装的 LinchKit 应该是一个「会自我记录、会自我描述、能安全提案」的 kernel，而不是一个哑 CRUD 框架。

### 三层分类模式

| 层级 | 定义 | 示例 |
|------|------|------|
| **CORE** | 引擎 + 类型 + 管道 + 生命系统抽象 | ActionEngine, AutomationEngine, FlowRegistry, AIBoundary |
| **CORE 接口 + CAPABILITY 实现** | 核心定义抽象接口，capability 提供具体实现 | `FlowEngine` 接口留 core，`RestateFlowEngine` 实现移到 `cap-flow-restate` |
| **PURE CAPABILITY** | 纯工具类，与 core 无耦合，可安全移出 | APIDocGenerator, DataImporter, CodeQuality |

判定标准：
- 如果移除后系统无法启动或核心行为改变 → **CORE**
- 如果移除后仅缺少某种具体实现，可由 capability 补回 → **CORE 接口 + CAPABILITY 实现**
- 如果移除后系统完全不受影响 → **PURE CAPABILITY**

## 3. 移出计划

### Phase 1: 安全移出（三方一致同意）

这些文件与 core 的引擎/管道无耦合，可直接移出：

| 目标 capability | 移出文件 | 来源目录 | 文件数 |
|----------------|---------|---------|--------|
| `@linchkit/devtools` | APIDocGenerator, CapabilityDocGenerator, OpenAPIGenerator, MarkdownRenderer, DocSearch | `core/src/documentation/` | 5 |
| `@linchkit/devtools` | CodeQuality, ConventionChecker, ProjectStructure | `core/src/methodology/` | 3–4 |
| `@linchkit/devtools` | SpecTracker, ChangelogGenerator, DocValidator | `core/src/governance/` | 3 |
| `cap-migration` (新建) | DataImporter, SchemaMapper, MigrationRunner | `core/src/migration/` | 3 |
| `cap-flow-restate` | RestateFlowEngine, restate-client | `core/src/flow/` | 2 |
| `cap-ai-provider` (新建) | `createAIService` 中的 Vercel AI SDK 具体实现 | `core/src/ai/ai-service.ts` | ~1 (partial) |

**总计: ~17 个文件**

Phase 1 的迁移不需要先补充任何抽象，直接按文件级别搬迁即可。

### Phase 2: 接口留核心 + 实现移出（需先补抽象）

Phase 2 的核心思路来自 Codex 的关键建议：在移出 detector/automation 实现之前，先在 core 中补充生命系统抽象接口。

**Step 2a — 补充生命系统抽象（在 core 中新增）**

对应 Spec 55 的五层架构，在 core 中增加：

```typescript
// Sense 层
interface Sensor<TSignal = unknown> {
  name: string
  schema?: string
  detect(context: SensorContext): Promise<TSignal | null>
}

interface Signal {
  type: string
  source: string
  timestamp: Date
  payload: unknown
}

// Memory 层
interface Baseline {
  schema: string
  metric: string
  value: number
  calculatedAt: Date
}

interface MemoryStore {
  recordSignal(signal: Signal): Promise<void>
  getBaseline(schema: string, metric: string): Promise<Baseline | null>
  updateBaseline(baseline: Baseline): Promise<void>
}
```

同时增加 `extensions.sensors` 扩展槽位，让 capability 通过标准机制注册传感器。

**Life-system abstractions in core (landed)**

The lifecycle-style abstractions for Phase 2 Step 2a are now live in
`@linchkit/core`, alongside the pre-existing detection-style abstractions.
Both styles co-exist — capabilities pick whichever fits the problem they
are solving:

- **Detection-style** (existing, unchanged): `Sensor`, `Signal`,
  `Baseline`, `MemoryStore` from `packages/core/src/types/life-system.ts`.
  Sensors flow through `extensions.sensors` and are polled by the
  EvolutionRuntime each cycle. `defineSensor()` is the canonical factory.
- **Lifecycle-style** (new in 2a): `LifecycleSensor` (`id` / `start` /
  `stop` / `subscribe`), `LifecycleSignal` (`{ source, kind, data,
  timestamp, metadata? }`), `LifecycleBaseline` (`update` / `score` /
  `snapshot`), and the generic key/value `LifecycleMemoryStore` (`read` /
  `write` / `delete` / `list`). All four live in
  `packages/core/src/life-system/abstractions.ts` and are exported
  alongside the detection-style names. Lifecycle sensors register via
  the module-level helpers `registerSensor` / `getSensors` / `findSensor`
  / `unregisterSensor` (see
  `packages/core/src/life-system/sensor-registry.ts`) — they do NOT
  flow through `extensions.sensors`, which remains detection-only.

This change is purely additive — `PatternDetector`, `AnomalyDetector` and
`WatcherEngine` concretes stay in core; their migration to capabilities
follows in subsequent PRs (Step 2b).

**Step 2b — 移出具体实现**

| 目标 capability | 移出内容 | 保留接口 |
|----------------|---------|---------|
| `cap-ai` | PatternDetector 具体实现 | `Detector` 接口留 core |
| `cap-ai` | AnomalyDetector 具体实现 | `Detector` 接口留 core |
| `cap-ai` | AI ResponseCache, CostEstimator | `AIService` 接口留 core |
| capability (TBD) | WatcherEngine 具体实现 | `Watcher` 接口留 core |

- 2026-05-07: AI helpers (ResponseCache, CostEstimator) consolidated into
  `cap-ai-provider`; core copies (`packages/core/src/ai/response-cache.ts`,
  `cost-estimator.ts`) and their tests deleted, exports removed from
  `packages/core/src/ai/index.ts`, `packages/core/src/index.ts`
  (`ModelPricing`) and `packages/core/src/server-entry.ts`. Detector
  migration (PatternDetector / AnomalyDetector / WatcherEngine) deferred
  pending the `Detector` / `Watcher` interface design.

**Step 2c — Detector / Watcher abstractions land + concrete impls move out**

- 2026-05-07: Phase 2 Step 2c executed.
  - **New core abstractions** (additive, type-only):
    - `Detector<TInput, TOutput>` — minimal Awareness-layer contract
      (`{ id; detect(input): TOutput | null | Promise<...> }`) at
      `packages/core/src/life-system/detector.ts`.
    - `Watcher` — minimal Sense-layer lifecycle contract
      (`{ id; start(); stop() }`) at
      `packages/core/src/life-system/watcher.ts`.
    - Both are re-exported via `@linchkit/core` (root barrel) and
      `packages/core/src/life-system/index.ts`. The pre-existing stub
      `Detector` interface in `packages/core/src/types/life-system.ts`
      was removed (no in-tree consumers).
  - **Concrete impls moved** out of core, alongside their tests, into
    `@linchkit/cap-ai-provider`:
    - `packages/core/src/ai/pattern-detector.ts` →
      `addons/ai-provider/cap-ai-provider/src/pattern-detector.ts`
    - `packages/core/src/ai/anomaly-detector.ts` →
      `addons/ai-provider/cap-ai-provider/src/anomaly-detector.ts`
    - `packages/core/src/automation/watcher-engine.ts` →
      `addons/ai-provider/cap-ai-provider/src/watcher-engine.ts`
    - Each class now declares an `id` and `implements` its core
      interface (`PatternDetector`/`AnomalyDetector` implement
      `Detector`; `WatcherEngine` extends a domain-specific interface
      that itself extends the abstract `Watcher`).
  - **Core retains** the `WatcherRegistry` (action pipeline consumes
    `WatcherDefinition` records directly) and a small
    `PatternInsight` data contract at
    `packages/core/src/ai/pattern-insight.ts` so
    `ProposalEngine.createFromInsight()` keeps its existing API
    without depending on `cap-ai-provider`.
  - **Out-of-tree consumer migrated**:
    `addons/adapter-server/cap-adapter-server/src/proposal-api.ts` now
    imports `PatternDetector` / `PatternInsight` from
    `@linchkit/cap-ai-provider`; `cap-adapter-server`'s `package.json`
    gained a `peerDependencies`/`devDependencies` entry for it.
  - **Path mapping**: root `tsconfig.json` gained
    `"@linchkit/cap-ai-provider": ["./addons/ai-provider/cap-ai-provider/src"]`.
  - **Tests moved** into `addons/ai-provider/cap-ai-provider/__tests__/`
    (`pattern-detector.test.ts`, `pattern-detector-integration.test.ts`,
    `anomaly-detector.test.ts`, `watcher-engine.test.ts`); their
    imports were rewritten to use `@linchkit/core` / `@linchkit/core/server`.
  - Follow-ups:
    - `cap-ai-provider` is currently the only home for `WatcherEngine`.
      A dedicated `cap-watcher` (or generic automation capability) may
      be split out later if non-AI watchers proliferate; tracked as a
      separate issue.
    - Several lifecycle-style abstractions
      (`LifecycleSensor`/`LifecycleSignal`/...) and the new minimal
      `Detector`/`Watcher` interfaces still co-exist; consolidating
      them is out of scope for Step 2c.

### 不移出（三方一致同意留核心）

| 组件 | 原因 |
|------|------|
| AutomationEngine | Sense 层引擎，没有它系统不能感知事件 |
| ApprovalEngine | Rule Engine 的关键路径，`require_approval` 效果依赖它 |
| ProposalEngine | Proposal 生命周期管理，安全闭环的必要组件 |
| Flow 接口 + SyncFlowEngine + TriggerBinding + FlowRegistry | Flow 是元模型一等公民，最小执行语义必须内置 |
| AI 安全层 (AIBoundary, PromptSanitizer, OutputValidator, ProposalValidator) | 安全钩子必须内建，不能依赖外部 capability |
| PatternDetector / AnomalyDetector **接口** | 生命系统 Awareness 层抽象，是 core 对"感知能力"的声明 |

## 4. 迁移策略

### 迁移方式

直接移除，清理导出。项目处于活跃新开发阶段，无外部消费者，无需任何过渡措施。

### 时间线

1. **Phase 1 迁移** — 直接搬文件，删除 core 中的旧导出，更新 import path
2. **Phase 2 抽象补充** — 与 Spec 55 实现同步推进
3. **Phase 2 迁移** — 抽象稳定后，移出具体实现

### CLAUDE.md 更新

迁移完成后更新包结构说明：

```
capabilities/ (pluggable):
  ...existing...
  @linchkit/cap-migration          — Data import/export, schema mapping — 🔧
  @linchkit/cap-flow-restate       — Restate durable flow engine — 🔧
  @linchkit/cap-ai-provider        — AI provider SDKs (Vercel AI, etc.) — 🔧
```

## 5. 与其他 Spec 的关系

| Spec | 关系 |
|------|------|
| [Spec 55 — 进化系统](./55_evolution_system.md) | Phase 2 的抽象补充（Sensor/Signal/Baseline）直接服务于 Spec 55 的五层架构 |
| [Spec 53 — Chatter](./53_chatter_and_collaboration.md) | Chatter 作为 capability 实现，验证了 "PURE CAPABILITY" 模式的可行性 |
| [Spec 20 — 扩展机制](./20_extension_mechanism.md) | 扩展点增加 `extensions.sensors` / `extensions.formPanels` 等新槽位 |
| [Spec 01 — Capability 结构](./01_capability_structure.md) | 新建的 `cap-migration`、`cap-flow-restate`、`cap-ai-provider` 遵循标准 Capability 结构 |

## 6. 零 Capability 安装的最小系统

引用 Codex 的建议：零 capability 安装不是只有 CRUD，而是一个「会自我记录、会自我描述、能安全提案」的 kernel。

**最小 kernel 包含：**

- **元模型定义与注册** — Schema / Action / Rule / State / Event / EventHandler / View / Flow / Link 的完整定义和 Registry
- **CommandLayer** — 7-slot 中间件管线，所有操作的统一入口
- **ActionEngine** — Action 执行引擎
- **PersistentEventBus + ExecutionLog** — Sense / Memory 层的基座，事件持久化和执行追踪
- **OntologyRegistry** — 结构层 Awareness，系统自我描述能力
- **Proposal + Approval 生命周期** — 安全闭环，所有变更需经过提案审批
- **AutomationEngine + TriggerBinding** — 事件驱动自动化，Sense 层核心引擎
- **Flow 最小同步执行** — SyncFlowEngine + FlowRegistry + TriggerBinding
- **AIService 接口 + noop 默认实现** — AI 能力声明，无 provider 时安全降级
- **AI 安全层** — AIBoundary, PromptSanitizer, OutputValidator, ProposalValidator

这个 kernel 已经具备：感知事件、记录执行、描述自身结构、安全提案变更的完整能力。具体的 AI provider、Flow 持久化引擎、文档生成等通过 capability 按需接入。
