// What `/me`'s Lichess card reads (T16 / T20 m1, reworked 2026-11-18): whether the player is linked, and whether their
// grant is still enough to PLAY (the same answer as the play gate, `assertLichessConsentForPlay`, checked against it
// here). The card is shown to EVERY signed-in player — linking is the player's own, not a club's, so the reader no
// longer asks which club the link is for, whether a club is offered online chess, or whether the player is entered in
// an online division. It asks the `online-chess` flag nothing, and says nothing about whether to render a card.
//
// The old rule is the contrast: every fixture below that used to yield `show: false` (entered nowhere, over the board,
// withdrawn, in a completed division, a merged person, a club not offered online chess) must now yield the same plain
// answer as a player entered online — the card does not depend on any of it.
//
// Single-sport by construction: online play exists only for `boardgame` (`supportsOnlinePlay`); the over-the-board
// division below is the other sports' answer.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";

const flags = vi.hoisted(() => ({ asked: [] as { distinctId: string; orgId: string }[] }));
vi.mock("@/lib/posthog-server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/posthog-server")>();
  return {
    ...actual,
    isServerFeatureEnabled: vi.fn(async (_flag: string, distinctId: string, o: { orgId: string }) => {
      flags.asked.push({ distinctId, orgId: o.orgId });
      return false;
    }),
  };
});

import { assertLichessConsentForPlay, PLAY_SCOPES } from "../external-accounts";
import { forgetOnlineChessFlagCache } from "../external-play/online-chess-flag";
import { myLichessLink } from "../me-lichess";
import { seedOnlineChessRound, seedPlayer, type SeedOnlineChessRoundResult } from "./_external-play-seed";

const HAS_DB = !!process.env.DATABASE_URL;

beforeEach(() => {
  flags.asked.length = 0;
});
afterEach(() => {
  vi.unstubAllEnvs();
});

/** Ask with the flag REALLY askable and OFF everywhere (the seeds turn online play on, which needs the club offered —
 *  vitest's ONLINE_CHESS_ALWAYS=1 — so the override is lifted only around the call under test). A reader that still
 *  consulted the flag would be told "no club offered" and answer as the old code did; it must answer the same. */
async function ask(userId: string) {
  flags.asked.length = 0;
  vi.stubEnv("ONLINE_CHESS_ALWAYS", undefined);
  forgetOnlineChessFlagCache();
  try {
    return await myLichessLink(userId);
  } finally {
    vi.unstubAllEnvs();
    forgetOnlineChessFlagCache();
  }
}
afterAll(async () => {
  if (HAS_DB) await sql.end({ timeout: 2 }).catch(() => undefined);
});

/** Labelled SQL: the player unlinks (the real unlink also revokes at Lichess, a network call this suite does not make). */
const dropLink = (userId: string) => sql`delete from user_external_accounts where user_id = ${userId} and provider = 'lichess'`;
const PLAIN = { linkedUsername: null, needsReconsent: false } as const;

describe.skipIf(!HAS_DB)("myLichessLink — /me's Lichess card", () => {
  it("the empty case first: not linked, entered nowhere — the plain unlinked answer, so the card still renders; no flag asked", async () => {
    const r = await seedOnlineChessRound({ fixtures: 1 });
    const loner = await seedPlayer(r.orgId, "Loner", `m-${randomUUID().slice(0, 8)}`, false);
    expect(await ask(loner.userId)).toEqual(PLAIN);
    expect(flags.asked).toEqual([]);
  });

  it("an unlinked player gets the same answer whatever they are entered in: online, over the board, withdrawn, a completed division, a merged person, a club not offered online chess", async () => {
    const cells: [string, () => Promise<SeedOnlineChessRoundResult>][] = [
      ["online, club not offered (the flag is off)", () => seedOnlineChessRound({ fixtures: 1 })],
      ["over the board", () => seedOnlineChessRound({ fixtures: 1, onlinePlay: "off" })],
      [
        "withdrawn",
        async () => {
          const r = await seedOnlineChessRound({ fixtures: 1 });
          await sql`update entrants set status = 'withdrawn' where id = ${r.boards[0]!.home.entrantId}`;
          return r;
        },
      ],
      [
        "completed division",
        async () => {
          const r = await seedOnlineChessRound({ fixtures: 1 });
          await sql`update divisions set status = 'completed' where id = ${r.divisionId}`;
          return r;
        },
      ],
      [
        "a merged person",
        async () => {
          const r = await seedOnlineChessRound({ fixtures: 1 });
          await sql`update persons set merged_into = ${r.boards[0]!.away.personId} where id = ${r.boards[0]!.home.personId}`;
          return r;
        },
      ],
    ];
    let checked = 0;
    for (const [label, seed] of cells) {
      const r = await seed();
      const user = r.boards[0]!.home.userId;
      await dropLink(user);
      expect(await ask(user), label).toEqual(PLAIN);
      expect(flags.asked, `${label}: the flag is not this reader's business`).toEqual([]);
      checked += 1;
    }
    expect(checked, "anti-vacuity: entries checked").toBe(cells.length);
  });

  it("linked: the answer names the account whatever the club offers; re-consent is asked exactly when the play gate would refuse", async () => {
    const r = await seedOnlineChessRound({ fixtures: 1 });
    const side = r.boards[0]!.home;
    const states: [string, () => Promise<unknown>][] = [
      ["full grant", async () => undefined],
      ["a play scope missing", () => sql`update user_external_accounts set scopes = ${PLAY_SCOPES.slice(1) as string[]} where user_id = ${side.userId} and provider = 'lichess'`],
      // The identity-only flow's row: no consent stamp and no token (user_external_accounts_consent_token_check).
      ["no consent stamp", () => sql`update user_external_accounts set scopes = ${[...PLAY_SCOPES]}, consented_at = null, access_token_enc = null where user_id = ${side.userId} and provider = 'lichess'`],
    ];
    const seen: boolean[] = [];
    for (const [label, arm] of states) {
      await arm();
      // The authority: the play gate itself, on the same row.
      const refused = await assertLichessConsentForPlay(side.userId).then(
        () => false,
        (e: { code?: string }) => e.code === "LICHESS_RECONSENT_REQUIRED",
      );
      expect(await ask(side.userId), label).toEqual({ linkedUsername: side.lichessId, needsReconsent: refused });
      expect(flags.asked, `${label}: no flag asked`).toEqual([]);
      seen.push(refused);
    }
    // Anti-vacuity: both answers of the gate were reached.
    expect(seen).toEqual([false, true, true]);
  });
});
