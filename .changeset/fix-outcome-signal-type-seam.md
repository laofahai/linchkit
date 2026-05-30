---
"@linchkit/core": patch
---

Fix the recorder↔verifier signal-type mismatch that silently broke the Spec 55
§7.7 effect-verification loop. `ProposalOutcomeRecorder` emitted outcome signals
with dot-delimited types (`proposal.outcome.<outcome>`) while
`ProposalEffectVerifier` (and the rest of the life-system) queries the
colon-delimited convention (`proposal:outcome:merged`). Because
`InMemoryMemoryStore.getSignals` matches `Signal.type` by exact equality, the
verifier never saw recorded merged outcomes, so the §7.7 effect-verification →
rollback-insight → rollback-proposal loop never fired. The recorder now emits
`proposal:outcome:*` (colons) to match the verifier's query and the repo-wide
signal-type convention.
