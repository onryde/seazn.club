// The organiser's roster demand on an online division reads "who holds a Lichess link" ONCE, in `withTenant`'s
// privileged prelude (the sealed table cannot be read after the role drops, and a pooled read from inside the
// transaction is a second connection — the self-deadlock pool-nesting-tripwire.test.ts pins). The prelude decides
// whether to read by looking at the division on its own connection; the transaction then re-reads the division under
// RLS. If the division turns online between those two reads, the transaction demands the link with no answer to give,
// and it must REFUSE (fail closed) rather than wave the roster through or reach for the pool.
//
// That window is microseconds wide in production and cannot be hit by timing, so the seam here is `readOnlinePlay`'s
// call ORDER inside one `createEntrants`: call 1 is the pre-read (decides whether the flag is asked), call 2 the
// prelude's read, call 3 the transaction's. Answering "off" to call 2 only is exactly the flip.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";

const seam = vi.hoisted(() => ({ calls: 0, offAt: 0 }));
vi.mock("@/server/external-play/online-play", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/external-play/online-play")>();
  return {
    ...actual,
    readOnlinePlay: (config: unknown) => {
      seam.calls++;
      return seam.calls === seam.offAt ? ("off" as const) : actual.readOnlinePlay(config);
    },
  };
});

import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { seedOwner, seedPlayer } from "./_external-play-seed";

const HAS_DB = !!process.env.DATABASE_URL;

/** The three reads of the division's online mode one `createEntrants` makes, in order. */
const READS_PER_CREATE = 3;
const PRELUDE_READ = 2;

beforeEach(() => {
  seam.calls = 0;
  seam.offAt = 0;
});

afterAll(async () => {
  if (HAS_DB) await sql.end({ timeout: 2 }).catch(() => undefined);
});

async function seedOnline(linked: boolean) {
  const auth = await seedOwner();
  const competition = await createCompetition(auth, {
    name: "Unverified " + randomUUID().slice(0, 6),
    visibility: "private",
    branding: {},
    starts_on: "2026-10-01",
    ends_on: "2026-10-02",
  });
  const division = await createDivision(auth, competition.id, {
    name: "Online",
    sport_key: "boardgame",
    variant_key: "classical",
    config: { variant: "classical", onlinePlay: "lichess", clock: { base: 600, increment: 5 } },
  });
  const player = await seedPlayer(auth.orgId, "Player", `u-${randomUUID().replaceAll("-", "").slice(0, 12)}`, linked);
  const entry = {
    display_name: "Player",
    kind: "individual" as const,
    members: [{ person_id: player.personId, is_captain: false, roles: [] }],
  };
  return { auth, divisionId: division.id, entry };
}

const entrantCount = async (divisionId: string): Promise<number> =>
  (await sql<{ n: number }[]>`select count(*)::int as n from entrants where division_id = ${divisionId}`)[0]!.n;

describe.skipIf(!HAS_DB)("createEntrants — the roster's link demand with no answer to give", () => {
  // The positive pair first: with nothing flipped, the flow reads the mode three times and a LINKED player enters.
  // It is what makes the refusal below a statement about the flip and not about the setup or the call count.
  it("premise: undisturbed, one create reads the online mode three times and a linked player enters", async () => {
    const { auth, divisionId, entry } = await seedOnline(true);
    seam.calls = 0;

    const created = await createEntrants(auth, divisionId, [entry]);

    expect(created).toHaveLength(1);
    expect(seam.calls).toBe(READS_PER_CREATE);
  });

  it("a division the prelude saw over the board but the transaction sees online refuses even a LINKED player (fails closed), and enters nobody", async () => {
    const { auth, divisionId, entry } = await seedOnline(true);
    seam.calls = 0;
    seam.offAt = PRELUDE_READ;

    await expect(createEntrants(auth, divisionId, [entry])).rejects.toMatchObject({
      status: 422,
      code: "LICHESS_LINK_REQUIRED",
    });

    expect(seam.calls, "the flip landed in the window it names: all three reads happened").toBe(READS_PER_CREATE);
    expect(await entrantCount(divisionId), "nobody entered").toBe(0);
  });
});
