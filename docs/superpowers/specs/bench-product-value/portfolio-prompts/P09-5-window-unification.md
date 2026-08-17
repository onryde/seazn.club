# P9.5 — one court-availability function, and the two constraints the
# placer never learned (D5b.5)

Read first: `_RULES.md` → `_INDEX.md` → spec
`../designs/2026-08-13-venues-courts-design.md` §"`usableWindows`
algorithm (normative)" and §"Calendars → lattice (P10)". Depends on P9
(merged). Blocks P10. Same external gate as P8/P9. Worktree + fresh
branch. **Refactor-only session: no new product surface.**

Owner ruling 2026-08-17: this was carved out of P10 as its own session,
because P10's prompt assumed `usableWindows` already existed and it does
not — and because the refactor deserves its own gate and review loop
rather than riding inside a feature session.

## Why this session exists (read before scoping anything)

`_RULES.md` §3 and `_INDEX.md` both state that `usableWindows` /
`capacity.ts` already make the placer/verifier fork impossible. **That is
false and both files are corrected by P9's close.** `usableWindows` has
zero hits outside documentation.

P9's inventory then overturned the obvious follow-on assumption too. The
three window computations do NOT drift:

| | placer | verifier | capacity |
|---|---|---|---|
| overlap test | `intervalsOverlap` | same fn (`calendar.ts:379-382`) | same fn |
| window bounds | `start >= from && end <= to` (`build-grid.ts:111`) | identical (`calendar.ts:1530`) | clipped to day |
| blackout scoping | unset `court` = global (`:113`) | same (`:401`, `:1522`) | same (`capacity-input.ts:154`) |
| empty `sessionWindows` | unrestricted (`:111`) | unrestricted (`:1530`) | unrestricted (`:148-153`) |

**The real defect is asymmetry, not drift.** `admits()`
(`build-grid.ts:109-123`) never applies two constraints the verifier
enforces:

1. the competition pack window — `config.window`, enforced at
   `calendar.ts:1467-1474`, producing `outside_competition_window`;
2. per-target start windows — `startWindowFor`
   (`calendar.ts:1399-1414`), enforced at `:1476-1483`.

So the lattice offers slots the verifier rejects. A build can hand the
solver a legal-looking board that fails its own `/validate`. This
predates P9 and is reachable today.

## Scope

1. `packages/engine/src/scheduling/court-windows.ts` — new pure
   `usableWindows(court, dateRange, config): Window[]`, implementing the
   D5 spec's normative algorithm (exceptions override hours, ∩
   `sessionWindows`, − blackouts, org-tz civil times, no UTC arithmetic,
   no calendars declared ⇒ full day).
2. **Close the asymmetry**: the lattice honours the pack window and
   per-target start windows **through the same functions the verifier
   calls** — not a reimplementation. Where the verifier's check is not
   already a callable pure function, extract it and have both sides call
   it. This is the deliverable; `usableWindows` is the vehicle.
3. Consume P8's `court_hours` / `court_exceptions` (V367, unread by
   anything today) — loader lives usecase-side, engine stays pure.
4. Route lattice build, `/validate` and `capacity-input.ts` through the
   one function; delete the now-redundant private paths.

## Do NOT touch

`services/placement/**` and proto/generated stubs (zero proto change) ·
any product surface, UI, or wire schema · P10's stranded-fixture conflict
code (A6) · court tags / archived semantics (P9 owns those and they are
merged).

## Acceptance criteria

- Unit: `usableWindows` — hours ∩ session − blackout, exception override,
  multi-range days, DST via `settings.orgTz` (the governing clock, #448;
  `settings.tz` is display only), no-calendar ⇒ status quo ante.
- **Regression, the session's core**: a fixture where the lattice
  previously offered a slot outside the pack window / outside a target's
  start window is now not offered — asserted on the lattice, and asserted
  green through `/validate` in the same test.
- **Anti-fork test**: a test that FAILS if any second window
  implementation is reintroduced (assert one exported symbol is the only
  producer, or equivalent). "One function, both sides" was asserted and
  untrue once already; it must be enforced by a test, not a convention.
- Lattice byte-equivalence for a no-calendar, no-pack-window org before
  and after — pure-refactor proof. P9's
  `court-id-lattice-equivalence.test.ts` is the pattern to copy; note its
  golden is a structural snapshot, not archived pre-cutover code.
- Both-ways gate: with AND without a live placement service.

## Verify

```bash
cd packages/engine && npx vitest run --reporter=json --outputFile=/tmp/p95e.json src/scheduling
cd apps/web && npx vitest run --reporter=json --outputFile=/tmp/p95w.json src/server/usecases
jq '{total:.numTotalTests,passed:.numPassedTests,failed:.numFailedTests}' /tmp/p95e.json /tmp/p95w.json
cd packages/engine && npx tsc --noEmit; echo EXIT=$?
```

Never judge from a vitest run at the REPO ROOT — it fails to resolve
`server-only` / `@/lib/db` and reports hundreds of uncollected suites.
Run per workspace.

## Execution notes learned in P9 (do not re-pay these)

- Subagents die at a 600s watchdog. Do not let one run a DB-backed suite,
  `db:apply`, `tsc`, or a broad multi-section sweep — the orchestrator
  runs gates; agents write code and commit as they go.
- One implementer at a time per branch. Two agents committing to one
  branch produced a `git reset HEAD~1` that swept a sibling's file.
- `git stash` is forbidden in a worktree here (shared stash stack).
- Re-pin every `file:line` in this prompt before trusting it.
