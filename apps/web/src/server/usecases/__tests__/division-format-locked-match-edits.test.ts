// Final review M2: DIVISION_FORMAT_LOCKED's sentence sends the organiser to "change individual unstarted matches" - advice
// only a stage whose matches can take a format of their own can follow. Whether they can is the SPORT's declaration for
// that stage (`fixtureKeysFor`: its match-scope keys), never a sport list typed into the product: a stage with none (chess
// today) gets the sentence without the advice, and the 409 says which (`extra.match_edits`) so a client words it the same
// way in the reader's language (`ruleRefusalText`).
//
// Two branches, two sports by construction: chess is the sport with no match-scope key (asserted from the declaration
// below), badminton one with them. Expected sentences come from the dictionaries, never from the reader under test.
// Real Postgres required; skipped without DATABASE_URL.
import { afterAll, describe, expect, it } from "vitest";
import { fixtureKeysFor } from "@seazn/engine/sport";
import type { StageKind } from "@seazn/engine/core";
import { builtinModules } from "@seazn/engine/sports";
import { sql } from "@/lib/db";
import { msg as msgEn } from "@/lib/messages";
import { ruleRefusalText } from "@/lib/rule-errors";
import en from "@/dictionaries/en/ui.json";
import es from "@/dictionaries/es/ui.json";
import type { AuthCtx } from "@/server/api-v1/auth";
import { seedBracket } from "@/server/engine-db/__tests__/helpers/seed-bracket";
import { patchDivision } from "../divisions";
import { scoreEvent } from "../scoring";
import { seedOnlineChessFixture } from "./_external-play-seed";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

const EN = en as unknown as Record<string, string>;
const ES = es as unknown as Record<string, string>;
const fill = (dict: Record<string, string>) => (key: string, vars: Record<string, string | number> = {}) =>
  dict[key]!.replace(/\{(\w+)\}/g, (h, name: string) => (name in vars ? String(vars[name]) : h));
const sayEn = fill(EN);
const sayEs = fill(ES);
const WITH_ADVICE = "rules.err.divisionFormatLocked";
const WITHOUT_ADVICE = "rules.err.divisionFormatLockedNoMatchEdits";

const moduleOf = (key: string) => builtinModules.find((m) => m.key === key)!;
async function stageOf(stageId: string) {
  const [row] = await sql<{ name: string; kind: StageKind; variant_key: string }[]>`
    select s.name, s.kind, d.variant_key from stages s join divisions d on d.id = s.division_id where s.id = ${stageId}`;
  return row!;
}
const refusalOf = (p: Promise<unknown>) =>
  p.then(
    () => {
      throw new Error("expected a refusal");
    },
    (e: unknown) => e as { status: number; code: string; message: string; extra: Record<string, unknown> },
  );

describe.skipIf(!HAS_DB)("final review M2: the format-lock sentence advises match edits only where a match can take a format", () => {
  it("premise: the dictionaries carry both sentences, and only one of them gives the advice", () => {
    expect(EN[WITH_ADVICE]).not.toBe(EN[WITHOUT_ADVICE]);
    expect(EN[WITH_ADVICE]!.startsWith(EN[WITHOUT_ADVICE]!.replace(/\.$/, "")), "the short sentence is the long one, cut").toBe(true);
    expect(ES[WITH_ADVICE]).not.toBe(ES[WITHOUT_ADVICE]);
  });

  it("chess (no match-scope key): an opened Lichess round's clock lock is 409 without the advice, match_edits false - twice", async () => {
    const s = await seedOnlineChessFixture({
      onlinePlay: "lichess",
      divisionStarted: true,
      scheduledAt: new Date("2026-10-01T12:10:00.000Z"),
      linked: false,
      clock: { base: 600, increment: 5 },
      roundOpenedAt: new Date("2026-10-01T12:00:00.000Z"),
    });
    const auth = { orgId: s.orgId, via: "session", userId: s.ownerUserId, role: "owner", keyId: null } as AuthCtx;
    const stage = await stageOf(s.stageId);
    expect(fixtureKeysFor(moduleOf("boardgame"), stage.kind, stage.variant_key), "premise: chess declares no match-scope key here").toEqual([]);
    const [div] = await sql<{ config: Record<string, unknown> }[]>`select config from divisions where id = ${s.divisionId}`;
    for (const call of ["first", "second"]) {
      const err = await refusalOf(patchDivision(auth, s.divisionId, { config: { ...div!.config, clock: { base: 900, increment: 10 } } }));
      expect(err, call).toMatchObject({ status: 409, code: "DIVISION_FORMAT_LOCKED", extra: { match_edits: false } });
      expect(err.message, `${call}: the server's English, without the advice`).toBe(sayEn(WITHOUT_ADVICE, { stage: stage.name }));
      expect(ruleRefusalText(err.code, err.extra, msgEn), `${call}: the client's English is the server's`).toBe(err.message);
      expect(ruleRefusalText(err.code, err.extra, sayEs as never), `${call}: and in Spanish, without it too`).toBe(sayEs(WITHOUT_ADVICE, { stage: stage.name }));
    }
  }, 60_000);

  it("badminton (match-scope keys): a played league's bestOf lock is 409 WITH the advice, match_edits true", async () => {
    const b = await seedBracket({ sport: "badminton", variant: "short", stageKind: "league", entrants: 3 });
    const stage = await stageOf(b.stageId);
    expect(fixtureKeysFor(moduleOf("badminton"), stage.kind, stage.variant_key).length, "premise: a badminton match can take its own format").toBeGreaterThan(0);
    await scoreEvent(b.auth, b.fixtureIds[0]!, { expected_seq: 0, type: "core.start", payload: {} });
    const [div] = await sql<{ config: { bestOf?: number } }[]>`select config from divisions where id = ${b.divisionId}`;
    const err = await refusalOf(patchDivision(b.auth, b.divisionId, { config: { bestOf: div!.config.bestOf === 5 ? 3 : 5 } } as never));
    expect(err).toMatchObject({ status: 409, code: "DIVISION_FORMAT_LOCKED", extra: { match_edits: true } });
    expect(err.message).toBe(sayEn(WITH_ADVICE, { stage: stage.name }));
    expect(ruleRefusalText(err.code, err.extra, msgEn)).toBe(err.message);
    expect(ruleRefusalText(err.code, err.extra, sayEs as never)).toBe(sayEs(WITH_ADVICE, { stage: stage.name }));
    // An older server's 409 (no match_edits) reads as before: with the advice.
    const older = Object.fromEntries(Object.entries(err.extra).filter(([k]) => k !== "match_edits"));
    expect(older, "premise: the older body still names the stage").toHaveProperty("refused");
    expect(ruleRefusalText(err.code, older, msgEn)).toBe(err.message);
  }, 60_000);
});
