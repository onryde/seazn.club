# Project standing rules

Owner-given policy, current as of 2026-08-07. Applies to all work in this
repo, not scoped to one feature or programme. Read this before starting any
task — it is compaction-proof and subagent-readable by design: every
dispatch brief should either restate the relevant parts inline or point here
explicitly, so a subagent never has to guess or re-derive them.

## Skills

Load and use ALL of: every `superpowers` skill, `frontend-design`, `stripe`,
`playwright`, `supabase`, `typescript-lsp`, `code-review`, and the
`seazn-local-env` skill for local environment setup. **Apply them where they
actually help — do not just cite them decoratively.** A dispatch brief that
says "use frontend-design" but never asks for actual design-system-consistent
polish is not compliant.

## Infra

TypeScript **7**. Node **26**. (See `.claude/ts7-migration-state.md` for the
in-flight migration this confirms as current target, not something to avoid.)

## Mindset

Think beyond the literal request. Actively look for gaps, edge cases, and
weak spots in the design, and propose improvements rather than only
implementing what was asked. Balanced against "don't file new issues" below:
surface it, then fix it inline or ask — don't file-and-walk-away.

## Schema

Greenfield project — no production data, no backfills to preserve. Adding
new tables/columns is fine and expected. Prefer a correct schema over a
backwards-compatible one; don't contort a design to dodge a migration.

## Agent topology

- **Scout — Sonnet, xHigh effort** (raised from High by the owner
  2026-08-30; set in `.claude/agents/scout.md` frontmatter, which is where
  effort actually lives — the Agent tool cannot set it per-dispatch). All
  read-only exploration, file discovery, codebase Q&A.
- **Implementer — Sonnet, xHigh effort** (MAX from 2026-08-10, returned to
  xHigh by the owner 2026-08-30; set in `.claude/agents/implementer.md`
  frontmatter, which is where effort actually lives — the Agent tool cannot
  set it per-dispatch). Writes code. Full access to all skills and tools.
- **Reviewer — Sonnet, xHigh effort** (same change, same date, same place).
  Reviews the implementer's diff, reports gaps as a list, not prose.

**Loop**: Implementer → Reviewer → gap list → Implementer → Reviewer → …
repeat until the review is clean AND all tests are green.

**Batching rule**: several tasks touching the SAME files → do them INLINE in
one implementer pass, not separate dispatches. Otherwise, separate
Implementer → Reviewer loops per task.

## Testing — required for every task, all four, stated explicitly in acceptance criteria

- Unit tests
- E2E tests (Playwright)
- Smoke tests (this repo's `scripts/smoke.ts` pattern)
- Regression tests covering the specific bug/behavior being changed

A task is not "done" until all four exist and pass. A task with no literal
UI (a backend/service change) still owes an E2E test — trace forward to the
real user-facing flow that eventually exercises it, don't skip it as N/A.

**Unrelated failures**: don't chase a failure in files/references the
current task didn't touch — skip it, note it clearly, let CI surface it
separately. Don't silently absorb scope.

## UI/UX

Every interface works on both desktop AND mobile — responsive layouts,
touch-friendly targets, no desktop-only interactions.

Screenshot-verify every UI change at desktop (1280), 320px, and 768px —
no horizontal page scroll at any of them. Wide tables scroll inside their
own `overflow-x-auto` container, never the page. The seven-width e2e
matrix (`apps/web/e2e/mobile.spec.ts` viewport projects: 320/360/375/390/
430/768/834) is the enforcement backstop. `/admin` stays functional-bar
only.

## Pre-commit

Before every commit: verify the OpenAPI spec hasn't drifted
(`npm run openapi:gen && git status --porcelain` must be empty after).
Regenerate/update if it has.

## Process — compaction resilience, subagent token efficiency

- Document every decision as it's made (spec/plan/this file), not batched at
  the end — undocumented decisions are lost across a compaction, not merely
  summarized.
- Every subagent dispatch is self-contained: full context inline, or an
  explicit pointer to a specific doc/section. No subagent should need to
  re-read the whole repo or re-derive something already decided — that's
  what actually wastes tokens, not verbosity.
- **Do not file new issues.** Ask if unclear. Fix inline if wrong — unless
  the fix would widen the blast radius past the task's stated files, in
  which case stop and escalate rather than silently expanding scope or
  silently ignoring it.

## Owner checklist (2026-09-07)

Owner-given, verbatim. Binding on every design, plan task and dispatch
brief from this date. A task's acceptance criteria name the rows it
satisfies; a reviewer checks the rows, not the prose. Three groups.

### VERIFY-AS-CUSTOMER

- Verify visually, always — screenshot before claiming done, don't infer
  from code/tests alone
- Show ≥2 UI options before building
- Mobile-first, never shrink — mobile view designed, not shrunk from desktop
- Compare control SET (membership/order/repeats), not box size, across widths
- No horizontal scroll at 320/768/1280 — split on overflow-x (auto/scroll =
  feature rail, hidden/visible = real clip)
- Button size, text alignment, text size, cards — check every width, not
  just desktop
- Zoom in/out — layout holds at non-100% zoom, not just viewport swaps
- truncate needs min-w-0 on WHOLE ancestor chain
- Scrolling rail needs tabindex="0" + role + accessible name

### PRODUCT-OWNER LENS

- Always give a recommendation, framed as product owner — never just
  present options and stop
- Recommendation states the OWNER's value/cost, not just "if wrong: X" —
  ties back to what user/business gets
- Never file issues/PRs unprompted
- Review findings → written to disk, not just chat
- Brainstorm BEFORE e2e/smoke — align on approach first
- A comment in code is a HYPOTHESIS, not evidence — verify against behavior
- One authority per fact — second source is a fallback, not a tiebreaker
- Billing/money claims tested against Stripe SANDBOX, never assumed
- Surface bench/product gaps to owner rather than silently absorbing them
- Never carry one session's approval as another's — recommendation goes to
  the peer, not "owner said X" secondhand

### TEST-CASE DESIGN

- Pin the VALUE a control opens/seeds at, not just that it's reachable
- Derive expected values from the engine's own declarations, never
  hand-typed constants
- Include ≥1 case where right answer differs from the wrong answer's
  constant, or the test can't witness the regression
- Ladder/rule tests need an ORDERING-differential case, not just membership
- Empty-set case must be checked explicitly — it vacuously satisfies most
  "contains X" rules and silently defaults
- Negative assertion needs its positive pair (prove both directions)
- Boundary row can subtract a mutant kill — check it doesn't fake coverage
- Derived bound is a tautology — don't test a value against itself
- Mutate the MONEY path specifically — money code needs its own mutant, not
  incidental coverage
- Mutate per SURFACE / per UNION MEMBER, not per test — a whole-function
  mutant can mask an uncovered branch
- Report mutant KILLER LIST, not just count — a test dying under every
  mutant fakes kills
- One sample isn't a parity sweep — enumerate serve/rotation/alternation
  tables, not one lucky case
