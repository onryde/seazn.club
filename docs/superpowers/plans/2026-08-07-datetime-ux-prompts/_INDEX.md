# Date/time scheduling UX — prompt index

**Read this first.** Compaction-proof authority on what this programme
is, where its decisions live, and what order its prompts run in.

- **Design doc** (why, current-state findings, decisions):
  `docs/superpowers/specs/2026-08-07-datetime-scheduling-ux-design.md`
- **Full narrative plan** (this index's source):
  `docs/superpowers/plans/2026-08-07-datetime-scheduling-ux.md`
- **Project-wide standing rules — read this too**:
  `docs/superpowers/RULES.md`. Agent topology for every dispatch below:
  Scout=Sonnet High, Implementer=Sonnet xHigh, Reviewer=Sonnet xHigh.
  Every task ultimately owes all 4 test types (unit, E2E, smoke,
  regression) — Prompts 01-04, 07, 08 are unit+regression only because
  nothing new is E2E/smoke-visible yet at that point; **Prompt 09 is
  where cumulative E2E + smoke coverage for the whole feature set
  lands.**

## Standing rules for this programme

- Self-contained prompts — a subagent should not need to re-read this
  index or the design doc to execute one, though both are the right
  place to check *why* if something looks surprising.
- **Do NOT file new issues.** Fix inline or ask; escalate only if a fix
  would widen the blast radius past the prompt's stated files.
- Run each prompt's own verify command before considering it done.
- Output cap per prompt: final message under 15 lines.

## Execution order

```
01 (shared component) → 02, 03, 04 (three independent conversions to
that component — DIFFERENT files each, safe to parallelize if you want,
sequential is simpler) → 05 (board segmentation, independent of 02-04)
→ 06 (blackout editor UI, needs 01) → 07 (confirm blackout round-trip,
needs 06 — verification only, expect zero backend changes) → 08
(court-removal guard, independent of 06/07) → 09 (E2E + smoke, needs
02-08 all done — this is where the whole feature set becomes testable
together) → 10 (regression audit, needs 08 done — checks whether an
existing test's premise became stale)
```

## Status

| # | Prompt | State |
|---|---|---|
| 01 | Shared `DateTimeField` component | **done** — `dcbec661`, `615dd3ff` |
| 02 | Convert `division-builder.tsx` | not started |
| 03 | Convert `competition-wizard.tsx` | not started |
| 04 | Convert `settings-panel.tsx` | not started |
| 05 | Board segmentation (real gcd step) | not started |
| 06 | Blackout editor UI + fix broken pointer | not started |
| 07 | Confirm blackout round-trip (verification only) | not started |
| 08 | Court-removal guard | not started |
| 09 | E2E + smoke coverage | not started |
| 10 | Regression audit (`disruption-signals.test.ts`) | not started |

## Parallel execution

Safe to run alongside the sibling `2026-08-07-cpsat-service-prompts/`
programme in a SEPARATE worktree/branch — file sets are disjoint except
a soft overlap in `apps/web/src/dictionaries/*/ui.json` (this programme
adds blackout-editor/court-removal keys via Prompts 06/08; the other
adds one `cp-sat` engine-label key) — a merge-time conflict at worst,
not a live-clobber risk, as long as each runs in its own worktree
rather than the same working directory. Do not run both in the same
checkout simultaneously.

## Owner decisions — settled, do not re-ask

| Decision | Answer |
|---|---|
| Component strategy | Native inputs, componentized into ONE shared `DateTimeField` — no custom picker, no hybrid. Used everywhere including the blackout editor. |
| Board segmentation | Matches the backend's real `gcd(matchMinutes, gapMinutes)` step, not a snap-to-{15,30,60} display rule. Extracted into a SHARED helper (`packages/engine/src/scheduling/grid-step.ts`) both sides import, so they can't drift apart again. |
| Blackout editor scope | Supplements the AI natural-language console, does not replace it. Writes into the EXISTING `config.blackouts` field — confirmed by reading `schedule.ts:146-155`'s `usesConstraints()`, no new backend endpoint needed (Prompt 07 verifies this rather than Prompt 06 building something new). |
| Court-removal guard | Hard reject (not override-with-confirmation) when the removed court has pinned/frozen fixtures. Does not block removing a court whose fixtures are all unlocked — AUTO already relocates those correctly today. |
| Row height | No fixed value pre-committed — Prompt 05 decides via screenshot comparison at implementation time, per the design doc's own deferral. |

## False premises found during execution — do not re-derive

| Prompt | The plan said | What is actually true |
|---|---|---|
| 01 | `text-base sm:text-sm` is needed so iOS does not zoom on focus. | **False.** `globals.css` Pattern 5 (`@media (max-width:39.99rem){input,select,textarea{font-size:16px}}`) already forces 16px repo-wide; measured identical at 375px with and without. `sm:text-sm` only shrank the control to 14px/38px on **desktop**, beside `.input` siblings at 16px/42px — breaking the "styled identically to the division-wizard inputs" criterion the component exists for. Dropped in `615dd3ff`; the test asserts its **absence**. Do not re-add it in Prompts 02-04/06. |
| 01 | Test with `@testing-library/react` + `screen.getByLabelText`; component uses `useId`/`htmlFor`. | **Not available.** `apps/web` has no jsdom and no `@testing-library` (vitest `environment: "node"`) — that suite cannot collect. Repo convention is `renderToStaticMarkup` + element-tree walk, which needs the component **hookless**; association is implicit via the wrapping `<label>`, matching the division wizard. Later prompts' tests must follow the same pattern. |
