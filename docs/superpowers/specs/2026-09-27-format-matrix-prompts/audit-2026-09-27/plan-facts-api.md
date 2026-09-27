# Format-matrix harness — API facts (read-only research, worktree `format-matrix` @ 3136e1c1a)

All paths below are relative to `apps/web/src/` unless they start with `packages/` or `apps/`.
`schemas.ts` = `server/api-v1/schemas.ts`. `ks:N` = `server/api-v1/key-scopes.ts` line N.
Every claim below comes from reading the file, not from running it. Section F (per sport) is in
`plan-facts-sports.md` beside this file, and it is summarised at the end of this file.

---

## 0. Cross-cutting wire rules

### Envelope (`server/api-v1/http.ts`)
- Success: `{ ok: true, data, requestId }`. The status is 200, or whatever `reply(n, …)` sets (201 on creates). A 204 has no body (http.ts:139-148).
- Error: `{ ok: false, error: { code, message, ...extra }, requestId }` (http.ts:101-116).
  - A ZodError gives **400 `VALIDATION`**, with `error.issues` (http.ts:151-154).
  - An EngineError is mapped by `ENGINE_HTTP` (http.ts:20-72). `SEQ_CONFLICT` gives **409** plus `error.current_seq`. `SCHEDULE_CONFLICT` gives 409 plus `conflicts`. `INVALID_EVENT`, `WRONG_PHASE`, `ALREADY_DECIDED`, `LINEUP_INVALID`, `CONFIG_INVALID`, `STAGE_NOT_READY`, `DRAW_NOT_ALLOWED`, `QUALIFICATION_INVALID`, `ELIGIBILITY`, `MODULE_NOT_FOUND` and the `SEEDING_*` codes all give **422**. `STAGE_NOT_READY` with reason `group_too_few_entrants` or `seeded_pool_too_few_qualifiers` also carries `groups`, `entrants`/`qualifiers`, `required` and `stranded`.
  - `PaymentRequiredError` gives **402 `PAYMENT_REQUIRED`**, plus `feature`, `feature_key` and `reason`.
  - `AuthError` gives 401 `UNAUTHENTICATED`.
  - `HttpError(status, msg, code?, extra?)` gives that status. The code is its own, or the fallback from the status: 400 VALIDATION, 401, 402, 403 FORBIDDEN, 404 NOT_FOUND, 409 CONFLICT, 429 RATE_LIMITED (http.ts:75-86).
- `parseBody` sends **400 "Request body must be valid JSON"** for a missing or malformed body (http.ts:252-260). So a POST with **no body** 400s on every route that uses `parseBody`. Four routes tolerate an empty body: `/divisions/:id/start` (it parses `req.json().catch(()=>({}))`), `/stages/:id/generate` (it reads text and treats empty as `{}`), and `complete`, `rebuild`, `unpair` and `seed-proposal` (these read no body at all).

### Auth (`server/api-v1/auth.ts`)
- Two doors: the **session cookie**, or `Authorization: Bearer sc_…` (an API key; legacy prefix also accepted) (auth.ts:1-4, 40).
- Session: `requireAuth`/`requireOrgAuth`/`requireResourceAuth` with `"write"` needs an EDITOR role (owner/admin). `"read"` needs a READ role (auth.ts:210-226, 302-313). `requireAuth` resolves the org from the **active-org cookie** (auth.ts:302-313).
- Fixture scoring: `requireFixtureActor(req, id, "score")` passes owner/admin, a key, a device link, or an accepted official (auth.ts:237-296).
- API keys: need the org feature **`api.access`** (Pro) (auth.ts:~149 `requireFeature(key.org_id,"api.access")`). Keys are default-deny against the route table `RULES` (ks:55). Scope rank is `read < score < manage`, and the legacy `write` counts as manage (ks:13-30). A pinned key gets 403 on a different competition. There is a per-key rate limit, 429 (auth.ts:~94).
- **Recommendation for the harness:** a session cookie (the e2e `AUTH_STATE` pattern) avoids the Pro `api.access` gate and the key rate limit. The scope column below only applies if you use keys.

### Scoring gate
Every event write to a fixture in a division whose status is `setup` or `scheduled` is refused with **422 `WRONG_PHASE`** "division has not started — scoring is closed" (`server/usecases/scoring.ts:494-498`, `lib/division-phase.ts:18-20`). **Start the division before scoring anything.**

### Entitlement gates you will hit per format (server/usecases/stages.ts:366-414, format-gates.ts:38-52)
- A stage of kind `double_elim` **or `page_playoff`** needs feature `formats.double_elim` (Pro).
- A stage of kind `americano` or `ladder`, or any stage config with `byes`, `cross_feeds` or `placements`, needs `formats.advanced`.
- A stage `config.points` with bonuses or a forfeit rule needs `standings.custom_points`.
- `config.h2h_scope:"overall"` needs `tiebreakers.custom`.
- A progression with `carry` other than `none` needs `standings.carry_over`.
- `POST /stages/:id/challenges` needs `formats.advanced` (stages.ts:5512).
- `PATCH /divisions/:id {auto_progress:true}` needs `formats.advanced` (divisions.ts:655-657).
- `POST /stages/:id/standings/override` needs `tiebreakers.custom` (stages.ts:4649).

---

## A. Competition / division / stages / settings

### A1. Create competition — `POST /api/v1/competitions`
- Route: `app/api/v1/competitions/route.ts:13-18`. Auth: `requireAuth(req,"write")`, which uses the active org. Key scope `manage` (ks:74).
- 201 → `CreatedCompetition` = `Competition` + `public_quota_degraded?` (schemas.ts:178-194, 260-263).
```ts
// schemas.ts:116-144
export const CreateCompetition = z
  .object({
    name: z.string().min(1).max(200),
    slug: Slug.optional(), // derived from name when omitted
    description: z.string().max(20_000).nullish(),
    starts_on: z.iso.date().nullish(),
    ends_on: z.iso.date(),                       // MANDATORY (#376)
    visibility: Visibility.default("public"),    // ["private","unlisted","public"]
    branding: z.record(z.string(), z.unknown()).default({}),
    discoverable: z.boolean().optional(),
  })
  .superRefine(checkDateOrder);                  // ends_on < starts_on → 400
// Slug (schemas.ts:69-73): /^[a-z0-9]+(?:-[a-z0-9]+)*$/, 1..80
```
- Refusals: 400 when `ends_on` is missing or backwards. Public/unlisted visibility may silently **degrade to private** when the public-dashboard cap is hit (`public_quota_degraded` is set). Public reads 404 for a private competition (see E5). **Send `visibility:"unlisted"` or `"public"` if you need the public reads.**
- `PATCH /api/v1/competitions/:id` takes `PatchCompetition` (schemas.ts:156-176): all fields are optional, an empty patch is refused, `status ∈ draft|published|live|completed|archived`.
- `POST /api/v1/competitions/from-template` (`CreateFromTemplate`, schemas.ts:1181-1197; route `competitions/from-template/route.ts:10-16`) takes a **competition-catalog** `template_key`. **It is NOT the format-template list.** It returns `{competitionId, slug, visibility, divisions:[{id, stages:[{id,fixtureCount}]}], templateKey, templateVersion}` (schemas.ts:1202-1227).

### A2. Create division — `POST /api/v1/competitions/:id/divisions`
- Route `competitions/[id]/divisions/route.ts:19-25`. `requireResourceAuth(competition, write)`. Scope `manage` (ks:83). Returns **201 `Division`** (schemas.ts:479-504).
```ts
// schemas.ts:384-400
export const CreateDivision = z
  .object({
    name: z.string().min(1).max(200),
    slug: Slug.optional(),
    sport_key: z.string().min(1),
    variant_key: z.string().min(1),
    config: z.record(z.string(), z.unknown()).default({}),   // sport-rule overrides, merged over variant
    tiebreakers: z.array(TiebreakerKeyS).nullish(),
    category: DivisionCategory.nullable().optional(),         // open|mens|womens|mixed
    age_min / age_max: z.number().int().min(0).max(120).nullable().optional(),
    age_cutoff_month: z.number().int().min(1).max(12).nullable().optional(),
    age_cutoff_day: z.number().int().min(1).max(31).nullable().optional(),
    eligibility_note: z.string().max(2000).nullable().optional(),
  })
// TiebreakerKeyS (schemas.ts:272-276):
// "points","wins","h2h_points","h2h_diff","h2h_for","diff","for","nrr","set_ratio","game_ratio",
// "board_ratio","point_ratio","buchholz","buchholz_cut1","sberger","direct","fair_play","seed","lots"
```
- Server validation (`server/usecases/divisions.ts` createDivision): an unknown sport gives **422** `unknown sport 'x'`, and an unknown variant gives **422** `unknown variant 'v' for s`. It merges `{...variant.config, ...input.config}` and parses that with `sportModule.configSchema`. A parse failure gives **422 `CONFIG_INVALID`** with `issues`.
- **Valid `variant_key` per sport.** These are the rows `sync:sports` writes from `module.variants` (scripts/sync-sports.ts:63-80), read from each module's `variants:` block:
  | sport | variants (file:line) | entrant kinds (entrantModel) |
  |---|---|---|
  | football | `11-a-side`, `youth`, `small-sided`, `mini-soccer` (sports/football/football.ts:2447) | team (2446) |
  | cricket | `t20`, `odi`, `hundred`, `test` (cricket/cricket.ts:3549) | team (3533) |
  | boardgame | `classical`, `rapid`, `blitz` (boardgame/boardgame.ts:579) | individual (578) |
  | carrom | `icf`, `club-29` (carrom/carrom.ts:817) | individual, pair (816) |
  | generic | `win_loss`, `score` (generic/generic.ts:507) | no model, so all three kinds |
  | volleyball | `indoor`, `beach` (setbased/volleyball.ts:44) | team, pair (136-140) |
  | badminton | `bwf`, `short` (setbased/badminton.ts:39) | individual, pair (80) |
  | tabletennis | `bo5`, `bo7`, `hardbat-21` (setbased/tabletennis.ts:39) | individual, pair (89) |
  | tennis | `tour`, `grand-slam`, `fast4`, `doubles-noad-mtb10` (tennis/tennis.ts:27) | individual, pair (55) |
  | icehockey | `iihf`, `recreational` (icehockey/icehockey.ts:178) | team (219) |
  | hockey | `fih-outdoor`, `fih-shootout`, `youth` (hockey/hockey.ts:137) | team (190) |
  (All module paths are under `packages/engine/src/sports/`.) A division can narrow the kinds through `config.entrants.{kinds,defaultKind}` (packages/engine/src/sport/entrant-model.ts:23-44).

### A3. Division settings — `PATCH /api/v1/divisions/:id`
- Route `divisions/[id]/route.ts:16-23`. Scope `manage` (ks:120). Returns the updated division.
```ts
// schemas.ts:411-438  (.partial(), empty patch refused)
name, description, tiebreakers: z.array(TiebreakerKeyS).nullable(), category, age_*, eligibility_note,
status: DivisionStatus /* setup|scheduled|active|completed */, officials_hide_names, auto_progress: z.boolean(),
auto_posts, show_seeds, youth, player_name_display: z.enum(["full","first_initial"]).nullable(),
logo_storage_path, variant_key: z.string().min(1).max(100), config: z.record(z.string(), z.unknown()),
required_court_tags: RequiredCourtTags
```
- `auto_progress` **defaults to false** (db/migration/jul3/V249__format_extensions.sql:20). With it false the harness must call `POST /stages/:id/complete` itself. With it true, scoring's `onDecided` auto-completes the stage (scoring.ts:811-813), and that needs `formats.advanced`.
- A variant or config change after fixtures exist is `FORMAT_LOCKED`. This is the same rule `replaceStages` cites (stages.ts:477-483 comment, 514-517).
- **Points** live in two places:
  1. **Sport config.** The division `config` carries the sport's own points, e.g. the hockey `fih-shootout` preset has `points:{win,draw,loss,shootoutWin,shootoutLoss}` (hockey.ts:139-143), and the e2e generic divisions send `config:{points:{w:3,d:1,l:0}, progressScore:false}` (e2e/formats.spec.ts:398).
  2. **Per-stage competition points.** Stage `config.points` is a `PointsRule`, validated at stage create against the sport's metrics (stages.ts:434-440):
```ts
// packages/engine/src/competition/points.ts:12-37
export const PointsRule = z.object({
  base: z.object({ win: z.number(), draw: z.number(), loss: z.number() }),
  bonuses: z.array(z.object({
      when: z.enum(["loss_margin_lte","win_margin_gte","score_ratio_gte","draw","forfeit_win","forfeit_loss","no_result"]),
      param: z.number().optional(),
      points: z.number(),
  })).default([]),
  forfeit: z.object({ winnerPoints: z.number(), loserPoints: z.number(),
                      awardScore: z.tuple([z.number(), z.number()]).optional() }).optional(),
});
```

### A4. Stages from a format template — `POST|PUT /api/v1/divisions/:id/stages`
- **There is no server endpoint that takes a format-template key.** The 16 keys live client-side in `components/v2/format-templates.ts:65-297` (`STAGE_TEMPLATES`) and are expanded by `buildTemplateStages(key, knobs)` (format-templates.ts:333-341). The division builder then POSTs the resulting array: `division-builder.tsx:429-448` does `POST /competitions/:id/divisions`, then `POST /divisions/:id/stages` with `stages.map((s,i)=>({...s, seq:i+1}))`. **The harness should import `buildTemplateStages` (and `applyStandingsCarry`) or copy the table below, and add `seq`.**
- Routes: `divisions/[id]/stages/route.ts`. GET is at 8-14 (read, ks:157). **PUT (replaceStages) is at 18-25** and returns the array. **POST (createStages) is at 28-35** and returns 201 with one stage object or an array, mirroring the input shape. Scope is `manage` for both (ks:158-159).
```ts
// schemas.ts:1063-1074
export const CreateStage = z.object({
    seq: z.number().int().min(1),
    kind: StageKind,  // "league","group","swiss","knockout","double_elim","stepladder","page_playoff","americano","ladder" (schemas.ts:79)
    name: z.string().min(1).max(200),
    config: StageConfig,
    progression: ProgressionSchema.nullish(),
  }).strict();                                       // unknown keys → 400
export const CreateStages = z.union([CreateStage, z.array(CreateStage).min(1).max(20)]);

// schemas.ts:1003-1053  StageConfig = z.strictObject({...}).default({})   (unknown key → 400)
legs?: int 1..8; pools?: { count: int>=1 } (strict); thirdPlace?: boolean; byes?: string[];
slotOrder?: (int|null)[]; bracketReset?: boolean; mode?: "americano"|"mexicano"; courtCount?: int>=1;
rounds?: int>=1; chess?: boolean; pairing?: "fold"|"rank_adjacent"; challengeRange?: int>=1;
ladder_order?: string[]; qualified?: string[]; h2h_scope?: "overall"; rngSeed?: number;
points?, carry_deltas?, rank_overrides?, cross_feeds?, placements?, shootout?, extraTime?: unknown;
rules?: record|null   // but createStages/replaceStages REFUSE any `rules` key → 400 RULES_NOT_ACCEPTED_HERE (stages.ts:315-322)

// schemas.ts:932-964
export const ProgressionSchema = z.object({
    sources: z.array(z.object({
        stage: z.union([z.literal("previous"), z.object({ stageId: Uuid }).strict()]),
        take: z.array(TakeRuleSchema).min(1).max(8) }).strict()).min(1).max(8),
    placement: z.enum(["seeded_map", "snake", "rank_order"]),
    map: z.array(z.object({ slot: z.string().min(1).max(20), source: z.string().min(1).max(40) }).strict()).max(64).optional(),
    timing: z.enum(["setup", "on_complete"]),
    carry: z.enum(["none", "points", "full"]).optional(),
  }).strict()   // seeded_map needs non-empty map
// TakeRuleSchema (schemas.ts:886-911), all .strict():
//  {kind:"rankRange", from:int>=1, to:int>=from} | {kind:"topNPerGroup", n:int 1..16}
//  | {kind:"bestNth", nth:int>=1, count:int>=1, normaliseUnequalPools?:boolean}
//  | {kind:"picks", picks:[{pool:string, rank:int>=1}]} | {kind:"roundLosers", round:int>=1, count:int>=1}
```
- **Template table**, verbatim from format-templates.ts:69-296. After it, `buildTemplateStages` stamps three things: `rounds = knobs.swissRounds` on every swiss stage, `legs = knobs.legs` on every league/group stage, and `pools={count:knobs.poolCount}` on group stages. Knobs are `{qualified, swissRounds, poolCount, legs}`. The builder clamps them to qualified 2..32 and pools 2..8 (division-builder.tsx:384-391). The builder's `legs` defaults to 1 (division-builder.tsx:292).
  | key | stages (kind name config → progression) |
  |---|---|
  | league | league "League" {legs:1} |
  | triple_rr | league "Triple RR" {legs:3} — **see the warning below** |
  | league_ko | league {legs:1} → knockout "Finals" {} prog rankRange 1..q, rank_order, setup |
  | groups_ko | group "Group stage" {legs:1,pools:{count:poolCount}} → knockout; take = [topNPerGroup n=floor(q/pools)] + [bestNth nth=n+1,count=r,normaliseUnequalPools:true] when r>0 |
  | group_stepladder | league {legs:1} → stepladder "Stepladder finals" rankRange 1..q |
  | group_playoffs | league {legs:1} → page_playoff "Playoffs" rankRange 1..4 |
  | swiss | swiss {rounds:5} |
  | swiss_playoff | swiss {pairing:"rank_adjacent"} → page_playoff rankRange 1..4 |
  | swiss_knockout | swiss {pairing:"rank_adjacent"} → knockout rankRange 1..q |
  | knockout | knockout {} |
  | ko_plate | knockout "Main draw" {} → knockout "Plate" {} prog roundLosers round 1 count q |
  | qualifying_main | knockout "Qualifying" {} → knockout "Main draw" rankRange 1..q |
  | double_elim | double_elim {} (Pro gate) |
  | americano | americano {mode:"americano",courtCount:2,rounds:7} (advanced gate) |
  | mexicano | americano {mode:"mexicano",courtCount:2,rounds:7} (advanced gate) |
  | ladder | ladder {challengeRange:3} (advanced gate) |
  Every progression in the table uses `placement:"rank_order", timing:"setup"`.
- **WARNING, read-level only (not run).** `buildTemplateStages` overwrites `config.legs = knobs.legs` for every league stage (format-templates.ts:337). The builder shows the legs picker only for league, league_ko, groups_ko and group_stepladder (division-builder.tsx:816-819), so `triple_rr` created through the builder gets `legs = 1`, not 3. A harness that calls `buildTemplateStages("triple_rr", {legs:1,…})` reproduces this. Pass `legs:3`, or post the raw `{legs:3}`, if you want a true triple round robin. This is a product-defect candidate; confirm it in the UI first.
- API-only shapes: send them straight through CreateStage.
  - `page_playoff` needs the Pro double_elim gate.
  - Third-place match: set `config.thirdPlace:true` on a knockout stage.
  - `bracketReset` for double_elim.
  - `pairing` on swiss.
- createStages refusals:
  - 400 `RULES_NOT_ACCEPTED_HERE`.
  - **422 `STAGE_SWISS_ROUNDS_REQUIRED`** when a swiss stage has no integer `rounds>=1` (stages.ts:345-357; lib/swiss-shell.ts:15). The swiss_playoff and swiss_knockout templates only get `rounds` from the knob stamp, so a raw copy must add it.
  - 409 "stage seq N already exists" (stages.ts:454).
  - 402 on the gates listed in section 0.
  - Stage cap `stages.per_division.max`.
  - 422 `CONFIG_INVALID` from a bad points rule.
  - Feed-graph validation (stages.ts:383-395).
  - `createStages` re-activates a `completed` division (stages.ts:471-473).
- replaceStages refusal: **409 `FORMAT_LOCKED` "Format is locked — fixtures exist"** as soon as any stage in the division owns a fixture (stages.ts:510-517). It deletes and recreates the stages and carries each stage's `rules` across by `seq:kind`.
- `DELETE /api/v1/stages/:id` (ks:245) deletes only the last stage: 409 on a middle stage or one with played fixtures, 422 `SCHEDULE_LOCKED` (stages.ts:573-616).
- `POST /api/v1/format-preview` takes `{count:2..64=8, stages:[{kind,name,config,progression}] (1..4)}` and returns `{phases}` (`app/api/v1/format-preview/route.ts:6-33`). It writes nothing, so you can use it for a dry-run of a template.

### A5. Per-stage match rules — `PUT /api/v1/stages/:id/rules`
- Route `stages/[id]/rules/route.ts:18-23`. Scope `manage` (ks:260). There is no GET on this route; read the rules from the stage's `config.rules` via `GET /divisions/:id/stages`.
```ts
// schemas.ts:1133-1135   whole-fragment replace; rules:null clears to division format
export const PutStageRules = z.object({ rules: z.record(z.string(), z.unknown()).nullable() });
```
- Refusals (server/usecases/stage-rules.ts:118-260):
  - **400 `SPORT_NOT_SUPPORTED`** unless the sport is one of `tennis`, `badminton`, `tabletennis`, `volleyball` (lib/match-rules.ts:956-961).
  - **409 `STAGE_FORMAT_LOCKED`** once the stage has started.
  - 400 `UNKNOWN_RULE_KEY` for a key outside the sport's `configKeysFor` list.
  - 422 `CONFIG_INVALID` when the merged config does not parse.
  - `POINTS_MAP_INCOMPLETE`.

---

## B. Entrants

### B1. Add — `POST /api/v1/divisions/:id/entrants` (single object OR array 1..500)
- Route `divisions/[id]/entrants/route.ts:25-47`. The body can also be multipart `file` for a CSV import. Scope `manage` (ks:131). Returns **201** with one entrant or an array.
```ts
// schemas.ts:576-604
export const CreateEntrant = z.object({
    kind: EntrantKind,                                   // REQUIRED: "team"|"individual"|"pair"
    display_name: z.string().min(1).max(ENTRANT_NAME_MAX).optional(),   // required unless team_id
    team_id: Uuid.nullish(),
    seed: z.number().int().min(1).nullish(),
    members: z.array(CreateEntrantMemberInput).max(40).default([]),
    copy_roster_from_entrant_id: Uuid.nullish(),
    badge_url: z.string().min(1).max(1000).nullish(),
    eligibility_override: EligibilityOverride.optional(),  // { reason: string }
  }).refine((e) => e.display_name != null || e.team_id != null, …);
export const CreateEntrants = z.union([CreateEntrant, z.array(CreateEntrant).min(1).max(500)]);
// CreateEntrantMemberInput (schemas.ts:542-573) = EntrantMemberInput | NewPersonMemberInput
//   EntrantMemberInput   { person_id: Uuid, squad_number?: int>=0|null, default_position_key?: string|null,
//                          is_captain: boolean=false, roles: string[]=[] }
//   NewPersonMemberInput { new_person: { full_name: 1..200, dob?: iso date|null, gender?: "m"|"f"|"x"|null,
//                          lane?: "player"|"coach"|"staff" }, squad_number?, default_position_key?, is_captain, roles }
```
- A pair takes `kind:"pair"` and up to 2 members. A team takes `kind:"team"`, capped by the model's `maxMembers`. An individual takes 1 member (entrant-model.ts:47-55).
- **Americano/mexicano needs ≥4 `individual` entrants, each with a linked person** (`members:[{person_id}]`), or generate refuses with 422 `STAGE_NOT_READY` (stages.ts:752). See `e2e/formats.spec.ts:444-454`: it first creates each person with `POST /api/v1/persons {full_name, consent:{}}`.
- Refusals (server/usecases/entrants.ts):
  - **Late entry after start:** when the division status is `active` or `completed`, the add is refused with **422** "This tournament has started — the entrant list is locked…". The exception is a division with a `ladder` or `americano` stage, which accepts late entries (entrants.ts:302-315).
  - 422 `ENTRANT_KIND_NOT_ALLOWED`.
  - 422 `ENTRANT_ROSTER_TOO_BIG`.
  - 422 `ENTRANT_ROSTER_DUPLICATE_MEMBER`.
  - 409 "this team is already entered in this division".
  - The cap `entrants.per_division.max`.

### B2. Rename / seed / status — `PATCH /api/v1/entrants/:id`
- Route `entrants/[id]/route.ts:17-24`. Scope `manage` (ks:177). Returns the entrant with its members.
```ts
// schemas.ts:630-643  (.partial(), empty refused)
display_name: z.string().min(1).max(ENTRANT_NAME_MAX), seed: int>=1|null,
status: EntrantStatus,   // "registered"|"confirmed"|"withdrawn"|"disqualified"
members: z.array(EntrantMemberInput),   // full replacement
badge_url: string|null, eligibility_override: { reason }
```
- **Disqualify is PATCH `{status:"disqualified"}`.** It is a bare column update with **no fixture cascade**: it does not walk anything over (entrants.ts:704-739). All it does is mark seed proposals stale when departed status flips (entrants.ts:812-818). **No dedicated disqualify endpoint exists.**

### B3. Delete — `DELETE /api/v1/entrants/:id`
- Route `entrants/[id]/route.ts:28-35`. Scope `manage` (ks:178). Returns **204**.
- Allowed only while the division status is `setup`. Otherwise it returns **409 `ENTRANT_DIVISION_STARTED`** with `extra:{withdraw:true}` (entrants.ts:482-506). Before deleting it unseats any swiss rounds that seat the entrant.

### B4. Withdraw (cascade) — `POST /api/v1/entrants/:id/withdraw` (no body)
- Route `entrants/[id]/withdraw/route.ts:10-16`. Scope `manage` (ks:179). Returns `WithdrawCascadeOut` `{entrant_id, status:"withdrawn", policy:"none"|"walkover"|"expunge", walkovers, voided, skipped_finalized}` (server/usecases/withdrawal.ts:44-54).
- **There is no mode parameter; the engine picks the policy** (withdrawal.ts:1-17, 130-200):
  - Before start (setup or scheduled), it is a plain status flip with `policy:"none"`.
  - league and group stages: with **< 50% played** it EXPUNGEs (`core.void` on every effective event, then `core.abandon`); otherwise it walks over the remaining games (`core.forfeit {by: entrantId, reason}`).
  - swiss **never expunges**: every paired board walks over.
  - knockout, double_elim and stepladder: the opponent advances by walkover.
  - ladder and americano: the remaining games are voided (`core.abandon`), and earned standings stand.
  - Finalized fixtures are counted in `skipped_finalized` and left untouched.
- Refusal: 409 "entrant is already withdrawn".

---

## C. Lifecycle / generation / progression

### C1. Start — `POST /api/v1/divisions/:id/start` (body optional)
- Route `divisions/[id]/start/route.ts:28-35`. It authenticates first, then parses. Key scope **`score`** (ks:160).
```ts
// schemas.ts:2703-2714
export const StartDivisionRequest = z.object({ acknowledge_warnings: z.boolean().optional(), reason: z.string().max(500).optional() });
export const StartDivisionResult  = z.object({ division_id: Uuid, status: DivisionStatus, started: z.boolean(), generated: z.number().int() });
```
- Behaviour (server/usecases/schedule.ts:3838-3920):
  - It **generates the first stage only**, and only if that stage has no fixtures yet.
  - It publishes the schedule: blocking conflicts give **422 `SCHEDULE_BLOCKING_CONFLICTS`**, and warnings give **422 `SCHEDULE_UNACKNOWLEDGED_WARNINGS`** until you send `acknowledge_warnings:true` (route comment 9-14). **The harness should always send `{acknowledge_warnings:true}`.**
  - It sets `status='active'` and promotes a `published` competition to `live`.
  - Starting a division that is already active is a no-op that returns `{started:false}`.
- Other refusals: 422 "division is completed", 422 "division has no stages to start", 422 `SCHEDULE_LOCKED`.

### C2. Generate stage fixtures — `POST /api/v1/stages/:id/generate`
- Route `stages/[id]/generate/route.ts:11-25`. The body is optional. Scope `manage` (ks:252).
```ts
// schemas.ts:1627 ; result schemas.ts:1611-1623
export const GenerateStageInput = z.object({ pairing: z.enum(["fold", "rank_adjacent"]).optional() }).strict();
GenerateResult = { created: int, existing: int, fixtures: Fixture[], reshaped?: {matches_added, matches_removed, byes_added, byes_removed} }
```
- It is **idempotent and additive**, keyed on `fixtures.ext_key`. Every call returns the stage's **full current fixture list**. The e2e loop re-calls it to read the next bracket round (e2e/formats.spec.ts:166-181).
- Per-kind behaviour (stages.ts:2200-2440):
  - A later stage whose progression has `timing:"setup"` generates **TBD placeholder fixtures** straight away, with no wait on the source stage. The e2e generates the later stage BEFORE start (formats.spec.ts:122-129, 315-317). **Start does not do this for you.**
  - `timing:"on_complete"`: if the previous stage is incomplete it gives 422 `STAGE_NOT_READY`, otherwise it seeds and then generates.
  - swiss: start generates **all rounds as empty shells** (formats.spec.ts:317-319: 3 rounds × 2 boards). **"Pair next round" is this same `POST /stages/:id/generate`** (stages-panel.tsx:595-604). It returns 422 `STAGE_NOT_READY` "current swiss round has undecided fixtures" (stages.ts:1096). `pairing` is only accepted on round 1: 422 `SWISS_PAIRING_ROUND_ONE_ONLY`, and 422 `SWISS_PAIRING_NOT_SWISS` on a non-swiss stage.
  - americano: all rounds are generated at once. mexicano: the next round is generated only when every prior fixture is decided (americanoGen, stages.ts:~740-790). **There is no separate "next round" endpoint; call generate again.**
  - ladder: generates nothing (`gen = []`). Fixtures come only from challenges.
- Other refusals:
  - 422 `STAGE_NOT_READY` "need at least 2 active entrants".
  - 422 group/league with nothing generated (`group_too_few_entrants`).
  - 422 `SCHEDULE_LOCKED`.
  - 422 "the qualifiers for this stage have left the field".

### C3. Swiss unpair — `POST /api/v1/stages/:id/unpair` (no body)
- Route `stages/[id]/unpair/route.ts:8-12`. Scope `manage` (ks:253). Returns `UnpairResult {cleared:int, round:int}` (schemas.ts:1637-1640).
- Refusals (stages.ts:2105-2170):
  - 422 "unpair only exists on swiss stages".
  - 422 `SCHEDULE_LOCKED`.
  - 422 `STAGE_NOT_READY` "no seated swiss round to unpair".
  - 422 `STAGE_NOT_READY` "…has played results / recorded match data — unpair refused".
- Division-level undo/redo is `POST /api/v1/divisions/:id/undo` (and `/redo`) with body `{expected_seq?: int}` (server/usecases/history.ts:592; route `divisions/[id]/undo/route.ts:8-13`). Scope `manage` (ks:173).

### C4. Rebuild — `POST /api/v1/stages/:id/rebuild` (no body)
- Route `stages/[id]/rebuild/route.ts:12-16`. Scope `manage` (ks:255). Returns `RebuildResult` = GenerateResult + `removed:int` (schemas.ts:1632-1635).
- Works on a **root stage only**; otherwise 422 `STAGE_NOT_ROOT`. Refused outright with `STAGE_HAS_RESULTS` if any fixture carries a result, and with 422 `SCHEDULE_LOCKED` (stages.ts:2964-3100).

### C5. Ad-hoc match — `POST /api/v1/stages/:id/fixtures`
- Route `stages/[id]/fixtures/route.ts:11-16`. Scope `manage` (ks:251). Returns **201 Fixture**.
```ts
// schemas.ts:1142-1151
export const AddFixture = z.object({
    home_entrant_id: Uuid, away_entrant_id: Uuid,
    round_no: z.number().int().min(1).optional(),
    scheduled_at: z.string().datetime({ offset: true }).nullish(),
    venue_id: VenueId.nullish(), court_id: CourtId.nullish(),
  }).strict();
```
- Allowed on league, group and swiss stages only (`ADHOC_STAGE_KINDS`, stages.ts:5673). Refusals (stages.ts:5674-5755):
  - 422 on ladder ("use challenges").
  - 422 on americano ("generate another round").
  - 422 on a bracket ("no slot in the tree").
  - 422 "this stage is complete".
  - 422 on self-play.
  - 422 on a foreign entrant.
  - 422 on a different pool.
  - 404 on an unknown court or venue.
  - 422 `SCHEDULE_LOCKED`.

### C6. Complete stage — `POST /api/v1/stages/:id/complete` (no body)
- Route `stages/[id]/complete/route.ts:14-18`. Scope `manage` (ks:248). Returns `CompleteResult` `{completed, events[], qualified?}` (schemas.ts:1642-1646) extended with `next_stage_fixtures?`, `division_completed?` and `seed_proposal?: {id,status}` (stages.ts:4105-4121).
- **Not ready is NOT an error:** it returns `{completed:false}` with 200 (stages.ts:4153-4154).
- On completion:
  - A next stage with `timing:"setup"` gets a DRAFT seed proposal (`seed_proposal.status:"draft"`). It is never auto-filled.
  - A next stage with `on_complete` is auto-seeded and generated.
  - The last stage marks the division `completed`.
  - A failure while seeding gives **409 `STAGE_COMPLETED_SEEDING_FAILED`** (stages.ts:4245-4250).
- **Final ranks.** For a bracket or ladder, the completion writes a placement standings snapshot (`placementTable(finalRanks)`; server/engine-db/competition.ts:606-618, 653), and `events[]` carries `{type:"stage_completed", finalRanks}`. After completion, read them with `GET /stages/:id/standings`. There is no dedicated final-ranks endpoint.

### C7. Seed proposal — `POST /api/v1/stages/:id/seed-proposal` then `POST …/seed-proposal/confirm`
- Compute: route `stages/[id]/seed-proposal/route.ts:9-13`, no body, returns **201 `SeedProposal`** `{id, stageId, status:"draft"|"confirmed"|"stale", computed:{qualifiers:[{rank, source:{stageId,group?,rank}, entrantId, destinationSlot}], ties:[{slots,entrantIds,reason}], standingsHash}}` (schemas.ts:4668-4699). Scope `manage` (ks:264).
- Confirm: route `…/confirm/route.ts:10-15`. Scope `manage` (ks:265). Returns `{proposalId, filled:int, fixtures: Fixture[]}` (schemas.ts:4708-4712).
```ts
// schemas.ts:4701-4705
export const ConfirmSeedProposal = z.object({
  proposalId: Uuid,
  edits: z.array(z.object({ destinationSlot: z.string(), entrantId: Uuid })).max(200).optional(),
  tiePicks: z.array(z.object({ slots: z.array(z.string()).min(1), order: z.array(Uuid).min(2) })).max(50).optional(),
});
```
- Refusals (stages.ts:4774-5170):
  - 422 `SEEDING_RULES_MISSING`.
  - 409 `SEEDING_PROPOSAL_STALE` (recompute and retry).
  - 422 `SEEDING_SLOT_DOUBLE_ASSIGNED`.
  - 422 `SEEDING_ENTRANT_FOREIGN`.
  - 422 `SEEDING_SLOT_FOREIGN_FIXTURE`.
  - 409 `SEEDING_FIXTURES_ALREADY_FILLED`.
  - 422 `SEEDING_CARRY_SOURCE_INVALID`.
  - `SEEDING_SOURCE_INCOMPLETE`.
- Worked sequence: e2e/formats.spec.ts:184-210 (ko_plate) and 357-367 (swiss_knockout). Complete the source stage, POST seed-proposal, then POST confirm with `{proposalId}`.

### C8. Rank override — `POST /api/v1/stages/:id/standings/override`
- Route `stages/[id]/standings/override/route.ts:11-16`. Scope `manage` (ks:267). Needs feature `tiebreakers.custom`.
```ts
// schemas.ts:4648-4660
export const OverrideStandings = z.object({ rows: z.array(z.object({
    entrant_id: Uuid, rank: z.number().int().min(1), reason: z.string().min(1).max(300) })).min(1).max(64) });
```
- Refusals: 422 "override references an entrant outside this division", 422 "duplicate ranks in override" (stages.ts:4644-4662).

### C9. Ladder challenge — `POST /api/v1/stages/:id/challenges`
- Route `stages/[id]/challenges/route.ts:8-17`. The body is the route's own `z.object({ challenger_id: z.string().uuid(), opponent_id: z.string().uuid() })` (also `LadderChallenge` at schemas.ts:4717). Scope `manage` (ks:247). Needs `formats.advanced`.
- Returns **201 `{fixture_id, ladder_order: string[]}`** (stages.ts:5503-5670).
- Refusals:
  - 422 "challenges only exist on ladder stages".
  - 422 `LADDER_ENTRANT_WITHDRAWN`.
  - 422 `LADDER_ENTRANT_FOREIGN`.
  - 422 `LADDER_CHALLENGE_NOT_UPWARD`.
  - 422 `LADDER_CHALLENGE_OUT_OF_RANGE` (extra `range`, default from `challengeRange`).
  - 422 `SCHEDULE_LOCKED`.
- `GET /api/v1/stages/:id/americano` (ks:246) returns the americano rotation view (`americanoView`).

---

## D. Fixture events

### D1. Append — `POST /api/v1/fixtures/:id/events`
- Route `fixtures/[id]/events/route.ts:11-16`. `requireFixtureActor(…,"score")`. Key scope **`score`** (ks:188). Returns **201**.
```ts
// schemas.ts:1420-1426
export const AppendEventRequest = z.object({
  expected_seq: z.number().int().min(0),       // = current last_seq (GET /fixtures/:id/state → last_seq)
  type: z.string().min(1).max(100),            // 'cricket.ball', 'core.void', …
  payload: z.unknown(),
  idempotency_key: z.string().min(1).max(200).optional(),
});
// 201 body — schemas.ts:1503-1509
AppendEventResponse = { seq: int, state_summary: unknown, outcome: unknown|null, status: string, event_id: Uuid }
```
- `expected_seq` must equal the fixture's current `last_seq`. After a success the new `last_seq` equals the response's `seq`. The pattern in `withdrawal.ts:83-120` and the e2e (formats.spec.ts:158-164) is to read the state, then post with `expected_seq: state.last_seq`. A mismatch gives **409 `SEQ_CONFLICT`** with `error.current_seq`. With an `idempotency_key`, a retry replays the first answer (scoring.ts:137-205).
- Refusals:
  - 422 `WRONG_PHASE` while the division is not started.
  - 422 `INVALID_EVENT`, `ALREADY_DECIDED` or `DRAW_NOT_ALLOWED` from the engine.
  - 403 when a finalized fixture is voided by a scorer or device link.
  - 402 `cricket.dls` for DLS events.
  - A per-fixture rate limit (`scorev1:`).
- Status values: `scheduled | in_play | decided | finalized | abandoned | forfeited | cancelled` (Fixture schema, schemas.ts:1299).

### D2. Core event types, as the server itself posts them (server/usecases/withdrawal.ts:66-126)
- **Void / undo:** `{type:"core.void", payload:{event_id:<score_events.id>}}`. The server checks the target first (scoring.ts:395-432):
  - 409 `UNDO_NOOP` when the payload is not a UUID.
  - 409 `UNDO_TARGET_MISSING`.
  - 409 `UNDO_ALREADY_VOIDED`.
  - 409 `UNDO_NOT_UNDOABLE` when the target is itself a void.
  - Event ids come from `GET /fixtures/:id/events?since_seq=0`, which returns a `ScoreEvent[]` of `{id, seq, type, payload, recorded_at, recorded_by, voids_event_id, device_link_id}` (schemas.ts:1491-1500).
- **Walkover / forfeit:** `{type:"core.forfeit", payload:{by:<entrantId who forfeits>, reason}}`. This is the path withdrawal uses. PointsRule treats `outcome.kind==="award"` and `win` with method `walkover`/`forfeit` as a forfeit (points.ts:56-58). `core.award` also exists: withdrawal's void sweep skips it (withdrawal.ts:73).
- **Abandon:** `{type:"core.abandon", payload:{reason}}`.
- **Start:** `{type:"core.start", payload:{}}`. It is optional for generic: the e2e posts `generic.result` directly on a scheduled fixture, while americano-panel.tsx:148-163 posts `core.start` first when the status is `scheduled`.
- **Finalize:** `{type:"core.finalize", payload:{}}`, or the wrapper route `POST /api/v1/fixtures/:id/finalize` with body `{expected_seq:int>=0}` (route `fixtures/[id]/finalize/route.ts:8-16`, which calls `scoreEvent(…core.finalize…)`, scoring.ts:842-852). Key scope **`manage`** (ks:189). A scorer needs the division's `scorer_can_finalize`, and a device link can never finalize (403).
- Retire, no-result and the per-sport terminal events are sport-specific. See section F and `plan-facts-sports.md`.

### D3. Bulk import — `POST /api/v1/divisions/:id/events/import`
Key scope `score` (ks:171). This may be useful to the harness for speed.
```ts
// schemas.ts:1437-1458
EventImportRequest = { import_id: string 1..200,
  streams: [{ fixture: {id: uuid} | {ext_key: string}, events: [{ type (≠"core.void"), payload: record = {}, at?: iso datetime }] (min 1) }] (min 1) }
// report schemas.ts:1460-1475: { importId, totals:{imported,skipped,rejected}, results:[{fixture, status:"imported"|"skipped_duplicate"|"rejected", eventsAppended, outcome?, error?:{code}}] }
```
Gated by feature `import.events`.

### D4. Fixture PATCH — `PATCH /api/v1/fixtures/:id` (scope `manage`, ks:184)
`PatchFixture` (schemas.ts:1229-1239): `{scheduled_at, venue_id, court_id, officials[], schedule_locked, expected_seq}`, all partial, strict.

### D5. Stage rule override
See A5 (`PUT /stages/:id/rules`).

---

## E. Reads

| read | route (method path) | file | key scope | shape |
|---|---|---|---|---|
| division | GET /divisions/:id | divisions/[id]/route.ts:8-14 | read ks:119 | `Division` schemas.ts:479-504 (has `status`, `auto_progress`, `tiebreakers`, `config`) |
| division list | GET /competitions/:id/divisions[?archived=1] | competitions/[id]/divisions/route.ts:8-17 | read | Division[] |
| stages | GET /divisions/:id/stages | divisions/[id]/stages/route.ts:8-14 | read ks:157 | `Stage` {id, division_id, seq, kind, name, config, progression, status: pending/active/complete} schemas.ts:1163-1172 |
| fixtures (all stages) | GET /divisions/:id/fixtures | divisions/[id]/fixtures/route.ts:22-37 | read ks:129 | Fixture[] (schemas.ts:1279-1306) minus venue/court_label/winner_to_*/loser_to_*; **filter by `stage_id`**, since there is **no GET /stages/:id/fixtures** (that path is POST only). `generate`'s response also lists a stage's fixtures |
| fixture | GET /fixtures/:id | fixtures/[id]/route.ts:8-13 | read ks:183 | fixture row |
| fixture state | GET /fixtures/:id/state (ETag / If-None-Match → 304) | fixtures/[id]/state/route.ts:9-21 | read ks:193 | `FixtureState {fixture_id, status, last_seq, summary, state, outcome}` schemas.ts:1515-1522 |
| events | GET /fixtures/:id/events?since_seq=N | fixtures/[id]/events/route.ts:21-28 | read ks:186 | ScoreEvent[] |
| entrants | GET /divisions/:id/entrants[?club_id&team_id] | divisions/[id]/entrants/route.ts:11-20 | read ks:130 | Entrant[] |
| standings | GET /stages/:id/standings[?pool_id=<uuid>] | stages/[id]/standings/route.ts:7-12 | read ks:266 | `{stage_id, pool_id, rows[], computed_through_seq, updated_at}` (stages.ts:4617-4643); it recomputes when there is no snapshot. Rows ≈ `StandingsRowOut {entrantId, rank, played?, points?}` (schemas.ts:1524-1529, loose). Per pool: pass `pool_id` (from `Fixture.pool_id`). Without it you get the `pool_id is null` snapshot |
| final ranks | same standings GET after `complete` | engine-db/competition.ts:606-618 | — | placement rows; also `CompleteResult.events[].finalRanks` |
| public standings | GET /api/v1/public/orgs/:orgSlug/competitions/:slug/divisions/:divisionSlug/standings | public/…/standings/route.ts:6-13 | none (public rate limit) | `{division_id, standings:[{stage_id, pool_id, rows, updated_at}]}` (usecases/public.ts:455-466) |
| public schedule / entrants / stats / hub | …/divisions/:divisionSlug/{schedule,entrants,stats}, …/competitions/:slug/hub | public routes | none | schedule = `{division_id, fixtures[]}` (public.ts:~410-452) |
| competition desk | GET /competitions/:id/desk | — | read | in-play band |

- Public reads go through `public_divisions_v ⋈ public_competitions_v`, filtered by **competition `visibility in ('public','unlisted')`** (db/migration/v2-engine/views/V230, V231; usecases/public.ts:468-481). Otherwise they return 404 "division not found". They are cached with `Cache-Control: public, s-maxage=30, stale-while-revalidate=300` (public.ts:68) plus the server `cached()` key, which scoring writes invalidate.
- **Embed:** `app/embed/divisions/[id]/[widget]/page.tsx` is an HTML page only. **There is no JSON embed standings endpoint.**
- OpenAPI: `GET /api/v1/openapi.json` (route present), generated from `server/api-v1/openapi.ts`.

---

## Worked end-to-end call sequences taken from existing specs (copy these)
- **ko_plate** (e2e/formats.spec.ts:55-210):
  1. Create the competition.
  2. Create the division (the builder posts the stages).
  3. Add entrants.
  4. `POST /stages/{plate}/generate`, which returns 3 TBD fixtures.
  5. `POST /stages/{main}/generate`.
  6. `POST /divisions/{d}/start`.
  7. Loop: `generate(main)`, then decide every seated fixture with `generic.result {p1Score,p2Score}` at `expected_seq=last_seq`.
  8. `POST /stages/{main}/complete`, which returns `seed_proposal.status:"draft"`.
  9. `POST /stages/{plate}/seed-proposal`.
  10. `POST …/confirm {proposalId}`, which returns `filled:4`.
- **swiss_knockout** (formats.spec.ts:236-367): generate the KO placeholders, start (all swiss shells), then per round: pair (the UI button, which is `POST /stages/{swiss}/generate`) and decide. Then complete swiss, seed-proposal, confirm.
- **ladder** (formats.spec.ts:389-427): create the stage `{seq:1,kind:"ladder",config:{challengeRange:2}}`, then challenge.
- **americano** (formats.spec.ts:429-482): create persons, add entrants with members, create the stage, generate, start, then score with `core.start` + `generic.result`.
- Note, read-level only: `americano-panel.tsx:160` always posts **`generic.result`** whatever the division's sport, and no sport gate on americano turned up in a grep. An americano division on a non-generic sport probably cannot be scored from that panel. Not run.

---

## F. Per-sport finalize sequences — full detail in `plan-facts-sports.md` (same dir, 393 lines, verbatim payloads + file:line)
Summary of that pass:
| sport | winner | draw | walkover |
|---|---|---|---|
| football | yes | yes (default) | yes |
| cricket | yes | `tie` (1-innings); `draw` only with `inningsPerSide:2` | yes |
| boardgame | yes | yes (`winner:null`) | yes (needs `core.start` first) |
| carrom | yes | only cfg `tieBoard:"draw"` | yes |
| generic | yes | only `allowDraws:true` | yes |
| volleyball / badminton / tabletennis | yes | never (odd best-of) | yes |
| tennis | yes | never | yes |
| icehockey | yes | not default; `recreational` variant (read-only, untested) | yes |
| hockey | yes | yes (default) | yes |
- Walkover AND retirement are universal: `core.forfeit {by:<forfeiting entrantId>, reason}`; abandon is per-sport (table in sports file); status → `abandoned`.
- Finalize is automatic on the deciding event (status `decided`); `core.finalize` / `POST /fixtures/:id/finalize` only locks.
- Sides in payloads are ENTRANT UUIDs, not "home"/"away". No quick-result endpoint; quick entry = each sport's summary event (football/icehockey/hockey have none → goals + period markers).
- Do NOT copy carrom from `scripts/seed-demo.ts` (no carrom case; wrong event type). Draw-in-knockout app behaviour unverified.
