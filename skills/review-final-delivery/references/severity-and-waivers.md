# Severity and waivers

| Severity | Meaning | Default action |
|---|---|---|
| P0 | security exploit, data loss, wrong product or unusable critical path | block |
| P1 | correctness defect, major compatibility/accessibility gap, unreliable delivery evidence | block |
| P2 | maintainability, bounded edge case or non-critical performance issue | fix or tracked follow-up |
| P3 | optional improvement | non-blocking |

A waiver needs finding ID, owner, reason, scope, compensating control and an explicit-timezone expiry.
The complete clause must already exist under the same finding ID as a `[RISK_WAIVER]` in the
human-approved canonical Spec. Agent OS derives the approval timestamp and evidence reference from
that Spec ID/version/hash; text, a URL or metadata invented in a later Gate is not approval. Agents
cannot self-waive, invent an owner or generate a default expiry. Expired, undeclared or
broader-than-requested waivers are invalid.
Keep waived findings visible and mark the workflow approved-with-waiver rather than cleanly approved.
