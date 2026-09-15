# F6 — `standings.carry_over` reachability (#625)

**Status:** owner-approved brainstorm 2026-09-15 (design in chat; option locked with #707 wave).  
**Issue:** [#625](https://github.com/onryde/seazn.club/issues/625)  
**Programme index:** `docs/superpowers/specs/2026-08-17-format-progression-prompts/_INDEX.md` F6 row + ruling 12 (2026-08-19 amendment).

## Problem

`standings.carry_over` is a sold Pro entitlement (pricing matrix, feature-copy paywall, `requireFeature` at `createStages`). Carry is applied only inside `seedNextStage` on `timing: "on_complete"`. Since F3, every picker/gallery template emits `timing: "setup"`, and `ProgressionSchema` rejects `setup` + non-`none` carry. No UI sets `carry`. A Pro organiser who wants Phase-1 points in Phase 2 has nothing to click.

Nothing regresses for current organisers — no template emits carry today. The gap is reachability, not engine capability (`config.carry_deltas → openingDeltas` already folds).

## Goals

1. Apply carry at `confirmSeedProposal` the same way `seedNextStage` does.
2. Reject non-real table sources (`REAL_TABLE_KINDS`: league/group/swiss) at **propose** time with an `HttpError`, not only at complete-time.
3. Relax the schema refine so `setup` + `points`|`full` parses.
4. Add a picker control so organisers can turn carry on; gate remains `standings.carry_over`.
5. Keep the `on_complete` path behaviour unchanged.

## Non-goals

- Engine changes to `carryDeltas` / opening deltas.
- Changing default templates to emit carry (default stays `none` / omitted).
- Removing the entitlement or pricing row.
- Carry from bracket/ladder/americano sources (still refused).

## Design

### Backend — confirm path

In `confirmSeedProposal` (`stages.ts`), after freshness-verified `sourcesToTables` and after the final entrant set is known (`expandedEntries` values), when `progression.carry` is `points` or `full`:

1. Destructure `resolved` from `sourcesToTables` (today discarded at the confirm call site).
2. If any resolved source kind ∉ `REAL_TABLE_KINDS` → `HttpError` 422 with a stable code (reuse or add beside seeding-error helpers; message mirrors the EngineError text on the on_complete path).
3. Filter source table rows to the confirmed entrant ids; `carryDeltas(rows, mode)`.
4. `UPDATE stages SET config = { ...config, carry_deltas }` on the **target** stage (this `stageId`).
5. Append `standings_carried` to `division_events` (seq bump), payload `{ stageId, from, mode, entrants }` — `from` = primary/previous source stage id(s) consistent with `seedNextStage` (single previous or document multi-source `from` the same way multi-source on_complete tests expect).

Prefer a small shared helper used by both `seedNextStage` and `confirmSeedProposal` so the two paths cannot drift on filter/mode/event shape. Do not invent a second carry semantics.

### Backend — propose time

In `computeSeedProposal`, after `sourcesToTables`, if carry ≠ none and a source is non-real → 422 before returning a draft. Organisers learn at propose, not at confirm.

### Schema

Remove (or invert) the refine at `schemas.ts` that rejects `timing === "setup"` with non-none carry. Update the three tests that assert rejection so they assert **acceptance** of `setup`+`points`/`full`, and keep a test that still rejects nonsense (e.g. empty map for seeded_map).

Entitlement gate at `createStages` stays timing-agnostic (already correct).

### Picker UI

- Extend `StageDraft.progression` with optional `carry?: "none" | "points" | "full"`.
- Surface a control on multi-stage templates that emit progression (at least `league_ko` / `groups_ko` and any other progression-bearing template in `format-templates.ts`). Placement: `division-builder.tsx` (create wizard) and the matching edit surface if progression is editable there (`division-settings.tsx` / `stages-panel` add-stage only if it already writes progression — do not invent a third editor).
- Default: omitted / `none`.
- Values: None / Points only / Full (match `CarryMode`).
- Free/Community: control visible but selecting non-none hits existing 402 paywall on stage create (`standings.carry_over`).
- Copy in all four `ui.json` locales + `pnpm i18n:gen-keys`. Marketing strings already exist; do not duplicate under marketing unless the picker needs distinct help text.

### Tests (all four types per RULES)

| Type | What |
|---|---|
| Unit | Schema accepts setup+carry; propose rejects non-real source; confirm writes `carry_deltas` + one `standings_carried`; on_complete path still green (`custom-points`, multi-source). |
| E2E or walkthrough | Pro org: league→finals with carry Points; after confirm, Phase-2 standings open with carried points (or assert config/event via API the UI uses). |
| Smoke | Existing stage/progression smoke still green; no new scorer dependency. |
| Regression | Mutate: delete confirm carry write → unit fails; delete propose guard → unit fails. |

## Acceptance

- [ ] Pro organiser can set carry in the picker and get `carry_deltas` after confirm on a setup-timing stage.
- [ ] Non-real source + carry fails at propose with a clear 422.
- [ ] Schema no longer claims F6 unwired.
- [ ] Free org gets 402 on non-none carry at create (existing gate).
- [ ] `on_complete` + carry still works.

## Out of band

Ship before #707. Separate PR preferred.
