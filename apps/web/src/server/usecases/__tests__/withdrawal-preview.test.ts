// W5 T8b Part 3 (X-WDT-10, owner ruling 289's condition) — the Disqualify confirmation's numbers are the cascade's numbers:
// `previewWithdrawal` reads the rows with the cascade's own reading and calls the cascade's own decision
// (`decideTableWithdrawal`), so what the organiser or the scorer is told before confirming — the matches taken out, her played
// count against her scheduled count, expunge or walkover — is what the cascade then writes. One decision, two readers.
//
// differential: today no preview exists (the confirmation says the per-format policy in general words, ruling 260).
//
// Driven through the real doors: the organiser's `patchEntrant {status: "disqualified"}` and the in-match forfeit through
// `scoreEvent` (Part 2's hook), read back from the division ledger's `table_withdrawal` row and the fixture rows; the pad's
// preview through the real fixture route with a real device link. Expected values from the rulebook: RB5-W2 (under half →
// expunge), RB5-W3 (half or more → walkover), RB5-W4 (a recorded result — a FINALIZED one included — is played; the match a
// disqualification is recorded in is played), the Swiss rule (always walkover), W4 (a bracket's own forfeit, no cascade).
// Single sport (generic): the decision is sport-blind (the policy counts involvement); the cascade's per-sport sweep is
// in-match-dq-cascade.test.ts and disqualify-cascade.test.ts.
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { sql } from "@/lib/db";
import { GET as fixturePreviewRoute } from "@/app/api/v1/fixtures/[id]/withdrawal-preview/route";
import type { AuthCtx } from "@/server/api-v1/auth";
import { post } from "@/server/engine-db/__tests__/helpers/w2b-rig";
import { createCompetition } from "../competitions";
import { createDeviceLink } from "../device-links";
import { createDivision } from "../divisions";
import { createEntrants, patchEntrant } from "../entrants";
import { startDivision } from "../schedule";
import { createStages, generateStageFixtures } from "../stages";
import { previewWithdrawal } from "../withdrawal-preview";
import { withdrawEntrantCascade } from "../withdrawal";
import { seedOrg } from "./_seed";

vi.stubEnv("DEVICE_LINK_KEK", randomBytes(32).toString("hex"));
const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  vi.unstubAllEnvs();
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

interface Line {
  id: string;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  status: string;
  round_no: number;
  outcome: { kind?: string; winner?: string; reason?: string } | null;
}
const linesOf = (stageId: string) =>
  sql<Line[]>`select id, home_entrant_id, away_entrant_id, status, round_no, outcome from fixtures where stage_id = ${stageId} order by round_no, seq_in_round, id`;
const involves = (l: Line, e: string) => l.home_entrant_id === e || l.away_entrant_id === e;
const otherSide = (l: Line, e: string) => (l.home_entrant_id === e ? l.away_entrant_id! : l.home_entrant_id!);
const ledgerRows = async (divisionId: string) =>
  (await sql<{ payload: { policy: string; played_at_departure: number; scheduled: number } }[]>`
    select payload from division_events where division_id = ${divisionId} and type = 'table_withdrawal' order by seq`).map((r) => [
    r.payload.policy,
    r.payload.played_at_departure,
    r.payload.scheduled,
  ]);
const hasActiveExpunge = async (fixtureId: string) => {
  const evs = await sql<{ id: string; type: string; payload: Record<string, unknown>; voids_event_id: string | null }[]>`
    select id, type, payload, voids_event_id from score_events where fixture_id = ${fixtureId} order by seq`;
  const voided = new Set(evs.filter((e) => e.voids_event_id !== null).map((e) => e.voids_event_id));
  return evs.some((e) => e.type === "core.abandon" && e.payload.expunge === true && !voided.has(e.id));
};

interface Rig { auth: AuthCtx; divisionId: string; stageId: string; ids: string[]; names: Map<string, string> }
async function started(n: number, kind: "league" | "swiss" | "knockout" = "league", opts: { start?: boolean } = {}): Promise<Rig> {
  const { auth } = await seedOrg("pro");
  const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "W5 T8b preview " + randomUUID().slice(0, 6), visibility: "private", branding: {} });
  const d = await createDivision(auth, comp.id, { name: "Open", slug: "o-" + randomUUID().slice(0, 6), sport_key: "generic", variant_key: "score", config: {} });
  const es = await createEntrants(
    auth,
    d.id,
    Array.from({ length: n }, (_, i) => ({ kind: "individual" as const, display_name: `P${i + 1}`, seed: i + 1, members: [] })),
  );
  const config = kind === "league" ? { legs: 1 } : kind === "swiss" ? { rounds: 3 } : {};
  const [stage] = await createStages(auth, d.id, { seq: 1, kind, name: "Stage", config, progression: null } as never);
  if (opts.start !== false) {
    await startDivision(auth, d.id);
    if (kind === "swiss") await generateStageFixtures(auth, stage!.id);
  }
  return { auth, divisionId: d.id, stageId: stage!.id, ids: es.map((e) => e.id), names: new Map(es.map((e) => [e.id, e.display_name])) };
}

/** `v` wins line `l`: a played result, signed off (finalized) — RB5-W4 counts a finalized result as played. */
async function finalizedWin(auth: AuthCtx, l: Line, v: string) {
  await post(auth, l.id, "core.start", {});
  await post(auth, l.id, "generic.result", l.home_entrant_id === v ? { p1Score: 3, p2Score: 0 } : { p1Score: 0, p2Score: 3 });
  const out = await post(auth, l.id, "core.finalize", {});
  expect(out.status, "rig: a finalized result").toBe("finalized");
}
const walkoverWin = async (auth: AuthCtx, l: Line, v: string) =>
  expect((await post(auth, l.id, "core.forfeit", { by: otherSide(l, v), reason: "walkover" })).status, "rig: an ordinary walkover").toBe("forfeited");

/** League of six (five lines each): P1 has played `k` (the first one finalized, the rest walkovers she won). */
async function playedK(k: number) {
  const r = await started(6);
  const v = r.ids[0]!;
  const mine = (await linesOf(r.stageId)).filter((l) => involves(l, v));
  expect(mine, "rig: five lines each").toHaveLength(5);
  for (const [i, l] of mine.slice(0, k).entries()) await (i === 0 ? finalizedWin(r.auth, l, v) : walkoverWin(r.auth, l, v));
  return { r, v, mine };
}

describe.skipIf(!HAS_DB)("X-WDT-10 the Disqualify confirmation's numbers are the cascade's numbers (ruling 289)", () => {
  for (const [k, policy, mode] of [
    [2, "expunge", "expunge"],
    [3, "walkover", "award"],
  ] as const) {
    it(`X-WDT-10 the Disqualify copy's numbers are the cascade's numbers — ${k} of 5 played, one of them finalized (${policy})`, async () => {
      const { r, v, mine } = await playedK(k);
      const pv = await previewWithdrawal(r.auth, v, "disqualified");
      expect([pv.cascade, pv.started, pv.name], "a started league, P1 in the field").toEqual([true, true, "P1"]);
      expect(pv.stages, "one stage").toHaveLength(1);
      const s = pv.stages[0]!;
      // The rulebook's answer (RB5-W2/W3 at k of 5) …
      expect([s.stage_kind, s.mode, s.played, s.scheduled, s.undo]).toEqual(["league", mode, k, 5, "restores"]);
      const open = mine.slice(k);
      expect(s.pending.map((p) => p.fixture_id).sort(), "the lines still to play").toEqual(open.map((l) => l.id).sort());
      expect(s.pending.map((p) => [p.fixture_id, p.opponent, p.round_no]).sort(), "each named by opponent and round").toEqual(
        open.map((l) => [l.id, r.names.get(otherSide(l, v)), l.round_no]).sort(),
      );

      // … and the cascade then acts on exactly that decision.
      await patchEntrant(r.auth, v, { status: "disqualified" });
      expect(await ledgerRows(r.divisionId), "the ledger row is the preview's count").toEqual([[policy, s.played, s.scheduled]]);
      const after = await linesOf(r.stageId);
      const touched: string[] = [];
      for (const l of after.filter((x) => open.some((o) => o.id === x.id))) {
        if (policy === "expunge") expect([l.status, await hasActiveExpunge(l.id)], "an open line voided").toEqual(["abandoned", true]);
        else expect(l.outcome, "an open line walked over").toMatchObject({ kind: "award", winner: otherSide(l, v), reason: "withdrew" });
        touched.push(l.id);
      }
      expect(touched.sort(), "the lines the cascade took out are the preview's list").toEqual(s.pending.map((p) => p.fixture_id).sort());
    }, 240_000);
  }

  it("X-WDT-10 the pad's preview counts the match the disqualification is recorded in as played — through the real fixture route and a real device link", async () => {
    const { r, v, mine } = await playedK(1);
    const line = mine[1]!;
    await post(r.auth, line.id, "core.start", {});
    // The court phone, as the pad's transport sends it.
    const [{ id: issuer }] = await sql<{ id: string }[]>`
      insert into users (email, display_name, email_verified) values (${`issuer-${randomUUID().slice(0, 8)}@test.local`}, 'Issuer', true) returning id`;
    await sql`insert into org_members (org_id, user_id, role) values (${r.auth.orgId}, ${issuer}, 'owner')`;
    const owner = { ...r.auth, via: "session" as const, userId: issuer, role: "owner" as const };
    const link = await createDeviceLink(owner, line.id, "Court phone");
    const ask = async (fixtureId: string, entrant: string, secret = link.secret) => {
      const res = await fixturePreviewRoute(
        new Request(`http://test.local/api/v1/fixtures/${fixtureId}/withdrawal-preview?entrant=${entrant}`, { headers: { authorization: `Bearer ${secret}` } }),
        { params: Promise.resolve({ id: fixtureId }) },
      );
      return { status: res.status, body: (await res.json()) as { ok: boolean; data?: Awaited<ReturnType<typeof previewWithdrawal>>; error?: { code: string } } };
    };
    const got = await ask(line.id, v);
    expect(got.status, JSON.stringify(got.body.error)).toBe(200);
    const s = got.body.data!.stages[0]!;
    // RB5-W4: 1 played + the match she is disqualified in = 2 of 5, under half.
    expect([s.mode, s.played, s.scheduled]).toEqual(["expunge", 2, 5]);
    const rest = mine.slice(2).map((l) => l.id).sort();
    expect(s.pending.map((p) => p.fixture_id).sort(), "the in-match line is not one of the remaining").toEqual(rest);

    // The doors: an entrant not on this fixture is not found; another fixture's link is refused.
    const stranger = r.ids.find((id) => !involves(line, id))!;
    expect((await ask(line.id, stranger)).status, "an entrant not on this fixture").toBe(404);
    // … not even one who has LEFT: the door answers 404 before it reads her (a cascade:false body would say she is gone).
    const leaver = r.ids.find((id) => id !== stranger && !involves(line, id))!;
    await patchEntrant(r.auth, leaver, { status: "withdrawn" });
    expect((await ask(line.id, leaver)).status, "a departed entrant elsewhere").toBe(404);
    expect((await ask(line.id, "not-a-uuid")).status, "a malformed id is not found, never a 500").toBe(404);
    const elsewhere = mine[2]!;
    expect((await ask(elsewhere.id, v)).status, "a link answers for its own fixture only").toBe(403);

    // The scorer then records the ending: the cascade's row is the pad's numbers.
    await post(r.auth, line.id, "core.forfeit", { by: v, reason: "disqualified" });
    expect(await ledgerRows(r.divisionId)).toEqual([["expunge", s.played, s.scheduled]]);
  }, 240_000);

  it("X-WDT-10 the empty case: a started entrant with no line (a reinstated arrival who waits) — no stages, then no table row", async () => {
    const r = await started(5, "league", { start: false });
    const gone = r.ids[4]!;
    await withdrawEntrantCascade(r.auth, gone); // before Start: the plain status flip
    await generateStageFixtures(r.auth, r.stageId); // the four still in the field
    await startDivision(r.auth, r.divisionId);
    const first = (await linesOf(r.stageId))[0]!;
    await post(r.auth, first.id, "core.start", {});
    const back = await patchEntrant(r.auth, gone, { status: "registered" });
    expect(back.late_entry?.case, "rig: she waits, with no line").toBe("waiting");
    const pv = await previewWithdrawal(r.auth, gone, "disqualified");
    expect([pv.cascade, pv.started, pv.stages]).toEqual([true, true, []]);
    await patchEntrant(r.auth, gone, { status: "disqualified" });
    expect(await ledgerRows(r.divisionId)).toEqual([]);
  }, 240_000);

  it("X-WDT-10 before Start: nothing is touched; an entrant already gone: no consequence", async () => {
    const r = await started(4, "league", { start: false });
    expect(await previewWithdrawal(r.auth, r.ids[0]!, "disqualified")).toMatchObject({ started: false, cascade: true, stages: [] });
    await patchEntrant(r.auth, r.ids[1]!, { status: "withdrawn" });
    expect(await previewWithdrawal(r.auth, r.ids[1]!, "disqualified")).toMatchObject({ cascade: false, stages: [] });
  }, 120_000);

  it("X-WDT-10 a Swiss: always the walkover, undone by rejoining; a knockout: a bracket walkover the organiser's Reinstate re-seats, and a disqualification IN a bracket match settles nothing more", async () => {
    const sw = await started(4, "swiss");
    const sv = (await linesOf(sw.stageId)).find((l) => l.home_entrant_id !== null && l.away_entrant_id !== null)!.home_entrant_id!;
    const swiss = (await previewWithdrawal(sw.auth, sv, "disqualified")).stages;
    expect(swiss.map((s) => [s.stage_kind, s.mode, s.played, s.scheduled, s.undo, s.pending.length])).toEqual([["swiss", "award", 0, 1, "rejoins", 1]]);

    const ko = await started(4, "knockout");
    const line = (await linesOf(ko.stageId)).find((l) => l.home_entrant_id !== null && l.away_entrant_id !== null)!;
    const kv = line.home_entrant_id!;
    const bracket = (await previewWithdrawal(ko.auth, kv, "disqualified")).stages;
    expect(bracket.map((s) => [s.stage_kind, s.mode, s.undo, s.pending.map((p) => p.fixture_id)])).toEqual([["knockout", "bracket_walkover", "waits", [line.id]]]);
    expect(await previewWithdrawal(ko.auth, kv, "disqualified", { fixtureId: line.id }), "W4: the bracket's own forfeit").toMatchObject({ cascade: false });
  }, 240_000);
});
