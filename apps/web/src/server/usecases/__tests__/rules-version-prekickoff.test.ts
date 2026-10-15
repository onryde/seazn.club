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
import { afterAll, describe, expect, it } from "vitest";
import { builtinModules } from "@seazn/engine/sports";
import type { AnySportModule } from "@seazn/engine/sport";
import enPublic from "@/dictionaries/en/public.json";
import { sql } from "@/lib/db";
import type { Dict } from "@/lib/i18n-constants";
import { rulesLineText } from "@/lib/rules-line";
import { describeMatchRules } from "@/server/public-site/describe-rules";
import { declaredVariant, insertLegacyEvents, seedBracket } from "@/server/engine-db/__tests__/helpers/seed-bracket";
import { fixtureRow, post, rowsOf, siblingOf } from "@/server/engine-db/__tests__/helpers/w2b-rig";
import { patchDivision } from "../divisions";
import { writeFixtureRulesOverride } from "../fixture-rules";
import { loadFixturePadCfg } from "../fixtures";
import { scoreEvent } from "../scoring";
import { putStageRules } from "../stage-rules";

const HAS_DB = !!process.env.DATABASE_URL;
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

const formatLine = (sport: string, cfg: unknown): string | null => {
  const line = describeMatchRules(sport, moduleOf(sport), cfg);
  return line === null ? null : rulesLineText(enPublic as unknown as Dict, line);
};
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
    await correct(b, id);
    const reloaded = await loadFixturePadCfg(b.auth, id);
    expect((reloaded.cfg as { bestOf: number }).bestOf, "premise: the correction moved the format").toBe(TARGET);
    expect(reloaded.rulesVersion, "the correction moved the version the pad compares").toBe(pad.rulesVersion + 1);
    const format = formatLine("badminton", reloaded.cfg);
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
    await patchDivision(b.auth, b.divisionId, { config: { halfMinutes: next } } as never);
    const reloaded = await loadFixturePadCfg(b.auth, id);
    expect((reloaded.cfg as { halfMinutes: number }).halfMinutes).toBe(next);
    await expect(scoreEvent(b.auth, id, start(pad.rulesVersion))).rejects.toMatchObject({
      code: "FIXTURE_RULES_CHANGED",
      extra: { rules_version: pad.rulesVersion + 1, format: formatLine("football", reloaded.cfg) },
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
      ["a tiebreakers change", () => patchDivision(b.auth, b.divisionId, { tiebreakers: ["head_to_head"] as never })],
      ["the stored config re-sent (a format save that changes nothing)", () => patchDivision(b.auth, b.divisionId, { config } as never)],
      ["a stage's points", () => putStageRules(b.auth, b.stageId, { points: { base: { win: 2, draw: 1, loss: 0 } } })],
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
    // per-match writer never bumps it; a save's bump agrees (`unfrozenRules` reads only matches with no outcome or with
    // recorded play). An odd knockout draw is the rig that has byes beside matches still to play.
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

// Batch-5 Q5 (review class 13, "CONFIRMED" by reading `unfrozenRules`): a take-back that reopens an event-less award
// (fed-seats.ts: the `reset` release, the walkover revive, the abandoned revive) was said to miss a version bump, so a
// pad opened before the award would freeze, at its first tap, a format that a save moved while the award was excluded
// from `unfrozenRules`. The sequence was DRIVEN through the real doors and the premise is false: step 3 cannot happen.
//   - A take-back needs an event in the stage (the void), and a played stage is locked: the division save refuses
//     DIVISION_FORMAT_LOCKED, the stage PUT STAGE_FORMAT_LOCKED, and the per-match writer FIXTURE_FORMAT_LOCKED on the
//     award itself (decided without play) - rule-locks.ts `lockedStageIdsAmong` reads PLAYED, and a double walkover or
//     a played semi is an event. So nothing moves what an excluded award resolves to between the pad's load and the
//     reopen: the cfg the pad folds IS the cfg the first event freezes.
//   - So a bump at the reopen would only refuse a pad that holds the right rules, and tell the scorer "the format
//     changed" over a line that did not. These tests pin that: the pad's first tap, sent under the version it loaded,
//     is TAKEN after each reopen, and freezes the cfg the pad folded. A bump added at any of the three UPDATEs reds them.
// If a future door can move a played stage's award (the planned bulk apply to unstarted matches), THAT door bumps the
// awards it moves; the guard to keep is that the pad's version and the cfg it folds never disagree.
describe.skipIf(!HAS_DB)("X-SR-7 a take-back that reopens an event-less award: the lock keeps the pad's version honest (batch-5 Q5)", () => {
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

  /** Every door that could move what the award resolves to refuses, and nothing moved. `perMatch: false` is the cascade
   *  void: it has no outcome, so the per-match writer is allowed on it (and bumps it itself - the last test below). */
  async function everyFormatDoorRefuses(b: Ko, awardId: string, perMatch = true) {
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
    await everyFormatDoorRefuses(b, finalId);
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
    await everyFormatDoorRefuses(b, finalId);
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
    await everyFormatDoorRefuses(b, semiId, false);
    await post(b.auth, qf1.id, "core.void", { event_id: k1.event_id });
    await post(b.auth, qf2.id, "core.void", { event_id: k2.event_id });
    expect((await fixtureRow(semiId)).status, "premise: the revive reopened the semi").toBe("scheduled");
    await winOut(b, qf1.id);
    await winOut(b, qf2.id);
    await padStillHonest(b, semiId, pad);
    reopened.push("abandoned revive");
  }, 120_000);

  it("the abandoned revive, the one door that is open: the per-match writer bumps the cascade void ITSELF, so the revive adds nothing and the stale pad is refused once", async () => {
    // A cascade void has no outcome, so `unfrozenRules` reads it (it is not decided without play) and the per-match writer
    // is not locked out of it: the one format door that reaches a reopenable shape, and it bumps in its own transaction.
    const b = await knockout(8);
    const qf1 = await fixtureRow(b.fixtureIds[0]!);
    const qf2 = siblingOf(await rowsOf(b.stageId), qf1);
    const semiId = qf1.winner_to_fixture!;
    const pad = await loadFixturePadCfg(b.auth, semiId);
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
    await expect(scoreEvent(b.auth, semiId, start(pad.rulesVersion))).rejects.toMatchObject({
      code: "FIXTURE_RULES_CHANGED",
      extra: { rules_version: pad.rulesVersion + 1, format: formatLine("badminton", now.cfg) },
    });
    await expect(scoreEvent(b.auth, semiId, start(now.rulesVersion))).resolves.toMatchObject({ seq: 1 });
    reopened.push("abandoned revive + per-match");
  }, 120_000);

  it("counted: all three reopening writes were driven, and the one open door", () => {
    expect(reopened).toEqual(["walkover revive", "reset", "abandoned revive", "abandoned revive + per-match"]);
  });
});
