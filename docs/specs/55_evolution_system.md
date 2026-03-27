# 进化系统 — 活的软件

> 本规范定义 LinchKit 的自进化能力。与产品愿景（[00a](./00a_product_vision.md)）互补：00a 定义"用户说→系统出现"的显式生长，本规范定义"系统自己感知→自己进化"的隐式生长。
>
> 相关规范：[15 — AI 开发者体验](./15_ai_developer_experience.md)（evolver Agent）、[36 — AI 服务层](./36_ai_service.md)（ctx.ai）、[45 — Reactive Automation](./45_reactive_automation.md)（TriggerBinding）、[22 — AI Rule Boundary](./22_ai_rule_boundary.md)（边界约束）。

## 1. 核心理念

传统软件是**死的**——写好了就固定了，除非有人改它。

LinchKit 要做的是一个**活的系统**——能感知、能记忆、能理解自己、能发现机会、能安全地改变自己。

```
传统软件               LinchKit
────────────          ────────────────
有骨架（代码）          有骨架（Schema/Action/Rule/Flow/Link/View）
没有感官               有感官（多维 Sense）
没有记忆               有记忆（Memory）
不认识自己             认识自己（Awareness = OntologyRegistry + 使用知识）
不能改自己             能安全地改自己（Proposal）
```

**LinchKit 同时拥有四样传统软件不具备的东西：**

| 能力 | 实现 | 意义 |
|------|------|------|
| **自我认知** | OntologyRegistry — 系统知道自己的完整结构 | 能做结构自检 |
| **全量记忆** | PersistentEventBus + Memory — 记录一切发生过的事 | 能发现模式 |
| **推理能力** | AI — 能对模式进行归因和翻译 | 能生成 Proposal |
| **安全自改** | Proposal 机制 — 变更经用户确认后生效 | 能进化而不崩溃 |

这四样加在一起，构成了一个**能自我进化的软件有机体**。

## 2. 生命系统模型

### 2.1 五层架构

```
┌─────────────────────────────────────────────────────────┐
│  Proposal（进化）                                        │
│  Insight 的可执行翻译 — AI 编译为 defineXxx() 代码        │
│  附带回测结果、影响范围、回滚条件                          │
├─────────────────────────────────────────────────────────┤
│  Insight（洞察）                                         │
│  从 Awareness 中涌现的发现 — 附带完整证据链                │
│  区分关联和因果，标注置信度，受注意力预算约束               │
├─────────────────────────────────────────────────────────┤
│  Awareness（意识）                                       │
│  系统知道"什么对这个业务重要"                              │
│  不是人定义的，是从 Sense + Memory 中涌现的                │
│  = OntologyRegistry（结构自知）+ 使用重要性图谱            │
├─────────────────────────────────────────────────────────┤
│  Memory（记忆）                                          │
│  使用模式的积累 — 偏好、频率、摩擦、趋势                   │
│  和历史对比，建立基线，发现偏移                            │
├─────────────────────────────────────────────────────────┤
│  Sense（感知）                                           │
│  多维信号持续流入 — API/GraphQL/MCP/UI/Server/EventBus    │
│  传感器 Capability 化，业务模块可扩展                      │
└─────────────────────────────────────────────────────────┘
```

### 2.2 循环

```
Sense → Memory → Awareness → Insight → Proposal → 用户确认 → 系统进化
  ↑                                                              │
  └──────────────── 新的信号流入 ────────────────────────────────┘
```

进化不是一次性的，是持续的循环。每一次进化改变了系统结构，产生新的使用模式，触发新的感知，可能产生新的洞察。

## 3. Sense — 感知层

### 3.1 多维信号源

系统通过多个通道感知使用情况，每个通道看到不同的侧面：

| 通道 | 感知到什么 | 信号示例 | 可信度 |
|------|-----------|---------|--------|
| Event Bus | 业务流程实际怎么跑 | 两个 Event 总是成对出现 | 最高 |
| Server | 系统在什么地方吃力 | 某 Action 响应时间劣化 | 高 |
| API/REST | 外部系统怎么用你 | 某 endpoint 被高频轮询 | 高 |
| GraphQL | 前端/第三方要什么数据 | 某 query 总取10个字段但 schema 有50个 | 高 |
| MCP | AI Agent 怎么理解你 | 某 tool 反复调用又报错 | 中 |
| UI 交互 | 用户实际怎么操作 | 反复在列表和详情间切换 | 低（需解读） |

**跨通道关联信号比单通道更有价值**：MCP 显示 AI 频繁查 supplier + UI 显示用户也频繁搜索供应商 + GraphQL 显示查询很慢 → 三个通道一起说明 supplier 查询是高频场景。

### 3.2 摩擦信号优先

> "摩擦日志比成功日志重要得多。" — 进化信号常来自"用户差点做成但没做成"。

| 摩擦信号 | 含义 |
|---------|------|
| 用户开始创建记录，然后放弃 | 表单太复杂或缺少信息 |
| 用户创建后立刻编辑某个字段 | 默认值不对 |
| 用户搜索了但没有结果 | 数据缺失或搜索不好用 |
| 用户反复在列表和详情间切换 | 列表缺关键字段 |
| 用户对同一个问题问 AI 两次 | 第一次回答不好 |
| 用户撤销了刚才的操作 | 操作不符合预期 |
| 用户手动重复做同一组操作 | 应该自动化 |

摩擦信号的特点：不需要 AI 来发现（事件模式匹配即可）、天然高信噪比（放弃操作一定有原因）、天然带上下文。

### 3.3 传感器 Capability 化

传感器不是框架硬编码的，而是通过 Capability 扩展机制注册的：

```typescript
// 框架提供 defineSensor API 和 SignalBus
// 系统 Capability 提供通用传感器（cap-sensor-health, cap-sensor-activity...）
// 业务 Capability 注册领域传感器

// 采购管理自己知道该监测什么
export default defineCapability({
  name: 'purchase_management',
  extensions: {
    sensors: [
      defineSensor({
        name: 'purchase_rejection_pattern',
        source: 'event_bus',
        filter: { schema: 'purchase_request', action: 'reject_*' },
        metric: 'count_by_field(rejection_reason)',
        window: '30d',
      }),
    ],
  },
})

// 质检模块扩展采购模块的传感器，叠加质检维度
export default defineCapability({
  name: 'quality_inspection',
  extensions: {
    sensorExtensions: [
      extendSensor('purchase_rejection_pattern', {
        enrich: (signal, ctx) => ({
          ...signal,
          context: {
            ...signal.context,
            relatedQualityIssues: ctx.query('quality_issue', { ... }),
          },
        }),
      }),
    ],
  },
})
```

行业冷启动包不只带 Schema 和 Rule，还带一整套**行业传感器**。装上行业包，系统立刻知道该监测什么。

### 3.4 标准化信号输出

所有传感器输出统一格式，汇入 SignalBus：

```typescript
interface SensorSignal {
  sensor: string              // 传感器名
  source: SignalSource        // 信号来源通道
  timestamp: Date
  value: number               // 当前值
  baseline: number            // 基线值（Memory 层计算）
  deviation: number           // 偏离程度 (0-1)
  confidence: number          // 信号置信度 (0-1)
  context: Record<string, any>  // 附加上下文
}
```

## 4. Memory — 记忆层

### 4.1 记忆类型

| 记忆类型 | 内容 | 来源 | 衰减 |
|---------|------|------|------|
| 使用基线 | 每个 Action/Schema 的历史统计分布 | Sense 聚合 | 滑动窗口自动更新 |
| 偏好模式 | 用户排序/筛选/搜索的习惯 | UI 交互 | 近期加权 |
| 摩擦记录 | 放弃、撤销、重复操作的累积 | 摩擦信号 | 长期保留 |
| 业务节奏 | 周期性模式（月末高峰、周五低谷） | Event Bus | 自动学习周期 |
| 进化历史 | 过去的 Proposal 及其接受/拒绝/效果 | Proposal 反馈 | 永久保留 |

### 4.2 基线自动计算

Memory 层的核心任务是为每个传感器**自动建立基线**，不需要人定义阈值：

- 滑动窗口平均值 + 标准差
- 识别周期性（日/周/月）
- 排除已知异常（部署、节假日）
- 基线随系统进化自动更新

### 4.3 跨通道关联

Memory 不是按通道分别记忆，而是按**业务实体**组织记忆。一个 Schema 的记忆包含所有通道对它的观测：

```
purchase_request 的记忆：
  - Event Bus: 日均创建 45 条，审批驳回率 12%
  - GraphQL: 最常查询的字段是 amount, supplier, status
  - UI: 用户最常按 amount 排序，搜索词 top3: 供应商名, 金额范围, 日期
  - MCP: AI Agent 最常对它执行 query 和 create_purchase_request
  - Server: list 操作 P95 = 230ms, create 操作 P95 = 45ms
```

## 5. Awareness — 意识层

### 5.1 什么是意识

Awareness = **OntologyRegistry（结构自知）+ Memory 凝练出的"什么重要"。**

系统不需要人告诉它"采购审批很重要"——它从使用数据中**自己感知到**：

```
使用量最大的 Schema → 核心业务实体
执行频率最高的 Action → 核心操作
被排序/筛选最多的字段 → 关键决策维度
摩擦最多的环节 → 最需要改进的地方
```

### 5.2 重要性图谱

Awareness 维护一张**动态重要性图谱**——系统对"什么重要"的理解，随使用模式变化而变化：

```
purchase_request ★★★★★    ← 使用量最大
  ├── amount ★★★★★        ← 被排序/筛选最多
  ├── supplier ★★★★       ← 跨通道高频访问
  ├── status ★★★          ← 状态流转频繁
  └── description ★       ← 很少被查看
approve_purchase ★★★★★    ← 执行频率最高，摩擦也最多
inventory_item ★★★        ← 使用量中等
```

重要性不是静态标签，是**涌现的**——系统观察使用模式，自动计算。

**重要性图谱是多视角的**——不同角色、岗位、行业关注的东西完全不同：

```
同一个 purchase_request：
  采购员视角：supplier ★★★★★, delivery_date ★★★★, amount ★★★
  财务视角：  amount ★★★★★, budget_code ★★★★, compliance ★★★★
  仓库视角：  delivery_date ★★★★★, quality_status ★★★★
  管理层视角：amount_total_trend ★★★★★, pending_approval_count ★★★★
```

Awareness 通过观察**谁在用什么**来建立多视角图谱——Actor 的角色/权限组天然标注了岗位，Capability 的行业属性标注了行业。这意味着：

- 同一个 Insight 对不同角色的重要性不同
- Insight 的呈现顺序按角色定制
- 行业冷启动包可以预置行业视角的初始权重（制造业关注质检，零售关注库存周转）

### 5.3 行业知识与领域专家

Awareness 不应从零学起。行业冷启动包除了带 Schema/Rule/Sensor，还带**行业知识库**——系统的先验知识：

```typescript
// starter-ind-manufacturing 的行业知识
export default defineCapability({
  name: '@linchkit/starter-ind-manufacturing',
  extensions: {
    knowledge: defineKnowledge({
      industry: 'manufacturing',

      // 行业常识：什么指标重要
      keyMetrics: [
        { name: '来料不良率', threshold: '<2%', severity: 'high' },
        { name: '库存周转天数', threshold: '<30d', severity: 'medium' },
        { name: '采购交期达成率', threshold: '>95%', severity: 'high' },
        { name: '生产工单准时完成率', threshold: '>90%', severity: 'medium' },
      ],

      // 行业常见模式：什么情况通常意味着什么
      patterns: [
        { signal: '采购驳回率上升', commonCauses: ['预算收紧', '供应商问题', '流程变更'] },
        { signal: '库存积压增加', commonCauses: ['需求预测偏差', '质检卡住', '供应商提前交货'] },
      ],

      // 行业最佳实践：Proposal 的参考模板
      bestPractices: [
        { scenario: '来料不良率 >5%', recommendation: '增加供应商评审规则 + 来料质检 Flow' },
        { scenario: '采购集中在少数供应商', recommendation: '添加供应商分散度监控' },
      ],
    }),
  },
})
```

行业知识库的作用：

- **加速 Awareness**：不用等3个月的数据积累，装包即知道行业关键指标
- **提升 Insight 质量**：基线偏移时，结合行业常见原因做归因，而非瞎猜
- **提升 Proposal 质量**：AI 翻译时参考行业最佳实践，生成的建议更靠谱
- **提供行业语言**：Insight 的表述用行业术语，而非技术指标

行业知识库也是 Capability——可以被社区贡献、可以被用户覆写、可以随行业变化更新。

未来还可以接入**外部领域专家**：行业顾问通过 MCP 或 UI 审阅 Insight 和 Proposal，他们的反馈进入 Memory，持续校准系统对行业的理解。

### 5.4 结构自检

Awareness 还包含框架对自身结构的理解（基于 OntologyRegistry）：

- 有 Schema 但没有 View → 缺少展示层
- 有 Action 但从未被调用 → 可能是死代码
- 有 Link 定义但关联记录为 0 → 关系未被使用
- 有 Rule 但从未触发 → 条件可能写错
- 字段在 95% 的记录里是同一个值 → 应该是默认值

这些是**确定性判断**，不需要 AI。

## 6. Insight — 洞察层

### 6.1 Insight 不是建议，是事实

Insight 是 Awareness 层发现的**有证据支撑的事实**，不是 AI 编造的建议：

```typescript
interface Insight {
  id: string
  type: 'anomaly' | 'friction' | 'pattern' | 'structural' | 'positive'
  confidence: number           // 0-1
  impact: 'low' | 'medium' | 'high'

  // 证据链（Codex 提出的 EvidencePack）
  evidence: {
    signals: SensorSignal[]    // 触发的传感器信号
    baseline: any              // 基线对比
    context: any               // 业务上下文
    counterExamples?: any      // 反例（如果有）
  }

  // 人可读的摘要
  summary: string              // "采购审批驳回率从12%升至28%，主因是金额超标(占73%)"

  // 因果标注
  causality: 'causal' | 'correlational' | 'structural'
}
```

### 6.2 Insight 类型

| 类型 | 来源 | 示例 | 需要 AI？ |
|------|------|------|----------|
| structural | 结构自检 | "Schema X 有定义但没有 View" | 否 |
| anomaly | 基线偏移 | "Action Y 失败率从3%升至25%" | 否 |
| friction | 摩擦检测 | "用户创建后立刻编辑 supplier 字段(78%)" | 否 |
| pattern | 模式识别 | "用户每周五批量导出采购数据" | 部分 |
| positive | 正向反馈 | "上次添加的校验规则使驳回率降低了40%" | 否 |

注意：**大部分 Insight 不需要 AI 来产生。** AI 的角色在下一层（Proposal）。

### 6.3 晋升规则

> 参考 OpenClaw 的学习日志晋升机制：同一模式重复出现才值得上报。

不是每次检测到异常就生成 Insight。信号必须满足**晋升条件**才能成为正式 Insight：

```typescript
promotionRule: {
  minOccurrences: 3,          // 同一模式至少出现3次
  minDistinctContexts: 2,     // 跨越至少2个不同上下文（不同用户、不同时段）
  timeWindow: '30d',          // 30天窗口内
  minConfidence: 0.7,         // 置信度阈值
}
```

未晋升的信号保留在 Memory 层作为"候选"——它们还在积累，等待满足条件。这确保用户看到的每一条 Insight 都是**反复验证过的模式**，而不是一次性波动。

对于 structural 类型的 Insight（结构自检），不需要晋升——结构缺失就是缺失，一次就够。

### 6.3 注意力预算

> 每条 Insight 都在消耗用户注意力。

系统维护**注意力预算**——不是所有 Insight 都呈现给用户：

- 按 `confidence × impact` 排序
- 每周最多呈现 N 条（可配置）
- 同类 Insight 合并
- 被用户忽略的类型自动降权
- 被用户标记"有用"的类型自动升权

### 6.4 呈现方式：拉为主，推为辅

| 置信度 \ 影响 | 低影响 | 高影响 |
|--------------|--------|--------|
| **低置信度** | 归档不呈现 | **拉**：放入洞察中心供探索 |
| **高置信度** | **拉**：上下文内提示 | **推**：主动通知 |

- **拉模式**（默认）：Insight 在用户浏览相关页面时，以侧边栏 / 徽标形式出现
- **推模式**（仅限）：安全风险、用户显式订阅的关注点、高置信+高影响

## 7. Proposal — 进化层

### 7.1 AI 在这里才登场

AI 的角色是**把 Insight 翻译成可执行的系统变更**：

```
Insight: "用户创建 purchase_request 后，78% 会立刻编辑 supplier_contact 字段"
  ↓ AI 翻译
Proposal: {
  type: 'modify_schema_field',
  definition: extendSchema('purchase_request', {
    fields: {
      supplier_contact: {
        ...existing,
        derivedFrom: 'supplier.contact',  // 自动从关联 supplier 填充
      },
    },
  }),
  evidence: { ... },        // Insight 的完整证据链
  backtest: { ... },        // 回测：如果这条改动早就存在，过去30天会怎样
  rollback: { ... },        // 回滚条件和方法
  successMetric: { ... },   // 成功指标：supplier_contact 手动编辑率降至 <20%
}
```

### 7.2 Skill 复用

进化系统在归因和生成 Proposal 时，不只看内部数据——通过复用现有的 Skill/Tool 生态来获取外部上下文：

```
内部能力                          外部 Skill（通过 MCP/Tool Calling）
────────────────                ──────────────────────────────────
OntologyRegistry（结构理解）      Tavily/Baidu Search（搜索行业信息）
Memory（使用数据）                Web Fetch（抓取行业报告/竞品做法）
Sensor（实时信号）                Codex/Claude Code（验证代码可行性）
                                 Knowledge Base（企业内部知识库）
                                 自定义 Skill（企业自有的分析工具）
```

Skill 在进化循环中的介入点：

- **Insight 归因**：驳回率上升时，搜索"最近行业政策变化"来辅助归因
- **Proposal 生成**：参考搜索到的行业最佳实践来生成更好的建议
- **Proposal 验证**：调用代码分析工具验证生成的 defineXxx() 是否合理
- **Knowledge 扩充**：将搜索到的行业知识沉淀回 Knowledge 库

这意味着进化系统的能力边界不是封闭的——随着 MCP 生态和 Skill 市场的扩展，系统的"认知能力"也在扩展。装一个新的 MCP Server，系统就多了一个信息来源。

### 7.3 Proposal 可行性验证

Proposal 不是自然语言描述，而是**可执行的 defineXxx() 代码**。生成时自动做静态验证：

- Schema 存在？字段存在？类型兼容？
- 引用可解析？依赖已安装？
- 与现有 Rule/Flow 有冲突吗？

验证不通过的 Proposal 不会到达用户面前。

### 7.4 回测与影响预览

每个 Proposal 附带**历史回测**——基于过去的数据，告诉用户"如果这个改动早就存在，会发生什么"：

```
Proposal: 添加规则"金额超预算时提交前提醒"

回测结果（基于过去30天数据）：
  - 23 条 purchase_request 会触发此规则
  - 其中 18 条最终被审批驳回（命中率 78%）
  - 5 条最终通过（可能误报率 22%）
```

### 7.5 渐进生效

Proposal 不直接全量生效，走渐进路径：

```
Proposal → Validate → Approve → Shadow（影子模式，只记录不执行）
  → Champion-Challenger（新旧规则并行对比）→ Promote（全量生效）
```

### 7.6 毕业：从数据到代码

进化的终态不是数据库记录，而是 **TypeScript 文件**。

这对齐了三层 Source of Truth 模型（[Spec 02](./02_runtime_change.md)）：进化产出从 Layer 2（运行时/DB）毕业为 Layer 0（设计时/Git），成为系统的永久"基因"。

```
阶段              存储位置        形态              可追溯性
──────────────────────────────────────────────────────────
候选（Memory）     DB             统计数据           临时
Shadow 模式       DB             defineXxx() 代码    可回滚
毕业              TS 文件 / Git   defineXxx() 代码    完整版本历史
```

毕业流程：

```
Proposal 验证通过 + successMetric 达标
    ↓
系统自动生成 TS 文件：
    capabilities/purchase_management/rules/budget_reminder.ts
    ─── defineRule({ name: 'budget_reminder', ... })
    ↓
自动创建 Git commit（或 PR，取决于配置）：
    "feat(evolution): add budget reminder rule

     Triggered by: Insight #42 — 采购驳回率异常
     Evidence: 30天内驳回47次，金额超标占73%
     Shadow period: 7 days, success metric met (驳回率 28%→10%)

     Co-Evolved-By: LinchKit Evolution System"
    ↓
从此这条规则：
  - 是 Layer 0 的一部分，Git 可追溯
  - 可被 code review
  - 可被其他项目 fork/复用
  - 克隆 repo 就能复现完整的进化历史
```

所有进化产出都可以毕业为 TS：

| 进化产出 | 毕业为 | 文件位置 |
|---------|--------|---------|
| 新规则 | `defineRule({ ... })` | `capabilities/xxx/rules/` |
| 新字段/Schema 扩展 | `extendSchema({ ... })` | `capabilities/xxx/schemas/` |
| 自动化流程 | `defineFlow({ ... })` | `capabilities/xxx/flows/` |
| 传感器配置 | `defineSensor({ ... })` | `capabilities/xxx/sensors/` |
| 行业知识积累 | `defineKnowledge({ ... })` | `capabilities/xxx/knowledge/` |
| View 默认配置 | `defineView({ defaultSort, ... })` | `capabilities/xxx/views/` |

**不毕业的**：用户个人偏好、租户级覆写——这些留在 Layer 2（DB），因为它们是个性化的、非通用的。

**半自动毕业**：当某个 Layer 2 覆写被多个租户/用户独立采用时，系统可以建议将其毕业为 Layer 0 的默认值——"这个调整已经被80%的用户采用，要不要变成系统默认？"

### 7.7 反馈回路

用户对 Proposal 的接受/拒绝/效果，反馈回 Memory 层：

- 哪类 Proposal 常被接受 → 下次更积极地生成
- 哪类 Proposal 常被拒绝 → 下次降低权重
- Proposal 生效后效果如何 → 验证 successMetric
- 验证失败 → 自动触发回滚条件

## 8. 数据治理：漏斗与降噪

### 8.1 核心问题

不加约束的进化系统会自杀：
- **数据爆炸**：每个用户操作 × 每个通道 × 每个传感器 = 海量原始信号
- **噪音爆炸**：更多传感器 = 更多信号 = 更多假阳性 = 更多无用 Insight
- **成本爆炸**：每条 Insight 都调 AI 生成 Proposal = 不可控的 API 成本
- **注意力破产**：用户看到3条没用的建议后就永远不看了

**每一层都必须是漏斗，激进压缩，绝不透传。**

### 8.2 分层数据生命周期

```
层              日均量级          保留策略              压缩比
─────────────────────────────────────────────────────────────
原始事件         10万-百万        热存7天，冷存90天       —
传感器信号       千级            聚合后丢弃原始          100:1
Memory 基线     百级             滑动窗口自动更新        1000:1
Insight         个位数           永久（但有过期标记）     10000:1
Proposal        0-3/周          永久                   100000:1
```

关键：**原始事件不进 Memory。** 传感器在源头做聚合，只把统计摘要（计数、分布、百分位）上报给 Memory 层。这是数据量控制的核心——从百万级压缩到千级。

### 8.3 源头采样

不是所有事件都需要被传感器处理：

```typescript
defineSensor({
  name: 'ui_friction_detector',
  source: 'ui',
  // 源头采样：只处理 10% 的 UI 事件，统计上足够
  sampling: { rate: 0.1, method: 'consistent_hash_by_user' },
  // 或者：只在特定条件下采集
  filter: { eventType: ['abandon', 'undo', 'repeat_edit'] },
})
```

规则：
- **Event Bus / Server 指标**：全量采集（量本身不大，且是核心信号）
- **GraphQL / API**：采样或只采集聚合指标（QPS、错误率、字段使用率）
- **UI 交互**：只采集摩擦信号（abandon/undo/repeat），不采集正常浏览
- **MCP**：全量采集（量小但信号密度高）

### 8.4 传感器激活阈值

传感器不是时刻在"看"——有**激活阈值**，偏移不够大就不产出信号：

```typescript
defineSensor({
  name: 'action_failure_rate',
  // 只有偏离基线 2σ 以上才产出信号
  activationThreshold: { deviationSigma: 2 },
  // 最小样本量：数据不够时不判断
  minSampleSize: 50,
  // 冷却期：同一传感器产出信号后，24h 内不重复
  cooldown: '24h',
})
```

### 8.5 信号去重与合并

多个传感器可能因同一根因触发——需要**根因合并**：

```
传感器A: purchase_request 失败率上升
传感器B: approve_purchase 失败率上升
传感器C: purchase_request 响应时间上升
  ↓ 根因关联
  合并为一条信号："purchase_request 相关操作整体异常"
  而不是3条独立信号
```

### 8.6 Insight 的注意力预算（补充）

每周 Insight 有硬上限：

```typescript
// 系统级配置
evolution: {
  insightBudget: {
    maxPerWeek: 5,              // 每周最多5条 Insight 呈现给用户
    maxPushPerWeek: 1,          // 其中最多1条推送（其余都是拉模式）
    minConfidence: 0.7,         // 置信度 < 0.7 的直接归档
    decayOnIgnore: 0.3,         // 被忽略后该类型权重降低30%
    boostOnAccept: 0.2,         // 被采纳后该类型权重提升20%
  },
  proposalBudget: {
    maxAiCallsPerDay: 3,        // 每天最多3次 AI 调用生成 Proposal
    maxActiveProposals: 5,      // 同时活跃的 Proposal 不超过5个
  },
}
```

**宁可漏掉一个有用的 Insight，也不要多推一个没用的。** 信任一旦失去，功能就等于不存在。

### 8.7 噪音反馈回路

系统自动学习什么是噪音：

- 用户忽略（未点击）→ 该类 Insight 降权
- 用户关闭/dismiss → 该类 Insight 大幅降权
- 用户标记"没用" → 该类 Insight 暂停一段时间
- 用户采纳并确认效果好 → 该类 Insight 升权
- 某个传感器连续10次产出被忽略的 Insight → 传感器自动降低灵敏度

这形成了一个**自适应的噪音过滤器**——系统越用越安静、越精准。

## 9. 与现有架构的关系

进化系统不是一个独立的引擎，而是**建立在已有架构之上**：

| 进化系统层 | 依赖的现有架构 |
|-----------|---------------|
| Sense | PersistentEventBus, CommandLayer 日志, GraphQL 查询日志 |
| Memory | 系统表（_linchkit_events, _linchkit_executions）扩展 |
| Awareness | OntologyRegistry + 新增的重要性图谱 |
| Insight | 新概念，但存储在系统表中 |
| Proposal | 已有的 Proposal 机制（Spec 15）扩展 |

传感器通过 Capability 的 `extensions.sensors` 注册，和 `extensions.fieldTypes` / `extensions.viewTypes` 等现有扩展点同级。

## 10. 愿景级场景

### 场景：系统自己意识到需要一个新 Rule

```
Week 1-4:
  Sense: 采购审批驳回事件持续流入
  Memory: 基线建立——驳回率 12%

Week 5:
  Sense: 驳回率信号偏离基线
  Memory: 驳回率升至 28%，偏移 > 2σ

  Awareness: purchase_request 是 ★★★★★ 核心实体
             approve_purchase 是 ★★★★★ 核心操作
             → 这个偏移值得关注

  Insight: {
    type: 'anomaly',
    confidence: 0.91,
    impact: 'high',
    summary: "采购审批驳回率从12%升至28%，主因：金额超标(73%)",
    evidence: { 驳回原因分布、受影响记录、时间趋势 },
    causality: 'correlational',
  }

  → Insight 呈现给用户（高置信+高影响 → 推模式）

Week 5（用户看到 Insight）:
  用户点击"生成建议"

  AI 翻译 Insight → Proposal:
    "添加规则：金额超过部门预算时，提交前自动提醒"
    回测：过去30天23条会触发，其中18条确实被驳回
    成功指标：驳回率回到 15% 以下

  用户确认 → Shadow 模式运行一周 → 效果验证 → 全量生效

Week 8:
  Sense: 驳回率下降至 10%
  Insight (positive): "上次添加的预算提醒规则使驳回率降低了18个百分点"
  Memory: 记录——"预算相关 Proposal 效果好"
```

### 场景：系统自己长出一个传感器

```
安装了 cap-quality-inspection（质检模块）
  ↓
质检模块通过 extensions.sensors 注册了 "来料不良率传感器"
  ↓
质检模块通过 extensions.sensorExtensions 扩展了采购模块的 "采购驳回模式传感器"
  — 给驳回信号附加质检维度
  ↓
系统的感知能力自动增强了
  — 不需要人配置
  — 装上 Capability 就多了一双眼睛
```

## 11. 参考系统

本设计参考了以下系统的实践经验：

| 系统 | 借鉴点 | 在 LinchKit 中的映射 |
|------|--------|---------------------|
| **OpenClaw** | Heartbeat 心跳调度；学习日志 + 3次晋升规则；Skill 自动生成与选择性注入 | Sense 层 Cron；Insight 晋升条件；Proposal 生成 |
| **Reflexion** (NeurIPS 2023) | 语义自我反思；失败经验转文本记忆；情景记忆缓冲区 | Memory 层进化历史；Proposal 拒绝原因记录与反馈 |
| **Stripe Radar** | AI 风险评分 + 人调阈值/规则；半自适应闭环 | Insight 置信度 + 用户决策；传感器灵敏度可调 |
| **Google Ads Smart Bidding** | 目标函数明确；动作空间窄；结果可量化 | Insight 需要明确 successMetric |
| **Spinnaker/Kayenta** | 金丝雀发布；baseline vs canary 自动比较 | Proposal 的 Shadow → Champion-Challenger → Promote |
| **Darwin Godel Machine** (Sakana AI) | 沙箱隔离；变更完全可追溯；进化搜索 | Proposal 沙箱验证；完整审计链 |
| **Database Auto-Index** (Azure/AWS) | 从查询负载中发现优化机会；低风险可回滚 | 结构自检；Proposal 回滚条件 |

**核心观察**：成功的自进化系统都有三个共同特征——**目标明确、动作空间窄、可回滚**。LinchKit 的 Proposal 机制天然满足后两条；Insight 的 successMetric 确保第一条。

## 12. 落地路径

| 阶段 | 内容 | 依赖 |
|------|------|------|
| **M3** | Sense 基础：SignalBus + defineSensor API；摩擦信号采集（事件模式匹配）；结构自检（Awareness 基础）；统计聚合 Dashboard | PersistentEventBus, OntologyRegistry |
| **M4** | Memory：基线自动计算 + 跨通道记忆；Insight 生成（非 AI，纯统计+结构）；Insight UI（侧边栏+洞察中心）；注意力预算 | M3 |
| **M5** | Sensor Capability 化；AI Proposal 翻译；回测与影响预览；渐进生效（Shadow → Promote）；反馈回路 | M4, ctx.ai |
| **M6+** | Awareness 重要性图谱；跨通道关联分析；正向反馈；Proposal 自动验证 | M5 |

每个阶段都交付独立可用的价值，不需要等到最后才有用。
