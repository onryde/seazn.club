# F1 — bracket round role: persist it once, name it once, in four locales

Paste this whole file as the session opener. Read `_RULES.md`, then `_INDEX.md`,
then this. Engine + server + UI session.

Branch `feat/f1-bracket-round-role` in a fresh worktree. One PR.
Design: `../2026-08-17-format-progression-design.md` §2.3.
**Step-by-step plan with the actual code:
`../../plans/2026-08-17-f1-bracket-round-role.md` — follow it task by task.**

**Sequencing**: F1 touches `apps/web/src/server/usecases/stages.ts` and
`packages/engine`, which L3/#414 also owns. **Do not start until L3 merges**, or
branch from the merge commit. Independent of F2–F5.

## Why

A round's name is a property of its position in the bracket. Four separate
places in this repo compute it anyway, three from distance-to-final and one from
match count, and they have drifted:

- `apps/web/src/server/usecases/stages.ts:746-753` (`roundTitle`) — **match
  count**. Titles every stepladder round "Final"; calls a page playoff's
  Qualifier-1-plus-Eliminator round "Semi-finals"; renames rounds when a bye
  changes the count. Preview/marketing surface only.
- `apps/web/src/components/public-site/bracket.tsx:385-398` — distance-based,
  **hardcoded English with no `msg()` import at all**. This is the surface
  players and spectators see, so it also breaks the 4-locale policy outright.
- `apps/web/src/components/v2/stages-panel.tsx:1091-1105` — distance-based,
  i18n'd, but **collapses Qualifier 1 and the Eliminator into one "Qualifiers"**
  where the public site distinguishes them. Also disagrees on the stepladder
  summit ("Rung N" vs "Final").
- `packages/engine/src/exports/build.ts:237-240` — a fourth, count-based,
  hardcoded English, inside the engine on the export/poster path.

The worst instance: a **double elimination of 8 renders four sections titled
"Final" and three titled "Semi-finals"**, because a losers bracket has repeated
2-match and 1-match rounds by construction. The wiring underneath is correct —
the grand final reads winners'-final vs losers'-final — only the labels lie.

The root cause is upstream of all four. The engine already computes each
fixture's role (`bracket: "WB"|"LB"|"GF"`, `isFinal`, `thirdPlace`,
`conditional` — `packages/engine/src/scheduling/bracket.ts:17-29`), and
`bracketToGen` (`stages.ts:511-531`) drops every one of them when persisting.
`fixtures` stores only `round_no` / `seq_in_round`, so each consumer must guess
the role back from a number.

## Scope

Five tasks, fully specified in the plan. In brief:

1. **`packages/engine/src/competition/round-role.ts`** — one pure function
   mapping position to a typed `RoundRole` union. Returns roles, **never
   strings**; the engine carries no user-facing English.
2. **Migration + `bracketToGen`** — persist `lane`, `is_final`, `third_place`,
   `conditional` on `fixtures`. Wire them into **both** insert sites
   (`stages.ts:1083` and `:1525`) — the seeded/placeholder path is the one F3
   depends on.
3. **`apps/web/src/lib/round-role-label.ts`** — role → `bracket.round.*` key,
   values in all 4 locales. Supersedes the split `bracket.*` /
   `schedule.bracket.*` namespaces; **delete the superseded keys**.
4. **Convert all four consumers**, delete `roundTitle`, and prove with a grep
   that one namer remains.
5. **Byes read "Bye"**, plus a committed snapshot of all 25 formats' shapes so
   this class of drift cannot recur silently.

## Not in scope

- Anything about `seeding` vs `qualification` — that is F2. F1 changes no
  progression semantics, only naming and the role columns.
- Bracket geometry, seeding order, bye placement. All correct today.
- `config/format-gallery.tsx` and `lib/marketing/draw-graph.ts` — static
  marketing illustrations, not generated output. If you leave them, **say so
  explicitly in the PR body** rather than letting the grep pass quietly.

## Acceptance

- [ ] A DE of 8 renders exactly one "Final", plus "Winners' final",
      "Losers' final", "Grand final" — asserted, not eyeballed
- [ ] Page playoff names Qualifier 1, Eliminator, Qualifier 2, Final distinctly
      on **every** surface
- [ ] `git grep -a "Semi-final\|Quarter-final\|Round of "` over `apps/web/src`
      and `packages/engine/src` returns nothing outside dictionaries and tests
- [ ] A bye renders "Bye", never "TBD"
- [ ] All 4 locales; `i18n:check` green; no hardcoded round name anywhere
- [ ] Engine boundary gate green; no English in `packages/engine`
- [ ] Migration applies from zero on a clean schema
- [ ] Screenshots at 1280 / 768 / 320 for the public bracket, `stages-panel`
      and `bracket-panel`, including a DE and a page playoff
- [ ] Counts from the JSON reporter, paths confirmed inside the worktree

## Gotchas

- **`lastRound` is per LANE.** A global maximum reintroduces the bug with every
  test green.
- **Page-playoff identity lives only in `ext_key`** (`pp-q1`, `pp-elim`,
  `pp-q2`, `pp-final` — verified at `bracket.ts:390-393`). Q1 and the Eliminator
  share a round and a match count.
- **A third-place fixture shares the final's `round_no`** and has no
  `winner_to_fixture` — L3 found it masquerading as the grand final. Handle
  `thirdPlace` before any lane logic.
- The five known-red suites in `_RULES.md` §4 are not yours.

## Execution

One coherent chain, engine → persistence → i18n → consumers. **Sequential
implementer → reviewer loop**; `stages.ts` is single-writer.

**Reviewer focus:** is any round named by counting? Is `lastRound` per lane or
global? Does `packages/engine` contain a user-facing string? Are the superseded
i18n keys actually deleted, or just orphaned? Did **both** insert sites get the
new columns?

## On close

`_INDEX.md`: F1 → DONE, the `RoundRole` union as shipped, the final namespace,
and whether the marketing surfaces were converted or left. Update help pages if
any round name changed there. Memory + `scripts/agent-memory-snapshot.sh`.
