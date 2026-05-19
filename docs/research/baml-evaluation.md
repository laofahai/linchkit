# BAML Evaluation — Schema-Aligned Parsing for LinchKit

> Research doc. Snapshot date: 2026-05-19.
> Companion to: [spec 69](../specs/69_ai_evaluation_framework.md).
> Phase 2a deliverable (documentation review). Phase 2b (hands-on spike) tracks separately.

## 1. Why we are evaluating BAML

LinchKit's `cap-ai-provider` pipeline (intent-resolver, anomaly/pattern/watcher detectors) uses Vercel AI SDK's `generateObject` with Zod schemas. The Phase 1 baseline against `zhipu/glm-4-flash-250414` showed **27/36 strict-pass** with 9 known weaknesses, of which 4 were prompt-injection failures (model returned malformed-but-eventually-coercible JSON for `delete_all_data`) and 5 were multi-candidate disambiguation failures.

BAML (Boundary ML, `@boundaryml/baml`) claims a structurally different approach: **Schema-Aligned Parsing (SAP)** — the model is allowed to emit free-form output (markdown fences, trailing commas, unquoted strings, prose) and BAML computes the minimum-edit-distance reconstruction to the declared schema. If their published benchmark holds (https://boundaryml.com/blog/sota-function-calling claims 2–4× accuracy gains over OpenAI strict function-calling), SAP would directly address the GLM-flash JSON-quality problem.

Phase 2's binding question: **does SAP materially lift the 27/36 → some-better-N/36 baseline on the existing fixtures, and is the toolchain weight acceptable?**

## 2. Current state (2026-05)

| Aspect | Finding |
|---|---|
| Latest version | `@boundaryml/baml@0.222.0` (2026-04-27) — monthly cadence |
| License | Apache-2.0 |
| Architecture | Separate `.baml` DSL → `baml-cli generate` → typed `baml_client/` |
| Runtime | Rust-via-napi-rs node bindings; thin npm wrapper + platform binaries via `optionalDependencies` |
| Bun support | Documented (`bun add @boundaryml/baml`, `bun baml-cli generate`); `engines.node >= 10` only |
| Provider support | First-class: Anthropic (incl. Vertex), OpenAI, Bedrock, Vertex, Azure. **Generic OpenAI-compat** via `openai-generic` provider with `base_url` — covers zhipu/GLM, OpenRouter, Together, Groq, Ollama, etc. |
| Toolchain | Adds: `.baml` source files (commit), `baml_client/` (community convention: gitignore + regenerate on CI), `baml-cli generate` build step, VSCode/Zed extension recommended |
| Notable users | Zapier, Vercel, Trunk (publicly listed); blog-tier coverage in March 2026 |
| Hosted product | Boundary Studio (observability/tracing SaaS, opt-in via `BOUNDARY_API_KEY`) — core compiler/runtime is fully OSS without it |

### What SAP actually does (vs. Vercel AI SDK + Zod)

| Step | AI SDK + Zod | BAML SAP |
|---|---|---|
| Model invocation | `generateObject({ model, schema, prompt })` forces constrained decode (OpenAI strict mode / tool-use JSON) | Plain chat completion — model writes naturally |
| Parsing | `JSON.parse(output)` then `schema.parse(json)` — throws on malformed JSON or schema mismatch | Edit-distance reconstruction from any output (markdown, prose, partial JSON) to target schema |
| Failure recovery | None — re-prompt or retry needed | Built-in: parser fills in missing optional fields, coerces types, tolerates trailing commas / quotes / fences |
| Throughput cost | Constrained decode may slow some providers; for GLM the JSON-mode flag is non-standard | Free decode — generally faster, also Vercel's blog claims higher accuracy across providers |

The interesting claim: on **Anthropic models with strict tool-calling**, SAP measured 2–4× accuracy gains over OpenAI-format strict calling. That benchmark used Anthropic's own evaluation harness, so take with salt — but the *mechanism* (free decode → tolerant parser) plausibly helps weaker models more than strong ones. GLM-flash is a weak model, so the upside could be larger here than the benchmark suggests.

## 3. Integration shape if we adopt

**Minimum-invasive adoption path** (intent-resolver only):

1. New file `addons/ai-provider/cap-ai-provider/baml_src/intent.baml` declares the `IntentResolution` schema + the `ResolveIntent` function (prompt template + parameters).
2. Add `baml-cli generate` to `bun run build` and the `bun install` post-install hook (alternative: commit `baml_client/` and skip generation).
3. `intent-resolver.ts` replaces its `generateObject(...)` call with `b.ResolveIntent({ catalog, userMessage })` from the generated client.
4. Existing fixtures + matchers don't change at all — spec 69 evaluates a black-box `resolveIntent` regardless of internal implementation.
5. Run the spec 69 §10.2 matrix:
   - Re-run 36-fixture live eval against `zhipu/glm-4-flash-250414`. Record new strict-pass rate.
   - Diff: did the 4 injection-failure fixtures actually flip to refusal? Did the 5 multi-candidate failures gain alternatives? Diff against the canonical baseline at `addons/ai-provider/cap-ai-provider/__tests__/eval/baselines/intent.current.json`.

**Tax we pay if we adopt:**

- New build step (`baml-cli generate`) — blocks `bun install` on Phase-1-clean clones unless we commit `baml_client/`. Committing it adds large generated TS to PRs.
- `.baml` DSL is a new language for contributors to learn (small but real cost).
- Rust-via-napi runtime ships per-platform binaries (`@boundaryml/baml-darwin-arm64`, `-linux-x64-gnu`, etc.) — bun resolves `optionalDependencies` correctly, but CI matrices need each binary cached.
- New external dependency (one of the things CLAUDE.md flags as needing explicit approval).

**Tax we don't pay:**

- We do **not** rewrite `intent-resolver.ts`'s integration with `OntologyRegistry` / `AIService` / the spec 52 NL pipeline. BAML replaces the prompt+parse layer only.
- We do **not** touch spec 69's runner / matchers / fixtures / baselines. The black-box contract holds.
- We do **not** lose Anthropic / OpenAI portability — BAML supports both natively.

## 4. Decision matrix (provisional — Phase 2b populates measured cells)

This is the §10.2 matrix from spec 69, pre-populated where the answer is already determined and marked "pending" where hands-on measurement is required.

| Indicator | Threshold for "adopt for that scenario" | Provisional reading (2026-05-19) | Phase 2b measures |
|---|---|---|---|
| Parser / schema failure rate vs current Zod-based path | BAML ≥ 50% reduction | **Pending** — claim plausible per SAP benchmark; GLM-flash known to emit malformed JSON, so upside likely real but unmeasured | Run 36 fixtures, count "JSON parse / schema validation" exceptions in current pipeline vs BAML-rewritten pipeline |
| Lines of code per scenario (prompt + schema + parsing) | BAML ≥ 30% reduction | **Likely** — `.baml` consolidates prompt + schema + function signature; current pipeline splits these across `intent-prompt.ts` + `intent-resolver.ts` + Zod schema declarations | Count LOC in current `addons/ai-provider/cap-ai-provider/src/intent-{prompt,resolver}.ts` vs `intent.baml` + slim `intent-resolver.ts` wrapper |
| Time to add a new AI scenario (re-implement pattern-detector in BAML) | BAML ≥ 40% reduction | **Pending** — depends on how much the SAP / function-definition idiom matches our actual scenario shape (catalog-aware prompts) | Stopwatch a porting exercise; subjective +/- 30% noise tolerable |
| Token cost per request on same fixture set | BAML neutral or better (≤ 10% worse) | **Likely neutral** — free decode generally cheaper; SAP retries on parse failure could spike cost but with GLM-flash the per-request cost is already ~$0.0001 so noise is dominant | Compare baseline cost report ($0.04 for 36 fixtures, currently) to BAML cost report |
| Toolchain burden | Subjective; must be documented | **Moderate** — `.baml` DSL + codegen + Rust runtime + VSCode extension. Acceptable for a single capability but compounds if every capability adopts | Documented in this doc + Phase 2b spike notes |

### Adoption rule (from spec 69 §10.2, unchanged)

- ≥ 3 of first 4 indicators met → recommend full migration of `intent-resolver` + authorize one detector port as stress test in Phase 3
- 2 of 4 met → recommend BAML for `intent-resolver` only; reevaluate after Phase 3
- ≤ 1 of 4 met → reject; document failed indicators; revisit on BAML major bump

## 5. Phase 2a verdict (research-only)

**Recommend proceeding to Phase 2b hands-on spike on `intent-resolver`.** The asymmetry is favorable: if SAP delivers even half its claimed accuracy gain on GLM-flash, it would shift the baseline from 27/36 → 32+/36 by recovering the 4 injection-malformed-JSON fixtures alone. If it doesn't, the spike produces a measured "no" and the existing pipeline keeps running.

What needs explicit user approval before Phase 2b can start:

1. **Add `@boundaryml/baml` as a `cap-ai-provider` dependency** (per CLAUDE.md "new dependencies require explicit approval").
2. **Commit `baml_client/` or run `baml-cli generate` in CI** — pick one. Recommendation: commit (smaller CI surface, deterministic PRs); accept the generated-file noise.
3. **Estimated Phase 2b live eval cost**: ≤ $0.10 on GLM-flash (per spec 69 §8.3 pre-authorization).

## 6. Out of scope

- Migrating anomaly/pattern/watcher detectors to BAML — Phase 3 (`#350`) decides per-detector.
- Boundary Studio adoption — separate observability decision; spec 28 owns that surface.
- Anthropic / OpenAI BAML eval — those models already perform well on the existing pipeline; the GLM-flash gap is the motivating problem.

## Sources

- `@boundaryml/baml@0.222.0` manifest — `registry.npmjs.org/@boundaryml/baml/latest`
- BAML CHANGELOG — `github.com/BoundaryML/baml/blob/canary/CHANGELOG.md`
- Schema-Aligned Parsing blog — `boundaryml.com/blog/schema-aligned-parsing`
- SOTA Function Calling benchmark — `boundaryml.com/blog/sota-function-calling`
- TypeScript installation guide — `docs.boundaryml.com/guide/installation-language/typescript`
- OpenAI-generic provider — `docs.boundaryml.com/ref/llm-client-providers/openai-generic`
