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
//  - `pool` is `pools.key`, read here by its own statement;
//  - `label` (owner ruling 2026-10-08, Option A) is the division's name (`divisions.name`, read here by its own
//    statement), the pool word (the RAW `table.poolLabel` of the org locale's `public.json`, the key put in), and the
//    round's text, joined with " · ", an absent part left out. The round's text: a plain round reads the RAW
//    `bracket.round.plain` of the org locale's `ui.json` with the number its chip `R{n}` shows; the final, the third-place
//    match and the grand final read their RAW long names (`bracket.round.final` / `.thirdPlace` / `.grandFinal`,
//    A1, applied on the owner's "raise PR"); every other round reads its chip. Over 40 characters the pool goes first, then the
//    division, then the label. Read off the dictionary files here, never through `poolLabel`, `msgFor` or the builder.
// Every sweep counts what it checked; zero checked is a failure.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import type { RoundRole } from "@seazn/engine/competition";
import { sql } from "@/lib/db";
import type { Locale } from "@/lib/i18n-constants";
import type { MessageKey } from "@/lib/messages";
import { msgFor } from "@/lib/messages-i18n";
import enPublic from "@/dictionaries/en/public.json";
import esPublic from "@/dictionaries/es/public.json";
import frPublic from "@/dictionaries/fr/public.json";
import nlPublic from "@/dictionaries/nl/public.json";
import enUi from "@/dictionaries/en/ui.json";
import esUi from "@/dictionaries/es/ui.json";
import frUi from "@/dictionaries/fr/ui.json";
import nlUi from "@/dictionaries/nl/ui.json";
import fc from "fast-check";
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

const ENV_KEYS = ["RELAY_KEK", "AUTH_SECRET", "OAUTH_BASE_URL", "NEXT_PUBLIC_BASE_URL", "STREAM_PLAYBACK_HOST", "STREAM_SRT_ENABLED", "RELAY_DRIVERS"] as const;
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
const PUBLIC: Record<Locale, Record<string, string>> = { en: enPublic, es: esPublic, fr: frPublic, nl: nlPublic };
const UI: Record<Locale, Record<string, string>> = { en: enUi, es: esUi, fr: frUi, nl: nlUi };
/** A dictionary string straight off its file (the source of truth), its one `{v}` put in by hand. */
const fill = (dict: Record<string, string>, key: string, v: string, value: string | number, where: string): string => {
  const raw = dict[key];
  expect(raw, `PREMISE: ${where} has ${key} with a {${v}}`).toContain(`{${v}}`);
  return raw!.replace(`{${v}}`, String(value));
};
/** The pool word: the locale's `public.json` `table.poolLabel`, the key put in. */
const poolWordOf = (locale: Locale, key: string): string => fill(PUBLIC[locale], "table.poolLabel", "key", key, `${locale} public.json`);
/** A plain round's long form: the locale's `ui.json` `bracket.round.plain`, the number put in. */
const roundWordOf = (locale: Locale, n: number): string => fill(UI[locale], "bracket.round.plain", "n", n, `${locale} ui.json`);
/** A string straight off the locale's `ui.json` with no variable in it — a chip (`bracket.roundShort.*`) or a round's
 *  long name (`bracket.round.*`). */
const chipOf = (locale: Locale, key: string): string => {
  const raw = UI[locale][key];
  expect(raw, `PREMISE: ${locale} ui.json has ${key}`).toBeTruthy();
  expect(raw, `PREMISE: ${key} carries no variable`).not.toContain("{");
  return raw!;
};
/** The rounds whose label reads their LONG name (A1, 2026-10-08), by the engine's role kind: the dictionary key. */
const LONG_NAME_KEY: Readonly<Record<string, string>> = {
  final: "bracket.round.final", third_place: "bracket.round.thirdPlace", grand_final: "bracket.round.grandFinal",
};
const longNameOf = (locale: Locale, kind: "final" | "third_place" | "grand_final"): string => chipOf(locale, LONG_NAME_KEY[kind]!);
/** The round's text the owner ruled (2026-10-08): a plain round reads its long form with the number its chip `R{n}`
 *  shows; the final, the third-place match and the grand final their long names; every other round its chip. */
const roundTextOf = (locale: Locale, role: Pick<RoundRole, "kind"> | CaptureStage["role"], code: string): string => {
  const longKey = LONG_NAME_KEY[role.kind];
  if (longKey !== undefined) return chipOf(locale, longKey);
  if (role.kind !== "plain_round") return code;
  const m = /^R(\d+)$/.exec(code);
  expect(m, `PREMISE: a plain round's chip is R{n} (got ${code})`).not.toBeNull();
  return roundWordOf(locale, Number(m![1]));
};
/** The label the owner ruled (2026-10-08, Option A): division · pool word · round text, an absent part left out. */
const labelOf = (locale: Locale, o: { division: string | null; pool: string | null | undefined; round: string }): string =>
  [o.division, o.pool ? poolWordOf(locale, o.pool) : null, o.round].filter((p): p is string => !!p).join(" · ");
const enPool = (key: string) => poolWordOf("en", key);
const MAX = 40;
/** The owner's ladder over 40 characters: the whole label, then without the pool word, then the round alone; else none. */
const fitOf = (locale: Locale, o: { division: string | null; pool: string | null | undefined; round: string }): string | undefined =>
  [labelOf(locale, o), labelOf(locale, { ...o, pool: null }), o.round].find((l) => l.length <= MAX);
/** A real-world division name, cut to `n` characters (the boundary pairs need exact lengths). */
const LONG_DIVISION = "Mixed Doubles Under-17 Intermediate Level";
const divisionOfLength = (n: number): string => {
  expect(LONG_DIVISION.length, "PREMISE: the long division name alone is over 40").toBeGreaterThan(MAX);
  expect(n, "a cut, never a pad").toBeLessThanOrEqual(LONG_DIVISION.length);
  const d = LONG_DIVISION.slice(0, n);
  expect(d.trim(), "no trailing blank: trimmed it would be shorter").toBe(d);
  return d;
};
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

/** A knockout of 8 with a bronze match, as today's generator writes it: is_final on the final, the flag on the bronze. */
const knockout8 = (): RoundCodeFixture[] => [
  ...[1, 2, 3, 4].map((s) => row({ round_no: 1, seq_in_round: s })),
  ...[1, 2].map((s) => row({ round_no: 2, seq_in_round: s })),
  row({ round_no: 3, seq_in_round: 1, is_final: true }),
  row({ round_no: 3, seq_in_round: 2, third_place: true }),
];
/** Every `log.warn` a call makes, the call silenced. */
const warnsOf = <T>(fn: () => T): { got: T; warned: unknown[][] } => {
  const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
  try {
    const got = fn();
    return { got, warned: [...warn.mock.calls] };
  } finally {
    warn.mockRestore();
  }
};
/** The `dropped` part of each over-40 warning, in the order they were logged. */
const droppedOf = (warned: unknown[][]): string[] =>
  warned.filter((c) => JSON.stringify(c).includes("over 40")).map((c) => (c[0] as { dropped: string }).dropped);

describe("buildCaptureStage — its guards (pure)", () => {
  it("the empty case: a stage of ONE fixture (round 1 of a league), no pool and NO division name (null, empty, blank) → R1, plain_round 1, the label the round's long form alone", () => {
    const only = row({ round_no: 1 });
    let checked = 0;
    for (const divisionName of [null, "", "   "]) {
      expect(buildCaptureStage({ fixtureId: only.id, stageKind: "league", poolKey: null, divisionName, rows: [only] }, en, enPool), JSON.stringify(divisionName))
        .toEqual({ code: "R1", role: { kind: "plain_round", n: 1 }, label: roundWordOf("en", 1) });
      checked++;
    }
    expect(checked).toBe(3);
    expect(roundWordOf("en", 1), "PREMISE: the owner's words").toBe("Round 1");
  });

  it("an assumption made a guard: a fixture that is not among its stage's rows is refused by name, never answered", () => {
    expect(() => buildCaptureStage({ fixtureId: randomUUID(), stageKind: "league", poolKey: null, divisionName: "Open", rows: [row({ round_no: 1 })] }, en, enPool))
      .toThrow(/not among its stage's rows/);
    expect(() => buildCaptureStage({ fixtureId: randomUUID(), stageKind: "league", poolKey: null, divisionName: "Open", rows: [] }, en, enPool))
      .toThrow(/not among its stage's rows/);
  });

  it("a code the contract cannot carry (9+ characters) omits the WHOLE stage and logs it; 8 characters is carried (the boundary pair)", () => {
    const long = row({ round_no: 12345678 });
    const edge = row({ round_no: 1234567 });
    const { got, warned } = warnsOf(() => ({
      nine: buildCaptureStage({ fixtureId: long.id, stageKind: "league", poolKey: "A", divisionName: "Open", rows: [long] }, en, enPool),
      eight: buildCaptureStage({ fixtureId: edge.id, stageKind: "league", poolKey: null, divisionName: "Open", rows: [edge] }, en, enPool),
    }));
    expect(got.nine).toBeNull();
    expect(got.eight).toEqual({
      code: "R1234567", role: { kind: "plain_round", n: 1 }, label: labelOf("en", { division: "Open", pool: null, round: roundWordOf("en", 1234567) }),
    });
    expect(JSON.stringify(warned)).toContain("stage omitted");
  });

  it("pools.key has no CHECK: \"AA\", \"a\" and \"\" are omitted (logged) and the rest of the stage kept; \"B\" is carried", () => {
    const f = row({ round_no: 2 });
    const got: Record<string, CaptureStage | null> = {};
    const { warned } = warnsOf(() => {
      for (const key of ["AA", "a", "", "B"]) got[key] = buildCaptureStage({ fixtureId: f.id, stageKind: "group", poolKey: key, divisionName: "Open", rows: [row({ round_no: 1 }), f] }, en, enPool);
    });
    let checked = 0;
    for (const key of ["AA", "a", ""]) {
      expect(got[key], key).toEqual({ code: "R2", role: { kind: "plain_round", n: 2 }, label: labelOf("en", { division: "Open", pool: null, round: roundWordOf("en", 2) }) });
      checked++;
    }
    expect(checked).toBe(3);
    expect(got.B).toEqual({ code: "R2", role: { kind: "plain_round", n: 2 }, pool: "B", label: labelOf("en", { division: "Open", pool: "B", round: roundWordOf("en", 2) }) });
    expect(warned.filter((c) => JSON.stringify(c).includes("pool omitted"))).toHaveLength(3);
  });

  it("a legacy bracket (no is_final row, pre-V368): the board leaves it R{n}, and the role is the plain ordinal — never the guess the column defaults make (a bronze 'final'); with is_final set, the board codes it and the role is the engine's", () => {
    // A knockout of 4 with a bronze match, as V368's defaults leave it: no lane, no flags.
    const legacy = [row({ round_no: 1, seq_in_round: 1 }), row({ round_no: 1, seq_in_round: 2 }), row({ round_no: 2, seq_in_round: 1 }), row({ round_no: 2, seq_in_round: 2 })];
    expect(boardRoundCodes(legacy, [{ id: STAGE, kind: "knockout" }], en).size, "PREMISE: the board refuses to code it").toBe(0);
    const bronze = legacy[3]!;
    const guess = roundRoleFor(legacy.map((f) => ({ round_no: f.round_no, lane: null })), { round_no: 2, lane: null, is_final: false, third_place: false, conditional: false }, "knockout");
    expect(guess.kind, "PREMISE: the engine would guess 'final' from the defaults").toBe("final");
    expect(buildCaptureStage({ fixtureId: bronze.id, stageKind: "knockout", poolKey: null, divisionName: "Open", rows: legacy }, en, enPool))
      .toEqual({ code: "R2", role: { kind: "plain_round", n: 2 }, label: labelOf("en", { division: "Open", pool: null, round: roundWordOf("en", 2) }) });
    // The positive pair: the same rows written by today's generator (is_final on the final, the flag on the bronze).
    const today = legacy.map((f, i) => (i === 2 ? { ...f, is_final: true } : i === 3 ? { ...f, third_place: true } : f));
    expect(buildCaptureStage({ fixtureId: bronze.id, stageKind: "knockout", poolKey: null, divisionName: "Open", rows: today }, en, enPool))
      .toEqual({ code: en("bracket.roundShort.thirdPlace"), role: { kind: "third_place" }, label: `Open · ${longNameOf("en", "third_place")}` });
    expect(buildCaptureStage({ fixtureId: today[2]!.id, stageKind: "knockout", poolKey: null, divisionName: "Open", rows: today }, en, enPool))
      .toEqual({ code: en("bracket.roundShort.final"), role: { kind: "final" }, label: `Open · ${longNameOf("en", "final")}` });
  });

  // ---- the label (owner ruling 2026-10-08, Option A) ----

  it("label, en: the owner's examples — `Open · Round 2`, `Open · QF`, `Open · SF`, `Open · Final`, the bronze's long name, `Girls U14 · Group A · Round 2`; a plain round reads the number its CHIP shows, never the role's", () => {
    const cases: Array<{ name: string; input: Omit<Parameters<typeof buildCaptureStage>[0], "rows" | "fixtureId">; rows: RoundCodeFixture[]; at: number; want: string; literal?: string }> = [];
    const league = [row({ round_no: 1 }), row({ round_no: 2 })];
    cases.push({ name: "plain round", input: { stageKind: "league", poolKey: null, divisionName: "Open" }, rows: league, at: 1,
      want: labelOf("en", { division: "Open", pool: null, round: roundWordOf("en", 2) }), literal: "Open · Round 2" });
    const ko = knockout8();
    // QF and SF keep the chip (their long names are plural); the final and the bronze read their long names (A1).
    for (const [at, key, literal] of [[0, "bracket.roundShort.quarter", "Open · QF"], [4, "bracket.roundShort.semi", "Open · SF"], [6, "bracket.round.final", "Open · Final"], [7, "bracket.round.thirdPlace", undefined]] as const) {
      cases.push({ name: key, input: { stageKind: "knockout", poolKey: null, divisionName: "Open" }, rows: ko, at, want: `Open · ${chipOf("en", key)}`, literal });
    }
    const group = [row({ round_no: 1 }), row({ round_no: 2 })];
    cases.push({ name: "pool", input: { stageKind: "group", poolKey: "A", divisionName: "Girls U14" }, rows: group, at: 1,
      want: labelOf("en", { division: "Girls U14", pool: "A", round: roundWordOf("en", 2) }), literal: "Girls U14 · Group A · Round 2" });
    // A round renumbered past its rank: the chip reads R5, the role n 1 — the label reads the chip's 5.
    const sparse = [row({ round_no: 5 })];
    cases.push({ name: "chip n ≠ role n", input: { stageKind: "league", poolKey: null, divisionName: "Open" }, rows: sparse, at: 0,
      want: labelOf("en", { division: "Open", pool: null, round: roundWordOf("en", 5) }), literal: "Open · Round 5" });
    // A division name with blanks around it reads trimmed — never "Open  · ".
    cases.push({ name: "trimmed", input: { stageKind: "league", poolKey: null, divisionName: "  Open " }, rows: league, at: 1,
      want: labelOf("en", { division: "Open", pool: null, round: roundWordOf("en", 2) }) });
    let checked = 0;
    for (const c of cases) {
      const f = c.rows[c.at]!;
      const got = buildCaptureStage({ ...c.input, fixtureId: f.id, rows: c.rows }, en, enPool);
      expect(got!.label, c.name).toBe(c.want);
      if (c.literal !== undefined) expect(got!.label, `${c.name}: the owner's literal`).toBe(c.literal);
      checked++;
    }
    expect(checked, "anti-vacuity: every case").toBe(8);
    const sparseStage = buildCaptureStage({ fixtureId: sparse[0]!.id, stageKind: "league", poolKey: null, divisionName: "Open", rows: sparse }, en, enPool)!;
    expect(sparseStage.role, "PREMISE: the role's n differs from the chip's").toEqual({ kind: "plain_round", n: 1 });
    expect(sparseStage.code).toBe("R5");
  });

  it("label, the long names (A1): the final, the third-place match and the grand final read `bracket.round.final` / `.thirdPlace` / `.grandFinal` in en AND es; QF, SF, the winners' final and the grand-final reset keep their chips", () => {
    // A double elimination's last two lanes, as the generator writes them: the winners' final, then the GF lane.
    const de = [
      row({ round_no: 1, lane: "WB" }),
      row({ round_no: 2, lane: "GF", is_final: true }),
      row({ round_no: 3, lane: "GF", is_final: true, conditional: true }),
    ];
    const ko = knockout8();
    let checked = 0;
    for (const locale of ["en", "es"] as const) {
      const msg = msgOf(locale);
      const at = (rows: RoundCodeFixture[], i: number, stageKind: string) =>
        buildCaptureStage({ fixtureId: rows[i]!.id, stageKind, poolKey: null, divisionName: "Open", rows }, msg, (k) => poolWordOf(locale, k))!;
      const cases: Array<[CaptureStage, string, string]> = [
        [at(ko, 6, "knockout"), "final", `Open · ${longNameOf(locale, "final")}`],
        [at(ko, 7, "knockout"), "third_place", `Open · ${longNameOf(locale, "third_place")}`],
        [at(de, 1, "double_elim"), "grand_final", `Open · ${longNameOf(locale, "grand_final")}`],
        [at(ko, 0, "knockout"), "quarter_final", `Open · ${chipOf(locale, "bracket.roundShort.quarter")}`],
        [at(ko, 4, "knockout"), "semi_final", `Open · ${chipOf(locale, "bracket.roundShort.semi")}`],
        [at(de, 0, "double_elim"), "winners_final", `Open · ${fill(UI[locale], "bracket.roundShort.winnersRound", "n", 1, `${locale} ui.json`)}`],
        [at(de, 2, "double_elim"), "grand_final_reset", `Open · ${chipOf(locale, "bracket.roundShort.grandFinalReset")}`],
      ];
      for (const [got, kind, want] of cases) {
        expect(got.role.kind, `${locale}: PREMISE the role`).toBe(kind);
        expect(got.label, `${locale} ${kind}`).toBe(want);
        // code is unchanged: always the chip.
        expect(got.label!.endsWith(got.code) || ["final", "third_place", "grand_final"].includes(kind), `${locale} ${kind}: the chip unless long-named`).toBe(true);
        checked++;
      }
    }
    expect(checked, "anti-vacuity: 7 rounds × 2 locales").toBe(14);
    expect(longNameOf("es", "third_place"), "PREMISE: the brief's es words").toBe("Tercer puesto");
    expect(longNameOf("es", "grand_final")).toBe("Gran final");
    expect(longNameOf("en", "third_place"), "PREMISE: the long name differs from the chip").not.toBe(chipOf("en", "bracket.roundShort.thirdPlace"));
  });

  it("label, es: `Open · Ronda 2`, `Open · CF`, `Girls U14 · Grupo A · Ronda 2` — the org locale's words, never English", () => {
    const es = msgOf("es");
    const esPool = (key: string) => poolWordOf("es", key);
    expect(roundWordOf("es", 2), "PREMISE: the brief's es round").toBe("Ronda 2");
    expect(poolWordOf("es", "A"), "PREMISE: the brief's es pool").toBe("Grupo A");
    expect(chipOf("es", "bracket.roundShort.quarter"), "PREMISE: the brief's es chip").toBe("CF");
    const league = [row({ round_no: 1 }), row({ round_no: 2 })];
    const ko = knockout8();
    const got = {
      plain: buildCaptureStage({ fixtureId: league[1]!.id, stageKind: "league", poolKey: null, divisionName: "Open", rows: league }, es, esPool)!,
      qf: buildCaptureStage({ fixtureId: ko[0]!.id, stageKind: "knockout", poolKey: null, divisionName: "Open", rows: ko }, es, esPool)!,
      pool: buildCaptureStage({ fixtureId: league[1]!.id, stageKind: "group", poolKey: "A", divisionName: "Girls U14", rows: league }, es, esPool)!,
    };
    expect(got.plain.label).toBe(labelOf("es", { division: "Open", pool: null, round: roundWordOf("es", 2) }));
    expect(got.plain.label).toBe("Open · Ronda 2");
    expect(got.qf.label).toBe(`Open · ${chipOf("es", "bracket.roundShort.quarter")}`);
    expect(got.qf.label).toBe("Open · CF");
    expect(got.pool.label).toBe(labelOf("es", { division: "Girls U14", pool: "A", round: roundWordOf("es", 2) }));
    expect(got.pool.label).toBe("Girls U14 · Grupo A · Ronda 2");
  });

  it("over 40, step 1 — the POOL goes first: 41 drops the pool word and keeps division · round (logged, the pool field kept); exactly 40 keeps all three (the boundary pair)", () => {
    const f = row({ round_no: 1 });
    const round = roundWordOf("en", 1);
    const fill40 = MAX - " · ".length - enPool("A").length - " · ".length - round.length;
    const d40 = divisionOfLength(fill40);
    const d41 = divisionOfLength(fill40 + 1);
    const { got, warned } = warnsOf(() => ({
      forty: buildCaptureStage({ fixtureId: f.id, stageKind: "group", poolKey: "A", divisionName: d40, rows: [f] }, en, enPool)!,
      fortyOne: buildCaptureStage({ fixtureId: f.id, stageKind: "group", poolKey: "A", divisionName: d41, rows: [f] }, en, enPool)!,
    }));
    expect(got.forty.label).toBe(labelOf("en", { division: d40, pool: "A", round }));
    expect(got.forty.label).toHaveLength(MAX);
    expect(got.fortyOne).toEqual({ code: "R1", role: { kind: "plain_round", n: 1 }, pool: "A", label: labelOf("en", { division: d41, pool: null, round }) });
    expect(got.fortyOne.label!.startsWith(d41), "the division kept").toBe(true);
    expect(droppedOf(warned), "one drop, the pool, for the 41 alone").toEqual(["pool"]);
    expect(warned[0]![0], "the log names the fixture, the length and the part, never the words").toEqual({ fixtureId: f.id, length: MAX + 1, dropped: "pool" });
  });

  it("over 40, step 2 — then the DIVISION: division · round over 40 leaves the round alone (logged); exactly 40 keeps it; the real-world long name with a pool drops both, pool first", () => {
    const f = row({ round_no: 1 });
    const round = roundWordOf("en", 1);
    const fill40 = MAX - " · ".length - round.length;
    const d40 = divisionOfLength(fill40);
    const d41 = divisionOfLength(fill40 + 1);
    const { got, warned } = warnsOf(() => ({
      forty: buildCaptureStage({ fixtureId: f.id, stageKind: "league", poolKey: null, divisionName: d40, rows: [f] }, en, enPool)!,
      fortyOne: buildCaptureStage({ fixtureId: f.id, stageKind: "league", poolKey: null, divisionName: d41, rows: [f] }, en, enPool)!,
    }));
    expect(got.forty.label).toBe(labelOf("en", { division: d40, pool: null, round }));
    expect(got.forty.label).toHaveLength(MAX);
    expect(got.fortyOne).toEqual({ code: "R1", role: { kind: "plain_round", n: 1 }, label: round });
    expect(droppedOf(warned), "no pool to drop: the division alone").toEqual(["division"]);
    expect(warned[0]![0]).toEqual({ fixtureId: f.id, length: MAX + 1, dropped: "division" });

    const both = warnsOf(() => buildCaptureStage({ fixtureId: f.id, stageKind: "group", poolKey: "B", divisionName: LONG_DIVISION, rows: [f] }, en, enPool)!);
    expect(both.got).toEqual({ code: "R1", role: { kind: "plain_round", n: 1 }, pool: "B", label: round });
    expect(droppedOf(both.warned), "the pool first, then the division").toEqual(["pool", "division"]);
    const full = labelOf("en", { division: LONG_DIVISION, pool: "B", round }).length;
    const noPool = labelOf("en", { division: LONG_DIVISION, pool: null, round }).length;
    expect(both.warned.map((c) => (c[0] as { length: number }).length), "each drop logs the length it found").toEqual([full, noPool]);
  });

  it("over 40 with a long name (A1): a 30-character division and the bronze match — `division · 3rd` would fit, `division · Third place` does not — drops the division (logged), the round's long name kept", () => {
    const ko = knockout8();
    const bronze = ko[7]!;
    const d = divisionOfLength(30);
    const longName = longNameOf("en", "third_place");
    expect(`${d} · ${chipOf("en", "bracket.roundShort.thirdPlace")}`.length, "PREMISE: the chip would have fit").toBeLessThanOrEqual(MAX);
    expect(`${d} · ${longName}`.length, "PREMISE: the long name does not").toBeGreaterThan(MAX);
    const { got, warned } = warnsOf(() => buildCaptureStage({ fixtureId: bronze.id, stageKind: "knockout", poolKey: null, divisionName: d, rows: ko }, en, enPool)!);
    expect(got).toEqual({ code: chipOf("en", "bracket.roundShort.thirdPlace"), role: { kind: "third_place" }, label: longName });
    expect(droppedOf(warned)).toEqual(["division"]);
  });

  it("over 40, step 3 — then the LABEL: a round's text over 40 on its own omits the label (logged), the rest of the stage kept; exactly 40 is carried. The pool word is asked for only when there IS a pool", () => {
    const f = row({ round_no: 1 });
    // No real dictionary's round is this long (a chip is at most 8): a locale stand-in reaches the last step.
    const wordy = (n: number) => (key: MessageKey, vars?: Record<string, string | number>) => key === "bracket.round.plain" ? "w".repeat(n) : en(key, vars);
    const { got, warned } = warnsOf(() => ({
      forty: buildCaptureStage({ fixtureId: f.id, stageKind: "group", poolKey: "A", divisionName: "Open", rows: [f] }, wordy(MAX), enPool),
      fortyOne: buildCaptureStage({ fixtureId: f.id, stageKind: "group", poolKey: "A", divisionName: "Open", rows: [f] }, wordy(MAX + 1), enPool),
    }));
    expect(got.forty!.label).toBe("w".repeat(MAX));
    expect(got.fortyOne).toEqual({ code: "R1", role: { kind: "plain_round", n: 1 }, pool: "A" });
    expect(Object.hasOwn(got.fortyOne!, "label"), "absent, never null or cut").toBe(false);
    expect(droppedOf(warned), "forty: pool, division; forty-one: pool, division, label").toEqual(["pool", "division", "pool", "division", "label"]);
    const omitted = warned.filter((c) => JSON.stringify(c).includes("label omitted"));
    expect(omitted, "logged once, for the 41").toHaveLength(1);
    expect(omitted[0]![0], "the log names the fixture, the length and the part, never the words").toEqual({ fixtureId: f.id, length: MAX + 1, dropped: "label" });
    const never = (): string => { throw new Error("the pool word was asked for without a pool"); };
    expect(buildCaptureStage({ fixtureId: f.id, stageKind: "league", poolKey: null, divisionName: "Open", rows: [f] }, en, never)!.label)
      .toBe(labelOf("en", { division: "Open", pool: null, round: roundWordOf("en", 1) }));
  });

  it("the ladder over generated names, pools and rounds: the label is the FIRST of division · pool · round, division · round, round that fits 40, else absent — never cut; code, role and pool untouched; every rung reached", () => {
    const alphabet = fc.constantFrom("a", "B", "7", "-", "é", "·", "U");
    const division = fc.oneof(fc.constantFrom<string | null>(null, "", "  "), fc.array(alphabet, { minLength: 1, maxLength: 48 }).map((a) => a.join("")));
    const rungs = { full: 0, poolDropped: 0, divisionDropped: 0, omitted: 0 };
    let checked = 0;
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    try {
      fc.assert(fc.property(
        division, fc.option(fc.constantFrom("A", "B", "Z"), { nil: null }), fc.integer({ min: 1, max: 9999 }), fc.option(fc.integer({ min: 1, max: 44 }), { nil: null }),
        (divisionName, poolKey, roundNo, wordLen) => {
          const f = row({ round_no: roundNo });
          const msg = (key: MessageKey, vars?: Record<string, string | number>) => key === "bracket.round.plain" && wordLen !== null ? "w".repeat(wordLen) : en(key, vars);
          const got = buildCaptureStage({ fixtureId: f.id, stageKind: poolKey === null ? "league" : "group", poolKey, divisionName, rows: [f] }, msg, enPool);
          const round = wordLen !== null ? "w".repeat(wordLen) : roundWordOf("en", roundNo);
          const d = divisionName !== null && divisionName.trim() !== "" ? divisionName : null;
          const ladder = [
            labelOf("en", { division: d, pool: poolKey, round }),
            labelOf("en", { division: d, pool: null, round }),
            round,
          ];
          const want = ladder.find((l) => l.length <= MAX);
          expect(got, "the stage itself is kept").not.toBeNull();
          expect(got!.code).toBe(`R${roundNo}`);
          expect(got!.role).toEqual({ kind: "plain_round", n: 1 });
          expect(got!.pool ?? null).toBe(poolKey);
          expect(got!.label).toBe(want);
          if (want === undefined) rungs.omitted++;
          else if (want === ladder[0]) rungs.full++;
          else if (want === ladder[1]) rungs.poolDropped++;
          else rungs.divisionDropped++;
          checked++;
        },
      ), { numRuns: 400, seed: 20261008 });
    } finally {
      warn.mockRestore();
    }
    expect(checked, "anti-vacuity: every run checked").toBe(400);
    for (const [rung, n] of Object.entries(rungs)) expect(n, `anti-vacuity: the ${rung} rung reached`).toBeGreaterThan(0);
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
  const [{ name }] = await sql<{ name: string }[]>`select name from divisions where id = ${divisionId}`;
  const division = name.trim() === "" ? null : name.trim();
  const want = new Map<string, CaptureStage>();
  for (const f of full) {
    const laneRows = full.filter((x) => x.stage_id === f.stage_id).map((x) => ({ round_no: x.round_no, lane: x.lane ?? null }));
    const role: RoundRole = roundRoleFor(laneRows, {
      round_no: f.round_no, lane: f.lane ?? null, is_final: f.is_final === true, third_place: f.third_place === true, conditional: f.conditional === true,
    }, kindOf.get(f.stage_id)!, f.ext_key ?? null);
    const boardRow = board.find((b) => b.id === f.id)!;
    const pool = pools.get(f.id) ?? null;
    const code = codes.get(f.id)?.code ?? `R${boardRow.round_no}`;
    const label = fitOf(locale, { division, pool, round: roundTextOf(locale, role, code) });
    want.set(f.id, { code, role: { ...role }, ...(pool !== null ? { pool } : {}), ...(label !== undefined ? { label } : {}) });
  }
  return { want, full, codes, division };
}

let stagesChecked = 0;
/** One division, `n` seeded entrants, one generated stage of `kind`; a stream code minted for EVERY fixture through the
 *  real `ensureStreamCode`, and each fixture's waiting descriptor read through the real `getCode`. */
async function family(kind: Kind, n: number, config: Record<string, unknown>, opts: { locale?: Locale; generate?: number; divisionName?: string } = {}) {
  const locale = opts.locale ?? "en";
  const { auth } = await seedOrg("pro");
  if (locale !== "en") await sql`update organizations set default_locale = ${locale} where id = ${auth.orgId}`;
  await override(auth.orgId, "streaming.relay", true);
  const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: `Capture stage ${kind}`, visibility: "private", branding: {} });
  const division = await createDivision(auth, comp.id, { name: opts.divisionName ?? "Open", slug: "open", sport_key: "generic", variant_key: "score", config: GENERIC_CONFIG });
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
    labelTally: tally(stages.map((s) => s.label ?? "(none)")),
  };
}

describe.skipIf(!HAS_DB)("the descriptor's stage over every family (W28)", () => {
  it("knockout of 8 with a bronze match: QF ×4, SF ×2, F, 3rd — the roles quarter_final, semi_final, final, third_place", async () => {
    const r = await family("knockout", 8, { thirdPlace: true });
    expect(r.codeTally).toEqual({ QF: 4, SF: 2, F: 1, "3rd": 1 });
    expect(r.kindTally).toEqual({ quarter_final: 4, semi_final: 2, final: 1, third_place: 1 });
    // The label (owner ruling 2026-10-08): the division's name, then the chip — the final's and the bronze's long names.
    const chip = (key: string) => `Open · ${chipOf("en", key)}`;
    expect(r.labelTally).toEqual({
      [chip("bracket.roundShort.quarter")]: 4, [chip("bracket.roundShort.semi")]: 2, [chip("bracket.round.final")]: 1, [chip("bracket.round.thirdPlace")]: 1,
    });
    expect(r.labelTally["Open · QF"], "the owner's own example").toBe(4);
    expect(r.labelTally["Open · Final"], "the owner's own example").toBe(1);
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
    // The grand final reads its long name (A1); the reset keeps its chip GF2, the winners' final its WB3.
    const labelOfCode = (code: string) => [...r.got.values()].filter((s) => s.code === code).map((s) => s.label);
    expect(labelOfCode("GF")).toEqual([`Open · ${longNameOf("en", "grand_final")}`]);
    expect(labelOfCode("GF2")).toEqual(["Open · GF2"]);
    expect(labelOfCode("WB3")).toEqual(["Open · WB3"]);
  });

  it("page playoff of 4: Q1, E, Q2, F — qualifier1, eliminator, qualifier2, final", async () => {
    const r = await family("page_playoff", 4, {});
    expect(r.codeTally).toEqual({ Q1: 1, E: 1, Q2: 1, F: 1 });
    expect(r.kindTally).toEqual({ qualifier1: 1, eliminator: 1, qualifier2: 1, final: 1 });
    // Its final's chip IS the final's (F) and its role IS final: the long name, like every other final (A1).
    expect(r.labelTally).toEqual({ "Open · Q1": 1, "Open · E": 1, "Open · Q2": 1, [`Open · ${longNameOf("en", "final")}`]: 1 });
  });

  it("stepladder of 5: E1, E2, E3, F — rung n 1..3, then final", async () => {
    const r = await family("stepladder", 5, {});
    expect(r.codeTally).toEqual({ E1: 1, E2: 1, E3: 1, F: 1 });
    expect([...r.got.values()].filter((s) => s.role.kind === "rung").map((s) => s.role.n).sort()).toEqual([1, 2, 3]);
    expect(r.kindTally.final).toBe(1);
    expect(r.labelTally[`Open · ${longNameOf("en", "final")}`], "the ladder's final: its long name (A1)").toBe(1);
  });

  it("league of 4: the board codes nothing, so R1–R3 (two each), plain_round n = the round", async () => {
    const r = await family("league", 4, {});
    expect(r.codes.size, "PREMISE: the board codes no league round").toBe(0);
    expect(r.codeTally).toEqual({ R1: 2, R2: 2, R3: 2 });
    for (const s of r.got.values()) expect(s.role).toEqual({ kind: "plain_round", n: Number(s.code.slice(1)) });
    // A league round is a plain round: the long form, with the chip's number.
    expect(r.labelTally).toEqual({ [`Open · ${roundWordOf("en", 1)}`]: 2, [`Open · ${roundWordOf("en", 2)}`]: 2, [`Open · ${roundWordOf("en", 3)}`]: 2 });
    expect(r.labelTally["Open · Round 2"], "the owner's own example").toBe(2);
  });

  it("Swiss (one round of 6): R1 ×3, plain_round 1", async () => {
    const r = await family("swiss", 6, { rounds: 1 }, { generate: 2 });
    expect(r.codeTally).toEqual({ R1: 3 });
    expect(r.kindTally).toEqual({ plain_round: 3 });
    // A Swiss round is a plain round too (the engine: every non-bracket kind).
    expect(r.labelTally).toEqual({ [`Open · ${roundWordOf("en", 1)}`]: 3 });
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
    expect(before.label, "PREMISE: it carried the pool word").toBe(labelOf("en", { division: "Open", pool: before.pool, round: roundTextOf("en", before.role, before.code) }));
    expect(body.stage).toEqual({ code: before.code, role: before.role, label: labelOf("en", { division: "Open", pool: null, round: roundTextOf("en", before.role, before.code) }) });
    expect(Object.hasOwn(body.stage!, "pool")).toBe(false);
  });

  it("a long division name through the real descriptor (owner ruling 2026-10-08): a group of 8 in two pools of \"Mixed Doubles Under-17\" drops the pool WORD (division · round, the pool KEY still carried); a league of 4 of a 41-character name drops the division too (the round alone)", async () => {
    const mid = "Mixed Doubles Under-17";
    const g = await family("group", 8, { pools: { count: 2 } }, { divisionName: mid });
    let checked = 0;
    for (const s of g.got.values()) {
      const round = roundWordOf("en", Number(s.code.slice(1)));
      expect(labelOf("en", { division: mid, pool: s.pool, round }).length, "PREMISE: the whole label is over 40").toBeGreaterThan(MAX);
      expect(s.pool, "the pool KEY stays").toMatch(/^[AB]$/);
      expect(s.label).toBe(`${mid} · ${round}`);
      checked++;
    }
    const l = await family("league", 4, {}, { divisionName: LONG_DIVISION });
    for (const s of l.got.values()) {
      expect(s.label).toBe(roundWordOf("en", Number(s.code.slice(1))));
      checked++;
    }
    expect(checked, "anti-vacuity: 12 + 6").toBe(18);
  });

  it("label in the org's locale: a group of 8 in two pools for an `es` org and an `fr` org — every fixture's label is the division, that locale's pool word and that locale's round, never the English ones", async () => {
    let checked = 0;
    for (const locale of ["es", "fr"] as const) {
      expect(poolWordOf(locale, "A"), `PREMISE: ${locale}'s pool word differs from en's`).not.toBe(poolWordOf("en", "A"));
      expect(roundWordOf(locale, 1), `PREMISE: ${locale}'s round word differs from en's`).not.toBe(roundWordOf("en", 1));
      const r = await family("group", 8, { pools: { count: 2 } }, { locale });
      for (const s of r.got.values()) {
        expect(s.pool, `${locale}: pooled`).toMatch(/^[AB]$/);
        const n = Number(s.code.slice(1));
        expect(s.label, locale).toBe(`Open · ${poolWordOf(locale, s.pool!)} · ${roundWordOf(locale, n)}`);
        expect(s.label!.includes(poolWordOf("en", s.pool!)), `${locale}: never the English pool word`).toBe(false);
        expect(s.label!.includes(roundWordOf("en", n)), `${locale}: never the English round`).toBe(false);
        checked++;
      }
    }
    expect(checked, "anti-vacuity: 12 fixtures in each locale").toBe(24);
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
    const chip = (key: string) => `Open · ${chipOf("es", key)}`;
    expect(r.labelTally).toEqual({
      [chip("bracket.roundShort.quarter")]: 4, [chip("bracket.roundShort.semi")]: 2, [chip("bracket.round.final")]: 1, [chip("bracket.round.thirdPlace")]: 1,
    });
    expect(r.labelTally["Open · Tercer puesto"], "the es long name").toBe(1);
    expect(r.labelTally["Open · CF"], "the brief's es example").toBe(4);
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
      expect(body.stage).toEqual({
        code: `R${f.round_no}`, role: { kind: "plain_round", n: rounds.indexOf(f.round_no) + 1 }, label: `Open · ${roundWordOf("en", f.round_no)}`,
      });
      checked++;
    }
    expect(checked).toBe(full.length);
    expect(checked).toBe(4);
  });

  it("anti-vacuity: the family sweeps checked every fixture they generated", () => {
    // ko8+3rd 8, ko16 15, DE8+reset ≥ 15, pp 4, stepladder 4, league 6, Swiss 3, group 12, long-name group 12 + league 6,
    // es ko8 8, legacy ko4 (own count).
    expect(stagesChecked).toBeGreaterThanOrEqual(8 + 15 + 15 + 4 + 4 + 6 + 3 + 12 + 12 + 6 + 8);
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
    expect(expected, "PREMISE: the rig's league round 1 of its division \"Open\"").toEqual({ code: "R1", role: { kind: "plain_round", n: 1 }, label: "Open · Round 1" });
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
    // The label reads the CHIP's 7, never the role's 1.
    expect((await get(mine)).stage).toEqual({ code: "R7", role: { kind: "plain_round", n: 1 }, label: `Open · ${roundWordOf("en", 7)}` });
    // ... and the division renamed under it: the next read carries the new name; a blank one is no division.
    await sql`update divisions set name = 'Girls U14' where id = ${division_id}`;
    expect((await get(mine)).stage!.label).toBe(`Girls U14 · ${roundWordOf("en", 7)}`);
    await sql`update divisions set name = '   ' where id = ${division_id}`;
    expect((await get(mine)).stage!.label).toBe(roundWordOf("en", 7));
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
    expect(body.stage).toEqual({ code: "R1", role: { kind: "plain_round", n: 1 }, label: labelOf("en", { division: "Open", pool: null, round: roundWordOf("en", 1) }) });
  });

  it("label on the waiting AND the live descriptor: the rig's match put in pool A of an `es` org reads the division, the es pool word and the es round on both, for the session's phone and another", async () => {
    const r = await captureRig();
    await sql`update organizations set default_locale = 'es' where id = ${r.auth.orgId}`;
    const [{ stage_id }] = await sql<{ stage_id: string }[]>`select stage_id from fixtures where id = ${r.fixtureId}`;
    const [{ id: poolId }] = await sql<{ id: string }[]>`insert into pools (stage_id, key, name) values (${stage_id}, 'A', 'Pool A') returning id`;
    await sql`update fixtures set pool_id = ${poolId} where id = ${r.fixtureId}`;
    const want = { code: "R1", role: { kind: "plain_round", n: 1 }, pool: "A", label: labelOf("es", { division: "Open", pool: "A", round: roundWordOf("es", 1) }) };
    expect(want.label, "PREMISE: the Spanish words").toBe("Open · Grupo A · Ronda 1");
    const get = (phone: string | null) => getCode(r.code, r.tok, { slot: 0, phone }, r.deps, r.now());
    const mine = phoneId("mine");
    let checked = 0;
    for (const phone of [null, mine]) {
      const body = await get(phone);
      expect(body.state).toBe("waiting");
      expect(body.stage, "waiting").toEqual(want);
      checked++;
    }
    const sid = await r.start(mine);
    await sql`update fixture_stream_sessions set state = 'live', first_ingest_at = now() where id = ${sid}`;
    for (const phone of [mine, phoneId("other")]) {
      const body = await get(phone);
      expect(body.state).toBe("live");
      expect(body.stage, "live").toEqual(want);
      // The key ORDER on the wire too (code, role, pool, label): the capture-v2 smoke compares the stage as a string.
      expect(JSON.stringify(body.stage), "wire order").toBe(JSON.stringify(want));
      expect(CaptureDescriptor.parse(body)).toEqual(body);
      checked++;
    }
    expect(checked).toBe(4);
  });
});
