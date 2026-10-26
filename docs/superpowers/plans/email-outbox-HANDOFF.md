# Email outbox — hand-off to the next session

Written 2026-10-26 at the end of phase 3 wave 1 (PR #1035). The next session owns everything below: waves 2–5 and
phase 4. Read this first, then the documents it names.

## Where things stand

| Part | State |
|---|---|
| Phase 1 (#1008), follow-ups FU1–3 (#1009–#1011) | Merged |
| Phase 2 (#1016) | Merged |
| Phase 3 wave 1 (#1035) | 7 kinds on the outbox: `magic_link`, `chess_invite`, `registration_confirmation`, `payment_reminder`, `registration_promoted`, `refund_issued`, `solo_signup_assigned`. Migration `V472`. |
| Phase 3 wave 2 | Planned: `docs/superpowers/plans/2026-10-26-email-outbox-phase3-wave2.md` (10 money kinds). Not started. |
| Phase 3 waves 3–5 | Outlined at the end of `docs/superpowers/plans/2026-10-25-email-outbox-phase3-wave1.md` (Next waves). Wave 5 deletes `send()` / `sendWithResult` and empties the scan's allowlist. |
| Phase 4 | **PARKED (owner, 2026-10-26)**, together with the in-app QStash dispatch option (phase-4 plan, PARKED section), until a trigger: email volume, a security review wanting the Resend key out of the app, or a second sender. Plan: `docs/superpowers/plans/2026-10-26-email-service-phase4.md`. Owner-approved roadmap: `docs/superpowers/specs/2026-10-26-email-service-phase4-note.md` (separate repo + Fly app, shared DB, QStash carries only the row id). Starts after wave 5. |

Spec of record for phase 3: the one named at the top of the wave-1 plan.

## Owner rules that bind every wave (2026-10-26)

These came from the owner in chat during wave 1. They are the owner's words to that session; confirm with the owner
before relying on any of them for something new.

- **Mainstream paths only.** Do not design, build or test rare/extreme cases: a misconfigured server (the KEK is set on
  stg and prod), a provider outage, narrow races, a fact changing while a row waits in retry. Record them in one line;
  fix only if money or data is lost or a secret's value leaks.
- **No time on non-product tooling.** No probe rigs, differential harnesses or scanner hardening beyond what the plan
  names. Review findings that only harden test tooling are parked.
- **Batch same-shape tasks.** Several per-kind moves of the same shape go to one implementer and one review, one commit
  per kind (wave 1 did T9–T12 this way).
- **Changed while queued.** A queued row is a frozen snapshot. Each kind's task states in one line which body facts can
  change while it waits and what refreshes it (re-enqueue → supersede, or cancel). Code or a test only when the change is
  a common one. Wave 2's plan carries this as a Global Constraint.
- Merges, stg operations and prod need the owner's explicit go. e2e runs only by CI dispatch
  (`gh workflow run e2e.yml --ref <branch> -f pr=<n>`), never locally. Scoped tests only, never the full suite.

## Open owner questions (wave 2 — ask before T2)

1. **Q1** — reword `sponsors.order.sent` in 4 locales so it is true while the invoice is still retrying. Recommendation:
   yes (wave-2 plan, Owner questions).
2. **Q2** — which owner gets owner-addressed notices in a multi-owner org. Recommendation: the oldest current owner,
   never a deleted account.
3. **P-W2-1 / P-W2-2** — wave 1's owner "Ok" accepted the P4 exception (submit and promotion enqueue after commit, on the
   pool). Does it also cover the sponsor invoice and refund? Recommendation: yes, same reasoning. Ask; do not assume.

## Owner approvals that are NOT yet carried out

- **Prod Resend webhook.** The owner approved adding `email.delivered`, `email.delivery_delayed` and `email.suppressed` to
  the PROD Resend webhook, only when the outbox reaches prod. Stg already has them. Confirm with the owner at that time.
- **Stg walk.** The owner said they will walk wave 1 on stg later. Not done yet.

## Parked (recorded, not built)

Wave 1, product:
- An organiser resend that supersedes a still-queued submit confirmation carries no Checkout or full-token links (entries
  and total only). Better than before, when a failed first send was lost.
- A withdrawal (whole or partial) or a payment that lands while a mail waits in provider-outage retry does not cancel
  it: confirmation, reminder, promotion and assignment can send stale. Rare by owner ruling.
- `reg.remind.sent` / `reg.remind.notSent` are rendered nowhere (`/registrations/:id/remind` is API-only), and the
  OpenAPI summary does not say `sent:false` now means "queued, retrying".
- Public resend shows the honest "couldn't resend" when the mail has not gone out. A local server with no Resend key
  always shows it.
- `withdrawal.ts` `cancelSettledBoardInvites` opens a `withTenant` transaction even for an empty fixture list (every
  cascade withdrawal, every sport). Add an early return.
- Dispute evidence renders in the D4 locale, not pick-or-en (negligible).

Wave 1, test tooling (parked by owner rule): the no-second-path scanner misses `obj.prop = await import(...)`,
`Promise.all([import(...)])`, `export const ns = await import(...)` and `return import(...)`, and its vi.mock-factory
spread exception accepts any returned object inside a factory. No production dynamic import of `@/lib/email` exists.

Routed pre-existing defects (not email work, found while planning wave 2):
- `sponsors.ts` `handleSponsorDispute` (~849–856): a replayed `won` for an OLDER dispute clears a NEWER dispute's flag
  and re-activates the placement.
- Every replay of a registration dispute `created` writes another `registration.disputed` audit row.

## Process notes

- Subagent-driven development, one workspace per plan under `.superpowers/sdd/` (gitignored). Each subagent cannot
  write report files; paste its report into the workspace.
- Wave 1 used Sonnet implementers/reviewers per task and an Opus whole-branch review; check `docs/superpowers/RULES.md`
  and `.claude/agents/*.md` for the current model rules rather than this line.
- Migration numbers: wave 2 takes main's max + 1 at its T0; W2d (another programme) also allocates numbers.
- The kind sweep and the no-second-path scan live in `apps/web/src/server/email-outbox/__tests__/` (`_kind-harness.ts`,
  `_kind-senders.ts`). Moving a kind = set its map entry to null, drop it from `NOT_YET_MOVED`, remove its `send*` from
  `SENDER_ALLOWLIST`, add its sweep scenario. The allowlist length is derived — never edit a number.
- Tests that stage a claim use `claimQueuedRow` (`email-outbox/attempt.ts`); never hand-copy the claim SQL.
