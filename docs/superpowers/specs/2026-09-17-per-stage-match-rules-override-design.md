# Per-stage match-rules override

Owner-approved 2026-09-17 (chat brainstorm, this session).

## Problem

`MatchRuleFields` (`apps/web/src/components/v2/match-rules.tsx`) — `bestOf`
and the rest of the per-sport match-format fields — is currently settable
only once, on `division.config`, applied to every fixture in every stage.
An organiser cannot run Best-of-1 in a league/Swiss stage and Best-of-3 in
the knockout/playoff stage of the same division.

Not Swiss-specific: `swiss_playoff` / `swiss_knockout` do not exist as
stage kinds or template keys anywhere in the tree (verified by grep,
zero hits) — PR #794 built them as **templates** that chain the existing
`swiss` and `knockout` `StageKind`s. Any multi-stage division (league_ko,
groups_ko, double_elim, page_playoff, swiss+knockout, …) has the identical
need, so this ships as a generic per-stage override, not a Swiss feature.

## Current resolution path (traced, not assumed)

One resolver already exists and is the single source of truth for match
format at scoring time:

- `resolveFixtureCfg(snapshot, divisionCfg, stageCfg)` —
  `apps/web/src/server/engine-db/fixture-cfg.ts:39`. Snapshot (frozen on
  first event, `append-event.ts:255`) wins outright; otherwise
  `stageScopedCfg(divisionCfg, stageCfg)`.
- `stageScopedCfg` — `apps/web/src/server/engine-db/stage-cfg.ts:11`.
  Overlays exactly two keys from `stage.config` onto `division.config`:
  `STAGE_DECIDER_KEYS = ["shootout", "extraTime"]`. `bestOf` and the rest
  of `MatchRuleFields` are not in this list today.
- Called from every read/write fold and every place that needs match
  format: `append-event.ts:245`, `fold.ts:155`, `competition.ts:278-282`,
  `event-import.ts:279`, `player-stats.ts:129-132`,
  `match-centre-load.ts:287`, `admin-fixture-config.ts:117,188`.
- Nothing bakes cfg into a fixture row at **generation** time — fixture
  inserts (`stages.ts:1420-1447`, `:2074`, `:2180`, `:3706`, `:3839`)
  write no config column. `config_snapshot` stays `null` until the
  fixture's first score event, then freezes the resolver's *output*
  (`fixture-cfg.ts` comment, lines 18-33) — so a fixture with zero events
  always reads **live** config, deliberately.

**Verified bug, same code path, fixed in this branch:** two pad-load entry
points bypass the resolver and read raw `division.config` directly instead
of `resolveFixtureCfg`:
- `apps/web/src/app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/f/[no]/page.tsx:119,171`
- `apps/web/src/app/score/[token]/page.tsx:84` (SQL selects `d.config` as
  `fixture.config`), `:145,168`

A pad can currently show a different `bestOf` than what the engine
actually folded against. Stage overrides are pointless if the surface
that renders them ignores the resolver, so this is fixed on this branch
rather than filed separately.

**`division.config` stores rule fields flat**, not nested — confirmed by
reading `buildRuleOverride`/`hydrateRuleValues`
(`match-rules.tsx:672,698`): `buildRuleOverride` returns
`{bestOf: 3, ...}` merged directly into `division.config`;
`hydrateRuleValues(sportKey, config)` reads those same flat keys back off
whatever config object it's given. So `stage.config.rules` is a **new**
namespace (there is nothing to "mirror" at the division level — it's
flat there), but both functions apply to it unchanged: call them with
`stage.config.rules ?? {}` instead of `division.config` and the same
field list, `build`, and `read` logic works with no adapter.

`StageConfig` (`apps/web/src/server/api-v1/schemas.ts:994-1027`) is a
`.strict()` zod object — an unknown key 400s (`:1029-1049`). No per-field
stage update exists today; the only way to change `stage.config` post
hoc is `replaceStages` (`stages.ts:363-388`), which deletes and
recreates the **whole stage graph** and 409s `FORMAT_LOCKED` the moment
any fixture exists anywhere in the division.

## Approaches considered

1. **Flatten new keys into `StageConfig`, extend `STAGE_DECIDER_KEYS`**
   per-key. Rejected — `MatchRuleFields` is a much larger surface than
   the two decider flags; flattening means `StageConfig` grows a
   parallel copy of every rule key and the resolver needs per-key
   fallback logic that only grows.
2. **`stage.config.rules` as a full replacement** of division rules
   (stage form pre-filled with every division value). Rejected — orphans
   a stage from later division-level rule edits; also means the UI must
   duplicate the whole division form into every stage even when only one
   field differs.
3. **Chosen: `stage.config.rules` as one nested object, partial merge,
   stage field wins per-key, unset fields still inherit from
   division.** Minimal schema surface, one merge point, reuses
   `MatchRuleFields`/`buildRuleOverride`/`hydrateRuleValues` verbatim.

## Design

### 1. Resolution (server)

`stageScopedCfg` gains a second overlay source, layered on top of the
existing `STAGE_DECIDER_KEYS` behavior (unchanged):

```ts
export function stageScopedCfg(divisionCfg, stageCfg) {
  if (stageCfg == null) return divisionCfg;
  const overlay: Record<string, unknown> = {};
  for (const key of STAGE_DECIDER_KEYS) {
    if (stageCfg[key] !== undefined) overlay[key] = stageCfg[key];
  }
  if (stageCfg.rules && typeof stageCfg.rules === "object") {
    Object.assign(overlay, stageCfg.rules); // stage rule fields win, per-key
  }
  if (Object.keys(overlay).length === 0) return divisionCfg;
  return { ...divisionCfg, ...overlay };
}
```

Merge order end to end: `snapshot (frozen) ?? {...divisionCfg, ...stage.config.rules}`.
A stage with no `rules` key is identity — existing single-stage divisions
resolve exactly as before (regression case).

Fix the pad-bypass sites to call `resolveFixtureCfg`/`stageScopedCfg`
instead of reading `division.config` raw:
- `f/[no]/page.tsx:119,171` — thread the fixture's stage id/config
  through to the resolver before building `rawConfig`/`sport.config`.
- `score/[token]/page.tsx:84` SQL — also select the fixture's
  `stage_id`/`stages.config`; `:145,168` — resolve through
  `resolveFixtureCfg` instead of aliasing `d.config` directly.

### 2. Schema

- `StageConfig` (`schemas.ts:994-1027`) gains one new optional key:
  `rules: z.record(z.string(), z.unknown()).optional()` — deliberately
  untyped/passthrough at this layer, matching how `division.config`
  itself is validated per-sport elsewhere (`fidelity.ts`'s
  `configSchema.parse`), not re-validated against a parallel
  rules-specific schema.
- New endpoint: `PATCH /divisions/:divisionId/stages/:stageId/rules`,
  body `{ rules: Record<string, unknown> }` (or `null` to clear back to
  "same as division"). Writes only `stages.config.rules` via
  `jsonb_set`/merge — never touches any other `config` key.
  **Deliberately exempt from `FORMAT_LOCKED`**: that gate protects
  structural fields (pools, legs, rounds, byes) whose change would
  invalidate an already-generated fixture graph. `config.rules` doesn't
  restructure anything — it only feeds `resolveFixtureCfg` at scoring
  time, and already-scored fixtures are unaffected regardless because
  freeze-on-first-event (`append-event.ts:255`) already pins their
  snapshot. Net effect: editable any time, and editing it mid-stage only
  changes format for fixtures in that stage **not yet started**.
- `createStages`/`replaceStages` payload (`CreateStages` schema) also
  accepts `rules` per stage at creation time; omitted = "same as
  division".

### 3. UI

- `MatchRuleFields` reused per-stage, called with
  `hydrateRuleValues(sportKey, stage.config?.rules ?? {})` instead of
  the division's config:
  - `division-builder.tsx` — per-stage step in the wizard, one
    "Same as division" toggle per stage that expands to `MatchRuleFields`
    on override; submits `rules` alongside each stage in `CreateStages`.
  - Fixture Console's fixtures tab (`stages-panel.tsx`, per
    `AGENTS.md`'s "Fixture Console" = division `?tab=fixtures` ruling —
    **not** `components/v2/fixture-console.tsx`) — a per-stage rules
    panel that calls the new `PATCH .../rules` endpoint, usable both
    before and after generation.
- No changes to `buildRuleOverride`/`hydrateRuleValues` themselves — same
  functions, different config object passed in.

### 4. Testing

- **Unit**: `stageScopedCfg` merge order (decider keys unaffected, rules
  partial-merge per field, identity when stage has no `rules`); new PATCH
  endpoint (writes only `config.rules`, 200s regardless of
  `FORMAT_LOCKED`, rejects on invalid stage id / division mismatch).
- **E2E**: build a swiss+knockout division, override the knockout stage
  to `bestOf: 3` while the swiss stage stays `bestOf: 1` (division
  default), generate both stages' fixtures, open the pad on a fixture in
  each stage, assert the rendered `bestOf` differs correctly per stage —
  this also closes the pad-bypass bug. Then score one fixture, edit that
  stage's rules again, and assert the scored fixture's frozen snapshot is
  unchanged while an unstarted sibling fixture in the same stage now
  resolves the new value.
- **Smoke**: division-builder wizard round-trip with a per-stage
  override, PR-only gate.
- **Regression**: existing division-level-only rules flow (no stage ever
  sets `rules`) resolves byte-identical to before this change.
- **Locales**: no new copy if the UI reuses `MatchRuleFields`'s existing
  field labels verbatim; the new "Same as division" toggle label needs
  en/es/fr/nl (`gen-keys` regen per `AGENTS.md`).
- **Screenshot**: division-builder per-stage step and the fixtures-tab
  stage-rules panel at 1280/320/768, no horizontal scroll at any width.

## Scope notes / explicitly out

- Not touching `STAGE_DECIDER_KEYS` (`shootout`/`extraTime`) — separate,
  pre-existing overlay, left as is.
- Not touching `replaceStages`'s `FORMAT_LOCKED` gate for structural
  fields — only `config.rules` gets its own narrower, unlocked path.
- Not adding a new `StageKind` or template — `swiss_playoff`/
  `swiss_knockout` are UI template labels over existing `swiss` +
  `knockout` kinds; no schema change needed there.
