# Programmes master index (living doc)

One page to sequence ACROSS programmes. Session content lives in each
programme's own `_INDEX.md` + prompts — never duplicated here. Update
this file whenever a programme's status or a cross-gate changes.
Last updated: 2026-08-13.

## The four active programmes

| Programme | Dir / index | Sessions | Status |
|---|---|---|---|
| ScoringPad v2 (#407) | `../2026-08-06-scoringpad-v2-prompts/_INDEX.md` | S1–S13, L1–L3 | S1–S9 done; S10 in flight; S11–S13, L-lane open |
| Release-2 scheduling | `../2026-08-12-release2-prompts/_INDEX.md` | C0–C8 | C0 done; C1 in flight; C2–C8 open |
| Product portfolio (D1–D7) | `portfolio-prompts/_INDEX.md` | P1–P11 | authored; build-gated per session (owner green-light) |
| Scheduler bench | `bench-prompts/_INDEX.md` | B00–B18 | authored; hard-gated (see below) |
| Format progression | `../2026-08-17-format-progression-prompts/_INDEX.md` | F1–F5 | F1 authored + planned; F2–F5 blocked on prod row counts. **F1 waits for L3/#414 to merge** (shared `stages.ts`) |

## Cross-programme gates

```
ScoringPad S13 ─┬─► bench B00+ (master gate, with C8)
                └─► portfolio P11 (batch import)
Release-2  C8  ─┬─► bench B00+ (master gate, with S13)
     C-chain   ─└─► portfolio P8–P10 (venues: shared schedule.ts/build.ts)
Portfolio P5   ───► P6 ───► P7        (progression → UI → multi-stage templates)
Portfolio P4   ───► P7
Bench B15      ───► B17               (disruption reuses suite 8 org)
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

- Bench: `designs/2026-08-12-scheduler-bench-design.md`
- Portfolio: `designs/2026-08-13-{capacity-precheck,schedule-health,
  news-enrichment,format-templates,stage-progression,venues-courts,
  batch-event-import}-design.md`
- Release-2 + ScoringPad: listed in their own indexes.
