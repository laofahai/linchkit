# Promptfoo Evaluation — CLI Eval Harness Comparison

> Research doc. Snapshot date: 2026-05-19.
> Companion to: [spec 69](../specs/69_ai_evaluation_framework.md).
> Phase 2a deliverable (documentation review).

## 1. Why we are evaluating Promptfoo

Spec 69 §10.1 names Promptfoo alongside BAML and `@mastra/evals` as a Phase 2 candidate. Promptfoo is the most mature open-source LLM eval CLI by adoption (~14k GitHub stars, active 2026-05 releases). The Phase 2 question: does Promptfoo provide enough of spec 69's runner/baseline/CI machinery for free that we should replace `@linchkit/devtools/ai-eval` with a Promptfoo wrapper?

## 2. Current state (2026-05)

| Aspect | Finding |
|---|---|
| Latest version | `promptfoo@0.121.11` (2026-05-08) — 2–3 releases/week |
| License | MIT |
| Authoring | YAML default; tests also accept JSON, JSONL, CSV, TS/JS |
| Runtime model | **CLI tool** (`bunx promptfoo eval`), not a library you import |
| Provider abstraction | **Own provider layer** — does NOT wrap Vercel AI SDK |
| Provider support | OpenAI / Anthropic / Bedrock / Vertex / Azure / Ollama / many; **OpenAI-compat** via `apiBaseUrl` field → covers zhipu/GLM |
| Bun support | `engines: node ^20.20.0 \|\| >=22.22.0`; pure-JS, no native deps; bun runs it but undocumented |
| Caching | First-class HTTP cache at `~/.cache/promptfoo` — recommended as the cost-saver story |
| Cost guard | Per-assertion `cost` threshold; no global hard budget kill-switch I could verify |
| Output formats | JSON report, **JUnit XML** (added 0.121.10, 2026-05-07), CSV, HTML viewer (`promptfoo view`), GitHub Action with PR comments |

### Assertion coverage vs spec 69 §5.1 matchers

Promptfoo ships **55+ assertion types** as of 2026-05. Mapping to LinchKit's 11 intent-resolver matchers:

| LinchKit matcher | Promptfoo equivalent | Native support? |
|---|---|---|
| `action_equals` | `javascript` extracting + comparing field, or `equals` after JSON projection | Via predicate |
| `confidence_min` / `confidence_max` | `javascript` | Via predicate |
| `input_must_include` | `contains` (string) / `contains-all` (array) | Native (limited) |
| `input_must_omit` | `not-contains` | Native |
| `missing_fields_includes` | `javascript` or `contains-all` | Via predicate |
| `alternatives_min_count` | `javascript` | Via predicate |
| `alternatives_includes_action` | `javascript` | Via predicate |
| `alternatives_excludes_primary` | `javascript` | Via predicate |
| `proposal_is_null` | `equals: null` or `javascript` | Native |
| `latency_max_ms` | `latency` (first-class!) | **Native** |

**Coverage assessment**: Most map cleanly via `javascript` predicates rather than dedicated assertion types. You lose the declarative purity of named matchers (`alternatives_includes_action(action_name)` becomes a one-liner JS arrow), but everything is expressible.

### Output format vs spec 69 §9.2 canonical baseline

Promptfoo's JSON report is per-eval-run, organized as `results[] = { vars, prompt, response, assertions[], passed }`. It is **not designed as a long-lived canonical baseline that subsequent runs diff against**; it's designed as a one-shot test report. Spec 69's pattern (commit `<scenario>.current.json`, replay against it on every PR, fail on delta) does not map directly. You could simulate it by checking the JSON report into git + writing a separate diff script — but at that point you've recreated `@linchkit/devtools/ai-eval`'s `BaselineDiff` logic on top of Promptfoo's output.

### Provider drift risk

Promptfoo invokes its **own** OpenAI / Anthropic / etc. clients, not Vercel AI SDK. If `cap-ai-provider` ships custom retry / fallback / tenant-config / cost-estimator logic (it does), Promptfoo evals run *parallel to* that pipeline, not *through* it. A bug in `cap-ai-provider`'s `executeWithFallback` would not show up in a Promptfoo eval. This is a **structural mismatch** for spec 69's goal of regression-testing the production pipeline.

By contrast, spec 69 Phase 1's intent-scenario adapter calls **production `resolveIntent`** directly (validated as R1-P1 fix in PR #353), so the eval exercises the actual code path that ships.

## 3. Integration shape if we adopt

**Option A — Full replacement** (replace `@linchkit/devtools/ai-eval` runner with Promptfoo wrapper):
- Pro: Get JUnit XML, HTML viewer, PR-comment GitHub Action for free
- Pro: Get HTTP cache + per-assertion cost thresholds
- Con: Lose direct call to production `resolveIntent` (parallel provider stack)
- Con: Lose declarative baseline-as-canonical-JSON pattern; rebuild it on top of Promptfoo output
- Con: Lose typed matcher signatures (`IntentMatchers` registry); fall back to `javascript:` predicates
- Con: Adds CLI dependency (`promptfoo`) + YAML config + new test format for contributors

**Option B — Hybrid** (keep our runner, adopt Promptfoo's output formats / CI artifacts):
- Add `--report-junit` flag to our CLI emitting Promptfoo-style JUnit XML
- Add a `promptfoo-style HTML viewer` adapter that reads our canonical JSON
- Cherry-pick Promptfoo's HTTP-cache idea into our runner if we ever go beyond replay-only CI
- No new runtime dependency; we inherit the *patterns* without the *coupling*

**Option C — Reject** (stay in-house):
- Promptfoo's wins (cache, JUnit, HTML viewer) are reproducible in <300 LOC if we ever need them
- Spec 69's pattern (canonical baseline JSON + matcher registry + production-pipeline-direct adapter) is architecturally cleaner for our use case than Promptfoo's one-shot-report model
- Eliminates the provider-drift risk

## 4. Phase 2a verdict (research-only)

**Recommend Option C — reject as primary runner. Hands-on Phase 2b spike NOT required.** Three structural mismatches make Promptfoo the wrong tool for spec 69's specific goal:

1. **Tests parallel pipeline, not production pipeline.** Promptfoo's value proposition is "test prompts independently of your app code." Spec 69's value proposition is the opposite: "test that the production `resolveIntent`/`detect-anomaly`/etc. functions don't regress." Adopting Promptfoo would weaken the regression guarantee that PR #353 just shipped.

2. **Report-not-baseline output model.** Promptfoo emits per-run reports; spec 69 hinges on a long-lived canonical baseline JSON with `BaselineDiff` semantics. The mapping is awkward.

3. **Matcher coverage via `javascript` predicates is a downgrade.** Our typed `MatcherRegistry<IntentEvalOutput>` is a deliberate design — matchers compose, are reusable across scenarios, and have testable signatures. Falling back to free-form JS predicates loses that.

**Selectively borrow** (Option B candidates, file as follow-up issues if/when needed):

- **JUnit XML emitter** — small, useful for non-GitHub CI integrations (file when first such integration is requested)
- **HTTP cache layer** — only needed if we ever run non-replay live evals routinely in CI (we don't; spec §9.3 is workflow_dispatch-only)
- **HTML viewer** — only needed if reviewers want graphical baseline diffing (defer until ask)

None of these are urgent. The current `markdown.ts` + `json.ts` reporters cover the actual asks (PR-readable + machine-diffable).

## 5. What this means for spec 69 §10

Spec 69 §10.1 lists Promptfoo as one of three Phase 2 candidates. This doc recommends **collapsing the §10 evaluation to BAML only** — the only candidate where adoption is plausible enough to justify a hands-on spike (Phase 2b). Mastra-evals is rejected on documentation review (see [`mastra-evaluation.md`](./mastra-evaluation.md) §7). Promptfoo is rejected on documentation review (this doc).

Phase 2b becomes: **"hands-on BAML spike for `intent-resolver`, measured against the Phase 1 GLM-flash baseline."** Two of three candidates closed without burning live LLM budget.

## Sources

- `promptfoo@0.121.11` manifest — `registry.npmjs.org/promptfoo/latest`
- Promptfoo releases — `github.com/promptfoo/promptfoo/releases`
- Expected outputs / assertion catalog — `promptfoo.dev/docs/configuration/expected-outputs/`
- Test cases / JSON authoring — `promptfoo.dev/docs/configuration/test-cases/`
- OpenAI provider config — `promptfoo.dev/docs/providers/openai/`
- GitHub Action integration — `promptfoo.dev/docs/integrations/github-action/`
