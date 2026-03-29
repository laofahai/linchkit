# LSP Integration for AI Code Generation in Self-Evolution

**Task:** linchkit-b341
**Agent:** builder-lsp-report / lead-lsp-research
**Date:** 2026-03-29

---

## 1. Executive Summary

LSP (Language Server Protocol) provides semantic code understanding — type information, symbol references, diagnostics, completions — that would dramatically improve AI code generation quality in LinchKit's self-evolution system (Spec 55). Instead of AI generating code blindly, LSP gives the AI "eyes" to see the codebase type structure, catch errors immediately, and navigate symbols precisely.

Key finding: The most practical path for LinchKit is a hybrid approach — using the TypeScript Compiler API directly (via ts-morph or ts.createLanguageService) for deep semantic analysis during Proposal generation, while optionally supporting LSP for multi-language scenarios in the future.

---

## 2. Background: Why LSP Matters for Self-Evolution

### 2.1 The Problem

Spec 55 defines the evolution cycle: Sense → Memory → Awareness → Insight → Proposal. At the Proposal layer (§7), AI translates Insights into executable `defineXxx()` TypeScript code. Today, this AI generation is "blind" — it doesn't know:
- What types exist in the codebase
- What functions are available and their signatures
- Whether generated code has type errors
- How generated code relates to existing code

### 2.2 What LSP Provides

| LSP Capability | Value for Code Generation |
|----------------|--------------------------|
| Diagnostics | Instant type-error detection after AI generates code |
| Completions | AI can query valid completions at a cursor position |
| Go-to-Definition | Resolve what a symbol actually is (type, function, etc.) |
| Find References | Understand impact of changes across the codebase |
| Hover | Get type information for any symbol |
| Document Symbols | Get the structure of a file (classes, functions, exports) |
| Workspace Symbols | Search for symbols across the entire project |
| Code Actions | Get suggested fixes for diagnostics |
| Rename | Safely rename symbols with all references updated |
| Semantic Tokens | Fine-grained token classification |

### 2.3 Industry Validation

- **Claude Code** shipped native LSP support in Dec 2025 — diagnostics after every edit, semantic navigation, type-aware understanding
- **Serena** (MCP tool already configured in this project) uses LSP via multilspy for symbol-level code analysis across 40+ languages
- **OpenCode** ships with 30+ pre-configured language servers, auto-initializing per project
- **LSPRAG** (NeurIPS paper) uses LSP + Tree-sitter for language-agnostic unit test generation
- Performance data: "Finding all call sites of a function takes ~50ms with LSP vs ~45 seconds with recursive text search — a 900x improvement."

---

## 3. Technical Options

### 3.1 Option A: Programmatic LSP Client (via stdio/JSON-RPC)

How it works: Spawn a language server process (e.g., `typescript-language-server --stdio`) and communicate via JSON-RPC over stdio.

Available libraries:
- `vscode-languageserver-protocol`: Microsoft official LSP type definitions + JSON-RPC (High maturity)
- `vscode-jsonrpc`: Low-level JSON-RPC transport (High maturity)
- `ts-lsp-client`: Standalone LSP client, minimal dependencies (Medium maturity, v1.1.1)
- `multilspy` (Python): Serena LSP wrapper — synchronous Python calls (High maturity, battle-tested)

Transport options: stdio (most common), TCP sockets, named pipes, node IPC.

**Pros:**
- Language-agnostic — works with any LSP-compliant server
- Standard protocol — large ecosystem of servers
- Incremental updates — `textDocument/didChange` for efficient re-analysis
- Matches industry direction (Claude Code, Cursor, etc.)

**Cons:**
- Process management overhead (spawn, initialize, shutdown)
- Startup latency (~1-3 seconds for typescript-language-server)
- Memory overhead (~100-300MB for TypeScript server on large projects)
- Async communication adds complexity
- Limited to what LSP protocol exposes (can't access TypeScript compiler internals)

### 3.2 Option B: TypeScript Compiler API Directly

How it works: Use `ts.createLanguageService()` or `ts.createProgram()` in-process.

Available libraries:
- `typescript` (native API): Direct compiler access via `ts.createLanguageService()`, `ts.createProgram()` — Maximum control, in-process
- `ts-morph`: Higher-level wrapper over TS compiler API — Programmatic code manipulation + analysis

Key capabilities of `ts.createLanguageService()`:
- `getCompletionsAtPosition()` — completions
- `getDefinitionAtPosition()` — go-to-definition
- `findReferences()` — find all references
- `getSemanticDiagnostics()` — type errors
- `getQuickInfoAtPosition()` — hover/type info
- `getEmitOutput()` — single-file emit
- Shared `DocumentRegistry` for memory efficiency

Key capabilities of `ts-morph`:
- Navigate AST with clean API (`sourceFile.getClasses()`, `classDecl.getMethods()`)
- Programmatic code manipulation (add/remove/modify nodes)
- Type checker access (`node.getType()`, `type.getText()`)
- Find references, get implementations, rename symbols
- Create new source files from scratch

**Pros:**
- No process spawn — runs in-process with Bun
- Full access to TypeScript internals (type checker, AST, symbol table)
- Lower latency — direct function calls
- Can do things LSP can't (custom type analysis, AST manipulation)
- `ts-morph` makes code generation + modification natural
- LinchKit is TypeScript-only — no need for multi-language support

**Cons:**
- TypeScript-only (but LinchKit IS TypeScript-only)
- Tighter coupling to TypeScript compiler version
- Must manage file system host manually

### 3.3 Option C: TypeScript 7 / tsgo Native LSP

**Status (March 2026):** TypeScript 7.0 stable released Jan 2026. The `tsgo` compiler (written in Go) delivers 7-10x build speedups. LSP support is being shipped as opt-in VS Code extension in early-to-mid 2026.

Relevance: `tsgo` uses standard LSP protocol (not custom TSServer protocol). This means future-proof standard, dramatically faster type checking (VSCode codebase: 89s → 8.7s). But still in preview for editor support; API not yet stable for programmatic use.

**Recommendation:** Monitor `tsgo` LSP readiness. Not ready for production integration yet, could replace Option A in ~6 months.

### 3.4 Option D: Tree-sitter (AST-only, no types)

How it works: Fast incremental parsing via Tree-sitter grammars. Returns AST nodes but NO type information.

**Pros:** Extremely fast (~1ms parse), incremental, multi-language.
**Cons:** No type information, no semantic analysis, no diagnostics.

**Verdict:** Useful complement (fast AST queries) but insufficient alone for code generation validation.

---

## 4. Recommended Architecture

### 4.1 Hybrid Approach: ts-morph + Optional LSP

```
Proposal Layer (Spec 55 §7)

Insight → AI generates defineXxx() code
     ↓
CodeIntelligenceService
├── ts-morph: validate types, check imports,
│   resolve symbols, verify schema compatibility
├── Diagnostics: run type checker on generated code
├── Impact analysis: find references to changed types
└── Code manipulation: safe AST-level modifications
     ↓
Validated Proposal (type-safe, import-resolved)
```

### 4.2 Why ts-morph over LSP for LinchKit

1. **LinchKit is TypeScript-only** — no need for language-agnostic LSP protocol
2. **In-process execution** — no spawning, no JSON-RPC overhead, direct function calls
3. **Code generation is a first-class use case** — ts-morph is built for creating/modifying TS files
4. **Proposal validation** — can run full type checker on generated code in-process
5. **Already in the ecosystem** — ts-morph is a standard npm package, works with Bun
6. **Richer API** — direct AST access + type checker > what LSP protocol exposes

### 4.3 Integration Points with Life-System

| Life-System Layer | Integration |
|-------------------|-------------|
| **Sense** | New `code_structure` signal source — detect when `defineXxx()` patterns change, monitor import graph health |
| **Awareness** | Structural self-check (§5.4) enhanced — use ts-morph to verify: unused exports, circular dependencies, type inconsistencies across capabilities |
| **Insight** | Structural insights with type-level evidence — e.g. "Field `supplier_contact` has type `string` but is always assigned a `Supplier` record ID — consider changing to `ref` type" |
| **Proposal** | **PRIMARY integration point** — validate generated `defineXxx()` code: type-check, resolve imports, verify schema compatibility, check for breaking changes |

### 4.4 Concrete Integration: Proposal Validation Pipeline

```typescript
// Conceptual — not implementation code
interface CodeIntelligenceService {
  // Validate a Proposal's generated code
  validateProposal(code: string, targetFile: string): Promise<{
    diagnostics: Diagnostic[];
    isValid: boolean;
    suggestions: string[];
  }>;

  // Analyze impact of a Proposal
  analyzeImpact(changes: FileChange[]): Promise<{
    affectedFiles: string[];
    breakingChanges: BreakingChange[];
    dependencyGraph: DependencyNode[];
  }>;

  // Provide context for AI code generation
  getGenerationContext(targetSchema: string): Promise<{
    availableTypes: TypeInfo[];
    existingPatterns: CodePattern[];
    imports: ImportInfo[];
  }>;

  // Post-generation: verify and fix
  verifyAndFix(generatedCode: string): Promise<{
    fixed: string;
    remainingIssues: Diagnostic[];
  }>;
}
```

### 4.5 Where LSP Still Makes Sense

Even with ts-morph as primary, LSP has a role:
- **Serena MCP** (already configured) — agents exploring the codebase use LSP via Serena for symbol navigation
- **Future multi-language** — if LinchKit ever supports capabilities in other languages, LSP becomes necessary
- **tsgo migration path** — when TypeScript 7 native LSP stabilizes, could replace in-process `ts.createLanguageService`

---

## 5. Implementation Roadmap

### Phase 1: ts-morph Foundation (M3, alongside Sense layer)
- Add `ts-morph` as a dependency
- Create `CodeIntelligenceService` interface in core types
- Implement basic Proposal validation: parse generated code, run type checker, report diagnostics
- Integrate with structural self-check (Awareness §5.4)

### Phase 2: AI Generation Context (M4, alongside Insight layer)
- Build `getGenerationContext()` — feed AI with type information, available symbols, existing patterns
- Implement impact analysis for Proposals
- Auto-fix common issues (missing imports, wrong types)

### Phase 3: Full Proposal Pipeline (M5, alongside Proposal layer)
- End-to-end: Insight → AI generates code → ts-morph validates → auto-fix → present to user
- Back-testing with type-level analysis
- Breaking change detection

### Phase 4: tsgo/LSP Migration (M6+, when tsgo LSP stabilizes)
- Evaluate tsgo LSP for performance gains
- Optional: abstract `CodeIntelligenceService` to support both ts-morph and LSP backends

---

## 6. Risk Assessment

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| ts-morph performance on large projects | Low | LinchKit capabilities are modular, each small; use `DocumentRegistry` for sharing |
| TypeScript compiler version coupling | Medium | Pin TS version; ts-morph handles version abstraction |
| tsgo breaking changes | Low | Deferred to Phase 4; not a dependency until stable |
| Memory usage of in-process type checker | Low-Medium | Lazy initialization; dispose after Proposal validation |
| AI-generated code too broken for type checker | Medium | Pre-validate syntax with Tree-sitter before ts-morph; provide structured templates |

---

## 7. Comparison Matrix

| Criterion | ts-morph (recommended) | LSP Client | tsgo LSP | Tree-sitter |
|-----------|----------------------|------------|----------|-------------|
| Type information | Full | Full | Full | None |
| Code generation | Native | Not designed for | Not designed for | Not designed for |
| Startup time | ~0 (in-process) | 1-3s | TBD | ~0 |
| Memory | Shared with host | Separate process | Separate process | Minimal |
| Multi-language | TypeScript only | Any LSP server | TypeScript only | Any grammar |
| Maturity | High | High | Preview | High |
| Bun compatibility | Yes | Yes (stdio) | TBD | Yes (WASM) |
| AST manipulation | Yes | No | No | Read-only |
| LinchKit fit | Excellent | Good | Future | Complement |

---

## 8. References

- ts-lsp-client: https://github.com/ImperiumMaximus/ts-lsp-client
- vscode-languageserver-node: https://github.com/microsoft/vscode-languageserver-node
- Serena: https://github.com/oraios/serena
- LSP-AI: https://github.com/SilasMarvin/lsp-ai
- ts-morph: https://github.com/dsherret/ts-morph
- TypeScript Language Service API: https://github.com/Microsoft/TypeScript/wiki/Using-the-Language-Service-API
- TypeScript Compiler API: https://github.com/microsoft/TypeScript-wiki/blob/main/Using-the-Compiler-API.md
- typescript-go: https://github.com/microsoft/typescript-go
- LSP: The Secret Weapon for AI Coding Tools: https://amirteymoori.com/lsp-language-server-protocol-ai-coding-tools/
- LSPRAG: https://arxiv.org/html/2510.22210v1
- Give Your AI Coding Agent Eyes: https://tech-talk.the-experts.nl/give-your-ai-coding-agent-eyes-how-lsp-integration-transform-coding-agents-4ccae8444929
