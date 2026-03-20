# 代码质量控制设计规范

## 1. 定位

不管是人写的还是 AI 生成的代码，都必须经过质量控制。质量控制贯穿开发、提交、CI、AI Review、人工 Review 全链路。

## 2. 质量检查全链路

```
代码编写
    ↓
开发时：IDE 实时检查（Biome + TypeScript）
    ↓
提交时：Git hooks（lint + type check + 相关测试）
    ↓
PR 时：GitHub Actions CI
    ├── Biome lint + format
    ├── TypeScript 编译
    ├── bun test（全量测试）
    ├── validateCapability（结构验证）
    ├── 覆盖率报告（Codecov）
    ├── 安全扫描（CodeQL + Dependabot）
    └── 静态分析（SonarCloud）
    ↓
AI 自动 Review
    ├── GitHub Copilot Code Review（代码质量建议）
    ├── CodeRabbit（深度 AI 审查：逻辑/安全/性能）
    └── LinchKit Review Bot（方法论合规 + 影响分析）
    ↓
人工 Review
    ├── 以上结果作为参考
    ├── 重点看业务逻辑
    └── 确认后 merge
```

## 3. 工具链

### 3.1 代码规范

| 工具 | 用途 |
|------|------|
| **Biome** | Lint + Format 一体化，Bun 原生支持 |

```json
// biome.json
{
  "linter": {
    "enabled": true,
    "rules": {
      "recommended": true,
      "correctness": { "noUnusedVariables": "error" },
      "style": { "useConst": "error" },
      "suspicious": { "noExplicitAny": "warn" }
    }
  },
  "formatter": {
    "enabled": true,
    "indentStyle": "space",
    "indentWidth": 2
  }
}
```

### 3.2 TypeScript 严格模式

```json
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true
  }
}
```

### 3.3 Git Hooks

使用 simple-git-hooks 或 lefthook：

```
pre-commit:
  1. Biome check（lint + format）
  2. TypeScript 类型检查（tsc --noEmit）
  3. 受影响的测试

commit-msg:
  Conventional Commits 格式检查
```

## 4. CI Pipeline（GitHub Actions）

```yaml
# .github/workflows/ci.yml
name: CI
on: [pull_request, push]

jobs:
  quality:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2

      # 代码规范
      - run: bun run biome check .

      # 类型检查
      - run: bun run tsc --noEmit

      # 测试
      - run: bun test

      # Capability 结构验证
      - run: bun run linch validate

      # 覆盖率
      - uses: codecov/codecov-action@v4

  security:
    runs-on: ubuntu-latest
    steps:
      # GitHub CodeQL 安全扫描
      - uses: github/codeql-action/analyze@v3

  # SonarCloud 静态分析
  sonar:
    runs-on: ubuntu-latest
    steps:
      - uses: SonarSource/sonarcloud-github-action@v2
```

## 5. AI 自动 Review

### 5.1 GitHub Copilot Code Review

GitHub 原生功能，自动在 PR 上评论代码质量建议。无需额外配置。

### 5.2 CodeRabbit

深度 AI 审查，开源可自托管：

```yaml
# .github/workflows/coderabbit.yml
# 或直接安装 CodeRabbit GitHub App

# CodeRabbit 自动检查：
# - 逻辑错误
# - 安全漏洞
# - 性能问题
# - 代码风格
# - 变更摘要自动生成
```

### 5.3 LinchKit Review Bot（自研）

LinchKit 专属的 Review Bot，作为 GitHub Action 运行：

```yaml
# .github/workflows/linchkit-review.yml
name: LinchKit Review
on: [pull_request]

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: linchkit/review-action@v1
        with:
          check-methodology: true      # 方法论合规
          check-change-level: true     # 变更分级
          check-security: true         # 安全敏感变更
          check-impact: true           # 影响分析（基于关系图）
          ai-review: true              # AI 深度分析
          ai-model: claude-sonnet
```

LinchKit Review Bot 的输出示例：

```markdown
## LinchKit Review

### 变更分级：minor
新增了 1 条 Rule，1 个 View 扩展。

### 方法论合规 ✅
- Rule 命名符合规范 (budget_check)
- 使用了声明式 condition（推荐）
- Action 粒度合理

### 影响分析
- 直接影响：purchase_management
- 间接影响：inventory_management（通过 bridge）
- 建议检查：purchase_inventory_bridge 中的相关逻辑

### 安全检查 ✅
- 未涉及权限变更
- 未涉及安全相关 Rule

### AI Review
- ⚠️ Rule condition 中的阈值 50000 是硬编码，建议使用 config 参数
- ✅ 其他方面无问题
```

## 6. AI 生成代码的额外检查

AI 通过 Proposal 生成的代码，除标准检查外：

| 检查项 | 说明 |
|--------|------|
| systemPermissions 检查 | AI 不能声明系统权限 |
| 新依赖检查 | 是否引入了新的外部依赖 |
| 安全变更检查 | 是否修改了权限/安全相关定义 |
| 方法论合规 | 命名、粒度、设计模式是否符合规范 |
| 过度设计检查 | AI 容易加不必要的抽象 |
| 变更分级 | 自动判断 patch/minor/major 是否正确 |
| **handler 复杂度** | 圈复杂度 ≤ 15，单函数 ≤ 80 行 |
| **安全扫描** | 禁止 handler 内直接拼接 SQL 字符串、禁止 eval/Function 构造 |
| **测试覆盖** | AI 生成的 Action handler 必须有对应的 testAction 测试用例 |

## 7. Commit 规范

Conventional Commits 格式：

```
type(scope): description
```

| type | 说明 |
|------|------|
| `feat` | 新功能 |
| `fix` | 修复 |
| `refactor` | 重构 |
| `test` | 测试 |
| `docs` | 文档 |
| `chore` | 构建/依赖/配置 |
| `perf` | 性能优化 |

## 8. 人工 Review 关注点

### 通用
- 业务逻辑是否正确
- Action 粒度是否合理
- Rule 是否声明式优先
- Schema 设计是否符合规范
- 安全性
- 性能

### AI 生成代码额外关注
- 过度设计
- 遗漏边界情况
- 命名合理性
- 不必要的依赖

## 9. 与里程碑的关系

### M0
- Biome 配置
- TypeScript strict 模式
- Git hooks（lint + type check）
- Conventional Commits
- 基础 GitHub Actions CI

### M1
- 完整 CI Pipeline（测试 + 覆盖率 + 安全扫描）
- CodeRabbit / GitHub Copilot Review
- LinchKit Review Bot 基础版（方法论合规 + 变更分级）
- Capability 结构验证纳入 CI

### M2
- LinchKit Review Bot 完整版（影响分析 + AI Review）
- AI 生成代码的额外检查
- 覆盖率要求
