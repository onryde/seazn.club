// Match Day online, MD-R21 - GET /api/v1/competitions/{id}/match-day over HTTP, by the reader's ROLE: a held board's reason names the
// players' conduct (`fair_play`, the no-shows), so it is the organiser's fact, as the flags' evidence is (MD-R13). The poll carries it twice -
// on the boards of a round (`online_rounds[].round.boards[].hold_reason`) and on the boards of earlier rounds that still need a decision
// (`online_rounds[].needs_decision[].hold_reason`) - and the route accepts a read-scope key, so a stripped reason is a claim about the WIRE,
// proved here through the real handler and the real door (`requireResourceAuth` unmocked; only the cookie door is faked one layer down: the
// read-only-staff test's pattern):
//   - an OWNER and an ADMIN read WHY each board is held, in both lists;
//   - a VIEWER member and a read-scope key read null in both, the board still held for them (the null is the strip, not an unheld
//     board), and nothing else of the answer differs. (A write-scope key is the same strip: the role is what is asked, and the seeded club
//     is not entitled to write keys; the board route's usecase-level case drives one.)
//
// ONE SPORT on purpose: online play is `boardgame`'s door (guard.ts); the registry sweep of the other sports is the usecase suite's.
// Real Postgres required; skipped without DATABASE_URL (CI runs them).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const authState = vi.hoisted(() => ({ userId: "" }));

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requireUser: async () => ({ id: authState.userId }),
    getCurrentUser: async () => ({ id: authState.userId }),
    getActiveOrgId: async () => null,
  };
});

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
  headers: async () => new Headers(),
}));

import { sql } from "@/lib/db";
import { MatchDayView } from "@/server/api-v1/schemas";
import { NEEDS_REASONS } from "@/server/external-play/types";
import { createApiKey } from "@/server/usecases/api-keys";
import { makeUser } from "@/server/usecases/__tests__/_seed";
import { seedDay, type Day } from "@/server/usecases/__tests__/_match-day-seed";
import { addRound, bridgeRow, openStamp, seedOnlineDivisionIn } from "@/server/usecases/__tests__/_match-day-online-seed";
import { GET as matchDayRoute } from "../route";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  vi.unstubAllEnvs();
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});
// `online_rounds` waits for the flag (match-day.ts reads it per poll), so it is on for every test; `afterEach` restores the process env.
beforeEach(() => vi.stubEnv("MATCH_DAY_ONLINE", "1"));
afterEach(() => vi.unstubAllEnvs());

type Envelope = { ok: boolean; data?: unknown; error?: { code?: string; message?: string } };
type Wire = { online_rounds: { key: string; round: { boards: { fixtureId: string; hold_reason: string | null; state: { kind: string } }[] } | null; needs_decision: { fixtureId: string; hold_reason: string | null; state: { kind: string } }[] }[] };
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const minutes = (m: number): Date => new Date(Date.now() + m * 60_000);

async function member(orgId: string, role: "admin" | "viewer"): Promise<string> {
  const u = await makeUser(role);
  await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${u.id}, ${role})`;
  return u.id;
}

describe.skipIf(!HAS_DB)("MD-R21: /api/v1/competitions/{id}/match-day - a hold's reason is the organiser's (by role, over the wire)", () => {
  let day: Day;
  /** Round 1's held board (reason `no_show_white`): not in round 2, so it rides `needs_decision`. */
  let earlier: string;
  /** Round 2's held board (reason `fair_play`): in the round's own boards. */
  let current: string;
  let readKey: string;
  let viewer: string;
  let admin: string;

  beforeAll(async () => {
    day = await seedDay();
    const online = await seedOnlineDivisionIn(day.auth, day.comp.id, { name: "Rapid", fixtures: 1 });
    const owner = { stageId: online.stageId, orgId: day.orgId, ownerUserId: day.auth.userId! };
    // Round 1 opened 90 minutes ago, its board held; round 2 (the same players meet again) opened five minutes ago, its board held too.
    await openStamp(owner, 1, minutes(-90));
    earlier = online.boards[0]!.fixtureId;
    await bridgeRow(earlier, day.orgId, { status: "needs_organiser", reason: "no_show_white" });
    const [r2] = await addRound({ stageId: online.stageId, divisionId: online.divisionId, orgId: day.orgId }, 2, [online.boards[0]!]);
    current = r2!;
    await openStamp(owner, 2, minutes(-5));
    await bridgeRow(current, day.orgId, { status: "needs_organiser", reason: "fair_play" });
    readKey = (await createApiKey(day.auth, { name: "hold reasons read", scopes: ["read"] })).secret;
    viewer = await member(day.orgId, "viewer");
    admin = await member(day.orgId, "admin");
  });

  /** The poll as `who` reads it: a signed-in member by session, a key by its secret. */
  async function poll(userId: string, secret?: string): Promise<{ status: number; wire: Wire; body: Envelope }> {
    authState.userId = userId;
    const res = await matchDayRoute(
      new Request(`https://test.local/api/v1/competitions/${day.comp.id}/match-day`, {
        headers: secret === undefined ? {} : { authorization: `Bearer ${secret}` },
      }),
      ctx(day.comp.id),
    );
    const body = (await res.json()) as Envelope;
    return { status: res.status, wire: body.data as Wire, body };
  }
  const boardsOf = (w: Wire) => w.online_rounds.flatMap((r) => [...(r.round?.boards ?? []), ...r.needs_decision]);

  it("an OWNER and an ADMIN read WHY each board is held - the round's own board and the earlier round's, both lists", async () => {
    let checked = 0;
    for (const [who, userId] of [["owner", day.auth.userId!], ["admin", admin]] as const) {
      const { status, wire } = await poll(userId);
      expect(status, who).toBe(200);
      const byId = new Map(boardsOf(wire).map((b) => [b.fixtureId, b]));
      expect(byId.get(current)?.hold_reason, `${who}: round.boards`).toBe("fair_play");
      expect(byId.get(earlier)?.hold_reason, `${who}: needs_decision`).toBe("no_show_white");
      expect(wire.online_rounds[0]!.needs_decision.map((b) => b.fixtureId), `${who}: the earlier board is in the decisions list`).toEqual([earlier]);
      expect(wire.online_rounds[0]!.round!.boards.map((b) => b.fixtureId), `${who}: the current board is in the round`).toEqual([current]);
      checked++;
    }
    expect(checked).toBe(2);
    expect(NEEDS_REASONS as readonly string[], "the reasons seeded are the server's own words").toEqual(expect.arrayContaining(["fair_play", "no_show_white"]));
  });

  it("a VIEWER member and a read-scope key read null in BOTH lists - every board still held for them, and the reason words are nowhere in the answer", async () => {
    let checked = 0;
    for (const [who, userId, secret] of [["viewer", viewer, undefined], ["read key", "", readKey]] as const) {
      const { status, wire, body } = await poll(userId, secret);
      expect(status, who).toBe(200);
      const boards = boardsOf(wire);
      expect(boards.map((b) => b.fixtureId).sort(), `${who}: both boards are listed`).toEqual([current, earlier].sort());
      for (const b of boards) {
        expect(b.state.kind, `${who}: ${b.fixtureId} is held for every reader`).toBe("on_hold");
        expect(b.hold_reason, `${who}: ${b.fixtureId}`).toBeNull();
      }
      const text = JSON.stringify(body);
      for (const word of ["fair_play", "no_show_white"]) expect(text, `${who}: no ${word} on the wire`).not.toContain(word);
      // The published schema still parses the stripped answer, and the keys are there (null, not missing).
      expect(MatchDayView.parse(body.data).online_rounds.length, who).toBe(wire.online_rounds.length);
      expect(Object.keys(wire.online_rounds[0]!.needs_decision[0]!), `${who}: null on the wire, not a missing key`).toContain("hold_reason");
      checked++;
    }
    expect(checked, "anti-vacuity: every non-editor reader").toBe(2);
  });

  it("nothing but the reason differs between an organiser's answer and a reader's: every other key of the online rounds is the same", async () => {
    const owner = await poll(day.auth.userId!);
    const reader = await poll(viewer);
    const unreasoned = (w: Wire): unknown =>
      JSON.parse(JSON.stringify(w.online_rounds), (k, v: unknown) => (k === "hold_reason" ? undefined : v));
    expect(boardsOf(owner.wire).length, "anti-vacuity: boards compared").toBe(2);
    expect(unreasoned(reader.wire)).toEqual(unreasoned(owner.wire));
  });
});
