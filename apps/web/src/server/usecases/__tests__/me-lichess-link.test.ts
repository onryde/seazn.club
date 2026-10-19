// T16 (T20 review m1) — what `/me`'s Lichess card reads: whether the player is
// linked, whether their grant is still enough to PLAY (the same answer as the
// play gate, `assertLichessConsentForPlay`, checked against it here), and which
// club the "Link" start names. Linking starts online chess, which is offered
// per club (the `online-chess` flag), so the start must name a club that is
// offered it AND in which this player is entered in an online division — not
// the club they happen to administer (a club-A admin entered via club B, B
// offered, A not, links through B).
//
// Single-sport by construction: online play exists only for `boardgame`
// (`supportsOnlinePlay`); the over-the-board division below is the other
// sports' answer.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";

const flags = vi.hoisted(() => ({ on: new Set<string>(), asked: [] as { distinctId: string; orgId: string }[] }));
vi.mock("@/lib/posthog-server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/posthog-server")>();
  return {
    ...actual,
    isServerFeatureEnabled: vi.fn(async (_flag: string, distinctId: string, o: { orgId: string }) => {
      flags.asked.push({ distinctId, orgId: o.orgId });
      return flags.on.has(o.orgId);
    }),
  };
});

import { assertLichessConsentForPlay, PLAY_SCOPES } from "../external-accounts";
import { forgetOnlineChessFlagCache } from "../external-play/online-chess-flag";
import { myLichessLink } from "../me-lichess";
import { seedOnlineChessRound, seedPlayer, type SeedOnlineChessRoundResult } from "./_external-play-seed";

const HAS_DB = !!process.env.DATABASE_URL;

beforeEach(() => {
  flags.on.clear();
  flags.asked.length = 0;
});
afterEach(() => {
  vi.unstubAllEnvs();
});

/** Ask with the flag REALLY asked: the seeds turn online play on, which needs the club offered (vitest's
 *  ONLINE_CHESS_ALWAYS=1), so the override is lifted only around the call under test. */
async function ask(userId: string, on: string[]) {
  flags.on = new Set(on);
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

const slugOf = async (orgId: string) =>
  (await sql<{ slug: string }[]>`select slug from organizations where id = ${orgId}`)[0]!.slug;
/** Labelled SQL: the player unlinks (the real unlink also revokes at Lichess, a network call this suite does not make). */
const dropLink = (userId: string) => sql`delete from user_external_accounts where user_id = ${userId} and provider = 'lichess'`;
/** Labelled SQL: the same player claimed in a second club — that club's person points at the same login. */
const claimIn = (r: SeedOnlineChessRoundResult, userId: string) =>
  sql`update persons set user_id = ${userId} where id = ${r.boards[0]!.home.personId}`;

describe.skipIf(!HAS_DB)("myLichessLink — /me's Lichess card", () => {
  it("the empty case first: not linked, entered nowhere online ⇒ no card, and no flag asked", async () => {
    const r = await seedOnlineChessRound({ fixtures: 1 });
    const loner = await seedPlayer(r.orgId, "Loner", `m-${randomUUID().slice(0, 8)}`, false);
    expect(await ask(loner.userId, [r.orgId])).toEqual({ show: false, linkedUsername: null, needsReconsent: false, orgSlug: null });
    expect(flags.asked).toEqual([]);
  });

  it("T20 m1: entered in two clubs — the start names the one offered online chess, asked for THIS player; neither ⇒ no card", async () => {
    const a = await seedOnlineChessRound({ fixtures: 1 });
    const b = await seedOnlineChessRound({ fixtures: 1 });
    const user = b.boards[0]!.home.userId;
    await claimIn(a, user);
    await dropLink(user);
    const [slugA, slugB] = [await slugOf(a.orgId), await slugOf(b.orgId)];
    const cells: [string, string[], string | null][] = [
      ["only B offered", [b.orgId], slugB],
      ["only A offered", [a.orgId], slugA],
      ["neither offered", [], null],
    ];
    let checked = 0;
    for (const [label, on, want] of cells) {
      const card = await ask(user, on);
      expect(card, label).toEqual({ show: want !== null, linkedUsername: null, needsReconsent: false, orgSlug: want });
      expect(flags.asked.length, `${label}: the flag was asked`).toBeGreaterThan(0);
      expect(flags.asked.every((x) => x.distinctId === user), `${label}: for this player`).toBe(true);
      checked += 1;
    }
    expect(checked).toBe(cells.length);
    // Both offered: either club is a correct start.
    expect([slugA, slugB]).toContain((await ask(user, [a.orgId, b.orgId])).orgSlug);
  });

  it("an entry that needs no link names no club: over the board, withdrawn, in a completed division, a merged person", async () => {
    const cells: [string, () => Promise<SeedOnlineChessRoundResult>][] = [
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
    ];
    let checked = 0;
    for (const [label, seed] of cells) {
      const r = await seed();
      const user = r.boards[0]!.home.userId;
      await dropLink(user);
      expect(await ask(user, [r.orgId]), label).toEqual({ show: false, linkedUsername: null, needsReconsent: false, orgSlug: null });
      checked += 1;
    }
    expect(checked, "anti-vacuity: entries checked").toBe(cells.length);
    // A person merged into another (V349) is not this login's player any more, whatever it was entered in.
    const merged = await seedOnlineChessRound({ fixtures: 1 });
    const mergedUser = merged.boards[0]!.home.userId;
    await dropLink(mergedUser);
    await sql`update persons set merged_into = ${merged.boards[0]!.away.personId} where id = ${merged.boards[0]!.home.personId}`;
    expect(await ask(mergedUser, [merged.orgId]), "merged person").toEqual({ show: false, linkedUsername: null, needsReconsent: false, orgSlug: null });
    // The positive pair: the same seed, untouched, names its club.
    const ok = await seedOnlineChessRound({ fixtures: 1 });
    await dropLink(ok.boards[0]!.home.userId);
    expect((await ask(ok.boards[0]!.home.userId, [ok.orgId])).orgSlug).toBe(await slugOf(ok.orgId));
  });

  it("linked: the card shows (so the player can unlink) whatever the flag; re-consent is asked exactly when the play gate would refuse", async () => {
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
      for (const on of [[r.orgId], []]) {
        const card = await ask(side.userId, on);
        expect(card, `${label}, flag ${on.length > 0}`).toMatchObject({
          show: true,
          linkedUsername: side.lichessId,
          needsReconsent: refused,
          orgSlug: on.length > 0 ? await slugOf(r.orgId) : null,
        });
      }
      seen.push(refused);
    }
    // Anti-vacuity: both answers of the gate were reached.
    expect(seen).toEqual([false, true, true]);
  });
});
