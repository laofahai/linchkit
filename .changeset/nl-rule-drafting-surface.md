---
"@linchkit/cap-adapter-ui": minor
---

Add a natural-language rule-drafting surface ("说→有"). A new `resolveSchemaIntent` API client and `NlRuleDrafter` component (mounted on the Evolution page) let users describe a rule in natural language; the server mints a governed draft Proposal that flows into the existing human-gated review pipeline. The surface renders every outcome state (draft / clarification / no_match / unavailable / error) and never submits, approves, or applies.
