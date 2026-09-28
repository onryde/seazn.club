# Format x Sport: what an organiser is offered today (main @ 782628af5)

Repo root: /Users/ashokhein/github/seazn.club

Key: UI = offered in the division builder (and in division settings too, same unfiltered list) ·
TPL = only through a catalog template (sport is fixed by the template) · API = only through `POST/PUT /api/v1/divisions/{id}/stages` ·
✗ = refused (none found) · ? = no refusal found, but the engine looks unfit (letter = reason below; "?(UI)" means the builder offers it anyway)

Sports (11, packages/engine/src/sports/index.ts:23-35): fb=football, cr=cricket, bg=boardgame, ca=carrom, ge=generic, vb=volleyball, bd=badminton, tt=tabletennis, tn=tennis, ih=icehockey, hk=hockey

| format (template key -> stage kinds) | fb | cr | bg | ca | ge | vb | bd | tt | tn | ih | hk |
|---|---|---|---|---|---|---|---|---|---|---|---|
| league (league) | UI | UI | UI | UI | UI | UI | UI | UI | UI | UI | UI |
| triple_rr (league legs:3) | UI | UI | UI | UI | UI | UI | UI | UI | UI | UI | UI |
| league_ko (league -> knockout) | UI | UI | ?(UI)b | UI | UI | UI | UI | UI | UI | UI | UI |
| groups_ko (group -> knockout) | UI | UI | ?(UI)b | UI | UI | UI | UI | UI | UI | UI | UI |
| group_stepladder (league -> stepladder) | UI | UI | ?(UI)b | UI | UI | UI | UI | UI | UI | UI | UI |
| group_playoffs (league -> page_playoff) | UI | UI | ?(UI)b | UI | ?(UI)c | UI | UI | UI | UI | UI | UI |
| swiss (swiss) | UI | UI | UI | UI | UI | UI | UI | UI | UI | UI | UI |
| swiss_playoff (swiss -> page_playoff) | UI | UI | ?(UI)b | UI | ?(UI)c | UI | UI | UI | UI | UI | UI |
| swiss_knockout (swiss -> knockout) | UI | UI | ?(UI)b | UI | UI | UI | UI | UI | UI | UI | UI |
| knockout (knockout) | UI | UI | ?(UI)b | UI | UI | UI | UI | UI | UI | UI | UI |
| ko_plate (knockout -> knockout, roundLosers) | UI | UI | ?(UI)b | UI | UI | UI | UI | UI | UI | UI | UI |
| qualifying_main (knockout -> knockout) | UI | UI | ?(UI)b | UI | UI | UI | UI | UI | UI | UI | UI |
| double_elim (double_elim) | UI | UI | ?(UI)b | UI | UI | UI | UI | UI | UI | UI | UI |
| americano (americano, mode americano) | ?(UI)a | ?(UI)a | ?(UI)a | ?(UI)a | UI | ?(UI)a | ?(UI)a | ?(UI)a | ?(UI)a | ?(UI)a | ?(UI)a |
| mexicano (americano, mode mexicano) | ?(UI)a | ?(UI)a | ?(UI)a | ?(UI)a | UI | ?(UI)a | ?(UI)a | ?(UI)a | ?(UI)a | ?(UI)a | ?(UI)a |
| ladder (ladder) | UI | UI | UI | UI | UI | UI | UI | UI | UI | UI | UI |
| group only, no KO (group) | API | API | API | API | API | API | TPL | API | API | API | API |
| group -> group -> knockout | API | TPL | ?b | API | API | API | API | API | API | API | API |
| knockout + 3rd-place match (config.thirdPlace) | API | API | ?b | API | API | API | API | API | API | API | API |
| standalone page_playoff | API | API | ?b | API | ?c | API | API | API | API | API | API |
| standalone stepladder | API | API | ?b | API | API | API | API | API | API | API | API |

Counts (231 cells = 21 rows x 11): UI 144 · TPL 2 · API 48 · ✗ 0 · ? 37 (32 of these the builder offers anyway, 5 are API-only).

Notes on the cells
- Catalog templates that match a builder row are not re-marked TPL, because the builder already offers that combination: euro24/wc32 football group->knockout, league-playoff cricket league->page_playoff, slam128 tennis knockout, swiss11 boardgame swiss, americano-night tennis americano (a "?a" cell, so this template ships a combination that is unfit).
- "group only": there is also a UI workaround. Build groups_ko, then delete the KO stage (stages-panel.tsx:593 DELETE /stages/{id}).
- ?a: generic works only with the `score` variant. The `win_loss` variant refuses the panel's scores-only payload (generic.ts:140-141).

## Reasons for "?"
a. americano/mexicano on any sport except generic. The console writes `generic.result` (apps/web/src/components/v2/americano-panel.tsx:162), and every other kernel rejects that type as an unknown event (nested/kernel.ts:2125, setbased/kernel.ts:2374, football.ts:2152, period/kernel.ts:2430, cricket.ts:3794, boardgame.ts:644, carrom.ts:868). Personal points and the mexicano re-pairing read `match_states.state->'score'` (apps/web/src/server/usecases/americano.ts:52,87; stages.ts:775). Only GenericState carries a top-level `score` (packages/engine/src/sports/generic/generic.ts:81); the other kernels hold no such field. The pairs are built from persons (stages.ts:741-755), while fb/cr/ih/hk declare a team-only entrant model.
b. boardgame on any bracket kind (knockout, double_elim, stepladder, page_playoff). `supportsDraws` returns true for every stage kind (packages/engine/src/sports/boardgame/boardgame.ts:770), so the DRAW_NOT_ALLOWED guard never fires. `bracketWinnerLoser` resolves a draw to neither side, on the stated assumption that draws never reach a bracket (apps/web/src/server/engine-db/competition.ts:148-152). The "multi-game mini-matches, modelled at the fixture layer" (boardgame.ts:768-769) exist only in that comment: a grep for mini-match/miniMatch/mini_match finds nothing else.
c. generic on page_playoff. `supportsDraws` excludes only knockout, double_elim and stepladder (generic.ts:650-652). The `score` variant ships `allowDraws: true`, so a drawn page-playoff fixture can finalize and then advance nobody (same competition.ts:148 assumption).

## Restriction sites, door by door
1. Division builder: no sport restriction.
   - apps/web/src/components/v2/format-templates.ts:65: STAGE_TEMPLATES has 16 entries and no sport field.
   - apps/web/src/components/v2/division-builder.tsx:772: `STAGE_TEMPLATES.map` renders every template for every sport, with no `sportKey` conditional anywhere in the file.
   - apps/web/src/app/o/[orgSlug]/c/[compSlug]/d/new/page.tsx:50: `select key, name from sports` returns all 11 sports, unfiltered.
   - apps/web/src/components/v2/division-settings.tsx:822: the same unfiltered list when the format is changed later.
   - apps/web/src/components/v2/format-recommend-strip.tsx: takes no sport input.
2. Templates: the sport is fixed per template.
   - apps/web/src/server/templates/catalog/*.json holds 8 templates: americano-night=tennis, box-league=badminton, euro24=football, wc32=football, league-playoff=cricket, t20-super8=cricket, slam128=tennis, swiss11=boardgame.
   - apps/web/src/server/templates/schema.ts:129: `sportKey` is required per template division.
   - apps/web/src/server/api-v1/schemas.ts:1181: CreateFromTemplate has no sport override.
   - apps/web/src/server/usecases/templates.ts:239-255: the template's own sport is validated, not a sport x kind pairing.
3. Server/API: no sport x kind refusal.
   - apps/web/src/server/api-v1/schemas.ts:79: StageKind is 9 kinds; the stage schema (schemas.ts:1063) has no sport.
   - apps/web/src/server/usecases/stages.ts:360 createStages and :488 replaceStages have gates by plan only: formats.double_elim at :373, formats.advanced at :381, custom points / h2h / carry at :399-413. The only sport-aware check is the points-metric check at :437-440.
   - db/migration/deltas/V298__page_playoff_stage_kind.sql:14: the kind CHECK constraint, sport-agnostic.
   - Kind-only checks, not sport: ladder challenge at stages.ts:5521, ad-hoc fixtures at stages.ts:5672, americano needing 4+ linked persons at stages.ts:752.
   - Sport gate that is NOT about the format: per-stage match rules are limited to STAGE_RULES_SPORTS (apps/web/src/server/usecases/stage-rules.ts:154).
4. Engine: `supportsDraws(cfg, stageKind)` is the only kind-aware sport capability.
   - Declared at packages/engine/src/sport/module.ts:830 and enforced at apps/web/src/server/engine-db/append-event.ts:335-345 (DRAW_NOT_ALLOWED).
   - Per sport:
     - football.ts:2666: league/group/swiss only.
     - period/kernel.ts:2644 (ih/hk): league-ish, and only with no OT or shootout.
     - cricket.ts:3964: 2-innings format, league-ish only.
     - carrom.ts:983: tieBoard=draw, league-ish only.
     - setbased/kernel.ts:2469 and nested/kernel.ts:2223: never.
     - generic.ts:650: any kind except the 3 listed in reason c.
     - boardgame.ts:770: always.
   - It gates draws, not whether a kind is offered. There is no swiss pairing metadata per sport: swiss pairing hard-codes win=1 and draw/tie=0.5 plus W/B colours for every sport (stages.ts:1136-1150).

## Premise corrections
- StageKind is 9 kinds (packages/engine/src/core/types.ts:91-101): league, group, swiss, knockout, double_elim, stepladder, americano, ladder, page_playoff.
- mexicano is kind `americano` with `config.mode` (format-templates.ts:259-261). plate and qualifying_main are two-knockout templates.
- The 3rd-place match is `config.thirdPlace` (schemas.ts:1010, read at stages.ts:1652). No UI control or catalog template sets it.
- The boardgame variants are time controls (classical, rapid, blitz). There are no chess/draughts/go presets.
- Other sports' variants: fb 11-a-side/youth/small-sided/mini-soccer · cr t20/odi/hundred/test · ca icf/club-29 · ge win_loss/score · vb indoor/beach · bd bwf/short · tt bo5/bo7/hardbat-21 · tn tour/grand-slam/fast4/doubles-noad-mtb10 · ih iihf/recreational · hk fih-outdoor/fih-shootout/youth.
