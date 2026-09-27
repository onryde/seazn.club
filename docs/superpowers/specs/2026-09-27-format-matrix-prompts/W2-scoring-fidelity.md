# W2 — sport scoring fidelity

**Goal.** When this wave is done every sport produces a result every format can
consume: a level knockout match always has an honest way to finish, walkovers
and retirements credit what the federation says, stage-level deciders and match
format are set on a screen for every sport, and an organiser can shorten a
final's match format before it starts — without any finished fixture changing.
It is the input layer every later wave stands on.

## Read first

- `_RULES.md` (R5–R9, R15–R17, R24, R28) and `_INDEX.md` (rulings 6, 10, 11, 12).
- Design §2, §4 (M3, M5, M6, M11, X3 "built in W2", E axis), §5 (customisation
  levels; the fixture override and its ~11 `resolveFixtureCfg` callers), §7.1,
  §7.2, §7.3 (V347 freeze invariant), §8 (W2 row), §10, §11 (O4, O5, O6, O8),
  §12 ("inert fixture override").
- Audits: `audit-2026-09-27/SC-scoring.md` (whole), `ST-standings.md` (G1, G2,
  G10, G16, G31), `FX-fixtures.md` (G23), `plan-facts-sports.md`.
- W1d's triaged ❌ list for W2 (in `_INDEX.md`).

## Prerequisites

W1a–W1d merged and W1d's W2 backlog written (design §8 order, R1).

## Scope

A sport-family wave: every sport row that consumes a result. Routed gaps,
copied from design §8:

SC-X1 (knockout tie/no-result stall), SC-X2 (stage deciders with a screen),
SC-X3 (no event to settle an abandoned knockout by lot), SC-X4 (auto-advance
blocked by `abandoned`), SC-P1, SC-P2 (level knockout without a decider), SC-P4
(hockey shoot-out points), SC-P11 (futsal preset), SC-S* (walkover/retirement
set and point credit, tennis impossible sets, tennis Bo1 match tie-break, double
walkover SC-S6) — **enumerate SC-S1…S9 from `SC-scoring.md` at start**, SC-C3
(DLS NRR), SC-O1/SC-O2 (boardgame/generic draws in brackets — the
`supportsDraws` root cause, owned here), ST-G1, ST-G2, ST-G16, ST-G10
(tiebreak validation against the sport + stage tiebreak UI); stage-level match
format for every sport (ruling 12, FX-G23, SC-O8); fixture-level format override
through every `resolveFixtureCfg` caller (§5); division-level lock of
points/tiebreakers per started stage (O8).

Unlisted SC-/ST- gaps on your sports go to you under the §8 preamble — list them
at start and record each assignment in the decision log.

## Lifecycle (design §10)

1. Rulebooks `rulebook-W2-sets-cricket.md` and `rulebook-W2-goals-boards.md`
   (drafts being written in parallel) → **owner sign-off** before step 2.
2. Reference families for the exact-oracle items (walkover credit, NRR,
   points), by a different agent than the engine fixer (R8).
3. Truth run on the sport rows; reproduce before fixing (R5).
4. Plan → implementer → reviewer; TDD; four test types; mutate every guard.
5. Gates (below). 6. No bench gate lines up after W2 (§9). 7. Drive the product,
   PR, e2e on `main` or `workflow_dispatch --ref`.

## Decisions owed (put to the owner as recommendations)

- **O4** fixture-override UI and **O5** stage deciders / match format / points
  / tiebreak UI — ≥2 options shown first (R24).
- **O6** per-case rulings, including build-or-refuse for SC-P11 (there is no
  futsal sport in the 11, §3 — a preset would be a football variant, not a row)
  and for any 🚫 action that arises on your rows.
- **O8** lock division-level points/tiebreakers per started stage — recommended
  in §5, **not yet a ruling**; confirm in the rulebook before building the lock.

## Done when

Ruling 19 on the sport rows: zero ❌ from the gaps above; every other red tagged
⏳ with its owner; nothing previously ✅/⛔ now red anywhere (W3–W7 rows
included — you change their input). Gates §10.5, plus: the fixture override
proven through the real pad and the real standings read, and M11 observed as ⛔.

## Traps

1. **The inert seam** (class 1, §12): an override that reaches `append-event`
   but not `fold`, `competition`, `event-import` or `player-stats` ships green.
   Enumerate every `resolveFixtureCfg` caller by grep `-a`, then prove each.
2. **A collectable field can be worse than an absent one** (class 19): check
   `payload.x ?? cfg.x` precedence. SC-P4 is the model — the declared 3/0 loses
   to the FIH 2/1 the rulebook adopts (§7.1), so the case is ❌ until fixed.
3. **"Cannot happen" comments** (R28): `competition.ts:148` says draws never
   reach a bracket; SC-X1/SC-O5 show `tie` and `no_result` do. Make it a guard.
   A tighter engine guard also changes what the pad offers — re-drive the pad.
4. **Tests lie in their names** (class 4): SC-P6's knockout case folds a cfg
   with no split and proves nothing; SC-S8 pins no set/point credit either way.
5. **Stage decider keys arrive as `z.unknown()`** (SC-P8) and `extraTime` does
   nothing for period sports — validate against the sport schema at create.

## Output and handoff

Update the W2 row, decision log and "False premises found" in `_INDEX.md` as
they happen (R22). Rulebook sign-offs go into "Owner rulings" only when the
owner signs; your recommendations stay in their own section.
