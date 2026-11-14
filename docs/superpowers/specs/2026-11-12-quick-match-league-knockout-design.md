# Quick Match — League + Knockout: design

- **Date:** 2026-11-12 · **Programme:** Quick Match (`2026-11-03-quick-match-design.md`), follow-up wave after PR #1198
- **Status:** APPROVED — OWNER 2026-11-13 "OK apply rec" after the sign-off page qmd13a01 (localhost:8765). Owner decisions are marked **OWNER**; everything marked **(designer's call)** is
  the controller's recommendation under the owner's autonomous mandate and is listed in §9 for checking.
- **Inputs:** owner conversation 2026-11-12; scout report (league_ko feasibility, file:line pins below — re-pin before
  building, they are against `feat/quick-match-surfaces` @ ca6872946b); decision log
  `.superpowers/sdd/quick-match-decision-log.md`; W5 round-robin design `2026-11-05-format-matrix-w5-round-robin-design.md`.

## 1. Intent

A quick match today is either a **League** (round robin: everyone plays everyone, once or twice) or a **Knockout**.
Club nights often want both: a few games against everyone, then **one deciding match people gather round**. League +
Knockout gives a guest that evening in one link: a short league, then the top of the table plays it off.

Success: a guest picks it on the setup page, plays the league on the same home they know, and the knockout fills itself
in the moment the league ends — no organiser, no button nobody knows to press, no unexplained result.

## 2. Goals, non-goals, anti-goals

**Goals**
- A second format on `/[lang]/play`: **League | League + Knockout**. **OWNER 2026-11-12**: plain Knockout is removed
  ("not sure who will play knockout alone"; taken out in PR #1198). The setup gains the format control back with these
  two options.
- Two knockout sizes. **OWNER**: **Final** — top 2 play one final; **Semi-finals** — top 4 play semis then a final,
  offered only with **4 or more sides**.
- League part: "Each pair plays" **Once | Twice** (**OWNER**, same cap as League, `QUICK_MATCH_MAX_PLAYS = 2`).
- Table ranks by the sport variant's **default points and default tiebreaker order** (**OWNER** confirmed). Quick
  match sets no standings rules of its own today (`quick-match-preview.ts:48-51` sets only `legs`); keep it that way.
  The default list already carries the sport's set/game/point measures — e.g. badminton (engine
  `sports/setbased/badminton.js:62`, BWF 16.2): matches won → head-to-head → game difference → head-to-head → point
  difference → head-to-head → lots. Each sport has its own list; the table and the cut both use it unchanged. "Still
  level" in §5 means level after every entry before `lots`.
- Advance from league to knockout **automatically** when the last league match is finished.

**Non-goals**
- **No 3rd-place match** (**OWNER**: "night over for them").
- No Swiss; no more than 6 sides; no other qualifier counts (top 2 and top 4 only).
- No change to how a plain League or Knockout quick match behaves.

**Anti-goals** (failure even if it technically works)
- A tie at the cut **silently** deciding who goes through. House invariant: a tie is flagged, never silently ordered
  (`seed-proposal.ts:388-391`). (Owner chose option A, §5.)
- A home that looks stuck: the league is over but nothing tells the guests what happens next.
- A knockout match that can end level.

## 3. Offer rules

| Sides | Final (top 2) | Semi-finals (top 4) |
|---|---|---|
| 2 | not offered (it is just a league or a final) | not offered |
| 3 | offered | not offered |
| 4 | offered | offered (everyone goes through; the league only seeds: 1 v 4, 2 v 3) |
| 5–6 | offered | offered |

- Only where the sport/variant may offer a knockout today: the knockout part follows the same C23 rule as a plain
  quick-match Knockout (`offer.knockoutAllowed`, `bracketMayEndLevel` on the knockout stage defaults). A sport that may
  only play League is not offered League + Knockout.
- Semi pairing: 1st v 4th, 2nd v 3rd; final = winners. Final with top 2: 1st v 2nd. **(designer's call: standard
  seeding.)**
- 2 sides not offered **(designer's call)**: a league of two followed by a final between the same two is a repeat.

## 4. The setup page

- Format control: **League | League + Knockout** (OWNER). Two segments; must fit at 320 with no horizontal scroll.
- With League + Knockout chosen, two sub-controls: **Each pair plays** (Once | Twice) and **Then** (Final | Semi-finals;
  Semi-finals hidden/disabled below 4 sides, with a one-line reason).
- Hint line (4 locales): e.g. "Everyone plays everyone, then the top 2 play a final." / "…then the top 4 play
  semi-finals and a final." **(designer's call** on wording; native-read of es/fr/nl stays OWED TO OWNER.)
- "Start playing · N matches" counts league matches + knockout matches (two-stage preview).

## 5. Ties at the cut — option A (OWNER, 2026-11-12)

The league table uses the sport's default tiebreakers first. Only if sides are **still exactly level after the whole
default list** does a tie matter:

1. **The tie decides who goes through** (it straddles the cut — e.g. level for 2nd when top 2 qualify): the home shows
   "**Tie for 2nd: Ines and Mika**" with two actions — **Pick who goes through** (choose a side) and **Toss a coin**
   (the server draws, records and shows the result). **Anyone with the link decides** (guests are the organisers).
   The knockout does not fill until this is settled.
2. **A tie among sides who all go through** (e.g. level for 1st when both qualify): order it by a visible lot, mark the
   row "**decided by lot**", and fill the knockout without asking. **(designer's call**, owner-approved as part of A.)

Engine facts (scout): residual ties are drawn by lot but still flagged `tieUnbroken` (`tiebreakers.js:864`);
`progression.js:587` flags ANY tied qualifier. So the app must distinguish case 1 from case 2 itself, and the confirm
path refuses on unresolved ties (`SEEDING_TIE_UNRESOLVED`, `seed-proposal.ts:401`) — case 1 is resolved by the guest's
pick/toss, case 2 by recording the lot as the tie pick.

Abuse note **(designer's call)**: the first decision wins; a second tap after the knockout has filled is refused with
"Already decided". Toss result is stored so a reload shows the same result.

## 6. What people see on the home

- One page, table on top, knockout below. The knockout is visible from the start with placeholder names ("1st in the
  league", "2nd in the league", "Winner of semi-final 1") — so guests see where the night is going.
  **(designer's call)**
- Hero line follows the current stage: league "Up next · match 3 of 6", then knockout "Semi-final 1", then the champion.
- When the league ends with a tie at the cut, the hero becomes the tie prompt (§5) — the home never looks stuck.
- **Add a match** stays league-only and is **not offered once the league is complete** (an open extra match would hold
  up the advance — scout `quick-match-add.ts:64`). **(designer's call)**
- Edit result on a league match **after** the knockout filled: refused with plain copy ("The knockout has started; this
  result can't change"), same pattern as the existing "next round has already started" pad copy.
- Pad: unchanged — it works per fixture (`score/[token]/page.tsx:218`).

## 7. Building blocks (from the scout; re-pin before building)

| Piece | Today | Needed |
|---|---|---|
| Template | `league_ko` exists (`format-templates.ts:80`: league + Finals KO, rankRange 1..q, timing `setup`) | reuse it; q = 2 or 4 |
| Create | one stage (`quick-match-create.ts:177`, `:192`) | two stages; `generateProgressionSetupFixtures` (`setup-fixtures.ts:59`) for KO placeholders |
| Format value | API enum `league|knockout` (`api-v1/schemas/quick-match.ts:35`); DB check (`V506:59`) | add `league_knockout` (+ qualifier count); **new migration** — numbered past main at merge |
| Auto-advance | `maybeAutoAdvance` only when `divisions.auto_progress` (`scoring.ts:1222`, default false) ; setup timing only drafts a seed proposal (`completion.ts:198,226`) | set `auto_progress` on QM divisions of this format; auto-confirm the proposal when no case-1 tie, modelled on the plate path (`plate-field.ts:252`, the only existing auto-confirm) |
| Ties | confirm refuses unresolved ties (`seed-proposal.ts:401`) | case-1 prompt + pick/toss usecase (link-token authorised, like Score); case-2 lot recorded as tie pick |
| Home | throws on `stages.length !== 1` (`quick-match-home.ts:343`); table OR draw (`home.tsx:210`) | read both stages; render table + bracket; winner from the final |
| Preview count | single stage (`quick-match-preview.ts`) | sum both stages |
| Delete / sweep | cascades competition → stages (`quick-match-delete.ts:10`) | no change expected; prove with a two-stage case |
| Admin counts | per match | "finished" = final decided; check played/finished SQL still right for two stages |

## 8. Constraints and dependencies

- **W5 round-robin wave**: `league_ko` is one of W5's rows (approved 2026-11-06, plans untracked). Before building,
  check what W5 has landed on main for `league_ko`. As of 2026-11-12 nothing of W5 is on main. OWNER 2026-11-12: do
  NOT wait — build only the QM tie handling this wave needs, consistent with W5's signed rulebook (no contradiction).
- House rules: 4 locales for every string; mobile-first at 320/768/1280, no horizontal scroll; tests per
  TEST-STRATEGY.md (anti-vacuity, sequence tests: tie → pick → advance, tie → toss → reload, edit after advance, delete
  of a two-stage match, every offered sport enumerated); e2e via CI; a tapped walkthrough extension; smoke extension.
- One PR for the wave, after PR #1198 merges.

## 9. Designer's calls to check

1. 2 sides: League + Knockout not offered.
2. Seeding 1v4 / 2v3; final 1v2.
3. Label "League + Knockout"; phone may use a stacked list if three segments do not fit at 320.
4. Case-2 ties ordered by visible lot without asking.
5. First decision wins; toss result stored.
6. Knockout shown from the start with placeholder names.
7. Add a match hidden once the league is complete; league edits refused once the knockout filled.

## 11. Builder-check answers (2026-11-12, designer's calls unless marked)

- **Toss vs the stored lot (designer's call):** the engine's stored lot IS the coin. "Toss a coin" reveals that stored
  lot (no second draw), so a reload or another phone shows the same result. "Pick who goes through" may overrule it;
  the pick is recorded as the tie pick. While the question is open the table shows the tied rows as "level — to decide"
  at the cut, not in lot order.
- **More than two level (designer's call):** generalise to "pick N of M" — e.g. "Tie for 2nd: 3 sides, 1 place". Pick
  chooses the N; toss takes the N best by the stored lot. Order among the qualifiers that came out of a tie follows the
  stored lot, shown "decided by lot" (case 2 rule), so the guest answers one question, never two.
- **League edits (designer's call):** QM-only rule, server-side for every caller: a league result can change until the
  knockout fills; after that it is refused with plain copy (consistent with the existing QM pad copy "the next round
  has already started"). Staff have no QM edit path. An edit while the tie question is open recomputes the table: if
  the tie is gone or changed, the pending question is replaced and any pick not yet applied is dropped. Knockout
  results follow today's QM knockout rules unchanged.
- **Who advances and failure (designer's call):** the advance runs in the same transaction as the score that finishes
  the league (actor = the system user, as every QM write). If it cannot run, the home retries it on load and, if it
  still fails, shows "Setting up the knockout — refresh in a moment" rather than a stuck page; the failure is logged.

## 10. Left to the builder

Exact copy beyond the hints above (all 4 locales); component structure; how the tie prompt is laid out at each width;
the format value's spelling; whether the qualifier count lives on the quick_matches row or is read from the stage graph.

## 13. Controller ruling after sign-off (2026-11-13, PO rec — owner may override)

- Tennis and ice hockey default lists put `seed` (entry = typing order) before `lots`, which would silently decide a tie at
  the cut — the §2 anti-goal. For **League + Knockout league stages only**, `seed` is removed from the stored list, so a
  level-at-the-cut tie reaches pick/toss like every other sport. Plain League and organiser competitions keep the sport
  default (§2's OWNER-confirmed line stands for them).

## 12. Calls fixed at sign-off (2026-11-13, approved with the page)

- **OWNER 2026-11-13 ("6 B, but need to choose both SemFinal -> Final right and 2 only then Final")**: the format control is a
  stacked list (Option B) of three whole choices — **League** | **League → Final** (top 2) | **League → Semi-finals →
  Final** (top 4). No separate "Then" sub-control. The top-4 row is disabled with a one-line reason below 4 sides; with 2
  sides neither knockout row is offered (§9 call 1). "Each pair plays" Once | Twice stays below the list. Supersedes §4's
  two-segment control and "Then" sub-control.
- A two-way tie at the cut needs "each pair plays Twice" (with Once, head-to-head separates two sides); tests must still cover a 3-way tie under Once.
- "N of M played": M counts league + knockout matches, same as "Start playing · N matches".
- Once the knockout has started, the bracket moves above the table.
