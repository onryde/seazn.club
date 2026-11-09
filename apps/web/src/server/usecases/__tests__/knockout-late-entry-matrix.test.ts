// W4 app-A Task 12 — late entry into a drawn knockout for EVERY entry template and EVERY entrant kind, in EVERY case,
// through the real usecases on Postgres (owner 2026-11-01: "make sure that it does support in all format and support all
// entrant kind"; rules RB4-L1…L13, X-LE-1…X-LE-13; spec 2026-11-04-format-matrix-w4-knockout-design.md §4.1, rulings
// 263/271). A coverage sweep: it builds nothing. Expected values come from the rulebook (RB4-L3…L12) and the rows as they
// stood before the add, never from the code under test.
//
// Enumerated, never sampled:
//   templates — every STAGE_TEMPLATES entry whose FIRST built stage is a root knockout (lib/format-templates.ts), pinned
//               to the three the brief names; built through `buildTemplateStages` and the API's own `CreateStage` schema, so
//               the stages are what the division builder makes. Late entry acts on the ROOT knockout only (RB4-L1): under
//               ko_plate the main bracket, under qualifying_main the qualifying one; the plate and the main draw are fed from
//               it and never take a late entrant (RB4-L2).
//   kinds     — every `entrants.kind` (V212; `EntrantKind` in schemas.ts). Each is played by a sport whose engine module
//               DECLARES it (`entrantModel.kinds`), its natural sport first (`defaultKind`), among the sports this file can
//               score a played win in and that is offered EVERY template the file builds (`templatesForSport`) — chess for
//               individual (chess is individual-only), badminton for a doubles pair, football for a team. Derived below,
//               never typed as a table. Single sport per kind, with this reason: the placement reads seats, statuses and the
//               ledger, which no sport field reaches; the scorer is touched only by the consumer proof (the placed line is
//               PLAYED and the late winner is seen in round 2), and each kind uses its own sport's vocabulary there. The
//               final describe sweeps the WHOLE sport registry for the placement itself.
//   cases     — the six answers a late knockout entrant can get: (bye) RB4-L3/L4, (withdrawn_slot) RB4-L5, (refused)
//               RB4-L6 with round 1 played out, (rebuild_offered) RB4-L6 with nothing started, and an AUTOMATIC arrival
//               (RB4-L10): (automatic_waiting) it waits with a desk flag, (automatic_tapped) one tap places it.
//               A placed late player (bye, withdrawn_slot, automatic_tapped) also answers X-LE-12's no-free-slot half (these
//               rigs hold no court: the match is unscheduled; the free-slot half is knockout-late-entry.test.ts's) and X-LE-13
//               (Undo is refused by name, pointing to Withdraw). X-LE-14 / RB4-L14 (the late entrant feeds the plate) is app PR B's
//               plate wave (B2) and is NOT asserted here.
//   n         — each cell's own rig size; every one >= max(5, QUALIFYING_MAIN_MIN) (the T15 gates refuse a smaller
//               ko_plate / qualifying_main at Start, and the sweep builds one rig per cell).
//
// Fed tails (RB4-L2, X-LE-2): league_ko, groups_ko and swiss_knockout are enumerated too — the knockout they carry is fed
// from a table, so it never seats a late entrant, whichever way the entrant arrives.
import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { builtinModules } from "@seazn/engine/sports";
import { entrantKindCap, type AnySportModule } from "@seazn/engine/sport";
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { STAGE_TEMPLATES, buildTemplateStages, templatesForSport } from "@/lib/format-templates";
import { QUALIFYING_MAIN_MIN } from "@/lib/format-size-gates";
import { engineEntrantKinds } from "@/lib/__tests__/_engine-entrant-kinds";
import { rb4L4ExpectedLine, type StoredByeLine } from "@/lib/__tests__/rb4-l4-oracle";
import type { AuthCtx } from "@/server/api-v1/auth";
import { CreateStage, EntrantKind, type KnockoutLateEntryResult } from "@/server/api-v1/schemas";
import { getCompetitionDesk } from "../competition-desk";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { undoDivision } from "../history";
import { placeWaitingKnockoutEntrant } from "../knockout-late-entry";
import { confirmRegistration, putRegistrationSettings } from "../registrations";
import { startDivision } from "../schedule";
import { scoreEvent } from "../scoring";
import { createStages, generateStageFixtures, rebuildStageFixtures } from "../stages";
import { withdrawEntrantCascade } from "../withdrawal";
import { seedRegistration } from "./_registration-fixtures";
import { seedOrg } from "./_seed";

// No network on these paths: a Stripe call is a failure, and mail never leaves (the arrival cells confirm registrations).
vi.mock("@/lib/stripe", async (io) => ({
  ...(await io<typeof import("@/lib/stripe")>()),
  getStripe: vi.fn(() => {
    throw new Error("this suite makes no Stripe call");
  }),
}));
vi.mock("@/server/email-outbox/transport", () => ({ deliver: vi.fn() }));

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

type Kind = (typeof EntrantKind.options)[number];

interface Row {
  id: string;
  stage_id: string;
  round_no: number;
  seq_in_round: number;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  home_slot_label: { key?: string } | null;
  away_slot_label: { key?: string } | null;
  status: string;
  outcome: { kind?: string; reason?: string; winner?: string; loser?: string | null } | null;
  winner_to_fixture: string | null;
  winner_to_slot: number | null;
  scheduled_at: Date | null;
  court_id: string | null;
}

/** The plan's sentences (task-10/11 briefs, rulebook RB4-L6), typed here: the refusal table is the code under test. */
const NO_SLOT = "Round 1 complete; no slot left.";
const NOT_WAITING = "This player isn't waiting to join this bracket.";
const NOT_UNDOABLE = "Adding a late player can't be undone. Withdraw the player instead.";
/** Main's Start-lock sentence (entrants.ts), typed here: what a table-fed knockout's list answers a late add. */
const LOCKED = "This tournament has started — the entrant list is locked. Withdrawing entrants still works.";

// ─── What is enumerated ────────────────────────────────────────────────────────────────────────────────────────────────

/** The knobs every template is built at: the cut `qualified` and the rest of what the stages read. */
const KNOBS = { qualified: 4, swissRounds: 3, poolCount: 2, legs: 1 };

/** Every template whose FIRST stage is a root knockout — read off the templates' OWN stage graphs, so a fourth would red the
 *  pin below rather than slip past the matrix. */
const ENTRY_TEMPLATES = STAGE_TEMPLATES.filter((t) => {
  const first = t.build(KNOBS)[0];
  return !t.retired && first?.kind === "knockout" && first.progression === null;
}).map((t) => t.key);

/** Every template that carries a knockout AFTER its first stage: the knockout is fed, so it is no entry stage (RB4-L2). */
const FED_TEMPLATES = STAGE_TEMPLATES.filter((t) => {
  const stages = t.build(KNOBS);
  return !t.retired && stages[0]?.kind !== "knockout" && stages.slice(1).some((s) => s.kind === "knockout");
}).map((t) => t.key);

/** A PLAYED win for `winner` after `core.start`, through the scorer's own events — each sport's own vocabulary. The set of
 *  sports this file can drive; the kind <-> sport pairing below is chosen from the engine's declarations within it. */
const PLAYED_WIN: Record<string, (auth: AuthCtx, f: Row, winner: string) => Promise<void>> = {
  boardgame: async (auth, f, winner) => {
    await post(auth, f.id, "boardgame.result", { winner, method: "resign" });
  },
  badminton: async (auth, f, winner) => {
    const home = winner === f.home_entrant_id;
    for (let g = 0; g < 2; g++) await post(auth, f.id, "badminton.game.summary", home ? { home: 21, away: 10 } : { home: 10, away: 21 });
  },
  football: async (auth, f, winner) => {
    await post(auth, f.id, "football.goal", { by: winner });
    await post(auth, f.id, "football.period", { phase: "HT" });
    await post(auth, f.id, "football.period", { phase: "FT" });
  },
};

interface SportPick {
  key: string;
  variant: string;
  module: AnySportModule;
}

/** A sport's first declared variant. */
function pickOf(m: AnySportModule): SportPick {
  const variant = Object.keys(m.variants)[0];
  if (variant === undefined) throw new Error(`sport ${m.key} declares no variant`);
  return { key: m.key, variant, module: m };
}

/** The kind's sport, from the engine's declarations: a module that declares the kind (`entrantModel.kinds`) and is offered
 *  every template this file builds (`templatesForSport` — chess refuses only the formats that mint pairs), its natural one
 *  first (`defaultKind === kind`), else the registry's first. */
function sportFor(kind: Kind): SportPick {
  const offered = builtinModules.filter(
    (m) =>
      m.key in PLAYED_WIN &&
      (m.entrantModel?.kinds ?? ["individual"]).includes(kind) &&
      [...ENTRY_TEMPLATES, ...FED_TEMPLATES].every((t) => templatesForSport(m.key, engineEntrantKinds(m.key)).some((x) => x.key === t)),
  );
  const pick = offered.find((m) => m.entrantModel?.defaultKind === kind) ?? offered[0];
  if (pick === undefined) throw new Error(`no scorable sport declares the '${kind}' entrant kind`);
  return pickOf(pick as AnySportModule);
}

const KINDS: readonly Kind[] = EntrantKind.options;
const SPORT_OF = new Map(KINDS.map((k) => [k, sportFor(k)] as const));
const sportOf = (kind: Kind): SportPick => SPORT_OF.get(kind)!;

const CASES = ["bye", "withdrawn_slot", "refused", "rebuild_offered", "automatic_waiting", "automatic_tapped"] as const;
type CaseKey = (typeof CASES)[number];

/** The answer each case ends on (`KnockoutLateEntryResult["case"]`, schemas.ts), typed so a new answer is a compile error
 *  here until it has a case. An automatic arrival's flag is `waiting` (a marker, `entrants.knockout_waiting_stage_id` — the
 *  registration door discards the answer, so the cell reads the marker); the tap then ends on the cases the organiser's add
 *  runs. */
const ANSWER_OF = {
  bye: "bye",
  withdrawn_slot: "withdrawn_slot",
  refused: "refused",
  rebuild_offered: "rebuild_offered",
  automatic_waiting: "waiting",
  automatic_tapped: "bye",
} as const satisfies Record<CaseKey, KnockoutLateEntryResult["case"]>;
type UnansweredCase = Exclude<KnockoutLateEntryResult["case"], (typeof ANSWER_OF)[CaseKey]>;
const EVERY_ANSWER_CASED: [UnansweredCase] extends [never] ? true : UnansweredCase = true;

/** The size a bracket of `n` is drawn at: the next power of two (single elimination; RB4 §1). */
const bracketSize = (n: number): number => 2 ** Math.ceil(Math.log2(n));

/** Each case's own field. `bye` and the automatic cells want an ODD field (round 1 holds a bye a newcomer can take);
 *  `withdrawn_slot`, `refused` and `rebuild_offered` want a bracket with NO bye (a power of two), so the case under test is
 *  the one the late entrant falls to. All >= max(5, QUALIFYING_MAIN_MIN) — the gates of T15. */
const N_OF: Record<CaseKey, number> = {
  bye: 5,
  withdrawn_slot: 8,
  refused: 8,
  rebuild_offered: 8,
  automatic_waiting: 5,
  automatic_tapped: 5,
};

// ─── Rig ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

interface Rig {
  template: string;
  kind: Kind;
  sport: SportPick;
  n: number;
  auth: AuthCtx;
  competitionId: string;
  divisionId: string;
  /** Every stage of the template, in seq order. */
  stageIds: string[];
  /** The first stage: the entry stage under an entry template. */
  rootId: string;
  rootName: string;
  /** The stage the root feeds (ko_plate's plate, qualifying_main's main draw, a fed template's knockout); null for plain `knockout`. */
  tailId: string | null;
  /** Entrant ids by seed, P1..Pn. */
  entrants: string[];
}

/** The number of members an entrant of `kind` is created with: one inline person per seat, at most two (`entrantKindCap`:
 *  an individual holds one, a pair two). */
const seatsOf = (kind: Kind): number => Math.min(2, entrantKindCap(kind));

function entrantInput(kind: Kind, name: string, seed?: number) {
  return {
    kind,
    display_name: name,
    ...(seed !== undefined ? { seed } : {}),
    members: Array.from({ length: seatsOf(kind) }, (_, i) => ({
      new_person: { full_name: `${name} m${i + 1} ${randomUUID().slice(0, 4)}` },
      is_captain: false,
      roles: [],
    })),
  };
}

/** `sport` + `kind`: a division of `n` seeded entrants running `template`'s stages, STARTED (the root knockout drawn); the
 *  tail's day-one TBD bracket generated, as the organiser's Generate lays it out. */
async function templateRig(template: string, kind: Kind, n: number, sport: SportPick = sportOf(kind)): Promise<Rig> {
  const { auth } = await seedOrg("pro");
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: `KO matrix ${template} ${kind} ` + randomUUID().slice(0, 6),
    visibility: "private",
    branding: {},
  });
  const division = await createDivision(auth, comp.id, {
    name: "Open",
    slug: "open-" + randomUUID().slice(0, 6),
    sport_key: sport.key,
    variant_key: sport.variant,
    config: {},
  });
  const made = await createEntrants(
    auth,
    division.id,
    Array.from({ length: n }, (_, i) => entrantInput(kind, `P${i + 1}`, i + 1)),
  );
  const drafts = buildTemplateStages(template, KNOBS);
  const ids: string[] = [];
  for (const [i, d] of drafts.entries()) {
    // Through the API's own request schema: what the picker builds is what the API accepts, and a malformed draft throws
    // here instead of seeding a different stage.
    const [stage] = await createStages(
      auth,
      division.id,
      CreateStage.parse({ seq: i + 1, kind: d.kind, name: d.name, config: d.config, progression: d.progression }),
    );
    ids.push(stage!.id);
  }
  await startDivision(auth, division.id);
  const tailId = ids[1] ?? null;
  if (tailId !== null) await generateStageFixtures(auth, tailId);
  return {
    template,
    kind,
    sport,
    n,
    auth,
    competitionId: comp.id,
    divisionId: division.id,
    stageIds: ids,
    rootId: ids[0]!,
    rootName: drafts[0]!.name,
    tailId,
    entrants: made.map((e) => e.id),
  };
}

const rowsOf = (stageId: string) =>
  sql<Row[]>`
    select id, stage_id, round_no, seq_in_round, home_entrant_id, away_entrant_id, home_slot_label, away_slot_label, status, outcome,
           winner_to_fixture, winner_to_slot, scheduled_at, court_id
      from fixtures where stage_id = ${stageId} order by round_no, seq_in_round`;
const rowById = async (id: string) =>
  (
    await sql<Row[]>`
      select id, stage_id, round_no, seq_in_round, home_entrant_id, away_entrant_id, home_slot_label, away_slot_label, status, outcome,
             winner_to_fixture, winner_to_slot, scheduled_at, court_id
        from fixtures where id = ${id}`
  )[0]!;
const tailRowsOf = async (rig: Rig) => (rig.tailId === null ? [] : rowsOf(rig.tailId));
const roundOf = (rows: readonly Row[], r: number) => rows.filter((f) => f.round_no === r);

/** Everything a line shows (seats, status, outcome, labels, time, court) — what "unchanged" compares. */
const shapeOf = (r: Row) =>
  JSON.stringify([r.home_entrant_id, r.away_entrant_id, r.status, r.outcome, r.home_slot_label, r.away_slot_label, r.scheduled_at, r.court_id]);

/** A seat of `line` holds `who`. */
const seatHolds = (line: Row, who: string) => line.home_entrant_id === who || line.away_entrant_id === who;

/** One scorer event at the fixture's tip (`expected_seq` = the highest seq recorded). */
async function post(auth: AuthCtx, fixtureId: string, type: string, payload: Record<string, unknown> = {}): Promise<void> {
  const [{ n }] = await sql<{ n: number }[]>`select coalesce(max(seq), 0)::int as n from score_events where fixture_id = ${fixtureId}`;
  await scoreEvent(auth, fixtureId, { expected_seq: n, type, payload });
}

/** Play `f` to a win for `winner`, from its Start, through the scorer's own events. */
async function win(rig: Rig, f: Row, winner: string): Promise<void> {
  await post(rig.auth, f.id, "core.start");
  await PLAYED_WIN[rig.sport.key]!(rig.auth, f, winner);
}

/** The seam through its CONSUMER: `winnerId` wins `lineId` through the scorer, and the bracket carries them into the next
 *  line's seat the line feeds. Answers the seat's side. */
async function winAndAdvance(rig: Rig, lineId: string, winnerId: string): Promise<void> {
  const line = await rowById(lineId);
  expect(line.winner_to_fixture, "premise: the placed line feeds a next line").not.toBeNull();
  expect([1, 2], "premise: the feed names a seat").toContain(line.winner_to_slot);
  await win(rig, line, winnerId);
  const next = await rowById(line.winner_to_fixture!);
  expect(line.winner_to_slot === 1 ? next.home_entrant_id : next.away_entrant_id, "the late winner is carried into the next line's seat").toBe(winnerId);
}

/** The stored round-1 bye lines, as the oracle reads them: the line, its holder (the award's winner), its seq. */
function storedByeLines(rows: readonly Row[]): StoredByeLine[] {
  return rows
    .filter((r) => r.round_no === 1 && r.outcome?.kind === "award" && r.outcome.reason === "bye" && r.outcome.winner)
    .map((r) => ({ lineId: r.id, holderId: r.outcome!.winner!, seq: r.seq_in_round }));
}

async function seedsOf(divisionId: string): Promise<Map<string, number | null>> {
  const rows = await sql<{ id: string; seed: number | null }[]>`select id, seed from entrants where division_id = ${divisionId}`;
  return new Map(rows.map((r) => [r.id, r.seed]));
}

async function entrantIds(divisionId: string): Promise<Set<string>> {
  return new Set((await sql<{ id: string }[]>`select id from entrants where division_id = ${divisionId}`).map((r) => r.id));
}

async function ledgerCount(divisionId: string): Promise<number> {
  const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from division_events where division_id = ${divisionId}`;
  return n;
}

async function lateRows(divisionId: string) {
  return (
    await sql<{ payload: Record<string, unknown> }[]>`
      select payload from division_events where division_id = ${divisionId} and type = 'knockout_late_entry' order by seq`
  ).map((r) => r.payload);
}

async function waitingOn(entrantId: string): Promise<string | null> {
  const [e] = await sql<{ w: string | null }[]>`select knockout_waiting_stage_id as w from entrants where id = ${entrantId}`;
  return e!.w;
}

/** The stages any fixture seats `entrantId` in. */
async function seatedIn(entrantId: string): Promise<string[]> {
  const rows = await sql<{ stage_id: string }[]>`
    select distinct stage_id from fixtures where ${entrantId} in (home_entrant_id, away_entrant_id)`;
  return rows.map((r) => r.stage_id);
}

/** The desk's late-player rows for the rig's division (`getCompetitionDesk`, the loader the desk and Match Day read). */
async function deskLate(rig: Rig) {
  const desk = await getCompetitionDesk(rig.auth, rig.competitionId);
  return (desk.divisions.get(rig.divisionId)?.attention ?? []).filter((a) => a.kind === "late_players_waiting");
}

async function refusal(p: Promise<unknown>): Promise<HttpError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err, "the call is refused").toBeInstanceOf(HttpError);
  return err as HttpError;
}

/** `late_entry` is a union by format; a late add here joins a knockout, so a Swiss answer is refused by name. */
type KnockoutCreated = Awaited<ReturnType<typeof createEntrants>>[number] & { late_entry?: KnockoutLateEntryResult };
function knockoutCreated(row: Awaited<ReturnType<typeof createEntrants>>[number]): KnockoutCreated {
  if (row.late_entry !== undefined && row.late_entry.format !== "knockout") {
    throw new Error(`a knockout late add answered format ${row.late_entry.format}`);
  }
  return row as KnockoutCreated;
}

/** The organiser's Add of one unseeded entrant of the rig's kind — the product path, `createEntrants`. */
async function addLate(rig: Rig, name: string) {
  const [row] = await createEntrants(rig.auth, rig.divisionId, [entrantInput(rig.kind, name)]);
  return knockoutCreated(row!);
}

/** An AUTOMATIC arrival: a free offline registration of the rig's kind, confirmed through `confirmRegistration` →
 *  `materialise` (ruling 271: never placed, never refused). */
async function registerAndConfirm(rig: Rig, name: string): Promise<string> {
  const settings = await putRegistrationSettings(rig.auth, rig.divisionId, {
    enabled: true,
    entrant_kind: rig.kind,
    fee_cents: 0,
    form_fields: [],
    opens_at: null,
    closes_at: null,
    capacity: null,
    refund_lock_at: null,
  });
  expect(settings.entrant_kind, "premise: the division registers this kind").toBe(rig.kind);
  const { registration } = await seedRegistration(
    rig.competitionId,
    rig.divisionId,
    { fee_cents: 0, currency: "eur", payment_method: "offline" },
    { displayName: name, players: Array.from({ length: seatsOf(rig.kind) }, (_, i) => ({ name: `${name} p${i + 1}` })) },
  );
  const confirmed = await confirmRegistration(rig.auth, registration.id);
  expect(confirmed.status, "an automatic arrival is never refused (ruling 271)").toBe("confirmed");
  expect(confirmed.entrant_id, "the confirmation made an entrant").toBeTruthy();
  return confirmed.entrant_id!;
}

/** How many times each kind's late entrant was proven to BE the entrant (X-LE-11) — read by the anti-vacuity `it`. */
const lateIsTheEntrantChecks = new Map<Kind, number>();

/** X-LE-11 / RB4-L11: the late PAIR (or player, or team) IS the entrant. Exactly the one entrant row was added since
 *  `before`, of the rig's kind, holding the members the arrival named — a partner is a MEMBER of it, never an entrant of
 *  its own. */
async function expectLateIsTheEntrant(rig: Rig, before: ReadonlySet<string>, lateId: string): Promise<void> {
  const added = [...(await entrantIds(rig.divisionId))].filter((id) => !before.has(id));
  expect(added, "X-LE-11: one entrant row was added: the late entrant itself, no partner row").toEqual([lateId]);
  const [e] = await sql<{ kind: string }[]>`select kind from entrants where id = ${lateId}`;
  expect(e!.kind, "X-LE-11: the entrant is of the division's kind").toBe(rig.kind);
  const [{ members }] = await sql<{ members: number }[]>`select count(*)::int as members from entrant_members where entrant_id = ${lateId}`;
  expect(members, "X-LE-11: the partner is a member of the one entrant").toBe(seatsOf(rig.kind));
  lateIsTheEntrantChecks.set(rig.kind, (lateIsTheEntrantChecks.get(rig.kind) ?? 0) + 1);
}

/** X-LE-13 / RB4-L13: a placed late player has no Undo — Undo answers by name and points to Withdraw, and moves nothing. */
async function expectNotUndoable(rig: Rig): Promise<void> {
  const before = await snapshot(rig);
  const err = await refusal(undoDivision(rig.auth, rig.divisionId));
  expect(err, "X-LE-13: Undo is refused by name").toMatchObject({ status: 409, code: "KO_LATE_ENTRY_NOT_UNDOABLE", message: NOT_UNDOABLE });
  await expectNothingWritten(rig, before, "X-LE-13 a refused Undo");
}

/** X-LE-12 / RB4-L12 (the no-free-slot half: these rigs hold no court, so no slot is free): the new round-1 match is
 *  unscheduled — the answer says so and the line carries no time and no court. The free-slot half is
 *  knockout-late-entry.test.ts's. */
async function expectUnscheduled(answer: KnockoutLateEntryResult | undefined, lineId: string): Promise<void> {
  expect(answer?.scheduled, "X-LE-12: no free slot, so the answer says unscheduled").toBe(false);
  const line = await rowById(lineId);
  expect({ at: line.scheduled_at, court: line.court_id }, "X-LE-12: the new match holds no time and no court").toEqual({ at: null, court: null });
}

/** Every line the arrival did not touch stands as it stood: same seats, status, outcome, labels, time and court; none added
 *  or removed. Answers how many lines were compared. */
function expectOthersUnchanged(before: readonly Row[], after: readonly Row[], moved: ReadonlySet<string>, label: string): number {
  expect(after.length, `${label}: no line added or removed`).toBe(before.length);
  let compared = 0;
  for (const b of before) {
    if (moved.has(b.id)) continue;
    const a = after.find((x) => x.id === b.id);
    expect(a, `${label}: line ${b.round_no}.${b.seq_in_round} still stands`).toBeDefined();
    expect(shapeOf(a!), `${label}: line ${b.round_no}.${b.seq_in_round} unchanged`).toBe(shapeOf(b));
    compared++;
  }
  expect(compared, `${label}: anti-vacuity: every other line compared`).toBe(before.length - moved.size);
  expect(compared, `${label}: anti-vacuity: something was compared`).toBeGreaterThan(0);
  return compared;
}

/** X-LE-7 / RB4-L7: the newcomer holds exactly ONE seat, in round 1 of the root, and none anywhere else — the tail seats no
 *  late entrant (RB4-L2). */
async function expectOnlyRoundOneSeat(rig: Rig, lateId: string): Promise<void> {
  const seats = await sql<{ round_no: number; stage_id: string }[]>`
    select round_no, stage_id from fixtures where ${lateId} in (home_entrant_id, away_entrant_id)`;
  expect(seats.length, "X-LE-7: the newcomer holds one seat").toBe(1);
  expect(seats[0], "X-LE-7: it is a round-1 seat of the entry stage").toMatchObject({ round_no: 1, stage_id: rig.rootId });
  expect(await seatedIn(lateId), "RB4-L2: seated in the entry stage only, never in a fed stage").toEqual([rig.rootId]);
}

/** A refused add wrote nothing: no entrant, no ledger row, no line moved (the tail's included). */
async function expectNothingWritten(rig: Rig, snap: { ids: ReadonlySet<string>; ledger: number; root: Row[]; tail: Row[] }, label: string): Promise<void> {
  expect(await entrantIds(rig.divisionId), `${label}: no entrant written`).toEqual(snap.ids);
  expect(await ledgerCount(rig.divisionId), `${label}: no ledger row`).toBe(snap.ledger);
  expect(await rowsOf(rig.rootId), `${label}: the root stands`).toEqual(snap.root);
  expect(await tailRowsOf(rig), `${label}: the tail stands`).toEqual(snap.tail);
}

async function snapshot(rig: Rig) {
  return {
    ids: await entrantIds(rig.divisionId),
    ledger: await ledgerCount(rig.divisionId),
    root: await rowsOf(rig.rootId),
    tail: await tailRowsOf(rig),
  };
}

// ─── The cells ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** (bye) RB4-L3/L4: odd field, round 1 holds byes, nothing of round 2 started: the newcomer plays the LOWEST-SEEDED holder in
 *  a new round-1 match; nothing else moves. A second add takes the next such bye (the oracle over the byes then stored). */
async function cellBye(rig: Rig): Promise<void> {
  const before = await rowsOf(rig.rootId);
  const round1 = roundOf(before, 1);
  expect(round1.length, "premise: round 1 of a bracket of the next power of two").toBe(bracketSize(rig.n) / 2);
  const stored = storedByeLines(before);
  expect(stored.length, "premise: one bye per missing seat").toBe(bracketSize(rig.n) - rig.n);
  expect(rig.n % 2, "premise: an odd field").toBe(1);
  const seeds = await seedsOf(rig.divisionId);
  const want = rb4L4ExpectedLine(stored, seeds, round1.length)!;
  const firstBye = [...stored].sort((a, b) => a.seq - b.seq)[0]!.lineId;
  expect(want, "premise: a differential case — RB4-L4's bye is not the first bye").not.toBe(firstBye);
  const holder = stored.find((l) => l.lineId === want)!.holderId;
  const line0 = before.find((r) => r.id === want)!;
  const next0 = before.find((r) => r.id === line0.winner_to_fixture)!;
  expect(seatHolds(next0, holder), "premise: the holder was carried into round 2").toBe(true);
  const tailBefore = await tailRowsOf(rig);
  const idsBefore = await entrantIds(rig.divisionId);

  const late = await addLate(rig, "Late");
  expect(late.late_entry, "RB4-L3: the newcomer takes the lowest-seeded holder's bye").toMatchObject({
    format: "knockout",
    case: ANSWER_OF.bye,
    entrant_id: late.id,
    stage_id: rig.rootId,
    fixture_id: want,
    opponent_id: holder,
  });
  await expectLateIsTheEntrant(rig, idsBefore, late.id);
  const after = await rowsOf(rig.rootId);
  const line = after.find((r) => r.id === want)!;
  expect(new Set([line.home_entrant_id, line.away_entrant_id]), "the newcomer plays the holder").toEqual(new Set([holder, late.id]));
  expect({ status: line.status, outcome: line.outcome }, "a scheduled match, the bye reversed").toEqual({ status: "scheduled", outcome: null });
  const next = after.find((r) => r.id === next0.id)!;
  expect(seatHolds(next, holder), "the holder is taken back out of round 2").toBe(false);
  expect(line0.winner_to_slot === 1 ? next.home_slot_label : next.away_slot_label, "the seat waits on the line's winner").toMatchObject({ key: "slot.winner_match" });
  expectOthersUnchanged(before, after, new Set([want, next0.id]), "RB4-L3 nothing else moves");
  expect(await tailRowsOf(rig), "RB4-L2: the tail stands").toEqual(tailBefore);
  await expectOnlyRoundOneSeat(rig, late.id);
  expect((await lateRows(rig.divisionId)).map((p) => [p.entrant_id, p.case, p.source]), "one ledger row").toEqual([[late.id, "bye", "organiser"]]);
  await expectUnscheduled(late.late_entry, want);
  await expectNotUndoable(rig);

  // The second call: the oracle over the byes as they now stand names the next one — a different line, never a seat in round 2.
  const storedNow = storedByeLines(after);
  expect(storedNow.length, "premise: the first add reversed exactly one bye").toBe(stored.length - 1);
  const want2 = rb4L4ExpectedLine(storedNow, seeds, round1.length)!;
  expect(want2, "premise: the second newcomer's bye is another line").not.toBe(want);
  const holder2 = storedNow.find((l) => l.lineId === want2)!.holderId;
  const idsBefore2 = await entrantIds(rig.divisionId);
  const late2 = await addLate(rig, "Late 2");
  expect(late2.late_entry, "a second add takes the next-lowest bye").toMatchObject({ case: "bye", fixture_id: want2, opponent_id: holder2 });
  await expectLateIsTheEntrant(rig, idsBefore2, late2.id);
  await expectOnlyRoundOneSeat(rig, late2.id);
  expect(seatHolds(await rowById(want), late.id), "the first newcomer's match stands").toBe(true);

  // The seam through its consumer: the newcomer wins the line and the scorer carries them into the next one.
  await winAndAdvance(rig, want, late.id);
}

/** (withdrawn_slot) RB4-L5: no bye in the field; a round-1 player withdrew and the withdrawal walked the line over — the
 *  newcomer takes the withdrawn seat, the walkover is reversed and its winner leaves round 2. */
async function cellWithdrawnSlot(rig: Rig): Promise<void> {
  expect(storedByeLines(await rowsOf(rig.rootId)).length, "premise: a bracket of a power of two holds no bye").toBe(0);
  const line0 = (await rowsOf(rig.rootId)).find((r) => r.round_no === 1 && r.seq_in_round === 2)!;
  const gone = line0.home_entrant_id!;
  const opp = line0.away_entrant_id!;
  await withdrawEntrantCascade(rig.auth, gone);
  const walked = await rowById(line0.id);
  expect(walked.outcome, "premise: the withdrawal walked the line over to the opponent").toMatchObject({ kind: "award", reason: "withdrew", winner: opp });
  const next0 = await rowById(line0.winner_to_fixture!);
  expect(seatHolds(next0, opp), "premise: the walkover winner sits in round 2").toBe(true);
  const before = await rowsOf(rig.rootId);
  const tailBefore = await tailRowsOf(rig);
  const idsBefore = await entrantIds(rig.divisionId);

  const late = await addLate(rig, "Late");
  expect(late.late_entry, "RB4-L5: the newcomer takes the withdrawn seat").toMatchObject({
    format: "knockout",
    case: ANSWER_OF.withdrawn_slot,
    entrant_id: late.id,
    stage_id: rig.rootId,
    fixture_id: line0.id,
    opponent_id: opp,
  });
  await expectLateIsTheEntrant(rig, idsBefore, late.id);
  const after = await rowsOf(rig.rootId);
  const line = after.find((r) => r.id === line0.id)!;
  expect({ home: line.home_entrant_id, away: line.away_entrant_id, status: line.status, outcome: line.outcome }, "the newcomer sits the departed seat").toEqual({
    home: late.id,
    away: opp,
    status: "scheduled",
    outcome: null,
  });
  const next = after.find((r) => r.id === next0.id)!;
  expect(seatHolds(next, opp), "the walkover winner is taken back out of round 2").toBe(false);
  const [{ live }] = await sql<{ live: number }[]>`
    select count(*)::int as live from score_events e
     where e.fixture_id = ${line0.id} and e.type <> 'core.void'
       and not exists (select 1 from score_events v where v.voids_event_id = e.id)`;
  expect(live, "the withdrawal's walkover is voided: nothing live on the line").toBe(0);
  expectOthersUnchanged(before, after, new Set([line0.id, next0.id]), "RB4-L5 nothing else moves");
  expect(await tailRowsOf(rig), "RB4-L2: the tail stands").toEqual(tailBefore);
  await expectOnlyRoundOneSeat(rig, late.id);
  expect((await lateRows(rig.divisionId)).map((p) => [p.entrant_id, p.case, p.source]), "one ledger row").toEqual([[late.id, "withdrawn_slot", "organiser"]]);
  await expectUnscheduled(late.late_entry, line0.id);
  await expectNotUndoable(rig);

  // The second call: the seat is taken and no bye is left — refused by name, nothing written. Still a 409 after RB4-L6's
  // "kept, Rebuild offered" (B6a fix round 1): RB4-L9 — a withdrawal's forfeit is a score event, so the stage has started
  // and Rebuild is not offered (`can_rebuild: false`).
  const snap = await snapshot(rig);
  const err = await refusal(addLate(rig, "Late 2"));
  expect(err).toMatchObject({ status: 409, code: "KO_LATE_ENTRY_NO_SLOT", message: NO_SLOT });
  expect(err.extra, "the stage has started: no Rebuild, so the add is refused rather than kept").toMatchObject({ can_rebuild: false });
  await expectNothingWritten(rig, snap, "a second add after the slot is taken");

  await winAndAdvance(rig, line0.id, late.id);
}

/** Round 1 played out through the scorer: every line decided (the home side wins), round 2 seated and not started. */
async function playRoundOne(rig: Rig): Promise<void> {
  const lines = roundOf(await rowsOf(rig.rootId), 1);
  expect(lines.length, "premise: round 1 has lines to play").toBeGreaterThan(0);
  for (const f of lines) await win(rig, f, f.home_entrant_id!);
  const after = await rowsOf(rig.rootId);
  expect(roundOf(after, 1).map((f) => f.status), "rig: round 1 is decided").toEqual(roundOf(after, 1).map(() => "decided"));
  const r2 = roundOf(after, 2);
  expect(r2.every((f) => f.home_entrant_id !== null && f.away_entrant_id !== null), "rig: round 2 is seated").toBe(true);
  expect(r2.map((f) => f.status), "rig: nothing of round 2 has started").toEqual(r2.map(() => "scheduled"));
}

/** The organiser's add finds no slot. Once a match has started (`canRebuild` false) it is refused by name (409
 *  `NO_SLOT`, `can_rebuild: false`) and writes nothing; with nothing started (RB4-L6, B6a fix round 1, owner ruling) it is
 *  KEPT and waits, answering 201 `rebuild_offered`. Then the same field gets an AUTOMATIC arrival: it waits, and the tap
 *  answers (a 200, not an error) the same refusal as a case, the player still waiting. Answers every waiting entrant, the
 *  arrival last. */
async function refusedThenArrival(rig: Rig, canRebuild: boolean): Promise<string[]> {
  const snap = await snapshot(rig);
  const waiting: string[] = [];
  if (canRebuild) {
    const late = await addLate(rig, "Late");
    expect(late.late_entry, "RB4-L6: no slot, nothing started — the add is kept and offers Rebuild").toMatchObject({
      format: "knockout",
      case: ANSWER_OF.rebuild_offered,
      entrant_id: late.id,
      stage_id: rig.rootId,
      reason: "KO_LATE_ENTRY_NO_SLOT",
    });
    expect(late.late_entry?.fixture_id, "nothing was placed").toBeUndefined();
    await expectLateIsTheEntrant(rig, snap.ids, late.id);
    expect(await waitingOn(late.id), "the kept player waits on the root").toBe(rig.rootId);
    expect(await seatedIn(late.id), "seated nowhere").toEqual([]);
    expect(await ledgerCount(rig.divisionId), "a kept add: no ledger row").toBe(snap.ledger);
    expect(await rowsOf(rig.rootId), "a kept add: the root stands").toEqual(snap.root);
    expect(await tailRowsOf(rig), "a kept add: the tail stands").toEqual(snap.tail);
    waiting.push(late.id);
  } else {
    const err = await refusal(addLate(rig, "Late"));
    expect(err, "RB4-L6: refused by name").toMatchObject({ status: 409, code: "KO_LATE_ENTRY_NO_SLOT", message: NO_SLOT });
    expect(err.extra, "Rebuild is offered only while nothing in the stage has started").toMatchObject({ can_rebuild: false, stage_id: rig.rootId });
    await expectNothingWritten(rig, snap, "a refused add");
  }

  const idsBefore = await entrantIds(rig.divisionId);
  const arrival = await registerAndConfirm(rig, "Arrival");
  await expectLateIsTheEntrant(rig, idsBefore, arrival);
  expect(await waitingOn(arrival), "RB4-L10: the arrival waits on the root").toBe(rig.rootId);
  expect(await rowsOf(rig.rootId), "the root stands").toEqual(snap.root);
  const ledgerAfterArrival = await ledgerCount(rig.divisionId);
  expect(ledgerAfterArrival, "waiting is no placement: no ledger row").toBe(snap.ledger);

  const answer = await placeWaitingKnockoutEntrant(rig.auth, rig.rootId, arrival);
  expect(answer, "RB4-L10: a refusal is an answer, never an error").toMatchObject({
    format: "knockout",
    case: canRebuild ? ANSWER_OF.rebuild_offered : ANSWER_OF.refused,
    entrant_id: arrival,
    stage_id: rig.rootId,
    reason: "KO_LATE_ENTRY_NO_SLOT",
  });
  expect(answer.fixture_id, "nothing was placed").toBeUndefined();
  expect(await waitingOn(arrival), "the player keeps waiting").toBe(rig.rootId);
  expect(await seatedIn(arrival), "seated nowhere").toEqual([]);
  expect(await rowsOf(rig.rootId), "the root stands").toEqual(snap.root);
  expect(await ledgerCount(rig.divisionId), "no ledger row").toBe(ledgerAfterArrival);
  waiting.push(arrival);
  expect(await deskLate(rig), "the desk still counts every waiting player").toEqual([
    { kind: "late_players_waiting", count: canRebuild ? 2 : 1, stageName: rig.rootName },
  ]);
  return waiting;
}

/** (refused) RB4-L6: round 1 is played out — no bye, no withdrawn seat. Refused by name, no Rebuild (the stage has started). */
async function cellRefused(rig: Rig): Promise<void> {
  await playRoundOne(rig);
  expect(storedByeLines(await rowsOf(rig.rootId)).length, "premise: no bye line").toBe(0);
  await refusedThenArrival(rig, false);
}

/** (rebuild_offered) RB4-L6: drawn, nothing started, no slot — the organiser's add is kept with Rebuild offered, and an
 *  automatic arrival waits beside it. Following the offer: Rebuild draws every active entrant, both waiting ones among them,
 *  and the flags go with it. */
async function cellRebuildOffered(rig: Rig): Promise<void> {
  expect(storedByeLines(await rowsOf(rig.rootId)).length, "premise: no bye line").toBe(0);
  const waiting = await refusedThenArrival(rig, true);
  expect(waiting.length, "premise: the kept add and the arrival both wait").toBe(2);

  await rebuildStageFixtures(rig.auth, rig.rootId);
  const field = await entrantIds(rig.divisionId);
  expect(field.size, "premise: the field is the roster plus the kept add and the arrival").toBe(rig.n + 2);
  const seated = roundOf(await rowsOf(rig.rootId), 1).flatMap((f) => [f.home_entrant_id, f.away_entrant_id]).filter((x): x is string => x !== null);
  expect(seated.length, "Rebuild seats every active entrant once (a bye line seats one)").toBe(field.size);
  expect(new Set(seated), "the field is the seated set").toEqual(field);
  for (const w of waiting) {
    expect(seated, "every waiting player is seated by the Rebuild").toContain(w);
    expect(await waitingOn(w), "the flag goes with it").toBeNull();
  }
  expect(await deskLate(rig), "the desk row goes").toEqual([]);
  expect(roundOf(await rowsOf(rig.rootId), 1).length, "round 1 of the bracket of the new field").toBe(bracketSize(rig.n + 2) / 2);
}

/** (automatic_waiting) RB4-L10: an automatic arrival (a registration confirm) never reshapes a drawn bracket: the entrant waits
 *  with a desk flag even though a bye is open, and is never refused. A second arrival is a second waiting player. */
async function cellAutomaticWaiting(rig: Rig): Promise<void> {
  const before = await rowsOf(rig.rootId);
  expect(storedByeLines(before).length, "premise: a bye is open — an organiser's add WOULD be placed").toBeGreaterThan(0);
  const tailBefore = await tailRowsOf(rig);
  const ledger = await ledgerCount(rig.divisionId);
  const idsBefore = await entrantIds(rig.divisionId);

  const arrival = await registerAndConfirm(rig, "Arrival");
  await expectLateIsTheEntrant(rig, idsBefore, arrival);
  expect(await waitingOn(arrival), "waits on the entry stage").toBe(rig.rootId);
  expect(await seatedIn(arrival), "seated nowhere").toEqual([]);
  expect(await rowsOf(rig.rootId), "the bracket stands: nothing moved").toEqual(before);
  expect(await tailRowsOf(rig), "RB4-L2: the tail stands").toEqual(tailBefore);
  expect(await ledgerCount(rig.divisionId), "no ledger row: the wait is no placement").toBe(ledger);
  expect(await deskLate(rig), "the desk says so").toEqual([{ kind: "late_players_waiting", count: 1, stageName: rig.rootName }]);

  // The second call: a second arrival is a second flag, the first untouched.
  const second = await registerAndConfirm(rig, "Arrival 2");
  expect(await waitingOn(second)).toBe(rig.rootId);
  expect(await waitingOn(arrival), "the first still waits").toBe(rig.rootId);
  expect(await rowsOf(rig.rootId), "still nothing moved").toEqual(before);
  expect(await deskLate(rig), "two players wait").toEqual([{ kind: "late_players_waiting", count: 2, stageName: rig.rootName }]);
}

/** (automatic_tapped) RB4-L10: the same arrival, then the organiser's ONE tap runs the cases "Add late player" runs. */
async function cellAutomaticTapped(rig: Rig): Promise<void> {
  const before = await rowsOf(rig.rootId);
  const stored = storedByeLines(before);
  expect(stored.length, "premise: a bye is open").toBeGreaterThan(0);
  const round1 = roundOf(before, 1);
  const want = rb4L4ExpectedLine(stored, await seedsOf(rig.divisionId), round1.length)!;
  expect(want, "premise: a differential case — RB4-L4's bye is not the first bye").not.toBe([...stored].sort((a, b) => a.seq - b.seq)[0]!.lineId);
  const holder = stored.find((l) => l.lineId === want)!.holderId;
  const line0 = before.find((r) => r.id === want)!;
  const next0 = before.find((r) => r.id === line0.winner_to_fixture)!;
  const tailBefore = await tailRowsOf(rig);

  const idsBeforeArrival = await entrantIds(rig.divisionId);
  const arrival = await registerAndConfirm(rig, "Arrival");
  await expectLateIsTheEntrant(rig, idsBeforeArrival, arrival);
  expect(await waitingOn(arrival), "premise: the arrival waits").toBe(rig.rootId);
  expect((await deskLate(rig))[0], "premise: the desk flags it").toMatchObject({ count: 1 });
  const idsBefore = await entrantIds(rig.divisionId);
  expect(idsBefore.has(arrival), "premise: the arrival is on the list").toBe(true);

  const placed = await placeWaitingKnockoutEntrant(rig.auth, rig.rootId, arrival);
  expect(placed, "one tap places the arrival on the lowest-seeded bye").toMatchObject({
    format: "knockout",
    case: ANSWER_OF.automatic_tapped,
    entrant_id: arrival,
    stage_id: rig.rootId,
    fixture_id: want,
    opponent_id: holder,
  });
  expect(await entrantIds(rig.divisionId), "the tap adds no entrant").toEqual(idsBefore);
  const after = await rowsOf(rig.rootId);
  const line = after.find((r) => r.id === want)!;
  expect(new Set([line.home_entrant_id, line.away_entrant_id]), "the arrival plays the holder").toEqual(new Set([holder, arrival]));
  expect({ status: line.status, outcome: line.outcome }).toEqual({ status: "scheduled", outcome: null });
  expect(seatHolds(after.find((r) => r.id === next0.id)!, holder), "the holder is taken back out of round 2").toBe(false);
  expectOthersUnchanged(before, after, new Set([want, next0.id]), "the tap moves only the bye and its next line");
  expect(await tailRowsOf(rig), "RB4-L2: the tail stands").toEqual(tailBefore);
  await expectOnlyRoundOneSeat(rig, arrival);
  expect(await waitingOn(arrival), "the marker clears").toBeNull();
  expect(await deskLate(rig), "the desk row goes").toEqual([]);
  expect((await lateRows(rig.divisionId)).map((p) => [p.entrant_id, p.case, p.source]), "one ledger row, by the organiser's tap").toEqual([
    [arrival, "bye", "organiser"],
  ]);
  await expectUnscheduled(placed, want);
  await expectNotUndoable(rig);

  // The second call: the player no longer waits — a second tap is refused by name and moves nothing.
  const snap = await snapshot(rig);
  const err = await refusal(placeWaitingKnockoutEntrant(rig.auth, rig.rootId, arrival));
  expect(err).toMatchObject({ status: 409, code: "KO_LATE_ENTRY_NOT_WAITING", message: NOT_WAITING });
  await expectNothingWritten(rig, snap, "a second tap");

  await winAndAdvance(rig, want, arrival);
}

const CELL: Record<CaseKey, (rig: Rig) => Promise<void>> = {
  bye: cellBye,
  withdrawn_slot: cellWithdrawnSlot,
  refused: cellRefused,
  rebuild_offered: cellRebuildOffered,
  automatic_waiting: cellAutomaticWaiting,
  automatic_tapped: cellAutomaticTapped,
};

/** The rulebook ids each case answers, carried in the cell titles (the plan's id-as-a-token rule). */
const RULES_OF: Record<CaseKey, string> = {
  bye: "X-LE-3 X-LE-4 X-LE-7 X-LE-11 X-LE-12 X-LE-13",
  withdrawn_slot: "X-LE-5 X-LE-7 X-LE-11 X-LE-12 X-LE-13",
  refused: "X-LE-6 X-LE-10 X-LE-11",
  rebuild_offered: "X-LE-6 X-LE-10 X-LE-11",
  automatic_waiting: "X-LE-10 X-LE-11",
  automatic_tapped: "X-LE-3 X-LE-4 X-LE-7 X-LE-10 X-LE-11 X-LE-12 X-LE-13",
};

// ─── The matrix ──────────────────────────────────────────────────────────────────────────────────────────────────────

// The ids sit in this STRING-LITERAL title because scripts/lib/rules-reference.ts `testTitles` reads only literal titles: the
// cell titles below interpolate (`${template} × ${kind} … ${RULES_OF[c]}`), so the proof checker sees none of the ids they
// carry. RULES_OF names which CASE answers which id; this title is the union of it. Add an id to RULES_OF → add it here.
describe.runIf(HAS_DB)("X-LE-3 X-LE-4 X-LE-5 X-LE-6 X-LE-7 X-LE-10 X-LE-11 X-LE-12 X-LE-13 matrix: every entry template × every entrant kind × case (bye/withdrawn/refused/rebuild/automatic)", () => {
  it("what is enumerated: the three entry templates, every entrant kind on a sport that declares it, six cases", () => {
    expect([...ENTRY_TEMPLATES].sort(), "re-pinned from format-templates.ts").toEqual(["knockout", "ko_plate", "qualifying_main"]);
    expect([...KINDS].sort(), "V212's entrant kinds").toEqual(["individual", "pair", "team"]);
    for (const k of KINDS) {
      const s = sportOf(k);
      expect(s.module.entrantModel?.kinds ?? ["individual"], `${s.key} declares '${k}'`).toContain(k);
    }
    // Chess is individual-only (owner ruling 2026-10-26): its module declares nothing else.
    expect(sportOf("individual").module.entrantModel?.kinds).toEqual(["individual"]);
    expect(new Set(KINDS.map((k) => sportOf(k).key)).size, "a sport per kind").toBe(KINDS.length);
    expect(EVERY_ANSWER_CASED, "every answer a late knockout entrant can get has a case").toBe(true);
    expect(new Set(CASES).size, "six distinct cases").toBe(6);
    // Every rig is at least as large as the gates the T15 doors enforce (the smallest field ko_plate / qualifying_main starts at).
    for (const c of CASES) expect(N_OF[c], `${c}'s field clears the format gates`).toBeGreaterThanOrEqual(Math.max(5, QUALIFYING_MAIN_MIN));
    expect(Object.keys(N_OF).sort(), "a field per case").toEqual([...CASES].sort());
  });

  // T12 review carry: the literal title above is what the proof checker reads, and RULES_OF is what the cells prove. This `it` reads
  // the title the runner is RUNNING under (`currentTestName` is "<describe title> <this title>") and requires its X-LE ids to be
  // exactly the union of RULES_OF, so neither can drift from the other. This `it`'s own title carries no id.
  it("the ids in the describe title are exactly the union of the ids the cases answer", () => {
    const ID = /X-LE-\d+/g;
    const inTitle = new Set(expect.getState().currentTestName?.match(ID) ?? []);
    const proved = new Set(Object.values(RULES_OF).flatMap((ids) => ids.match(ID) ?? []));
    expect(Object.keys(RULES_OF).sort(), "an id list per case").toEqual([...CASES].sort());
    expect(proved.size, "ids the cases answer").toBeGreaterThan(0);
    expect(inTitle.size, "ids in the title").toBeGreaterThan(0);
    expect([...inTitle].sort(), `title ids (${inTitle.size}) = RULES_OF ids (${proved.size})`).toEqual([...proved].sort());
  });

  const checked = new Set<string>();
  for (const template of ENTRY_TEMPLATES) {
    for (const kind of KINDS) {
      for (const c of CASES) {
        it(`${template} × ${kind} (${sportOf(kind).key}) × (${c}) ${RULES_OF[c]}`, async () => {
          const rig = await templateRig(template, kind, N_OF[c]);
          expect(rig.tailId === null, `premise: ${template}'s stage graph decides whether a stage is fed from the root`).toBe(template === "knockout");
          await CELL[c](rig);
          checked.add(`${template}|${kind}|${c}`);
        });
      }
    }
  }

  // Runs after every cell (a file's tests run in order). A `-t` slice that skips cells reds it: a partial sweep is not a sweep.
  it("anti-vacuity: every cell enumerated was checked (templates × kinds × cases), and zero is a failure", () => {
    expect(checked.size, "cells checked").toBeGreaterThan(0);
    expect(checked.size, "cells checked = templates × kinds × cases").toBe(ENTRY_TEMPLATES.length * KINDS.length * CASES.length);
    expect(ENTRY_TEMPLATES.length * KINDS.length * CASES.length, "3 × 3 × 6").toBe(54);
    // X-LE-11 was proven in every cell of every kind (at least once per cell), and a pair really is two members in one entrant.
    for (const k of KINDS) {
      expect(lateIsTheEntrantChecks.get(k) ?? 0, `${k}: the late entrant was proven to be the entrant, once per cell at least`).toBeGreaterThanOrEqual(
        ENTRY_TEMPLATES.length * CASES.length,
      );
    }
    expect([seatsOf("individual"), seatsOf("pair")], "a pair is two members in ONE entrant; an individual is one").toEqual([1, 2]);
  });
});

// ─── Fed tails: the knockout a table feeds never seats a late entrant (RB4-L2, X-LE-2) ──────────────────────────────────

/** What a late add to each fed template does, from the rulebook (RB4-L2): league and groups have no late-entry rule yet (W5),
 *  so the add is the Start lock's refusal; a Swiss takes the entrant itself (ruling 250), never its knockout. */
const FED_OUTCOME: Record<string, "locked" | "joins_swiss"> = {
  league_ko: "locked",
  groups_ko: "locked",
  swiss_knockout: "joins_swiss",
};

describe.runIf(HAS_DB)("X-LE-2 fed tails: league_ko, groups_ko, swiss_knockout never seat a late entrant in the knockout", () => {
  it("what is enumerated: the three fed templates, each with a declared outcome", () => {
    expect([...FED_TEMPLATES].sort(), "re-pinned from format-templates.ts").toEqual(["groups_ko", "league_ko", "swiss_knockout"]);
    expect(Object.keys(FED_OUTCOME).sort(), "an outcome per fed template").toEqual([...FED_TEMPLATES].sort());
  });

  const checked = new Set<string>();
  const refused = new Set<string>();
  const joined = new Set<string>();
  for (const template of FED_TEMPLATES) {
    for (const kind of KINDS) {
      it(`${template} × ${kind} (${sportOf(kind).key}) the knockout never seats a late entrant X-LE-2 X-LE-10 X-LE-11`, async () => {
        const rig = await templateRig(template, kind, 6);
        expect(rig.tailId, `premise: ${template} has a knockout after its first stage`).not.toBeNull();
        const knockoutId = rig.tailId!;
        const tailBefore = await tailRowsOf(rig);
        expect(tailBefore.length, "premise: the knockout's day-one bracket is laid out").toBeGreaterThan(0);
        const [tail] = await sql<{ kind: string }[]>`select kind from stages where id = ${knockoutId}`;
        expect(tail!.kind, "premise: the second stage is the fed knockout").toBe("knockout");
        const snap = await snapshot(rig);

        if (FED_OUTCOME[template] === "locked") {
          const err = await refusal(addLate(rig, "Late"));
          expect(err, "the table-fed list is locked").toMatchObject({ status: 422, message: LOCKED });
          await expectNothingWritten(rig, snap, `${template}: a refused add`);
          refused.add(`${template}|${kind}`);
        } else {
          const [late] = await createEntrants(rig.auth, rig.divisionId, [entrantInput(kind, "Late")]);
          expect(late!.late_entry, "the answer is the Swiss's, by format").toMatchObject({ format: "swiss", stage_id: rig.rootId });
          expect(await seatedIn(late!.id), "never seated in the knockout").not.toContain(knockoutId);
          joined.add(`${template}|${kind}`);
        }
        expect(await tailRowsOf(rig), "the knockout stands: it seats no late entrant").toEqual(tailBefore);

        // An automatic arrival: never a waiting flag on a fed knockout (it is no entry stage), seated nowhere in it.
        const arrival = await registerAndConfirm(rig, "Arrival");
        expect(await waitingOn(arrival), "RB4-L2: no flag points at a fed knockout").toBeNull();
        expect(await deskLate(rig), "the desk raises no late-player row").toEqual([]);
        expect(await tailRowsOf(rig), "the knockout still stands").toEqual(tailBefore);
        expect(await seatedIn(arrival), "never seated in the knockout").not.toContain(knockoutId);
        checked.add(`${template}|${kind}`);
      });
    }
  }

  it("anti-vacuity: every fed template × kind was checked, and the outcome split is the declared one", () => {
    expect(checked.size, "cells checked").toBeGreaterThan(0);
    expect(checked.size, "templates × kinds").toBe(FED_TEMPLATES.length * KINDS.length);
    expect(refused.size, "league_ko and groups_ko refuse").toBe(KINDS.length * Object.values(FED_OUTCOME).filter((o) => o === "locked").length);
    expect(joined.size, "swiss_knockout joins its Swiss").toBe(KINDS.length * Object.values(FED_OUTCOME).filter((o) => o === "joins_swiss").length);
    expect(refused.size + joined.size, "every cell fell in exactly one bucket").toBe(checked.size);
  });
});

// ─── Every sport: the placement itself reads no sport field ──────────────────────────────────────────────────────────────

describe.runIf(HAS_DB)("X-LE-3 X-LE-5 the placement is sport-blind: every registry sport takes the bye and the withdrawn seat", () => {
  /** A sport's natural entrant kind and first variant. */
  const kindOf = (m: AnySportModule): Kind => (m.entrantModel?.defaultKind ?? "individual") as Kind;

  const checked = new Set<string>();
  for (const m of builtinModules) {
    const sport = pickOf(m as AnySportModule);
    const kind = kindOf(m as AnySportModule);
    it(`${m.key} (${kind}) knockout: case (1) takes the lowest-seeded bye, case (2) the withdrawn seat X-LE-3 X-LE-5`, async () => {
      // Case (1): odd field.
      const byeRig = await templateRig("knockout", kind, 5, sport);
      const before = await rowsOf(byeRig.rootId);
      const stored = storedByeLines(before);
      expect(stored.length, "premise: three byes in a bracket of eight").toBe(3);
      const want = rb4L4ExpectedLine(stored, await seedsOf(byeRig.divisionId), roundOf(before, 1).length)!;
      const late = await addLate(byeRig, "Late");
      expect(late.late_entry, `${m.key}: the lowest-seeded holder's bye`).toMatchObject({ case: "bye", fixture_id: want, opponent_id: stored.find((l) => l.lineId === want)!.holderId });

      // Case (2): a bracket of eight, one withdrawal.
      const slotRig = await templateRig("knockout", kind, 8, sport);
      const line0 = (await rowsOf(slotRig.rootId)).find((r) => r.round_no === 1 && r.seq_in_round === 2)!;
      await withdrawEntrantCascade(slotRig.auth, line0.home_entrant_id!);
      const late2 = await addLate(slotRig, "Late");
      expect(late2.late_entry, `${m.key}: the withdrawn seat`).toMatchObject({ case: "withdrawn_slot", fixture_id: line0.id, opponent_id: line0.away_entrant_id });
      expect(await rowById(line0.id), "the newcomer sits the departed seat").toMatchObject({ home_entrant_id: late2.id, away_entrant_id: line0.away_entrant_id });
      checked.add(m.key);
    });
  }

  it("anti-vacuity: every sport of the registry was checked", () => {
    expect(builtinModules.length, "the registry is not empty").toBeGreaterThan(0);
    expect(checked.size, "sports checked").toBeGreaterThan(0);
    expect([...checked].sort(), "every registry sport").toEqual(builtinModules.map((m) => m.key).sort());
  });
});
