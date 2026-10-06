// Capture QR v2 §6.4 (W28, owner sign-off 2026-10-06): the descriptor's optional `stage` — `{code, role, pool?}` — on
// the waiting shape and every session state, driven through the REAL descriptor (`getCode`) over REAL generated stages
// of every family: knockout (R16, QF, SF, F, 3rd), double elimination (WB, LB, GF, GF2), page playoff, stepladder,
// league, Swiss, and a group with pools; an `es` org; and the empty and refused cases.
//
// Expected values come from the sources of truth, never from capture-stage.ts:
//  - `code` is "exactly the board chip": the board's OWN read (`listDivisionFixturesForBoard`) through the board's own
//    `boardRoundCodes`, else the card's `R{round_no}` (fixture-block.tsx) — plus a literal tally per family from the
//    rulebook (a knockout of 8 is QF ×4, SF ×2, F, 3rd), so a board that went wrong cannot carry this test with it;
//  - `role` is the ENGINE's `roundRole` (via `roundRoleFor`) over the FULL row read (`listDivisionFixtures`);
//  - `pool` is `pools.key`, read here by its own statement.
// Every sweep counts what it checked; zero checked is a failure.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import type { RoundRole } from "@seazn/engine/competition";
import { sql } from "@/lib/db";
import type { Locale } from "@/lib/i18n-constants";
import type { MessageKey } from "@/lib/messages";
import { msgFor } from "@/lib/messages-i18n";
import { roundRoleFor } from "@/lib/round-role-label";
import { boardRoundCodes, type RoundCodeFixture } from "@/components/v2/board/round-codes";
import type { AuthCtx } from "@/server/api-v1/auth";
import { CaptureDescriptor, type CaptureStage } from "@/server/api-v1/capture-schemas";
import { log } from "@/server/logger";
import { FakeIngest, FakeRunner } from "@/server/relay/fakes";
import { getCode } from "../capture-phone";
import { buildCaptureStage } from "../capture-stage";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { listDivisionFixtures, listDivisionFixturesForBoard } from "../fixtures";
import { createStages, generateStageFixtures, listStages } from "../stages";
import { ensureStreamCode } from "../stream-codes";
import type { SessionDeps } from "../stream-sessions";
import { captureRig, override, phoneId } from "./_capture-rig";
import { GENERIC_CONFIG, seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

const ENV_KEYS = ["RELAY_KEK", "AUTH_SECRET", "OAUTH_BASE_URL", "NEXT_PUBLIC_BASE_URL", "STREAM_INGEST_HOST", "STREAM_PLAYBACK_HOST", "STREAM_SRT_ENABLED", "RELAY_DRIVERS"] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const KEK = randomBytes(32).toString("hex");
function baseEnv() {
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.RELAY_KEK = KEK;
  process.env.AUTH_SECRET = "capture-stage-test-secret";
}
beforeAll(baseEnv);
beforeEach(baseEnv);
afterAll(() => { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

const msgOf = (locale: Locale) => (key: MessageKey, vars?: Record<string, string | number>) => msgFor(locale, key, vars);
const en = msgOf("en");
const tally = (xs: string[]) => xs.reduce<Record<string, number>>((acc, x) => ((acc[x] = (acc[x] ?? 0) + 1), acc), {});
const fakeDeps = (): SessionDeps => {
  const ingest = new FakeIngest({ clock: () => Date.now(), connectAfterMs: 3000 });
  return { drivers: { ingest, runner: new FakeRunner() }, now: () => new Date(), appUrl: "http://app.test" };
};

// ---------------------------------------------------------------------------
// The builder's guards (pure): each "cannot happen" is a refusal a test reaches.
// ---------------------------------------------------------------------------

const STAGE = randomUUID();
const row = (o: Partial<RoundCodeFixture> & { round_no: number; seq_in_round?: number }): RoundCodeFixture => ({
  id: randomUUID(), stage_id: STAGE, seq_in_round: 1, ext_key: null, lane: null, is_final: false, third_place: false, conditional: false, ...o,
});

describe("buildCaptureStage — its guards (pure)", () => {
  it("the empty case: a stage of ONE fixture (round 1 of a league) → R1, plain_round 1, no pool", () => {
    const only = row({ round_no: 1 });
    expect(buildCaptureStage({ fixtureId: only.id, stageKind: "league", poolKey: null, rows: [only] }, en))
      .toEqual({ code: "R1", role: { kind: "plain_round", n: 1 } });
  });

  it("an assumption made a guard: a fixture that is not among its stage's rows is refused by name, never answered", () => {
    expect(() => buildCaptureStage({ fixtureId: randomUUID(), stageKind: "league", poolKey: null, rows: [row({ round_no: 1 })] }, en))
      .toThrow(/not among its stage's rows/);
    expect(() => buildCaptureStage({ fixtureId: randomUUID(), stageKind: "league", poolKey: null, rows: [] }, en))
      .toThrow(/not among its stage's rows/);
  });

  it("a code the contract cannot carry (9+ characters) omits the WHOLE stage and logs it; 8 characters is carried (the boundary pair)", () => {
    const warn = vi.spyOn(log, "warn");
    let warned: unknown[][];
    let nine: CaptureStage | null, eight: CaptureStage | null;
    try {
      const long = row({ round_no: 12345678 });
      nine = buildCaptureStage({ fixtureId: long.id, stageKind: "league", poolKey: "A", rows: [long] }, en);
      const edge = row({ round_no: 1234567 });
      eight = buildCaptureStage({ fixtureId: edge.id, stageKind: "league", poolKey: null, rows: [edge] }, en);
    } finally {
      warned = [...warn.mock.calls];
      warn.mockRestore();
    }
    expect(nine!).toBeNull();
    expect(eight!).toEqual({ code: "R1234567", role: { kind: "plain_round", n: 1 } });
    expect(JSON.stringify(warned)).toContain("stage omitted");
  });

  it("pools.key has no CHECK: \"AA\", \"a\" and \"\" are omitted (logged) and the rest of the stage kept; \"B\" is carried", () => {
    const f = row({ round_no: 2 });
    const warn = vi.spyOn(log, "warn");
    let warned: unknown[][];
    const got: Record<string, CaptureStage | null> = {};
    try {
      for (const key of ["AA", "a", "", "B"]) got[key] = buildCaptureStage({ fixtureId: f.id, stageKind: "group", poolKey: key, rows: [row({ round_no: 1 }), f] }, en);
    } finally {
      warned = [...warn.mock.calls];
      warn.mockRestore();
    }
    let checked = 0;
    for (const key of ["AA", "a", ""]) {
      expect(got[key], key).toEqual({ code: "R2", role: { kind: "plain_round", n: 2 } });
      checked++;
    }
    expect(checked).toBe(3);
    expect(got.B).toEqual({ code: "R2", role: { kind: "plain_round", n: 2 }, pool: "B" });
    expect(warned.filter((c) => JSON.stringify(c).includes("pool omitted"))).toHaveLength(3);
  });

  it("a legacy bracket (no is_final row, pre-V368): the board leaves it R{n}, and the role is the plain ordinal — never the guess the column defaults make (a bronze 'final'); with is_final set, the board codes it and the role is the engine's", () => {
    // A knockout of 4 with a bronze match, as V368's defaults leave it: no lane, no flags.
    const legacy = [row({ round_no: 1, seq_in_round: 1 }), row({ round_no: 1, seq_in_round: 2 }), row({ round_no: 2, seq_in_round: 1 }), row({ round_no: 2, seq_in_round: 2 })];
    expect(boardRoundCodes(legacy, [{ id: STAGE, kind: "knockout" }], en).size, "PREMISE: the board refuses to code it").toBe(0);
    const bronze = legacy[3]!;
    const guess = roundRoleFor(legacy.map((f) => ({ round_no: f.round_no, lane: null })), { round_no: 2, lane: null, is_final: false, third_place: false, conditional: false }, "knockout");
    expect(guess.kind, "PREMISE: the engine would guess 'final' from the defaults").toBe("final");
    expect(buildCaptureStage({ fixtureId: bronze.id, stageKind: "knockout", poolKey: null, rows: legacy }, en))
      .toEqual({ code: "R2", role: { kind: "plain_round", n: 2 } });
    // The positive pair: the same rows written by today's generator (is_final on the final, the flag on the bronze).
    const today = legacy.map((f, i) => (i === 2 ? { ...f, is_final: true } : i === 3 ? { ...f, third_place: true } : f));
    expect(buildCaptureStage({ fixtureId: bronze.id, stageKind: "knockout", poolKey: null, rows: today }, en))
      .toEqual({ code: en("bracket.roundShort.thirdPlace"), role: { kind: "third_place" } });
    expect(buildCaptureStage({ fixtureId: today[2]!.id, stageKind: "knockout", poolKey: null, rows: today }, en))
      .toEqual({ code: en("bracket.roundShort.final"), role: { kind: "final" } });
  });
});

// ---------------------------------------------------------------------------
// Every family through the REAL descriptor.
// ---------------------------------------------------------------------------

type Kind = "knockout" | "double_elim" | "page_playoff" | "stepladder" | "league" | "swiss" | "group";

/** What the board shows and the engine says, for every fixture of the division — never capture-stage.ts. */
async function expectedFor(auth: AuthCtx, divisionId: string, locale: Locale) {
  const [board, full, stages] = await Promise.all([
    listDivisionFixturesForBoard(auth, divisionId), listDivisionFixtures(auth, divisionId), listStages(auth, divisionId),
  ]);
  const codes = boardRoundCodes(board, stages, msgOf(locale));
  const kindOf = new Map(stages.map((s) => [s.id, s.kind]));
  const pools = new Map((await sql<{ id: string; key: string | null }[]>`
    select f.id, p.key from fixtures f left join pools p on p.id = f.pool_id where f.division_id = ${divisionId}`).map((r) => [r.id, r.key]));
  const want = new Map<string, CaptureStage>();
  for (const f of full) {
    const laneRows = full.filter((x) => x.stage_id === f.stage_id).map((x) => ({ round_no: x.round_no, lane: x.lane ?? null }));
    const role: RoundRole = roundRoleFor(laneRows, {
      round_no: f.round_no, lane: f.lane ?? null, is_final: f.is_final === true, third_place: f.third_place === true, conditional: f.conditional === true,
    }, kindOf.get(f.stage_id)!, f.ext_key ?? null);
    const boardRow = board.find((b) => b.id === f.id)!;
    const pool = pools.get(f.id) ?? null;
    want.set(f.id, { code: codes.get(f.id)?.code ?? `R${boardRow.round_no}`, role: { ...role }, ...(pool !== null ? { pool } : {}) });
  }
  return { want, full, codes };
}

let stagesChecked = 0;
/** One division, `n` seeded entrants, one generated stage of `kind`; a stream code minted for EVERY fixture through the
 *  real `ensureStreamCode`, and each fixture's waiting descriptor read through the real `getCode`. */
async function family(kind: Kind, n: number, config: Record<string, unknown>, opts: { locale?: Locale; generate?: number } = {}) {
  const locale = opts.locale ?? "en";
  const { auth } = await seedOrg("pro");
  if (locale !== "en") await sql`update organizations set default_locale = ${locale} where id = ${auth.orgId}`;
  await override(auth.orgId, "streaming.relay", true);
  const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: `Capture stage ${kind}`, visibility: "private", branding: {} });
  const division = await createDivision(auth, comp.id, { name: "Open", slug: "open", sport_key: "generic", variant_key: "score", config: GENERIC_CONFIG });
  await createEntrants(auth, division.id, Array.from({ length: n }, (_, i) => ({ kind: "individual" as const, display_name: `Entrant ${i + 1}`, seed: i + 1, members: [] })));
  const [stage] = await createStages(auth, division.id, { seq: 1, kind, name: kind, config });
  for (let i = 0; i < (opts.generate ?? 1); i++) await generateStageFixtures(auth, stage!.id);
  const { want, full, codes } = await expectedFor(auth, division.id, locale);
  const got = new Map<string, CaptureStage>();
  for (const f of full) {
    const shown = await ensureStreamCode(auth, f.id);
    const body = await getCode(shown.qr.code, shown.qr.tok, { slot: 0, phone: null }, fakeDeps(), new Date());
    expect(body.state, f.id).toBe("waiting");
    expect(CaptureDescriptor.parse(body)).toEqual(body);
    expect(body.stage, `${kind} fixture ${f.id} (round ${f.round_no})`).toEqual(want.get(f.id));
    got.set(f.id, body.stage!);
    stagesChecked++;
  }
  expect(got.size, `anti-vacuity: ${kind} checked every fixture`).toBe(full.length);
  expect(got.size).toBeGreaterThan(0);
  const stages = [...got.values()];
  return {
    auth, divisionId: division.id, full, codes, got,
    codeTally: tally(stages.map((s) => s.code)),
    kindTally: tally(stages.map((s) => s.role.kind)),
  };
}

describe.skipIf(!HAS_DB)("the descriptor's stage over every family (W28)", () => {
  it("knockout of 8 with a bronze match: QF ×4, SF ×2, F, 3rd — the roles quarter_final, semi_final, final, third_place", async () => {
    const r = await family("knockout", 8, { thirdPlace: true });
    expect(r.codeTally).toEqual({ QF: 4, SF: 2, F: 1, "3rd": 1 });
    expect(r.kindTally).toEqual({ quarter_final: 4, semi_final: 2, final: 1, third_place: 1 });
  });

  it("knockout of 16: R16 ×8, carried as round_of with entrants 16", async () => {
    const r = await family("knockout", 16, {});
    expect(r.codeTally).toEqual({ R16: 8, QF: 4, SF: 2, F: 1 });
    const opening = [...r.got.values()].filter((s) => s.code === "R16");
    expect(opening.map((s) => s.role)).toEqual(Array(8).fill({ kind: "round_of", entrants: 16 }));
  });

  it("double elimination of 8 with a reset: WB1–3, LB1–4, GF, GF2 — the roles verbatim, losers_round carrying n", async () => {
    const r = await family("double_elim", 8, { bracketReset: true });
    expect(new Set(Object.keys(r.codeTally))).toEqual(new Set(["WB1", "WB2", "WB3", "LB1", "LB2", "LB3", "LB4", "GF", "GF2"]));
    expect(r.codeTally.GF).toBe(1);
    expect(r.codeTally.GF2).toBe(1);
    expect(new Set(Object.keys(r.kindTally))).toEqual(new Set(["quarter_final", "semi_final", "winners_final", "losers_round", "losers_final", "grand_final", "grand_final_reset"]));
    const losers = [...r.got.values()].filter((s) => s.role.kind === "losers_round");
    expect(losers.length).toBeGreaterThan(0);
    for (const s of losers) expect(s.role.n, s.code).toBeGreaterThanOrEqual(1);
  });

  it("page playoff of 4: Q1, E, Q2, F — qualifier1, eliminator, qualifier2, final", async () => {
    const r = await family("page_playoff", 4, {});
    expect(r.codeTally).toEqual({ Q1: 1, E: 1, Q2: 1, F: 1 });
    expect(r.kindTally).toEqual({ qualifier1: 1, eliminator: 1, qualifier2: 1, final: 1 });
  });

  it("stepladder of 5: E1, E2, E3, F — rung n 1..3, then final", async () => {
    const r = await family("stepladder", 5, {});
    expect(r.codeTally).toEqual({ E1: 1, E2: 1, E3: 1, F: 1 });
    expect([...r.got.values()].filter((s) => s.role.kind === "rung").map((s) => s.role.n).sort()).toEqual([1, 2, 3]);
    expect(r.kindTally.final).toBe(1);
  });

  it("league of 4: the board codes nothing, so R1–R3 (two each), plain_round n = the round", async () => {
    const r = await family("league", 4, {});
    expect(r.codes.size, "PREMISE: the board codes no league round").toBe(0);
    expect(r.codeTally).toEqual({ R1: 2, R2: 2, R3: 2 });
    for (const s of r.got.values()) expect(s.role).toEqual({ kind: "plain_round", n: Number(s.code.slice(1)) });
  });

  it("Swiss (one round of 6): R1 ×3, plain_round 1", async () => {
    const r = await family("swiss", 6, { rounds: 1 }, { generate: 2 });
    expect(r.codeTally).toEqual({ R1: 3 });
    expect(r.kindTally).toEqual({ plain_round: 3 });
  });

  it("a group of 8 in two pools: R{n} and plain_round, each fixture carrying its pool's KEY (A or B, six each) — and a key the contract refuses (\"AA\") is omitted from the stage, which stays", async () => {
    const r = await family("group", 8, { pools: { count: 2 } });
    expect(tally([...r.got.values()].map((s) => s.pool ?? "none"))).toEqual({ A: 6, B: 6 });
    expect(r.codes.size).toBe(0);
    for (const s of r.got.values()) expect(s.role).toEqual({ kind: "plain_round", n: Number(s.code.slice(1)) });
    // pools.name is the English "Group A": never on the wire.
    const names = await sql<{ name: string }[]>`select name from pools where stage_id = (select stage_id from fixtures where id = ${r.full[0]!.id})`;
    for (const { name } of names) expect([...r.got.values()].some((s) => s.pool === name), name).toBe(false);
    // The refused key, through the real descriptor.
    const victim = r.full[0]!;
    await sql`update pools set key = 'AA' where id = ${victim.pool_id}`;
    const shown = await ensureStreamCode(r.auth, victim.id);
    const body = await getCode(shown.qr.code, shown.qr.tok, { slot: 0, phone: null }, fakeDeps(), new Date());
    const before = r.got.get(victim.id)!;
    expect(before.pool, "PREMISE: it carried a pool").toMatch(/^[AB]$/);
    expect(body.stage).toEqual({ code: before.code, role: before.role });
    expect(Object.hasOwn(body.stage!, "pool")).toBe(false);
  });

  it("an `es` org reads the board's Spanish chips: CF ×4 for the quarter-finals (the brief's own example), SF, F, 3.º", async () => {
    expect(msgFor("es", "bracket.roundShort.quarter"), "PREMISE: the es quarter-final chip").toBe("CF");
    const r = await family("knockout", 8, { thirdPlace: true }, { locale: "es" });
    const es = msgOf("es");
    expect(r.codeTally).toEqual({
      CF: 4, [es("bracket.roundShort.semi")]: 2, [es("bracket.roundShort.final")]: 1, [es("bracket.roundShort.thirdPlace")]: 1,
    });
    expect(r.codeTally.QF, "never the English chip").toBeUndefined();
    expect(r.kindTally).toEqual({ quarter_final: 4, semi_final: 2, final: 1, third_place: 1 });
  });

  it("a legacy knockout (is_final cleared, as before V368): the board reads R{n}, and so does the stage — role plain_round, the round's rank + 1", async () => {
    const r = await family("knockout", 4, { thirdPlace: true });
    const stageId = r.full[0]!.stage_id;
    await sql`update fixtures set is_final = false, third_place = false where stage_id = ${stageId}`;
    const { codes, full } = await expectedFor(r.auth, r.divisionId, "en");
    expect(codes.size, "PREMISE: the board refuses to code the legacy stage").toBe(0);
    const rounds = [...new Set(full.map((f) => f.round_no))].sort((a, b) => a - b);
    let checked = 0;
    for (const f of full) {
      const shown = await ensureStreamCode(r.auth, f.id);
      const body = await getCode(shown.qr.code, shown.qr.tok, { slot: 0, phone: null }, fakeDeps(), new Date());
      expect(body.stage).toEqual({ code: `R${f.round_no}`, role: { kind: "plain_round", n: rounds.indexOf(f.round_no) + 1 } });
      checked++;
    }
    expect(checked).toBe(full.length);
    expect(checked).toBe(4);
  });

  it("anti-vacuity: the family sweeps checked every fixture they generated", () => {
    // ko8+3rd 8, ko16 15, DE8+reset ≥ 15, pp 4, stepladder 4, league 6, Swiss 3, group 12, es ko8 8, legacy ko4 (own count).
    expect(stagesChecked).toBeGreaterThanOrEqual(8 + 15 + 15 + 4 + 4 + 6 + 3 + 12 + 8);
  });
});

// ---------------------------------------------------------------------------
// Every shape: waiting, and each session state; recomputed on every read; absent (never null) when no code fits.
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("the stage on EVERY descriptor shape (W28)", () => {
  it("waiting (no session, with a phone and without), then warming, live, ending, completed and failed for the session's phone and another — all carry the SAME stage; a round renumbered under it is re-read; a code too long for the contract omits it (absent, never null)", async () => {
    const r = await captureRig();
    const [{ division_id }] = await sql<{ division_id: string }[]>`select division_id from fixtures where id = ${r.fixtureId}`;
    const { want } = await expectedFor(r.auth, division_id, "en");
    const expected = want.get(r.fixtureId)!;
    expect(expected, "PREMISE: the rig's league round 1").toEqual({ code: "R1", role: { kind: "plain_round", n: 1 } });
    const get = (phone: string | null) => getCode(r.code, r.tok, { slot: 0, phone }, r.deps, r.now());
    let shapes = 0;
    const seen = new Set<string>();
    const check = async (phone: string | null, want: string) => {
      const body = await get(phone);
      expect(body.state, want).toBe(want);
      expect(body.stage, `${want} (${phone === null ? "no phone" : "a phone"})`).toEqual(expected);
      expect(CaptureDescriptor.parse(body)).toEqual(body);
      seen.add(body.state);
      shapes++;
    };
    const mine = phoneId("mine");
    await check(null, "waiting");
    await check(phoneId("x"), "waiting");
    const sid = await r.start(mine);
    await check(mine, "warming");
    await check(phoneId("other"), "warming");
    await sql`update fixture_stream_sessions set state = 'live', first_ingest_at = now() where id = ${sid}`;
    await check(mine, "live");
    await sql`update fixture_stream_sessions set state = 'ending', end_reason = 'stopped', ending_at = now() where id = ${sid}`;
    await check(mine, "ending");
    await sql`update fixture_stream_sessions set state = 'completed', ended_at = now() where id = ${sid}`;
    await check(mine, "completed");
    await sql`update fixture_stream_sessions set state = 'failed', end_reason = null, fail_reason = 'no_inbound_timeout' where id = ${sid}`;
    await check(mine, "failed");
    expect(seen).toEqual(new Set(["waiting", "warming", "live", "ending", "completed", "failed"]));
    expect(shapes).toBe(8);

    // Recomputed on every read: the fixture's round renumbered, the next read carries it.
    await sql`update fixtures set round_no = 7 where id = ${r.fixtureId}`;
    expect((await get(mine)).stage).toEqual({ code: "R7", role: { kind: "plain_round", n: 1 } });
    // A code the contract cannot carry: the field is ABSENT — never null — and the descriptor still parses.
    await sql`update fixtures set round_no = 123456789 where id = ${r.fixtureId}`;
    for (const phone of [mine, null]) {
      const body = await get(phone);
      expect(Object.hasOwn(body, "stage"), `${body.state}: absent`).toBe(false);
      expect(CaptureDescriptor.parse(body)).toEqual(body);
    }
  });

  it("another sport (cricket): the stage reads no sport — the same R1 / plain_round 1 on its waiting shape", async () => {
    const r = await captureRig({ sport: "cricket" });
    const body = await getCode(r.code, r.tok, { slot: 0, phone: null }, r.deps, r.now());
    expect(body.stage).toEqual({ code: "R1", role: { kind: "plain_round", n: 1 } });
  });
});
