# Per-stage match-rules override — sets-based sports

Owner-approved 2026-09-17 (chat). Supersedes the v1 draft of the same date;
v1's design survived review only in outline, and every ruling below is a
correction to it. Line numbers pinned against `main` `dc64cfcd6`
(contains #794 `f3dcbdb8b` and spectator #797 `22a9f6131`).

## Problem

Match format — `bestOf` and its neighbours in `MatchRuleFields`
(`apps/web/src/components/v2/match-rules.tsx`) — is settable once, on
`division.config`, and applies to every fixture of every stage. An
organiser cannot run Best-of-1 in the league/Swiss stage and Best-of-3 in
the knockout/playoff stage of the same division.

Not Swiss-specific. `swiss_playoff` / `swiss_knockout` are **template**
keys over the existing `swiss` and `knockout` `StageKind`s (#794); they are
not stage kinds. (`swiss_knockout` does appear as a legacy string at
`apps/web/src/server/migration/v1-map.ts:17` and in
`packages/engine/src/testkit/simulation.ts:69,1025`, where v1 imports are
split into two stages — a real customer for this feature, not a
counter-example.) Every multi-stage template has the identical need, so
this is a generic per-stage override.

## Scope — sets-based sports only

Owner ruling 2026-09-17: **tennis, badminton, tabletennis, volleyball.**
Their entire rule surface is nine keys:

| Sport | Overridable keys |
| --- | --- |
| volleyball | `winBy`, `bestOf`, `setTo`, `finalSetTo`, `cap` |
| badminton | `bestOf`, `setTo`, `finalSetTo`, `cap` |
| tabletennis | `bestOf`, `setTo`, `finalSetTo` |
| tennis | `bestOf`, `setType`, `finalSet`, `noAd`, `tiebreakWinBy` |

`SPORT_RULES` sources: volleyball/badminton/tabletennis via the shared
consts at `match-rules.tsx:56-165` (wired at `:360-362`), tennis at
`:363-428`.

This scoping is load-bearing, not cosmetic. It removes three whole classes
of problem found in review rather than deferring them:

- **No `points.*` key exists in any sets sport**, so a stage override
  cannot reach `standingsDelta`'s `cfg.points` and cannot bypass the
  `standings.custom_points` entitlement gate (`stages.ts:276-282`).
- **No `shootout` / `extraTime`** in any sets sport, so the new key cannot
  become a second source for `STAGE_DECIDER_KEYS`
  (`engine-db/stage-cfg.ts:9`), which stays untouched.
- **No `teamSize` / `playersPerSide` / `goalkeeper`**, so the lineup
  catalog is not cfg-coupled for these sports (see "Known gaps").

## Current resolution path (re-verified on `dc64cfcd6`)

- `resolveFixtureCfg(snapshot, divisionCfg, stageCfg)` —
  `engine-db/fixture-cfg.ts:39`. Frozen snapshot wins; else
  `stageScopedCfg`.
- `stageScopedCfg` — `engine-db/stage-cfg.ts:11`, overlaying exactly
  `STAGE_DECIDER_KEYS = ["shootout","extraTime"]` (`:9`).
- Callers: `append-event.ts:245`, `fold.ts:155`, `competition.ts:278-282`,
  `event-import.ts:279`, `player-stats.ts:129-132`,
  `match-centre-load.ts:287`, `admin-fixture-config.ts:117,188`,
  `org-posts.ts:761`.
- Nothing bakes cfg into a fixture at generation time; `config_snapshot`
  freezes the resolver's OUTPUT on the first event
  (`append-event.ts:255,328`). A fixture with zero events reads live cfg
  deliberately (`fixture-cfg.ts:24-28`).
- `StageConfig` — `schemas.ts:994-1035`, `.strict()`; `pairing:1018`,
  `points:1027`, `shootout:1032`, `extraTime:1033`. `rules` inserts after
  `:1033`. #797 added only `PublicOrgLive` to this file — no contention.

**Five surfaces bypass the resolver and read raw `division.config`:**

| Site | What it feeds |
| --- | --- |
| `d/[divSlug]/f/[no]/page.tsx:119` | `rawConfig` → pad bootstrap |
| `d/[divSlug]/f/[no]/page.tsx:171` | `sport.config` → `<FixtureConsole>` |
| `score/[token]/page.tsx:84` | SQL selects `d.config` as `fixture.config` |
| `score/[token]/page.tsx:145` | `rawConfig` → device pad |
| `score/[token]/page.tsx:168` | `config` → device pad |

The comment at `score/[token]/page.tsx:104-105` ("the device link's fixture
carries its own resolved `config` column") is false and is corrected here.
The pad skins read these directly — `tennis.tsx:268,505`,
`badminton.tsx:351,584`, `volleyball.tsx:496,648`, each `cfg.bestOf ?? n` —
so today a pad can render a different `bestOf` than the fold uses. Fixed on
this branch: stage overrides are inert if the surface that renders them
ignores the resolver.

**Rule values do not round-trip.** `buildRuleOverride` (`:672`) returns a
flat object; `hydrateRuleValues` (`:698`) rebuilds form values through each
field's `read`. **Of 52 field entries, exactly 2 implement `read`**
(`:266`, `:280` — football shoot-out points). None of the nine keys above
has one, so a saved override reopens blank. This is a live defect in the
division editor today, not new work this feature invents.

## Rulings

**D1 — lock scope.** `patchDivision` freezes match format division-wide once
any fixture exists: `withoutEntrants` strips only `entrants`
(`divisions.ts:582`), and `nonEntrantsChanged` 409s `FORMAT_LOCKED`
(`:808-815`, `:839-843`). v1's "editable any time" was a silent reversal of
that. **Ruling: a stage's rules stay editable until the first fixture IN
THAT STAGE starts, then lock.** This serves the real case — set the
knockout to Bo3 while the league is still running — and prevents unequal
rounds inside one stage (Bo1 early, Bo3 late), which is a fairness defect,
not a feature. Division-level locking is unchanged.

**D2 — allowlist.** The nine keys above, per sport, derived from
`SPORT_RULES[sportKey]` rather than a hand-typed list. Anything else 400s.
The MERGED `{...division.config, ...rules}` is validated through the sport
module's `configSchema` and 422s `CONFIG_INVALID` exactly as
`patchDivision` does (`divisions.ts:797-803`). The fragment alone cannot be
parsed — defaults would fill it — so the merge is what gets parsed.

**D3 — the public format line is IN SCOPE** (owner, 2026-09-17). The hub's
`formatLine` is built from raw division config at
`server/public-site/competition-hub.ts:665`
(`describeFormat(d.sport_key, module_, d.config)`), its only production
caller. Left alone, the hub would tell spectators "Best of 1" for a Bo3
knockout. Cost, accepted: a `competition-hub-schema.ts` change (`:119`), an
`openapi/v1*.json` regen, and a **`pub-hub-v3` → `pub-hub-v4` cache bump**
(`competition-hub.ts:1042`) — `unstable_cache` otherwise serves an
old-shaped document. #797 rewrote this file heavily, so re-read before
editing.

**D4 — i18n.** The nine labels are hardcoded English literals today.
Translate them into all four dictionaries; `gen-keys` regen, zero drift.
This also fixes the existing division editor.

**D5 — no entitlement gate.** Per-stage rules are core format settings, not
a paid surface. D2's allowlist is what keeps `points` out of reach.

## Design

### T1 — resolver

`stageScopedCfg` gains a second overlay source; the decider-key loop is
untouched:

```ts
if (isPlainObject(stageCfg.rules)) Object.assign(overlay, stageCfg.rules);
```

Merge order: `snapshot ?? {...divisionCfg, ...stage.config.rules}`. A stage
with no `rules` is identity — the existing reference-identity assertion at
`stage-cfg.test.ts:24-27` must keep passing. `Object.assign` copies explicit
`null`s, so **"inherit" is key ABSENCE, never `null`**; the endpoint strips
nulls on the way in.

### T2 — atomic stage-config writes

Six writers rewrite a stage's whole config from a JS-side read, with no
lock: `stages.ts:3176,3265,3699,3876`, `scoring.ts:555,567`. A rules write
landing inside that window is silently lost. #794 already shipped the fix
pattern at `stages.ts:764` — `config || jsonb_build_object('rounds', …)`,
a server-side merge. Convert all six, and have the new endpoint write the
same way.

### T3 — endpoint

`PUT /stages/:id/rules`, following `putStageCourtTags`
(`stage-court-tags.ts:145-180`): `withTenant`, `stageOrThrow`,
`frozenCompetitionIds` + `assertNotFrozen`, D1's per-stage lock, D2's
allowlist and merged-config validation, the T2 atomic write, and an
**awaited** revalidation — `stages.ts` has four `void fireStageRevalidate`
calls recorded as a defect (spectator W2 handoff §8, P1c); do not add a
fifth. Body `{rules: {...}}`; `{rules: null}` clears back to the division. This
endpoint is the ONLY writer — `createStages` is deliberately left alone,
since the builder no longer offers rules (T6) and no other caller needs
them at creation. OpenAPI regen (`ci.yml:92-96` gates drift).

### T4 — resolver threading

Route the five pad sites through `resolveFixtureCfg`. Both pages must also
select the fixture's stage config; `score/[token]/page.tsx:84` currently
selects `d.config` alone.

### T5 — `read` for the nine keys

Implement `read` on each of the nine `RuleField`s so the stage panel (and
the division editor) hydrate. With `read` complete for the exposed set, the
PATCH carries the full override and replace-vs-merge stops being ambiguous:
**the endpoint replaces `config.rules` wholesale** with the form's output.

### T6 — UI: the Fixture Console only

Owner ruling 2026-09-17: **no division-builder change.** The only editor is
the fixtures tab `stages-panel.tsx` (the owner's "Fixture Console") — a
per-stage rules panel calling `PUT /stages/:id/rules`, usable before and
after generation, disabled with a reason once D1's lock bites. This is
where an organiser stands when they decide the knockout's format, and it
keeps the wizard, its payload and its screenshot round out of scope.

`structureDraftsForApply` (`division-settings.tsx:213-227`, applied at
`:551-553`) rebuilds stage drafts from the template and drops stored
config — it must still carry each surviving stage's `rules` forward, with a
test that fails without it. That path is reachable from the Format tab
regardless of where rules were set.

### T7 — public format line (D3)

Make `formatLine` stage-aware in the hub document, schema + regen + cache
bump as above.

## Testing

- **Unit** — `stageScopedCfg` (identity when no `rules`; per-key override;
  decider keys unaffected; `null` never overrides). Endpoint: allowlist
  rejection, merged-config 422, D1 lock boundary, tenancy, freeze. Each
  verified by mutation: break the predicate, confirm a named test reds.
- **E2E** — a sets-sport division, league/Swiss at Bo1 and knockout at Bo3,
  both generated; open the pad on a fixture in each stage and assert the
  rendered set structure differs. **Prove the selector is visible in pad
  DOM before relying on it**, or the test passes vacuously. Then: score a
  fixture, edit that stage's rules, assert the scored fixture's frozen
  snapshot is unchanged while an unstarted sibling picks the new value, and
  assert the lock refuses once the stage has started.
- **Regression** — (a) a frozen `config_snapshot` differing from live
  division config renders from the snapshot on both pad routes; (b) a stage
  carrying only `shootout` still overlays as before; (c) a division with no
  stage rules anywhere resolves byte-identically. (a) and (b) are the real
  regression risk of T4 and are invisible to a "no override" test.
- **Smoke** — Fixture Console round-trip: set a stage override, reload,
  confirm it hydrates back into the panel (the `read` gap in T5 is exactly
  what makes this fail today).
- **Visual** — contact sheet at 320/390/768/1024/1280, per-screen verdicts,
  owner sign-off before PR (spectator programme gate applies to T7's hub
  change).
- Full spec files for e2e, never a `-g` slice; JSON reporter counts only.

## Known gaps — recorded, not fixed

- **Four lineup-catalog sites still read raw `division.config`**:
  `d/[divSlug]/f/[no]/page.tsx:70`, `score/[token]/page.tsx:107`,
  `usecases/fixtures.ts:312,320` (SQL `:380`), `d/[divSlug]/page.tsx:37,269`.
  The catalog is cfg-derived (`lineup-catalog.ts:4-30`: football `teamSize`,
  cricket `playersPerSide`, hockey `goalkeeper`) — all team sports, none in
  this scope. They become live defects the day a team sport gains a
  stage-overridable `teamSize`; that wave owns them.
- `event-import.ts:250-255` gates DLS entitlement on `division.config` by
  deliberate comment. Cricket, out of scope; a stage override must not move
  that gate.
- Team sports (`points.*`, `shootout`, `extraTime`, `teamSize`) are
  deliberately excluded. Extending to them re-opens D2's entitlement and
  two-sources questions and owes its own design round.
- **Per-ROUND overrides are out** (owner, 2026-09-17: "per stage only").
  The unit is the stage: a Swiss stage at Bo1 and its playoff stage at Bo3.
  Round 5 of a Swiss differing from rounds 1-4 is NOT buildable on this
  design — a round is an integer column on `fixtures`, not a row that can
  carry config — and it would re-open the mid-stage fairness question D1
  closes. Its own design round if it is ever wanted.
