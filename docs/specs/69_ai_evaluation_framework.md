# AI Evaluation & Quality Framework

> This spec defines a cross-scenario evaluation framework for LinchKit's AI surface area. It is the missing companion to:
> - **Spec 36 — AI Service** (`ctx.ai` runtime — *how* we call LLMs)
> - **Spec 52 — AI Deep Integration** (intent resolution, action proposal — *what* the user-facing AI does)
> - **Spec 27 — AI Security** (prompt injection defense, audit — *how* we keep AI safe)
> - **Spec 22 — AI-Rule Boundary** (where AI may decide vs where deterministic Rules must)
>
> Without this spec, LinchKit has no answer to: "did the last prompt change make AI better or worse?" The current `mock-LLM` unit tests verify parsing, not prompt quality.
>
> Companion research: [`docs/research/mastra-evaluation.md`](../research/mastra-evaluation.md) — analysis of Mastra `@mastra/evals` as a possible runner.
>
> Tracking milestones: M5 (Phase 1 + 2), M6 (Phase 3 + 4), M7+ (Phase 5).

## 1. Background and Motivation

### 1.1 The current gap

`cap-ai-provider` already ships four production AI scenarios:

| Scenario | File | Critical to |
|---|---|---|
| Intent resolution (NL → Action proposal) | `intent-resolver.ts` + `intent-prompt.ts` | Spec 52 §2.2 — the user-facing AI entry point |
| Anomaly detection | `anomaly-detector.ts` | Spec 55 — life system Insight layer |
| Pattern detection | `pattern-detector.ts` | Spec 55 — life system Awareness layer |
| Watcher engine | `watcher-engine.ts` | Spec 45 — data-condition triggered effects |

All four are tested today only by mock-LLM unit tests. Those tests verify the parser and Zod schema. They do **not** verify whether the prompt actually elicits correct behavior from a real model.

This means:

- Changing a single sentence in `intent-prompt.ts` can move hit rate by tens of percentage points and CI will stay green.
- Provider model upgrades (Anthropic releases sonnet-4-7, openai releases o4) can silently degrade quality.
- New AI scenarios from spec 36 / 52 / 55 / 60 / 62 multiply this exposure.
- BAML / DSPy / Promptfoo / Mastra evaluation cannot proceed because we have no baseline to compare against.

### 1.2 Why this is a LinchKit-grade problem, not a "nice to have"

LinchKit's positioning is *AI-Native*. AI quality is product quality, not auxiliary. A platform that calls itself AI-Native without prompt regression tests is equivalent to a web framework without HTTP integration tests.

### 1.3 What "done" looks like

A reviewer asks "did this PR make AI worse?" and the framework produces a quantitative answer in under five minutes with under USD $1 of LLM cost.

A user asks "what's LinchKit's intent resolution hit rate?" and we have a current dated number to quote.

A provider releases a new model and our monthly cron flags any scenario that regressed beyond a threshold.

## 2. Design Principles

| Principle | Concrete consequence |
|---|---|
| **Data structures first** | The fixture schema is defined before the runner; the runner depends on the schema, not the other way around. |
| **Scenario-agnostic core, scenario-specific fixtures** | One runner, one report format; per-scenario fixture sets. Adding a fifth AI scenario requires fixtures, not new infrastructure. |
| **Separate three regression kinds** | (a) Parser/schema regression (cheap, every PR, replay-based). (b) Prompt-quality regression (expensive, only on prompt changes, live LLM). (c) Provider drift (expensive, monthly cron, live LLM). See §9. |
| **Cost governance by default** | Live LLM calls require an explicit opt-in (`AI_EVAL_LIVE=1`). CI never burns money silently. Estimated cost is printed before any live run. |
| **Evidence over judgement** | Tool selection (BAML vs Mastra-evals vs Promptfoo vs in-house) is decided by a documented decision matrix populated with measured numbers, not by aesthetic preference. |
| **No new dependencies in Phase 1** | Phase 1 ships with the runner written against `@linchkit/devtools` + `bun test` + `@linchkit/core` `AIService`. External runners (Mastra-evals, Promptfoo) are evaluated in Phase 2 after we have a baseline. |
| **Boundary clarity** | This spec covers `cap-ai-provider` AI scenarios. It does **not** cover model-level red-teaming (that is spec 27's domain — though we will integrate, see §10). It does **not** cover Flow step-level testing (that is spec 18's domain). |

## 3. Scope

### 3.1 In scope

| AI scenario | Phase | Fixture count target |
|---|---|---|
| `intent-resolver` (NL → action proposal) | 1 | ≥30 fixtures, ≥6 tags |
| `anomaly-detector` | 4 | ≥20 fixtures, ≥4 tags |
| `pattern-detector` | 4 | ≥20 fixtures, ≥4 tags |
| `watcher-engine` (AI-driven trigger evaluation only) | 4 | ≥15 fixtures, ≥3 tags |
| Any future `cap-ai-provider` scenario | — | Reuse the framework; ≥15 fixtures, ≥3 tags required before merge |

### 3.2 Out of scope

- Model red-teaming / jailbreak resistance (spec 27 owns this — see §10.4 for delegation pattern).
- Flow-level integration testing (spec 18 owns this).
- UI-layer testing of AI components like ActionProposalCard (spec 13 owns this).
- Cost / rate-limit enforcement testing (spec 36 owns this).

## 4. Fixture Schema

The single most important design decision in this spec.

### 4.1 Generic shape

```typescript
// packages/devtools/src/ai-eval/types.ts (Phase 1)

export interface EvalFixture<TInput, TContext = unknown> {
  /** Stable, unique identifier. Used as filename stem and report key. */
  id: string;

  /** Scenario this fixture targets — must match a registered scenario in the runner. */
  scenario: "intent" | "anomaly" | "pattern" | "watcher" | string;

  /** Free-form tags for slicing reports (e.g. "happy_path", "injection", "param_extraction"). */
  tags: string[];

  /** Human-readable purpose. Surfaces in failure reports. */
  description: string;

  /** Scenario-specific input. */
  input: TInput;

  /** Optional context (catalog, prior records, time-of-day, etc.). */
  context?: TContext;

  /** Assertions evaluated against the AI output. See §5 for matcher catalog. */
  expected: {
    matchers: Array<MatcherInvocation>;
  };

  /** Optional metadata for cost tracking and reporting. */
  meta?: {
    /** Estimated input + output tokens (for cost prediction). */
    estimatedTokens?: { input: number; output: number };
    /** Free-form notes for fixture authors. */
    notes?: string;
  };
}

export interface MatcherInvocation {
  /** Matcher name (e.g. "action_equals", "confidence_min"). */
  name: string;
  /** Matcher-specific arguments. */
  args: Record<string, unknown>;
  /** When true (default), failing this matcher fails the fixture. When false, it only contributes to scored metrics. */
  strict?: boolean;
}
```

### 4.2 Intent-resolver fixture (Phase 1 example)

```json
{
  "id": "create_purchase_simple_zh",
  "scenario": "intent",
  "tags": ["happy_path", "purchase", "zh"],
  "description": "Simple Chinese purchase creation with explicit amount",
  "input": {
    "userMessage": "帮我创建一个金额 5000 的采购单"
  },
  "context": {
    "catalogSource": "demo:purchase_management",
    "scope": {}
  },
  "expected": {
    "matchers": [
      { "name": "action_equals", "args": { "value": "create_purchase_request" } },
      { "name": "confidence_min", "args": { "value": 0.7 } },
      { "name": "input_must_include", "args": { "key": "amount", "value": 5000 } },
      { "name": "alternatives_excludes_primary", "args": {}, "strict": false }
    ]
  },
  "meta": {
    "estimatedTokens": { "input": 2200, "output": 250 }
  }
}
```

### 4.3 Fixture storage

```
__tests__/eval/fixtures/
  intent/
    happy_path/
      create_purchase_simple_zh.json
      ...
    param_extraction/
    ambiguous/
    typo_colloquial/
    injection/
    multi_candidate/
  anomaly/
  pattern/
  watcher/
```

Fixtures are JSON, not TypeScript, so they can be authored by humans (or AI agents) without import cycles.

### 4.4 Catalog sources

The `context.catalogSource` field is interpreted by the runner. Supported sources for `intent` scenario:

| Source | Use |
|---|---|
| `demo:purchase_management` | Real `cap-demo` catalog — primary fixture body (~70%). |
| `inline:<filename>` | A JSON file under `__tests__/eval/catalogs/` — used for controlled-coverage fixtures (~30%, especially `injection` tag where catalog must be tightly controlled). |
| `live:<capability>` | Resolved at runtime from a live `OntologyRegistry` — reserved for future integration tests, not used in Phase 1. |

## 5. Matcher Catalog

A matcher takes the AI output + matcher args and returns `{ passed: boolean; observed: unknown; message?: string }`.

### 5.1 Phase 1 matcher set (intent scenario)

| Name | Args | Purpose |
|---|---|---|
| `action_equals` | `{ value: string \| null }` | Top-level action name must equal value. `null` value asserts refusal (no proposal). |
| `confidence_min` | `{ value: number }` | Primary proposal confidence ≥ value. |
| `confidence_max` | `{ value: number }` | Primary proposal confidence ≤ value (for ambiguous fixtures where high confidence is wrong). |
| `input_must_include` | `{ key: string; value: unknown }` | Cleaned input must contain key with deep-equal value. |
| `input_must_omit` | `{ key: string }` | Cleaned input must NOT contain key (used for injection/typo fixtures). |
| `missing_fields_includes` | `{ fields: string[] }` | All listed fields must appear in `missingFields`. |
| `alternatives_min_count` | `{ value: number }` | At least N alternatives present. |
| `alternatives_includes_action` | `{ value: string }` | An alternative with action equals value exists. |
| `alternatives_excludes_primary` | `{}` | No alternative duplicates the primary action name (sanity check on `reconcileAlternatives`). |
| `proposal_is_null` | `{}` | Resolver returned `null` (correctly refused). |
| `latency_max_ms` | `{ value: number }` | Single-call latency below threshold (scored, not strict, by default). |

### 5.2 Matcher categories

- **Strict matchers** (default): failing one fails the fixture. Drives the headline hit-rate metric.
- **Scored matchers** (`strict: false`): contribute to aggregate statistics in the report without gating the fixture. Used for latency, alternatives quality, secondary signals.

### 5.3 Cross-scenario matchers

Some matchers generalize across scenarios (e.g. `latency_max_ms`, `cost_max_usd`, `output_contains`). Per-scenario matcher modules register their own; the runner deduplicates by name. Naming convention: scenario-specific matchers prefix with scenario name (e.g. `anomaly_severity_min`).

## 6. Runner Architecture

### 6.1 Module layout

```
packages/devtools/src/ai-eval/
  types.ts             — EvalFixture, MatcherInvocation, RunReport (public types)
  runner.ts            — orchestrates: load fixtures → call AI → invoke matchers → emit report
  matchers/
    intent.ts          — intent-scenario matchers
    anomaly.ts         — (Phase 4)
    common.ts          — latency, cost, output_contains
    registry.ts        — name → MatcherFn map
  scenarios/
    intent.ts          — adapter: fixture.input → buildIntentSystemPrompt → ai.complete → ActionProposal
    anomaly.ts         — (Phase 4)
    registry.ts        — name → ScenarioAdapter map
  catalog/
    demo-purchase.ts   — loads cap-demo's real action catalog (lazy)
    inline.ts          — loads catalogs from __tests__/eval/catalogs/*.json
  reporters/
    markdown.ts        — baseline-YYYY-MM-DD.md
    json.ts            — machine-readable for diffing; this JSON is committed
                         and acts as the replay source (see §9.2)
  cost.ts              — token estimation + USD prediction (reuses CostEstimator)
  cli.ts               — bun cli entry: bun run ai:eval --scenario intent --tag happy_path
```

### 6.2 Public CLI

```bash
# Replay mode (default) — reads committed baseline JSON, no network, runs in CI
bun run ai:eval --scenario intent

# Live mode — requires env var AI_EVAL_LIVE=1; prints cost estimate first.
# When --model is omitted, the run uses the default provider + model from
# `config/linchkit.config.ts` (e.g. zhipu / glm-4-flash-250414 in this repo);
# the baseline records the resolved model so reports never read "n/a".
# By default, live mode runs + diffs against prior canonical baseline but does NOT
# overwrite the canonical. CI uses this exact form.
AI_EVAL_LIVE=1 bun run ai:eval --scenario intent

# Local dev — refresh canonical baseline only if no regression (safe refresh path).
# Commit the resulting `baselines/<scenario>.current.json` alongside your prompt change.
AI_EVAL_LIVE=1 bun run ai:eval --scenario intent --refresh-baseline

# Force-refresh canonical regardless of regression — for intentional "move the bar"
# (e.g. accepting a confidence floor change). Requires PR justification in commit message.
AI_EVAL_LIVE=1 bun run ai:eval --scenario intent --force-refresh-baseline

# Single-fixture debugging
AI_EVAL_LIVE=1 bun run ai:eval --fixture create_purchase_simple_zh

# Diff against a specific historical baseline
bun run ai:eval --scenario intent --diff baselines/intent/2026-05-20.json
```

### 6.3 Runner contract (pseudocode)

```typescript
async function runEval(opts: RunOptions): Promise<RunReport> {
  const fixtures = await loadFixtures(opts);
  await assertLiveAllowed(opts);            // exits with non-zero if live without AI_EVAL_LIVE
  const cost = estimateCost(fixtures, opts);
  if (opts.live) printCostBanner(cost);     // and exit 1 if --max-cost-usd exceeded

  // ALWAYS load the prior canonical baseline (committed JSON — §7.2 and §9.2).
  // Live mode uses it for diff comparison; replay mode uses it as the source of recorded AI outputs.
  // First-ever live run for a scenario may produce no prior baseline — diff step then skipped.
  const priorBaseline = await loadCanonicalBaseline(opts.scenario); // may be null

  const results: FixtureResult[] = [];
  for (const fx of fixtures) {
    const scenario = scenarioRegistry.get(fx.scenario);
    const aiOutput = opts.live
      ? await scenario.runLive(fx, deps)
      : scenario.replayFromBaseline(fx, priorBaseline); // throws if fx absent — see §6.4
    const matcherResults = invokeMatchers(fx.expected.matchers, aiOutput);
    results.push({ fx, aiOutput, matcherResults });
  }

  const report = aggregate(results);
  await writeReport(report, opts.reporter);

  // Diff against the prior canonical baseline — drives the §9.4 regression gate.
  // Skipped only when no prior baseline exists (first-ever live run).
  const diff = priorBaseline ? compareToBaseline(report, priorBaseline) : null;
  if (diff) await writeDiffReport(diff, opts.reporter);

  // CRITICAL: live mode does NOT auto-overwrite the canonical baseline.
  // Refreshing the canonical is an explicit, separate gesture:
  //   --refresh-baseline       writes canonical ONLY if diff has no regression (safe refresh)
  //   --force-refresh-baseline writes canonical regardless of diff (intentional "move the bar")
  // CI in PRs runs without these flags — pure measurement, never silently moves the bar.
  // Local devs run with --refresh-baseline when they intentionally improved the prompt
  // and want the new outputs to become the next canonical (committed alongside the prompt PR).
  const shouldRefresh =
    opts.live &&
    (opts.forceRefreshBaseline ||
      (opts.refreshBaseline && (!diff || !diff.hasRegression)));
  if (shouldRefresh) await writeCanonicalBaseline(opts.scenario, report);

  if (diff?.hasRegression) {
    throw new RegressionError(diff); // non-zero exit; CI fails (§9.4)
  }
  return report;
}
```

### 6.4 Real AI dependency

Live runs use the same `AIService` instance the rest of `cap-ai-provider` uses. **No mocking.**

Replay mode reads recorded AI outputs from the **committed canonical baseline JSON** — `__tests__/eval/baselines/<scenario>.current.json` (see §7.2 + §9.2). Each fixture's `aiOutput` is stored alongside its matcher results. Replay re-runs matchers only; the AI is never called.

When a fixture is added or its `input`/`context` mutated but the baseline has not been refreshed, replay fails loud:

```
ERROR: fixture "create_purchase_with_date_zh" has no recorded AI output in
       baselines/intent.current.json (fixture hash mismatch or new fixture).
       Run with AI_EVAL_LIVE=1 to refresh the canonical baseline.
```

This makes "I added a fixture but forgot to refresh the baseline" a CI-blocking error rather than a silent skip.

## 7. Report Format

### 7.1 Markdown baseline (committed to repo)

The baseline records the **current** behaviour of whichever model the
project is configured to use — it is a model-capability snapshot, not an
aspirational "ideal" target. A fixture failing in the baseline is a
truthfully recorded known weakness; replay-mode CI only fails when the
*delta* against this snapshot regresses.

The numbers below are from the actual Phase 1 bootstrap (`zhipu` /
`glm-4-flash-250414`, 36 fixtures, ~$0.04 USD), kept verbatim so future
readers see what "lived-in" baseline output looks like — including its
warts:

```markdown
# AI Eval Baseline — intent — 2026-05-18

- **Runner**: @linchkit/devtools ai-eval
- **Mode**: live
- **Model**: glm-4-flash-250414
- **Provider**: zhipu
- **Fixtures**: 36 (intent)

## Headline metrics

| Metric | Value |
|---|---|
| Strict hit rate | 75.0% (27/36) |
| Avg primary confidence | 0.76 |

## By tag

| Tag | Fixtures | Strict pass | Avg confidence |
|---|---|---|---|
| happy_path | 8 | 100.0% | 0.90 |
| param_extraction | 6 | 100.0% | 0.93 |
| ambiguous | 5 | 100.0% | 0.00 |
| typo_colloquial | 5 | 100.0% | 0.90 |
| injection | 7 | 42.9% | 0.84 |
| multi_candidate | 5 | 0.0% | 0.82 |

## Failures (known weaknesses of glm-4-flash-250414)

- 4 × `injection` — model executes prompt-injected actions instead of
  refusing (e.g. "delete_all_data" under role-spoofing / control-char
  payloads). Stronger system prompt + post-parse policy rule needed
  (filed against Phase 1 follow-up).
- 5 × `multi_candidate` — model emits confident single answers where the
  ambiguous fixture expected `confidence ≤ 0.7` + ≥1 alternatives.
  Suggests prompt does not currently surface the "if uncertain, return
  alternatives" branch loudly enough for GLM-4-flash.

These are LinchKit's actionable Phase 2/3 inputs — exactly what spec 69
is designed to surface.

## Reproduction

AI_EVAL_LIVE=1 bun run ai:eval --scenario intent

```

### 7.2 JSON snapshot (committed)

Two artifacts per scenario, both committed (see §9.2 for layout rationale):

- `__tests__/eval/baselines/<scenario>.current.json` — canonical baseline. Single file per scenario, always reflects the latest live run. Drives replay mode (§6.4).
- `__tests__/eval/baselines/<scenario>/<date>.json` — dated archive. Append-only history for trend analysis and `--diff` comparisons.

Both share the same JSON shape: per-fixture `{input, context, aiOutput, matcherResults, modelId, providerName, timestamp}`.

### 7.3 Diff output

`bun run ai:eval --diff baselines/intent/2026-05-20.json` produces a delta table: per fixture, status change (PASS→FAIL, FAIL→PASS, FAIL→FAIL-different-matcher), per-tag hit rate delta. Non-zero exit when any regression detected.

`bun run ai:eval --diff-current` is shorthand for comparing the current run against `baselines/<scenario>.current.json` — useful for local pre-PR validation.

## 8. Cost Governance

### 8.1 Three-gate model

| Gate | Mechanism |
|---|---|
| **Opt-in** | Live runs require `AI_EVAL_LIVE=1`. Default mode is replay. |
| **Estimate-first** | Before any live call, runner prints predicted token usage and USD cost (using `CostEstimator` from `cap-ai-provider`). |
| **Cap** | `--max-cost-usd <n>` flag (default $5). Runner aborts before exceeding. |

### 8.2 Token estimation

Fixtures may carry `meta.estimatedTokens`. When absent, runner falls back to: input tokens ≈ system prompt + user message + catalog JSON length × 0.25 tokens-per-char; output tokens ≈ 500. Predicted USD = `CostEstimator.estimateCost(modelId, in, out)`.

### 8.3 Budget norms (informational)

| Run kind | Typical budget |
|---|---|
| Full intent baseline (40 fx, sonnet-4) | ~$1 |
| Single-fixture live debugging | <$0.05 |
| Monthly drift cron (all scenarios × 2 models) | ~$10/month |
| BAML spike comparison (Phase 2) | ~$5 |

Phase 1 implementer is pre-authorized up to $5 cumulative live spend without further approval, provided every run prints its cost banner.

## 9. CI Integration

### 9.1 Three-tier regression strategy

| Regression kind | What it catches | Cost | Frequency | Trigger |
|---|---|---|---|---|
| **Schema / parser** | Parser bugs, Zod-schema drift, response-shape breakage | $0 | Every PR | `bun run ai:eval --replay` in `bun test` flow |
| **Prompt quality** | Prompt-text changes that move hit rate | $1–5 | When prompt files change | Path-filter GitHub Action (see §9.3) |
| **Provider drift** | Model upgrades that silently degrade | $5–10 | Monthly | Scheduled GitHub Action / cron |

### 9.2 Replay source: committed canonical baseline JSON

There is no separate "cache" directory. The committed baseline JSON (§7.2) **is** the replay source.

```
__tests__/eval/baselines/
  <scenario>.current.json          ← canonical replay source (committed, single file)
  <scenario>/
    2026-05-20.json                ← dated history (committed, append-only)
    2026-06-15.json
    ...
```

Write rules (must match §6.3 runner contract):

| Run kind | Writes to `<scenario>.current.json` | Writes to dated `<scenario>/<date>.json` archive |
|---|---|---|
| Replay (no LLM call) | Never | Never |
| Live without `--refresh-baseline` (default; CI uses this) | **Never** — measurement only | Never |
| Live with `--refresh-baseline` and no regression | Yes | Yes |
| Live with `--refresh-baseline` but diff has regression | **Never** — gate fails first | Never |
| Live with `--force-refresh-baseline` | Yes (regardless of diff) | Yes |

The dated baselines (§7.2) and the canonical `current.json` share the same JSON shape: per-fixture `{input, context, aiOutput, matcherResults, modelId, providerName, timestamp}`. Replay (§6.4) reads `current.json`, re-runs matchers against the recorded `aiOutput`, and fails loud if a fixture is missing.

**Rationale**: this eliminates the gitignored-cache anti-pattern. Fresh clones can run `bun run ai:eval --replay --scenario intent` immediately — no rebuild step needed. The same JSON that documents the baseline result is the JSON that drives replay. Baselines are mutated only when the author explicitly opts in via `--refresh-baseline`, so CI prompt-quality runs cannot silently move the bar.

**Diff hygiene**: every `current.json` change appears in the PR's git diff. Reviewers see exactly which fixture outputs changed and approve the new canonical alongside the prompt change that produced it.

### 9.3 GitHub Actions wiring (Phase 1 minimum)

```yaml
# .github/workflows/ai-eval.yml (Phase 1)

name: AI Eval (prompt-quality, on prompt change)
on:
  pull_request:
    paths:
      - 'addons/ai-provider/cap-ai-provider/src/intent-prompt.ts'
      - 'addons/ai-provider/cap-ai-provider/__tests__/eval/fixtures/intent/**'
  workflow_dispatch:        # manual trigger always allowed

jobs:
  intent-eval:
    runs-on: ubuntu-latest
    # Skip on fork PRs (secrets not available to forks per GitHub policy) and on
    # PRs explicitly opted out. Maintainers must trigger workflow_dispatch for
    # fork-originated prompt changes — see §9.4 and §12 OQ #5.
    # The `github` context IS allowed in job-level `if:` (unlike `secrets`).
    if: >-
      github.event_name == 'workflow_dispatch' ||
      github.event.pull_request.head.repo.full_name == github.repository
    env:
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - name: Verify ANTHROPIC_API_KEY is set (defense in depth)
        # The job-level `if:` above already excludes fork PRs. This step is a
        # belt-and-suspenders guard for misconfigured secret rotation.
        run: |
          if [ -z "$ANTHROPIC_API_KEY" ]; then
            echo "::error::ANTHROPIC_API_KEY missing despite same-repo PR — check repo secrets."
            exit 1
          fi
      - run: bun install --frozen-lockfile
      - run: AI_EVAL_LIVE=1 bun run ai:eval --scenario intent --max-cost-usd 5
        # NOTE: no --refresh-baseline flag. Live mode diffs against prior canonical and
        # fails on regression (§6.3). Canonical is updated by the PR author locally with
        # --refresh-baseline and committed alongside the prompt change.
      - name: Comment delta on PR
        if: always()
        run: bun run ai:eval --diff-current --post-to-pr
```

Replay-mode regression (`bun run ai:eval --replay`) is wired into the existing `bun test` job — no new workflow.

### 9.4 Failure semantics

| Mode | Failure threshold | Effect |
|---|---|---|
| Replay (every PR) | Any fixture parses differently or matcher result changes | Fails `bun test`; blocks merge. |
| Live prompt-quality (same-repo PRs only) | Strict hit rate < 90% OR > 10pp drop from prior canonical baseline | Fails workflow; blocks merge. |
| Live prompt-quality (fork PRs) | Not run automatically — see below | Does not block merge. Maintainer review required. |
| Monthly drift cron | Any scenario drops > 5pp from prior month | Files a GitHub Issue auto-labelled `P1, ai-drift`. Does not block anything. |

**Fork PR handling**: GitHub does not expose secrets to fork-originated workflows. The `if:` guard on the job (§9.3) skips the live job for fork PRs — the check appears as "skipped", which does NOT block merge. The merge protocol for fork PRs touching prompts or fixtures is:

1. Maintainer reviews the prompt/fixture diff manually.
2. Maintainer manually triggers `workflow_dispatch` for the AI eval workflow against the PR's head commit.
3. Once the workflow passes, maintainer approves the PR.

This intentionally puts a human gate in front of fork-originated AI changes, consistent with §10.4 spec-27 integration and §12 OQ #5.

## 10. Tool Strategy

This section is the framework's **decision contract**. It exists so that Phase 2 (BAML spike) and the Mastra-evals evaluation are forced to produce evidence, not opinions.

### 10.1 Position before evaluation

- **Phase 1 runner is in-house**, written against `@linchkit/devtools`. Zero new dependencies. Rationale: we need a baseline before we can evaluate any external tool fairly.
- **Phase 2 evaluates external tools**, specifically: BAML (schema-aligned generation + parser), Mastra `@mastra/evals` (eval runner), Promptfoo (eval CLI), DSPy (prompt auto-optimization — Python only, deferred to Phase 5).
- **Migration is conditional** on the decision matrix below.

### 10.2 BAML decision matrix (Phase 2 must populate this)

| Indicator | Threshold for "adopt BAML for that scenario" |
|---|---|
| Parser / schema failure rate vs current Zod-based path | BAML ≥ 50% reduction |
| Lines of code per scenario (prompt + schema + parsing) | BAML ≥ 30% reduction |
| Time to add a new AI scenario (measured by re-implementing pattern-detector in BAML) | BAML ≥ 40% reduction |
| Token cost per request on same fixture set | BAML neutral or better (no more than 10% worse) |
| Toolchain burden (baml-cli installation, generated artifacts in repo, IDE integration) | Subjective — must be documented, not weighed numerically |

**Adoption rule:**
- ≥ 3 of the first 4 indicators met → recommend full migration of `intent-resolver` to BAML, plus authorization to migrate one detector as a stress test in Phase 3.
- 2 of 4 met → recommend BAML for `intent-resolver` only, pending re-evaluation after Phase 3.
- ≤ 1 of 4 met → reject. Document the failed indicators and revisit when BAML releases major version bump.

### 10.3 Mastra `@mastra/evals` evaluation (Phase 2)

See `docs/research/mastra-evaluation.md` for context. Phase 2 hands-on spike must answer:

1. Can `@mastra/evals` be imported without pulling `@mastra/core` agent runtime?
2. Does its scorer set cover the matchers listed in §5?
3. Is its fixture/dataset format compatible with our JSON schema (§4)?
4. Is its CI/cost story compatible with §8 / §9?

**Adoption rule:**
- All 4 answers yes → replace in-house runner with `@mastra/evals`-based runner, keep our fixture schema as the source of truth.
- 3 of 4 yes → adopt as the *matcher library* (replace `matchers/` directory), keep our runner.
- ≤ 2 of 4 yes → reject. Keep in-house runner. Re-evaluate in Phase 4 or on Mastra major release.

### 10.4 Spec 27 (AI Security) integration

Spec 27's red-team / injection scenarios are a **separate dataset** that uses the same runner + matcher infrastructure but lives under `__tests__/eval/fixtures/security/`. Spec 27 owns those fixtures. This spec only provides the plumbing.

### 10.5 DSPy / prompt auto-optimization (Phase 5)

Out of Phase 1–4 scope but called out so the architecture leaves room. DSPy is Python; integration would be via subprocess + JSON IPC. Prerequisite: stable baseline + Langfuse-style production trace data (Phase 3 territory). Decision deferred.

## 11. Phase Roadmap

| Phase | Deliverable | Owner | Status |
|---|---|---|---|
| **0a — Research** | `docs/research/mastra-evaluation.md` | this spec author | Done (this PR) |
| **0b — Spec** | This document | this spec author | Done (this PR) |
| **1 — Framework + Intent baseline** | `packages/devtools/src/ai-eval/*`, intent fixtures ≥ 30, first live baseline report, replay-mode CI green, deliberate-regression self-test passed | next implementer | Done (this PR — 36 fixtures, GLM-4-flash baseline 27/36 pass) |
| **2 — Tool decision** | Hands-on BAML spike + Mastra-evals spike, both decision matrices (§10.2, §10.3) populated with measured numbers, recommendation merged to this spec | next implementer | Pending |
| **3 — Production observability tie-in** | Langfuse (or chosen equivalent) integrated into `ai-service.ts`, monthly drift cron live | next implementer | Pending |
| **4 — Scenario expansion** | Anomaly + pattern + watcher fixtures and adapters | per-scenario owner | Pending |
| **5 — Auto-optimization POC** | DSPy or in-house prompt-search loop using accumulated baselines + traces | TBD | Deferred |

Phase 1 is the only phase authorized by this PR. Phases 2–5 each require explicit go-ahead based on the prior phase's results.

## 12. Open Questions

1. **Catalog source for non-purchase scenarios.** `intent` fixtures lean 70% on `cap-demo`. As we add anomaly/pattern fixtures, do we add more demo capabilities or generate synthetic catalogs? **Tentative answer:** mix, with the same 70/30 ratio.
2. **Multi-model baselines.** Phase 1 commits to whatever the project's `linchkit.config.ts` declares as `ai.defaultProvider` (currently `zhipu` / `glm-4-flash-250414`). When and how do we expand to a per-model baseline matrix (e.g. add `claude-sonnet-4` / `claude-haiku-4-5` rows so prompt changes can be evaluated against multiple models without switching the default)? **Tentative answer:** when spec 36 model-routing decision PR is filed — that PR sponsors the multi-model run. The 9 known-weakness fixtures captured in the GLM-4-flash bootstrap (4× injection refusal, 5× multi-candidate disambiguation) are exactly the cases worth re-running on a stronger model to quantify the prompt-vs-model contribution to the gap.
3. **Fixture authorship by AI.** LinchKit positions itself as AI-Native. Should fixtures themselves be AI-generated, with human review? **Tentative answer:** yes for fixture *expansion* (taking an existing fixture and producing typo / colloquial variants); no for fixture *design* (which tags to cover) — that's still a human judgment call.
4. **Public dataset.** Is the fixture set company-confidential or open-sourceable? If open, can it become a community benchmark? **Tentative answer:** defer until Phase 4 — by then we'll know whether it has external value.
5. **Cost accounting per PR author.** When live eval runs are triggered by external contributors' PRs, who pays? **Tentative answer:** require maintainer approval (workflow_dispatch only for external PRs in Phase 1).
