# Mastra Evaluation — Strategic Posture for LinchKit

> Research doc. Snapshot date: 2026-05-18.
> Companion to: [spec 69](../specs/69_ai_evaluation_framework.md).

## 1. Why we are looking at Mastra

Mastra (mastra-ai/mastra, $35M total raised including a $22M Series A in Apr-2026, 22k+ GitHub stars, 300k+ weekly npm downloads at 1.0) is the closest existing TypeScript framework to LinchKit's AI layer. Before we invest in our own `AIEvaluationFramework` (spec 69) we must answer:

1. **Is Mastra a substitute for what we're building?** If yes, adopt — don't reinvent.
2. **Is Mastra a substitute for LinchKit?** If yes, our positioning is wrong and that's a strategic question, not a technical one.
3. **Can we adopt parts of Mastra without inheriting its philosophy?** Granularity matters.

This doc answers all three.

## 2. Capability overlap matrix

| Concern | Mastra | LinchKit | Verdict |
|---|---|---|---|
| Language / runtime | TypeScript, Node + Bun | TypeScript, Bun-only | Compatible |
| LLM provider abstraction | `@mastra/core` agent runtime, 40+ providers | `cap-ai-provider` over Vercel AI SDK | **Overlap** — both wrap providers |
| Durable workflow | Own workflow engine (graph-based, checkpoint/resume); also integrates Inngest / Vercel Workflows for long pauses | Restate (`cap-flow-restate`) | **Overlap, but LinchKit chose Restate deliberately** |
| Tool definition | `tool()` API + MCP sharing | `defineAction()` + CommandLayer pipeline | **Different semantics** — Mastra has no permission slot, no Proposal pipeline |
| Memory / RAG | Built-in conversation memory, semantic recall, Memory Gateway product | `cap-vector-pgvector` + spec 55 life system (Sense/Memory/Awareness/Insight/Proposal) | **Different scope** — LinchKit's life system is meta-modeling, not just RAG |
| Evals | `@mastra/evals` — scorers (textual/classification/prompt-engineering), trace evals, CI hooks | **None yet — this is what spec 69 is for** | **Direct overlap** |
| Telemetry | OpenTelemetry traces, metrics, logs | Spec 28 observability stack | **Overlap** — both OTel-based |
| Agent runtime | `Agent` class with built-in loops | Action + Rule + State + Flow composes "agentic" behavior via meta-model | **Philosophically different** |
| Entity / Rule / State meta-model | **None** | Core | **LinchKit's moat** |
| Proposal → Validation → Approval governance | **None** | Spec 09 + 22 + 27 | **LinchKit's moat** |
| Capability hub / OCA addon model | **None** (mastra is a single framework, not a platform) | Spec 01 / 21 / 57 | **LinchKit's moat** |
| License | Apache 2.0 (core) + Mastra Enterprise (in `/ee/`) | (LinchKit license decision pending) | Mastra core is permissive enough to depend on |

### What this matrix says

- **Mastra is not a substitute for LinchKit.** Mastra has no Entity/Rule/State/Proposal model. It's an *agent framework*; LinchKit is an *AI-Native business runtime*. Different layer.
- **Mastra IS a substitute for parts of `cap-ai-provider`.** Specifically: the agent runtime layer (which `cap-ai-provider` does NOT have yet), and the eval module (which we are about to build).
- **Mastra is NOT a substitute for LinchKit's intent-resolver, anomaly-detector, pattern-detector, watcher-engine** — those are domain-specific orchestrators wired into spec 52 / 55 / 45, which Mastra does not understand.

## 3. Reusable components (granular)

Mastra is modular (`@mastra/core`, `@mastra/evals`, etc. published independently on npm). We can adopt at the package level without inheriting the framework.

### 3.1 `@mastra/evals` — direct candidate for spec 69

**Pros:**
- Existing scorers (textual, classification, prompt-engineering) save us writing matchers from scratch.
- Trace-eval pattern (score historical agent traces) aligns with spec 28 observability — could close the loop production → eval.
- Actively maintained, well-funded.

**Cons / unknowns:**
- Fixture format unclear from docs — needs hands-on spike.
- Couples to `@mastra/core` agent abstractions? Needs verification — if so, we'd be importing the framework through the back door.
- Apache 2.0 is fine; `/ee/` enterprise pieces are not. Need to confirm `@mastra/evals` is fully Apache 2.0.

**Decision posture:** **Evaluate hands-on during spec 69 Phase 2 (tool decision), not Phase 1.** Spec 69 §10.1 and §11 keep Phase 1 dependency-free so a baseline exists before any external runner is benchmarked against it. Phase 2 then runs the hands-on spike against the Phase 1 baseline, populates the decision matrix in spec 69 §10.3, and either replaces or keeps the in-house runner based on measured fit. This sequencing prevents picking a runner before we know what "good" looks like.

### 3.2 Mastra workflow engine — pass

LinchKit committed to Restate (spec 23). Mastra's workflow engine is a competitor to Restate, not a complement. No reason to switch.

### 3.3 Mastra memory / RAG — pass

Spec 55 (life system) defines LinchKit's memory layer at a higher abstraction (insight → proposal). Mastra's session memory is below that. `cap-vector-pgvector` (spec issue #165, just landed) already covers the vector store primitive. No gap to fill.

### 3.4 Mastra agent runtime — defer

LinchKit doesn't have an "agent runtime" today. Whether we ever need one is an open question — current position is that the meta-model (Action + Rule + Flow) composes agentic behavior without a dedicated agent abstraction. If we ever decide we need one, Mastra is a viable building block. Until then: pass.

### 3.5 Mastra MCP integration — already covered

`cap-adapter-mcp` already does MCP. No gap.

## 4. Strategic implications

### 4.1 Mastra validates LinchKit's bet

A $22M Series A on "TypeScript AI framework with workflows, memory, evals, telemetry as cohesive primitives" is a strong signal that the market believes this is the right shape. LinchKit's bet on a TypeScript-first AI runtime is not contrarian — it's increasingly mainstream.

### 4.2 LinchKit's differentiation must be sharpened

Mastra's existence makes "LinchKit is a TypeScript AI framework" insufficient as positioning. LinchKit's actual differentiation:

1. **Meta-modeling (Entity + Action + Rule + State + ...)** — Mastra has none of this. LinchKit lets you define business semantics, not just agent behavior.
2. **Governance pipeline (Proposal → Validation → Approval)** — Mastra has none. LinchKit treats every AI-driven change as a reviewable artifact.
3. **Life system (Sense → Memory → Awareness → Insight → Proposal)** — Mastra has scattered observability + memory, not a coherent evolution model.
4. **Capability ecosystem (OCA addons, hub, ontology)** — Mastra is a single framework, LinchKit is a platform for capabilities.

**Spec 70+ should reinforce these four** — anything that doesn't strengthen the moat is at risk of being commoditized by Mastra.

### 4.3 Risk: Mastra becomes the default `cap-ai-provider`

If a competing capability `cap-mastra-provider` emerges that exposes Mastra agents through CommandLayer, it might be more attractive than our hand-rolled intent-resolver / anomaly-detector / pattern-detector for users who want a richer agent model.

**Mitigation:** That outcome is OK. LinchKit's "Everything is a Capability" stance means alternative AI providers are a feature, not a threat. As long as the core meta-model + governance pipeline remains LinchKit's, swapping the AI engine underneath is fine.

## 5. Recommendation (binding for spec 69)

| Question | Answer |
|---|---|
| Adopt Mastra wholesale as our AI layer? | **No.** Mastra is at a lower abstraction; doesn't replace our meta-model. |
| Drop spec 69 because Mastra has `@mastra/evals`? | **No.** Spec 69 defines the framework + governance contract; the runner *implementation* is a separate decision. |
| Allow spec 69 to *use* `@mastra/evals` as the runner? | **No** (revised 2026-05-19 per §7 below). Original disposition was "Yes, conditionally pending Phase 2 spike"; Phase 2a documentation review hard-rejected on structural grounds (`@mastra/core` peerDep + wrong scoring paradigm). |
| Bring in Mastra's agent runtime / workflow / memory? | **No.** Direct overlap with Restate / life system / vector store — those choices are deliberate and load-bearing. |
| Reposition LinchKit messaging in response to Mastra? | **Yes — separate task.** Spec 70+ and any user-facing materials should foreground meta-model + governance + life system + capability hub, not "TypeScript AI framework." |

## 6. Open follow-ups

1. **License audit** — confirm `@mastra/evals` license + whether it transitively pulls `/ee/` enterprise code.
2. **Hands-on `@mastra/evals` spike** — owned by spec 69 Phase 2 implementer (after Phase 1 baseline lands).
3. **Positioning refresh** — separate doc/issue, not blocking.
4. **`cap-mastra-provider` exploratory issue** — file as P3, "evaluate when first user asks."

---

## 7. 2026-05-19 Phase 2 update — `@mastra/evals` REJECTED

Phase 2 documentation review hard-rejected `@mastra/evals` as a runner candidate. Hands-on spike is **not needed** — the rejection comes from `@mastra/evals@1.2.2`'s own package.json:

```json
"peerDependencies": {
  "zod": "^3.25.0 || ^4.0.0",
  "@mastra/core": ">=1.0.0-0 <2.0.0-0"
}
```

The package is structurally bound to the Mastra agent runtime. Its documented import path is `"@mastra/core/evals"`, and `runEvals(target, ...)` takes a Mastra `Agent` instance as `target`. **Adopting `@mastra/evals` means adopting Mastra, period** — which contradicts §3 of this doc (we explicitly do *not* want Mastra's agent runtime; LinchKit's meta-model + Restate + life system already cover that ground).

The scoring paradigm is also wrong shape for spec 69's contract. Built-in scorers as of 1.2.2 (`answer-relevancy`, `faithfulness`, `hallucination`, `completeness`, `toxicity`, `bias`, `content-similarity`, …) are LLM-judged or NLP-based 0..1 floats designed for *RAG quality measurement*. LinchKit's matchers are **field-level equality assertions** (`action_equals`, `confidence_min/max`, `input_must_include/omit`, …). Zero of the 11 spec 69 §5.1 matchers maps to a built-in Mastra scorer — every one would have to be reimplemented as a custom scorer on Mastra's harness, at which point we have rebuilt our matcher framework on top of Mastra while still dragging `@mastra/core` along.

§5's row 3 (above) is updated in-place to reflect the new "No" verdict; this section explains the rationale.

Sources for this section (2026-05-19):
- `@mastra/evals@1.2.2` manifest — `registry.npmjs.org/@mastra/evals/latest`
- `mastra.ai/docs/evals/overview`
- `mastra.ai/docs/evals/built-in-scorers`
- `mastra.ai/docs/evals/running-in-ci`

---

## Sources

- Mastra official framework page — fetched 2026-05-18
- Mastra GitHub README — `mastra-ai/mastra`, fetched 2026-05-18
- `@mastra/evals` docs — `mastra.ai/docs/evals/overview`, fetched 2026-05-18
- Mastra Series A coverage — `faq.com.tw/en/developer-tools/2026-04-10-mastra-22m-series-a-typescript-agents-en/`
- TypeScript Agent Frameworks 2026 survey — `everydev.ai/p/blog-typescript-agent-frameworks-in-2026-loop-runtime-sandbox`
