// R3.5 Task K — `appendEvent` is the single funnel every scoring event passes
// through and it logged NOTHING: every super-over ball, every shoot-out kick
// and every engine refusal on both was invisible in production. This proves
// the log lines exist, carry the right shape, and — K5 — never carry a
// payload value: payloads carry striker/nonStriker/bowler/person ids and,
// for some events, free text, and persons in this product carry consent
// flags, so a log line is not a consented surface.
//
// DB-backed like its siblings in this directory (config-snapshot.test.ts):
// the funnel is a real transaction over real tables, and mocking the DB away
// would only prove a mock's own behaviour, not the funnel's.
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { football } from "@seazn/engine/sports/football";
import { foldMatchWithStoppage } from "@seazn/engine/core";
import { sportCases } from "@seazn/engine/testkit";
import { sql, withTenant } from "@/lib/db";
import { appendEvent } from "../index";
import { appendEventInTx } from "../append-event";
import { v1 } from "@/server/api-v1/http";

// F10 (R3.5 review) — the fold's catch only instrumented the EngineError
// (422) case; a TypeError/RangeError from inside a sport module, or a Zod
// issue surfacing as a plain Error, re-threw with NOTHING logged. Proving
// that deterministically needs a non-EngineError thrown FROM the fold
// itself (`foldMatchWithStoppage` since W2a: append-event reads the settle
// beside module state through `outcomeOf`). Real sport-module internals that happen to crash today are out of
// this task's lane (packages/engine/**) and would make the test depend on
// incidental engine behaviour rather than on append-event.ts's own catch, so
// this wraps the imported `foldMatchWithStoppage` instead. `importActual` keeps every
// OTHER export (EngineError, resolveVoids, …) real, and the fold itself
// defaults to the real implementation — every test in this file still folds
// for real — except the one call in K8 below that overrides it with
// `mockImplementationOnce`.
vi.mock("@seazn/engine/core", async () => {
  const actual = await vi.importActual<typeof import("@seazn/engine/core")>("@seazn/engine/core");
  return { ...actual, foldMatchWithStoppage: vi.fn(actual.foldMatchWithStoppage) };
});

const HAS_DB = !!process.env.DATABASE_URL;

// `lines` must exist before `vi.mock`'s factory can run — vitest hoists
// `vi.mock` calls above every import in this file (including the transitive
// one append-event.ts makes for "@/server/logger", resolved while THIS
// file's own `import { appendEvent } from "../index"` is still linking), so
// nothing declared as ordinary top-level code here is ready yet either.
// `vi.hoisted` is the one construct that runs early enough.
//
// The pino instance itself is built INSIDE the mock factory instead (via a
// dynamic `import("pino")`) rather than up here: a first attempt built it in
// this same `vi.hoisted` block using a statically-imported `pino`, and it
// failed every test with "Cannot access '__vi_import_3__' before
// initialization" — the hoisted callback runs before this file's own static
// imports (pino included) are linked, so it cannot touch them directly. A
// dynamic `import()` inside the (lazily-invoked) factory sidesteps that.
const { lines } = vi.hoisted(() => ({ lines: [] as string[] }));
vi.mock("@/server/logger", async () => {
  const { default: pino } = await import("pino");
  // A plain `{ write }` sink is pino's documented minimal destination shape
  // (no real stream needed) — see pino's own test suite. `write` returning
  // synchronously means every line is in `lines` by the time the
  // `log.info`/`log.warn` call that produced it returns, no flush needed.
  const sink = {
    write(chunk: string) {
      lines.push(chunk);
      return true;
    },
  };
  return { log: pino({ level: "debug" }, sink as never) };
});

function parsedLines(): Array<Record<string, unknown>> {
  return lines.map((l) => JSON.parse(l) as Record<string, unknown>);
}
function linesNamed(msg: string): Array<Record<string, unknown>> {
  return parsedLines().filter((l) => l.msg === msg);
}

const GENERIC_CONFIG = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
};

interface Seed {
  orgId: string;
  divisionId: string;
  stageId: string;
  fixtureId: string;
  home: string;
  away: string;
}

/** Fresh org -> competition -> division -> stage -> 2 entrants -> fixture,
 *  raw SQL (config-snapshot.test.ts's pattern) — no usecase layer, so no
 *  entitlement gating, matching what `appendEvent` itself checks (neither). */
async function seed(
  opts: {
    sportKey?: string;
    config?: unknown;
    moduleVersion?: string;
    positionCatalog?: unknown;
  } = {},
): Promise<Seed> {
  const sportKey = opts.sportKey ?? "generic";
  const config = opts.config ?? GENERIC_CONFIG;
  const moduleVersion = opts.moduleVersion ?? "1.0.0";
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"K " + suffix}, ${"k-" + suffix})
    returning id`;
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values (${sportKey}, ${sportKey}, ${moduleVersion},
            ${sql.json((opts.positionCatalog ?? { groups: [], lineup: { size: 1, benchMax: 0 } }) as never)})
    on conflict (key) do nothing`;
  const [{ id: competitionId }] = await sql<{ id: string }[]>`
    insert into competitions (org_id, name, slug, visibility)
    values (${orgId}, ${"Comp " + suffix}, ${"comp-" + suffix}, 'private')
    returning id`;
  const [{ id: divisionId }] = await sql<{ id: string }[]>`
    insert into divisions (competition_id, name, slug, sport_key, variant_key, config, module_version)
    values (${competitionId}, 'Div', ${"div-" + suffix}, ${sportKey}, 'default',
            ${sql.json(config as never)}, ${moduleVersion})
    returning id`;
  const [{ id: stageId }] = await sql<{ id: string }[]>`
    insert into stages (division_id, seq, kind, name, config)
    values (${divisionId}, 1, 'league', 'Stage', ${sql.json({})})
    returning id`;
  const [{ id: home }] = await sql<{ id: string }[]>`
    insert into entrants (division_id, kind, display_name, seed)
    values (${divisionId}, 'individual', 'Home', 1) returning id`;
  const [{ id: away }] = await sql<{ id: string }[]>`
    insert into entrants (division_id, kind, display_name, seed)
    values (${divisionId}, 'individual', 'Away', 2) returning id`;
  const [{ id: fixtureId }] = await sql<{ id: string }[]>`
    insert into fixtures (stage_id, division_id, round_no, seq_in_round, home_entrant_id, away_entrant_id)
    values (${stageId}, ${divisionId}, 1, 1, ${home}, ${away})
    returning id`;
  return { orgId, divisionId, stageId, fixtureId, home, away };
}

/** A football fixture under a real `football.version` — hardcoding "1.0.0"
 *  like the generic default would be a coincidence, not a contract (that IS
 *  football's current version, but `_seed.ts`'s `seedFootballCatalog` reads
 *  it dynamically for exactly this reason, and this mirrors that). */
function seedFootball(cfg: unknown): Promise<Seed> {
  return seed({
    sportKey: "football",
    config: cfg,
    moduleVersion: football.version,
    positionCatalog: football.positions,
  });
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

beforeEach(() => {
  lines.length = 0;
});

afterEach(() => {
  // K8's mockImplementationOnce is self-clearing after one call, but guard
  // against a failed assertion leaving it queued for the NEXT test anyway.
  vi.mocked(foldMatchWithStoppage).mockClear();
});

describe.skipIf(!HAS_DB)("appendEvent logging (R3.5 Task K)", () => {
  it("K1: logs an accepted event with its type, fixture and resulting seq", async () => {
    const s = await seed();
    await appendEvent(s.orgId, s.fixtureId, 0, { type: "core.start", payload: {} });

    const accepted = linesNamed("scoring event appended");
    expect(accepted).toHaveLength(1);
    expect(accepted[0]).toMatchObject({
      fixtureId: s.fixtureId,
      sportKey: "generic",
      eventType: "core.start",
      seq: 1,
      phase: "live",
      status: "in_play",
    });
  });

  it("K2: logs a refusal with the EngineError code and the event type, and still throws", async () => {
    const s = await seed();
    await appendEvent(s.orgId, s.fixtureId, 0, { type: "core.start", payload: {} });
    lines.length = 0;

    // A second core.start replays [core.start, core.start] through the fold —
    // every module refuses a double start with WRONG_PHASE, thrown from
    // INSIDE the fold, which is exactly the scope Task K's try/catch covers.
    await expect(
      appendEvent(s.orgId, s.fixtureId, 1, { type: "core.start", payload: {} }),
    ).rejects.toMatchObject({ code: "WRONG_PHASE" });

    const refused = linesNamed("scoring event refused");
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({
      fixtureId: s.fixtureId,
      eventType: "core.start",
      code: "WRONG_PHASE",
    });
    // Re-thrown unchanged means the tx aborted before any insert — no
    // accepted-event line for the refused attempt.
    expect(linesNamed("scoring event appended")).toHaveLength(0);
  });

  it("K8 (F10, R3.5 review): a non-EngineError from the fold is logged with ID-only fields, and re-thrown UNCHANGED", async () => {
    const s = await seed();
    const boom = new TypeError("cannot read properties of undefined (reading 'x')");
    vi.mocked(foldMatchWithStoppage).mockImplementationOnce(() => {
      throw boom;
    });

    // Reference equality, not just a matching shape: the catch must not
    // wrap, reshape, or replace the error it re-throws.
    await expect(
      appendEvent(s.orgId, s.fixtureId, 0, { type: "core.start", payload: {} }),
    ).rejects.toBe(boom);

    const crashed = linesNamed("scoring event fold crashed");
    expect(crashed).toHaveLength(1);
    expect(crashed[0]).toMatchObject({
      fixtureId: s.fixtureId,
      eventType: "core.start",
      seq: 1,
    });
    // Neither sibling branch fired for this error, and nothing was written.
    expect(linesNamed("scoring event refused")).toHaveLength(0);
    expect(linesNamed("scoring event appended")).toHaveLength(0);
  });

  it("K9 (F9, R3.5 review): a rollback AFTER the fold succeeds must NOT have logged an accepted-event line", async () => {
    const s = await seed();

    // Call appendEventInTx directly, inside OUR OWN transaction — the same
    // shape the P11 batch importer uses (event-import.ts), and the pattern
    // append-event-in-tx.test.ts's own "rolls back every event" test uses —
    // so we control what happens to the surrounding transaction AFTER the
    // fold succeeds and BEFORE it commits. `withTenant` (postgres.js
    // `sql.begin`) only issues COMMIT once this callback resolves; throwing
    // here forces a ROLLBACK of everything appendEventInTx already did,
    // exactly the window F9 closes.
    await expect(
      withTenant(s.orgId, async (tx) => {
        await appendEventInTx(tx, s.orgId, s.fixtureId, 0, { type: "core.start", payload: {} });
        throw new Error("deliberate rollback — simulates a throw between the fold and commit");
      }),
    ).rejects.toThrow("deliberate rollback");

    // Guard against a vacuous pass: the fold really did succeed and really
    // did roll back, not just "nothing happened". If the write had landed,
    // this fixture would show in_play.
    const [row] = await sql<{ status: string }[]>`
      select status from fixtures where id = ${s.fixtureId}
    `;
    expect(row.status).toBe("scheduled");

    // The whole point of F9: a line claiming the append happened is only
    // honest once the write actually committed. Before the fix this fired
    // unconditionally the moment the fold succeeded, regardless of what the
    // surrounding transaction went on to do — so this assertion is RED
    // against the old code (see the task report for the captured run) even
    // though it never calls `appendEvent` at all.
    expect(linesNamed("scoring event appended")).toHaveLength(0);
  });

  it("K3: the accepted-event line shows the decider phase once the fold enters SHOOTOUT", async () => {
    const cfg = football.configSchema.parse({
      extraTime: { enabled: false, halfMinutes: 15 },
      shootout: true,
    });
    const s = await seedFootball(cfg);
    await appendEvent(s.orgId, s.fixtureId, 0, { type: "core.start", payload: {} });
    await appendEvent(s.orgId, s.fixtureId, 1, {
      type: "football.period",
      payload: { phase: "HT" },
    });
    lines.length = 0;

    // 0-0 at FT, extraTime disabled, shootout enabled -> phase flips straight
    // to SHOOTOUT (football.ts resolveFullTime) with zero kicks posted yet.
    await appendEvent(s.orgId, s.fixtureId, 2, {
      type: "football.period",
      payload: { phase: "FT" },
    });

    const accepted = linesNamed("scoring event appended");
    expect(accepted).toHaveLength(1);
    expect(accepted[0]).toMatchObject({
      eventType: "football.period",
      phase: "SHOOTOUT",
      status: "in_play",
    });
    // R3.5 ruling: no separate "entered a decider" line — the phase field on
    // this SAME accepted-event line is what makes a decider visible.
    expect(parsedLines().some((l) => typeof l.msg === "string" && /decider/i.test(l.msg))).toBe(
      false,
    );
  });

  it("K4: logs the decided transition with outcome.kind and outcome.method", async () => {
    const cfg = football.configSchema.parse({
      extraTime: { enabled: false, halfMinutes: 15 },
      shootout: true,
    });
    const s = await seedFootball(cfg);
    let seq = 0;
    const post = async (type: string, payload: unknown) => {
      await appendEvent(s.orgId, s.fixtureId, seq, { type, payload });
      seq += 1;
    };
    const kick = (by: "home" | "away", scored: boolean) =>
      post("football.shootout.kick", { by: by === "home" ? s.home : s.away, scored });

    await post("core.start", {});
    await post("football.period", { phase: "HT" });
    await post("football.period", { phase: "FT" }); // 0-0, extraTime off -> SHOOTOUT
    // The exact sequence football.test.ts's own golden decides 4-3 on: 5
    // kicks each, method "shootout" (packages/engine football golden (b)).
    await kick("home", true);
    await kick("away", true);
    await kick("home", true);
    await kick("away", true);
    await kick("home", true);
    await kick("away", true);
    await kick("home", false);
    await kick("away", false);
    await kick("home", true);
    lines.length = 0;
    await kick("away", false); // 4-3 after 5 kicks each -> decides

    const decided = linesNamed("fixture decided");
    expect(decided).toHaveLength(1);
    expect(decided[0]).toMatchObject({
      fixtureId: s.fixtureId,
      sportKey: "football",
      kind: "win",
      method: "shootout",
    });
    // The accepted-event line for this same event reflects the decision too.
    const accepted = linesNamed("scoring event appended");
    expect(accepted).toHaveLength(1);
    expect(accepted[0]).toMatchObject({ phase: "done", status: "decided" });
  });

  it("K10 (F9, R3.5 review): a rollback AFTER the DECIDING fold succeeds must NOT have logged 'fixture decided' either", async () => {
    const cfg = football.configSchema.parse({
      extraTime: { enabled: false, halfMinutes: 15 },
      shootout: true,
    });
    const s = await seedFootball(cfg);
    let seq = 0;
    const post = async (type: string, payload: unknown) => {
      await appendEvent(s.orgId, s.fixtureId, seq, { type, payload });
      seq += 1;
    };
    const kick = (by: "home" | "away", scored: boolean) =>
      post("football.shootout.kick", { by: by === "home" ? s.home : s.away, scored });

    await post("core.start", {});
    await post("football.period", { phase: "HT" });
    await post("football.period", { phase: "FT" }); // 0-0, extraTime off -> SHOOTOUT
    await kick("home", true);
    await kick("away", true);
    await kick("home", true);
    await kick("away", true);
    await kick("home", true);
    await kick("away", true);
    await kick("home", false);
    await kick("away", false);
    await kick("home", true);
    lines.length = 0;

    // The 10th kick (4-3 after 5 each) is the one that decides — append it
    // directly, inside OUR transaction, so it can be rolled back after the
    // fold succeeds. Same window as K9, for the OTHER log line.
    await expect(
      withTenant(s.orgId, async (tx) => {
        await appendEventInTx(tx, s.orgId, s.fixtureId, seq, {
          type: "football.shootout.kick",
          payload: { by: s.away, scored: false },
        });
        throw new Error("deliberate rollback — simulates a throw between the fold and commit");
      }),
    ).rejects.toThrow("deliberate rollback");

    // Guard against a vacuous pass: still mid-shootout, not decided — the
    // fixtures row update the fold's outcome would have driven never landed.
    const [row] = await sql<{ status: string; outcome: unknown }[]>`
      select status, outcome from fixtures where id = ${s.fixtureId}
    `;
    expect(row.status).toBe("in_play");
    expect(row.outcome).toBeNull();

    expect(linesNamed("fixture decided")).toHaveLength(0);
    expect(linesNamed("scoring event appended")).toHaveLength(0);
  });

  it("K5: never logs an event payload, a person name, or an email", async () => {
    const s = await seed();
    await appendEvent(s.orgId, s.fixtureId, 0, { type: "core.start", payload: {} });
    lines.length = 0;

    const emailMarker = "jane.doe+consent-marker@example.com";
    await appendEvent(s.orgId, s.fixtureId, 1, {
      type: "generic.score",
      payload: { by: s.home, points: 3, person: emailMarker },
    });

    // Guard against a vacuous pass: the event really was accepted and logged.
    expect(linesNamed("scoring event appended")).toHaveLength(1);
    const raw = lines.join("\n");
    expect(raw.includes(emailMarker)).toBe(false);
    expect(raw.includes(s.home)).toBe(false);
  });
});

/** A home side of a starter and a bench player and an away side of a starter, as the organiser's team sheet saves them
 *  (`PUT /fixtures/{id}/lineups/{entrantId}` writes exactly these rows). Raw SQL, like `seed`. */
async function seedSheets(s: Seed): Promise<{ homeStarter: string; homeBench: string; awayStarter: string }> {
  const person = async (name: string): Promise<string> => {
    const [{ id }] = await sql<{ id: string }[]>`insert into persons (org_id, full_name) values (${s.orgId}, ${name}) returning id`;
    return id;
  };
  const homeStarter = await person("Gina Starter");
  const homeBench = await person("Bea Bench");
  const awayStarter = await person("Al Away");
  for (const [entrantId, personId, slot, orderNo] of [
    [s.home, homeStarter, "starting", 1],
    [s.home, homeBench, "bench", 2],
    [s.away, awayStarter, "starting", 1],
  ] as const) {
    await sql`insert into entrant_members (entrant_id, person_id, org_id) values (${entrantId}, ${personId}, ${s.orgId})`;
    await sql`insert into lineups (fixture_id, entrant_id, person_id, org_id, slot, order_no) values (${s.fixtureId}, ${entrantId}, ${personId}, ${s.orgId}, ${slot}, ${orderNo})`;
  }
  return { homeStarter, homeBench, awayStarter };
}
const ledgerSize = async (fixtureId: string): Promise<number> => {
  const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from score_events where fixture_id = ${fixtureId}`;
  return n;
};

// Engine lineup fix (owner ruling 2026-10-15, option 1). `POST /api/v1/fixtures/{id}/events` ends in `appendEvent`, so this is the
// route's refusal: a sport that declares no `lineupPolicy` takes no `core.lineup.*` event, and the engine's own EngineError
// (`LINEUP_NOT_SUPPORTED`, a 422 by `ENGINE_HTTP`) is what the caller gets. Verified live on 2026-10-15 before the fix: a `dl_`
// bearer got a 201 for a substitution in generic, and a later tap credited the player taken off.
describe.skipIf(!HAS_DB)("a lineup event is refused by the append path of a sport that declares no lineupPolicy (engine lineup fix)", () => {
  const lineupEvents = (s: Seed, sheets: { homeStarter: string; homeBench: string }) => ({
    substitution: { type: "core.lineup.substitution", payload: { side: s.home, off: sheets.homeStarter, on: { personId: sheets.homeBench, slot: "starting", orderNo: 2 } } },
    retirement: { type: "core.lineup.retirement", payload: { side: s.home, personId: sheets.homeStarter } },
  });

  it("generic, the sport where a tap went on crediting the player taken off: refused first, mid-match and after a void, and every refusal leaves the ledger and its seq untouched", async () => {
    const s = await seed();
    const sheets = await seedSheets(s);
    const ev = lineupEvents(s, sheets);
    let refusals = 0;
    const refuse = async (seq: number, event: { type: string; payload: unknown }) => {
      await expect(appendEvent(s.orgId, s.fixtureId, seq, event)).rejects.toMatchObject({ code: "LINEUP_NOT_SUPPORTED" });
      refusals++;
    };

    // the first event of a fixture nobody started: the refusal is the sport's, not WRONG_PHASE
    await refuse(0, ev.substitution);
    expect(await ledgerSize(s.fixtureId), "nothing written").toBe(0);
    expect(linesNamed("scoring event refused").at(-1)).toMatchObject({ fixtureId: s.fixtureId, eventType: "core.lineup.substitution", code: "LINEUP_NOT_SUPPORTED" });

    await appendEvent(s.orgId, s.fixtureId, 0, { type: "core.start", payload: {} });
    // mid-match, then the same refusal a second time: the answer does not drift with a repeat
    await refuse(1, ev.substitution);
    await refuse(1, ev.substitution);
    await refuse(1, ev.retirement);
    expect(await ledgerSize(s.fixtureId), "only the start is on the ledger").toBe(1);

    // the refusals consumed no seq: the next legal event goes in at the SAME expected seq, and a credit to the starter is the starter's
    await appendEvent(s.orgId, s.fixtureId, 1, { type: "generic.score", payload: { by: s.home, points: 1, person: sheets.homeStarter } });
    // after a void: strike that score, then offer the substitution again
    const [scored] = await sql<{ id: string }[]>`select id from score_events where fixture_id = ${s.fixtureId} and type = 'generic.score'`;
    await appendEvent(s.orgId, s.fixtureId, 2, { type: "core.void", payload: {}, voids: scored!.id });
    await refuse(3, ev.substitution);
    expect(await ledgerSize(s.fixtureId), "start, score, void").toBe(3);
    // and play carries on after the last refusal
    await appendEvent(s.orgId, s.fixtureId, 3, { type: "generic.score", payload: { by: s.away, points: 1, person: sheets.awayStarter } });
    expect(await ledgerSize(s.fixtureId)).toBe(4);
    // every refusal was logged by the funnel with its code, and none was swallowed
    expect(refusals).toBe(5);
    expect(linesNamed("scoring event refused").filter((l) => l.code === "LINEUP_NOT_SUPPORTED")).toHaveLength(refusals);
  });

  it("a ledger that already holds a lineup event keeps taking play, a note and the void of that event, and a NEW lineup event is still refused (replay is lenient, the write path is not)", async () => {
    // A generic fixture scored before the ruling: its ledger holds a substitution the engine accepted then. Raw rows, because
    // that is how such a ledger exists - nothing can write one through the funnel any more.
    const s = await seed();
    const sheets = await seedSheets(s);
    const legacyId = randomUUID();
    const rawEvent = async (id: string, seq: number, type: string, payload: unknown) => {
      await sql`
        insert into score_events (id, fixture_id, seq, type, payload, recorded_by, recorded_at)
        values (${id}, ${s.fixtureId}, ${seq}, ${type}, ${sql.json(payload as never)}, null, now())`;
    };
    await rawEvent(randomUUID(), 1, "core.start", {});
    await rawEvent(legacyId, 2, "core.lineup.substitution", { side: s.home, off: sheets.homeStarter, on: { personId: sheets.homeBench, slot: "starting", orderNo: 2 } });
    expect(await ledgerSize(s.fixtureId), "the legacy ledger is on the table").toBe(2);
    const legacyEvent = lineupEvents(s, sheets).substitution;

    // the new lineup event is refused on top of the legacy ledger: the gate judges the CANDIDATE, not history
    await expect(appendEvent(s.orgId, s.fixtureId, 2, legacyEvent)).rejects.toMatchObject({ code: "LINEUP_NOT_SUPPORTED" });
    expect(await ledgerSize(s.fixtureId)).toBe(2);

    // play, an annotation and the undo of the legacy event are all taken: a strict fold of the stored event would refuse each of
    // them (and brick the fixture, with no event the scorer could void)
    await expect(appendEvent(s.orgId, s.fixtureId, 2, { type: "generic.score", payload: { by: s.home, points: 1, person: sheets.homeStarter } }), "play over a legacy lineup event").resolves.toBeDefined();
    await expect(appendEvent(s.orgId, s.fixtureId, 3, { type: "core.note", payload: { text: "after the ruling" } }), "a note over a legacy lineup event").resolves.toBeDefined();
    await expect(appendEvent(s.orgId, s.fixtureId, 4, { type: "core.void", payload: {}, voids: legacyId }), "the void of the legacy lineup event").resolves.toBeDefined();
    expect(await ledgerSize(s.fixtureId), "start, legacy substitution, score, note, void").toBe(5);

    // and with the legacy event struck, the new lineup event is still refused, and play still goes on
    await expect(appendEvent(s.orgId, s.fixtureId, 5, legacyEvent)).rejects.toMatchObject({ code: "LINEUP_NOT_SUPPORTED" });
    await expect(appendEvent(s.orgId, s.fixtureId, 5, { type: "generic.score", payload: { by: s.away, points: 1, person: sheets.awayStarter } }), "play after the void").resolves.toBeDefined();
    expect(await ledgerSize(s.fixtureId)).toBe(6);
  });

  it("every sport, by its own declaration: a retirement of a starter after the start is refused where no lineupPolicy is declared (ledger unchanged) and recorded where one is", async () => {
    let refused = 0;
    let recorded = 0;
    for (const { key, module: mod } of sportCases()) {
      const cfg = mod.configSchema.parse(mod.variants[Object.keys(mod.variants)[0]!] ?? {});
      const s = await seed({ sportKey: key, config: cfg, moduleVersion: mod.version, positionCatalog: mod.positions });
      const sheets = await seedSheets(s);
      await appendEvent(s.orgId, s.fixtureId, 0, { type: "core.start", payload: {} });
      const { retirement } = lineupEvents(s, sheets);
      if (mod.lineupPolicy === undefined) {
        await expect(appendEvent(s.orgId, s.fixtureId, 1, retirement), key).rejects.toMatchObject({ code: "LINEUP_NOT_SUPPORTED" });
        expect(await ledgerSize(s.fixtureId), `${key}: refused, so only the start`).toBe(1);
        refused++;
      } else {
        await appendEvent(s.orgId, s.fixtureId, 1, retirement);
        expect(await ledgerSize(s.fixtureId), `${key}: recorded, so the start and the retirement`).toBe(2);
        recorded++;
      }
    }
    // anti-vacuity: both sides of the declaration were driven through the real funnel
    expect(refused, "sports that refuse").toBeGreaterThan(0);
    expect(recorded, "sports that record").toBeGreaterThan(0);
    expect(refused + recorded).toBe(sportCases().length);
  }, 120_000);
});

// Static, DB-independent checks — always run, regardless of DATABASE_URL.
const TEST_DIR = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(TEST_DIR, "../../../../../..");
const V3_DIR = resolve(REPO_ROOT, "apps/web/src/components/v2/scorepad/v3");
const ENGINE_SPORTS_DIR = resolve(REPO_ROOT, "packages/engine/src/sports");

function sourceFilesUnder(dir: string, exts: string[]): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "__tests__" || entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...sourceFilesUnder(full, exts));
    } else if (exts.some((ext) => entry.name.endsWith(ext)) && !entry.name.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

describe.skipIf(!HAS_DB)("firstResult and the held status (W2a T8, spec §5.4.4)", () => {
  it("X-BR-2: a held fixture does not count as a first result; its settle does", async () => {
    // Football with no extra time and no shootout: a 0–0 full time in a KNOCKOUT is a level result with no decider,
    // held as needs_decision (ruling 79). The witness is the "fixture decided" line — the one consumer of
    // firstResult this file can observe (PostHog's capture reads the same value, append-event.ts).
    const s = await seedFootball(football.configSchema.parse({ extraTime: { enabled: false, halfMinutes: 15 }, shootout: false }));
    await sql`update stages set kind = 'knockout' where id = ${s.stageId}`;
    let seq = 0;
    const post = async (type: string, payload: unknown) => {
      const r = await appendEvent(s.orgId, s.fixtureId, seq, { type, payload });
      seq += 1;
      return r;
    };
    await post("core.start", {});
    await post("football.period", { phase: "HT" });
    lines.length = 0;
    const ft = await post("football.period", { phase: "FT" });
    expect(ft.status).toBe("needs_decision");
    expect(linesNamed("fixture decided")).toHaveLength(0); // held: not a result yet
    lines.length = 0;
    const settled = await post("core.settle", { winner: s.home, method: "organiser" });
    expect(settled.status).toBe("decided");
    const decided = linesNamed("fixture decided");
    expect(decided).toHaveLength(1); // the settle IS the first result, though fixture.outcome was already set
    expect(decided[0]).toMatchObject({ fixtureId: s.fixtureId, kind: "win", method: "settled_organiser" });
  });
});

describe("no logger outside the sanctioned funnel (R3.5 Task K, K6/K7)", () => {
  it("K6: no v3 skin imports @/server/** (a client-component build failure tsc cannot see)", () => {
    const files = sourceFilesUnder(V3_DIR, [".ts", ".tsx"]);
    expect(files.length).toBeGreaterThan(0); // guard: the scan really found files
    const offenders = files.filter((f) => /from\s+["']@\/server\//.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("K7: no sport module imports a logger (packages/engine is zero-effectful-deps by declaration)", () => {
    const files = sourceFilesUnder(ENGINE_SPORTS_DIR, [".ts"]);
    expect(files.length).toBeGreaterThan(0);
    const offenders = files.filter((f) =>
      /from\s+["']pino["']|require\(\s*["']pino["']\s*\)/.test(readFileSync(f, "utf8")),
    );
    expect(offenders).toEqual([]);
  });
});

// W2e T32 fix round 2 (item 3) — the API behaviour `docs/api-v1-breaking-changes.md` (2026-10-29) promises, at the funnel
// `POST /api/v1/fixtures/{id}/events` ends in, through the route's own `v1()` wrapper: a football `core.lineup.*` event is
// judged on the pitch a `football.sub` left. single-sport: football is the one sport with a second substitution vocabulary
// (`squadsForLineup`; w2e-retirement.test.ts pins that from the skins).
describe.skipIf(!HAS_DB)("W2e M12b: a football lineup event is judged on the pitch a football.sub left (POST /fixtures/{id}/events)", () => {
  it("retiring the starter football.sub took off is 422 LINEUP_INVALID, nothing written; retiring the substitute it brought on is accepted and written", async () => {
    const s = await seedFootball(football.configSchema.parse({}));
    const sheets = await seedSheets(s);
    const retire = (personId: string) => ({ type: "core.lineup.retirement", payload: { side: s.home, personId, reason: "injured" } });
    await appendEvent(s.orgId, s.fixtureId, 0, { type: "core.start", payload: {} });
    await appendEvent(s.orgId, s.fixtureId, 1, { type: "football.sub", payload: { by: s.home, off: sheets.homeStarter, on: sheets.homeBench } });
    expect(await ledgerSize(s.fixtureId), "start, sub").toBe(2);

    // The refusal, as the route answers it: the documented status, code and sentence, and the ledger untouched.
    const refused = await v1(() => appendEvent(s.orgId, s.fixtureId, 2, retire(sheets.homeStarter)));
    expect(refused.status).toBe(422);
    const body = (await refused.json()) as { ok: boolean; error: { code: string; message: string } };
    expect(body).toMatchObject({ ok: false, error: { code: "LINEUP_INVALID", message: `"${sheets.homeStarter}" is not on the field` } });
    expect(await ledgerSize(s.fixtureId), "nothing written").toBe(2);
    expect(linesNamed("scoring event refused").at(-1)).toMatchObject({ fixtureId: s.fixtureId, eventType: "core.lineup.retirement", code: "LINEUP_INVALID" });

    // The substitute football.sub brought on retires: accepted at the same expected seq (the refusal consumed none), written.
    const accepted = await v1(() => appendEvent(s.orgId, s.fixtureId, 2, retire(sheets.homeBench)));
    expect(accepted.status).toBeLessThan(300);
    expect(await ledgerSize(s.fixtureId), "start, sub, retirement").toBe(3);
    const [last] = await sql<{ type: string; payload: { personId: string } }[]>`
      select type, payload from score_events where fixture_id = ${s.fixtureId} order by seq desc limit 1`;
    expect(last).toMatchObject({ type: "core.lineup.retirement", payload: { personId: sheets.homeBench } });
  });
});
