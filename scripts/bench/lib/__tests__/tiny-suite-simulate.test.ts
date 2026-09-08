// B05 T1 — proves `runTinySuite` actually DRIVES division A's streams
// through the single-event scoring route end to end against the REAL
// committed `_tiny.json` pack: removing the
// `if (input.sql !== undefined) { ... simulateDivisionStreams(...) ... }`
// block in `lib/suites/tiny.ts` reds a test here (AGENTS.md recurring-
// failure class 1 — "the inert seam", which is this whole task's reason to
// exist: `seed.ts`'s `bindStreamFixtures` has resolved every stream's real
// fixture id since B03 and NOTHING ever read `.events` until now).
//
// A fresh, self-contained fake — same "minimize blast radius outside what
// THIS task owns" precedent `tiny-suite-stats.test.ts`'s own header comment
// gives for not extending `tiny-suite.test.ts`'s shared `makeFakeServer()`.
// This one is `tiny-suite-stats.test.ts`'s own `fakeServer` COPIED VERBATIM
// (its `request()` surface already answers everything `input.sql` present
// unconditionally drives — the DLS-gate probe, officials/claims seeding —
// against the real `_tiny.json` pack), with exactly one addition: a
// `conflictAt` knob on `raw()` so one test can prove a refusal actually
// reaches `report.errors`/`report.gate`, not just `simulate.ts`'s own unit
// suite (which already covers the fold logic exhaustively).
import { describe, expect, it } from "vitest";
import pino from "pino";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RawResult, Session } from "../http.ts";
import type { ProbeTransport } from "../dls-gate.ts";
import type { PlanEntitlementRow, PlanSql } from "../plan.ts";
import { runTinySuite, TINY_PACK_PATH } from "../suites/tiny.ts";
import { makeScheduleWorld } from "./_schedule-routes.ts";
import { makeDivisionPhaseWorld } from "./_division-phase.ts";
import { makeAdvanceRoutesWorld } from "./_advance-routes.ts";
import type { DivisionCardSource, DivisionPlayerStatsLike } from "./_oracle-routes.ts";
import {
  makeOracleRoutesWorld,
  personCareerStatsFromDivisions,
  personStatsFromDivisions,
  tinyDivisionPlayerStats,
  tinyLeagueTableRows,
} from "./_oracle-routes.ts";
import { roundRobinRoundCount } from "./_roundrobin-rounds.ts";

const silent = pino({ level: "silent" });

interface RecordedCall {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

function fakeServer(
  opts: {
    conflictAt?: { extKey: string; expectedSeq: number };
    /** B05 T3 regression — the seed-proposal answers with the WRONG order
     *  (reversed), so D7's assertion should red and neither confirm,
     *  generate nor the playoff's own stream fold should ever be attempted. */
    reverseAdvanceQualifiers?: boolean;
    /** B05 T4 regression — `GET /stages/{id}/standings` answers with the
     *  final order REVERSED, independent of `reverseAdvanceQualifiers`
     *  above (that one is read by the SEED PROPOSAL for `s-league` ->
     *  `s-playoff`; this one is read by the runtime oracle's re-fetch of
     *  `s-playoff`'s OWN completed standings). Proves the oracle step is a
     *  real wire read, not a restatement of the captured `complete`
     *  response: with this set, the captured response still says
     *  [e-alpha, e-bravo] but the re-read standings say the opposite. */
    wrongFinalStandingsOrder?: boolean;
    /** B05 T4b regression — `GET /stages/{id}/standings` answers `d-badminton`'s
     *  own league table with ZERO rows (as if nothing ever folded into it),
     *  proving `compareStandings`'s empty-case discipline through the WIRING:
     *  an empty `actual` against a non-empty `expected.tables` row must red,
     *  never vacuously pass. */
    emptyBadmintonStandings?: boolean;
    /** B05 T5a review MINOR — `GET /divisions/{id}/stats/players` answers
     *  `d-tiny`'s division with ZERO rows (the same empty shape
     *  `oracle.test.ts`'s own unit test uses) instead of this fake's real
     *  live tally, proving `compareLeaderboard`'s empty-case discipline
     *  through the WIRING — symmetric with `emptyBadmintonStandings` above. */
    emptyLeaderboard?: boolean;
    /** B05 T5b — `GET /persons/{id}/stats?group=sport` answers an EMPTY
     *  `sports` array (a person the rollup found nothing for) while every
     *  other read stays honest, proving `compareCareerStats`'s empty case
     *  through the WIRING: an empty rollup against a non-empty
     *  `expected.careers` must red, never vacuously pass. Scoped to the
     *  career route alone so the per-division cards keep passing — a sibling
     *  oracle reddening alongside it would not be coverage of this one. */
    emptyCareerSports?: boolean;
    /** B05 T5b — `GET /persons/{id}/stats` answers an EMPTY `divisions`
     *  array while the division leaderboard read stays honest, proving
     *  `comparePersonDivisionStat`'s absent-division case through the
     *  WIRING. Symmetric with `emptyCareerSports`, and equally scoped: the
     *  leaderboard oracle for the same board must still pass. */
    emptyPersonDivisions?: boolean;
  } = {},
): {
  transport: ProbeTransport;
  sql: PlanSql;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const dlsByDivisionId = new Map<string, boolean>();
  const legsByStageId = new Map<string, number>();
  // B05 T3 — d-tiny now declares a second, non-league stage (s-playoff, a
  // knockout fed from the league). `/generate` needs to know which shape to
  // mint: this fake's own round-robin arithmetic assumes every stage is a
  // league, which was true of every pack this file drove before this task.
  const kindByStageId = new Map<string, string>();
  const divisionIdByStageId = new Map<string, string>();
  // B05 T4b — the name `_oracle-routes.ts`'s `tinyLeagueTableRows` keys its
  // real (non-placement) standings fixture on: the `/stages` POST body's
  // own `name` field (`seed.ts`), never a pack ref this fake never sees.
  // `divisionNameById` is this file's OWN discriminator for
  // `getDivisionPlayerStats` below (is this division "Tiny"?).
  const stageNameById = new Map<string, string>();
  const divisionNameById = new Map<string, string>();
  // B05 T5b — the `sport_key` the SAME `POST /competitions/{id}/divisions`
  // body already carries (`seed.ts:614`). Read off the wire rather than
  // guessed, because `personCareerStats` files a person's divisions UNDER
  // their sport and `compareCareerStats` reds on a metric key found in more
  // than one sport.
  const divisionSportById = new Map<string, string>();
  const fixtureDivisionId = new Map<string, string>();
  // B05 T2.5 (D9) — see `_division-phase.ts`'s own header comment: EVERY
  // `sql`-passing fake now reaches `/start`/`GET /divisions/{id}`
  // unconditionally, and phase-gating `/fixtures/{id}/events` here is what
  // makes this file's own "clean fold" assertions a real regression against
  // the start step being wired in, rather than a test that only proves the
  // fold function exists.
  const phase = makeDivisionPhaseWorld();
  const fixtureExtKeyById = new Map<string, string>();
  const fixtureOfficials = new Map<string, unknown[]>();
  const claimInvites = new Map<string, unknown>();
  // B05 T4b — D6's OWN mis-attribution regression, run through the WIRED
  // leaderboard oracle rather than only a unit fixture: this fake TALLIES
  // real `generic.score` events as they land on `/fixtures/{id}/events`
  // (never a hardcoded constant), so `GET /divisions/{id}/stats/players`
  // answers with whatever the pack's OWN streams actually produced —
  // exactly what a mis-transcribed `payload.person` would change.
  const personNameById = new Map<string, string>();
  const personScoreTally = new Map<string, { scores: number; points: number }>();
  let divisionCounter = 0;
  let stageCounter = 0;
  let fixtureCounter = 0;
  let entitled = false;

  const schedule = makeScheduleWorld({ solverEngine: "optimized" });
  // B05 T3 — see `_advance-routes.ts`'s own header comment: EVERY
  // `sql`-passing fake now reaches the advancement routes unconditionally,
  // because `_tiny.json`'s own `s-playoff` always declares a `progression`.
  // This file is not ABOUT advancement; it exists so this file's OWN
  // "clean fold, gate green" assertions stay green rather than reddening on
  // an unmodeled route.
  const advanceRoutes = makeAdvanceRoutesWorld({
    getQualifiers: (stageId) => {
      const divisionId = divisionIdByStageId.get(stageId);
      if (divisionId === undefined) return undefined;
      const entrants = schedule.entrantsOfDivision(divisionId);
      return opts.reverseAdvanceQualifiers === true ? [...entrants].reverse() : entrants;
    },
  });
  // B05 T4 — the runtime oracle's own route (`GET /stages/{id}/standings`),
  // unconditionally reached once `s-playoff` completes. This world reports
  // the REAL entrant order regardless of `reverseAdvanceQualifiers` above —
  // that knob feeds the SEED PROPOSAL a wrong order to prove D7 stops the
  // flow before `complete` is ever called, so the oracle step (which only
  // runs once `complete` has actually been captured) never reaches this
  // route in that scenario either way.
  // B05 T5b — division player stats, hoisted out of the world literal below
  // so the person-stats routes can derive their own answers from the SAME
  // source. `d-tiebreak` ("Tiebreak") also carries `expected.leaderboards`
  // rows since T5b-1 gave `expected.careers` a second division to roll up;
  // its own streams fold through `/events/import` (this file's pass-through
  // branch, which tallies nothing), so it takes `_oracle-routes.ts`'s shared
  // committed fixture rather than the live tally — only division A's fold is
  // tallied here.
  const honestDivisionPlayerStats = (divisionId: string): DivisionPlayerStatsLike | undefined => {
    const divisionName = divisionNameById.get(divisionId);
    if (divisionName === undefined) return undefined;
    if (divisionName !== "Tiny") {
      return tinyDivisionPlayerStats(divisionName, (fullName) => `person-${slug(fullName)}`);
    }
    return {
      metrics: [
        { key: "scores", label: "Scores" },
        { key: "points", label: "Points" },
      ],
      rows: [...personScoreTally.entries()].map(([personId, tally]) => ({
        person_id: personId,
        full_name: personNameById.get(personId) ?? personId,
        stats: { scores: tally.scores, points: tally.points },
      })),
      requires_detailed_scoring: false,
    };
  };
  const divisionPlayerStatsFor = (divisionId: string): DivisionPlayerStatsLike | undefined => {
    if (opts.emptyLeaderboard === true && divisionNameById.get(divisionId) === "Tiny") {
      return { metrics: [], rows: [], requires_detailed_scoring: true };
    }
    return honestDivisionPlayerStats(divisionId);
  };
  const divisionCardSources = (): readonly DivisionCardSource[] =>
    [...divisionNameById.entries()].flatMap(([divisionId, divisionName]) => {
      const playerStats = honestDivisionPlayerStats(divisionId);
      return playerStats === undefined
        ? []
        : [{ divisionId, divisionName, sportKey: divisionSportById.get(divisionId) ?? "unknown", playerStats }];
    });

  const oracleRoutes = makeOracleRoutesWorld({
    getRankedEntrantIds: (stageId) => {
      const divisionId = divisionIdByStageId.get(stageId);
      if (divisionId === undefined) return undefined;
      const entrants = schedule.entrantsOfDivision(divisionId);
      return opts.wrongFinalStandingsOrder === true ? [...entrants].reverse() : entrants;
    },
    // B05 T4b — the two REAL league tables (`d-tiny`/`s-league`,
    // `d-badminton`/`s-badminton-league`); `undefined` for `s-playoff`
    // (the knockout `getRankedEntrantIds` above already covers) falls back
    // to the placement shape unchanged.
    getFullStandingsRows: (stageId) => {
      const divisionId = divisionIdByStageId.get(stageId);
      const stageName = stageNameById.get(stageId);
      if (divisionId === undefined || stageName === undefined) return undefined;
      if (opts.emptyBadmintonStandings === true && stageName === "Badminton League") return [];
      return tinyLeagueTableRows(stageName, schedule.entrantsOfDivision(divisionId));
    },
    // B05 T4b/D6 — a LIVE tally of `generic.score` events actually posted to
    // `/fixtures/{id}/events` (`personScoreTally`, filled below in `raw()`),
    // never `_oracle-routes.ts`'s hardcoded fixture: this file is the one
    // that folds division0's OWN real events, and D6's regression needs the
    // fake to report whatever a mis-attributed `payload.person` actually
    // produced, not a constant that could never disagree with it.
    getDivisionPlayerStats: divisionPlayerStatsFor,
    // B05 T5b — the two person-stats reads. Both derive from
    // `honestDivisionPlayerStats`, NEVER from `divisionPlayerStatsFor`: the
    // `emptyLeaderboard` knob models one broken ENDPOINT, and letting it
    // leak into the person card would red two oracles for one injected
    // fault, which is exactly the "two guards covering for each other" shape
    // this task is required not to ship. Each of the three knobs below reds
    // its own oracle and no other.
    getPersonStats: (personId) =>
      opts.emptyPersonDivisions === true
        ? { divisions: [] }
        : personStatsFromDivisions(personId, divisionCardSources()),
    getPersonCareerStats: (personId) =>
      opts.emptyCareerSports === true
        ? { sports: [] }
        : personCareerStatsFromDivisions(personId, divisionCardSources()),
  });

  const transport: ProbeTransport = {
    async signIn(_base, _s) {
      calls.push({ method: "SIGNIN", path: "signIn", body: undefined });
      return { has_org: true, org_id: "org-fixed", redirect: "/dashboard" };
    },
    async request<T>(_base: string, _s: Session, rawPath: string, reqOpts?: { method?: string; body?: unknown }) {
      const method = reqOpts?.method ?? "GET";
      const body = reqOpts?.body;
      const routePath = rawPath.split("?")[0]!;
      calls.push({ method, path: rawPath, body });

      if (method === "GET" && routePath === "/api/orgs") {
        return [{ id: "org-fixed", slug: "org-fixed-slug", name: "Bench Org" }] as unknown as T;
      }
      if (method === "POST" && /^\/api\/v1\/orgs\/[^/]+\/venues$/.test(routePath)) {
        const id = `venue-${slug((body as { name: string }).name)}`;
        schedule.addVenue(id);
        return { id } as T;
      }
      const courtsMatch = /^\/api\/v1\/orgs\/[^/]+\/venues\/([^/]+)\/courts$/.exec(routePath);
      if (method === "POST" && courtsMatch !== null) {
        const name = (body as { name: string }).name;
        const id = `court-${slug(name)}`;
        schedule.addCourt(courtsMatch[1]!, id, name);
        return { id } as T;
      }
      if (method === "POST" && routePath === "/api/v1/persons") {
        const fullName = (body as { full_name: string }).full_name;
        const id = `person-${slug(fullName)}`;
        personNameById.set(id, fullName);
        return { id } as T;
      }
      if (method === "POST" && routePath === "/api/v1/competitions") {
        return { id: `comp-${slug((body as { name: string }).name)}` } as T;
      }
      if (method === "POST" && /^\/api\/v1\/competitions\/[^/]+\/divisions$/.test(routePath)) {
        const b = body as { name?: string; sport_key?: string; config?: { dls?: { enabled?: boolean } } };
        const id = `div-${++divisionCounter}`;
        dlsByDivisionId.set(id, b.config?.dls?.enabled === true);
        if (b.name !== undefined) divisionNameById.set(id, b.name);
        if (b.sport_key !== undefined) divisionSportById.set(id, b.sport_key);
        return { id } as T;
      }
      const entrantsMatch = /^\/api\/v1\/divisions\/([^/]+)\/entrants$/.exec(routePath);
      if (method === "POST" && entrantsMatch !== null) {
        const rows = body as { display_name?: string }[];
        const out = rows.map((e, i) => ({
          id: `entrant-${slug(e.display_name ?? String(i))}-${Math.random()}`,
        }));
        schedule.addEntrants(entrantsMatch[1]!, out.map((e) => e.id));
        return out as unknown as T;
      }
      if (method === "POST" && /^\/api\/v1\/divisions\/([^/]+)\/stages$/.test(routePath)) {
        const divisionId = routePath.split("/")[4]!;
        const stagesBody = body as { name?: string; kind?: string; config?: { legs?: number } }[];
        return stagesBody.map((st) => {
          const id = `stage-${++stageCounter}`;
          legsByStageId.set(id, (st.config?.legs as number | undefined) ?? 1);
          kindByStageId.set(id, st.kind ?? "league");
          divisionIdByStageId.set(id, divisionId);
          if (st.name !== undefined) stageNameById.set(id, st.name);
          schedule.addStage(id, divisionId);
          return { id };
        }) as unknown as T;
      }
      if (method === "POST" && /^\/api\/v1\/stages\/[^/]+\/generate$/.test(routePath)) {
        const stageId = routePath.split("/")[4]!;
        const divisionId = divisionIdByStageId.get(stageId);
        // B05 T3 — a knockout `timing:"setup"` progression stage mints ONE
        // TBD placeholder (`se-r0-i0`, `buildSingleElim`'s own id for a
        // 2-slot single-elim bracket), never this fake's round-robin
        // arithmetic — see `kindByStageId`'s own comment.
        const fixtures =
          kindByStageId.get(stageId) === "knockout"
            ? [(() => {
                const id = `fx-${++fixtureCounter}`;
                if (divisionId !== undefined) fixtureDivisionId.set(id, divisionId);
                fixtureExtKeyById.set(id, "se-r0-i0");
                return { id, ext_key: "se-r0-i0" };
              })()]
            : Array.from(
                {
                  length: roundRobinRoundCount(
                    divisionId === undefined ? 0 : schedule.entrantsOfDivision(divisionId).length,
                    legsByStageId.get(stageId) ?? 1,
                  ),
                },
                (_v, i) => {
                  const id = `fx-${++fixtureCounter}`;
                  if (divisionId !== undefined) fixtureDivisionId.set(id, divisionId);
                  const extKey = `rr-r${i + 1}-c1`;
                  fixtureExtKeyById.set(id, extKey);
                  return { id, ext_key: extKey };
                },
              );
        schedule.addFixtures(stageId, fixtures);
        return { fixtures } as unknown as T;
      }
      // B04 — the seven scheduling endpoints, from the shared world. BEFORE
      // the officials routes below, so the anchored `PATCH /fixtures/{id}`
      // and `PATCH /fixtures/{id}/officials` cannot shadow each other.
      const scheduled = schedule.handle(method, routePath, body);
      if (scheduled !== undefined) return scheduled as T;
      if (method === "POST" && /^\/api\/v1\/divisions\/[^/]+\/officials\/auto$/.test(routePath)) {
        return { assignments: [] } as unknown as T;
      }
      if (method === "POST" && routePath === "/api/v1/officials") {
        return { id: `official-${slug((body as { display_name: string }).display_name)}` } as T;
      }
      if (method === "POST" && /^\/api\/v1\/officials\/[^/]+\/availability$/.test(routePath)) {
        return { date: (body as { date: string }).date } as T;
      }
      const inviteMatch = /^\/api\/v1\/officials\/([^/]+)\/invite$/.exec(routePath);
      if (method === "POST" && inviteMatch) {
        const officialId = inviteMatch[1]!;
        const personId = `invited-${officialId}`;
        const row = { id: personId, person_id: personId, claimed_at: null, revoked_at: null };
        claimInvites.set(personId, row);
        return { person_id: personId } as T;
      }
      if (method === "PATCH" && /^\/api\/v1\/fixtures\/[^/]+\/officials$/.test(routePath)) {
        const fixtureId = routePath.split("/")[4]!;
        const set = (body as { set: unknown[] }).set;
        fixtureOfficials.set(fixtureId, set);
        schedule.setOfficials(fixtureId, set);
        return { ok: true } as T;
      }
      if (method === "GET" && /^\/api\/v1\/fixtures\/[^/]+$/.test(routePath)) {
        const fixtureId = routePath.split("/")[4]!;
        return { id: fixtureId, officials: fixtureOfficials.get(fixtureId) ?? [] } as T;
      }
      if (method === "POST" && /^\/api\/v1\/persons\/[^/]+\/claim-invites$/.test(routePath)) {
        const personId = routePath.split("/")[4]!;
        const row = { person_id: personId, claimed_at: null, revoked_at: null };
        claimInvites.set(personId, row);
        return row as T;
      }
      if (method === "GET" && /^\/api\/v1\/persons\/[^/]+\/claim-invites$/.test(routePath)) {
        const personId = routePath.split("/")[4]!;
        return (claimInvites.get(personId) ?? null) as T;
      }
      if (method === "GET" && /^\/api\/v1\/divisions\/[^/]+$/.test(routePath)) {
        // B05 T2.5 — `status` is D9's own RE-READ; `slug` is unrelated
        // scaffolding no production call site actually reads.
        return { slug: `slug-${routePath.split("/")[4]}`, ...phase.handleDivisionGet(method, routePath) } as T;
      }
      if (method === "POST" && /^\/api\/admin\/orgs\/[^/]+\/entitlement-override$/.test(routePath)) {
        entitled = true;
        return { ok: true } as unknown as T;
      }
      if (method === "DELETE" && /^\/api\/admin\/orgs\/[^/]+\/entitlement-override$/.test(routePath)) {
        return { ok: true } as unknown as T;
      }
      throw new Error(`fake server: unhandled ${method} ${routePath}`);
    },
    async raw(_base, _s, path, method = "GET", body): Promise<RawResult> {
      calls.push({ method, path, body });
      // B05 T2.5 (D9) — `/start` itself, unconditionally whenever `sql` is
      // present. Checked FIRST: nothing below can be reached before this.
      const started = phase.handleStart(method, path);
      if (started !== undefined) return started;
      // B05 T3 — the advancement routes, unconditionally whenever `sql` is
      // present (see `_advance-routes.ts`'s own header comment).
      const advanced = advanceRoutes.handle(method, path, body);
      if (advanced !== undefined) return advanced;
      // B05 T4 — the runtime oracle's standings read, unconditionally
      // whenever `sql` is present (see `_oracle-routes.ts`'s own header
      // comment).
      const oracled = oracleRoutes.handle(method, path);
      if (oracled !== undefined) return oracled;
      // B05 T2 — division B's own streams (`d-badminton`) fold through THIS
      // route unconditionally whenever `sql` is present, same gating as
      // division A's single-event fold this file is actually about. Handled
      // here as a plain pass-through so THIS file's own division-A
      // assertions stay green; the import path's own wiring/behaviour is
      // covered by `tiny-suite-import.test.ts`.
      const importMatch = /^\/api\/v1\/divisions\/([^/]+)\/events\/import$/.exec(path);
      if (importMatch) {
        const importDivisionId = importMatch[1]!;
        const refused = phase.refuseUnlessStarted(importDivisionId, "import");
        if (refused !== undefined) return refused;
        const sent = (body as { streams: { fixture: { id: string }; events: unknown[] }[] }).streams;
        return {
          status: 200,
          json: {
            ok: true,
            data: {
              importId: "x",
              totals: { imported: sent.length, skipped: 0, rejected: 0 },
              results: sent.map((s) => ({ fixture: s.fixture.id, status: "imported", eventsAppended: s.events.length })),
            },
          } as never,
        };
      }
      const m = /^\/api\/v1\/fixtures\/([^/]+)\/events$/.exec(path);
      if (!m) throw new Error(`fake server: unhandled raw ${method} ${path}`);
      const fixtureId = m[1]!;
      const divisionId = fixtureDivisionId.get(fixtureId);
      const dlsEnabled = divisionId !== undefined && dlsByDivisionId.get(divisionId) === true;
      const { type, payload, expected_seq } = body as { type: string; payload: { target?: unknown }; expected_seq: number };
      // B05 T2.5 (D9) — the phase gate `usecases/scoring.ts:222` enforces:
      // this is what proves `runDivisionStartLayer` actually ran BEFORE this
      // fold, not merely that the function exists. Scoped away from
      // `cricket.*` types on purpose: the DLS-gate probe's own throwaway
      // division is NEVER in `runDivisionStartLayer`'s input (only `_tiny`'s
      // OWN streamed divisions are), and the probe's whole point is proving
      // the ENTITLEMENT door — this phase door would otherwise shadow it,
      // turning a "must be 402" cell into a false "422 WRONG_PHASE" this
      // probe's own `NEVER_REACHED_THE_GATE` list does not even know to
      // exclude. `_tiny.json`'s division-A stream events use only
      // `core.*`/`generic.*` types (this file's own `divisionAEventCalls`
      // helper relies on the same non-overlap), so this scoping costs the
      // real fold nothing.
      if (divisionId !== undefined && !type.startsWith("cricket.")) {
        const refused = phase.refuseUnlessStarted(divisionId, "scoring");
        if (refused !== undefined) return refused;
      }
      const manualTarget = payload?.target !== undefined;
      const requiresDls = type === "cricket.revise" && dlsEnabled && !manualTarget;
      if (requiresDls && !entitled) {
        return {
          status: 402,
          json: { ok: false, error: { code: "PAYMENT_REQUIRED", message: "nope", feature_key: "cricket.dls" } } as never,
        };
      }
      // B05 T1's own addition: a deliberate SEQ_CONFLICT for exactly one
      // (extKey, expected_seq) pair, so a wiring test can prove the finding
      // reaches `report.errors`/`report.gate` — never a silent skip or retry.
      const extKey = fixtureExtKeyById.get(fixtureId);
      if (
        opts.conflictAt !== undefined &&
        extKey === opts.conflictAt.extKey &&
        expected_seq === opts.conflictAt.expectedSeq
      ) {
        return {
          status: 409,
          json: {
            ok: false,
            error: { code: "SEQ_CONFLICT", message: "deliberate test conflict", current_seq: expected_seq + 5 },
          } as never,
        };
      }
      // B05 T4b/D6 — tally the event actually accepted, never one this fake
      // is about to refuse above: `payload.person` is already the REAL
      // resolved id by this point (`simulate.ts#resolvePayloadRefs` runs
      // before `raw()` ever sees the event), so a re-attributed
      // `generic.score` in the SOURCE pack changes exactly this tally, with
      // no help from this fake.
      if (type === "generic.score") {
        const scorePayload = payload as unknown as { person?: string; points?: number };
        if (scorePayload.person !== undefined) {
          const tally = personScoreTally.get(scorePayload.person) ?? { scores: 0, points: 0 };
          tally.scores += 1;
          tally.points += typeof scorePayload.points === "number" ? scorePayload.points : 0;
          personScoreTally.set(scorePayload.person, tally);
        }
      }
      return { status: 201, json: { ok: true, data: { seq: expected_seq + 1 } } as never };
    },
  };

  const sql: PlanSql = {
    async entitlementRows(featureKey) {
      if (featureKey === "cricket.dls") {
        return [
          { plan_key: "community", bool_value: false },
          { plan_key: "pro", bool_value: true },
        ] satisfies PlanEntitlementRow[];
      }
      if (featureKey === "officials.auto") {
        return [{ plan_key: "community", bool_value: false }, { plan_key: "pro", bool_value: false }] satisfies PlanEntitlementRow[];
      }
      if (featureKey === "stats.player") {
        return [{ plan_key: "community", bool_value: false }, { plan_key: "pro", bool_value: false }] satisfies PlanEntitlementRow[];
      }
      return [];
    },
    async planCandidateInfo(planKeys) {
      return planKeys
        .filter((k) => k === "community" || k === "pro")
        .map((k) => ({ plan_key: k, is_public: true, privilege: k === "pro" ? 1 : 0 }));
    },
    async getOrgSubscriptionId() {
      return null;
    },
    async updateSubscriptionPlan() {},
    async createSubscriptionForOrg() {
      return "sub-new";
    },
    async setOwnerStaff() {},
    async setDivisionActive() {},
  };

  return { transport, sql, calls };
}

/** Every `POST .../events` call — INCLUDING the DLS-gate probe's own 5
 *  synthetic `cricket.*` cells, unconditionally driven whenever `input.sql`
 *  is present (same fake, same `raw()` route). `divisionAEventCalls` below
 *  is the one that scopes to what THIS task's own fold sent. */
function eventPostCalls(calls: RecordedCall[]): RecordedCall[] {
  return calls.filter((c) => c.method === "POST" && /^\/api\/v1\/fixtures\/[^/]+\/events$/.test(c.path));
}

/** Division A's (`d-tiny`'s) own stream events, scoped away from the DLS-
 *  gate probe's unconditional `cricket.revise`/`cricket.ball` cells by event
 *  TYPE — `_tiny.json`'s division-A streams use only `core.*`/`generic.*`
 *  types, and the probe's cells use only `cricket.*` ones (dls-gate.ts:347-
 *  397); the two vocabularies never overlap. */
function divisionAEventCalls(calls: RecordedCall[]): RecordedCall[] {
  return eventPostCalls(calls).filter((c) => !(c.body as { type: string }).type.startsWith("cricket."));
}

describe("runTinySuite — B05 T1 division-A stream fold wiring", () => {
  it("drives real POSTs for every division-A event and reports a populated simulation section", async () => {
    const { transport, sql, calls } = fakeServer();

    const report = await runTinySuite({
      base: "http://bench.example",
      engine: "optimized",
      keep: false,
      log: silent,
      cliEntry: "admin",
      packPath: TINY_PACK_PATH,
      transport,
      sql,
      probeTransport: transport,
      simTransport: transport,
      // B05 T2 — the SAME fake now handles `/events/import` too (see this
      // file's own `raw()`), so division B's own streams fold cleanly
      // rather than falling back to a real `fetch()`. This file's own
      // assertions are about division A; the import path's own wiring is
      // `tiny-suite-import.test.ts`'s job.
      importTransport: transport,
      startTransport: transport,
      advanceTransport: transport,
      oracleTransport: transport,
    });

    expect(report.gate).toBe("green");
    // B05 T2.5 (D9) — both `_tiny.json`'s streamed divisions (`d-tiny` AND
    // `d-badminton`) were started and RE-READ as active BEFORE either fold
    // below ran at all — this is the whole reason the fold above succeeded
    // rather than 409ing against the fake's own phase gate.
    expect(report.divisionStart).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ divisionRef: "d-tiny", started: true, confirmedStatus: "active" }),
        expect.objectContaining({ divisionRef: "d-badminton", started: true, confirmedStatus: "active" }),
      ]),
    );
    // `/start` happens BEFORE any division-A event POST — never the other
    // way around. Scoped to division A's OWN `core.*`/`generic.*` calls
    // (`divisionAEventCalls`'s own reasoning): the DLS-gate probe's
    // `cricket.*` cells run BEFORE scheduling/start even begins, so an
    // unscoped index would always read as "before" regardless of ordering.
    const firstStartIdx = calls.findIndex((c) => c.method === "POST" && /\/start$/.test(c.path));
    const firstDivisionAEventIdx = calls.findIndex(
      (c) =>
        c.method === "POST" &&
        /^\/api\/v1\/fixtures\/[^/]+\/events$/.test(c.path) &&
        !(c.body as { type: string }).type.startsWith("cricket."),
    );
    expect(firstStartIdx).toBeGreaterThan(-1);
    expect(firstDivisionAEventIdx).toBeGreaterThan(firstStartIdx);
    // `_tiny.json`'s division A (`d-tiny`) league stage (`s-league`) declares
    // 3 streams with 2, 5 and 2 events — 9 total, via T1's OWN fold
    // (`report.simulation`, asserted below). B05 T3 ALSO folds `s-playoff`'s
    // OWN single stream (2 events: core.start + generic.result) through this
    // SAME `/fixtures/{id}/events` route — a SEPARATE call, reusing T1's
    // fold function rather than a new one (the acceptance bar: the existing
    // fold covers it) — so the RAW call count this fake recorded is 11
    // across 4 fixtures, not 9 across 3; `report.simulation` itself stays
    // scoped to T1's own 9, asserted against what the pack ACTUALLY sent
    // (call count), never a constant typed into this test a second time.
    const eventCalls = divisionAEventCalls(calls);
    expect(eventCalls).toHaveLength(11);
    // And in strictly ascending expected_seq PER FIXTURE — grouped by path
    // (== fixture), each fixture's own sequence starts at 0 and increments.
    const byFixture = new Map<string, number[]>();
    for (const c of eventCalls) {
      const seqs = byFixture.get(c.path) ?? [];
      seqs.push((c.body as { expected_seq: number }).expected_seq);
      byFixture.set(c.path, seqs);
    }
    expect(byFixture.size).toBe(4);
    for (const seqs of byFixture.values()) {
      expect(seqs).toEqual(seqs.map((_v, i) => i));
    }

    expect(report.simulation).toBeDefined();
    expect(report.simulation?.eventsSent).toBe(9);
    expect(report.simulation?.findings ?? []).toHaveLength(0);
    expect(report.timings.simMs).toBeDefined();
    // B05 T3's own oracles — the advance step's qualifier proposal and the
    // captured finalRanks both matched the pack's own expectations.
    const advanceOracles = (report.oracles ?? []).filter((o) => o.name.startsWith("advance:"));
    expect(advanceOracles.map((o) => o.passed)).toEqual([true, true]);
    // B05 T4 — the runtime oracle layer's own checks: rank crossing
    // (captured vs re-read standings), standings vs `expected.finalRanks`,
    // and champion, all against this fake's clean (unreversed) final order.
    // B05 T4b — the two comparators T4 left unwired, now reached for every
    // real subject `_tiny.json` carries: both league tables
    // (`expected.tables`) and both `d-tiny` leaderboard entries
    // (`expected.leaderboards`), all BEFORE the T3 advance step's own checks
    // (this task's wiring runs earlier in `runTinySuite`, right after T2's
    // import fold). If (false)-ing out either T4b block removes its four
    // entries from this list — the wiring-level regression this task owes.
    const runtimeOracles = (report.oracles ?? []).filter((o) => o.name.startsWith("oracle:"));
    // B05 T5a — the tie-order cascade oracle (reviewer MAJOR #2: this
    // comparator had no call site anywhere) is wired right after EACH
    // table's own standings check, so it interleaves one-per-table rather
    // than trailing the whole list. `d-tiebreak`'s own pair (echo/golf) is
    // genuinely tied on points and genuinely checked (not skipped); d-tiny
    // and d-badminton's tables carry no tied rows, so their own cascade
    // entries report `checkedPairs: 0` but still run — removing the block
    // (`if (false)`) drops all THREE from this list, which is the wiring
    // regression this task owes.
    expect(runtimeOracles.map((o) => o.name)).toEqual([
      "oracle: d-tiny/s-league standings table",
      "oracle: d-tiny/s-league tie-order cascade",
      "oracle: d-badminton/s-badminton-league standings table",
      "oracle: d-badminton/s-badminton-league tie-order cascade",
      "oracle: d-tiebreak/s-tiebreak-league standings table",
      "oracle: d-tiebreak/s-tiebreak-league tie-order cascade",
      "oracle: d-tiny leaderboard (scores)",
      "oracle: d-tiny leaderboard (points)",
      "oracle: d-tiebreak leaderboard (scores)",
      "oracle: d-tiebreak leaderboard (points)",
      "oracle: s-playoff rank crossing (captured vs standings)",
      "oracle: s-playoff standings rank vs expected.finalRanks",
      "oracle: d-tiny champion",
    ]);
    expect(runtimeOracles.map((o) => o.passed)).toEqual([
      true, true, true, true, true, true, true, true, true, true, true, true, true,
    ]);
    // The genuinely tied pair (echo/golf) was actually CHECKED, not merely
    // present-and-skipped — the whole point of an ordering-differential
    // fixture (a case with nothing tied would report checkedPairs: 0 here
    // too, and could never witness a reversed cascade).
    const tiebreakCascade = runtimeOracles.find((o) => o.name === "oracle: d-tiebreak/s-tiebreak-league tie-order cascade");
    expect(tiebreakCascade?.detail).toContain("1 checked");
  });

  // B05 T4b — D6, MOVED ONTO THE WIRED PATH (the re-pin's own instruction:
  // "this regression must now run through the WIRED leaderboard oracle, not
  // only through a unit fixture — otherwise D6 proves the comparator and
  // not the pipeline"). `oracle.test.ts`'s own D6 test proves
  // `compareLeaderboard` itself, fed a hand-built `liveDerivedActual`; this
  // one proves the WIRING — the mutated pack's stream is folded through the
  // REAL `simulateDivisionStreams`/`/fixtures/{id}/events` path, and the
  // fake's `getDivisionPlayerStats` (this file's own live tally, not a
  // fixture) answers with whatever that fold actually produced.
  it("D6 — a mis-transcribed generic.score stays invisible to stage 0, but reds the WIRED leaderboard oracle", async () => {
    // The SAME mutation `oracle.test.ts`'s own D6 test uses: `rr-r2-c1`'s
    // `@p-bo` scoring event re-attributed to `@p-ana`. `by` (the SIDE,
    // `@e-bravo`) is untouched, so the fixture's own outcome/standings stay
    // exactly what stage 0 already checks — only who gets PERSONAL credit
    // changes, which stage 0's own header names as the one thing it cannot
    // see.
    const raw = JSON.parse(await readFile(TINY_PACK_PATH, "utf8")) as {
      streams: { fixtureExtKey: string; events: { type: string; payload?: Record<string, string | number> }[] }[];
    };
    const stream = raw.streams.find((st) => st.fixtureExtKey === "rr-r2-c1");
    if (stream === undefined) throw new Error("test fixture assumption broken: rr-r2-c1 stream not found");
    const boEvent = stream.events.find((e) => e.type === "generic.score" && e.payload?.person === "@p-bo");
    if (boEvent?.payload === undefined) throw new Error("test fixture assumption broken: no @p-bo scoring event");
    boEvent.payload.person = "@p-ana"; // the mis-transcription

    // The filename must stay `_tiny.json`: `pack-schema.ts`'s own
    // `suite_mismatch` check refuses a pack whose declared `suite` disagrees
    // with the file it was loaded from — a different temp DIRECTORY keeps
    // this isolated from the real committed pack without tripping it.
    const dir = await mkdtemp(join(tmpdir(), "b05-d6-"));
    const mutatedPackPath = join(dir, "_tiny.json");
    await writeFile(mutatedPackPath, JSON.stringify(raw), "utf8");

    const { transport, sql } = fakeServer();
    const report = await runTinySuite({
      base: "http://bench.example",
      engine: "optimized",
      keep: false,
      log: silent,
      cliEntry: "admin",
      packPath: mutatedPackPath,
      transport,
      sql,
      probeTransport: transport,
      simTransport: transport,
      importTransport: transport,
      startTransport: transport,
      advanceTransport: transport,
      oracleTransport: transport,
    });

    // The mutated pack still reaches the live run at all — stage 0 does NOT
    // derive `expected.leaderboards` from events (`validate-pack.ts`'s own
    // "LIMITS" header), so this is a warning, never a stage-0 error.
    const leaderboardOracles = (report.oracles ?? []).filter((o) => o.name.startsWith("oracle: d-tiny leaderboard"));
    expect(leaderboardOracles.map((o) => o.name)).toEqual([
      "oracle: d-tiny leaderboard (scores)",
      "oracle: d-tiny leaderboard (points)",
    ]);
    // Both metrics disagree: the live tally now shows p-ana with 3
    // scores/4 points (three events, one worth 2) and p-bo with 0/0, against
    // the pack's OWN unchanged `expected.leaderboards` (2/1 scores, 2/2
    // points) — a REAL disagreement the wiring caught, not a restated
    // fixture (`expected.leaderboards` is read from the pack exactly once,
    // by `lib/suites/tiny.ts`'s own T4b block, never re-derived here).
    expect(leaderboardOracles.map((o) => o.passed)).toEqual([false, false]);
    expect(report.gate).toBe("red");
    expect((report.errors ?? []).some((e) => e.includes("d-tiny/scores") || e.includes("leaderboard"))).toBe(true);
  });

  // B05 T4b — `compareStandings`'s empty-case discipline ("an empty rows
  // array must not vacuously satisfy the comparison"), proven through the
  // WIRING: `d-badminton`'s own `GET /stages/{id}/standings` answers ZERO
  // rows (as if its fold never happened), against a non-empty
  // `expected.tables` row. `oracle.test.ts`'s own unit tests already prove
  // `compareStandings` itself does this ("the EMPTY set is checked
  // explicitly" — empty vs empty matches, empty actual vs non-empty
  // expected reds); this proves the WIRED path reaches that same discipline
  // rather than short-circuiting past it (e.g. skipping the comparison
  // entirely for a stage with no rows).
  it("B05 T4b — an EMPTY standings table reds the wired comparator, never vacuously", async () => {
    const { transport, sql } = fakeServer({ emptyBadmintonStandings: true });

    const report = await runTinySuite({
      base: "http://bench.example",
      engine: "optimized",
      keep: false,
      log: silent,
      cliEntry: "admin",
      packPath: TINY_PACK_PATH,
      transport,
      sql,
      probeTransport: transport,
      simTransport: transport,
      importTransport: transport,
      startTransport: transport,
      advanceTransport: transport,
      oracleTransport: transport,
    });

    const tableOracles = (report.oracles ?? []).filter((o) => o.name.endsWith("standings table"));
    // B05 T5a added a THIRD table (`d-tiebreak`'s own), untouched by this
    // knob just like d-tiny's — the knob only hollows out d-badminton's.
    expect(tableOracles.map((o) => o.name)).toEqual([
      "oracle: d-tiny/s-league standings table",
      "oracle: d-badminton/s-badminton-league standings table",
      "oracle: d-tiebreak/s-tiebreak-league standings table",
    ]);
    // d-tiny's and d-tiebreak's own tables are UNTOUCHED by this knob —
    // only d-badminton's fetch was hollowed out — so the middle entry must
    // disagree with its neighbours, never all three red (which would
    // suggest the knob leaked) or all three green (which would suggest the
    // empty case was silently ignored).
    expect(tableOracles.map((o) => o.passed)).toEqual([true, false, true]);
    expect(report.gate).toBe("red");
    expect((report.errors ?? []).some((e) => e.includes("d-badminton/s-badminton-league"))).toBe(true);
  });

  // B05 T5a review MINOR — `compareLeaderboard`'s own empty-case discipline
  // (`oracle.test.ts`: "the EMPTY set: an empty actual leaderboard against
  // non-empty expected reds every entry, never vacuously") is unit-tested
  // but had no WIRED equivalent, asymmetric with standings' own empty-case
  // wiring proof just above. `GET /divisions/{id}/stats/players` answers
  // `d-tiny`'s division with `{metrics:[],rows:[],requires_detailed_scoring:
  // true}` — the SAME empty shape the unit test uses — in place of this
  // fake's real live tally, against the pack's own non-empty
  // `expected.leaderboards` rows.
  it("B05 T5a — an EMPTY leaderboard reds the wired comparator, never vacuously (symmetric with standings' empty case)", async () => {
    const { transport, sql } = fakeServer({ emptyLeaderboard: true });

    const report = await runTinySuite({
      base: "http://bench.example",
      engine: "optimized",
      keep: false,
      log: silent,
      cliEntry: "admin",
      packPath: TINY_PACK_PATH,
      transport,
      sql,
      probeTransport: transport,
      simTransport: transport,
      importTransport: transport,
      startTransport: transport,
      advanceTransport: transport,
      oracleTransport: transport,
    });

    const leaderboardOracles = (report.oracles ?? []).filter((o) => o.name.startsWith("oracle: d-tiny leaderboard"));
    expect(leaderboardOracles.map((o) => o.name)).toEqual([
      "oracle: d-tiny leaderboard (scores)",
      "oracle: d-tiny leaderboard (points)",
    ]);
    // Every entry reds against the empty actual — never a vacuous pass just
    // because there was nothing to fetch.
    expect(leaderboardOracles.map((o) => o.passed)).toEqual([false, false]);
    expect(report.gate).toBe("red");
    expect((report.errors ?? []).some((e) => e.includes("d-tiny/scores") || e.includes("leaderboard"))).toBe(true);
  });

  it("B05 T4 — the runtime oracle is a REAL wire read, not an inert restatement: a reversed re-read standings order reds the run", async () => {
    // The captured `complete` response still reports [e-alpha, e-bravo] —
    // this fake's `advanceRoutes` world is untouched. Only the SEPARATE
    // `GET /stages/{id}/standings` re-read (`oracleRoutes`) disagrees. If
    // the oracle step were dead code (never wired, or silently comparing
    // the captured response against itself), this run would still be
    // green.
    const { transport, sql } = fakeServer({ wrongFinalStandingsOrder: true });
    const report = await runTinySuite({
      base: "http://bench.example",
      engine: "optimized",
      keep: false,
      log: silent,
      cliEntry: "admin",
      packPath: TINY_PACK_PATH,
      transport,
      sql,
      probeTransport: transport,
      simTransport: transport,
      importTransport: transport,
      startTransport: transport,
      advanceTransport: transport,
      oracleTransport: transport,
    });

    expect(report.gate).toBe("red");
    const runtimeOracles = (report.oracles ?? []).filter((o) => o.name.startsWith("oracle:"));
    const rankCrossing = runtimeOracles.find((o) => o.name === "oracle: s-playoff rank crossing (captured vs standings)");
    expect(rankCrossing?.passed).toBe(false);
    const standingsVsExpected = runtimeOracles.find(
      (o) => o.name === "oracle: s-playoff standings rank vs expected.finalRanks",
    );
    expect(standingsVsExpected?.passed).toBe(false);
    const champion = runtimeOracles.find((o) => o.name === "oracle: d-tiny champion");
    expect(champion?.passed).toBe(false);
    expect((report.errors ?? []).join(" | ")).toContain("DISAGREE on final order");
  });

  it("without `sql`, the fold never runs — no fixtures/events calls, no simulation section", async () => {
    const { transport, calls } = fakeServer();

    const report = await runTinySuite({
      base: "http://bench.example",
      engine: "optimized",
      keep: false,
      log: silent,
      cliEntry: "admin",
      packPath: TINY_PACK_PATH,
      transport,
    });

    expect(report.gate).toBe("green");
    expect(divisionAEventCalls(calls)).toHaveLength(0);
    expect(report.simulation).toBeUndefined();
  });

  it("a deliberate SEQ_CONFLICT reaches report.errors and reds the gate — never silently retried", async () => {
    // `rr-r2-c1` is the 5-event stream; conflict its THIRD event (index 2).
    const { transport, sql, calls } = fakeServer({ conflictAt: { extKey: "rr-r2-c1", expectedSeq: 2 } });

    const report = await runTinySuite({
      base: "http://bench.example",
      engine: "optimized",
      keep: false,
      log: silent,
      cliEntry: "admin",
      packPath: TINY_PACK_PATH,
      transport,
      sql,
      probeTransport: transport,
      simTransport: transport,
      // B05 T2 — the SAME fake now handles `/events/import` too (see this
      // file's own `raw()`), so division B's own streams fold cleanly
      // rather than falling back to a real `fetch()`. This file's own
      // assertions are about division A; the import path's own wiring is
      // `tiny-suite-import.test.ts`'s job.
      importTransport: transport,
      startTransport: transport,
      advanceTransport: transport,
      oracleTransport: transport,
    });

    expect(report.gate).toBe("red");
    expect((report.errors ?? []).some((e) => e.includes("SEQ_CONFLICT"))).toBe(true);
    expect(report.simulation?.findings).toHaveLength(1);
    expect(report.simulation?.findings?.[0]).toMatchObject({ code: "SEQ_CONFLICT", status: 409, eventIndex: 2 });

    // Never retried: the conflicted fixture's stream stops at expected_seq 2
    // — nothing sent it twice, and events 3/4 (the two AFTER the conflict in
    // that same 5-event stream) were never attempted at all.
    const conflictedFixturePath = divisionAEventCalls(calls).find(
      (c) => (c.body as { expected_seq: number }).expected_seq === 2,
    )?.path;
    const conflictedFixtureCalls = divisionAEventCalls(calls).filter((c) => c.path === conflictedFixturePath);
    const seqsOnConflictedFixture = conflictedFixtureCalls.map((c) => (c.body as { expected_seq: number }).expected_seq);
    expect(seqsOnConflictedFixture).toEqual([0, 1, 2]);
  });

  // B05 T3 (design doc D7) — the wiring-level regression: a wrong seed
  // proposal reds the run, and NOTHING downstream of the assertion is ever
  // attempted, at the `tiny.ts` wiring layer, not just inside
  // `advanceStageSeeding` itself (`advance.test.ts` proves the function; this
  // proves the SUITE actually stops on its answer rather than folding
  // `s-playoff`'s own stream regardless).
  it("D7 — a WRONG seed-proposal order reds the run, and the playoff's own fixture is NEVER scored", async () => {
    const { transport, sql, calls } = fakeServer({ reverseAdvanceQualifiers: true });

    const report = await runTinySuite({
      base: "http://bench.example",
      engine: "optimized",
      keep: false,
      log: silent,
      cliEntry: "admin",
      packPath: TINY_PACK_PATH,
      transport,
      sql,
      probeTransport: transport,
      simTransport: transport,
      importTransport: transport,
      startTransport: transport,
      advanceTransport: transport,
      oracleTransport: transport,
    });

    expect(report.gate).toBe("red");
    expect((report.errors ?? []).some((e) => e.includes("disagree with the pack's expected order"))).toBe(true);
    const advanceOracle = (report.oracles ?? []).find((o) => o.name.includes("seed proposal qualifiers"));
    expect(advanceOracle?.passed).toBe(false);
    // No finalRanks oracle at all — completing the target stage never ran.
    expect((report.oracles ?? []).some((o) => o.name.includes("finalRanks"))).toBe(false);
    // The absence of the downstream CALLS, not just the absence of an
    // oracle: confirm is never attempted at all, and `/complete` is called
    // EXACTLY once — the SOURCE stage's own completion this wiring always
    // makes BEFORE proposing (it is what satisfies SEEDING_SOURCE_INCOMPLETE)
    // — never a second time for the TARGET stage.
    expect(calls.some((c) => c.method === "POST" && /\/seed-proposal\/confirm$/.test(c.path))).toBe(false);
    expect(calls.filter((c) => c.method === "POST" && /\/complete$/.test(c.path))).toHaveLength(1);
    // 9 events total (T1's league fold only) — the playoff's own 2-event
    // stream was never sent.
    expect(divisionAEventCalls(calls)).toHaveLength(9);
  });
});
