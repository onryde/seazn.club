# Format templates — design (D1)

Date: 2026-08-13. Status: **approved design, creative-only** — build not
scheduled; owner green-light required. Origin: bench spec §14 item 1.
Sessions: P4 (catalog + single-stage instantiation), P7 (multi-stage,
after D4) in the portfolio index.

## Purpose

Organizers copy formats they trust. "Start from a famous format" turns a
blank create-competition wizard into picking "World Cup 32", "Wimbledon
128 knockout", "Swiss 11 rounds", "T20 groups + Super 8 + knockout" —
pre-wiring divisions, stages, points, tiebreakers, seeding and schedule
defaults. Owner ruling (2026-08-13): **curated built-ins only** in v1 —
no user-generated templates, no sharing.

## Design

### Template schema & catalog (P4)

- `apps/web/src/server/templates/schema.ts` — zod `CompetitionTemplate`:

```ts
{ key, version: number,               // bump on any change; instantiation stamps it
  i18n: { nameKey, descriptionKey },  // dictionary keys, not strings
  divisions: Array<{
    i18nNameKey, sportKey, variantKey,
    cfgOverrides?: object,            // validated via division-config snapshot path
    tiebreakers?: string[],           // omitted = sport default
    entrantKind: "team"|"pair"|"individual",
    entrantCount: number,             // placeholder count shown in wizard
    stages: Array<{
      i18nNameKey, kind: StageKind,
      size?: number, groups?: number,
      points?: PointsRule,
      seeding?: StageSeeding,         // D4 schema — multi-stage only (P7)
      scheduleDefaults?: { matchMinutes, gapMinutes, sessionWindows?,
                           suggestedCourtTags?: string[] } }> }> }
```

- Catalog: `apps/web/src/server/templates/catalog/*.json`, loaded +
  zod-parsed at module init; a unit test instantiates EVERY entry so a
  broken catalog cannot ship. Launch set (8): `wc32` (8 groups →
  KO w/ best-thirds off — KO hand-seeded until P7), `euro24` (6 groups →
  best-thirds R16 chain), `t20-super8` (4 groups → Super 8 groups →
  SF/F), `slam128` (single KO), `swiss11`, `league-playoff` (league →
  top-4 playoff), `americano-night`, `box-league` (parallel small
  leagues). `euro24`, `t20-super8`, `league-playoff` are P7 (need
  `seeding`); the rest ship in P4. CAVEAT for P4's scout: the api-v1
  `StageKind` enum (9) is wider than the DB `stages_kind_check` (6 as of
  V210) — `americano` and `page_playoff` must be verified against the
  CURRENT check constraint before those two templates ship; if rejected,
  swap `americano-night` for a second box-league variant and
  `league-playoff`'s playoff stage to `knockout(4)`, and record it in
  the portfolio index (the divergence itself stays a bench-spec §7
  triage item — do not widen the CHECK inside a template session).
- Bench packs later ENRICH this catalog: pack schema is a strict superset
  (adds real persons/streams/expected); a pack→template strip function is
  specified in the bench plan, not here.

### Instantiation (P4)

`POST /api/v1/competitions/from-template {template_key, name, overrides?}`
→ usecase `createFromTemplate(auth, input)`:
1. create competition (existing usecase),
2. per division: create with sport/variant/cfg/tiebreakers (existing
   validation path — a template can never bypass config validation),
3. per stage: create with kind/size/points (+ `seeding` in P7, which also
   generates TBD fixtures via D4),
4. stamps `competitions.template_key` + `template_version` (provenance,
   analytics),
5. returns the created tree; wizard routes into the entrant-add step with
   placeholder counts as guidance (no fake entrants created).

Partial failure = transaction rollback; the wizard never receives a
half-instantiated competition.

### UI (P4)

Create-competition wizard step 0: template gallery (card per template:
localized name/description, division/stage shape summary, entrant count)
+ "start blank". Detail sheet shows the full structure before commit.
Full polish; 320/768/1280; gallery is a grid that collapses to one column.

## Testing (all four)

- Unit: schema parse of every catalog entry; instantiation of every entry
  against a test org (structure counts, cfg snapshots valid, provenance
  stamped); rollback on induced mid-instantiation failure.
- Regression: each template's instantiated shape pinned (divisions ×
  stages × kinds table) so a catalog edit that changes shape reds.
- E2E: pick template → wizard → competition page shows structure →
  entrant step shows placeholder guidance.
- Smoke: `from-template` for one template, then normal flow continues.

## i18n

Template names/descriptions/division/stage name keys ×4 locales (flat
dotted keys, `templates.*` namespace). No hardcoded English anywhere in
catalog JSON — keys only.

## Dependencies & sequencing

P4 has no dependency on other designs. P7 needs D4's `StageSeeding`
merged (encodes it) — P7 sits after P5/P6 in the index. D5 later: only
`suggestedCourtTags` touches it (string hints, valid with or without the
venue model). OpenAPI regen owed. Structured logging: pino
`competition_from_template` (key, version).

## Risks / re-pin

Create-usecase signatures (`createCompetition`/`createDivision`/stages)
re-pinned at plan time. `StageKind` API-vs-DB divergence (9 vs 6) — the
catalog uses DB-checked kinds only; the divergence itself stays a §7-triage
item in the bench spec.

## Non-goals

No user-generated/save-as-template, no template marketplace/sharing, no
entrant seeding data in templates, no venue references (tags as hints
only).
