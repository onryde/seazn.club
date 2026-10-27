// W2c Task 15 fix round 1 (review I-1, M-4) — a correction made BEFORE kickoff reaches a pad already open on the match.
//
// A match with no frozen cfg plays whatever its division, stage and own override resolve to when its first event lands.
// A pad opened before kickoff loads that cfg and the match's `rules_version` (`loadFixturePadCfg`, the page's own read).
// Until this round a pre-kickoff correction moved the cfg and left the version alone, so the pad's first tap carried a
// version that still matched: it was accepted, and the first event froze the NEW format under a pad folding the OLD one
// (the reviewer's probe: pad best of 3, server best of 5). Every writer that moves what an unfrozen, undecided match
// resolves to now bumps its version in the same transaction:
//   - `writeFixtureRulesOverride` (fixture-rules.ts): the unstarted branch, and the legacy played-without-snapshot one;
//   - `patchDivision` (divisions.ts): a variant or config save;
//   - `putStageRules` (stage-rules.ts): the rules arm.
// `replaceStages` (the template Apply) owes none: it is refused while any fixture exists (FORMAT_LOCKED, under the
// division lock), so no pad can be open on a match it reshapes.
//
// The bump is read off what each match RESOLVES to before and after the write (`resolveFixtureCfg`, the fold's own
// resolver), so a save that moves nothing a match plays — a rename, tiebreakers, a stage's points, a re-send of what is
// stored, a key the match's own override already fixes — moves no version, and its open pad keeps scoring.
//
// Every expectation comes from the declarations: the version off `loadFixturePadCfg`, the formats off the engine's
// variant declarations, the refusal's format line off the public describer.
//
// Real Postgres; skipped without DATABASE_URL.
import { afterAll, describe, expect, it, vi } from "vitest";
import { builtinModules } from "@seazn/engine/sports";
import type { AnySportModule } from "@seazn/engine/sport";
import enPublic from "@/dictionaries/en/public.json";
import { sql } from "@/lib/db";
import type { Dict } from "@/lib/i18n-constants";
import type { AuthCtx } from "@/server/api-v1/auth";
import { declaredVariant, insertLegacyEvents, seedBracket } from "@/server/engine-db/__tests__/helpers/seed-bracket";
import { fixtureRow, post, rowsOf, siblingOf } from "@/server/engine-db/__tests__/helpers/w2b-rig";
import { patchDivision } from "../divisions";
import { writeFixtureRulesOverride } from "../fixture-rules";
import { getFixtureRules, loadFixturePadCfg } from "../fixtures";
import { scoreEvent } from "../scoring";
import { putStageRules } from "../stage-rules";
import { withdrawEntrantCascade } from "../withdrawal";

const HAS_DB = !!process.env.DATABASE_URL;

// Batch-5 m-1: which divisions the public revalidation was asked for. The spy wraps the REAL revalidation (it still runs).
const revalidated = vi.hoisted(() => [] as { divisionId: string; competitionId: string | undefined }[]);
vi.mock("@/server/public-site/revalidate", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/public-site/revalidate")>();
  return {
    ...real,
    fireDivisionRevalidate: (...args: Parameters<typeof real.fireDivisionRevalidate>) => {
      revalidated.push({ divisionId: args[0], competitionId: args[1] });
      return real.fireDivisionRevalidate(...args);
    },
  };
});

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

const moduleOf = (key: string): AnySportModule => {
  const m = builtinModules.find((x) => x.key === key);
  if (m === undefined) throw new Error(`no sport ${key}`);
  return m as AnySportModule;
};
/** A variant's format as the engine parses it — the cfg a match opens on before anything corrects it. */
const declared = (sport: string, variant: string) =>
  moduleOf(sport).configSchema.parse(moduleOf(sport).variants[variant]) as Record<string, unknown>;
const SHORT_BEST_OF = declared("badminton", "short").bestOf as number;
/** The corrected format: a best-of the variant does not declare (the right answer differs from the wrong one's). */
const TARGET = SHORT_BEST_OF === 5 ? 3 : 5;

const EN = enPublic as unknown as Dict;
/** The line the 409 and the pad's banner say, as the rules read answers it (`getFixtureRules`: GET /rules, the pad's own
 *  reload). This used to be `describeMatchRules` run on the reloaded cfg of a KNOCKOUT, which mirrored the code under test
 *  and agreed only because badminton states no decider and these corrections leave the abandon policy alone (batch-5
 *  re-review N-4); the describer's own oracle, built from the dictionary and the engine's declarations and checked against
 *  the match centre, is `rules-line-parity.test.ts`. Each use below also asserts the line CHANGED, so a 409 stuck on the
 *  old line cannot pass. */
const rulesLineNow = async (auth: AuthCtx, id: string): Promise<string | null> => (await getFixtureRules(auth, id, EN)).format_line;
const count = async (id: string) =>
  (await sql<{ n: number }[]>`select count(*)::int n from score_events where fixture_id = ${id}`)[0]!.n;
const snapshotOf = async (id: string) =>
  (await sql<{ s: Record<string, unknown> | null }[]>`select config_snapshot s from fixtures where id = ${id}`)[0]!.s;
/** Every fixture of the stage, id → version. */
const versions = async (stageId: string) =>
  Object.fromEntries(
    (await sql<{ id: string; v: number }[]>`select id, rules_version v from fixtures where stage_id = ${stageId}`).map((r) => [r.id, r.v]),
  );
const start = (rulesVersion: number) => ({ expected_seq: 0, type: "core.start", payload: {}, rules_version: rulesVersion });

// single-sport: badminton `short` is the review's probe rig (best of 3 → 5, the headline the pad shows); football is the
// "another sport" case below. The bump is in the writers every sport shares.
async function league(entrants = 3) {
  return seedBracket({ sport: "badminton", variant: "short", stageKind: "league", entrants });
}
type Seeded = Awaited<ReturnType<typeof league>>;

/** The three writers that can move an unstarted match's format, each moving best-of to TARGET. */
const WRITERS: readonly { name: string; correct: (b: Seeded, id: string) => Promise<unknown> }[] = [
  { name: "the match's own format (writeFixtureRulesOverride)", correct: (b, id) => writeFixtureRulesOverride(b.auth, [id], { bestOf: TARGET }) },
  { name: "the division's format (patchDivision)", correct: (b) => patchDivision(b.auth, b.divisionId, { config: { bestOf: TARGET } } as never) },
  { name: "the stage's rules (putStageRules)", correct: (b) => putStageRules(b.auth, b.stageId, { rules: { bestOf: TARGET } }) },
];
const corrected: string[] = [];

describe.skipIf(!HAS_DB)("X-SR-7 before kickoff: a correction reaches a pad already open on an unstarted match", () => {
  it.each(WRITERS)("$name: the pad's first tap under the version it loaded is refused, nothing is frozen, and the reloaded version is taken", async ({ name, correct }) => {
    const b = await league();
    const id = b.fixtureIds[0]!;
    const pad = await loadFixturePadCfg(b.auth, id);
    expect((pad.cfg as { bestOf: number }).bestOf, "premise: the pad opened on the variant's format").toBe(SHORT_BEST_OF);
    const lineBefore = await rulesLineNow(b.auth, id);
    await correct(b, id);
    const reloaded = await loadFixturePadCfg(b.auth, id);
    expect((reloaded.cfg as { bestOf: number }).bestOf, "premise: the correction moved the format").toBe(TARGET);
    expect(reloaded.rulesVersion, "the correction moved the version the pad compares").toBe(pad.rulesVersion + 1);
    const format = await rulesLineNow(b.auth, id);
    expect(format, "premise: the corrected match has a line to say").not.toBeNull();
    expect(format, "and it is not the line the pad opened on").not.toBe(lineBefore);
    await expect(scoreEvent(b.auth, id, start(pad.rulesVersion))).rejects.toMatchObject({
      code: "FIXTURE_RULES_CHANGED",
      extra: { rules_version: reloaded.rulesVersion, format },
    });
    expect(await count(id), "nothing was recorded").toBe(0);
    expect(await snapshotOf(id), "nothing was frozen under the old pad").toBeNull();
    // The pad reloads (GET /rules is the same read) and taps again: taken, and it freezes the format the pad now folds.
    await expect(scoreEvent(b.auth, id, start(reloaded.rulesVersion))).resolves.toMatchObject({ seq: 1, rules_version: reloaded.rulesVersion });
    expect(((await snapshotOf(id)) as { bestOf: number }).bestOf).toBe(TARGET);
    corrected.push(name);
  });

  it("legacy (M-4): a match played before V347 froze a snapshot folds under the live format, so its correction bumps too", async () => {
    const b = await league(2);
    const id = b.fixtureIds[0]!;
    await insertLegacyEvents(id, [{ type: "core.start", payload: {} }]); // played, nothing frozen
    expect(await snapshotOf(id), "premise: the legacy shape has no snapshot").toBeNull();
    const pad = await loadFixturePadCfg(b.auth, id);
    const out = await writeFixtureRulesOverride(b.auth, [id], { bestOf: TARGET });
    expect(out.fixtures[0], "a recorded event is play: started, and bumped").toEqual({ id, started: true, rules_version: pad.rulesVersion + 1 });
    const before = await count(id);
    await expect(
      scoreEvent(b.auth, id, { expected_seq: before, type: "badminton.game.summary", payload: { home: 11, away: 5 }, rules_version: pad.rulesVersion }),
    ).rejects.toMatchObject({ code: "FIXTURE_RULES_CHANGED", extra: { rules_version: pad.rulesVersion + 1 } });
    expect(await count(id)).toBe(before);
    corrected.push("legacy");
  });

  it("another sport (football, a division save): the stale first tap is refused with football's own format line", async () => {
    const b = await seedBracket({ sport: "football", variant: "11-a-side", stageKind: "league", entrants: 2 });
    const id = b.fixtureIds[0]!;
    const pad = await loadFixturePadCfg(b.auth, id);
    const half = (pad.cfg as { halfMinutes: number }).halfMinutes;
    expect(half, "premise: the variant declares its halves").toBe((declared("football", "11-a-side") as { halfMinutes: number }).halfMinutes);
    const next = half === 40 ? 35 : 40;
    const lineBefore = await rulesLineNow(b.auth, id);
    await patchDivision(b.auth, b.divisionId, { config: { halfMinutes: next } } as never);
    const reloaded = await loadFixturePadCfg(b.auth, id);
    expect((reloaded.cfg as { halfMinutes: number }).halfMinutes).toBe(next);
    const lineAfter = await rulesLineNow(b.auth, id);
    expect(lineAfter, "premise: football's own line moved with its halves").not.toBe(lineBefore);
    await expect(scoreEvent(b.auth, id, start(pad.rulesVersion))).rejects.toMatchObject({
      code: "FIXTURE_RULES_CHANGED",
      extra: { rules_version: pad.rulesVersion + 1, format: lineAfter },
    });
    expect(await count(id)).toBe(0);
    corrected.push("football");
  });

  it("counted: every writer and both extra shapes refused a stale first tap", () => {
    expect(corrected).toEqual([...WRITERS.map((w) => w.name), "legacy", "football"]);
  });
});

describe.skipIf(!HAS_DB)("X-SR-7 before kickoff, the positive pair: a save that moves nothing a match plays moves no version", () => {
  it("a rename, tiebreakers, a re-sent config, a stage's points and its re-sent rules: no version moves, and the open pad's first tap is taken", async () => {
    const b = await league();
    const before = await versions(b.stageId);
    expect(Object.keys(before), "premise: the stage has matches to watch").toHaveLength(b.fixtureIds.length);
    const pad = await loadFixturePadCfg(b.auth, b.fixtureIds[0]!);
    const [{ config }] = await sql<{ config: Record<string, unknown> }[]>`select config from divisions where id = ${b.divisionId}`;
    const [{ rules }] = await sql<{ rules: Record<string, unknown> | null }[]>`select config -> 'rules' as rules from stages where id = ${b.stageId}`;
    const saves: readonly [string, () => Promise<unknown>][] = [
      ["a rename", () => patchDivision(b.auth, b.divisionId, { name: "Renamed " + b.divisionId.slice(0, 6) })],
      // W2d Task 10: a division order is `validateCascade`d on the write path (`head_to_head` is no tie-break key, and a
      // badminton order opens on `wins` and closes on `lots`), so the change is a valid badminton order.
      ["a tiebreakers change", () => patchDivision(b.auth, b.divisionId, { tiebreakers: ["wins", "set_diff", "point_diff", "lots"] })],
      ["the stored config re-sent (a format save that changes nothing)", () => patchDivision(b.auth, b.divisionId, { config } as never)],
      ["a stage's points", () => putStageRules(b.auth, b.stageId, { points: { win: { regulation: 2 }, draw: 1, loss: { regulation: 0 }, shootoutAs: "result", unit: "whole" } })],
      ["the stage's stored rules re-sent", () => putStageRules(b.auth, b.stageId, { rules: rules ?? null })],
    ];
    let checked = 0;
    for (const [what, save] of saves) {
      await save();
      expect(await versions(b.stageId), what).toEqual(before);
      checked++;
    }
    expect(checked, "anti-vacuity: the saves checked").toBe(5);
    await expect(scoreEvent(b.auth, b.fixtureIds[0]!, start(pad.rulesVersion))).resolves.toMatchObject({ seq: 1, rules_version: pad.rulesVersion });
  });

  it("per match: a save leaves alone the match whose own format already fixes the key it moves, and bumps its sibling", async () => {
    const b = await league();
    const [own, plain] = b.fixtureIds;
    await writeFixtureRulesOverride(b.auth, [own!], { bestOf: 1 }); // the match's own format: best of one
    const ownPad = await loadFixturePadCfg(b.auth, own!);
    const plainPad = await loadFixturePadCfg(b.auth, plain!);
    expect(ownPad.rulesVersion, "premise: the override itself moved its match").toBe(plainPad.rulesVersion + 1);
    for (const [what, save] of [
      ["division", () => patchDivision(b.auth, b.divisionId, { config: { bestOf: TARGET } } as never)],
      ["stage", () => putStageRules(b.auth, b.stageId, { rules: { bestOf: SHORT_BEST_OF } })],
    ] as const) {
      const v = await versions(b.stageId);
      await save();
      const after = await versions(b.stageId);
      expect(after[own!], `${what}: the match's own best-of-one still stands`).toBe(v[own!]);
      expect(after[plain!], `${what}: its sibling's format moved`).toBe(v[plain!]! + 1);
    }
    expect((await loadFixturePadCfg(b.auth, own!)).cfg).toMatchObject({ bestOf: 1 });
    await expect(scoreEvent(b.auth, own!, start(ownPad.rulesVersion)), "the untouched match's pad keeps scoring").resolves.toMatchObject({ seq: 1 });
    await expect(scoreEvent(b.auth, plain!, start(plainPad.rulesVersion))).rejects.toMatchObject({ code: "FIXTURE_RULES_CHANGED" });
  });

  it("after a bye (decided without play, nothing frozen): a division save bumps the matches still to play and leaves the bye alone", async () => {
    // A bye takes no tap and its own format cannot be corrected (`fixture-rules.ts` (7a), FIXTURE_FORMAT_LOCKED), so the
    // per-match writer never bumps it; a save's bump agrees: `unfrozenRules` skips a SEEDED bye, a bye with no feeder that
    // no take-back can reopen, and reads every other shape with no frozen cfg (the feeder test in `resolvedNow`). An odd
    // knockout draw is the rig that has seeded byes beside matches still to play.
    const variant = declaredVariant("badminton", "bwf");
    const bestOf = declared("badminton", variant).bestOf as number;
    const odd = await seedBracket({ sport: "badminton", variant, stageKind: "knockout", entrants: 6 });
    const rows = await sql<{ id: string; outcome: { reason?: string } | null; s: unknown }[]>`
      select id, outcome, config_snapshot s from fixtures where stage_id = ${odd.stageId}`;
    const byes = rows.filter((r) => r.outcome?.reason === "bye");
    const open = rows.filter((r) => r.outcome === null);
    expect(byes.length, "premise: the odd draw has byes").toBeGreaterThan(0);
    expect(open.length, "premise: and matches still to play").toBeGreaterThan(0);
    for (const r of byes) expect(r.s, "premise: a bye freezes nothing").toBeNull();
    // The bye excluded is the SEEDED one: no feeder, so no take-back can ever reopen it. (The award a dead seat leaves in a
    // later round carries `reason: "bye"` too, but it has feeders and IS read: the table-key door tests below.)
    const [{ fed }] = await sql<{ fed: number }[]>`
      select count(*)::int fed from fixtures g where g.winner_to_fixture = any(${byes.map((r) => r.id)}::uuid[]) or g.loser_to_fixture = any(${byes.map((r) => r.id)}::uuid[])`;
    expect(fed, "premise: nothing feeds a seeded bye").toBe(0);
    const before = await versions(odd.stageId);
    await patchDivision(odd.auth, odd.divisionId, { config: { bestOf: bestOf === 5 ? 3 : 5 } } as never);
    const after = await versions(odd.stageId);
    let checked = 0;
    for (const r of byes) {
      expect(after[r.id], "a bye's version stays").toBe(before[r.id]);
      checked++;
    }
    for (const r of open) {
      expect(after[r.id], "a match still to play moves").toBe(before[r.id]! + 1);
      checked++;
    }
    expect(checked, "anti-vacuity: every bye and every match still to play").toBe(byes.length + open.length);
  });
});

// Batch-5 Q5 (review class 13): a take-back that reopens an event-less award (fed-seats.ts: the `reset` release, the walkover
// revive, the abandoned revive) must not leave a pad's version dishonest: a pad opened on the award's match before the award
// must never freeze, at its first tap, a cfg a save moved while the award sat out of `unfrozenRules`.
//   - The FORMAT keys cannot move it: a take-back needs an event in the stage, a played stage is locked, and the division
//     save refuses `DIVISION_FORMAT_LOCKED`, the stage PUT `STAGE_FORMAT_LOCKED`, the per-match writer
//     `FIXTURE_FORMAT_LOCKED` on the award (rule-locks.ts reads PLAYED; a double walkover or a played semi is an event).
//     The first fix round probed only those and ruled the premise false; the three reopen tests below pin that they bump
//     nothing when nothing moved (a bump there would refuse a pad holding the right rules).
//   - The TABLE keys CAN: `divisionRefusals` lets a table (points-scope) key through on a started KNOCKOUT ("a knockout
//     has no table to protect", rule-locks.ts), and table keys flow into `resolveFixtureCfg` (football's `awardScore` is
//     the walkover's headline, a set sport's `pointsMap` is table-only). The re-review's probe drove it through the real
//     doors: the award is excluded from `unfrozenRules`, the save moved its cfg and bumped nothing, the revive reopened it,
//     and a tap at the old version was ACCEPTED and froze the new cfg under a pad folding the old. `resolvedNow` now
//     excludes only a bye (the system's award: no pad, no format a save can change), so the SAVE bumps an event-less
//     walkover whose resolved cfg moved, and nothing bumps at the reopen. The "table-key door" tests below drive it.
// A future door that moves a played stage's award (the planned bulk apply to unstarted matches) bumps what it moves.
describe.skipIf(!HAS_DB)("X-SR-7 a take-back that reopens an event-less award: the format-key doors refuse and a reopen alone bumps nothing; the table-key door bumps at the save (batch-5 Q5)", () => {
  const BWF = declared("badminton", "bwf").bestOf as number;
  const MOVED = BWF === 5 ? 3 : 5; // a best-of the variant does not declare: a format save that landed would be seen
  type Ko = Awaited<ReturnType<typeof knockout>>;
  async function knockout(entrants: 4 | 8) {
    return seedBracket({ sport: "badminton", variant: "bwf", stageKind: "knockout", entrants });
  }
  /** Home wins, game after game, until the match is decided (the format may not be the declared one). */
  async function winOut(b: Ko, id: string) {
    if ((await fixtureRow(id)).status === "scheduled") await post(b.auth, id, "core.start");
    for (let g = 0; g < 5 && (await fixtureRow(id)).status !== "decided"; g++) {
      await post(b.auth, id, "badminton.game.summary", { home: 21, away: 10 });
    }
    expect((await fixtureRow(id)).status, "rig: the match was played out").toBe("decided");
  }
  const dw = (b: Ko, id: string) => post(b.auth, id, "core.forfeit", { by: "both", reason: "walkover" });
  const lastEvent = async (id: string) =>
    (await sql<{ id: string }[]>`select id from score_events where fixture_id = ${id} order by seq desc limit 1`)[0]!.id;
  const versionOf = async (id: string) =>
    (await sql<{ v: number }[]>`select rules_version v from fixtures where id = ${id}`)[0]!.v;

  /** The three FORMAT-key doors refuse (the division's `bestOf`, the stage's rules, the match's own override) and nothing
   *  moved. Table keys are NOT among them - that door is open, and the "table-key door" tests below drive it. `perMatch:
   *  false` is the cascade void: it has no outcome, so the per-match writer is allowed on it (and bumps it itself). */
  async function formatKeyDoorsRefuse(b: Ko, awardId: string, perMatch = true) {
    await expect(patchDivision(b.auth, b.divisionId, { config: { bestOf: MOVED } } as never)).rejects.toMatchObject({
      code: "DIVISION_FORMAT_LOCKED",
    });
    await expect(putStageRules(b.auth, b.stageId, { rules: { bestOf: MOVED } })).rejects.toMatchObject({ code: "STAGE_FORMAT_LOCKED" });
    if (perMatch) {
      await expect(writeFixtureRulesOverride(b.auth, [awardId], { bestOf: MOVED })).rejects.toMatchObject({ code: "FIXTURE_FORMAT_LOCKED" });
    }
    const [{ config }] = await sql<{ config: { bestOf?: number } }[]>`select config from divisions where id = ${b.divisionId}`;
    expect(config.bestOf, "nothing landed on the division").not.toBe(MOVED);
  }
  /** The pad that loaded before the award sends its first tap under the version it loaded: taken, and it freezes the cfg it folds. */
  async function padStillHonest(b: Ko, finalId: string, pad: Awaited<ReturnType<typeof loadFixturePadCfg>>) {
    const reloaded = await loadFixturePadCfg(b.auth, finalId);
    expect(reloaded.cfg, "the cfg the match resolves to is the one the pad folds").toEqual(pad.cfg);
    expect(reloaded.rulesVersion).toBe(pad.rulesVersion);
    expect(await versionOf(finalId), "no spurious bump from the reopen").toBe(pad.rulesVersion);
    await expect(scoreEvent(b.auth, finalId, start(pad.rulesVersion))).resolves.toMatchObject({ seq: 1, rules_version: pad.rulesVersion });
    expect(((await snapshotOf(finalId)) as { bestOf: number }).bestOf, "it froze the format the pad folds").toBe((pad.cfg as { bestOf: number }).bestOf);
  }
  const reopened: string[] = [];

  it("the walkover revive: the void of the double walkover that killed the seat reopens the walkover; the pad's first tap is taken", async () => {
    const b = await knockout(4);
    const sf1 = await fixtureRow(b.fixtureIds[0]!);
    const finalId = sf1.winner_to_fixture!;
    const pad = await loadFixturePadCfg(b.auth, finalId);
    expect((pad.cfg as { bestOf: number }).bestOf, "premise: the pad opened on the declared format").toBe(BWF);
    const killed = await dw(b, sf1.id);
    await winOut(b, b.fixtureIds[1]!);
    const walked = await fixtureRow(finalId);
    expect([walked.status, walked.outcome?.kind, await count(finalId)], "premise: the final is an event-less award").toEqual(["forfeited", "award", 0]);
    await formatKeyDoorsRefuse(b, finalId);
    expect(await versionOf(finalId), "the award sat out the doors, version untouched").toBe(pad.rulesVersion);
    await post(b.auth, sf1.id, "core.void", { event_id: killed.event_id });
    expect((await fixtureRow(finalId)).status, "premise: the revive reopened the award").toBe("scheduled");
    await winOut(b, sf1.id);
    await padStillHonest(b, finalId, pad);
    reopened.push("walkover revive");
  }, 120_000);

  it("the release (reset): taking back the played semi resets the walkover it advanced; the pad's first tap is taken", async () => {
    const b = await knockout(4);
    const sf1 = await fixtureRow(b.fixtureIds[0]!);
    const sf2Id = b.fixtureIds[1]!;
    const finalId = sf1.winner_to_fixture!;
    const pad = await loadFixturePadCfg(b.auth, finalId);
    const killed = await dw(b, sf1.id);
    await winOut(b, sf2Id);
    expect((await fixtureRow(finalId)).status, "premise: the final is walked over").toBe("forfeited");
    await formatKeyDoorsRefuse(b, finalId);
    await post(b.auth, sf2Id, "core.void", { event_id: await lastEvent(sf2Id) });
    const reset = await fixtureRow(finalId);
    expect([reset.status, reset.outcome, await versionOf(finalId)], "premise: the reset reopened the award").toEqual(["scheduled", null, pad.rulesVersion]);
    await post(b.auth, sf1.id, "core.void", { event_id: killed.event_id });
    await winOut(b, sf2Id);
    await winOut(b, sf1.id);
    await padStillHonest(b, finalId, pad);
    reopened.push("reset");
  }, 120_000);

  it("the abandoned revive: the void of a double walkover reopens the semi the cascade voided; the pad's first tap is taken", async () => {
    const b = await knockout(8);
    const rows = await rowsOf(b.stageId);
    const qf1 = await fixtureRow(b.fixtureIds[0]!);
    const qf2 = siblingOf(rows, qf1);
    const semiId = qf1.winner_to_fixture!;
    const pad = await loadFixturePadCfg(b.auth, semiId);
    const k1 = await dw(b, qf1.id);
    const k2 = await dw(b, qf2.id);
    const voided = await fixtureRow(semiId);
    expect([voided.status, voided.outcome, await count(semiId)], "premise: both feeders dead, the semi is a cascade void").toEqual(["abandoned", null, 0]);
    await formatKeyDoorsRefuse(b, semiId, false);
    await post(b.auth, qf1.id, "core.void", { event_id: k1.event_id });
    await post(b.auth, qf2.id, "core.void", { event_id: k2.event_id });
    expect((await fixtureRow(semiId)).status, "premise: the revive reopened the semi").toBe("scheduled");
    await winOut(b, qf1.id);
    await winOut(b, qf2.id);
    await padStillHonest(b, semiId, pad);
    reopened.push("abandoned revive");
  }, 120_000);

  it("the abandoned revive, the one FORMAT-key door that is open: the per-match writer bumps the cascade void ITSELF, so the revive adds nothing and the stale pad is refused once", async () => {
    // A cascade void has no outcome, so `unfrozenRules` reads it (it is not decided without play) and the per-match writer
    // is not locked out of it: the one format door that reaches a reopenable shape, and it bumps in its own transaction.
    const b = await knockout(8);
    const qf1 = await fixtureRow(b.fixtureIds[0]!);
    const qf2 = siblingOf(await rowsOf(b.stageId), qf1);
    const semiId = qf1.winner_to_fixture!;
    const pad = await loadFixturePadCfg(b.auth, semiId);
    const lineBefore = await rulesLineNow(b.auth, semiId);
    const k1 = await dw(b, qf1.id);
    const k2 = await dw(b, qf2.id);
    expect((await fixtureRow(semiId)).status, "premise: the semi is a cascade void").toBe("abandoned");
    await writeFixtureRulesOverride(b.auth, [semiId], { bestOf: MOVED });
    expect(await versionOf(semiId), "the writer bumped it").toBe(pad.rulesVersion + 1);
    await post(b.auth, qf1.id, "core.void", { event_id: k1.event_id });
    await post(b.auth, qf2.id, "core.void", { event_id: k2.event_id });
    expect((await fixtureRow(semiId)).status, "premise: the revive reopened the semi").toBe("scheduled");
    expect(await versionOf(semiId), "the revive bumped nothing more").toBe(pad.rulesVersion + 1);
    await winOut(b, qf1.id);
    await winOut(b, qf2.id);
    const now = await loadFixturePadCfg(b.auth, semiId);
    expect((now.cfg as { bestOf: number }).bestOf).toBe(MOVED);
    const lineAfter = await rulesLineNow(b.auth, semiId);
    expect(lineAfter, "premise: the line moved with the best-of").not.toBe(lineBefore);
    await expect(scoreEvent(b.auth, semiId, start(pad.rulesVersion))).rejects.toMatchObject({
      code: "FIXTURE_RULES_CHANGED",
      extra: { rules_version: pad.rulesVersion + 1, format: lineAfter },
    });
    await expect(scoreEvent(b.auth, semiId, start(now.rulesVersion))).resolves.toMatchObject({ seq: 1 });
    reopened.push("abandoned revive + per-match");
  }, 120_000);

  it("counted: all three reopening writes were driven, and the one FORMAT-key door that is open", () => {
    expect(reopened).toEqual(["walkover revive", "reset", "abandoned revive", "abandoned revive + per-match"]);
  });

  // ---- the table-key door (batch-5 re-review, Q5) -------------------------------------------------------------------
  // A points-scope key is NOT refused on a played knockout, so a division save can move what an event-less walkover
  // resolves to between the pad's load and the reopen. The save bumps the walkover (`resolvedNow` excludes only byes).
  const PM = declared("badminton", "bwf").pointsMap as Record<string, [number, number]>;
  const PM_KEY = Object.keys(PM)[0]!;
  /** A points map the variant does not declare: the winner's points one higher (so the right answer differs from the old). */
  const PM_MOVED = { ...PM, [PM_KEY]: [PM[PM_KEY]![0] + 1, PM[PM_KEY]![1]] as [number, number] };
  const tableKey: string[] = [];
  /** The per-match writer's door onto an event-less walkover (fixture-rules.ts 7a), driven below. */
  const walkoverDoor: string[] = [];
  const forfeitAway = (b: Ko, row: { id: string; away_entrant_id: string | null }) =>
    post(b.auth, row.id, "core.forfeit", { by: row.away_entrant_id, reason: "walkover" });
  /** A division save of one table key on the played knockout: accepted (no refusal), and what it landed. */
  async function saveTableKey(b: Ko, config: Record<string, unknown>) {
    const out = await patchDivision(b.auth, b.divisionId, { config } as never);
    expect((out as { refused?: unknown[] }).refused ?? [], "premise: the played knockout lets a table key through").toEqual([]);
  }
  /** The pad that loaded before the save taps under the version it loaded: refused (nothing recorded, nothing frozen) with
   *  the corrected version and the line the rules read says; it reloads, the cfg carries the moved key, and the retaken tap
   *  lands and freezes it. `pick` reads the moved key off a cfg. */
  async function staleThenReload(b: Ko, id: string, pad: Awaited<ReturnType<typeof loadFixturePadCfg>>, pick: (cfg: unknown) => unknown, want: unknown) {
    expect(pick(pad.cfg), "premise: the pad was folding the old value").not.toEqual(want);
    const format = await rulesLineNow(b.auth, id);
    await expect(scoreEvent(b.auth, id, start(pad.rulesVersion))).rejects.toMatchObject({
      status: 409,
      code: "FIXTURE_RULES_CHANGED",
      extra: { rules_version: pad.rulesVersion + 1, format },
    });
    expect(await count(id), "the refused tap wrote nothing").toBe(0);
    expect(await snapshotOf(id), "and froze nothing").toBeNull();
    const reloaded = await loadFixturePadCfg(b.auth, id);
    expect(pick(reloaded.cfg), "the reload carries the moved key").toEqual(want);
    expect(reloaded.rulesVersion).toBe(pad.rulesVersion + 1);
    await expect(scoreEvent(b.auth, id, start(reloaded.rulesVersion))).resolves.toMatchObject({ seq: 1, rules_version: reloaded.rulesVersion });
    expect(pick(await snapshotOf(id)), "the first event froze the moved cfg").toEqual(want);
  }

  it("football 11-a-side, a knockout of 4 (the re-review's probe): awardScore saved while the final is a walkover bumps it, so the pad's old version is refused after the revive and the reload carries the new goals", async () => {
    const b = await seedBracket({ sport: "football", variant: "11-a-side", stageKind: "knockout", entrants: 4 });
    const sf1 = await fixtureRow(b.fixtureIds[0]!);
    const sf2 = siblingOf(await rowsOf(b.stageId), sf1);
    const finalId = sf1.winner_to_fixture!;
    const pad = await loadFixturePadCfg(b.auth, finalId);
    const award = (pad.cfg as { awardScore: { goals: number } }).awardScore;
    const GOALS = award.goals + 2;
    const goalsOf = (cfg: unknown) => (cfg as { awardScore?: { goals?: number } } | null)?.awardScore?.goals;

    const killed = await dw(b, sf1.id); // SF1: both sides forfeit, its seat in the final is dead
    await forfeitAway(b, sf2); // SF2: the away side forfeits, the home side advances: the final is walked over
    const walked = await fixtureRow(finalId);
    expect([walked.status, walked.outcome?.kind, await count(finalId), await versionOf(finalId)], "premise: the final is an event-less award at the pad's version").toEqual(["forfeited", "award", 0, pad.rulesVersion]);
    const semiVersions = [await versionOf(sf1.id), await versionOf(sf2.id)];

    // The empty case first: re-sending the stored value moves nothing the award resolves to, so it bumps nothing.
    await saveTableKey(b, { awardScore: award });
    expect(await versionOf(finalId), "a re-sent table key moves no version").toBe(pad.rulesVersion);
    // The save that moves it.
    await saveTableKey(b, { awardScore: { ...award, goals: GOALS } });
    expect(await versionOf(finalId), "the save moved what the walkover resolves to, so it bumped it").toBe(pad.rulesVersion + 1);
    expect([await versionOf(sf1.id), await versionOf(sf2.id)], "the played semis keep their snapshots: no bump").toEqual(semiVersions);

    await post(b.auth, sf1.id, "core.void", { event_id: killed.event_id });
    expect((await fixtureRow(finalId)).status, "premise: the revive reopened the final").toBe("scheduled");
    await forfeitAway(b, sf1); // SF1 re-decided: both seats of the final are filled again
    const seated = await fixtureRow(finalId);
    expect([seated.home_entrant_id !== null, seated.away_entrant_id !== null], "premise: the final is seated").toEqual([true, true]);
    expect(await versionOf(finalId), "the reopen bumped nothing more").toBe(pad.rulesVersion + 1);

    await staleThenReload(b, finalId, pad, goalsOf, GOALS);
    tableKey.push("football walkover revive");
  }, 120_000);

  it.each([
    {
      name: "badminton walkover revive",
      run: async (b: Ko) => {
        const sf1 = await fixtureRow(b.fixtureIds[0]!);
        const finalId = sf1.winner_to_fixture!;
        const pad = await loadFixturePadCfg(b.auth, finalId);
        const killed = await dw(b, sf1.id);
        await winOut(b, b.fixtureIds[1]!);
        expect((await fixtureRow(finalId)).status, "premise: the final is walked over").toBe("forfeited");
        return { id: finalId, pad, bumpedAtSave: true, reopen: async () => {
          await post(b.auth, sf1.id, "core.void", { event_id: killed.event_id });
          expect((await fixtureRow(finalId)).status, "premise: the revive reopened it").toBe("scheduled");
          await winOut(b, sf1.id);
        } };
      },
      entrants: 4 as const,
    },
    {
      name: "badminton reset (taking back the played semi)",
      run: async (b: Ko) => {
        const sf1 = await fixtureRow(b.fixtureIds[0]!);
        const sf2Id = b.fixtureIds[1]!;
        const finalId = sf1.winner_to_fixture!;
        const pad = await loadFixturePadCfg(b.auth, finalId);
        const killed = await dw(b, sf1.id);
        await winOut(b, sf2Id);
        expect((await fixtureRow(finalId)).status, "premise: the final is walked over").toBe("forfeited");
        return { id: finalId, pad, bumpedAtSave: true, reopen: async () => {
          await post(b.auth, sf2Id, "core.void", { event_id: await lastEvent(sf2Id) });
          expect((await fixtureRow(finalId)).outcome, "premise: the reset released the award").toBeNull();
          await post(b.auth, sf1.id, "core.void", { event_id: killed.event_id });
          await winOut(b, sf2Id);
          await winOut(b, sf1.id);
        } };
      },
      entrants: 4 as const,
    },
    {
      // The pair that was never excluded: a cascade void has no outcome, so `resolvedNow` always read it. It must still bump.
      name: "badminton abandoned revive (a cascade void)",
      run: async (b: Ko) => {
        const qf1 = await fixtureRow(b.fixtureIds[0]!);
        const qf2 = siblingOf(await rowsOf(b.stageId), qf1);
        const semiId = qf1.winner_to_fixture!;
        const pad = await loadFixturePadCfg(b.auth, semiId);
        const k1 = await dw(b, qf1.id);
        const k2 = await dw(b, qf2.id);
        expect((await fixtureRow(semiId)).status, "premise: the semi is a cascade void").toBe("abandoned");
        return { id: semiId, pad, bumpedAtSave: true, reopen: async () => {
          await post(b.auth, qf1.id, "core.void", { event_id: k1.event_id });
          await post(b.auth, qf2.id, "core.void", { event_id: k2.event_id });
          expect((await fixtureRow(semiId)).status, "premise: the revive reopened the semi").toBe("scheduled");
          await winOut(b, qf1.id);
          await winOut(b, qf2.id);
        } };
      },
      entrants: 8 as const,
    },
  ])("$name: a points-map save while the match is decided without play bumps it at the save, and the pad's old version is refused after the reopen", async ({ name, run, entrants }) => {
    const b = await knockout(entrants);
    const { id, pad, reopen } = await run(b);
    const v0 = pad.rulesVersion;
    expect(await versionOf(id), "premise: nothing has bumped it yet").toBe(v0);
    await saveTableKey(b, { pointsMap: PM_MOVED });
    expect(await versionOf(id), "the save moved what the match resolves to, so it bumped it").toBe(v0 + 1);
    await reopen();
    expect(await versionOf(id), "the reopen bumped nothing more").toBe(v0 + 1);
    await staleThenReload(b, id, pad, (cfg) => (cfg as { pointsMap?: unknown } | null)?.pointsMap, PM_MOVED);
    tableKey.push(name);
  }, 180_000);

  it("badminton third place, a bye fed by LOSER edges only: the same save bumps it, and its pad's old version is refused after the reopen", async () => {
    // A bye the cascade writes on the third-place match when a semi is a double walkover: its feeders are the semis'
    // LOSER edges, never a winner edge, so a feeder test that read only winner edges would call it a seeded bye and skip it.
    const b = await seedBracket({ sport: "badminton", variant: "bwf", stageKind: "knockout", entrants: 4, stageConfig: { thirdPlace: true } });
    const sf1 = await fixtureRow(b.fixtureIds[0]!);
    const thirdId = sf1.loser_to_fixture!;
    const pad = await loadFixturePadCfg(b.auth, thirdId);
    const killed = await dw(b, sf1.id);
    await winOut(b, b.fixtureIds[1]!);
    const third = await fixtureRow(thirdId);
    expect([third.status, third.outcome?.reason], "premise: third place is a bye").toEqual(["forfeited", "bye"]);
    const [{ byWinner, byLoser }] = await sql<{ byWinner: number; byLoser: number }[]>`
      select count(*) filter (where winner_to_fixture = ${thirdId})::int "byWinner",
             count(*) filter (where loser_to_fixture = ${thirdId})::int "byLoser" from fixtures where stage_id = ${b.stageId}`;
    expect([byWinner, byLoser], "premise: only loser edges feed third place").toEqual([0, 2]);
    expect(await versionOf(thirdId)).toBe(pad.rulesVersion);
    await saveTableKey(b, { pointsMap: PM_MOVED });
    expect(await versionOf(thirdId), "the save moved what the third-place bye resolves to, so it bumped it").toBe(pad.rulesVersion + 1);
    await post(b.auth, sf1.id, "core.void", { event_id: killed.event_id });
    await winOut(b, sf1.id);
    expect((await fixtureRow(thirdId)).status, "premise: both semis' losers are seated").toBe("scheduled");
    await staleThenReload(b, thirdId, pad, (cfg) => (cfg as { pointsMap?: unknown } | null)?.pointsMap, PM_MOVED);
    tableKey.push("badminton third place (loser edges)");
  }, 180_000);

  it("football 11-a-side, a ruling-116 walkover (the winner withdrew before her opponent arrived): the per-match writer's correction bumps it, so the pad's old version is refused after the take-back and the reload carries the new halves", async () => {
    // The re-review's second probe. The semi's winner withdraws before the other semi is decided, so the arriving side walks
    // over her dead seat: an award with `reason: "withdrew"`, NO event and no snapshot (not a bye: it is a walkover a
    // take-back can reopen). The per-match writer's 7a branch fits a halves correction on it and re-writes the award - and
    // used to bump nothing ("no frozen cfg to bump"), so the reopened final accepted a tap at the old version and froze 40
    // under a pad folding 45. Control: the division table-key door bumped it (the tests above).
    const b = await seedBracket({ sport: "football", variant: "11-a-side", stageKind: "knockout", entrants: 4 });
    const sf1 = await fixtureRow(b.fixtureIds[0]!);
    const sf2 = siblingOf(await rowsOf(b.stageId), sf1);
    const finalId = sf1.winner_to_fixture!;
    await post(b.auth, sf1.id, "core.forfeit", { by: sf1.away_entrant_id, reason: "walkover" }); // SF1 decided: its home side advances
    const pad = await loadFixturePadCfg(b.auth, finalId); // the pad opens on the final, SF2 still to play
    const halves = (pad.cfg as { halfMinutes: number }).halfMinutes;
    const HALVES = halves === 40 ? 35 : 40; // a length the variant does not declare: the right answer differs from the old
    await withdrawEntrantCascade(b.auth, sf1.home_entrant_id!); // the SF1 winner withdraws before her opponent arrives
    await post(b.auth, sf2.id, "core.forfeit", { by: sf2.away_entrant_id, reason: "walkover" }); // SF2 decided: her opponent arrives
    const walked = await fixtureRow(finalId);
    expect(
      [walked.status, walked.outcome?.kind, walked.outcome?.reason, await count(finalId), await snapshotOf(finalId), await versionOf(finalId)],
      "premise: the final is a ruling-116 award: no event, no snapshot, the pad's version",
    ).toEqual(["forfeited", "award", "withdrew", 0, null, pad.rulesVersion]);

    await writeFixtureRulesOverride(b.auth, [finalId], { halfMinutes: HALVES });
    expect(await versionOf(finalId), "the correction moved what the walkover resolves to, so it bumped it").toBe(pad.rulesVersion + 1);
    await writeFixtureRulesOverride(b.auth, [finalId], { halfMinutes: HALVES }); // the second call: a re-send moves nothing
    expect(await versionOf(finalId), "re-sending the format it already plays bumps nothing").toBe(pad.rulesVersion + 1);

    await post(b.auth, sf1.id, "core.void", { event_id: await lastEvent(sf1.id) }); // take SF1's decision back: the final reopens
    expect((await fixtureRow(finalId)).status, "premise: the take-back reopened the final").toBe("scheduled");
    await post(b.auth, sf1.id, "core.forfeit", { by: sf1.home_entrant_id, reason: "walkover" }); // SF1 re-decided the other way
    const seated = await fixtureRow(finalId);
    expect([seated.home_entrant_id === sf1.away_entrant_id, seated.away_entrant_id === sf2.home_entrant_id], "premise: the final is seated again").toEqual([true, true]);
    expect(await versionOf(finalId), "the reopen bumped nothing more").toBe(pad.rulesVersion + 1);

    await staleThenReload(b, finalId, pad, (cfg) => (cfg as { halfMinutes?: number } | null)?.halfMinutes, HALVES);
    walkoverDoor.push("football ruling-116 walkover, per-match writer");
  }, 180_000);

  it("counted: the table-key door was driven on a walkover revive in both a goal sport and a set sport, the reset, the cascade void and a loser-fed bye", () => {
    expect(tableKey).toEqual([
      "football walkover revive",
      "badminton walkover revive",
      "badminton reset (taking back the played semi)",
      "badminton abandoned revive (a cascade void)",
      "badminton third place (loser edges)",
    ]);
    expect(walkoverDoor, "the per-match writer's walkover door was driven too").toEqual(["football ruling-116 walkover, per-match writer"]);
  });
});

// Batch-5 m-1: a division format save that only moves `config` must reach the public pages. The pad's banner said "Best of
// 5" the moment the save's version bump was reloaded, while the hub's format line, the stage chips and the match centre
// kept "Best of 3" until their caches expired - `putStageRules` and the per-match writer always revalidate, the division
// save did so only when it re-wrote a walkover or re-seeded a stage.
describe.skipIf(!HAS_DB)("a division format save revalidates the public pages when the format it stores moved (batch-5 m-1)", () => {
  it("the empty cases first: a rename and a re-sent config revalidate nothing; a config that moves the format does, once, with its competition", async () => {
    const b = await league();
    const [{ competition_id: competitionId }] = await sql<{ competition_id: string }[]>`select competition_id from divisions where id = ${b.divisionId}`;
    const mine = () => revalidated.filter((r) => r.divisionId === b.divisionId);
    const [{ config }] = await sql<{ config: Record<string, unknown> }[]>`select config from divisions where id = ${b.divisionId}`;

    revalidated.length = 0;
    await patchDivision(b.auth, b.divisionId, { name: "Renamed " + b.divisionId.slice(0, 6) });
    expect(mine(), "a rename moves no format").toEqual([]);
    await patchDivision(b.auth, b.divisionId, { config } as never);
    expect(mine(), "the stored config re-sent moves no format").toEqual([]);

    await patchDivision(b.auth, b.divisionId, { config: { bestOf: TARGET } } as never);
    expect(mine(), "a config-only save that moved the format: told once, with the competition").toEqual([{ divisionId: b.divisionId, competitionId }]);
    expect(((await sql<{ c: { bestOf: number } }[]>`select config c from divisions where id = ${b.divisionId}`)[0]!.c).bestOf, "premise: it stored the change").toBe(TARGET);

    revalidated.length = 0;
    await patchDivision(b.auth, b.divisionId, { config: { bestOf: TARGET } } as never);
    expect(mine(), "the same save again moves nothing").toEqual([]);
  });

  it("a save the stage lock refuses entirely lands nothing and tells nobody", async () => {
    const b = await league();
    await scoreEvent(b.auth, b.fixtureIds[0]!, { expected_seq: 0, type: "core.start", payload: {} });
    revalidated.length = 0;
    await expect(patchDivision(b.auth, b.divisionId, { config: { bestOf: TARGET } } as never)).rejects.toMatchObject({ code: "DIVISION_FORMAT_LOCKED" });
    expect(revalidated.filter((r) => r.divisionId === b.divisionId), "refused: nothing stored, nothing to refresh").toEqual([]);
  });

  it("another sport (football): a halves save revalidates too, though no stage was re-seeded and no walkover re-written", async () => {
    const b = await seedBracket({ sport: "football", variant: "11-a-side", stageKind: "league", entrants: 2 });
    const half = (declared("football", "11-a-side") as { halfMinutes: number }).halfMinutes;
    revalidated.length = 0;
    await patchDivision(b.auth, b.divisionId, { config: { halfMinutes: half === 40 ? 35 : 40 } } as never);
    expect(revalidated.filter((r) => r.divisionId === b.divisionId)).toHaveLength(1);
  });
});
