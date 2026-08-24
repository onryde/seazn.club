# F5 — shipped, and what survived it

*Rewritten 2026-08-24, same day, replacing this file's first revision entirely.*

**Read this first: F5 is MERGED.** It shipped as PR **#630**
(`feat/f5-test-debt`, merge `45a5b835c`). The first revision of this document
was a "design of record" that re-planned work already on `main`, because it was
written from `_INDEX.md`'s "Left for F5" block and from reading the code,
without checking merged PRs. Nearly every premise it stated was false for that
one reason. It has been replaced rather than amended, because an amended
version would still read as an open wave.

What this file is now: a record of what #630 covered, the small remainder that
genuinely survived it, and — most importantly — the prescriptions the first
revision got *wrong*, so nobody implements them.

---

## 1. What #630 shipped

```
fix(exports): localize table chrome, descriptions and scoresheet copy
fix(calendar): localize the two remaining hardcoded entrant-name fallbacks
fix(registrations): escape ICS TEXT values in the single-registration download
fix(notifications): resolve day-one placeholder labels instead of bare TBD in
                    3 digest/notice emails
fix(ui): render the paywall card, not a plain error banner, on PAYMENT_REQUIRED
fix(ui): clear the stale paywall card on AddStageForm resubmit
test(smoke): prove bracket round-role columns and the bye slot label over real data
feat(engine-testkit): teach the simulation harness genuinely multi-source
                      progression specs
test(engine): full seeded_map unclaimed-seat assertion + best_nth cross-pool
              tie coverage
test(formats): replace tautological qualification-absence checks with
               schema-valid progression checks
```

That is the §5 test debt AND F4's leftover i18n/placeholder cleanup, in one
branch. Both paywall defects, the `seeded_map` assertion, the `best_nth` tie
test, the multi-source fuzz and the F1 smoke check are **done**.

---

## 2. What genuinely survived — verified against `main` on 2026-08-24

Each line was checked by reading `main`, not inherited from any list. Line
numbers decay fast in this repo; re-pin every one before editing.

| Item | Evidence |
|---|---|
| `packages/engine/src/exports/build.ts` values #630 did not reach: `f.result ?? "vs"`, `f.court ?? "Unassigned"`, `"No duties assigned"`, `"Accepted"/"Declined"`, and `home/away ?? "TBD"` ×8 in the bracket builders | #630 localized the table CHROME through the `BuildOpts["i18n"]` seam; these row and section VALUES were not part of it |
| `buildOfficialsRota` and `buildRoster` hardcode their `signatures` arrays | same file, same `opts.i18n?.x ?? CONST` idiom as the fields #630 added |
| Hardcoded `' vs '` separators baked into template literals in `exports.ts` (rota duty rows, my-rota, scoresheet heading, audit-ledger title) | `schedule.vs` is already resolved in `exportChrome()` — no new key needed |
| The `?entrant=` calendar feed drops **every** day-one fixture | predicate is `!entrantId \|\| home===id \|\| away===id`; an unresolved fixture has both ids null. #630 fixed the *vacuous assertion* over this feed, not the filter |
| `registrationIcs` still hand-rolls a second VCALENDAR | escaping landed in `afbfda4eb`; folding, `CALSCALE`/`METHOD` and the English `DESCRIPTION` did not |
| Stray `?? "TBD"` in `org-posts.ts` (4 sites) and `match-reports.ts` (1) | the notifications commit covered 3 digest/notice emails, not these |
| `poster.pdf` renders QR + branding only, and its own copy is hardcoded English with an `en-GB` date format | nobody had listed the poster's own strings before |

---

## 3. Prescriptions the first revision got WRONG

These are recorded because each one, implemented as written, produces a green
suite and a broken product. They came out of a review of that revision plus
direct verification.

**"Keep a fixture whose slot label cites that entrant" is impossible.** No slot
label ever cites an entrant. Every label is structural — pool letters, ranks,
round positions ("Winner of Group A"). A filter written to that instruction
matches zero rows, the feed keeps dropping day-one fixtures, and the test stays
green. **Owner ruling 2026-08-24:** a personal feed carries the subscriber's own
resolved fixtures PLUS every unresolved fixture in their division. Do not walk
the progression graph for reachability — that was considered and deferred.
Over-inclusion is intended; the events are already all-day `STATUS:TENTATIVE`.

**"Replace the body with a `buildIcs` call" is lossy.** `buildIcs` differs from
`registrationIcs` in four ways that would break existing subscribers:

- it emits `UID:<uid>@seazn.club`, appending the suffix itself, while
  `registrationIcs` already builds `registration-<id>@seazn.club` — passing that
  through double-suffixes it and changes every subscriber's event identity;
- its all-day branch hardcodes `DTEND = nextDay(allDayOn)`, one day, while
  `registrationIcs` deliberately spans `starts_on … ends_on + 1`, so a
  multi-day competition collapses to a single day;
- it emits `STATUS:TENTATIVE` + `SEQUENCE:0`; a confirmed registration is not
  tentative;
- it uses a different `PRODID`.

Either extend `buildIcs` to carry a multi-day span, an optional status and an
already-suffixed UID, or keep a local builder that REUSES `foldLine`/`icsText`.
Preserve all four behaviours, each pinned by its own test.

**The folding is not RFC-correct, and a naive test cannot see it.** `foldLine`
slices on JS string length — UTF-16 code units — while RFC 5545 §3.1 counts
OCTETS. Accented text still emits over-long lines, and `slice(0, 74)` can split
a surrogate pair. A folding test written with ASCII passes while the violation
stands; write it with genuinely multi-byte text.

**"The existing test will pass through the swap either way" is false.**
`registrations.test.ts` also asserts `DTSTART;VALUE=DATE:20260915`, and a second
test asserts exact `SUMMARY`/`DESCRIPTION` strings that localizing the
description turns red. Both are correct to update deliberately, not delete.

**The board payload budget was already re-baselined.** `91e5c0b20`
("test(e2e): re-baseline the board payload budget 250KB -> 300KB
(owner-approved)") moved the gate; the live assertion is
`toBeLessThan(300_000)` with an owner-approved rationale block above it (P9
court-label→UUID cutover, ~9KB structural growth), and it budgets flight bytes
MINUS the serialised `en/ui.json`. The "roughly 250003 against 250000" figure
was arithmetic, and stale as well. **Measured 2026-08-24: the ceiling is
300_000.** The first revision's ruling — "if it is already over, report and
stop" — is retained as owner policy but is unlikely to fire.

**Three bad citations, corrected.** Only TWO tautological
`not.toHaveProperty("qualification")` tests existed, not three;
`catalog.test.ts`'s assertion is an unrelated `progression` absence check on a
byte-stable P4-era template, and that file sits inside this document's own
exclusion list. And `format-catalogue.test.ts` carries no "stays red until Task
6" blocker wording — the lines cited are load-bearing F2/F3 rationale that a
future re-baseline needs. Do not delete them.

---

## 4. Where the remainder is being worked

Branch `feat/f5-remainder`, in a worktree, stacked on `fix/admit-tickets-empty`.
Sequenced by file-group rather than fanned out, because four of the groups all
edit the four locale dictionaries and the generated `i18n-keys.ts` — file sets
that are not disjoint cannot run in parallel.

`fix/admit-tickets-empty` is separate and covers a defect found the same day:
admit tickets read `registrations`, not `entrants`, so a competition whose
organiser added entrants directly rendered a blank branded page as a **200 PDF**.
It now refuses with 422 `TICKETS_NOT_AVAILABLE`, mirroring the bracket arm's
`BRACKET_NOT_AVAILABLE`, and the status stamp no longer overprints the
reference (its x is measured off the ref rather than fixed; a real ref is 12
characters and ran ~10pt past the old offset).

---

## 5. Exclusions

- `packages/engine/src/sport/**`, the fidelity-tier scale, the scoring pad, the
  `StageKind` enum.
- `ticketRegistrationRows` is **not** part of P5 and never was. Verified twice
  by two reviewers. Do not "fix" it.
- `/r/[ref]/page.tsx` is a deliberate stub — it renders "Registration is
  closed" for every ref, valid or not, and **RS007 owns re-pointing it at group
  refs**. Note the consequence: every admit-ticket QR, printed and digital,
  currently lands on that stub. `regByRef` itself works.
- The staff-facing landscape bracket poster in the `exports.ts` bracket arm.
- `standings.carry_over` — that is F6 / `#625`, which is what "next" now means.

---

## 6. Verification

- `turbo run lint typecheck` from the repo root is the CI gate. `npm run lint`
  alone is not, and `rtk` hides lint output — use `rtk proxy` and read
  `✖ N problems`.
- vitest via `--reporter=json --outputFile`, judged on
  `numPassedTests`/`numTotalTests`, with your own file confirmed present in
  `.testResults[].name`. The positional is a **substring** filter, not a regex:
  `"a|b"` matches nothing and still reports a green total.
- All four test types per task; every change ships a test that fails without it.
- Pre-commit: `npm run openapi:gen` then `git status --porcelain` must be empty.
- New dictionary key ⇒ `npm run i18n:gen-keys` and commit `i18n-keys.ts`.
  `i18n:check` stays green against a stale generated file; only CI sees it.
- **Check merged PRs before treating any programme item as open.** That is the
  single lesson of this document's first revision.
