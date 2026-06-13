---
"@linchkit/core": patch
---

Fix Phase-1 proposal validation rejecting `sourcePatch`-carrying rule updates as `MISSING_DEFINITION` (#566). A "say→change an existing code-condition rule's threshold" proposal carries a definition-less change whose `sourcePatch` IS the specification (value-validated at assembly, re-validated by the patcher at graduation). Phase 1 now skips the definition requirement for such a change — like `revert`/`delete` — so the governed draft can reach the approval gate and graduate. Without this, every natural-language rule-threshold update failed Phase 1 and was unapprovable (the resolver produced a correct proposal that could never be approved). Caught by live testing of the chat-assistant approval flow.
