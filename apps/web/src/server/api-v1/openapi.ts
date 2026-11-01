// OpenAPI 3.1 document for /api/v1, generated from the SAME Zod schemas the
// route handlers parse with (PROMPT-11 §6). Choice: Zod 4's native
// z.toJSONSchema over a third-party converter (@asteasolutions/zod-to-openapi)
// — zero extra dependency, JSON Schema 2020-12 output is what OpenAPI 3.1
// consumes natively, and the schemas stay plain Zod.
//
// NOT server-only: also imported by scripts/openapi-gen.ts (the CI drift gate)
// and the vitest route-coverage test.
import { z, type ZodType } from "zod";
import * as S from "./schemas.ts";
import { matchKeyRoute } from "./key-scopes.ts";
// Spectator surface W2, Task 5 — imported directly rather than routed through
// schemas.ts's `S.` namespace (unlike W1's MatchCentreDoc, which schemas.ts
// re-exports as a field of PublicFixtureSummary): this is the document's own
// top-level route response, not a field nested inside another schema. Same
// relative-import, explicit-`.ts`-extension reasoning as every other import
// in this file that reaches the standalone generator script — verified
// transitively before wiring: competition-hub-schema.ts imports zod,
// ./match-centre-schema.ts (zod only) and ../../lib/matches-hub.ts (no
// imports at all), so nothing here reaches a `server-only` module.
import { CompetitionHubDoc } from "../public-site/competition-hub-schema.ts";
// Spectator W2, Task 14 — the player page's match lines. Same reasoning as the
// hub's import above: `player-matches-schema.ts` imports zod and nothing else.
import { PublicPlayerMatches } from "../public-site/player-matches-schema.ts";
// Streaming R1, A18 — the destination refusal rules, for the 422 envelope below.
// Zero imports in that file (it is client-safe), so the generator stays clean.
import {
  DESTINATION_LABEL_EMPTY, DESTINATION_NOT_ALLOWED, DESTINATION_REFUSALS, STREAM_KEY_EMPTY, TARGET_UNREADABLE, YOUTUBE_USE_DISCONNECT,
} from "../../lib/stream-destinations.ts";
// The stream-link validator's own host list (zod only, client-safe, already reached through schemas.ts): a published example
// link is built from it, so it is a link `isStreamUrl` accepts by construction.
import { STREAM_HOSTS } from "../../lib/stream-url.ts";

// ---------------------------------------------------------------------------
// Route registry — one row per (path, method). The coverage test asserts this
// table matches the route files on disk 1:1, so the served spec cannot drift
// from the implementation.
// ---------------------------------------------------------------------------

type Method = "get" | "post" | "put" | "patch" | "delete";

interface RouteSpec {
  path: string; // OpenAPI template, e.g. /competitions/{id}
  method: Method;
  summary: string;
  tag: string;
  request?: ZodType;
  requestOptional?: boolean; // body may be omitted (route treats absent as {}) → requestBody.required: false
  response?: ZodType; // the `data` member of the envelope
  status?: number; // success status (default 200)
  query?: Record<string, { schema: object; description?: string }>;
  public?: boolean; // no auth, cacheable
  errors?: number[]; // extra documented error statuses
  /** Capture QR v2 §6.3 (the phone's routes): the 2xx is the BARE `response` shape and every refusal the bare
   *  `{code, message}` of the capture-refusal contract — no `{ok, data | error, requestId}` envelope, no 400 (a bad
   *  request is 422 `invalid`) — and the Bearer is the stream code's tok, never a session or an API key. */
  bare?: boolean;
  /** A bare route's own refusal twin (capture-record.v1, Q2: the record's `too_large` stays out of the shared
   *  CaptureRefusalCode). Default: S.CaptureRefusal. */
  refusal?: ZodType;
  /** The request body's media type. Default application/json; the record upload is NDJSON, and its `request` is ONE
   *  line (the contract's root). */
  requestContentType?: string;
}

const PAGE_QUERY = {
  cursor: { schema: { type: "string" }, description: "Opaque cursor from a previous page" },
  limit: { schema: { type: "integer", minimum: 1, maximum: 200, default: 50 } },
};

/** RS005 W1b — the Registrants-tab list/export filter set (usecases/
 *  registrations.ts's `ListRegistrationsFilters`), shared by the competition
 *  list route and its CSV export twin so the two documented query surfaces
 *  cannot drift apart. `free_agent`/`consent_pending` follow this file's
 *  existing "1"/"0" boolean-query convention (e.g. `archived` above). */
const REGISTRATION_LIST_QUERY = {
  status: { schema: { type: "string", enum: S.RegistrationStatus.options } },
  division_id: { schema: { type: "string" } },
  kind: { schema: { type: "string", enum: S.EntrantKind.options } },
  free_agent: { schema: { type: "string", enum: ["1", "0"] } },
  consent_pending: { schema: { type: "string", enum: ["1", "0"] } },
  q: { schema: { type: "string" } },
  sort: { schema: { type: "string", enum: S.RegistrationSort.options } },
};

const pageOf = (item: ZodType) =>
  z.object({ items: z.array(item), nextCursor: z.string().nullable() });

export const ROUTES: RouteSpec[] = [
  // Competitions
  { path: "/competitions", method: "get", summary: "List competitions", tag: "competitions", response: pageOf(S.Competition), query: PAGE_QUERY },
  { path: "/competitions", method: "post", summary: "Create a competition. Public by default; at `dashboard.public.max` the create is NOT refused — it is created private and the 201 carries `public_quota_degraded` naming the cap", tag: "competitions", request: S.CreateCompetition, response: S.CreatedCompetition, status: 201, errors: [409] },
  { path: "/competitions/from-template", method: "post", summary: "Instantiate a curated format template (D1a) — competition + divisions + stages in one transaction", tag: "competitions", request: S.CreateFromTemplate, response: S.FromTemplateResult, status: 201, errors: [402, 404, 409, 422] },
  { path: "/competitions/{id}", method: "get", summary: "Get a competition", tag: "competitions", response: S.Competition },
  { path: "/competitions/{id}", method: "patch", summary: "Update a competition", tag: "competitions", request: S.PatchCompetition, response: S.Competition, errors: [409] },
  { path: "/competitions/{id}", method: "delete", summary: "Delete a competition (no recorded play)", tag: "competitions", response: z.object({ deleted: z.boolean() }), errors: [409] },
  { path: "/competitions/{id}/desk", method: "get", summary: "Get a competition desk summary", tag: "competitions", response: S.CompetitionDesk },
  // Divisions
  { path: "/competitions/{id}/divisions", method: "get", summary: "List divisions", tag: "divisions", response: z.array(S.Division) },
  { path: "/competitions/{id}/divisions", method: "post", summary: "Create a division (pins sport module version). With onlinePlay 'lichess', 403 ONLINE_CHESS_DISABLED unless the club is offered online chess (the PostHog flag `online-chess`), and 400 INVALID_TIME_CONTROL unless config.clock is one of the curated Board API controls (error.controls lists them); camera_policy null or absent inherits the competition's, and a non-off value on a sport that cannot play online is 422 CAMERA_POLICY_SPORT. Chess divisions take individual players only: a config.entrants override that names pair or team is 422 CHESS_INDIVIDUAL_ONLY", tag: "divisions", request: S.CreateDivision, response: S.Division, status: 201, errors: [403, 409, 422] },
  { path: "/divisions/{id}", method: "get", summary: "Get a division", tag: "divisions", response: S.Division },
  { path: "/divisions/{id}", method: "patch", summary: "Update a division. A format edit (`variant_key`, `config`, `tiebreakers`) is applied PER FIELD (W2c, owner P-2 \"A\"): a change a STARTED stage depends on is not applied and is listed in the 200's `refused` (`field`, `code`, `stageId`, `stageName`) while every other field lands; when nothing in the save can land, 409 DIVISION_FORMAT_LOCKED (the stage plays that format) or 409 DIVISION_TABLE_RULES_LOCKED (the stage's table ranks by it), the message naming the first stage and `refused` listing every field. W2d: a stage is PINNED to its table rules when it is generated — and a stage that started without being generated (an ad-hoc match played on a pending stage) is pinned by the save itself, with the rules it read, before the save lands — so `tiebreakers` and the points keys a stage rule replaces (`points`, `pointsMap`) are never refused for a pinned stage: the save lands and `stagesKeptPinned` (`stageId`, `name`) lists the pinned stages that kept their rules; `scoring` and `awardScore` keep the table lock. 422 CONFIG_INVALID when the sport's schema refuses the config (`issues`, plus `refused` when the refusal follows from fields kept as stored), or when a stage's OWN rules would no longer parse under it (`stage_id`, `stage_name`, `issues`); 422 TIEBREAK_KEY_INVALID when the validator refuses the order, for the sport or for an unstarted stage that inherits it (`refusals`, each `index`, `key`, `reason`; with `stage_id`, `stage_name`, `stage_kind` when a stage's); 422 POINTS_OUTCOME_UNCOVERED when the save would let a stage end in an outcome its points do not pay (`uncovered`, with `stage_id`, `stage_name`) — clear or widen that stage's points first. A variant change re-seeds the preset match rules its unstarted stages still store (a key equal to the old variant's preset becomes the new variant's, or goes when it declares none; a key the new preset adds is written; each stage re-seeded is audited `stage.rules_reseeded`); a key the organiser changed is kept. 400 RULE_NOT_SETTABLE when a new variant cannot carry such a key (`field`, `stage_id`, `stage_name`) — clear it on that stage first. 409 FIXTURE_OWN_FORMAT_NO_LONGER_FITS when an unstarted match's own format (`PUT /fixtures/{id}/rules`) would stop fitting (`fixture_id`, `fixture_no`, `field`). 422 ENTRANT_KIND_IN_USE when entrants of a kind the new format refuses still exist. Chess divisions take individual players only: a config.entrants override that names pair or team is 422 CHESS_INDIVIDUAL_ONLY (an override already stored on a division from before this rule can be re-sent unchanged, or dropped to reset it). Turning onlinePlay on (a stored value other than 'lichess' patched to 'lichess') is 403 ONLINE_CHESS_DISABLED unless the club is offered online chess (the PostHog flag `online-chess`); re-sending a stored 'lichess', or turning it off, is never refused for that. With onlinePlay 'lichess' in the final config, 400 INVALID_TIME_CONTROL unless config.clock is one of the curated Board API controls (error.controls lists them). camera_policy is editable at any time, but once a round of the division has been opened it can only be relaxed: a tightening of the effective policy is 409 POLICY_LOCKED. Every change of the stored camera_policy is audited", tag: "divisions", request: S.PatchDivision, response: S.PatchedDivision, errors: [400, 402, 403, 409, 422] },
  { path: "/divisions/{id}/logo-upload-url", method: "post", summary: "Signed upload URL for the division card logo (session-only; not key-accessible)", tag: "divisions" },
  { path: "/divisions/{id}", method: "delete", summary: "Delete a setup division (204) or purge a 30-day archive; started/resulted → 409 DIVISION_HAS_RESULTS {archive: true}", tag: "divisions", status: 204, errors: [409] },
  { path: "/divisions/{id}/archive", method: "post", summary: "Archive: hidden from console/public/quota, restorable", tag: "divisions", response: S.Division, errors: [409] },
  { path: "/divisions/{id}/archive", method: "delete", summary: "Restore an archived division (quota re-checked)", tag: "divisions", response: S.Division, errors: [402] },
  // Entrants
  { path: "/divisions/{id}/fixtures", method: "get", summary: "List a division's fixtures in play order (G3 — before this the only way to obtain fixtures over HTTP was the idempotent POST /stages/{id}/generate)", tag: "fixtures", response: z.array(S.Fixture) },
  { path: "/divisions/{id}/entrants", method: "get", summary: "List entrants", tag: "entrants", response: z.array(S.Entrant) },
  { path: "/divisions/{id}/entrants", method: "post", summary: "Register entrant(s) — object or bulk array. After Start a division whose Swiss is running takes a late player (W3, ruling 250): the reply's late_entry says whether the unstarted round was re-paired (a), the newcomer plays the round's bye holder (b), or joins the next round (c); with the last round started it is 409 SWISS_NO_ROUND_LEFT (details.canAddRound), and a finished Swiss is 422 SWISS_OVER. A pair or team entrant in a chess division is 422 CHESS_INDIVIDUAL_ONLY (chess takes individual players only). A multipart CSV/XLSX upload is the division-pinned import preview; its plan lists a blocking CHESS_INDIVIDUAL_ONLY issue for each row that would enter a team into a chess division", tag: "entrants", request: S.CreateEntrants, response: z.union([S.CreatedEntrant, z.array(S.CreatedEntrant)]), status: 201, errors: [409, 422] },
  { path: "/entrants/{id}", method: "get", summary: "Get an entrant with members", tag: "entrants", response: S.Entrant },
  { path: "/entrants/{id}", method: "patch", summary: "Set status, seed, name or members (no fixture surgery — see /withdraw). A members-only patch also renames an ad-hoc entrant whose name was derived from its people (e.g. 'A & B' − B + C → 'A & C'); a custom name, a team-linked entrant or an explicit display_name in the same patch is never renamed", tag: "entrants", request: S.PatchEntrant, response: S.Entrant, errors: [422] },
  { path: "/entrants/{id}", method: "delete", summary: "Delete an entrant while its division is still setup (204); started → 409 ENTRANT_DIVISION_STARTED (withdraw instead)", tag: "entrants", status: 204, errors: [409] },
  { path: "/entrants/{id}/withdraw", method: "post", summary: "Withdraw with fixture surgery (spec 05 §5): tables expunge (<50% played) or walk over remaining; brackets walk over; open formats void remaining", tag: "entrants", errors: [409, 422] },
  { path: "/entrants/{id}/roster/sync", method: "post", summary: "Replace the entrant roster with the linked team's current squad (enrollment snapshots once — this is the explicit re-sync; sport filter + kind cap apply)", tag: "entrants", request: S.SyncEntrantRoster, response: S.Entrant, errors: [404, 422] },
  { path: "/divisions/{id}/roster", method: "get", summary: "Every (person → team entrant) membership in the division (same-division double-roster warning)", tag: "entrants" },
  // Persons
  { path: "/persons", method: "get", summary: "List persons", tag: "persons", response: pageOf(S.Person), query: PAGE_QUERY },
  { path: "/persons", method: "post", summary: "Create a person", tag: "persons", request: S.CreatePerson, response: S.Person, status: 201 },
  { path: "/persons/{id}", method: "get", summary: "Get a person", tag: "persons", response: S.Person },
  { path: "/persons/{id}", method: "patch", summary: "Update a person", tag: "persons", request: S.PatchPerson, response: S.Person },
  // Duplicate review + merge (#404). Session-only — see NEVER_KEY_ROUTES — so
  // none of the three appear in the published (key-scoped) spec.
  { path: "/persons/duplicates", method: "get", summary: "Ranked duplicate-person candidates for the org, with the evidence that suggested each pair (session only)", tag: "persons", response: S.DuplicateCandidates, query: { limit: { schema: { type: "integer", minimum: 1, maximum: 200, default: 50 } } } },
  { path: "/persons/{id}/merge", method: "post", summary: "Absorb a duplicate person into this one — reversible, requires confirmed:true; returns the merge id, the survivor and any published boards the merge revealed conflicts on (session only)", tag: "persons", request: S.MergePersons, response: S.MergeResult, errors: [403, 409, 422] },
  { path: "/persons/merges", method: "get", summary: "The org's person-merge log, newest first — each row carries the names, the timestamp and `reversed_at`, which is what decides whether Undo is still offered (session only)", tag: "persons", response: S.MergeLog, query: { limit: { schema: { type: "integer", minimum: 1, maximum: 200, default: 50 } } } },
  { path: "/persons/merges/{id}/reverse", method: "post", summary: "Undo a merge from its snapshot — requires confirmed:true; 409 once already reversed (session only)", tag: "persons", request: S.ReverseMerge, response: z.object({ reversed: z.boolean() }), errors: [403, 404, 409, 422] },
  { path: "/persons/{id}/photo", method: "post", summary: "Upload a player photo (multipart `file`); public display gated by public_photo consent", tag: "persons", response: S.Person, errors: [400, 404, 415, 502] },
  { path: "/entrants/{id}/badge", method: "post", summary: "Upload an entrant crest/badge (multipart `file`) — stored in assets, badge_url set to the path; external URLs via PATCH /entrants/{id}", tag: "entrants", response: S.Entrant, errors: [400, 404, 415, 502] },
  { path: "/entrants/{id}/badge", method: "delete", summary: "Clear the entrant badge (display falls back to team logo, then monogram)", tag: "entrants", response: S.Entrant, errors: [404] },
  { path: "/persons/{id}/profiles/{sport}", method: "get", summary: "Get a per-sport profile", tag: "persons" },
  { path: "/persons/{id}/profiles/{sport}", method: "put", summary: "Upsert a per-sport profile", tag: "persons", request: S.PutProfile, errors: [422] },
  // Player accounts (PROMPT-53) — session-only, never key-accessible
  { path: "/persons/{id}/claim-invites", method: "post", summary: "Invite the person to claim their profile (session editors only; claim_url embeds the one-time secret; revokes any prior open invite)", tag: "player-accounts", request: S.CreateClaimInvite, response: S.CreatedPersonClaim, status: 201, errors: [409] },
  { path: "/persons/{id}/claim-invites", method: "get", summary: "The person's open claim invite, if any (never the secret)", tag: "player-accounts", response: S.PersonClaim.nullable() },
  { path: "/persons/{id}/claim-invites", method: "delete", summary: "Withdraw the open claim invite (idempotent)", tag: "player-accounts", response: S.PersonClaim.nullable() },
  { path: "/persons/{id}/unlink", method: "post", summary: "Staff unlink: detach the player login and revoke live claims (audited — claim rows are retained)", tag: "player-accounts" },
  { path: "/me/fixtures", method: "get", summary: "Player home read: upcoming fixtures, recent results and teams for every claimed person of the caller, across orgs (session only)", tag: "player-accounts", response: S.MyFixtures },
  { path: "/me/fixtures/{id}/availability", method: "put", summary: "RSVP in/out/maybe + note for the caller's person on this fixture (session only)", tag: "player-accounts", request: S.PutAvailability, response: S.Availability, errors: [403, 422] },
  { path: "/me/persons", method: "get", summary: "The caller's claimed player profiles with consent state (session only)", tag: "player-accounts", response: z.array(S.MyPerson) },
  { path: "/me/persons/{id}/consent", method: "patch", summary: "Player-owned consent flags; under-16 → 403 CONSENT_LOCKED (guardian gate)", tag: "player-accounts", request: S.PatchMyConsent, response: S.MyPerson, errors: [403] },
  { path: "/me/persons/{id}/photo", method: "post", summary: "Player-owned photo upload (multipart `file`); guardian gate as consent; public display still needs public_photo consent (session only)", tag: "player-accounts", response: S.MyPerson, errors: [400, 403, 404, 415, 502] },
  { path: "/me/persons/{id}/photo", method: "delete", summary: "Remove my photo — the public card falls back to initials (session only)", tag: "player-accounts", response: S.MyPerson, errors: [403, 404] },
  { path: "/fixtures/{id}/checkin-link", method: "post", summary: "Mint the fixture's self-check-in QR link (session editors only; signed token, dies at local midnight)", tag: "player-accounts", response: S.CheckinLink, status: 201, errors: [422] },
  // Stages
  { path: "/divisions/{id}/stages", method: "get", summary: "List stages in board order, each with its `tableRules` (W2d, as `GET /stages/{id}` serves them; null for a stage whose rules do not read; a bracket stage is served its sport's league reading)", tag: "stages", response: z.array(S.StageWithTableRules) },
  { path: "/divisions/{id}/stages", method: "post", summary: "Define the stage graph. Each stage is created with its kind's PRESET match rules in `config.rules` (W2c X-SR-6: a bracket stage starts with the deciders its sport presets for its kind and the division's variant — extra time and a shoot-out, overtime, a super over; the engine's `stageDefaults` decides which and their values; a table stage with none), every one the organiser's to switch off. `config.rules` sent with a create is laid over that preset key by key (a null removes the preset key: the stage inherits the division's value; `false` switches OFF a decider the sport turns off with no value at all, ice-hockey `overtime` and `shootout` and the hockey `shootout`). Unlike the stage PUT, `config.rules` that is absent, null or `{}` at create KEEPS the whole preset (a create has nothing stored to clear; to start from the division's own rules, send each preset key as null, or PUT `{}` afterwards). The rules are validated as `PUT /stages/{id}/rules` validates a save: 400 UNKNOWN_RULE_KEY / RULE_NOT_SETTABLE (`field`), 422 CONFIG_INVALID (`issues`), 422 TIEBREAK_KEY_INVALID (`refusals`, `stage_id`, `stage_name`) for the INHERITED tie-break order (the division's) the new stage's kind refuses — a stage's own order is not part of this body (`config.tiebreakers` is an unknown key of the strict stage config: 400 VALIDATION); nothing in the batch is written. A stage's own `config.points` (the engine's PointsRule) is asked what the stage PUT asks of it, and `config.points: null` means no points for this slot (as `points: null` does on the stage PUT): nothing is asked and nothing is stored. A non-null value: a bracket stage (no table) 400 RULE_NOT_SETTABLE (`field` `points`); a walkover `awardScore` on a sport whose table never reads it 400 RULE_NOT_SETTABLE (`field` `points.forfeit.awardScore`); a rule that does not pay an outcome the stage can end in 422 POINTS_OUTCOME_UNCOVERED (`uncovered`, `stage_name`); a bonus reading a score the sport does not emit 422 CONFIG_INVALID; a FLAT rule (one amount per win and per loss: no overtime, shoot-out or not-played split, no set-score table, a shoot-out booked as a result) on a stage whose sport pays one of those apart (IIHF's overtime 2/1, a 3-2 volleyball result, a table-tennis loss not played, FIH's shoot-out bonus) 422 POINTS_SPLIT_FLATTENED (`splits` naming each: `otWin`, `otLoss`, `shootoutWin`, `shootoutLoss`, `soBonus`, `unplayed`, `pointsMap`, `stage_name`, `stage_kind`) — no flat rule pays such a stage as its sport does (a retirement after play pays a flat rule's loss, never the sport's loss not played), so state the split in the rule to set it. A stage's own points ask no plan feature (bonuses and a forfeit row are free on every plan); a plan feature the body's stages need (a double-elimination or an advanced-format kind, carry-over) or the stage cap is 402 PAYMENT_REQUIRED. A decider at the config's TOP level (any whole decider a sport declares, e.g. `config.shootout`, `config.overtime`, `config.superOver`) is refused 400 VALIDATION naming the key (`field`) and where it goes (`config.rules.<key>`). 422 STAGE_SWISS_ROUNDS_REQUIRED when a `swiss` stage's `config.rounds` is absent or is not a whole number >= 1 — a Swiss round budget is declared up front, never derived from field size. Chess divisions take individual players only: an americano or mexicano stage (it mints pair entrants) is 422 CHESS_INDIVIDUAL_ONLY, asked before any plan gate, and the whole batch writes nothing", tag: "stages", request: S.CreateStages, response: z.union([S.Stage, z.array(S.Stage)]), status: 201, errors: [400, 402, 409, 422] },
  { path: "/divisions/{id}/stages", method: "put", summary: "Replace the stage graph (v8 Settings format; 409 FORMAT_LOCKED once fixtures exist). Each stage is written as for POST, then the body's `config.rules` over it — except that a slot whose `seq` keeps the same `kind` keeps the rules it already stored IN PLACE OF its preset (a preset key the organiser removed stays removed, and a stage set to the division's rules stays so); a new slot, or one whose kind changed, starts from its own kind's preset. A matched slot also keeps its own `points` (the stage's PointsRule) unless the body sends its own, which replaces it whole, or sends `points: null`, which drops it and stores none; a new slot, or one whose kind changed, has none. Every refusal POST can raise from the body or the carry (400 UNKNOWN_RULE_KEY / RULE_NOT_SETTABLE, 402 PAYMENT_REQUIRED for a plan feature or the stage cap, 409 for a `seq` the body names twice, 422 CONFIG_INVALID / TIEBREAK_KEY_INVALID / POINTS_OUTCOME_UNCOVERED / POINTS_SPLIT_FLATTENED / STAGE_SWISS_ROUNDS_REQUIRED — a carried `points` is asked as a sent one — and 422 CHESS_INDIVIDUAL_ONLY for an americano or mexicano stage in a chess division) refuses the whole save: a refused save leaves the existing stages untouched", tag: "stages", request: S.CreateStages, response: z.array(S.Stage), errors: [400, 402, 409, 422] },
  { path: "/stages/{id}/generate", method: "post", summary: "Generate fixtures (idempotent, returns diff). Optional body `{pairing}` — Swiss only, ROUND 1 only (422 SWISS_PAIRING_ROUND_ONE_ONLY / SWISS_PAIRING_NOT_SWISS otherwise); never stored. An americano or mexicano stage mints pair entrants, so in a chess division it is 422 CHESS_INDIVIDUAL_ONLY. A Swiss whose rounds exceed the hard maximum of the field being paired (n − 1 for an even field, n for an odd one) is refused SWISS_ROUNDS_ABOVE_MAX `{rounds, field, hardMax, canFinish}` — 422 as sent (the first Generate, or any before Start); in a running Swiss whose field shrank, only a round beyond the shrunk field's hard maximum is refused, 409 `canFinish: true`, and a round still within it is paired with `swiss_rounds` (verdict shrunk, `{rounds, field, hardMax, canFinish: true}`); above the safe maximum ⌊n/2⌋ it goes through with `swiss_rounds` (verdict warn).", tag: "stages", request: S.GenerateStageInput, requestOptional: true, response: S.GenerateResult, errors: [409, 422] },
  { path: "/stages/{id}/unpair", method: "post", summary: "Unpair latest Swiss round (shells kept) — clears sides on the highest fully seated round when it has no played results; Pair-minted bye awards do not block. 422 when the stage is not `swiss`; 409 ONLINE_GAME_EXISTS when an online (Lichess) game exists, or may exist, on a board it would clear — nothing changes, void the game first", tag: "stages", response: S.UnpairResult, errors: [409, 422] },
  { path: "/stages/{id}/open-round", method: "post", summary: "D12 — the organiser opens one round of an online-play (Lichess) stage: stamps it (the 10-minute check-in window hangs off this) and emails each player not yet invited for the current pairing. Idempotent per seat: a re-open invites only boards added or re-paired since, and answers `already_open` when nobody is left. A refusal (`no_fixtures`, `not_paired`, `division_not_started`, `clock_not_playable`) writes nothing; a board with no start time is served, its window hanging off the open. 403 OPEN_ROUND_FORBIDDEN for a non-organiser; 422 ROUND_NOT_ONLINE when the division is not played online; 403 ONLINE_CHESS_DISABLED unless the club is offered online chess (the PostHog flag `online-chess`) (asked after those two, so a re-open is refused alike and nothing is written); 409 ROUND_CHANGED when a board was re-paired mid-call. Session only — never an API-key route", tag: "stages", request: S.OpenRoundInput, response: S.OpenRoundResult, errors: [403, 404, 409, 422] },
  { path: "/stages/{id}/rebuild", method: "post", summary: "F3 Task 5 — replace a root stage's fixtures wholesale (delete + regenerate against the current active roster), instead of /generate's additive-only top-up. 409 STAGE_HAS_RESULTS if any fixture already carries a score, is in progress, or is completed (never a partial rebuild); 422 STAGE_NOT_ROOT for a stage that doesn't draw fixtures directly from the active roster (a progression source, a ladder, or an americano stage); a Swiss whose rounds exceed the current field's hard maximum is 422 SWISS_ROUNDS_ABOVE_MAX `{rounds, field, hardMax, canFinish: false}` and nothing is deleted", tag: "stages", response: S.RebuildResult, errors: [409, 422] },
  { path: "/stages/{id}/complete", method: "post", summary: "Guarded stage completion / progression", tag: "stages", response: S.CompleteResult, errors: [422] },
  { path: "/stages/{id}/standings", method: "get", summary: "Standings snapshot: one pool's table (`pool_id`; the stage's own table without it) as last folded. Each row carries the sport's ledger in `metrics` — with `won_ot`, `won_so`, `lost_ot`, `lost_so` (W2d spec §5.7: the wins and losses decided in overtime or a shoot-out, whatever the points rule paid for them) — and `tieBreak` naming the step that split it from the rows it was tied with (`key`, the rows it was tied `with`; `note` `h2h_two_not_applicable` / `h2h_incomplete` when a conditional step could not split a residual tie; `drawnAt`, the date a stored drawing of lots was made). `level: true` is on every row of a table with no counted fixture (no leader, nobody first), and `rank` is then `null` on every row (2026-10-28: the place 1..n otherwise; an older client that reads `rank` as a number must handle null)", tag: "stages", query: { pool_id: { schema: { type: "string", format: "uuid" } } }, response: S.StandingsSnapshot },
  { path: "/stages/{id}", method: "get", summary: "One stage with its `tableRules` (W2d spec §7): the tie-break order it ranks by (`tiebreakers.keys`), the layer it came from (`source`: `stage` — its own, `PUT /stages/{id}/rules`; `division` — the division's `tiebreakers`; `sport` — the sport's default; `migrated` — what the W2d migration found it ranking by), when the stage was PINNED to its rules (`pinnedAt`: generating a stage's fixtures pins it, and a pinned stage keeps its rules while the division's move — `stagesKeptPinned` on `PATCH /divisions/{id}`), and the sport's own default for the stage's kind under the division's config (`sportDefault`, the editor's Reset — never the winning order); the cross-group order (`crossGroup.keys`, §5.9); the points rule it pays (`points.rule`, `source`, `pinnedAt`); and every outcome the stage can end in (`reachableOutcomes`, the keys a points rule must pay). `tableRules` is null for a stage whose rules do not read (a build this server no longer carries, a config its sport cannot read): no order is guessed. A bracket stage ranks no table of its own and is served its sport's LEAGUE reading (the order and points a table stage of the division would read), though its own `points` are refused there (`PUT /stages/{id}/rules`, 400 RULE_NOT_SETTABLE)", tag: "stages", response: S.StageWithTableRules, errors: [404] },
  { path: "/stages/{id}", method: "delete", summary: "Delete a stage (last-in-graph, no played fixtures)", tag: "stages", response: z.object({ deleted: z.boolean() }), errors: [409] },
  // #622 — round-scoped required court tags. Registered under `stages`
  // rather than `scheduling` because it edits the stage's own configuration;
  // the SCHEDULER is the consumer, not the owner.
  { path: "/stages/{id}/court-tags", method: "get", summary: "#622 — a stage's required court tags: the stage-wide list (V367) plus per-round-role overrides, and the round roles this stage's fixtures currently occupy (a picker source, in bracket order). A round is addressed by ROLE (`final`, `semi_final`, `round_of_16`, `losers_round_2`, `plain_round_3`, …), never by `round_no`: a bracket numbers sparsely and a draw resize renumbers every round, so a round_no key silently addresses the wrong fixtures", tag: "stages", response: S.StageCourtTags },
  { path: "/stages/{id}/rules", method: "put", summary: "Per-stage match-format override (design 2026-09-17; every sport since W2c) — Best-of-1 in the league/Swiss stage and Best-of-3 in the playoff of the same division, an extra-time length on a knockout. What a stage can set is the SPORT'S declaration for the stage's kind and variant, not a list kept here: a key the sport never declares is 400 UNKNOWN_RULE_KEY, a declared key this stage cannot set (a league-only key on a knockout, a knockout-only decider on a table stage) or any points key is 400 RULE_NOT_SETTABLE (`field` names it). On an online (Lichess) division the clock and its clock family (`clock`, `variant`) are the division's own, never a stage's: either key is 400 RULE_NOT_SETTABLE (`field`, `reason: online_division`), and the Lichess challenge plays the division's clock in every stage. Keys are the CONFIG keys, not the editor's form keys: tennis takes `set`, `game` and `tiebreak`, NOT `setType`, `noAd` or `tiebreakWinBy`. The body is a FRAGMENT that MERGES into the stage's stored rules: a key it omits is kept, a key it names is replaced, a null VALUE removes that key (\"inherit\" is key ABSENCE — a stored null would be copied over the division's value by the overlay), `false` switches OFF a decider the sport turns off with no value at all (ice-hockey `overtime` and `shootout`, the hockey `shootout`; football's `shootout` and cricket's `superOver` take `false` as themselves; anywhere else it is 422 CONFIG_INVALID), an empty list is a value (chess `tiebreakRungs: []`, held for the organiser), and `rules: null` or `{}` clears every key back to the division format. The merged `{division config + rules}` is validated through the sport module's own configSchema (422 CONFIG_INVALID) while only the merged rules are stored. A save whose merged format (a `bestOf` in the body, say) would let the stage end in an outcome its points do not pay (the division's `pointsMap`, looked up by the exact \"W-L\" score else \"*\", or the stage's own `points`) is refused 422 POINTS_OUTCOME_UNCOVERED, `uncovered` naming the outcomes (`set:2-1`, `tie`). A save that would leave an unstarted match's OWN format (`PUT /fixtures/{id}/rules`) unable to fit the stage is 409 FIXTURE_OWN_FORMAT_NO_LONGER_FITS, naming the match (`fixture_id`, `fixture_no`, `field`) — never a silent drop; the same refusal comes from a division config save. Walkovers no event records are re-scored under the new format in the same transaction (409 FORMAT_DOES_NOT_FIT_PLAY if one cannot hold). The stage's own POINTS and ORDERS ride the same PUT (W2c ST-G8, W2d): the body is `{rules?, points?, tiebreakers?, crossGroupTiebreakers?}`, at least one sent, each arm left as stored when omitted, any other key 400 (an old-shape `points: {base: …}` too: no alias). `tiebreakers` is the stage's own tie-break order (`null` clears it back to the division's, else the sport's), validated on the stage's kind before anything is written: 422 TIEBREAK_KEY_INVALID, `refusals` naming each (`index`, `key`, `reason` — `sport`: the sport records no such ledger, e.g. `nrr` outside cricket); `crossGroupTiebreakers` is its order across groups (§5.9; `null` derives it from the order again). `points` is the engine's PointsRule (the outcome-keyed `win` and `loss` — regulation, overtime, shoot-out — the `draw`, `bonuses`, a `forfeit` row with an optional walkover `awardScore`) written WHOLE to the stage's `config.points` — a second save replaces it — and `points: null` removes it, back to the division's points. Refused by name: a bracket stage (no table) 400 RULE_NOT_SETTABLE (`field` `points`); a rule that does not pay an outcome the stage can end in 422 POINTS_OUTCOME_UNCOVERED (`uncovered`); a walkover `awardScore` on a sport whose table never reads it (the set sports, carrom, the board games) 400 RULE_NOT_SETTABLE (`field` `points.forfeit.awardScore`); a bonus reading a score the sport does not emit 422 CONFIG_INVALID; a FLAT rule (one amount per win and per loss: no overtime, shoot-out or not-played split, no set-score table, a shoot-out booked as a result) on a stage whose sport pays one of those apart (IIHF's overtime 2/1, a 3-2 volleyball result, a table-tennis loss not played, FIH's shoot-out bonus) 422 POINTS_SPLIT_FLATTENED (`splits` naming each: `otWin`, `otLoss`, `shootoutWin`, `shootoutLoss`, `soBonus`, `unplayed`, `pointsMap`) — no flat rule pays such a stage as its sport does (a `forfeit` row reaches only the walkover: a retirement after play pays a flat rule's loss, where ITTF pays the retired loser 0), so state the split in the rule to set it. No plan feature is asked: bonuses and a forfeit row are free on every plan; the one 402 PAYMENT_REQUIRED is a frozen competition's (`competitions.max_active`, over its plan's active-competition limit). A decider at the body's TOP level (any whole decider a sport declares, e.g. `shootout`, `superOver`, `tiebreakRungs`) is 400 VALIDATION, naming the key (`field`) and where it goes (`rules.<key>`). Editable until the first fixture in THAT stage has a frozen config snapshot or a score event, then 409 STAGE_FORMAT_LOCKED — a monotonic pair, deliberately not `fixtures.status`, which moves backwards when a start is voided. W2d: a stage generated but not yet scored is PINNED to its table rules; a points or order save then re-pins only the arm it saved (the others keep their pin and source). The answer is the stage's `rules`, `points`, `tiebreakers` and `crossGroupTiebreakers` as stored", tag: "stages", request: S.PutStageRules, response: S.StageRules, errors: [400, 402, 409, 422] },
  { path: "/stages/{id}/court-tags", method: "put", summary: "#622 — replace a stage's required court tags. `rounds` is a WHOLE-LIST replace: an omitted round role is deleted, an empty `required_court_tags` on a listed role is a real \"no requirement\" row. Omitting the `rounds` key entirely leaves the round rules untouched. 422 UNKNOWN_ROUND_ROLE for a role key no stage format produces, 422 DUPLICATE_ROUND_ROLE for the same role listed twice. Effective requirement per fixture is division ∪ stage ∪ round, resolved identically by the deterministic placer, the AI pack and the verifier", tag: "stages", request: S.PutStageCourtTags, response: S.StageCourtTags, errors: [422] },
  // Seed proposals (D4a design doc, P5) — propose + confirm cross-stage fill.
  { path: "/stages/{id}/seed-proposal", method: "post", summary: "Compute (or recompute) a draft seed proposal for a stage whose `progression.timing` is `setup`. 409 SEEDING_SOURCE_INCOMPLETE, 409 SEEDING_ALREADY_CONFIRMED, 422 SEEDING_RULES_MISSING, 422 SEEDING_CARRY_SOURCE_INVALID (`progression.carry` set against a source that offers a downstream stage a finishing order rather than a points table — every kind except `league`/`group`/`swiss`, i.e. the four bracket kinds plus `ladder` and `americano`)", tag: "stages", response: S.SeedProposal, status: 201, errors: [409, 422] },
  { path: "/stages/{id}/seed-proposal/confirm", method: "post", summary: "Confirm a draft proposal: fills the stage's TBD fixtures via the same slot-fill pathway as intra-bracket advancement, never regenerates. 409 SEEDING_PROPOSAL_STALE/SEEDING_ALREADY_CONFIRMED/SEEDING_FIXTURES_ALREADY_FILLED, 422 SEEDING_EDIT_UNKNOWN_SLOT/SEEDING_SLOT_DOUBLE_ASSIGNED/SEEDING_SLOT_FOREIGN_FIXTURE/SEEDING_ENTRANT_FOREIGN/SEEDING_ENTRANT_WITHDRAWN (an entrant about to be filled has withdrawn or been disqualified — recompute the proposal; her seat is left empty, nobody is promoted into it)/SEEDING_TIE_UNRESOLVED", tag: "stages", request: S.ConfirmSeedProposal, response: S.ConfirmSeedProposalResult, errors: [409, 422] },
  // Scheduling console (doc 12 §4, PROMPT-17)
  { path: "/format-preview", method: "post", summary: "Example fixtures for a stage graph (placeholder entrants; no persistence)", tag: "scheduling", request: z.object({ count: z.number().int().min(2).max(64).default(8), stages: z.array(z.object({ kind: z.string(), name: z.string(), config: z.record(z.string(), z.unknown()), progression: z.unknown().nullable() })) }), response: z.object({ phases: z.array(z.object({ title: z.string(), note: z.string().optional(), sections: z.array(z.object({ title: z.string(), matches: z.array(z.object({ home: z.string(), away: z.string() })) })) })) }) },
  { path: "/divisions/{id}/schedule-settings", method: "get", summary: "Get scheduling settings (defaults when unset)", tag: "scheduling", response: S.ScheduleSettings },
  { path: "/divisions/{id}/schedule-settings", method: "put", summary: "Upsert scheduling settings (constraint fields are gated by `scheduling.constraints`, free on every plan)", tag: "scheduling", request: S.PutScheduleSettings, response: S.ScheduleSettings, errors: [402] },
  { path: "/stages/{id}/schedule/auto", method: "post", summary: "Run the pure calendar pass — propose only, nothing persisted. 422 CAPACITY_IMPOSSIBLE (D2 pre-check, `error.capacity_report` attached) when the configured courts/dates/rest rules cannot arithmetically fit the movable fixtures, BEFORE either solver is reached", tag: "scheduling", request: S.AutoScheduleRequest, response: S.AutoScheduleResult, errors: [422] },
  { path: "/stages/{id}/schedule/apply", method: "post", summary: "Persist an assignment set; blocking conflicts → 409", tag: "scheduling", request: S.ApplyScheduleRequest, response: S.ApplyScheduleResult, errors: [402, 409, 422] },
  { path: "/stages/{id}/schedule/health", method: "get", summary: "Schedule health score (D3): 5 per-metric bars 0-100 with named offenders over the stage's applied fixtures — report-only, blocks nothing. homeAwayAlternation is present only for table-shaped stages (league/group/swiss/americano); 409 SCHEDULE_NOT_APPLIED when no fixture has been scheduled yet", tag: "scheduling", response: S.ScheduleHealthReport, errors: [409] },
  { path: "/divisions/{id}/schedule/validate", method: "post", summary: "Full board conflict report (doc 12 §2 taxonomy)", tag: "scheduling", response: S.ValidateScheduleResult },
  { path: "/divisions/{id}/schedule/capacity", method: "post", summary: "D2 live capacity precheck (P10 §4) over the board's UNSAVED config/fixtures in the body — court calendars are resolved server-side, since P9 stopped shipping them to the board payload; returns null when the window is unbounded, matching capacityInputForFixtures's own contract. Never throws on a bad verdict — 'impossible' is a 200, not a refusal", tag: "scheduling", request: S.CapacityPrecheck, response: S.CapacityReport.nullable(), errors: [404] },
  { path: "/divisions/{id}/publish-schedule", method: "post", summary: "Publish the timetable (division → scheduled), validated server-side: blocking conflicts 422 SCHEDULE_BLOCKING_CONFLICTS; warnings 422 SCHEDULE_UNACKNOWLEDGED_WARNINGS until acknowledge_warnings", tag: "scheduling", request: S.PublishScheduleRequest, response: S.PublishScheduleResult, errors: [422] },
  { path: "/divisions/{id}/start", method: "post", summary: "Start the tournament (quick-start generates fixtures). Publishes the schedule on the way through, validated server-side: blocking conflicts 422 SCHEDULE_BLOCKING_CONFLICTS; warnings 422 SCHEDULE_UNACKNOWLEDGED_WARNINGS until acknowledge_warnings. A root Swiss whose rounds exceed its field's hard maximum is 422 SWISS_ROUNDS_ABOVE_MAX `{rounds, field, hardMax, canFinish: false}`", tag: "scheduling", request: S.StartDivisionRequest, response: S.StartDivisionResult, errors: [422] },
  { path: "/divisions/{id}/events/import", method: "post", summary: "Batch-import score events into unstarted fixtures (D6)", tag: "scoring", request: S.EventImportRequest, response: S.EventImportReport, errors: [402, 403, 404, 409, 413] },
  // Fixtures & scoring
  { path: "/fixtures/{id}", method: "get", summary: "Get a fixture", tag: "fixtures", response: S.Fixture },
  { path: "/fixtures/{id}", method: "patch", summary: "Schedule move, venue, officials, pin/lock — blocking conflicts → 409, warn-level ones come back in `conflicts`", tag: "fixtures", request: S.PatchFixture, response: S.PatchedFixture, errors: [402, 409, 422] },
  { path: "/fixtures/{id}/stream", method: "put", summary: "Set or clear the fixture's public broadcast link (https, exact-host allowlist: YouTube, Facebook, Twitch, Kick) — surfaces as \"Watch live\" on the public match page", tag: "fixtures", request: S.PutFixtureStream, response: S.FixtureStream, errors: [403, 404, 422] },
  { path: "/fixtures/{id}/rules", method: "put", summary: "One match's own format over its stage's (W2c X-SR-2), and the live correction of a STARTED match's format (X-SR-5, owner Q11). A WHOLE-FRAGMENT replace: `rules` is the match's format over its stage's, and `rules: null` (or `{}`, or only null values) sets it back to the stage's — a null VALUE means inherit and is never stored. Only the leaves that differ from the stage's format are stored, so a later stage edit still reaches every leaf the match did not change. Keys are the sport's declared rule keys (400 UNKNOWN_RULE_KEY otherwise); a key the sport scopes per stage, or a decider switched on or lengthened, is 400 RULE_NOT_SETTABLE; the merged `{division + stage rules + bracket deciders + rules}` is parsed by the sport's configSchema (422 CONFIG_INVALID, the engine's message on `field`). A finished match (finalized or cancelled) is 409 FIXTURE_FORMAT_LOCKED. A started match is corrected only if the recorded play fits the new format: its ledger refolded under it must fold, keep its outcome and keep its score as shown, else 409 FORMAT_DOES_NOT_FIT_PLAY (\"This format would end the match as it stands\" when it would decide an open match). A correction re-freezes the match's config and bumps `rules_version` (an open pad compares it); re-sending the format it already plays bumps nothing. A match decided WITHOUT play (a walkover no event records) is started too: the correction must keep the award and its credited score (else 409 FORMAT_DOES_NOT_FIT_PLAY), and a bye, which credits no score, is 409 FIXTURE_FORMAT_LOCKED. Errors carry `fixture_id` and, where one applies, `field`. Organiser auth (no device link): a caller without write access to the fixture (a read-only role, an API key without the scope) is 403.", tag: "fixtures", request: S.PutFixtureRules, response: S.FixtureRulesResult, errors: [400, 402, 403, 404, 409, 422] },
  { path: "/fixtures/{id}/rules", method: "get", summary: "The rules a match plays by now (W2c X-SR-7, owner P-1): `cfg` (the format its ledger folds under), `rules_version` (bumped by each live correction of a started match) and `format_line` (the rules line the public pages print, in the reader's language: the format, how a tied match ends, an abandon policy the stage changed; null when there is none to say). An open scoring pad reloads them after 409 FIXTURE_RULES_CHANGED, or when an append's answer carries a newer `rules_version`. Organiser or device link, as GET /fixtures/{id}/state", tag: "scoring", response: S.FixtureCurrentRules, errors: [404] },
  // Streaming R1 — phone relay sessions (design §6.3). Never key-reachable (key-scopes.ts).
  { path: "/fixtures/{id}/stream-sessions", method: "post", summary: "Start a phone-relay session for the fixture (one match credit is consumed when it goes live). 409 active_session when one is already running (its id is returned as `sessionId`), 409 overlay_required, 409 phone_not_paired (no phone is paired on the fixture's stream code — scan it first; asked after active_session and before credits, so no row is written and no credit spent), 409 phone_not_responding (a phone IS paired but has sent no beat within its liveness window — wake it, no rescan needed; asked at the same point, same guarantees), 409 target_in_use (the destination is live or waiting on another match, named in `holder`), 402 no_credits, 422 DESTINATION_NOT_ALLOWED (the saved destination is no longer on the allowlist), 422 TARGET_UNREADABLE (the saved stream key can no longer be read: replace the key, or for a legacy destination remove it, since only YouTube and Twitch can be added; refused before any provider call, no row is written, no credit spent), 503 composed_unavailable (mode composed where the compositor cannot run: the relay is unavailable, no compositor image is configured, or, on a live deployment, FLY_API_TOKEN or ENV_NAME is unset or FLY_RELAY_APP is unset or still the retired shared default; asked before every admission refusal, after the deployment's ingest_unavailable, so no session row, input, credit or runner is created — start passthrough instead), 503 storage_exhausted (no row is written). A destination that is a connected YouTube channel is refused with a YouTube code and `connectionId` in the error extras (nothing is written or spent, and a broadcast made at YouTube is deleted again) — after every admission refusal above except 503 storage_exhausted, which is weighed after the YouTube step, so a channel that cannot go live answers its YouTube code even when storage is exhausted, and a channel that can answers storage_exhausted: 409 youtube_reconnect_needed (the channel's grant is dead: reconnect it), 409 youtube_live_not_enabled (live streaming is not enabled on the channel), 409 youtube_live_blocked (YouTube has blocked the channel from streaming), 409 youtube_channel_busy (the channel already has its ten live streams in use), 429 youtube_limit_reached (YouTube's quota is used up; try again later), 503 youtube_unavailable (YouTube did not answer, or the channel's stream key could not be read)", tag: "fixtures", request: S.CreateStreamSession, response: S.StreamSessionCreated, status: 201, errors: [402, 403, 404, 409, 422, 429, 503] },
  { path: "/fixtures/{id}/stream-sessions/current", method: "get", summary: "The fixture's latest relay session as the organiser sees it (state, health, the phone-lost countdown, the restart allowance) — null when none exists. Carries no credential. A `reveal` query parameter (the removed v1 QR's) is 400", tag: "fixtures", response: S.StreamSessionCurrent.nullable(), errors: [403, 404] },
  { path: "/fixtures/{id}/stream-sessions/{sid}/stop", method: "post", summary: "Ask a running relay session to end (desired_state = ending); a passthrough session completes at once. Idempotent: a session already ending or ended answers the same projection and decides nothing (no transition, no provider call) — a tap on a session still ending is recorded as the organiser's action, one on an ended session writes nothing; 409 not_active when the fixture has since started a newer session", tag: "fixtures", response: S.StreamSessionCurrent, errors: [403, 404, 409] },
  // Capture QR v2 (T5) — the stable stream code and the destination pre-pick. Never key-reachable (key-scopes.ts).
  { path: "/fixtures/{id}/stream-code", method: "post", summary: "The fixture's stable stream code (editor session only): re-shows the ACTIVE code (the same QR) or mints one; never ends a code. Served private, no-store (the tok is live). 402 without streaming.relay, 422 fixture_finished (the match is over: nothing left to start), 503 RELAY_KEK_MISSING (the server has no key; nothing is written)", tag: "fixtures", response: S.StreamCodeShown, errors: [402, 403, 404, 422, 503] },
  { path: "/fixtures/{id}/stream-code/reissue", method: "post", summary: "Revoke & reissue the fixture's stream code: the ACTIVE code ends at once (a phone already streaming keeps its session until it ends) and a fresh one is minted and shown. 402 without streaming.relay, 422 fixture_finished, 503 RELAY_KEK_MISSING (the old code is untouched)", tag: "fixtures", response: S.StreamCodeShown, errors: [402, 403, 404, 422, 503] },
  // Capture QR v2 §6.3 — the phone's routes, under the internal `capture` tag: never key-reachable (key-scopes.ts), so
  // never in the published spec. The JSON contracts (docs/contracts/capture-*.json) stay the cross-repo authority.
  { path: "/capture/codes/{code}", method: "get", summary: "The phone's descriptor (Bearer: the stream code's tok). With `phone`, it follows the fixture's latest session: open (warming, live, ending) → the session shape, with `cred` only for that session's own phone; ended after warming → completed or failed with its endReason; otherwise, and always without `phone`, the waiting shape. Served private, no-store. 401 code_ended (unknown, wrong tok, ended, or no Bearer — one body), 404 not_a_stream_code, 422 invalid (a slot other than 0, or a `phone` that is not 16–64 characters), 429 rate_limited, 503 unavailable. Never 410", tag: "capture", bare: true, response: S.CaptureDescriptor, query: { slot: { schema: { type: "integer", enum: [0] }, description: "The camera slot; omitted = 0, any other is 422 invalid" }, phone: { schema: { type: "string", minLength: 16, maxLength: 64 }, description: "The phone's id: picks the session shape, and `cred` for the session's own phone" } }, errors: [422, 429, 503] },
  { path: "/capture/codes/{code}/beats", method: "post", summary: "The phone's beat (Bearer: the stream code's tok), every pollSeconds. A strict body: a claim (new/resume) decides who holds slot 0 (a live slot is `taken` unless its phone is dead — no beat, no video and a fresh read not connected for 60 s); the current phone's beat is stored on the server's clock; `ended` from the session's phone is the operator's Stop (it ends the pairing), and `stopped` closes that sid unless another current phone holds it. Answers by state: waiting, go-live (sid, startedBy), live (sid), over (sid, endReason), replaced, taken — each with the waiting fields and pollSeconds. Served private, no-store. 401 code_ended, 404 not_a_stream_code, 422 invalid (a malformed body, a slot other than 0, a body naming another code), 429 rate_limited, 503 unavailable. Never 410", tag: "capture", bare: true, request: S.CaptureBeat, response: S.CaptureBeatAnswer, errors: [422, 429, 503] },
  { path: "/capture/codes/{code}/start", method: "post", summary: "The phone's own start (Bearer: the stream code's tok), body {phone}: the CURRENT phone starts its match on the organiser's pre-picked destination, cause operator, through the one start path. 200 {sid}. 409 already_live {sid, startedBy} (a session is running — a retry after a lost 200 meets this with the same sid), 409 replaced (not the current phone), 409 no_destination (no pre-pick, archived, held by another match, not allowed, its key unreadable, or its YouTube channel needs reconnecting, has live streaming disabled or is blocked from streaming), 402 no_credit, 403 not_entitled, 503 unavailable (storage exhausted, the ingest unavailable, the relay disabled, or YouTube not answering, its quota used up, or the channel's ten live streams in use). 401 code_ended (an ended code starts nothing), 404 not_a_stream_code, 422 invalid, 429 rate_limited with Retry-After. Served private, no-store. Not idempotent. Never 410", tag: "capture", bare: true, request: S.CaptureStartBody, response: S.CaptureStartOk, errors: [402, 403, 409, 422, 429, 503] },
  { path: "/capture/codes/{code}/records", method: "post", summary: "The operator's Send record (Bearer: the stream code's tok; spec 2026-10-12, capture-record.v1). The body is NDJSON (application/x-ndjson, `Content-Encoding: gzip` or none), ONE line per the request schema: at most 1000 non-empty lines and 1 MB decompressed. Any phone holding a currently valid tok of the code may send (R4): an active or finishing code, an ended one while the fixture's session opened before the end is still open, and for 24 h after. Lines of another code are dropped before storage (A1 by session, A2 by pairing window), and so is every bad line — a key off capture's allow-list, a value off its class, a line that is not a JSON object or not UTF-8, a key named twice, a secret-shaped value — never the body refused (owner ruling, 2026-10-12); a kept line is stored as the server re-serialises it; a dropped line is never stored, logged or echoed. 201 {ref, kept, dropped} — a record whose every line was dropped is still 201 with kept 0. 401 code_ended, 404 not_a_stream_code, 413 too_large, 422 invalid (a body that cannot be read as lines — an unsupported Content-Encoding, a gzip that will not decode — or one with no non-empty line), 429 rate_limited with Retry-After (10 records an hour per code, a bucket of its own), 503 unavailable. Served private, no-store. Not idempotent. Never 410, never replaced", tag: "capture", bare: true, request: S.CaptureRecordLine, requestContentType: "application/x-ndjson", response: S.CaptureRecordOk, status: 201, refusal: S.CaptureRecordRefusal, errors: [413, 422, 429, 503] },
  { path: "/capture/codes/{code}/scoring-link", method: "post", summary: "The match's Remote scoring link (Bearer: the stream code's tok), body {phone}, for the slot's CURRENT phone, with or without a session (capture QR v2 §6.3.5, W27). Returns the match's live scoring link, or creates one — it never removes or replaces an existing link, so a repeat call returns the same url. 200 {url} (https, /score/, the link's secret: a credential, never logged). 409 replaced (not the current phone), 409 match_finished (the match is finalized or cancelled; nothing written), 402 not_entitled (the plan has no scoring links; an Event Pass on the competition lifts it), 503 unavailable (scoring links not configured on this server). 401 code_ended (an ended code serves nothing here), 404 not_a_stream_code, 422 invalid, 429 rate_limited with Retry-After (the code's budget, then the console's per-IP mint budget). Served private, no-store. Never 410", tag: "capture", bare: true, request: S.CaptureStartBody, response: S.CaptureScoringLinkOk, errors: [402, 409, 422, 429, 503] },
  { path: "/fixtures/{id}/stream-phone", method: "get", summary: "The organiser panel's phone read model (editor session only): the fixture's stream code (active, finishing or ended, with its end cause), its paired phone — present, silent and not responding judged on the server's clock, its model, app version, mode, state, readiness and latest beat (battery, bitrate, delivery, thermal, data used), with elapsedMs since that beat on the server's clock, the amber health reason (null when none), and how long it has been continuously not ready (shown only once a beat at least 20 seconds after it began still reports it, and never for a silent phone; a silent phone's readings are not judged) — the destination pre-pick (null when archived), the last time another phone took the slot, and the fixture's automatic-streaming state (null with no settings row; a refusal is shown only while an automatic start could still fire). A session with no phone (opened before stream codes) shows no phone. Carries no secret. Served private, no-store", tag: "fixtures", response: S.StreamPhone, errors: [403, 404] },
  { path: "/fixtures/{id}/stream-settings", method: "put", summary: "The fixture's stream settings: the destination pre-pick the phone's start uses (`targetId`, null clears it), the automatic-streaming switch (`autoStream`), and the stream's score preferences — `streamMode` (`passthrough` streams the camera only; null or `composed` streams the score whenever the deployment can run it, and every start reads it), `overlayTemplate` (null is the sport's default; an id the fixture's sport is not offered is a 400 and writes nothing) and `overlayDelayMs` (0–30000 whole ms; null is the server's default, 0 a real override). Send any of them; a field left out is left as it is. The answer's `targetId` is the saved choice, and its `revision` orders it against any other answer or read of these settings (higher is newer). 404 when the target is not this org's, is archived, or does not exist", tag: "fixtures", request: S.PutStreamSettings, response: S.StreamSettings, errors: [403, 404] },
  { path: "/fixtures/{id}/lineups/{entrantId}", method: "get", summary: "Get a side's lineup", tag: "fixtures" },
  { path: "/fixtures/{id}/lineups/{entrantId}", method: "put", summary: "Replace a side's lineup", tag: "fixtures", request: S.PutLineup, errors: [422] },
  { path: "/fixtures/{id}/events", method: "post", summary: "Append a score event (THE scoring endpoint). 403 RESULT_CARRIED_FORWARD: a device link writing to a fixture whose settled result has already moved the competition on (its winner or loser feed seated, the next Swiss round paired, or its stage complete) — corrections are then the organiser's. A keyed retry of a write the ledger already holds still gets its original answer. 409 FIXTURE_RULES_CHANGED (W2c X-SR-7): the request sent a `rules_version` that is not the match's — its format was corrected since; nothing was written, and the error carries the match's `rules_version` and `format` (its rules line, en: the format, how a tied match ends, an abandon policy the stage changed; null when none). Checked only when sent, and before `expected_seq`. Every 201 carries the match's `rules_version`. 426 ENGINE_OUTDATED: the request carries an engine_epoch lower than the minimum epoch the server accepts for the fixture's sport now (normally its fold epoch) — update the client; nothing was written and the idempotency key is not consumed (an absent or higher engine_epoch is accepted; a retry of an already-accepted key answers its original event even after the epoch has moved). This 426 carries no Upgrade header (it is not a protocol upgrade): key on error.code ENGINE_OUTDATED, never on the status alone", tag: "scoring", request: S.AppendEventRequest, response: S.AppendEventResponse, status: 201, errors: [403, 409, 422, 426, 429] },
  { path: "/fixtures/{id}/events", method: "get", summary: "Read the ledger after ?since_seq=", tag: "scoring", response: z.array(S.ScoreEvent), query: { since_seq: { schema: { type: "integer", minimum: 0, default: 0 } } } },
  { path: "/fixtures/{id}/audit", method: "get", summary: "Signed per-match audit trail: the full hash-chained event stream, chain-verification verdict and an Ed25519 signature over the head hash (Pro `scoring.audit_export`; verify keys at /.well-known/seazn-audit-keys)", tag: "scoring", errors: [402, 404], query: { format: { schema: { type: "string", enum: ["json", "pdf"], default: "json" } } } },
  { path: "/fixtures/{id}/state", method: "get", summary: "Live state (ETag = digest of the body)", tag: "scoring", response: S.FixtureState },
  { path: "/fixtures/{id}/finalize", method: "post", summary: "Lock the ledger (core.finalize)", tag: "scoring", request: z.object({ expected_seq: z.number().int().min(0) }), response: S.AppendEventResponse, errors: [409, 422] },
  { path: "/fixtures/{id}/external-play/resolve", method: "post", summary: "The organiser settles an online board — held for a decision, or still being played — through the normal scoring path, under their own authority (the ledger records who). `home_wins` / `away_wins` is a forfeit when the loser was recorded as a no-show and an adjudication otherwise; `draw` is a draw by adjudication, which in a knockout opens the tie-break and answers `tiebreak_owed` (the board stays held for the winner); `no_result` voids the game — an abandon, no points to either player, its reason the hold's in the club's language — only in a league or a group's round-robin, and is refused in any knockout and in a Swiss; `double_walkover` is offered instead where both players were recorded as no-shows, in any stage that takes one (a knockout line that feeds a next match included, a final not). Each is accepted only where it is the one offered. A board whose tie-break is owed takes a winner only. Session only, never an API key. 403 ARBITER_PLAYS_THIS_BOARD when the caller plays on this board; 404 for a board that is not this club's online board; 409 ALREADY_RESOLVED for a board that already has its result, BOARD_CHANGED when another writer changed the board while this settle was on its way (nothing written; reload to see it), NO_RESULT_CHANGED when the board now offers the other of `no_result` and `double_walkover` — who turned up changed (nothing written), ONLINE_GAME_OVER when the board's online game is over but its fixture is open again (a result voided on the scoring pad — decided there, nothing written), ONLINE_GAME_NEVER_STARTED for the same on a board closed before its online game started (no move on file — a no-show walkover or a pre-start settle, voided on the pad; nothing written), TIEBREAK_NEEDS_WINNER for a draw, no result or double walkover on a board whose tie-break is owed, KNOCKOUT_NEEDS_WINNER for no result in any knockout (a double walkover on a final included) and SWISS_NEEDS_RESULT for no result in a Swiss, whose next round waits on every game decided (nothing written)", tag: "fixtures", request: S.ResolveExternalPlay, response: S.ResolveExternalPlayOut, errors: [403, 404, 409, 422] },
  { path: "/fixtures/{id}/external-play/flags/close", method: "post", summary: "Let the game go on: the organiser closes the fair-play flags they were shown, by id. A flag raised since stays open; an id already closed keeps its first resolver. Flags are evidence, never sanctions: no result, seat or game changes. Answers how many this call closed and how many are still open on the board. Session only, never an API key. 403 ARBITER_PLAYS_THIS_BOARD when the caller plays on this board; 404 FLAG_NOT_FOUND when an id is not one of this board's flags", tag: "fixtures", request: S.CloseExternalPlayFlags, response: S.CloseExternalPlayFlagsOut, errors: [403, 404, 422] },
  { path: "/fixtures/{id}/external-play/arbiter", method: "post", summary: "A signed-in organiser joins ONE PLAYER's video meeting receive-only (RealtimeKit preset `arbiter`; each player has a meeting of their own, so the body names the entrant `side` - `home` or `away`): their OWN token for a FRESH participant (one per open, never reused; the server removes it when the panel closes, when the organiser's role is gone, when the organiser is now seated on the board, after 3 hours, or when the room is torn down), the side joined, and the participant ids of the players in that meeting. It joins an existing meeting or refuses; it never creates one. Never a player's token; never an API key. 400 for a missing or unknown side; 403 ARBITER_PLAYS_THIS_BOARD when the caller plays on this board; 409 FIXTURE_NOT_PLAYABLE (the board is over), ROUND_NOT_OPEN, VIDEO_NOT_IN_USE (camera policy off), VIDEO_OVERRIDDEN (the board plays without video), VIDEO_MEETING_NOT_STARTED (that player has not checked in yet), VIDEO_MEETING_ENDED; 429 past 12 joins a minute for one fixture and organiser; 503 VIDEO_UNAVAILABLE when the video vendor is down", tag: "fixtures", request: S.ArbiterJoinInput, response: S.ArbiterJoinOut, errors: [400, 403, 404, 409, 429, 503] },
  { path: "/fixtures/{id}/external-play/arbiter/{participantId}", method: "delete", summary: "The arbiter panel closed: the server removes the caller's OWN arbiter participant from the board's meeting (kicked from the live session, then deleted at the video vendor), so its token can no longer watch. `removed: false` when it was already removed. Best effort from the browser; the sweep removes whatever is left. 404 for a participant that is not the caller's on this board; 503 VIDEO_UNAVAILABLE when the video vendor is down (the sweep retries). Session only, never an API key", tag: "fixtures", response: S.ArbiterLeaveOut, errors: [403, 404, 503] },
  { path: "/fixtures/{id}/external-play/resync", method: "post", summary: "Organiser's resync: reads the board's game at Lichess and brings the move ledger in line (reconcile, trigger `organiser`). Answers whether a read brought the truth, how many plies it added, and whether it closed the board. Session only, never an API key. 404 for a board that is not played online; 429 when the board was resynced too often in the last minute; 503 LICHESS_TOKEN_UNAVAILABLE when a player's Lichess token cannot be opened", tag: "fixtures", response: S.ExternalPlayResyncOut, errors: [403, 404, 429, 503] },
  { path: "/fixtures/{id}/external-play/extend-checkin", method: "post", summary: "The arbiter adds 5 minutes to ONE board's check-in while it is still open (at most 3 times a board): the board's deadline - and with it the player's countdown, the sweep's no-show and the line's cap - moves by the same 5 minutes. Answers the board's press count, the presses it has left and its new deadline. Allowed only while the board's check-in is open: after it opens, before its (extended) deadline, with no game on file, the board still to be played, under the cap. Written to the audit log (who, which board, the new deadline). Session only, never an API key. 403 ARBITER_PLAYS_THIS_BOARD when the caller plays on this board, or the caller is not a signed-in owner or admin of the club; 404 for a board that is not this club's online board; 409 ROUND_NOT_OPEN, then one code per reason: CHECKIN_NOT_OPEN (the board's batch has not opened yet), CHECKIN_CLOSED (past its deadline), CHECKIN_GAME_STARTED (a game is, or may be, on file), FIXTURE_NOT_PLAYABLE (the board is over, cancelled or voided), CHECKIN_EXTEND_CAP (already extended 3 times); ROUND_CHANGED when the board changed under the call", tag: "fixtures", response: S.CheckinExtendBoardOut, errors: [403, 404, 409] },
  { path: "/stages/{id}/extend-checkin", method: "post", summary: "The arbiter adds 5 minutes to the check-in of EVERY board of an opened round whose check-in is open right now: one action, the single board's rule on each board, each board its own atomic step. Answers how many boards were extended and how many were skipped and why - `closed` (past its deadline), `gameStarted` (a game is, or may be, on file), `capReached` (already extended 3 times) - plus `notOpenYet` (a later batch that has not opened; untouched), `ownBoards` (boards the caller plays on; never touched) and `failed` (a board whose step threw; the others went on). One audit row per board extended. Session only, never an API key. 403 for a caller who is not a signed-in owner or admin of the club; 404 for a stage that is not this club's; 409 ROUND_NOT_OPEN before the round is opened", tag: "stages", request: S.ExtendRoundCheckinInput, response: S.CheckinExtendRoundOut, errors: [403, 404, 409, 422] },
  { path: "/fixtures/{id}/external-play/video-override", method: "post", summary: "D11: video is required but unavailable — the organiser lets this board play without video. Written once to the audit log with the reason given (first writer wins). Session only, never an API key. 403 ARBITER_PLAYS_THIS_BOARD when the caller plays on this board (they would be excusing their own camera); 409 FIXTURE_NOT_PLAYABLE for a board no longer being played, VIDEO_NOT_REQUIRED when the camera policy is not `required`", tag: "fixtures", request: S.VideoOverrideInput, response: S.VideoOverrideOut, errors: [403, 404, 409, 422] },
  { path: "/fixtures/{id}/external-play/resend", method: "post", summary: "Re-email the Seazn fixture URL to both players of an online-play fixture (does not mint a new Lichess challenge). Session only, never an API key. 403 ONLINE_CHESS_DISABLED unless the club is offered online chess (the PostHog flag `online-chess`) — nobody is mailed. 409 ROUND_NOT_OPEN before the round is opened, WINDOW_CLOSED after its 10-minute deadline (plus any time the arbiter added), ONLINE_GAME_EXISTS when a game exists (or may exist) on the board, BOARD_HELD while it awaits an organiser decision, ALREADY_RESOLVED / FIXTURE_NOT_PLAYABLE for a settled board, ROUND_CHANGED when it was re-paired mid-call", tag: "fixtures", response: z.object({ emailed: z.number().int(), retrying: z.number().int() }), errors: [403, 404, 409, 422] },
  { path: "/fixtures/{id}/external-play/room", method: "get", summary: "Match-room snapshot for one of the fixture's two players (session, or the personal link token in `?t=`, which wins when present). Never writes. Never key-reachable. The snapshot's `deadline` is the board's own check-in deadline; `heldUntil` is, while the check-in line holds the board open for this viewer past it, the instant that hold ends (the board's cap, or for a player already admitted the earlier of the cap and the end of their admission hold) and null otherwise. The answer is `Cache-Control: private, no-store` (it varies by the session cookie and carries the viewer's own email on a mismatch). `account` says whose seat this is and who is looking: `{ state: \"ok\" }`, or `{ state: \"wrong_account\", viewerEmail }` when the personal link is opened while signed in as a different account (the VIEWER's own email; the seat's is never sent). Every identity failure is the same 404 NOT_FOUND; 409 ROOM_BEING_REPAIRED while the organiser re-pairs the board's round (it seats nobody), to the board's own link or a player of its division; 409 ROOM_SEAT_NO_ACCOUNT to a personal link that verified for this board whose seat is tied to no Seazn account", tag: "fixtures", errors: [401, 404, 409] },
  { path: "/fixtures/{id}/external-play/room", method: "post", summary: "Take the seat for this fixture: under policy `required` the camera gate is read from RealtimeKit (presence, and the current peer's own report showing the camera granted and on), never from a claim sent to this API. Seat refusals `camera_starting` (joined, the camera's report not in yet — or RealtimeKit's call budget was spent so the claim could not look: ask again after the back-off of 1, 2, 4 then 8 seconds; asking sooner is answered from the last read without calling the vendor) and `camera_blocked` (the browser refused the camera) carry the caller's own participant token, as `camera_required` and `camera_lost` do — except a `camera_starting` whose participant is null: it is answered to a browser that says it holds this participant's token (optional body `{ heldParticipantId }`, the id it holds; absent or null means it holds none, and a token is handed on every answer), or the claim could not look — keep the token already held. An `optional` camera whose token the call budget held back is seated with `participant: null` and `cameraRetry: true`: ask POST …/room/camera for the token on a back-off (a tokenless seat WITHOUT `cameraRetry` - camera Off, an organiser's override, a vendor outage - is final). Seat refusal `queued` (the platform's RealtimeKit call budget is holding this claim in the check-in line, first come first served, one place per player): `participant` is null and `line` is { position (among those still waiting), etaS (a conservative estimate of how many seconds until this player is let in: it prices every place ahead at its worst case and allows one poll, so the wait is usually shorter, but it is a guide and not a promise), pollMs (ask again after this many milliseconds; never faster than 2000), closesAt (the board's cap, ISO), mayTimeOut (the estimate and the camera's start may not fit before closesAt), left (null; `silent` or `camera` on the one claim that starts a fresh place after the player's previous one was lost, and only there) } — the room keeps the token it already holds and asks again after `pollMs`, with no upper bound, until the answer changes. Stamps the check-in inside the BOARD's window, which a player held in that line keeps open until the board's cap (a round's boards open for check-in in groups of ten, two minutes apart, when the camera policy is `required` or `optional`; a claim before the board's own group has opened is refused `checkin_not_open` with nothing stamped and no vendor call — the snapshot's `opensAt` says when it opens, and a claim for a round never opened is still `round_not_open`); once both players are in, the Lichess game is created. Answers { snapshot, seat }. 409 ROOM_BEING_REPAIRED and 409 ROOM_SEAT_NO_ACCOUNT as the GET (and its snapshot carries `account`, as the GET's). 429 RATE_LIMITED: more claims from this seat on this board inside a minute than the room's own check-in attempt sends - twenty on the seat door, sized for one attempt on each of two devices (an attempt is the press and the room's own follow-up asks, so a second attempt inside the same minute can be refused), and sixty-four on the `line` door that a claim from a player already in the check-in line counts under, so polling in the line never uses up the check-in's own asks (Retry-After is the whole seconds until the minute reopens; nothing was done) — the room shows a countdown from Retry-After on the Check in button and offers it again when it reaches zero; a player in the line stays in it and keeps polling", tag: "fixtures", request: S.RoomSeatClaim, requestOptional: true, errors: [400, 401, 404, 409, 429] },
  { path: "/fixtures/{id}/external-play/room/act", method: "post", summary: "Submit a move (UCI; a promotion must carry its piece), a draw offer or answer, a resignation or an abort. Our server forwards it to Lichess with the player's own token; a move that ends the game, a resignation, an accepted draw or an abort closes the board through reconcile. 400 INVALID_UCI for a malformed move; 503 LICHESS_TOKEN_UNAVAILABLE when the player's token cannot be opened", tag: "fixtures", request: S.RoomAct, response: S.RoomActOut, errors: [400, 401, 404, 503] },
  { path: "/fixtures/{id}/external-play/room/clock-zero", method: "post", summary: "A player's clock display reached zero. The server re-does the arithmetic and only when it agrees asks Lichess; a flag is never declared from arithmetic", tag: "fixtures", response: z.object({ reconciled: z.boolean() }), errors: [401, 404] },
  { path: "/fixtures/{id}/external-play/room/camera", method: "post", summary: "An optional camera's token, asked for again: a player seated under camera policy `optional` whose token the platform's RealtimeKit call budget held back (the seat answer carried `cameraRetry: true`) asks here, on a back-off of 2, 4, 8 then 16 seconds (30 at most), until it holds one. Answers the token and nothing else - no check-in is stamped, no lobby published, no game asked for. `retry: true` with no token: the budget is still spent, ask again later; `retry: false` with no token is final (camera Off, an organiser's override, a vendor outage, a refused seat). No body. Never key-reachable. Identity as the room's other routes (a stranger is the same 404 NOT_FOUND). 409 VIDEO_MEETING_ENDED when the board's video meeting has already ended (final: nothing to ask for). 429 RATE_LIMITED: more asks from this seat on this board inside a minute than the back-off above ever makes (Retry-After is the seconds until the minute reopens; nothing was done) — the client asks again on its next back-off step", tag: "fixtures", response: S.RoomCameraAnswer, errors: [401, 404, 409, 429] },
  { path: "/fixtures/{id}/external-play/room/camera-fault", method: "post", summary: "The player's browser left the video meeting because it could not refuse a remote stream (our safeguard, never the player's camera), or is back in it. Stamps the caller's own seat on the server's clock, so the camera evidence never counts the gap against the player. 429 CAMERA_FAULT_CAP_REACHED: a start past the seat's stamp cap for the match (nothing written); an end is never refused", tag: "fixtures", request: S.RoomCameraFault, response: z.object({ open: z.boolean() }), errors: [400, 401, 404, 429] },
  { path: "/fixtures/{id}/external-play/room/camera-report", method: "post", summary: "The player's browser reports its own camera (`live` or `off`) so the OPPONENT's presence pill can show it: each player is in a video meeting of their own, so the opponent's browser cannot see it. `heartbeat: true` repeats an unchanged state (every 30 s, in both states); a change (`heartbeat: false`) always writes. Stamps the caller's own player participant on the server's clock; a heartbeat that disagrees with a still-fresh stored state is ignored (`outcome: ignored`). Makes no video-vendor call, and nothing but the opponent's pill reads it. Never key-reachable. 404 for anyone but one of the board's two seated players; 429 past 12 reports a minute for one fixture and person", tag: "fixtures", request: S.RoomCameraReport, response: z.object({ outcome: z.enum(["written", "refreshed", "ignored"]) }), errors: [400, 401, 404, 429] },
  { path: "/fixtures/{id}/external-play/lobby", method: "get", summary: "A signed-in player's door into their match room, for the public fixture page: the board's state and the room's path (`state` + `roomPath`), or `online_chess_off` with no path while the club is not offered online chess and no game has started. Never writes — check-in happens only in the room. Session only, never an API key; `Cache-Control: private, no-store` on every answer. Every identity failure (not a player on this board, another club, not an online fixture) is the same 404 NOT_FOUND", tag: "fixtures", response: S.ExternalPlayLobbyOut, errors: [401, 404] },
  // Device links (doc 13 §7, PROMPT-21)
  { path: "/fixtures/{id}/device-links", method: "post", summary: "The fixture's device link (editor session only): re-shows the live sealed link (200, same secret) or mints one (201); never revokes a sealed link. Lives until the fixture is over. 503 DEVICE_LINK_KEK_MISSING when the server has no key.", tag: "device-links", request: S.CreateDeviceLink, response: S.CreatedDeviceLink, status: 201, errors: [402, 403, 404, 422, 429, 503] },
  { path: "/fixtures/{id}/device-links", method: "get", summary: "The fixture's active device link, if any (never the secret)", tag: "device-links", response: S.DeviceLink.nullable() },
  { path: "/fixtures/{id}/device-links/{linkId}", method: "delete", summary: "Revoke a device link (immediate 401 for the holder)", tag: "device-links", response: S.DeviceLink },
  { path: "/fixtures/{id}/device-links/reissue", method: "post", summary: "Revoke & reissue: every live device link for the fixture dies (including a printed scorer sheet's QR) and a fresh one is minted", tag: "device-links", request: S.CreateDeviceLink, response: S.CreatedDeviceLink, status: 201, errors: [402, 403, 404, 422, 429, 503] },
  // Officiating portal (PROMPT-57)
  { path: "/me/fixtures/{id}/officiating-response", method: "patch", summary: "Accept or decline an officiating assignment (assigned official's session only; declines flag for a manual re-pick, never auto-reassign)", tag: "officials", request: S.OfficiatingResponseInput, response: S.OfficiatingResponseOut, errors: [422] },
  { path: "/me/availability/officiating", method: "post", summary: "Mark a blackout date on every officiating profile linked to the caller (upsert on note)", tag: "officials", request: S.OfficiatingBlackoutInput, response: S.OfficiatingBlackout, status: 201 },
  { path: "/me/availability/officiating", method: "delete", summary: "Clear a blackout date (idempotent)", tag: "officials", query: { date: { schema: { type: "string", format: "date" }, description: "The date to clear (YYYY-MM-DD)" } } },
  { path: "/me/officiating-claims/{id}/accept", method: "post", summary: "Accept a pending officiating invite by id (v11.1 — /me 'Pending invites' card; no token in the URL, the session's verified email proves it; routes through the same accept core as /claim/{token})", tag: "officials", response: S.OfficiatingClaimAccepted, errors: [403, 404, 409] },
  // API keys
  { path: "/orgs/{id}/api-keys", method: "get", summary: "List API keys", tag: "api-keys", response: z.array(S.ApiKey) },
  { path: "/orgs/{id}/api-keys", method: "post", summary: "Create an API key (secret shown once)", tag: "api-keys", request: S.CreateApiKey, response: S.CreatedApiKey, status: 201, errors: [402] },
  { path: "/orgs/{id}/api-keys/{keyId}", method: "delete", summary: "Revoke an API key", tag: "api-keys", response: S.ApiKey },
  // Sponsor CRM (v10 PROMPT-56)
  { path: "/orgs/{id}/sponsors", method: "get", summary: "List sponsors, tier-ranked (title → gold → silver → partner)", tag: "sponsors", response: z.array(S.Sponsor) },
  { path: "/orgs/{id}/sponsors", method: "post", summary: "Create a sponsor (tiers above partner / competition scoping are Pro `sponsors.tiers`)", tag: "sponsors", request: S.CreateSponsor, response: S.Sponsor, status: 201, errors: [402] },
  { path: "/orgs/{id}/sponsors/{sponsorId}", method: "patch", summary: "Update a sponsor (promoting tier / scoping is Pro `sponsors.tiers`)", tag: "sponsors", request: S.PatchSponsor, response: S.Sponsor, errors: [402] },
  { path: "/orgs/{id}/sponsors/{sponsorId}", method: "delete", summary: "Delete a sponsor", tag: "sponsors" },
  { path: "/orgs/{id}/sponsors/reorder", method: "post", summary: "Persist a new display order (ids in render order)", tag: "sponsors", request: S.ReorderSponsors, errors: [422] },
  { path: "/orgs/{id}/sponsor-packages", method: "get", summary: "List sponsorship packages", tag: "sponsors", response: z.array(S.SponsorPackage) },
  { path: "/orgs/{id}/sponsor-packages", method: "post", summary: "Create a priced sponsorship package (Pro `sponsors.monetize`)", tag: "sponsors", request: S.CreateSponsorPackage, response: S.SponsorPackage, status: 201, errors: [402] },
  { path: "/orgs/{id}/sponsor-packages/{packageId}", method: "delete", summary: "Retire a package (soft — orders keep referencing it)", tag: "sponsors", response: S.SponsorPackage },
  { path: "/orgs/{id}/sponsor-orders", method: "get", summary: "List sponsor orders (payment audit trail)", tag: "sponsors", response: z.array(S.SponsorOrder) },
  { path: "/orgs/{id}/sponsor-orders", method: "post", summary: "Start a package checkout — pending order + Connect destination-charge session + invoice email; 409 when the org isn't Connect-onboarded", tag: "sponsors", request: S.StartSponsorCheckout, response: S.SponsorCheckoutStarted, status: 201, errors: [402, 409, 422] },
  { path: "/orgs/{id}/sponsor-orders/{orderId}/refund", method: "post", summary: "Full refund of a paid order — transfer reversed, platform fee returned, placement deactivated", tag: "sponsors", response: S.SponsorOrder, errors: [422] },
  { path: "/orgs/{id}/sponsor-orders/{orderId}/evidence", method: "get", summary: "Dispute evidence pack as a printable HTML attachment — order record, receipt reconstruction, placement delivery proof, activity log (session console, not key-accessible)", tag: "sponsors", errors: [404] },
  // Venues & courts (D5/P8): entities replacing the free-text venue/court_label
  // fields. P9 cutover in progress across several passes — GET/PATCH
  // /fixtures/{id} above already serve court_id/venue_id + derived
  // court_name/venue_name instead (pass 3c-2); court_label/venue are frozen
  // (no longer written) pending a later drop PR.
  { path: "/orgs/{id}/venues", method: "get", summary: "List venues with their courts nested, each court carrying its full weekly-hours/exception calendar — there is no separate GET for a court or its calendar", tag: "venues", response: z.array(S.VenueWithCourts) },
  { path: "/orgs/{id}/venues", method: "post", summary: "Create a venue", tag: "venues", request: S.CreateVenue, response: S.Venue, status: 201 },
  { path: "/orgs/{id}/venues/{venueId}", method: "patch", summary: "Update a venue", tag: "venues", request: S.PatchVenue, response: S.Venue, errors: [404] },
  { path: "/orgs/{id}/venues/{venueId}", method: "delete", summary: "Delete a venue — 409 VENUE_NOT_EMPTY while it still has courts (delete or archive those first, no cascade)", tag: "venues", errors: [404, 409] },
  { path: "/orgs/{id}/venues/{venueId}/archive", method: "post", summary: "Archive a venue — the end state for a permanently-lost venue with fixture history, which a hard delete (blocked by VENUE_NOT_EMPTY while it has courts) can never reach. Idempotent. 409 VENUE_IN_USE while any of its courts is referenced by an UNPLAYED fixture (scheduled/in_play); a venue whose courts carry only completed/finalized/abandoned/forfeited/cancelled fixture history — or no courts at all — archives freely", tag: "venues", response: S.Venue, errors: [404, 409] },
  { path: "/orgs/{id}/venues/{venueId}/archive", method: "delete", summary: "Restore an archived venue. Idempotent. Restores the venue only — its courts keep their own independent archived_at, never cascaded", tag: "venues", response: S.Venue, errors: [404] },
  { path: "/orgs/{id}/venues/{venueId}/courts", method: "post", summary: "Add a court to a venue. Tags are free-form org-scoped slugs (no global registry) — trimmed, lowercased and deduped on write", tag: "venues", request: S.CreateCourt, response: S.Court, status: 201, errors: [404] },
  { path: "/orgs/{id}/courts/{courtId}", method: "patch", summary: "Update a court (name, sort, tags)", tag: "venues", request: S.PatchCourt, response: S.Court, errors: [404] },
  { path: "/orgs/{id}/courts/{courtId}", method: "delete", summary: "Hard-delete a court — only when NO fixture (played or not) references it. 409 COURT_IN_USE otherwise; archive instead if the fixtures are history (`/archive`)", tag: "venues", errors: [404, 409] },
  { path: "/orgs/{id}/courts/{courtId}/archive", method: "post", summary: "Archive a court — the end state for a permanently-lost facility with fixture history, which a hard delete can never reach. Idempotent. 409 COURT_IN_USE while any UNPLAYED fixture (scheduled/in_play) still references it; a court referenced only by completed/finalized/abandoned/forfeited/cancelled fixtures archives freely. Frees the court's name for reuse (partial unique index)", tag: "venues", response: S.Court, errors: [404, 409] },
  { path: "/orgs/{id}/courts/{courtId}/archive", method: "delete", summary: "Restore an archived court. Idempotent. 409 COURT_NAME_TAKEN if another active court in the venue has taken the freed name since", tag: "venues", response: S.Court, errors: [404, 409] },
  { path: "/orgs/{id}/courts/{courtId}/calendar", method: "put", summary: "Replace a court's weekly hours + exceptions in one write — full replace, no per-row PATCH surface. An exception date always wins over that weekday's hours (closed = no windows). 422 COURT_HOURS_OVERLAP when two ranges on the same weekday overlap. Response carries two ADVISORY, non-blocking numbers: `newlyStrandedFixtureCount` — unplayed fixtures THIS write stranded, which is what a client should attribute to the edit — and `strandedFixtureCount`, every unplayed fixture on the court currently outside a usable window, including ones a division session window or blackout stranded independently of this write (the real conflict code is P10's)", tag: "venues", request: S.PutCourtCalendar, response: S.CourtCalendar, errors: [404, 422] },
  // Streaming R1 — destinations (design §6.1), beside the other /orgs/{id}/… rows. Tagged
  // "fixtures" with the relay sessions they feed: there is no "organizations" tag (lane C A11).
  // Never key-reachable (key-scopes.ts).
  { path: "/orgs/{id}/stream-targets", method: "get", summary: "The organisation's streaming destinations (never the stream key). A destination that is a connected YouTube channel carries `youtube` (its connection: channel title, default visibility, made-for-kids, status, live state, whether the consent wording moved on, open broadcasts) and has no `keyHint` or `inUse`; a pasted-key destination has `youtube: null`", tag: "fixtures", response: z.array(S.StreamTarget) },
  { path: "/orgs/{id}/stream-targets", method: "post", summary: "Add a streaming destination (YouTube or Twitch). The ingest URL is filled per platform; the key is sealed at rest (AES-256-GCM). The same key again returns the existing destination UNCHANGED (`outcome: existing` — its name and watch link stand), or restores a removed one under the submitted name and watch link (`outcome: restored`); a new destination is `outcome: inserted`. The preset still passes the destination allowlist, else 422 DESTINATION_NOT_ALLOWED with the refusing `rule`. 422 STREAM_KEY_EMPTY / DESTINATION_LABEL_EMPTY when the key or name is blank once trimmed. 409 when a concurrent save of the same destination won: try again", tag: "fixtures", request: S.CreateStreamTarget, response: S.StreamTargetSaved, status: 201, errors: [403, 409, 422] },
  { path: "/orgs/{id}/stream-targets/{targetId}", method: "patch", summary: "Rename a streaming destination ({label}, allowed while in use) or replace its stream key ({streamKey}; 409 TARGET_IN_USE while a match is live or waiting on it, 409 DESTINATION_DUPLICATE when another destination already holds that key). A key that can no longer be read is recovered in place for YouTube and Twitch; a legacy destination is 422 TARGET_UNREADABLE (remove it; only YouTube and Twitch can be added). 422 STREAM_KEY_EMPTY / DESTINATION_LABEL_EMPTY when the key or name is blank once trimmed, 422 DESTINATION_NOT_ALLOWED when the preset leaves the allowlist, 422 YOUTUBE_USE_DISCONNECT for a destination that is a connected YouTube channel (it has no key and no name of its own: disconnect the channel instead)", tag: "fixtures", request: S.PatchStreamTarget, response: S.StreamTarget, errors: [404, 409, 422] },
  { path: "/orgs/{id}/stream-targets/{targetId}", method: "delete", summary: "Remove a streaming destination — an archive: hidden from every list, history keeps its name, and adding the same key again restores it. 409 TARGET_IN_USE while a match is live or waiting on it; 404 once removed; 422 YOUTUBE_USE_DISCONNECT for a destination that is a connected YouTube channel (disconnect the channel instead)", tag: "fixtures", response: S.StreamTargetRemoved, errors: [404, 409, 422] },
  // YouTube Connect (T8). Never key-reachable (key-scopes.ts NEVER_KEY_ROUTES).
  { path: "/orgs/{id}/youtube-connections", method: "post", summary: "Save the channel picked from a multi-channel Google grant ({pendingId, channelId}): the connection and its destination row. The same channel connected again in this organisation is the existing connection, its token replaced (the response says `existing: true` and the connection keeps its own visibility and made-for-kids settings; `existing: false` is a new connection). 422 YOUTUBE_CHANNEL_NOT_OFFERED when the channel is not one the grant listed; 409 YOUTUBE_OTHER_ORG when the channel is connected to another organisation on Seazn (the grant is not revoked: it is the one that connection uses); 410 YOUTUBE_PENDING_EXPIRED once the 10-minute grant expired; 404 for a grant that is not yours, not this organisation's, or already used", tag: "fixtures", request: S.PickYoutubeChannel, response: S.YoutubeConnectionSaved, status: 201, errors: [403, 409, 410, 422] },
  { path: "/orgs/{id}/youtube-connections/pending/{pendingId}", method: "get", summary: "The channels a pending Google grant offers, for the picker ({channels: [{id, title}]}). Only the person who made the grant, in the organisation it was made for; 404 otherwise, 410 YOUTUBE_PENDING_EXPIRED once it expired", tag: "fixtures", response: S.YoutubePendingChannels, errors: [403, 410] },
  { path: "/orgs/{id}/youtube-connections/{connectionId}", method: "patch", summary: "Change a YouTube connection's default visibility ({privacy}), made-for-kids ({madeForKids}) and/or give the consent on the current wording ({consent: true, consentMinors: true}, 'Review updated terms': both boxes, the terms and YouTube's under-16 rule, and one without the other is 400; it records the caller and the time, and a second press does not replace who consented). At least one field; 404 for a connection that is missing, disconnected or another organisation's", tag: "fixtures", request: S.YoutubeConnectionSettings, response: S.YoutubeConnectionView, errors: [403] },
  { path: "/orgs/{id}/youtube-connections/{connectionId}", method: "delete", summary: "Disconnect a YouTube channel: the grant is revoked at Google (unless another connected channel runs on the same Google account, which is left alone on purpose: `revokeOutcome` is `skipped_shared_account`), the stream keys Seazn made on the channel are deleted at YouTube (one YouTube refuses is tried again once its broadcast has ended, and any other stream on the channel named as Seazn names its keys is deleted too; a club's own keys are never touched), any broadcast that is no longer in use is completed or deleted there, and what Seazn stored from YouTube is purged at once (the broadcast records, the match stream links that pointed at their videos, the saved keys, the channel's id and name); the channel's destination is archived. Videos already on the channel stay there. Available whatever the plan. `keysDeleted` counts the stream keys deleted at YouTube. `keysLeft` counts the Seazn keys still on the channel afterwards (YouTube would not delete them: the person deletes them in YouTube Studio), `0` when none is, and is `null` when Seazn could not read the channel's streams to check. `revokeOutcome` is `revoked` (Google answered the revoke), `skipped_shared_account` (see above) or `not_confirmed` (the revoke was tried and Google or YouTube did not answer, or Seazn's saved token would not open: the person can remove Seazn under their Google account's third-party access). The purge happens in every case. 409 YOUTUBE_IN_USE while a match is using the channel (a broadcast that is live, reserved or bound and whose end is not yet due, which includes the grace after a Stop): nothing changes. 409 YOUTUBE_END_UNKNOWN when Seazn cannot tell whether one is (a broadcast whose recorded times are inconsistent): nothing changes and it is reported to us; retry later. 404 for a connection that is missing, already disconnected or another organisation's", tag: "fixtures", response: S.YoutubeDisconnected, errors: [403, 409] },
  // Public (no auth, cacheable, consent-filtered)
  { path: "/public/orgs/{orgSlug}/live", method: "get", summary: "Public org live status: every competition the org home lists, with its status and how many of its public fixtures are in play — what the org home's status chips poll", tag: "public", public: true, response: S.PublicOrgLive },
  { path: "/public/orgs/{orgSlug}/competitions/{slug}", method: "get", summary: "Public competition: description + divisions", tag: "public", public: true },
  { path: "/public/orgs/{orgSlug}/competitions/{slug}/hub", method: "get", summary: "Public competition hub: matches, tables, leaders, teams, info — the landing page's live document", tag: "public", public: true, response: CompetitionHubDoc },
  { path: "/public/orgs/{orgSlug}/competitions/{slug}/players/{personId}/matches", method: "get", summary: "Public player match lines: one line per started match the player appeared in within the competition, newest first, with their figures, the opponent and the result — the player page's live document. 404 when the competition is private or the player's public page is not shown", tag: "public", public: true, response: PublicPlayerMatches, errors: [404] },
  { path: "/public/orgs/{orgSlug}/competitions/{slug}/divisions/{divisionSlug}/schedule", method: "get", summary: "Public schedule", tag: "public", public: true },
  { path: "/public/orgs/{orgSlug}/competitions/{slug}/divisions/{divisionSlug}/standings", method: "get", summary: "Public standings: every published table of the division, each row as `GET /stages/{id}/standings` serves it (`won_ot`/`won_so`/`lost_ot`/`lost_so` in `metrics`, `tieBreak` with its `note` and `drawnAt`, `level` on a table with no counted fixture, whose rows carry `rank: null`; each table is judged on its own rows)", tag: "public", public: true, response: S.PublicDivisionStandings },
  { path: "/public/orgs/{orgSlug}/competitions/{slug}/divisions/{divisionSlug}/entrants", method: "get", summary: "Public entrants (consent-filtered)", tag: "public", public: true },
  { path: "/public/fixtures/{id}", method: "get", summary: "Public live fixture summary", tag: "public", public: true, response: S.PublicFixtureSummary },
  { path: "/public/fixtures/{id}/realtime-token", method: "get", summary: "Realtime subscriber token (403 unless the org has the realtime entitlement; ?purpose=overlay is also granted when ?key= is the fixture's signed overlay key from the organiser's OBS URL and the org has streaming.overlay)", tag: "public", public: true, query: { purpose: { schema: { type: "string", enum: ["overlay"] } }, key: { schema: { type: "string" } } } },
  { path: "/public/fixtures/{id}/board", method: "get", summary: "An online chess board's view-only state, polled by the public fixture page: whether the fixture's round is open, and the board's public snapshot (status; the position the move ledger stands at, the last move, whose turn, the ply, the clocks as of the last move and whether they run, whether the game is over, and which entrant plays White), or null before the board has one. Never a Lichess id, link or draw offer. 404 for a fixture the public cannot see. Spends the 300-a-minute poll bucket", tag: "public", public: true },
  { path: "/public/fixtures/{id}/overlay", method: "get", summary: "Stream overlay payload: the public live summary, the folded-state clock (football family) and innings numbers (cricket), and the last eight surviving ledger events with consent-resolved person names", tag: "public", public: true },
  { path: "/public/discovery", method: "get", summary: "Discovery directory (doc 15 §4): opted-in public competitions, listed once published (a draft never is), cursor-paginated", tag: "public", public: true, query: { sport: { schema: { type: "string" } }, country: { schema: { type: "string" } }, status: { schema: { type: "string", enum: ["live", "upcoming"] } }, q: { schema: { type: "string" } }, cursor: { schema: { type: "string" } }, limit: { schema: { type: "integer", minimum: 1, maximum: 48 } } } },
  // Registration & entry fees (doc 16 §1.1, PROMPT-20a)
  { path: "/divisions/{id}/registration-settings", method: "get", summary: "Division registration settings (defaults when unset)", tag: "registration", response: S.RegistrationSettings },
  { path: "/divisions/{id}/registration-settings", method: "put", summary: "Upsert registration settings (entry fees are gated by `registration.paid`, free on every plan). A chess division takes individual players only: an entrant_kind other than individual, allow_free_agents, or a free_agent_fee_cents is 422 CHESS_INDIVIDUAL_ONLY", tag: "registration", request: S.PutRegistrationSettings, response: S.RegistrationSettings, errors: [402, 422] },
  { path: "/divisions/{id}/registrations", method: "get", summary: "Organiser registration list (?status=)", tag: "registration", response: z.array(S.RegistrationListEntry), query: { status: { schema: { type: "string", enum: S.RegistrationStatus.options } } } },
  // CSV body shape (RS005 F1 finding 5 — no typed response: text/csv, not
  // JSON): one row per PLAYER, not per registration — an entry with N
  // players repeats its entry columns N times; an entry with none emits one
  // row with blank player columns. Header starts `id,registration_id,...`
  // — both the same value on every row (`id` kept for the pre-RS005-W1a
  // one-row-per-registration contract, `registration_id` is the current
  // name) — and varies by caller role: player dob/gender are editor-only,
  // OMITTED (not blanked) for a viewer session or a read-scope API key.
  { path: "/divisions/{id}/registrations/export", method: "get", summary: "CSV export of registrations; all plans (`exports`). One row per player, `id`+`registration_id` both present (same value); player dob/gender omitted for a viewer/read-scope key", tag: "registration", errors: [402] },
  // RS005 W1b — competition-wide Registrants tab: the same read model
  // (listRegistrations/exportRegistrationsCsv) as the division routes above,
  // scoped to a whole competition with the full RS005 W1a filter set.
  { path: "/competitions/{id}/registrations", method: "get", summary: "Cross-division organiser registration list — the Registrants tab read model (?status=&division_id=&kind=&free_agent=&consent_pending=&q=&sort=)", tag: "registration", response: z.array(S.RegistrationListEntry), query: REGISTRATION_LIST_QUERY },
  { path: "/competitions/{id}/registrations/export", method: "get", summary: "CSV export of a competition's registrations, same filters as the list; all plans (`exports`). Same per-player CSV shape as the division export above", tag: "registration", errors: [402], query: REGISTRATION_LIST_QUERY },
  { path: "/registrations/{id}/confirm", method: "post", summary: "Approve: materialise the entrant (idempotent)", tag: "registration", response: S.Registration, errors: [422] },
  { path: "/registrations/{id}/mark-paid", method: "post", summary: "Record an offline (cash/bank) payment — confirms the entry", tag: "registration", response: S.Registration, errors: [422] },
  { path: "/registrations/{id}/waive", method: "post", summary: "Confirm without payment (fee waived, audited)", tag: "registration", response: S.Registration, errors: [422] },
  // RS005 W1b — manual-approval review (registration-approval.ts). Approve
  // mirrors /confirm's idempotent-materialise shape; reject is terminal.
  { path: "/registrations/{id}/approve", method: "post", summary: "Manual-approval review: pending|paid → confirmed, materialises the entrant (idempotent); refused on an auto-approval division, an already-rejected row, or one already refunded", tag: "registration", response: S.Registration, errors: [422] },
  { path: "/registrations/{id}/reject", method: "post", summary: "Manual-approval review: pending|paid → rejected (terminal); frees the spot (auto-promotes the waitlist) and refunds a paid entry", tag: "registration", response: S.Registration, errors: [422] },
  { path: "/registrations/{id}/waitlist", method: "post", summary: "Move a pending registration to the waitlist", tag: "registration", response: S.Registration, errors: [422] },
  // RS005 W1b — the id's own division promotes oldest-first by default;
  // body.registration_id overrides which waitlisted entry gets promoted.
  { path: "/registrations/{id}/promote", method: "post", summary: "Promote from the waitlist: oldest-first in id's division by default, or an explicit registration_id override", tag: "registration", request: S.PromoteRegistration, response: S.Registration.nullable(), errors: [404, 422] },
  { path: "/registrations/{id}/withdraw", method: "post", summary: "Withdraw: frees the spot, auto-promotes, auto-refunds pre-lock", tag: "registration", response: S.Registration },
  { path: "/registrations/{id}/refund", method: "post", summary: "Manual refund (post-lock discretion; partial allowed; audited)", tag: "registration", request: S.RefundRegistration, response: S.Registration, errors: [422] },
  { path: "/registrations/{id}/remind", method: "post", summary: "Email an unpaid registrant a payment reminder (offline pay)", tag: "registration", response: z.object({ sent: z.boolean() }), errors: [422] },
  // RS005 W4 — the confirmation mailer had zero callers before this wave; this
  // is the organiser-facing resend of the cart-shaped confirmation the
  // public register route now queues at submit. Each resend writes a
  // `registration_confirmation` row on the email outbox (ref
  // `registration_group/<group id>`), which supersedes an older one still
  // waiting; `sent` is whether the first attempt at it was accepted — false
  // while the outbox is retrying, not that the mail is lost.
  { path: "/registrations/{id}/resend-confirmation", method: "post", summary: "Resend the registrant's confirmation email — the whole cart, not just this entry", tag: "registration", response: z.object({ sent: z.boolean() }) },
  // RS009 — the organiser's solo sign-up assignment loop. The three routes
  // were written without entries here and the openapi drift gate stayed
  // GREEN, because that gate compares the generated spec against this
  // registry: a route absent from BOTH is not drift, it is simply
  // undocumented. Every one of the sixteen sibling registration routes was
  // listed; these three were not.
  { path: "/registrations/{id}/assign", method: "post", summary: "Place a pooled solo sign-up onto a team entry in the same division — idempotent; refuses a full roster, a cross-division target, and a placement that would close a mixed team on one gender", tag: "registration", request: S.AssignSoloSignUp, response: S.AssignSoloSignUpResult, errors: [404, 409, 422] },
  { path: "/registrations/{id}/unassign", method: "post", summary: "Return a placed solo sign-up to the pool — idempotent; refused once the division has fixtures or its competition has started", tag: "registration", response: S.UnassignSoloSignUpResult, errors: [404, 422] },
  { path: "/registrations/{id}/assign-targets", method: "get", summary: "Team entries a solo sign-up may be placed on, with roster fill and composition context. Write scope, not read: this list exists only to feed a write action, and READ_ROLES includes viewer", tag: "registration", response: S.AssignTargets, errors: [404] },
  { path: "/registrations/{id}/evidence", method: "get", summary: "Dispute evidence pack as a printable HTML attachment — registration record, receipt reconstruction, activity log, fixtures (session console, not key-accessible)", tag: "registration", errors: [404] },
  { path: "/orgs/{id}/connect", method: "get", summary: "Stripe Connect status (?refresh=1 re-reads from Stripe)", tag: "registration", response: S.ConnectStatus, query: { refresh: { schema: { type: "string", enum: ["1"] } } } },
  { path: "/orgs/{id}/connect", method: "post", summary: "Create the connected account (Express Dashboard) + onboarding link (`registration.paid`, free on every plan)", tag: "registration", request: S.CreateConnectOnboarding, response: S.ConnectOnboardingLink, errors: [402] },
  { path: "/orgs/{id}/connect/dashboard", method: "post", summary: "Mint a one-time Stripe Express Dashboard login link (owner)", tag: "registration", response: S.ConnectOnboardingLink, errors: [409] },
  { path: "/public/orgs/{orgSlug}/competitions/{slug}/registration", method: "get", summary: "Public register panel: open divisions, fees, remaining capacity", tag: "public", public: true, response: S.PublicRegistrationInfo },
  // POST .../register (old single-entry submit) deleted in the RS001
  // registration demolition — RS003 W2 defines its group-shaped replacement
  // below, plus the new join-by-code endpoint. `checkout_url` carries a real
  // Stripe URL whenever the cart has a payable subtotal, and is null for an
  // all-free/all-waitlisted/offline cart OR when minting failed (the route
  // returns 201 regardless, so a committed cart is never reported as a failed
  // registration — see the route's own doc comment).
  // 400 is the honeypot's generic rejection; there is no 402 on this path.
  { path: "/public/orgs/{orgSlug}/competitions/{slug}/register", method: "post", summary: "Public group registration submit: a club rep's whole cart (one or more entries) in one transaction — capacity, eligibility, waitlist and payment-method coherence enforced; checkout_url is a Stripe URL when the cart has a payable subtotal, otherwise null", tag: "public", public: true, request: S.PublicRegisterGroupRequest, response: S.PublicRegisterGroupResponse, status: 201, errors: [400, 404, 422, 429, 503] },
  { path: "/public/orgs/{orgSlug}/competitions/{slug}/register/join", method: "get", summary: "Preview a join link before claiming — entry/division/competition/org context, unclaimed slots, whether a new person may be added", tag: "public", public: true, query: { join_code: { schema: { type: "string" } } }, response: S.PublicJoinPreviewResponse, errors: [404, 429] },
  { path: "/public/orgs/{orgSlug}/competitions/{slug}/register/join", method: "post", summary: "Join an existing team or pair entry via its join_code link — claims an existing captain-entered slot (player_id given) or inserts a genuinely new player (refused for a pair); squad-cap and eligibility enforced", tag: "public", public: true, request: S.PublicJoinRequest, response: S.PublicJoinResponse, status: 201, errors: [404, 409, 422, 429] },
  { path: "/public/registrations/{id}", method: "get", summary: "Registrant status view (?token=; ?reconcile=1 after checkout)", tag: "public", public: true, response: S.PublicRegistrationStatus, errors: [401] },
  { path: "/public/registrations/{id}/withdraw", method: "post", summary: "Registrant self-withdraw (token)", tag: "public", public: true, request: S.PublicRegistrationToken, response: S.PublicRegistrationStatus },
  { path: "/public/registrations/{id}/checkout", method: "post", summary: "(Re)open Stripe Checkout for a pending paid registration", tag: "public", public: true, request: S.PublicRegistrationToken, errors: [422, 503] },
  { path: "/public/registrations/{id}/ics", method: "get", summary: "Confirmation .ics for the competition dates (?token=)", tag: "public", public: true, errors: [401] },
  { path: "/public/registrations/by-ref/{ref}/withdraw", method: "post", summary: "Self-withdraw via reference number — the ref locates, the email token authorises (v3/05 §3)", tag: "public", public: true, request: S.PublicRegistrationToken, errors: [404] },
  { path: "/public/registrations/groups/{id}/resend", method: "post", summary: "Registrant self-service resend of the cart-shaped confirmation email (token) — refused only once every entry in the cart is terminal", tag: "public", public: true, request: S.PublicRegistrationToken, response: z.object({ sent: z.boolean() }), errors: [404, 422] },
  // Clubs & bulk import (Jul3/01, PROMPT-21)
  { path: "/clubs", method: "get", summary: "List clubs", tag: "clubs", response: z.array(S.Club) },
  { path: "/clubs", method: "post", summary: "Create a club (all plans; capped by `clubs.max`)", tag: "clubs", request: S.CreateClub, response: S.Club, status: 201, errors: [402, 409] },
  { path: "/clubs/{id}", method: "get", summary: "Club detail: teams across divisions", tag: "clubs", response: S.ClubDetail },
  { path: "/clubs/{id}", method: "patch", summary: "Update a club", tag: "clubs", request: S.PatchClub, response: S.Club, errors: [402] },
  { path: "/clubs/{id}", method: "delete", summary: "Delete a club (teams survive, badges fall back)", tag: "clubs", errors: [402] },
  { path: "/clubs/{id}/contacts", method: "get", summary: "List a club's FA officers (W1 §4.2)", tag: "clubs", response: z.array(S.ClubContact), errors: [404] },
  { path: "/clubs/{id}/contacts", method: "post", summary: "Add a club contact (single-primary enforced per club)", tag: "clubs", request: S.CreateClubContact, response: S.ClubContact, status: 201, errors: [404] },
  { path: "/clubs/{id}/contacts/{contactId}", method: "patch", summary: "Edit a club contact", tag: "clubs", request: S.PatchClubContact, response: S.ClubContact, errors: [404] },
  { path: "/clubs/{id}/contacts/{contactId}", method: "delete", summary: "Remove a club contact", tag: "clubs", response: z.object({ deleted: z.boolean() }), errors: [404] },
  // Teams (Pro clubs.hierarchy) — parent-club teams and their persistent squads.
  { path: "/clubs/{id}/teams", method: "post", summary: "Add a team under a club (all plans; capped by `teams.max`)", tag: "clubs", request: S.CreateTeam, status: 201, errors: [402, 404, 409] },
  { path: "/teams", method: "get", summary: "List teams with their division entries", tag: "clubs" },
  { path: "/teams", method: "post", summary: "Create a team, optionally under a club (all plans; capped by `teams.max`)", tag: "clubs", request: S.CreateTeamStandalone, status: 201, errors: [402, 404] },
  { path: "/teams/{id}", method: "patch", summary: "Move a team into a club or detach it (`club_id: null`) — all plans", tag: "clubs", request: S.PatchTeam, errors: [402, 404] },
  { path: "/teams/{id}/squad", method: "get", summary: "Get a team's persistent squad", tag: "clubs", errors: [404] },
  { path: "/teams/{id}/squad", method: "put", summary: "Replace a team's squad (auto-seeds entrant rosters on enrollment)", tag: "clubs", request: S.SetTeamSquad, errors: [402, 404] },
  { path: "/teams/{id}/logo", method: "post", summary: "Set a team badge: multipart `file` (v3/03 §5; overrides the club badge for this team)", tag: "clubs", errors: [404, 422] },
  { path: "/teams/{id}/logo", method: "delete", summary: "Clear a team badge (falls back to the club badge)", tag: "clubs", errors: [404] },
  { path: "/clubs/logos", method: "post", summary: "Bulk logo assign: multipart `files` + `mapping` JSON + `assign_remaining` (Jul3/01 §5; Pro `logos.bulk` for >1 file)", tag: "clubs", response: z.array(S.LogoAssignment), errors: [402, 422] },
  { path: "/imports", method: "post", summary: "Upload a participants spreadsheet (multipart `file`) → dry-run { importId, plan }; writes nothing (Jul3/01 §6)", tag: "clubs", response: S.ImportPreview, status: 201, errors: [402, 413, 422] },
  { path: "/imports/{id}", method: "get", summary: "Re-preview a stored import against current state", tag: "clubs", response: S.ImportPreview },
  { path: "/imports/{id}/commit", method: "post", summary: "Execute the plan in one transaction (Idempotency-Key header). A plan that enters a team into a chess division is refused 422 CHESS_INDIVIDUAL_ONLY, with `rows` naming the file rows, and nothing is written", tag: "clubs", request: S.ImportCommitRequest, response: S.ImportCommitResult, status: 201, errors: [402, 422] },
  { path: "/participants/export", method: "get", summary: "Participants CSV/XLSX: club + division columns, empty-spot rows intact; all plans (`exports`)", tag: "clubs", errors: [402], query: { format: { schema: { type: "string", enum: ["csv", "xlsx"] } }, club_id: { schema: { type: "string" } }, division_id: { schema: { type: "string" } } } },
  // Referee & officials assignment (Jul3/02, PROMPT-22)
  { path: "/officials", method: "get", summary: "List officials (people or team-as-referee entrants)", tag: "officials", response: z.array(S.Official) },
  { path: "/officials", method: "post", summary: "Create an official (multi-role on all plans)", tag: "officials", request: S.CreateOfficial, response: S.Official, status: 201, errors: [402] },
  { path: "/officials/{id}", method: "get", summary: "Get an official", tag: "officials", response: S.Official },
  { path: "/officials/{id}", method: "patch", summary: "Update an official", tag: "officials", request: S.PatchOfficial, response: S.Official, errors: [402] },
  { path: "/officials/{id}", method: "delete", summary: "Delete an official", tag: "officials" },
  { path: "/officials/{id}/availability", method: "get", summary: "List this official's blackout dates (G9 — G2 shipped the write with no read)", tag: "officials", response: z.array(S.OfficiatingBlackout) },
  { path: "/officials/{id}/availability", method: "post", summary: "Record a blackout date for this org's officials row (G2 — organiser-side counterpart to POST /me/availability/officiating, which is self-service only and fans out across every org linked to the official)", tag: "officials", request: S.OfficiatingBlackoutInput, response: S.OfficiatingBlackout, status: 201 },
  { path: "/officials/{id}/availability", method: "delete", summary: "Clear a blackout date (idempotent)", tag: "officials", query: { date: { schema: { type: "string", format: "date" }, description: "The date to clear (YYYY-MM-DD)" } } },
  { path: "/officials/import", method: "post", summary: "Bulk CSV/XLSX import (multipart `file`: Name, Roles, MaxPerDay). Subject to the same per-FILE row cap as POST /imports (`import.bulk`): over it, 402 quoting the cap that refused the file", tag: "officials", status: 201, errors: [402, 422] },
  { path: "/officials/{id}/invite", method: "post", summary: "Invite the official to claim their profile through the shared person-claim rail (session editors only; claim_url embeds the one-time secret)", tag: "officials", request: S.CreateClaimInvite, response: S.CreatedPersonClaim, status: 201, errors: [409] },
  { path: "/divisions/{id}/officials/auto", method: "post", summary: "Propose assignments — pure engine pass with locked rows as obstacles; writes nothing (Pro `officials.auto`)", tag: "officials", request: S.AutoAssignOfficials, response: S.OfficialsProposal, errors: [402] },
  { path: "/divisions/{id}/officials/ai-plan", method: "post", summary: "AI Officials Architect: assign officials to a dry-run/current schedule, engine-refereed; propose-only, empty instruction = solver draft (credit-metered on any tier, 1 credit/run — 402 `ai.credits` when the wallet is empty)", tag: "officials", request: S.AiOfficialsPlanRequest, response: S.AiOfficialsPlanResponse, errors: [402, 403, 422, 429] },
  { path: "/divisions/{id}/officials/apply", method: "post", summary: "Persist a proposal transactionally; emits `officials_assigned` (Pro `officials.auto`)", tag: "officials", request: S.ApplyOfficials, errors: [402, 422] },
  { path: "/fixtures/{id}/officials", method: "patch", summary: "Manual set/move/lock — single-role manual assignment free on every plan", tag: "officials", request: S.PatchFixtureOfficials, errors: [402] },
  { path: "/stages/{id}/officials/source", method: "post", summary: "Resolve rank/result sourcing → officiating entrants; pending until the source decides (Pro `officials.auto`)", tag: "officials", request: S.SourceOfficials, errors: [402] },
  // Schedule undo, versioning & safe destructive ops (Jul3/03, PROMPT-23)
  { path: "/divisions/{id}/undo", method: "post", summary: "Undo the last structural edit: appends the inverse event, moves the watermark (results-guarded)", tag: "history", request: S.HistoryStep, errors: [409, 422] },
  { path: "/divisions/{id}/redo", method: "post", summary: "Redo the next edit (Word-like linear history)", tag: "history", request: S.HistoryStep, errors: [409, 422] },
  { path: "/divisions/{id}/history", method: "get", summary: "Ledger slice: type, actor, time, undoable/undone", tag: "history" },
  { path: "/divisions/{id}/checkpoints", method: "get", summary: "Named save points", tag: "history" },
  { path: "/divisions/{id}/checkpoints", method: "post", summary: "Create a save point at the current watermark (quota `schedule.checkpoints.max`: 2 free / 10 Pro; at the cap the oldest save point is replaced)", tag: "history", request: S.CreateCheckpoint, status: 201, errors: [402] },
  { path: "/divisions/{id}/checkpoints/{checkpointId}", method: "delete", summary: "Delete a save point — frees a quota slot when the save point is manual", tag: "history", errors: [404] },
  { path: "/divisions/{id}/restore", method: "post", summary: "Undo back to a checkpoint (confirm: true; results-guarded)", tag: "history", request: S.RestoreCheckpoint, errors: [422] },
  { path: "/divisions/{id}/locks", method: "patch", summary: "Whole-division freeze + multi-site scope locks (scopes are Pro)", tag: "history", request: S.DivisionLocks, errors: [402] },
  { path: "/schedule/clear", method: "post", summary: "Scoped clear (stage/pools/rounds/courts; confirm: true; locked + decided survive; undoable)", tag: "history", request: S.ClearSchedule, errors: [422] },
  { path: "/pools/{id}/clear-entrants", method: "post", summary: "Remove all teams in a pool, keep the pool (confirm: true; blocked once decided; undoable)", tag: "history", request: S.ClearPoolEntrants, errors: [422] },
  // Scheduling constraints v2 & AI (Jul3/04, PROMPT-24)
  { path: "/schedule/shift", method: "post", summary: "Bulk time shift: push everything in scope by ±N minutes (schedule_shifted event; undoable; all plans)", tag: "scheduling", request: S.ScheduleShift, errors: [422] },
  { path: "/divisions/{id}/schedule/report", method: "get", summary: "Wait-time diagnostics: min/max gap per entrant + worst waits (16 Sep; all plans)", tag: "scheduling" },
  { path: "/divisions/{id}/schedule/ai-plan", method: "post", summary: "AI Schedule Architect: propose times+courts (generate/refine/repair), engine-verified; propose-only; all plans (`scheduling.ai`), metered by the AI credit wallet (402 when it's empty)", tag: "scheduling", request: S.AiPlanRequest, response: S.AiPlanResponse, errors: [400, 402, 403, 409, 422, 429] },
  // W5 (#400) — the parse-only preview that precedes either run. Registered
  // beside the run it gates, not in a section of its own: the two are one flow.
  { path: "/divisions/{id}/schedule/ai-preview", method: "post", summary: "Compile the instruction and show what it means, WITHOUT spending a credit or calling the architect: returns the enforced constraints, the soft preferences, the wording that could not be compiled (verbatim), the resolver's assumptions and the resolved window, plus a `preview_id` the run reuses so the compile the organiser confirmed is the compile that executes. Declining costs nothing. Consumes the run's own rate-limit budget (5/division/hour) because it IS the pre-flight LLM call. A wallet that cannot afford the run this precedes is refused 402 `ai.credits` BEFORE any model call. A compile that fails schema twice is a 200 with `failed: true` and no `preview_id` — a state to render, not an error. Needs `scheduling.ai`", tag: "scheduling", request: S.AiParsePreviewRequest, response: S.AiParsePreviewResponse, errors: [402, 403, 404, 409, 429] },
  { path: "/competitions/{id}/schedule/ai-preview", method: "post", summary: "Joint twin of the division preview (#400). `division_ids` is required: the resolved window depends on which divisions are in scope, so a preview compiled against a different set is a preview of a different run. Fewer than two solvable divisions -> 400 `AI_PLAN_SINGLE_DIVISION`. Consumes the joint run's rate-limit budget (3/competition/hour). Needs `scheduling.ai` + `scheduling.multi_division`", tag: "scheduling", request: S.AiParsePreviewRequest, response: S.AiParsePreviewResponse, errors: [400, 402, 403, 404, 409, 429] },
  { path: "/divisions/{id}/schedule/ai-last", method: "get", summary: "Recall the division's most recent AI-sourced schedule apply (instruction + summary + timestamp), or null; all plans", tag: "scheduling", response: S.AiLastResult },
  // Multi-division joint AI scheduling (#350) — one model call over >= 2
  // divisions of one competition, priced as a batch.
  { path: "/competitions/{id}/schedule/ai-plan", method: "post", summary: "Joint AI Schedule Architect: plan 2-20 divisions of one competition in ONE engine-verified run, so cross-division court and player clashes are solved rather than discovered later. Propose-only. Needs `scheduling.ai` + `scheduling.multi_division` (both free on every plan), metered by the AI credit wallet at max(1, sum of per-division rungs - 1) credits (402 when empty). Fewer than two solvable divisions -> 400 `AI_PLAN_SINGLE_DIVISION`; more than 500 movable fixtures in total -> 409 `AI_PLAN_TOO_LARGE`; a division with no courts or unusable settings -> 422 `AI_PLAN_DIVISION_UNPLANNABLE`; any kept division arithmetically unable to fit its courts/dates/rest rules (D2 pre-check, before the wallet is touched) -> 422 `CAPACITY_IMPOSSIBLE` naming every impossible division; a division emptied mid-run -> retryable 409 `AI_PLAN_SCOPE_CHANGED`. 3 runs/hour per competition", tag: "scheduling", request: S.AiCompetitionPlanRequest, response: S.AiCompetitionPlanResponse, errors: [400, 402, 403, 404, 409, 422, 429, 503] },
  { path: "/competitions/{id}/schedule/ai-last", method: "get", summary: "Recall the competition's most recent AI-sourced JOINT schedule apply (instruction + summary + timestamp), or null, plus how many joint runs the competition has had. The joint twin of the division endpoint: an AI plan is propose-only, so only an APPLIED plan is recalled; all plans", tag: "scheduling", response: S.AiCompetitionLastResult },
  { path: "/competitions/{id}/schedule/apply", method: "post", summary: "Apply a joint plan across several divisions ATOMICALLY: ONE transaction writes every listed division's board or none of it, so a failure part-way through can never leave half a schedule written (the per-stage apply, called in a loop, can). Every division's advisory lock is taken in a fixed order, every `expected_seq` is checked (a stale one on any division -> 409 `SEQ_CONFLICT` and nothing is written), and the MERGED board is verified so a cross-division court clash is a 409 `SCHEDULE_CONFLICT` rather than a silent double-book. Non-blocking warnings (rest, blackout, session window, start window, person overlap) come back in full — except that a division whose `constraints.crossPersonClash` is `hard` blocks on its own person overlaps, exactly as the per-stage apply does. A locked division or a fixture that is not in the division it was listed under -> 422; more than 500 assignments in one call -> 409 `SCHEDULE_APPLY_TOO_LARGE`. Needs `scheduling.multi_division` (free on every plan): the request carries client-supplied assignments, so this is a multi-division bulk write in its own right, not merely the tail of a paid plan run. Free otherwise — the plan run was already charged", tag: "scheduling", request: S.ApplyCompetitionScheduleRequest, response: S.ApplyCompetitionScheduleResult, errors: [400, 402, 403, 404, 409, 422] },
  { path: "/competitions/{id}/schedule/publish", method: "post", summary: "Publish every division of the competition whose schedule is still unreleased (`status = 'setup'` — the status `public_fixtures_v` redacts times, venue, court, officials and stream link for). The competition-wide twin of /divisions/{id}/publish-schedule, running that endpoint's gate per division, so the refusal codes are identical. BEST EFFORT, unlike the joint apply: publishing a division touches nothing another division shares, so a board the gate refuses does NOT withhold the clean ones — the response reports every candidate division with `published` true or a `refusal` carrying its full conflict list. ONE `acknowledge_warnings` covers the whole competition: `blocking: false` refusals (`PUBLISH_UNACKNOWLEDGED`) clear on a second call with the flag, `blocking: true` ones (`PUBLISH_BLOCKED`) never do. A division at any other status is not a candidate and appears nowhere in `results`. Free on every plan — it is a convenience over N single-division publishes the organiser can already make", tag: "scheduling", request: S.PublishCompetitionScheduleRequest, response: S.PublishCompetitionScheduleResult, errors: [402, 403, 404] },
  { path: "/competitions/{id}/schedule/health", method: "get", summary: "Schedule health score (D3), joint variant: every division's stages assessed via the SAME per-stage computation the single-stage route uses, reported per division (a stage with no applied schedule yet is `{stageId, status:\"empty\"}`, never an aborted call), plus a COMBINED block (gapDispersion + primeSlotFairness only, over the union of every ready stage's fixtures across divisions — the two metrics that key off shared court-day resources rather than a single division's own entrant pool). Report-only; blocks nothing", tag: "scheduling", response: S.CompetitionScheduleHealthReport },
  { path: "/competitions/{id}/schedule/restore", method: "post", summary: "Undo one joint apply — restores every division that apply wrote (confirm: true). The body carries the per-division checkpoint anchors, since the apply event records only `division_ids`, and the division set must EXACTLY equal that list: a subset is a 422, not a partial restore. NOT one transaction — each division rewinds through its own single-writer appends, exactly as the per-division restore does — so a division that refuses is REPORTED in `failed` while the rest still restore, and `ok` is false. The newest apply event is read once as an ANCHOR and re-read before each division, so a joint apply that lands mid-rewind is DETECTED rather than overwritten: the loop stops there, every division it did not reach comes back in `failed` saying a newer apply superseded the undo, the divisions already rewound keep their real `steps` in `restored`, and `ok` is false. Nothing here waits on a lock, so there is no 409 — a second undo of the same apply is idempotent (it rewinds 0 steps), and the console disables its own undo button while one is running. No joint apply on the competition -> 404", tag: "history", request: S.RestoreCompetitionScheduleRequest, response: S.RestoreCompetitionScheduleResult, errors: [404, 422] },
  // Custom points & rank control (Jul3/05, PROMPT-25)
  { path: "/stages/{id}/standings/override", method: "post", summary: "Pin final ranks (placement games decide 3rd/4th); cascade orders the unlocked remainder; audited rank_overridden; free on every plan (`tiebreakers.custom`)", tag: "stages", request: S.OverrideStandings, errors: [402, 422] },
  // Rich exports & print templates (Jul3/06, PROMPT-26)
  { path: "/divisions/{id}/exports/{kind}", method: "get", summary: "Templated export (timetable|standings|roster|participants|scoresheet|officials_rota) as PDF/XLSX; export itself is on every plan (`exports`); page-break + landscape knobs free, branding needs `exports.branded` (Event Pass or Pro)", tag: "exports", errors: [402, 404], query: { format: { schema: { type: "string", enum: ["pdf", "xlsx"] } }, pageBreaks: { schema: { type: "string", enum: ["auto", "per_pitch", "per_team", "per_division"] } }, landscape: { schema: { type: "string", enum: ["true"] } }, blank: { schema: { type: "string", enum: ["true"] } } } },
  { path: "/competitions/{id}/exports/timetable", method: "get", summary: "Competition-wide pretty timetable PDF, one division per page; all plans (`exports`)", tag: "exports", errors: [402], query: { pretty: { schema: { type: "string", enum: ["true"] } } } },
  // Matchday documents (v12/Task 14): officials rota kind above; admit tickets + the caller's own cross-org rota below.
  { path: "/competitions/{id}/exports/tickets", method: "get", summary: "2-up admit tickets (PDF only) for every confirmed registration, name-masked, QR carries the /r/{ref} URL; all plans (`exports`)", tag: "exports", errors: [400, 402, 422], query: { format: { schema: { type: "string", enum: ["pdf"] } } } },
  // Scorer sheets (§4.4): POST because printing ENSURES device links; the PDF is live credentials (private, no-store).
  { path: "/competitions/{id}/exports/scorer-sheets", method: "post", summary: "Printable scorer sheets PDF for one day (application/pdf attachment, `private, no-store`): per court, a 3×3 grid of cut-out cards, one QR per match, each its fixture's live device link (re-shown, never rotated). Session editors only (`scoring.device_links`). 422 NO_FIXTURES_ON_DAY when nothing prints; 500 SHEET_LINKS_INCOMPLETE when any card's link cannot be proven — never a partial sheet", tag: "exports", request: S.ScorerSheetsRequest, errors: [400, 402, 403, 422, 429, 500] },
  { path: "/me/rota.pdf", method: "get", summary: "The caller's own officiating rota PDF across every organisation — free, session-only, no org tenant", tag: "officials" },
  // Player statistics (Jul3/07, PROMPT-27)
  { path: "/divisions/{id}/stats/players", method: "get", summary: "Division leaderboard from the score-event fold, sortable by any declared metric; flags requires_detailed_scoring instead of wrong zeros (`stats.player`, free on every plan since W3-A — an org may switch it off via an entitlement override)", tag: "stats", errors: [402], query: { metric: { schema: { type: "string" } }, sort: { schema: { type: "string", enum: ["asc", "desc"] } } } },
  { path: "/persons/{id}/stats", method: "get", summary: "A player's card stats, keyed per division (`stats.player`, free on every plan since W3-A). `?group=sport` returns the S9/#418 career rollup instead, still Pro + Event Pass on its own key `stats.player.career`: every sport this person has snapshot rows in, summed across divisions and labelled via the sport's latest registered module; any other (or absent) `group` value keeps the per-division shape unchanged", tag: "stats", errors: [402], query: { division_id: { schema: { type: "string", format: "uuid" } }, group: { schema: { type: "string", enum: ["sport"] } } } },
  { path: "/public/orgs/{orgSlug}/competitions/{slug}/divisions/{divisionSlug}/stats", method: "get", summary: "Consent-filtered public leaderboard (minors' names gated); `stats.player`, same key and default as the org's own read since W3-A", tag: "public", public: true },
  // Format engine extensions (Jul3/08, PROMPT-28)
  { path: "/stages/{id}/challenges", method: "post", summary: "Ladder challenge: creates the fixture on demand; result reorders the ladder (Pro `formats.advanced`). 422 LADDER_ENTRANT_WITHDRAWN when either side has withdrawn or been disqualified — `config.ladder_order` keeps her rung (a withdrawal is a status flip, and she can be un-withdrawn), so presence in that array is not eligibility", tag: "stages", request: S.LadderChallenge, status: 201, errors: [402, 422] },
  { path: "/stages/{id}/fixtures", method: "post", summary: "Ad-hoc single fixture (replay / friendly / tie-breaker) on a league or group stage; the match folds into the standings. Bracket kinds 422. A Swiss stage 422 SWISS_ADHOC_REFUSED: the system pairs Swiss rounds, so friendlies go in another stage (W3 RB3-15)", tag: "stages", request: S.AddFixture, status: 201, errors: [422] },
  { path: "/stages/{id}/americano", method: "get", summary: "Americano rotation grid + personal-points leaderboard (Jul3/08 §3)", tag: "stages", errors: [422] },
  // Discipline & suspensions (SPEC-1, PROMPT-78)
  { path: "/divisions/{id}/discipline-rules", method: "get", summary: "Discipline rules + enabled flag (null when the sport has no card model); Pro `discipline.enforced`", tag: "discipline", response: S.DisciplineRulesResponse, errors: [402] },
  { path: "/divisions/{id}/discipline-rules", method: "put", summary: "Upsert discipline rules; colours validated against the sport module", tag: "discipline", request: S.PutDisciplineRules, response: S.DisciplineRulesResponse, errors: [402, 422] },
  { path: "/divisions/{id}/suspensions", method: "get", summary: "List suspensions in the division, optional ?status= filter", tag: "discipline", response: z.array(S.Suspension), errors: [402], query: { status: { schema: { type: "string", enum: S.SuspensionStatus.options } } } },
  { path: "/divisions/{id}/suspensions", method: "post", summary: "Record a manual suspension (pending until confirmed)", tag: "discipline", request: S.CreateSuspension, response: S.Suspension, status: 201, errors: [402] },
  { path: "/suspensions/{id}", method: "patch", summary: "Confirm (→ active), waive or adjust a suspension. Confirming one for a player on no entrant in the division → 422 SUSPENSION_NO_ENTRANT (it could never be served): add them to an entrant first, or waive it", tag: "discipline", request: S.DecideSuspension, response: S.Suspension, errors: [402, 422] },
  // Official marks & match reports (SPEC-3, PROMPT-80)
  { path: "/fixture-officials/{id}/mark", method: "put", summary: "Rate an accepted, decided assignment 1..5 with an optional comment (console, all plans); upsert, one per assignment; 403 outside the window", tag: "officials", request: S.PutMarkBody, status: 204, errors: [402, 403] },
  { path: "/fixture-officials/{id}/mark", method: "delete", summary: "Clear the mark on an assignment (idempotent; all plans)", tag: "officials", status: 204, errors: [402] },
  { path: "/officials/{id}/marks-summary", method: "get", summary: "Org-scoped mark average, count and last 5 comments for an official (console, all plans)", tag: "officials", response: S.MarkSummary, errors: [402] },
  { path: "/me/officiating/{fixtureOfficialId}/report", method: "get", summary: "The caller's match report draft/submitted for one of their accepted assignments (session only, cross-org rail); null when none filed yet", tag: "officials", response: S.MatchReport.nullable(), errors: [403] },
  { path: "/me/officiating/{fixtureOfficialId}/report", method: "put", summary: "Save the match report draft body + incident rows (session only; free); draft only — a submitted report is immutable (409); 403 outside the window", tag: "officials", request: S.PutReportBody, response: S.MatchReport, errors: [403, 409] },
  { path: "/me/officiating/{fixtureOfficialId}/report/submit", method: "post", summary: "Submit the draft (immutable thereafter, 409 on resubmit); misconduct incidents suggest pending suspensions when the org enforces discipline (session only)", tag: "officials", response: S.MatchReport, errors: [403, 409] },
  { path: "/fixtures/{id}/reports", method: "get", summary: "Submitted match reports for a fixture with the official's name (console; free)", tag: "officials", response: z.array(S.FixtureReport) },
  { path: "/me/officiating/{fixtureOfficialId}/squad", method: "get", summary: "Both entrants' squads behind the caller's assignment — the match report's optional person picker (session only, cross-org rail; free)", tag: "officials", response: z.array(S.FixtureSquadMember), errors: [404] },
  // Org news (SPEC-2, PROMPT-82) — manual posts free on every plan; the
  // decided-seam result/round_recap auto-drafts land on the score write, not
  // through the API. The weekly digest (P3/D7) IS reachable through the API
  // (console button + stg cron) — same news.auto entitlement.
  { path: "/orgs/{id}/posts", method: "get", summary: "Org news feed (console; free), optional ?status= filter", tag: "news", response: z.array(S.OrgPost), query: { status: { schema: { type: "string", enum: S.PostStatus.options } } } },
  { path: "/orgs/{id}/posts", method: "post", summary: "Compose a post (draft; free on every plan)", tag: "news", request: S.CreatePost, response: S.OrgPost, status: 201, errors: [404] },
  { path: "/orgs/{id}/posts/digest", method: "post", summary: "Generate a weekly digest draft (standings movement, stat leaders, next 7 days, claimed-player highlight); Pro news.auto", tag: "news", response: S.OrgPost, status: 201, errors: [402, 404] },
  { path: "/posts/{id}", method: "get", summary: "Get a post (console; free)", tag: "news", response: S.OrgPost, errors: [404] },
  { path: "/posts/{id}", method: "patch", summary: "Edit a post and/or publish|archive; publish stamps published_at and freezes the slug", tag: "news", request: S.PatchPost, response: S.OrgPost, errors: [404] },
  { path: "/posts/{id}", method: "delete", summary: "Delete a post", tag: "news", status: 204, errors: [404] },
];

// ---------------------------------------------------------------------------
// Document assembly
// ---------------------------------------------------------------------------

function toSchema(schema: ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { target: "draft-2020-12", io: "output" }) as Record<
    string,
    unknown
  >;
  delete json.$schema;
  return json;
}

function envelope(data?: ZodType): Record<string, unknown> {
  return {
    type: "object",
    required: ["ok", "data", "requestId"],
    properties: {
      ok: { const: true },
      data: data ? toSchema(data) : {},
      requestId: { type: "string", format: "uuid" },
    },
  };
}

// Shared by ERROR_ENVELOPE (below) and CAPACITY_ERROR_ENVELOPE (further
// down): every property a refusal MIGHT carry, regardless of which route
// threw it. Kept small on purpose — this is the base every response x
// status in the whole API is built from (`operation()`'s `responses[...]`
// loop inlines it verbatim, not by $ref), so anything added here is added
// EVERYWHERE. A route-specific extra (like the capacity precheck's report)
// belongs on a SCOPED variant instead — see the P1 review finding this
// comment exists because of: `capacity_report` landed here first and
// roughly doubled both openapi/v1*.json (776 inlined copies, one per
// route x error status in the entire API, not just the two guarded routes).
const BASE_ERROR_PROPERTIES = {
  code: { type: "string" },
  message: { type: "string" },
  current_seq: { type: "integer", description: "On SEQ_CONFLICT (409): the ledger tip to resync from" },
} as const;

const ERROR_ENVELOPE = {
  type: "object",
  required: ["ok", "error", "requestId"],
  properties: {
    ok: { const: false },
    error: {
      type: "object",
      required: ["code", "message"],
      properties: BASE_ERROR_PROPERTIES,
      additionalProperties: true,
    },
    requestId: { type: "string", format: "uuid" },
  },
} as const;

// SCOPED to the capacity-guarded routes' 422 only (ERROR_SCHEMA_OVERRIDES,
// consulted from `operation()`) — never embedded in the shared
// ERROR_ENVELOPE above. `capacity_report` is the SAME literal
// `CAPACITY_REPORT_KEY` the throw site (capacity-guard.ts) and smoke.ts's
// assertion use — imported, not retyped, after those three disagreeing was
// itself a review finding (the wire key was actually `report`, silently
// spread from `HttpError.extra` with no rename, while this schema and
// smoke.ts both said `capacity_report`).
const CAPACITY_ERROR_ENVELOPE = {
  type: "object",
  required: ["ok", "error", "requestId"],
  properties: {
    ok: { const: false },
    error: {
      type: "object",
      required: ["code", "message"],
      properties: {
        ...BASE_ERROR_PROPERTIES,
        [S.CAPACITY_REPORT_KEY]: {
          ...toSchema(S.CapacityReport),
          description: "On CAPACITY_IMPOSSIBLE (422): the D2 arithmetic pre-check report",
        },
      },
      additionalProperties: true,
    },
    requestId: { type: "string", format: "uuid" },
  },
} as const;

// SCOPED to POST /competitions/from-template's 409 only (D1a design doc's
// error table: template.version_retired) — same reasoning as
// CAPACITY_ERROR_ENVELOPE above: a route-specific extra never joins the
// shared BASE_ERROR_PROPERTIES (P4 review 2026-08-13 finding 8 — these two
// extras were real HttpError `extra` fields, undocumented in the served
// spec, and the fix must not repeat the capacity_report mistake this
// comment describes).
const TEMPLATE_VERSION_RETIRED_ENVELOPE = {
  type: "object",
  required: ["ok", "error", "requestId"],
  properties: {
    ok: { const: false },
    error: {
      type: "object",
      required: ["code", "message"],
      properties: {
        ...BASE_ERROR_PROPERTIES,
        live_version: {
          type: "integer",
          description: "On TEMPLATE_VERSION_RETIRED (409): the catalog's current version for this key",
        },
      },
      additionalProperties: true,
    },
    requestId: { type: "string", format: "uuid" },
  },
} as const;

// SCOPED to POST /competitions/from-template's 422 only (D1a design doc's
// error table: template.instantiation_failed) — locates which division/
// stage the transaction was on when it rolled back.
const TEMPLATE_INSTANTIATION_FAILED_ENVELOPE = {
  type: "object",
  required: ["ok", "error", "requestId"],
  properties: {
    ok: { const: false },
    error: {
      type: "object",
      required: ["code", "message"],
      properties: {
        ...BASE_ERROR_PROPERTIES,
        divisionIndex: {
          type: "integer",
          description: "On TEMPLATE_INSTANTIATION_FAILED (422): 0-based index into the template's divisions",
        },
        stageIndex: {
          type: ["integer", "null"],
          description: "On TEMPLATE_INSTANTIATION_FAILED (422): 0-based index into the division's stages, or null if the division itself failed",
        },
        cause: {
          type: "string",
          description: "On TEMPLATE_INSTANTIATION_FAILED (422): the underlying validation error message",
        },
      },
      additionalProperties: true,
    },
    requestId: { type: "string", format: "uuid" },
  },
} as const;

// SCOPED to the 422 of the three stream routes that refuse a destination (Streaming R1, A18 — G2; POST and PATCH
// stream-targets, POST stream-sessions): the allowlist's refusal carries `rule`, which check refused, as a real
// HttpError `extra` (usecases/stream-targets.ts DestinationNotAllowedError). The enum IS lib/stream-destinations.ts's
// list, imported, not retyped. Each route's variant names its own 422 codes on `code` (N1/N2, B2).
function destinationRefusal422(codes: Record<string, string>, withRule = true) {
  return {
    type: "object",
    required: ["ok", "error", "requestId"],
    properties: {
      ok: { const: false },
      error: {
        type: "object",
        required: ["code", "message"],
        properties: {
          ...BASE_ERROR_PROPERTIES,
          // N1/N2 (B2): the route's stable 422 codes (lib/stream-destinations.ts), named — the wire's `code` stays a string.
          code: { type: "string", description: `This route's 422 codes — ${Object.entries(codes).map(([c, why]) => `${c}: ${why}`).join("; ")}` },
          // Only the routes that can refuse an ingest URL carry `rule` (DELETE's 422 is YOUTUBE_USE_DISCONNECT alone).
          ...(withRule
            ? {
                rule: {
                  type: "string",
                  enum: [...DESTINATION_REFUSALS],
                  description: "On DESTINATION_NOT_ALLOWED (422): which destination rule refused the ingest URL — never the URL itself",
                },
              }
            : {}),
        },
        additionalProperties: true,
      },
      requestId: { type: "string", format: "uuid" },
    },
  } as const;
}
const WHY_422 = {
  [DESTINATION_NOT_ALLOWED]: "the destination is not on the allowlist (see `rule`)",
  [STREAM_KEY_EMPTY]: "the stream key is blank once trimmed",
  [DESTINATION_LABEL_EMPTY]: "the destination name is blank once trimmed",
  [TARGET_UNREADABLE]: "the saved stream key can no longer be read (replace the key; a legacy destination: remove it, since only YouTube and Twitch can be added)",
  [YOUTUBE_USE_DISCONNECT]: "the destination is a connected YouTube channel, which has no key or name of its own (disconnect the channel instead)",
} as const;
const pick422 = (...codes: (keyof typeof WHY_422)[]) => destinationRefusal422(Object.fromEntries(codes.map((c) => [c, WHY_422[c]])));
const STREAM_TARGET_CREATE_422 = pick422(DESTINATION_NOT_ALLOWED, STREAM_KEY_EMPTY, DESTINATION_LABEL_EMPTY);
const STREAM_TARGET_PATCH_422 = pick422(DESTINATION_NOT_ALLOWED, STREAM_KEY_EMPTY, DESTINATION_LABEL_EMPTY, TARGET_UNREADABLE, YOUTUBE_USE_DISCONNECT);
// Remove refuses nothing about an ingest URL: its one 422 is the connected-channel row, so no `rule`.
const STREAM_TARGET_DELETE_422 = destinationRefusal422({ [YOUTUBE_USE_DISCONNECT]: WHY_422[YOUTUBE_USE_DISCONNECT] }, false);
const STREAM_SESSION_CREATE_422 = pick422(DESTINATION_NOT_ALLOWED, TARGET_UNREADABLE);

// SCOPED to POST /fixtures/{id}/stream-sessions (Streaming R1, lane C A21): the
// typed refusals of `createSession` carry machine-readable extras as real
// HttpError `extra`s (usecases/stream-sessions.ts `refuse`), and the v1
// envelope merges them into `error`. One envelope per status, built from the
// same base, because a status can carry two refusals with different extras
// (402: the plan paywall's feature_key/reason vs no_credits' featureKey).
// routes.test.ts beside the route asserts wire ⊆ spec for every refusal.
function scopedErrorEnvelope(extra: Record<string, unknown>) {
  return {
    type: "object",
    required: ["ok", "error", "requestId"],
    properties: {
      ok: { const: false },
      error: {
        type: "object",
        required: ["code", "message"],
        properties: { ...BASE_ERROR_PROPERTIES, ...extra },
        additionalProperties: true,
      },
      requestId: { type: "string", format: "uuid" },
    },
  } as const;
}
// Engine-split D31: ENGINE_OUTDATED's three extras (usecases/scoring.ts assertEngineEpoch), documented on POST /fixtures/{id}/events' 426 only.
const ENGINE_OUTDATED_ENVELOPE = scopedErrorEnvelope({
  sport: { type: "string", description: "On ENGINE_OUTDATED (426): the fixture's sport — the one whose fold epoch moved" },
  required: { type: "integer", description: "On ENGINE_OUTDATED (426): the minimum epoch the server accepts for that sport now (normally its fold epoch); the client must send at least this" },
  got: { type: "integer", description: "On ENGINE_OUTDATED (426): the engine_epoch the request carried" },
});
const STREAM_TARGET_HOLDER_PROPERTIES = {
  type: "object",
  description: "On TARGET_IN_USE (409): the match whose stream holds the destination (always this organisation's)",
  // B2 review nit: wireHolder always sends all six (null when empty), so a generated client must not see them optional.
  required: ["fixtureId", "href", "matchNo", "courtName", "label", "state"],
  properties: {
    fixtureId: { type: ["string", "null"], format: "uuid", description: "The holding fixture; null if it was deleted" },
    href: { type: ["string", "null"], description: "The holding fixture's organiser page; null if it was deleted" },
    matchNo: { type: ["integer", "null"], description: "The holding fixture's number in its division; null if it was deleted" },
    courtName: { type: ["string", "null"], description: "The holding fixture's court, when it has one" },
    label: { type: "string", description: "The destination's own label" },
    state: { enum: ["live", "waiting"], description: "live = a phone is sending (live or ending), or — on Go live only — an ENDED session whose Machine or destination output is still up and could not be released; waiting = requested, provisioning or warming" },
  },
} as const;
// PATCH (Replace key) refuses TARGET_IN_USE or DESTINATION_DUPLICATE; DELETE (Remove) only TARGET_IN_USE — so only
// PATCH's 409 documents `other` (M1, B1 review: an extra a route never sends is not documented on it).
const STREAM_TARGET_DELETE_409 = scopedErrorEnvelope({ holder: STREAM_TARGET_HOLDER_PROPERTIES });
const STREAM_TARGET_PATCH_409 = scopedErrorEnvelope({
  holder: STREAM_TARGET_HOLDER_PROPERTIES,
  other: {
    type: "object",
    description: "On DESTINATION_DUPLICATE (409): the active destination that already holds this stream key",
    required: ["id", "label"],
    properties: { id: { type: "string", format: "uuid" }, label: { type: "string" } },
  },
});
const STREAM_SESSION_CREATE_ERRORS = {
  402: scopedErrorEnvelope({
    featureKey: { type: "string", description: "On no_credits (402): the entitlement whose match credits ran out (streaming.relay)" },
    feature_key: { type: "string", description: "On PAYMENT_REQUIRED (402): the plan feature the organisation lacks (streaming.overlay or streaming.relay)" },
    feature: { type: "string", description: "On PAYMENT_REQUIRED (402): the same key, kept for pre-PROMPT-13 clients" },
    reason: { type: "string", description: "On PAYMENT_REQUIRED (402): the human sentence for the paywall" },
  }),
  409: scopedErrorEnvelope({
    sessionId: { type: ["string", "null"], format: "uuid", description: "On active_session (409): the fixture's running session — resume it rather than start another" },
    // T3 (spec §5.5): the Streaming page's holder shape (stream-target-holders.ts wireHolder), nullable here alone.
    holder: {
      ...STREAM_TARGET_HOLDER_PROPERTIES,
      type: ["object", "null"],
      description: "On target_in_use (409): the match (always this organisation's) whose stream holds the destination — its number, organiser page, court and whether a phone is live or awaited; null when a concurrent start won the race and there is no holder to name",
    },
  }),
  422: STREAM_SESSION_CREATE_422,
  503: scopedErrorEnvelope({
    headroomMinutes: { type: "integer", description: "On storage_exhausted (503): recording minutes left once every active session's reservation is subtracted — below what the refused start would itself reserve (one recording's buffer for passthrough, two for composed)" },
  }),
};

// `"METHOD /path"` (the literal `RouteSpec.path`, `{id}` un-substituted) ->
// status -> the envelope THAT route x status uses instead of the plain
// ERROR_ENVELOPE. Consulted once, inside `operation()`'s `route.errors`
// loop, so a route not listed here is completely unaffected.
// W2c — the division PATCH's refusals, each with the facts a client says it with (`lib/rule-errors.ts`
// `ruleRefusalText`). `refused` is the same list the 200 carries.
const DIVISION_REFUSED = {
  type: "array",
  description: "The format fields this save did not apply, each with the first started stage that depends on it",
  items: toSchema(S.RefusedFieldS),
} as const;
const STAGE_NAMED = {
  stage_id: { type: "string", format: "uuid", description: "The stage whose own rules refuse the save" },
  stage_name: { type: "string", description: "Its name, for the sentence" },
} as const;
const DIVISION_PATCH_ERRORS = {
  400: scopedErrorEnvelope({
    field: { type: "string", description: "On RULE_NOT_SETTABLE (400): the stage's own rules key the new variant (or online play) cannot carry" },
    reason: { type: "string", enum: ["online_division"], description: "On RULE_NOT_SETTABLE (400): why, as a code - `online_division` when the key (clock, clock family) is the division's own once it plays online (Lichess)" },
    ...STAGE_NAMED,
  }),
  409: scopedErrorEnvelope({
    refused: { ...DIVISION_REFUSED, description: "On DIVISION_FORMAT_LOCKED / DIVISION_TABLE_RULES_LOCKED (409): every field refused; the message names the first" },
    match_edits: { type: "boolean", description: "On DIVISION_FORMAT_LOCKED (409): whether the first refused stage's matches can take a format of their own (the sport declares a match-scope key for it); false = the message does not suggest changing individual matches" },
    fixture_id: { type: "string", format: "uuid", description: "On FIXTURE_OWN_FORMAT_NO_LONGER_FITS (409): the unstarted match whose own format would stop fitting" },
    fixture_no: { type: ["integer", "null"], description: "On FIXTURE_OWN_FORMAT_NO_LONGER_FITS (409): that match's number on the board" },
    field: { type: "string", description: "On FIXTURE_OWN_FORMAT_NO_LONGER_FITS (409): the rule that would stop fitting" },
  }),
  422: scopedErrorEnvelope({
    issues: {
      type: "array",
      description: "On CONFIG_INVALID (422): the sport schema's reasons, path and message only",
      items: { type: "object", required: ["path", "message"], properties: { path: { type: "array", items: { type: ["string", "integer"] } }, message: { type: "string" } } },
    },
    refused: { ...DIVISION_REFUSED, description: "On CONFIG_INVALID (422) after a per-field refusal: the fields kept as stored, whose stored values the config no longer parses with" },
    refusals: {
      type: "array",
      description: "On TIEBREAK_KEY_INVALID (422): every step the validator refuses, in order; with `stage_id`, `stage_name`, `stage_kind` when an unpinned stage's inherited order is the one refused",
      items: {
        type: "object",
        required: ["index", "key", "reason"],
        properties: {
          index: { type: "integer", description: "the step's position (-1 for the empty order)" },
          key: { type: ["string", "null"], description: "the refused key (null for the empty order)" },
          reason: { type: "string", enum: ["sport", "stage_format", "cross_group", "fair_play_off", "position", "first", "last", "duplicate", "empty"] },
          need: { type: "string", description: "what the step needs: the metrics, the stage format, the primary key or `lots`" },
        },
      },
    },
    uncovered: {
      type: "array",
      description: "On POINTS_OUTCOME_UNCOVERED (422): the outcomes the save would let a stage end in that its points do not pay (`draw`, `tie`, `set:2-1`, ...), with `stage_id`, `stage_name`",
      items: { type: "string" },
    },
    ...STAGE_NAMED,
  }),
};

const ERROR_SCHEMA_OVERRIDES: Record<string, Partial<Record<number, unknown>>> = {
  "PATCH /divisions/{id}": DIVISION_PATCH_ERRORS,
  "POST /stages/{id}/schedule/auto": { 422: CAPACITY_ERROR_ENVELOPE },
  "POST /fixtures/{id}/events": { 426: ENGINE_OUTDATED_ENVELOPE },
  "POST /competitions/from-template": {
    409: TEMPLATE_VERSION_RETIRED_ENVELOPE,
    422: TEMPLATE_INSTANTIATION_FAILED_ENVELOPE,
  },
  "POST /orgs/{id}/stream-targets": { 422: STREAM_TARGET_CREATE_422 },
  "POST /fixtures/{id}/stream-sessions": STREAM_SESSION_CREATE_ERRORS,
  "PATCH /orgs/{id}/stream-targets/{targetId}": { 409: STREAM_TARGET_PATCH_409, 422: STREAM_TARGET_PATCH_422 },
  "DELETE /orgs/{id}/stream-targets/{targetId}": { 409: STREAM_TARGET_DELETE_409, 422: STREAM_TARGET_DELETE_422 },
};

function pathParams(path: string): object[] {
  const params = [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
  return params.map((name) => ({
    name,
    in: "path",
    required: true,
    schema: name === "code"
      ? { type: "string", pattern: S.CAPTURE_CODE_RE.source }   // capture QR v2: the stream code, not a uuid
      : name.endsWith("Slug") || name === "slug" || name === "sport"
        ? { type: "string" }
        : { type: "string", format: "uuid" },
  }));
}

// ---------------------------------------------------------------------------
// Examples — deterministic sample values derived from the JSON schema so
// every operation ships with at least one example (v3/08 §3) without
// hand-maintaining ~100 of them.
// ---------------------------------------------------------------------------

/** `{not: {}}`: the JSON Schema `z.never()` emits, which no value satisfies. */
function refusesEverything(schema: unknown): boolean {
  if (typeof schema !== "object" || schema === null) return false;
  const s = schema as Record<string, unknown>;
  const not = s.not;
  return Object.keys(s).length === 1 && typeof not === "object" && not !== null && Object.keys(not).length === 0;
}

/** A string example that satisfies what the JSON Schema says of it (batch 4: a request example is a body a client copies, so
 *  it must parse). In order: a declared DEFAULT where the stock word cannot be made to fit (a pattern, or an exact length:
 *  valid by construction, e.g. `return_path`, `currency`), then its format, then the stock word padded to `minLength` and cut to
 *  `maxLength`. `ordinal` is the element's place in an array whose `minItems` asks for several, so uuid items stay distinct. */
function stringExample(s: Record<string, unknown>, ordinal: number): string {
  const exactLength = typeof s.minLength === "number" && s.minLength === s.maxLength;
  if ((typeof s.pattern === "string" || exactLength) && typeof s.default === "string") return s.default;
  if (s.format === "uuid") return ordinal === 0 ? "3f1a2b04-8c1d-4e5f-9a6b-7c8d9e0f1a2b" : `3f1a2b04-8c1d-4e5f-9a6b-7c8d9e0f1a2${(ordinal % 16).toString(16)}`;
  if (s.format === "date") return "2026-08-01";
  if (s.format === "date-time") return "2026-08-01T09:00:00Z";
  if (s.format === "email") return "user@example.com";
  if (s.format === "uri" || s.format === "url") return "https://example.com/example";
  const min = typeof s.minLength === "number" ? s.minLength : 0;
  const max = typeof s.maxLength === "number" ? s.maxLength : Number.POSITIVE_INFINITY;
  const word = "example";
  const padded = word.length >= min ? word : word.repeat(Math.ceil(min / word.length)).slice(0, min);
  return padded.length > max ? padded.slice(0, max) : padded;
}

const isScalarSchema = (schema: unknown): boolean => {
  const type = typeof schema === "object" && schema !== null ? (schema as { type?: unknown }).type : undefined;
  return type === "string" || type === "integer" || type === "number";
};

export function exampleOf(schema: unknown, depth = 0, ordinal = 0): unknown {
  if (depth > 6 || typeof schema !== "object" || schema === null) return null;
  const s = schema as Record<string, unknown>;
  if ("const" in s) return s.const;
  if (Array.isArray(s.enum) && s.enum.length > 0) return s.enum[0];
  if (Array.isArray(s.examples) && s.examples.length > 0) return s.examples[0];
  const first = (k: "anyOf" | "oneOf" | "allOf") =>
    Array.isArray(s[k]) && (s[k] as unknown[]).length > 0 ? (s[k] as unknown[])[0] : null;
  const union = first("anyOf") ?? first("oneOf") ?? first("allOf");
  if (union) return exampleOf(union, depth + 1, ordinal);
  const type = Array.isArray(s.type) ? s.type[0] : s.type;
  switch (type) {
    case "object": {
      const out: Record<string, unknown> = {};
      const props = (s.properties ?? {}) as Record<string, unknown>;
      const required = new Set((s.required as string[]) ?? []);
      for (const [name, prop] of Object.entries(props)) {
        // A property that accepts nothing (`z.never()`, emitted `{not: {}}`: the top-level stage deciders a stage's
        // config refuses by name, W2c Task 13b) is documented only so a client learns where the key went. Any value in
        // an example would make the example a body its own route refuses.
        if (refusesEverything(prop)) continue;
        // Keep examples focused: required fields plus the first few optionals.
        if (required.has(name) || Object.keys(out).length < 4) {
          out[name] = exampleOf(prop, depth + 1);
        }
      }
      return out;
    }
    case "array":
      // A tuple (`z.tuple`, emitted `prefixItems` with no `items`: a stage forfeit's `awardScore` pair) is one example
      // per position; `[exampleOf(undefined)]` would publish `[null]`, which the tuple refuses.
      if (Array.isArray(s.prefixItems)) return (s.prefixItems as unknown[]).map((item) => exampleOf(item, depth + 1));
      // `minItems` is a count the schema demands (a tie-break order needs two entrants): one example per place, for a list of
      // scalars. A list of objects keeps its single sample (the same object repeated is noise in a document, and no request needs more).
      return Array.from({ length: isScalarSchema(s.items) && typeof s.minItems === "number" && s.minItems > 1 ? s.minItems : 1 }, (_, i) => exampleOf(s.items, depth + 1, i));
    case "string":
      return stringExample(s, ordinal);
    case "integer":
    case "number":
      return typeof s.minimum === "number" ? s.minimum : 1;
    case "boolean":
      return true;
    case "null":
      return null;
    default:
      return null;
  }
}

/** One published stream link: the validator's first allowed host, so `isStreamUrl` accepts it by construction. */
const STREAM_EXAMPLE_URL = `https://${STREAM_HOSTS[0]}/watch?v=example`;

/**
 * Batch 4 — the request examples JSON Schema cannot get right on its own. A zod `.refine` is not exported to JSON Schema, so a
 * timezone is "a string" to the generator, a stream link is "a string", and two fields that exclude each other are both
 * "optional strings". Each entry names the route (`METHOD /path`, as `RouteSpec`) and the TOP-LEVEL body properties to set;
 * `undefined` removes the property. The ratchet (`openapi-request-examples.test.ts`) parses every example against its own
 * schema, so a patch that is wrong is red, and a patch the generated example did not need is red too (a stale entry).
 */
export const REQUEST_EXAMPLE_PATCHES: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  "PUT /divisions/{id}/schedule-settings": { tz: "Europe/London" },
  "PUT /fixtures/{id}/stream": { streamUrl: STREAM_EXAMPLE_URL },
  "POST /orgs/{id}/stream-targets": { watchUrl: STREAM_EXAMPLE_URL },
  // Exactly one of label or streamKey (the route's refine).
  "PATCH /orgs/{id}/stream-targets/{targetId}": { streamKey: undefined },
  // The code's own pattern; and `stopped` rides only while no broadcast is held (`sid` null), which the example's sid breaks.
  "POST /capture/codes/{code}/beats": { code: "3f1a2b04m8cd", stopped: null },
  // `date` and `dateFrom`/`dateTo` are exclusive.
  "POST /competitions/{id}/exports/scorer-sheets": { dateFrom: undefined, dateTo: undefined },
};

/** The request body example the spec publishes for a route: the schema-driven `exampleOf`, then the route's patch.
 *  `patched: false` is the generator alone (the ratchet uses it to prove every patch is load-bearing). */
export function requestExampleOf(
  route: { method: string; path: string; request?: ZodType },
  opts: { patched?: boolean } = {},
): unknown {
  if (route.request === undefined) throw new Error(`${route.method} ${route.path} takes no request body`);
  const generated = exampleOf(toSchema(route.request));
  const patch = opts.patched === false ? undefined : REQUEST_EXAMPLE_PATCHES[`${route.method.toUpperCase()} ${route.path}`];
  if (patch === undefined) return generated;
  if (typeof generated !== "object" || generated === null || Array.isArray(generated)) {
    throw new Error(`${route.method} ${route.path}: an example patch needs an object body`);
  }
  const out = { ...(generated as Record<string, unknown>) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete out[key];
    else out[key] = value;
  }
  return out;
}

/** The key scope this operation needs, from the SAME allowlist the auth
 *  wrapper enforces (key-scopes.ts) — spec and door cannot disagree. */
function requiredScope(route: RouteSpec): string | null {
  if (route.public) return null;
  const concrete = route.path.replace(/\{[^}]+\}/g, "seg");
  return matchKeyRoute(route.method.toUpperCase(), `/api/v1${concrete}`)?.scope ?? null;
}

function operation(route: RouteSpec): Record<string, unknown> {
  const scope = requiredScope(route);
  // A bare route (capture QR v2) answers the shape itself and refuses with the capture-refusal body.
  const errorBody = route.bare ? toSchema(route.refusal ?? S.CaptureRefusal) : ERROR_ENVELOPE;
  const responses: Record<string, unknown> = {
    [String(route.status ?? 200)]: {
      description: "Success",
      content: { "application/json": { schema: route.bare && route.response ? toSchema(route.response) : envelope(route.response) } },
    },
  };
  if (!route.bare) responses["400"] = { description: "Validation error", content: { "application/json": { schema: ERROR_ENVELOPE } } };
  if (!route.public) {
    responses["401"] = { description: "Not authenticated", content: { "application/json": { schema: errorBody } } };
  }
  responses["404"] = { description: "Not found", content: { "application/json": { schema: errorBody } } };
  const overrides = ERROR_SCHEMA_OVERRIDES[`${route.method.toUpperCase()} ${route.path}`];
  for (const status of route.errors ?? []) {
    responses[String(status)] = {
      description: { 400: "Validation error", 402: "Plan upgrade required", 409: "Conflict", 410: "Gone", 422: "Rejected by the engine", 426: "Client engine out of date", 429: "Rate limited" }[status] ?? "Error",
      content: { "application/json": { schema: overrides?.[status] ?? errorBody } },
    };
  }
  // Response example: success envelope around a data sample.
  const success = responses[String(route.status ?? 200)] as {
    content?: { "application/json": { schema: unknown; example?: unknown } };
  };
  if (success?.content) {
    const data = route.response ? exampleOf(toSchema(route.response)) : {};
    success.content["application/json"].example = route.bare
      ? data
      : { ok: true, data, requestId: "3f1a2b04-8c1d-4e5f-9a6b-7c8d9e0f1a2b" };
  }
  return {
    summary: route.summary,
    tags: [route.tag],
    // x-required-scope (v3/08 §3): which API-key scope unlocks this
    // operation; "none" = session-only, never key-accessible.
    ...(route.public ? {} : { "x-required-scope": scope ?? "none" }),
    parameters: [
      ...pathParams(route.path),
      ...Object.entries(route.query ?? {}).map(([name, q]) => ({
        name,
        in: "query",
        required: false,
        schema: q.schema,
        ...(q.description ? { description: q.description } : {}),
      })),
    ],
    ...(route.request
      ? {
          requestBody: {
            required: !route.requestOptional,
            content: {
              [route.requestContentType ?? "application/json"]: {
                schema: toSchema(route.request),
                example: requestExampleOf(route),
              },
            },
          },
        }
      : {}),
    responses,
    security: route.public ? [] : route.bare ? [{ captureTok: [] }] : [{ sessionCookie: [] }, { apiKey: [] }],
  };
}

export function buildOpenApiDocument(
  opts: { published?: boolean } = {},
): Record<string, unknown> {
  // Published spec (v3/08 §3): exactly the key-scoped surface plus the
  // public read API — session-only/internal operations stay out of it.
  const routes = opts.published
    ? ROUTES.filter((r) => r.public || requiredScope(r) !== null)
    : ROUTES;
  const paths: Record<string, Record<string, unknown>> = {};
  for (const route of routes) {
    const full = `/api/v1${route.path}`;
    paths[full] = paths[full] ?? {};
    paths[full][route.method] = operation(route);
  }
  const usedTags = new Set(routes.map((r) => r.tag));
  const tags = [
    { name: "competitions" }, { name: "divisions" }, { name: "entrants" },
    { name: "persons" }, { name: "stages" }, { name: "fixtures" },
    { name: "scoring" }, { name: "scheduling" },
    { name: "device-links" }, { name: "api-keys" }, { name: "registration" },
    { name: "clubs" }, { name: "officials" }, { name: "sponsors" }, { name: "venues" }, { name: "history" },
    { name: "exports" }, { name: "stats" }, { name: "discipline" }, { name: "news" },
    { name: "public" }, { name: "capture" },
  ].filter((t) => usedTags.has(t.name));
  return {
    openapi: "3.1.0",
    info: {
      title: "seazn.club platform API",
      version: "1.0.0",
      description:
        "Versioned REST API (design doc engine/08). Every response is " +
        "`{ ok, data | error, requestId }`. Additive changes land in place; " +
        "breaking changes move to /api/v2 with Sunset headers on deprecation." +
        (opts.published
          ? "\n\nAuthenticate with an API key (`Authorization: Bearer sc_…`, " +
            "created in org settings — Pro). Keys carry a scope — `read`, " +
            "`score` or `manage`; each operation lists its requirement as " +
            "`x-required-scope`. Keys are rate-limited per minute (60 rpm, " +
            "300 rpm on Pro) with `X-RateLimit-*` headers on every response. " +
            "The `public` tag needs no key at all."
          : ""),
    },
    servers: [{ url: "https://seazn.club" }],
    tags,
    components: {
      securitySchemes: {
        sessionCookie: { type: "apiKey", in: "cookie", name: "seazn_session" },
        apiKey: {
          type: "http",
          scheme: "bearer",
          description:
            "Pro API key: `Authorization: Bearer sc_…` (entitlement api.access). " +
            "Scopes: read < score < manage; see x-required-scope per operation.",
        },
        // The capture routes are internal (never key-reachable), so the PUBLISHED spec neither lists them nor this.
        ...(opts.published ? {} : {
          captureTok: {
            type: "http",
            scheme: "bearer",
            description:
              "Capture QR v2 (§6.3): the phone's Bearer is the stream code's `tok` from the QR — accepted ONLY by " +
              "the `capture` routes of ITS code. Unknown, wrong, ended or missing → 401 code_ended (one body).",
          },
        }),
        deviceLink: {
          type: "http",
          scheme: "bearer",
          description:
            "Day-of device link (doc 13 §7): `Authorization: Bearer dl_…` — " +
            "accepted ONLY by its fixture's scoring surface (append events, " +
            "void own events pre-finalize, read state/events, realtime " +
            "token). Expired/revoked → 401 LINK_EXPIRED / LINK_REVOKED.",
        },
      },
    },
    paths,
  };
}
