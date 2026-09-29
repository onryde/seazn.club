# Programmes master index (living doc)

One page to sequence ACROSS programmes. Session content lives in each
programme's own `_INDEX.md` + prompts — never duplicated here. Update
this file whenever a programme's status or a cross-gate changes.
Last updated: 2026-09-27 (format-matrix programme added; B17 folded into it; B07a merged #792). Previously: 2026-09-16 (bench row — B06b MERGED; B07a done, this wave; B07 split into B07a/B07b).

## The four active programmes

| Programme | Dir / index | Sessions | Status |
|---|---|---|---|
| ScoringPad v2 (#407) | `../2026-08-06-scoringpad-v2-prompts/_INDEX.md` | S1–S13, L1–L3 | S1–S9 done; S10 in flight; S11–S13, L-lane open |
| Release-2 scheduling | `../2026-08-12-release2-prompts/_INDEX.md` | C0–C8 | C0 done; C1 in flight; C2–C8 open |
| Product portfolio (D1–D7) | `portfolio-prompts/_INDEX.md` | P1–P11 | authored; build-gated per session (owner green-light) |
| Scheduler bench | `bench-prompts/_INDEX.md` | B00–B18 (+B03r, B16; B07 split → B07a/B07b) | gate open; **B00–B05 all merged** (B05 = #754 `c28c46752`, 2026-09-08). **B06 is now two waves**: B06a (framework — registry, extracted runner, two comparators, provenance writer, claim acceptance, news) is **MERGED** (#762 `c1203a373`, 2026-09-10); B06b (the darts pack) is **MERGED** (#770 `38f5fb3b5`, 2026-09-11; two same-day follow-ups also merged — #771 `873efb725` and #773 `9f30577d1`, see `bench-prompts/_INDEX.md`'s own B06b row for what each closed). Suite 11 authored and run on both placement legs, **both GATE GREEN** with identical oracle verdicts (23 with a subject, 23 PASS, 0 FAIL). Seven bench gaps found by the live run and all seven fixed. **One open product finding on the optimized scheduling path remains** — both divisions returned `solver_unavailable` at 0 of 6 tiers with the build finishing in 849 ms / 496 ms against a 30_000 ms wall, an error response rather than a timeout or a volume limit. Narrowed to `build.ts:2176`; #773 fixed the "logs nothing" half (both the engine's resolved-`ERROR` arm and the placement service's own wire-refusal path now log `code`+`message`) but nobody has yet re-run suite 11 to read what the now-logged reason says — still needs its own wave. **PackSchema freezes at B06b's merge, not B06a's, and stays FROZEN — B07a (below) touched no Pack file.** B16's only remaining gate is B06b (now merged) — B16 also now depends on B07a for its tap-driving machinery. B05's deferred **T6 (people layer)** and **T7 (report sections + provenance %)** are both DISCHARGED by B06a — claims are accepted, news is drafted and published, and `provenancePct`/`claims`/`news` all have writers. **B07a (match day, played by hand) is done this session** on `feat/bench-b07a-match-day`, not yet merged: the generic `TapAdapter`/`TapStep` (real Playwright pad, no HTTP bypass), the device-link entitlement gate (`scoring.device_links`, mint→QR→copy→revoke all proven in a real browser), per-pool stage-0 standings, qualifier order from the progression rule, advancement for every division, and two live tap legs (single-run gate GREEN, 4/24 taps all `finalized`; two concurrent bench processes tapping two different fixtures at once, also GREEN, 0 findings — the R71 "lost point" trigger was NOT reproduced by this, absence rather than proof). One **confirmed product finding, live-proven, `apps/web` untouched, owner ruling owed**: a repeat `POST /stages/{id}/complete` is idempotent in storage but `completeStage`'s guard never distinguishes "just completed" from "already complete", so it re-runs the next `setup`-timed stage's `computeSeedProposal` on every repeat call UNTIL the downstream proposal is organiser-confirmed — proven live on `_tiny` (two repeat calls each minted a new draft row, `stage_seed_proposals` 2→4); confirmation closes the window cleanly (a further repeat is refused, zero new rows, also proven live). `on_complete` timing has no such window. Full detail: `bench-prompts/_INDEX.md`'s new B07a row. B07 is now split: **B07b** (carrom, suite 10) depends on B06b + B07a and stays TODO. |
| Registration redesign | `../2026-08-16-registration-redesign-prompts/_INDEX.md` | RS001–RS011 | RS001–RS006 merged; RS007–RS011 + RS010 open |
| Format progression | `../2026-08-17-format-progression-prompts/_INDEX.md` | F1–F5 | F1 + F2 authored (F1 also planned); F3–F5 written after F2 **merges**. **F1 waits for L3/#414** (shared `stages.ts`) |
| Spectator surface (`/shared`) | `../2026-09-04-spectator-prompts/_INDEX.md` | W0–W5 | owner-requested 2026-09-04 (green-lit by the request); W0 CLOSED (Option A everywhere); W1 (match centre) executing on `feat/spectator-surface` — all tasks built and reviewed, the gate and the whole-branch review remaining, no PR until the owner asks; W2–W4 sequential after it, W5 designed after W4; no cross-programme gate — reads the engine, touches no organiser surface |
| Format × sport matrix | `../2026-09-27-format-matrix-prompts/_INDEX.md` | W1–W10 | APPROVED 2026-09-27 (spec `../2026-09-27-format-matrix-design.md`); W1a merged (#896); W1b Tasks 1–16 done on `feat/format-matrix-w1b`, final whole-branch review next (see the index's W1b row). **Folds in bench B17** (owner ruling 8) and runs BEFORE the remaining bench suites, which become closing gates of its waves (see Cross-programme gates). |

## Cross-programme gates

```
ScoringPad S13 ─┬─► bench B00+ (master gate, with C8)
                └─► portfolio P11 (batch import)
Release-2  C8  ─┬─► bench B00+ (master gate, with S13)
     C-chain   ─└─► portfolio P8–P10 (venues: shared schedule.ts/build.ts)
Portfolio P5   ───► P6 ───► P7        (progression → UI → multi-stage templates)
Portfolio P4   ───► P7
Bench B15      ───► B17               (disruption reuses suite 8 org)  ← SUPERSEDED 2026-09-27: B17 folded into format-matrix
Format-matrix does NOT edit run-suite.ts or PackSchema (its ruling 17) — no gate on bench runner work
Format-matrix W3 ─► bench Grand Swiss · W4 ─► All England, Wimbledon, WTTC
Format-matrix W5 ─► Candidates, Euro, T20WC, Paris, IIHF, carrom (B07b)
Registration RS010 ─► bench B03r ──► B16 (customer-journey suite 13,
                                     UI-first incl. Stripe test mode + pad;
                                     spec designs/2026-08-27-bench-customer-journey-design.md)
Portfolio libs (P1 capacity, P2 health, P10 court-windows,
                P5/P6 D4 flows, P11 import) ──► consumed by bench B04/B05
                                                if shipped; B00 inventories,
                                                every B-prompt names fallback
```

Nothing in portfolio or bench builds without an explicit owner
green-light per session (creative-only ruling, 2026-08-13). The bench
additionally cannot start before S13 AND C8 regardless of green-light
(strict-wait ruling, 2026-08-12).

## Runnable now (no external gate, green-light only)

P1 (capacity), P2 (health), P3 (news), P4 (templates single-stage),
P5→P6 (progression), P7 after P4+P5. Blocked regardless of green-light:
P8–P10 (release-2 C-chain), P11 (S13), all B (S13+C8).

## Session lifecycle (house pattern — applies to every programme)

1. Owner green-light ("run P1" / gate opens for B00).
2. Open the programme's `_RULES.md` (where present) → `_INDEX.md` →
   the session prompt. Prompts assume rules; rulings in the index are
   closed — do not re-litigate.
3. Fresh branch in a worktree; `pnpm install --frozen-lockfile`;
   engine-symlink check.
4. Scout re-pin of the prompt's citations (all authored pre-C1/S10+).
5. Implementer ↔ Reviewer loop (Sonnet / MAX per
   `docs/superpowers/RULES.md`) until clean AND green; TDD; all 4 test
   types or named deferrals.
6. Gates run by the orchestrator, raw counts pasted (JSON reporter);
   one PR; smoke CI is PR-only.
7. Programme `_INDEX.md` status log updated in the same PR; memory
   written at decision points; snapshot script at wave boundaries.

## Specs of record

- Bench: `designs/2026-08-12-scheduler-bench-design.md`; registration +
  customer-journey amendment: `designs/2026-08-27-bench-customer-journey-design.md`
- Portfolio: `designs/2026-08-13-{capacity-precheck,schedule-health,
  news-enrichment,format-templates,stage-progression,venues-courts,
  batch-event-import}-design.md`
- Release-2 + ScoringPad: listed in their own indexes.

## Routed in from entitlements v18 W2 — 2026-09-05: the bench baseline moved to `enterprise`

**CLOSED 2026-09-08 as B05's T0** (`599ca30fd`, merged in #754). The recommendation
below was taken as written: candidates filtered to `is_public = true`, ranked
least-privileged-first off the live matrix, and the fixtures re-derived from the
migration deltas so the next plan change moves them instead of passing through.
Kept in full below because the failure shape — a unit fixture holding a catalog the
migrations deleted, so no test could witness the drift — is the reusable part.

**Not fixed by that wave.** The cause is its migration; the chooser and its fixtures
belong to this programme, and changing them mid-flight without their tests would be
half a fix. Evidence and recommendation, so this can be decided rather than
re-derived:

**What happened.** `V393__entitlements_v18.sql` deleted the `pro_plus` plan outright
and inserted `officials.auto` for both Event Pass rungs.
`chooseGrantingPlanForCapabilities` (`scripts/bench/lib/plan.ts`) iterates
`[...primaryGrantors].sort()` and breaks on the first plan satisfying every desired
capability. With `cricket.dls` granted by `{community, enterprise, pro}` in the live
matrix, **`enterprise` sorts before `pro`** and satisfies the rest — so `provisionPlan`
now lands the bench org on `enterprise` where it used to land on `pro_plus`.

**Why it matters rather than being cosmetic.** `enterprise` is `is_public = false` —
the Contact-us plan — and its column is unlimited across the board. A benchmark
provisioned onto unlimited caps is not measuring anything a customer can buy. There is
no crash and no FK failure; the baseline just moved.

**And the fixtures hide it.** `scripts/bench/lib/__tests__/plan.test.ts:27-30` and
`dls-gate.test.ts:129-156,295-315` inject a fake catalog containing `pro_plus` and no
`enterprise`, so they stay green while asserting a catalog shape that no longer exists
— `dls-gate.test.ts:304` still expects `provisionedPlan === "pro_plus"`, a plan V393
deleted. The tests cannot witness the regression because their catalog is not the
live one.

**Recommendation (not a ruling — this programme's owner decides).** Filter candidates
to `is_public = true` before choosing, so a bench can never provision the Contact-us
plan; that alone yields `{community, pro}` and restores a meaningful baseline. Then
order deliberately — least-privileged-that-satisfies is what a benchmark wants —
rather than relying on `.sort()`, where the current behaviour is alphabetical by
accident. And point the fixtures at the live catalog, or they will keep passing
through the next plan change too.

**One caution from the wave that found it:** `scripts/bench/lib/plan.ts` deliberately
reads `plan_entitlements` at call time so constants cannot go stale — and its own
header comment still went stale anyway, asserting as *checked* that no pass tier had
an `officials.auto` row. That comment is corrected in place with the correction left
visible. A matrix fact written in prose beside matrix-reading code is a hazard however
carefully the code is written.
