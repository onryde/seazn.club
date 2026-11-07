// Open a match through a Match Day code (capture S4 design §3, §6, §9.4; MD-1 Task 4): the match's OWN sealed scoring link —
// the printed QR's, never a second one, and nothing revoked — for a match the code covers at the moment of asking (Review
// Focus 2); "finished" for a finalized or cancelled match, never a fresh mint (Review Focus 3); one use row per open. Plus the
// route (`POST /api/v1/match-day-code/fixtures/{id}/scoring-link`) against its contract twin, and the batch 1 review's m6: a
// Match Day code's actor is refused every organiser and finalize gate a device link is refused (spec §3: a code never
// finalizes). Real Postgres required; skipped without DATABASE_URL.
//
// One sport on purpose: the open reads no sport — it copies the division's `sport_key` into the answer.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, randomBytes, randomUUID } from "node:crypto";

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
  headers: async () => new Headers(),
}));

import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import type { AuthCtx } from "@/server/api-v1/auth";
import { CaptureMatchdayOpen, CaptureMatchdayRefusal } from "@/server/api-v1/capture-schemas";
import { matchDayActor, mintMatchDayCode, revokeMatchDayCode, type MatchDayCodeRow, type MatchDayScope } from "../match-day-codes";
import { openMatchForCode } from "../match-day-code-open";
import { ensureDeviceLink } from "../device-links";
import { getFixture } from "../fixtures";
import { scoreEvent } from "../scoring";
import { at, place, seedCompetition, seedDay, setStatus, T0, type Day } from "./_match-day-seed";
import { POST } from "@/app/api/v1/match-day-code/fixtures/[id]/scoring-link/route";

vi.stubEnv("DEVICE_LINK_KEK", randomBytes(32).toString("hex"));
vi.stubEnv("OAUTH_BASE_URL", "https://md.test.seazn.club");

const HAS_DB = !!process.env.DATABASE_URL;
const NOW = at(30);
const LINK_RE = /^https:\/\/md\.test\.seazn\.club\/score\/(dl_[A-Za-z0-9_-]{43})$/;
const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");
const tokenOf = (url: string): string => url.slice(url.lastIndexOf("/") + 1);

afterAll(async () => {
  vi.unstubAllEnvs();
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

async function codeFor(day: Day, scope: MatchDayScope): Promise<{ code: MatchDayCodeRow; token: string }> {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date(T0) });
  try {
    const { row, url } = await mintMatchDayCode(day.auth, day.comp.id, { scope, day: "2026-11-07", canApprove: false });
    return { code: row, token: tokenOf(url) };
  } finally {
    vi.useRealTimers();
  }
}

type Link = { id: string; token_hash: string; issued_by: string; revoked_at: Date | null };
const linksOf = (fixtureId: string): Promise<Link[]> =>
  sql<Link[]>`select id, token_hash, issued_by, revoked_at from device_links where fixture_id = ${fixtureId} order by created_at`;
const usesOf = (codeId: string): Promise<{ kind: string; fixture_id: string | null }[]> =>
  sql`select kind, fixture_id from match_day_code_uses where code_id = ${codeId} order by id`;

describe.skipIf(!HAS_DB)("open a match through a Match Day code", () => {
  let day: Day;
  /** f0 planned on Court 1 (Hall A) at 11:00; f1 on Court 3 (Hall B) at 11:30; f2 ready with no court; f3 on Court 2
   *  TOMORROW; f4 finished on Court 1 today; f5 on Court 1 at 12:00. */
  let f: string[];
  beforeEach(async () => {
    day = await seedDay();
    f = day.comp.fixtures.map((x) => x.id);
    const { c1, c2, c3 } = day.courts;
    await place(day, f[0]!, 60, c1);
    await place(day, f[1]!, 90, c3);
    await place(day, f[2]!, null, null);
    await place(day, f[3]!, 24 * 60, c2);
    await place(day, f[4]!, -60, c1);
    await setStatus(f[4]!, "decided");
    await place(day, f[5]!, 120, c1);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("opens an in-scope match and returns its sealed /score/dl_ link", async () => {
    const { code } = await codeFor(day, { kind: "competition" });
    const got = await openMatchForCode(code, f[0]!, NOW);
    expect(got.kind).toBe("link");
    if (got.kind !== "link") return;
    expect(got.sport_key).toBe("generic");
    const secret = LINK_RE.exec(got.url)?.[1];
    expect(secret, "the url is the scoring pad's: the https origin, /score/, a dl_ secret").toBeDefined();
    const links = await linksOf(f[0]!);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ token_hash: sha256(secret!), issued_by: code.issuedBy, revoked_at: null });
    // A held (decided) match still opens: only finalized or cancelled is over (the device links' own rule).
    expect((await openMatchForCode(code, f[4]!, NOW)).kind).toBe("link");
  });

  it("a second open returns the same link and revokes nothing: the printed QR's link is still live", async () => {
    // The printed QR: the console's ensure, before any phone asks.
    const printed = await ensureDeviceLink(day.auth, f[0]!);
    const { code } = await codeFor(day, { kind: "competition" });
    const first = await openMatchForCode(code, f[0]!, NOW);
    const second = await openMatchForCode(code, f[0]!, NOW);
    expect(first).toEqual({ kind: "link", url: `https://md.test.seazn.club/score/${printed.secret}`, sport_key: "generic" });
    expect(second).toEqual(first);
    const links = await linksOf(f[0]!);
    expect(links.map((l) => [l.id, l.revoked_at])).toEqual([[printed.row.id, null]]);
    // A match with no link yet: the first open mints ONE, the second re-shows it.
    const a = await openMatchForCode(code, f[5]!, NOW);
    const b = await openMatchForCode(code, f[5]!, NOW);
    expect(b).toEqual(a);
    expect(await linksOf(f[5]!)).toHaveLength(1);
  });

  it("a match moved off a courts code's courts is MD_OUT_OF_SCOPE (Review Focus 2)", async () => {
    const { code } = await codeFor(day, { kind: "courts", courtIds: [day.courts.c3] });
    expect((await openMatchForCode(code, f[1]!, NOW)).kind).toBe("link");
    const before = await linksOf(f[1]!);
    await place(day, f[1]!, 90, day.courts.c2);
    expect(await openMatchForCode(code, f[1]!, NOW)).toEqual({ kind: "refused", code: "MD_OUT_OF_SCOPE" });
    expect(await linksOf(f[1]!)).toEqual(before);
    // A courts code never reaches another court's match, today or not.
    expect(await openMatchForCode(code, f[0]!, NOW)).toEqual({ kind: "refused", code: "MD_OUT_OF_SCOPE" });
    expect(await linksOf(f[0]!)).toEqual([]);
  });

  it("a no-court match is MD_OUT_OF_SCOPE for a venue code", async () => {
    const venue = (await codeFor(day, { kind: "venue", venueId: day.venues.hallA })).code;
    expect(await openMatchForCode(venue, f[2]!, NOW)).toEqual({ kind: "refused", code: "MD_OUT_OF_SCOPE" });
    // The venue's own court opens; another venue's court does not.
    expect((await openMatchForCode(venue, f[0]!, NOW)).kind).toBe("link");
    expect(await openMatchForCode(venue, f[1]!, NOW)).toEqual({ kind: "refused", code: "MD_OUT_OF_SCOPE" });
    // A whole-competition code covers the match with no court.
    const whole = (await codeFor(day, { kind: "competition" })).code;
    expect((await openMatchForCode(whole, f[2]!, NOW)).kind).toBe("link");
    expect(await linksOf(f[1]!)).toEqual([]);
  });

  it("a no-court match the list does not show is MD_OUT_OF_SCOPE, even for a whole-competition code (fix I1)", async () => {
    const { code } = await codeFor(day, { kind: "competition" });
    const refused = { kind: "refused", code: "MD_OUT_OF_SCOPE" };
    // The premise: f2 is the desk's "no court yet" (ready, active stage, both seats, live division), and it opens.
    expect((await openMatchForCode(code, f[1]!, NOW)).kind).toBe("link");
    await place(day, f[1]!, null, null);
    expect((await openMatchForCode(code, f[1]!, NOW)).kind).toBe("link");
    // An undecided seat (a later knockout round): not listed, so not opened.
    await sql`update fixtures set home_entrant_id = null where id = ${f[2]!}`;
    expect(await openMatchForCode(code, f[2]!, NOW)).toEqual(refused);
    // A stage not yet started.
    await place(day, f[5]!, null, null);
    await sql`update stages set status = 'pending' where id = ${day.comp.stageId}`;
    expect(await openMatchForCode(code, f[5]!, NOW)).toEqual(refused);
    await sql`update stages set status = 'active' where id = ${day.comp.stageId}`;
    expect((await openMatchForCode(code, f[5]!, NOW)).kind, "the premise: the stage was the only bar").toBe("link");
    // An archived division: the same match, refused once its division is archived.
    const before = (await linksOf(f[5]!)).length;
    await sql`update divisions set archived_at = now() where id = ${day.comp.divisionId}`;
    expect(await openMatchForCode(code, f[5]!, NOW)).toEqual(refused);
    // In play with no court, in an archived division: not on the desk's list either.
    await setStatus(f[1]!, "in_play");
    expect(await openMatchForCode(code, f[1]!, NOW)).toEqual(refused);
    expect(await linksOf(f[2]!)).toEqual([]);
    expect(await linksOf(f[5]!)).toHaveLength(before);
  });

  it("the use row is written in the link's own transaction: a use that cannot be logged hands out no link (fix M4)", async () => {
    const { code } = await codeFor(day, { kind: "competition" });
    await openMatchForCode(code, f[0]!, NOW);
    expect(await usesOf(code.id)).toEqual([{ kind: "open", fixture_id: f[0] }]);
    // The code's row gone under the open (its use log cascades with it): the use insert breaks its foreign key, and the
    // link minted in the same transaction rolls back with it.
    await sql`delete from match_day_codes where id = ${code.id}`;
    await expect(openMatchForCode(code, f[5]!, NOW)).rejects.toMatchObject({ code: "23503" });
    expect(await linksOf(f[5]!)).toEqual([]);
  });

  it("a finalized match is {kind:\"finished\"} (Review Focus 3), and so is a cancelled one: nothing minted", async () => {
    const { code } = await codeFor(day, { kind: "competition" });
    await setStatus(f[4]!, "finalized");
    expect(await openMatchForCode(code, f[4]!, NOW)).toEqual({ kind: "finished" });
    await setStatus(f[5]!, "cancelled");
    expect(await openMatchForCode(code, f[5]!, NOW)).toEqual({ kind: "finished" });
    expect(await linksOf(f[4]!)).toEqual([]);
    expect(await linksOf(f[5]!)).toEqual([]);
    // A printed link on a finalized match is left as it was: never revoked, never re-shown.
    await setStatus(f[0]!, "in_play");
    const printed = await ensureDeviceLink(day.auth, f[0]!);
    await setStatus(f[0]!, "finalized");
    expect(await openMatchForCode(code, f[0]!, NOW)).toEqual({ kind: "finished" });
    expect((await linksOf(f[0]!)).map((l) => [l.id, l.revoked_at])).toEqual([[printed.row.id, null]]);
  });

  it("another day's match is MD_OUT_OF_SCOPE", async () => {
    const { code } = await codeFor(day, { kind: "competition" });
    expect(await openMatchForCode(code, f[3]!, NOW)).toEqual({ kind: "refused", code: "MD_OUT_OF_SCOPE" });
    // Yesterday's, unplayed, on a court: not today's either.
    await place(day, f[5]!, -24 * 60, day.courts.c1);
    expect(await openMatchForCode(code, f[5]!, NOW)).toEqual({ kind: "refused", code: "MD_OUT_OF_SCOPE" });
    // In play, whatever its plan: a match being played is today's.
    await setStatus(f[5]!, "in_play");
    expect((await openMatchForCode(code, f[5]!, NOW)).kind).toBe("link");
    expect(await linksOf(f[3]!)).toEqual([]);
  });

  it("another competition's match is MD_OUT_OF_SCOPE, and an unknown match is 404", async () => {
    const other = await seedCompetition(day.auth, "Other Open", [[day.people[0]!], [day.people[1]!]], { courts: [day.courts.c1] });
    await place(day, other.fixtures[0]!.id, 60, day.courts.c1);
    const { code } = await codeFor(day, { kind: "competition" });
    expect(await openMatchForCode(code, other.fixtures[0]!.id, NOW)).toEqual({ kind: "refused", code: "MD_OUT_OF_SCOPE" });
    await expect(openMatchForCode(code, randomUUID(), NOW)).rejects.toMatchObject({ status: 404 });
    await expect(openMatchForCode(code, "not-a-uuid", NOW)).rejects.toMatchObject({ status: 404 });
  });

  it("each open writes one match_day_code_uses row", async () => {
    const { code } = await codeFor(day, { kind: "venue", venueId: day.venues.hallA });
    await openMatchForCode(code, f[0]!, NOW);
    await openMatchForCode(code, f[0]!, NOW);
    await openMatchForCode(code, f[5]!, NOW);
    // A refusal and a finished match open nothing, so they log nothing.
    await openMatchForCode(code, f[1]!, NOW);
    await setStatus(f[4]!, "finalized");
    await openMatchForCode(code, f[4]!, NOW);
    expect(await usesOf(code.id)).toEqual([
      { kind: "open", fixture_id: f[0] },
      { kind: "open", fixture_id: f[0] },
      { kind: "open", fixture_id: f[5] },
    ]);
  });

  describe("POST /api/v1/match-day-code/fixtures/{id}/scoring-link", () => {
    const post = (bearer: string | null, fixtureId: string): Promise<Response> =>
      POST(
        new Request(`https://test.local/api/v1/match-day-code/fixtures/${fixtureId}/scoring-link`, {
          method: "POST",
          headers: bearer === null ? {} : { authorization: `Bearer ${bearer}` },
        }),
        { params: Promise.resolve({ id: fixtureId }) },
      );

    it("the answer validates against capture-matchday-open.v1.json", async () => {
      const { code, token } = await codeFor(day, { kind: "venue", venueId: day.venues.hallA });
      vi.useFakeTimers({ toFake: ["Date"], now: NOW });
      const ok = await post(token, f[0]!);
      expect(ok.status).toBe(200);
      expect(ok.headers.get("cache-control")).toBe("no-store");
      const link = (await ok.json()).data;
      expect(CaptureMatchdayOpen.safeParse(link).success).toBe(true);
      expect(link).toMatchObject({ kind: "link", sport_key: "generic" });
      await setStatus(f[4]!, "finalized");
      const done = await post(token, f[4]!);
      expect(done.status).toBe(200);
      const finished = (await done.json()).data;
      expect(finished).toEqual({ kind: "finished" });
      expect(CaptureMatchdayOpen.safeParse(finished).success).toBe(true);
      const out = await post(token, f[1]!);
      expect(out.status).toBe(403);
      const refusal = (await out.json()).error;
      expect(refusal.code).toBe("MD_OUT_OF_SCOPE");
      expect(CaptureMatchdayRefusal.safeParse(refusal).success).toBe(true);
      expect((await post(token, randomUUID())).status).toBe(404);
      expect((await post(null, f[0]!)).status).toBe(401);
      await revokeMatchDayCode(day.auth, code.id);
      const gone = await post(token, f[0]!);
      expect(gone.status).toBe(410);
      expect((await gone.json()).error.code).toBe("MD_WITHDRAWN");
      // The token never comes back on the wire, in any answer.
      expect(JSON.stringify([link, finished, refusal])).not.toContain(token);
    });
  });

  describe("a Match Day code never finalizes (batch 1 review m6; spec §3)", () => {
    /** The refusal as `status words`; a non-HTTP error is rethrown, so a refusal from anywhere but a gate fails loudly. */
    const refusedWith = async (p: Promise<unknown>): Promise<string> => {
      try {
        await p;
      } catch (e) {
        if (e instanceof HttpError) return `${e.status} ${e.message}`;
        throw e;
      }
      return "allowed";
    };

    beforeEach(async () => {
      // Scoring is open (the division started), and the division lets a SCORER finalize: only the actor's kind stands in
      // the way.
      await sql`update divisions set status = 'active', scorer_can_finalize = true where id = ${day.comp.divisionId}`;
      await setStatus(f[0]!, "in_play");
    });

    /** The code's own actor, and the same actor with an organiser's role: the gate is the actor's KIND, never its role. */
    const actors = async (): Promise<[string, AuthCtx][]> => {
      const { code } = await codeFor(day, { kind: "competition" });
      const own = matchDayActor(code);
      return [["the code's actor", own], ["a code's actor with an owner's role", { ...own, role: "owner" }]];
    };

    it("cannot finalize, forfeit, settle or abandon", async () => {
      const winner = day.comp.fixtures[0]!.home;
      // The device link's own refusals, word for word (scoring.ts): the same status and the same words.
      const events: [string, unknown, string][] = [
        ["core.finalize", {}, "403 Finalizing needs an organiser or scorer account"],
        ["core.forfeit", { winner, reason: "no_show" }, "403 Only an organiser can record a walkover for a match"],
        ["core.settle", { winner }, "403 Only an organiser can settle a match"],
        ["core.abandon", { reason: "weather" }, "403 Only an organiser can abandon a match"],
      ];
      let checked = 0;
      for (const [who, actor] of await actors()) {
        for (const [type, payload, refusal] of events) {
          expect(await refusedWith(scoreEvent(actor, f[0]!, { expected_seq: 0, type, payload })), `${who}: ${type}`).toBe(refusal);
          checked++;
        }
      }
      expect(checked).toBe(8);
      const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from score_events where fixture_id = ${f[0]!}`;
      expect(n, "nothing was written").toBe(0);
      const [{ status }] = await sql<{ status: string }[]>`select status from fixtures where id = ${f[0]!}`;
      expect(status).toBe("in_play");
    });

    it("cannot read a fixture's organiser surface", async () => {
      for (const [who, actor] of await actors()) {
        expect(await refusedWith(getFixture(actor, f[0]!)), who).toBe("403 Device links can only access their fixture's scoring surface");
      }
    });
  });
});
