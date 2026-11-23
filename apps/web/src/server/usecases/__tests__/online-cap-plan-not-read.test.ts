// Cap-256 re-review n2: Reinstate and the online switch judge an online division against min(plan cap, 256), with the plan read BEFORE
// their transaction (`openOnlineCapGuard`). A door whose read never happened must fail CLOSED - a missing guard is not an unlimited plan
// (`planLimit: null` is), and reading it as one would put the flat 256 back where a lower plan binds (the m1 hole). No state the product
// reaches skips the read, so this file forces it: `openOnlineCapGuard` answers undefined, and each door is driven through its real
// usecase. The controls are the same doors where the plan is never asked (over the board; a re-send of a stored 'lichess').
//
// Real Postgres required (skipped without DATABASE_URL). Single sport: online play exists for boardgame alone.
import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("@/server/external-play/online-entrant-cap", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/external-play/online-entrant-cap")>();
  return { ...actual, openOnlineCapGuard: vi.fn(async () => undefined) };
});

import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { openOnlineCapGuard, PLAN_LIMIT_NOT_READ } from "@/server/external-play/online-entrant-cap";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision, patchDivision } from "../divisions";
import { patchEntrant } from "../entrants";
import { seedOwner } from "./_external-play-seed";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (HAS_DB) await sql.end({ timeout: 2 }).catch(() => undefined);
});

async function divisionOf(auth: AuthCtx, online: boolean) {
  const competition = await createCompetition(auth, {
    name: "Unread Cup " + randomUUID().slice(0, 6),
    visibility: "private",
    branding: {},
    starts_on: "2030-11-01",
    ends_on: "2030-11-02",
  });
  return createDivision(auth, competition.id, {
    name: online ? "Online" : "Over the board",
    sport_key: "boardgame",
    variant_key: "classical",
    config: { variant: "classical", ...(online ? { onlinePlay: "lichess" } : {}), clock: { base: 600, increment: 5 } },
  });
}

/** `n` live entrants, and the id of one more that has withdrawn (the one a Reinstate brings back). */
async function withOneWithdrawn(divisionId: string, n: number): Promise<string> {
  await sql`
    insert into entrants (division_id, kind, display_name, status)
    select ${divisionId}, 'individual', 'Seed ' || g, 'confirmed' from generate_series(1, ${n}) g`;
  const [gone] = await sql<{ id: string }[]>`
    insert into entrants (division_id, kind, display_name, status) values (${divisionId}, 'individual', 'Gone', 'withdrawn') returning id`;
  return gone!.id;
}
const statusOf = async (id: string): Promise<string> => (await sql<{ status: string }[]>`select status from entrants where id = ${id}`)[0]!.status;
const onlinePlayOf = async (divisionId: string): Promise<string | null> =>
  ((await sql<{ config: { onlinePlay?: string } }[]>`select config from divisions where id = ${divisionId}`)[0]!.config.onlinePlay ?? null);

describe.skipIf(!HAS_DB)("a door that judges an online division with its plan never read fails closed (cap-256 re-review n2)", () => {
  it("Reinstate into an online division, plan unread: refused by name, the entrant stays withdrawn; over the board the same Reinstate lands (it never asks the plan)", async () => {
    const auth = await seedOwner();
    const online = await divisionOf(auth, true);
    const gone = await withOneWithdrawn(online.id, 3); // 4 places once back: far inside every plan, so only the unread plan can refuse
    vi.mocked(openOnlineCapGuard).mockClear();
    await expect(patchEntrant(auth, gone, { status: "confirmed" })).rejects.toThrow(PLAN_LIMIT_NOT_READ);
    expect(vi.mocked(openOnlineCapGuard), "premise: the door went through the (unread) plan read").toHaveBeenCalled();
    expect(await statusOf(gone), "nothing written").toBe("withdrawn");

    const otb = await divisionOf(auth, false);
    const back = await withOneWithdrawn(otb.id, 3);
    await expect(patchEntrant(auth, back, { status: "confirmed" }), "the control: over the board").resolves.toBeTruthy();
    expect(await statusOf(back)).toBe("confirmed");
  });

  it("turning online play on, plan unread: refused by name and the division stays over the board; a re-send of a stored 'lichess' is never judged", async () => {
    const auth = await seedOwner();
    const otb = await divisionOf(auth, false);
    await withOneWithdrawn(otb.id, 3);
    vi.mocked(openOnlineCapGuard).mockClear();
    await expect(
      patchDivision(auth, otb.id, { config: { ...(otb.config as Record<string, unknown>), onlinePlay: "lichess" } }),
    ).rejects.toThrow(PLAN_LIMIT_NOT_READ);
    expect(vi.mocked(openOnlineCapGuard), "premise: the door went through the (unread) plan read").toHaveBeenCalled();
    expect(await onlinePlayOf(otb.id), "still over the board").toBeNull();

    const online = await divisionOf(auth, true);
    await expect(
      patchDivision(auth, online.id, { config: { ...(online.config as Record<string, unknown>) } }),
      "the control: no off -> lichess transition, so the plan is never asked",
    ).resolves.toBeTruthy();
    expect(await onlinePlayOf(online.id)).toBe("lichess");
  });
});
