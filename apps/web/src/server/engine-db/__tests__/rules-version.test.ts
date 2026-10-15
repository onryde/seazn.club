// W2c Task 15 (X-SR-7, owner P-1 "A", D14) — a tap sent under old rules is never applied under new ones.
//
// `fixtures.rules_version` counts the corrections of a match's format: a started match's re-freeze (`refreezeFixture`),
// and since fix round 1 (I-1) any write that moves what an unstarted match resolves to (`rules-version-prekickoff.test.ts`
// drives those). A scoring pad sends the version it loaded with every append; the append path refuses a sent version that differs from
// the row's (≠, not <) with 409 FIXTURE_RULES_CHANGED BEFORE any insert, and every accepted answer carries the row's
// version. An append WITHOUT the field is never checked (the console chrome, the server's own writers: P-1).
//
// Every expectation is read off the declarations — the version off `loadFixturePadCfg` (the pad's own read), the
// refusal's sentence off the en dictionary, its format line off the public describer and the en public dictionary —
// never off the code under test.
//
// Real Postgres; skipped without DATABASE_URL.
import { afterAll, describe, expect, it } from "vitest";
import { builtinModules } from "@seazn/engine/sports";
import type { AnySportModule } from "@seazn/engine/sport";
import enPublic from "@/dictionaries/en/public.json";
import enUi from "@/dictionaries/en/ui.json";
import es from "@/dictionaries/es/public.json";
import { sql } from "@/lib/db";
import type { Dict } from "@/lib/i18n-constants";
import { rulesLineText } from "@/lib/rules-line";
import { describeMatchRules } from "@/server/public-site/describe-rules";
import { scoreEvent } from "@/server/usecases/scoring";
import { writeFixtureRulesOverride } from "@/server/usecases/fixture-rules";
import { getFixtureRules, loadFixturePadCfg } from "@/server/usecases/fixtures";
import { seedBracket } from "./helpers/seed-bracket";

const HAS_DB = !!process.env.DATABASE_URL;
afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

const count = async (id: string) =>
  (await sql<{ n: number }[]>`select count(*)::int n from score_events where fixture_id = ${id}`)[0]!.n;

const moduleOf = (key: string): AnySportModule => {
  const m = builtinModules.find((x) => x.key === key);
  if (m === undefined) throw new Error(`no sport ${key}`);
  return m as AnySportModule;
};

/** The match's format as the public describer says it, in `dict` — null when the describer has nothing to say. */
const formatLine = (sport: string, cfg: unknown, dict: Dict): string | null => {
  const line = describeMatchRules(sport, moduleOf(sport), cfg);
  return line === null ? null : rulesLineText(dict, line);
};

const EN_UI = enUi as unknown as Record<string, string>;
/** The refusal's en sentence, read off the dictionary (the server's English IS the en dictionary). */
const refusalSentence = (format: string | null) =>
  format === null
    ? EN_UI["rules.err.fixtureRulesChangedNoLine"]!
    : EN_UI["rules.err.fixtureRulesChanged"]!.replace("{format}", format);

async function liveBadminton() {
  // single-sport: badminton `short` is the brief's P5 rig (bestOf moves 3 -> 5, a headline the pad shows); football is
  // the "another sport" case below.
  const b = await seedBracket({ sport: "badminton", variant: "short", stageKind: "league", entrants: 2 });
  const id = b.fixtureIds[0]!;
  const started = await scoreEvent(b.auth, id, { expected_seq: 0, type: "core.start", payload: {} });
  return { b, id, startId: started.event_id };
}
/** Every `core.void` through `scoreEvent` names its target as `payload: {event_id}` (scoring.ts maps it to `voids`). */
const voidOf = (startId: string) => ({ type: "core.void", payload: { event_id: startId } });

describe.skipIf(!HAS_DB)("X-SR-7 a tap sent under old rules is never applied under new ones", () => {
  it("the empty case: version 0 with no correction is accepted, and the response carries 0", async () => {
    const { b, id, startId } = await liveBadminton();
    expect((await loadFixturePadCfg(b.auth, id)).rulesVersion).toBe(0);
    await expect(scoreEvent(b.auth, id, { expected_seq: 1, ...voidOf(startId), rules_version: 0 })).resolves.toMatchObject({
      rules_version: 0,
    });
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int n from score_events where fixture_id = ${id} and voids_event_id = ${startId}`;
    expect(n, "the void landed (not UNDO_NOOP)").toBe(1);
  });

  it("a second device that loaded before the first event (version 0) is accepted after a normal first freeze", async () => {
    const { b, id, startId } = await liveBadminton(); // device A started the match; device B loaded at version 0 before it
    await expect(scoreEvent(b.auth, id, { expected_seq: 1, ...voidOf(startId), rules_version: 0 })).resolves.toMatchObject({
      rules_version: 0,
    });
  });

  it("after a correction: a stale version is refused FIXTURE_RULES_CHANGED and NO event is written; the current version is accepted", async () => {
    const { b, id, startId } = await liveBadminton();
    const stale = (await loadFixturePadCfg(b.auth, id)).rulesVersion;
    await writeFixtureRulesOverride(b.auth, [id], { bestOf: 5 });
    const before = await count(id);
    const corrected = (await loadFixturePadCfg(b.auth, id)).cfg;
    expect((corrected as { bestOf: number }).bestOf, "premise: the correction moved the format").toBe(5);
    const format = formatLine("badminton", corrected, enPublic as unknown as Dict);
    expect(format, "premise: badminton's format line says the corrected format").not.toBeNull();

    const err = await scoreEvent(b.auth, id, { expected_seq: 1, ...voidOf(startId), rules_version: stale }).catch((e: unknown) => e);
    expect(err).toMatchObject({
      status: 409,
      code: "FIXTURE_RULES_CHANGED",
      extra: { rules_version: stale + 1, format },
      message: refusalSentence(format),
    });
    expect(await count(id), "nothing was written").toBe(before);

    const fresh = (await loadFixturePadCfg(b.auth, id)).rulesVersion;
    expect(fresh).toBe(stale + 1);
    await expect(scoreEvent(b.auth, id, { expected_seq: 1, ...voidOf(startId), rules_version: fresh })).resolves.toMatchObject({
      rules_version: fresh,
    });
    expect(await count(id), "the current version lands").toBe(before + 1);
  });

  it("the version is checked BEFORE the seq: a stale queued tap behind a stale seq is refused for the rules, not left to renegotiate", async () => {
    const { b, id, startId } = await liveBadminton();
    await writeFixtureRulesOverride(b.auth, [id], { bestOf: 5 });
    const before = await count(id);
    // expected_seq 0 is stale (the ledger is at 1): a SEQ_CONFLICT would send the pad's queue into renegotiation and a
    // resend under the new rules — the thing X-SR-7 forbids.
    await expect(scoreEvent(b.auth, id, { expected_seq: 0, ...voidOf(startId), rules_version: 0 })).rejects.toMatchObject({
      code: "FIXTURE_RULES_CHANGED",
    });
    expect(await count(id)).toBe(before);
  });

  it("an idempotent retry of a tap the ledger recorded BEFORE the correction gets its original answer, and writes nothing", async () => {
    // A game, not a void: a void's retry meets `assertUndoTarget` (its target is already struck) before the append path
    // is reached at all, which is the undo path's own business and not this check's.
    const { b, id } = await liveBadminton();
    const key = `t15-${id}`;
    const game = { type: "badminton.game.summary", payload: { home: 11, away: 5 } };
    const first = await scoreEvent(b.auth, id, { expected_seq: 1, ...game, rules_version: 0, idempotency_key: key });
    await writeFixtureRulesOverride(b.auth, [id], { bestOf: 5 }); // 1-0 in games fits best of five
    const before = await count(id);
    // The response was lost; the pad retries the same key at the same seq and version.
    const retry = await scoreEvent(b.auth, id, { expected_seq: 1, ...game, rules_version: 0, idempotency_key: key });
    expect(retry.event_id, "the original row, not a refusal of a write that already landed").toBe(first.event_id);
    expect(retry.seq).toBe(first.seq);
    expect(retry.rules_version, "the answer tells the pad the rules moved").toBe(1);
    expect(await count(id)).toBe(before);
  });

  it("fix round 1 (M-6): a retry of a tap the correction REFUSED — its key never recorded — is refused again and writes nothing", async () => {
    // The other half of the replay above: the refusal's catch looks the key up (`scoring.ts`), and a key the ledger does
    // not hold must never be answered as if it did.
    const { b, id } = await liveBadminton();
    await writeFixtureRulesOverride(b.auth, [id], { bestOf: 5 });
    const key = `t15-unrecorded-${id}`;
    const game = { type: "badminton.game.summary", payload: { home: 11, away: 5 } };
    const before = await count(id);
    let attempts = 0;
    for (const attempt of ["first", "retry"]) {
      await expect(scoreEvent(b.auth, id, { expected_seq: 1, ...game, rules_version: 0, idempotency_key: key }), attempt).rejects.toMatchObject({
        code: "FIXTURE_RULES_CHANGED",
        extra: { rules_version: 1 },
      });
      attempts++;
    }
    expect(attempts).toBe(2);
    expect(await count(id)).toBe(before);
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int n from score_events where idempotency_key = ${key}`;
    expect(n, "the key was never recorded").toBe(0);
  });

  it("after a correction: an append WITHOUT the field is never checked (P-1)", async () => {
    const { b, id, startId } = await liveBadminton();
    await writeFixtureRulesOverride(b.auth, [id], { bestOf: 5 });
    await expect(scoreEvent(b.auth, id, { expected_seq: 1, ...voidOf(startId) })).resolves.toMatchObject({ rules_version: 1 });
  });

  it("a version from the future is refused too (≠, not <)", async () => {
    const { b, id, startId } = await liveBadminton();
    const before = await count(id);
    await expect(scoreEvent(b.auth, id, { expected_seq: 1, ...voidOf(startId), rules_version: 7 })).rejects.toMatchObject({
      code: "FIXTURE_RULES_CHANGED",
      extra: { rules_version: 0 },
    });
    expect(await count(id)).toBe(before);
  });

  it("another sport (football): the same refusal, its format line whatever the describer says of it", async () => {
    const b = await seedBracket({ sport: "football", variant: "11-a-side", stageKind: "league", entrants: 2 });
    const id = b.fixtureIds[0]!;
    await scoreEvent(b.auth, id, { expected_seq: 0, type: "core.start", payload: {} });
    await writeFixtureRulesOverride(b.auth, [id], { halfMinutes: 40 });
    const corrected = (await loadFixturePadCfg(b.auth, id)).cfg;
    expect((corrected as { halfMinutes: number }).halfMinutes, "premise: the correction moved the format").toBe(40);
    const format = formatLine("football", corrected, enPublic as unknown as Dict);
    const before = await count(id);
    await expect(
      scoreEvent(b.auth, id, { expected_seq: 1, type: "football.period", payload: { phase: "HT" }, rules_version: 0 }),
    ).rejects.toMatchObject({ code: "FIXTURE_RULES_CHANGED", extra: { rules_version: 1, format }, message: refusalSentence(format) });
    expect(await count(id)).toBe(before);
  });
});

describe.skipIf(!HAS_DB)("X-SR-7 GET /fixtures/{id}/rules — what an open pad reloads", () => {
  it("before and after a correction: the cfg the fold uses, the version, and the format line in the READER's language", async () => {
    const { b, id } = await liveBadminton();
    const esDict = es as unknown as Dict;
    const before = await getFixtureRules(b.auth, id, esDict);
    const pad = await loadFixturePadCfg(b.auth, id);
    expect(before).toEqual({ cfg: pad.cfg, rules_version: 0, format_line: formatLine("badminton", pad.cfg, esDict) });

    await writeFixtureRulesOverride(b.auth, [id], { bestOf: 5 });
    const after = await getFixtureRules(b.auth, id, esDict);
    const corrected = await loadFixturePadCfg(b.auth, id);
    expect(after.rules_version).toBe(1);
    expect(after.cfg).toEqual(corrected.cfg);
    expect((after.cfg as { bestOf: number }).bestOf).toBe(5);
    const esLine = formatLine("badminton", corrected.cfg, esDict);
    expect(after.format_line).toBe(esLine);
    expect(esLine, "the reader's language, not the server's English").not.toBe(
      formatLine("badminton", corrected.cfg, enPublic as unknown as Dict),
    );
  });
});
