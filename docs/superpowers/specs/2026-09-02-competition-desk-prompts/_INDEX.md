# Competition desk — programme index

Decision log and session status. Read `_RULES.md` beside this file first.

- **Design of record:** `../2026-09-02-competition-desk-design.md`
- **W1 plan:** `../../plans/2026-09-02-competition-desk-w1.md`
- **Waves:** W1 competition page (in flight) · W2 fixtures tab as a run sheet ·
  W3 phone layouts and the in-play band

## Status

| Wave | Scope | State |
| --- | --- | --- |
| W1 | Competition page: derived phase, Needs you, division ledger, tip gating, stage order | In flight — fix round A after a Needs-fixes final review |
| W2 | Fixtures tab as a run sheet (`stages-panel.tsx`), desktop two-column | Not started |
| W3 | Two-line run-sheet rows, bottom-sheet stage rail, in-play band | Not started |

## Owner rulings

Rulings BY THE OWNER. Anything below this line came from the owner directly;
recommendations I made are recorded in the next section and are **not**
interchangeable with these. Never carry either to a peer session as the other.

1. **The surface is the DIVISION page's fixtures tab** (`?tab=fixtures`,
   `components/v2/stages-panel.tsx`), NOT `components/v2/fixture-console.tsx`.
   "Fixture Console" in owner vocabulary means the former. The component of
   that name belongs to the R7 programme.
2. **One surface serves both modes** — pre-event planning and live match day.
3. **Sport icon on division rows only**, never the competition masthead
   (reasoning in `_RULES.md`).
4. **Mobile is designed, not shrunk** — given verbally in this wave, later
   repo-wide policy (`1a0c948b9`).
5. **Cosmetic alignment defects are defects, not polish.** The premise of the
   desk is that it reads truthfully at a glance; an unaligned row with
   duplicated numbers defeats that.
6. **W2 and W3 stay split exactly as the spec writes them** (2026-09-02). I
   recommended folding W3's run-sheet mobile composition into W2 so the run
   sheet is designed at both widths once rather than built at desktop and
   reflowed later; the owner declined. Do not re-open this.

## Spec amendments (binding, in the design doc)

1. Sport icon on division rows, none on the competition masthead.
2. **Rule order: `setting_up` before `finished`.** With zero stages and zero
   fixtures, `everyStageComplete || (noOpenStage && noLiveFixture)` is TRUE, so
   the first division an organiser created read "Finished" before it began.
3. **An aggregate phase states its empty case first.** `competitionPhase`
   derived from the division phases, and an empty set satisfied none of its
   `includes` tests, so a competition created seconds earlier rendered
   "Finished · 0 divisions" above its own "No divisions yet" empty state.
   Confirmed on a live prod build before the fix.

## False premises found (my own, unless noted)

Recorded because each was believed, acted on, and wrong.

- **The wrong surface was scouted first** — `fixture-console.tsx` instead of
  the division fixtures tab. Cost a full scout pass. See owner ruling 1.
- **`DEFAULT_MATCH_MINUTES = 60`** contradicted the codebase's 30 (zod default,
  `schemas.ts:1266`). Ruling: DERIVE such constants from the schema, never
  retype them, so they cannot drift from the source of truth again.
- **My V2/V3 fix instruction was wrong.** I said "un-hide the pill, stop
  truncating", which preserves the desktop DNA at 320. The owner caught it:
  that is shrinking, not designing. Superseded by the mobile card composition.
- **`fixtures.status` has no `live` value** — it is `in_play`.
- **Three vacuous-truth phase defects**, all three shipped past green suites
  and were found by looking at a screen. See `_RULES.md`.

## Review lessons (W1)

- A task review returned **Approved** with all three product mutations killing
  tests, live e2e green, and nine screenshots opened — and still missed both
  the Critical and three unreachable assertions. The final whole-branch review
  found them by driving the product. **Run the final review even when every
  task review is clean.**
- The two reviews contradicted each other on assertion quality; the final one
  was right. Checking that an assertion is well-formed is not checking that it
  is reachable.
- A subagent that BACKGROUNDS a build ends its own turn, losing uncommitted
  work. Environment work (build, serve) is the controller's for the whole wave.

## Environment (label `fxc`)

`seazn-env up --label fxc` in a worktree, never the main checkout. The server
port MOVES on every rebuild — re-`eval` the env script rather than reusing a
remembered port. Without an exported `DATABASE_URL` vitest refuses to start
because it detects `.env.local`'s dev DB; that refusal is the guard working.
A source edit does not reach the running server until a rebuild, so a copy
assertion run against a stale bundle fails for a reason unrelated to the test.
