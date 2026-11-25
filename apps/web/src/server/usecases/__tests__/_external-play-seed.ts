// Shared DB-backed seed helpers for the chess Lichess external-play guard
// suite (Task 7) and its downstream tasks (8/9/10/13). Boardgame sport/owner/
// player seeding adapted from the pre-redesign `external-play-sync.test.ts`
// (`seedBoardgameSport`/`seedOwner`/`seedPlayer`) — that file's fixture row
// used the OLD V404-era `fixture_external_play` columns and is being
// superseded task-by-task (R1); these helpers target the CURRENT schema.
import { randomBytes, randomUUID } from "node:crypto";
import { boardgame } from "@seazn/engine/sports/boardgame";
import { sql } from "@/lib/db";
import { sizeFor, type OnlineSize } from "@/lib/online-chess-package";
import { setOrgPlan } from "@/lib/__tests__/_billing-group";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";
import type { CameraPolicy } from "@/lib/camera-policy";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createStages, generateStageFixtures } from "../stages";
import { startDivision } from "../schedule";
import { createStagesOnLegacyOnline } from "./_legacy-online-stage";
import { PLAY_SCOPES, upsertLichessLink } from "../external-accounts";
import { lockDivisionForCap } from "@/server/external-play/online-entrant-cap";
import { livePackage, payOnlinePackageInTx, quoteLocked, readPackageFacts, writeOnlineSize } from "../online-package";
import { creditBreakdown, lockOrg, streamMonthlyRate } from "../stream-credits";

// A linked seed now seals a REAL token (T2), so `upsertLichessLink` needs
// LICHESS_TOKEN_KEK in the process. Set here, once, rather than in each of the
// fourteen suites that reach this helper — and only when nothing else set it,
// so a suite that pins its own key (external-accounts.test.ts) still wins, and
// a CI job or .env.local value is never overwritten. Test-only file; the
// production path reads the key from the environment as always.
process.env.LICHESS_TOKEN_KEK ??= randomBytes(32).toString("hex");

export async function seedBoardgameSport(): Promise<void> {
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('boardgame', 'Board game', ${boardgame.version}, ${sql.json(boardgame.positions as never)})
    on conflict (key) do update set module_version = excluded.module_version`;
  await sql`
    insert into sport_variants (sport_key, key, name, config, is_system)
    values ('boardgame', 'classical', 'Classical', ${sql.json(boardgame.variants.classical as never)}, true)
    on conflict on constraint sport_variants_pkey do update set config = excluded.config`;
}

export async function seedOwner(): Promise<AuthCtx> {
  // 16 hex characters (T17 re-review N4): the accumulated test database holds ~10^5 of these owners, and 8 characters
  // collided on users_email_key (external-play-seed.test.ts pins the odds against the live count).
  const suffix = randomUUID().replaceAll("-", "").slice(0, 16);
  const [{ id: userId }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified, locale)
    values (${`ep7-${suffix}@test.local`}, 'Owner', true, 'en') returning id`;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by)
    values (${"EP7 Org " + suffix}, ${"ep7-" + suffix}, ${userId}) returning id`;
  await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${userId}, 'owner')`;
  await setOrgPlan(orgId, "pro");
  await invalidateOrgEntitlements(orgId);
  await seedBoardgameSport();
  return { orgId, via: "session", userId, role: "owner", keyId: null } as AuthCtx;
}

export type SeedPlayer = { personId: string; userId: string; lichessId: string };

/** Online Chess credits Task 9 (spec 2026-11-23-online-chess-credits-design.md §7.6): the first round of an online division opens only
 *  on a PAID package that covers it. A seeded online division is therefore PAID by default - the state an organiser's division is in
 *  when its round opens - and `"unpaid"` leaves the row the create door wrote (the open-round gate's own suite). */
export type SeedPackage = "paid" | "unpaid";

/** The division's live package PAID, at the size it holds, WITH the camera price (so a camera policy a case sets later - by a door or
 *  by SQL - never leaves the package short) and WITHOUT touching the division's camera setting (the case's own policy stands: the
 *  receipt's camera ANSWER, Task 15, would write it, so the seed gives none and prices the camera through the facts it reads - the
 *  product state "paid with the camera, then turned off in Division settings"), through the real money path: the `division:` lock, then `payOnlinePackageInTx` (the org
 *  money lock, the row lock, the quote under them, the ledger debit). A precondition, not a door under test: the pay DOOR's own gates
 *  (the flag, the billing freeze, the stage kinds online play runs) are not asked, because the legacy shapes these seeds build (a
 *  league on an online division) are what staging still holds and the door would refuse to charge one. The org is granted the
 *  credits it is short (one staff-shaped `grant` row in the bought bucket, under the money lock), so a size of any price is paid.
 *  A division with no live row (an online flip by SQL, `deferOnlinePlay`) first gets the unpaid row the switch would have written,
 *  at the smallest size holding its places. */
export async function paySeededPackage(owner: AuthCtx, divisionId: string): Promise<void> {
  if (!owner.userId) throw new Error("paySeededPackage: the owner has no user to name as the payer");
  const userId = owner.userId;
  const rate = await streamMonthlyRate(owner.orgId);
  await sql.begin(async (tx) => {
    await lockDivisionForCap(tx, divisionId);
    // Priced as if the division's policy said "camera on" (`cameras: true`): the camera price without the answer's write (see above).
    const facts = { ...(await readPackageFacts(tx, divisionId, null)), cameras: true };
    let row = await livePackage(tx, divisionId);
    if (row === null) {
      const [d] = await tx<{ name: string }[]>`select name from divisions where id = ${divisionId}`;
      await writeOnlineSize(tx, { orgId: owner.orgId, divisionId, divisionName: d!.name, size: sizeFor(facts.held)! });
      row = (await livePackage(tx, divisionId))!;
    }
    const quote = await quoteLocked(tx, { orgId: owner.orgId, divisionId, size: row.size, rate }, facts);
    if (quote.shortBy !== null) {
      await lockOrg(tx, owner.orgId);
      const { total } = await creditBreakdown(tx, owner.orgId);
      await tx`
        insert into org_stream_credits (org_id, delta, reason, bucket, balance_after, note)
        values (${owner.orgId}, ${quote.shortBy}, 'grant', 'pack', ${total + quote.shortBy}, 'test seed: an online division paid for')`;
    }
    await payOnlinePackageInTx(
      tx, { orgId: owner.orgId, divisionId, userId, size: row.size, expectedOwed: quote.owed }, facts, { rate },
    );
  });
}

/** `linked: false` seeds the person/user but skips `upsertLichessLink` — for
 *  cases that need an entrant with no Lichess identity. */
export async function seedPlayer(
  orgId: string,
  name: string,
  lichessId: string,
  linked: boolean,
): Promise<SeedPlayer> {
  const [{ id: userId }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified, locale)
    values (${`${lichessId}-${randomUUID().slice(0, 6)}@t.local`}, ${name}, true, 'en') returning id`;
  const [{ id: personId }] = await sql<{ id: string }[]>`
    insert into persons (org_id, full_name, user_id)
    values (${orgId}, ${name}, ${userId}) returning id`;
  if (linked) {
    // The link now carries a sealed token (T2), so every suite that seeds a
    // linked player needs LICHESS_TOKEN_KEK in its process.
    await upsertLichessLink(userId, {
      externalUserId: lichessId,
      username: lichessId,
      scopes: [...PLAY_SCOPES],
      token: `lio_seed_${lichessId}`,
    });
  }
  return { userId, personId, lichessId };
}

/** A Lichess link in the two shapes the play gate refuses with `LICHESS_RECONSENT_REQUIRED` (`lichessGrantPlays`):
 *  - `identity-only` - the row V405's identity-only flow wrote: no token, no consent stamp, no scopes (raw SQL, because
 *    `upsertLichessLink` always writes a token and a consent stamp together - V451's consent_token CHECK);
 *  - `{ without }` - a consented grant of EVERY play scope except `without` (what a PLAY_SCOPES that grew, or a player who
 *    narrowed the grant at lichess.org, leaves behind). The scope list comes from PLAY_SCOPES, never from a typed table.
 *  `seedPlayer(..., linked: false)` first, then this - the person has an account but, until the grant plays, no way in. */
export async function linkWithoutPlayConsent(
  p: Pick<SeedPlayer, "userId" | "lichessId">,
  shape: "identity-only" | { without: string },
): Promise<void> {
  if (shape === "identity-only") {
    await sql`
      insert into user_external_accounts (user_id, provider, external_user_id, username)
      values (${p.userId}, 'lichess', ${p.lichessId}, ${p.lichessId})`;
    return;
  }
  if (!PLAY_SCOPES.includes(shape.without)) throw new Error(`linkWithoutPlayConsent: ${shape.without} is not a play scope`);
  await upsertLichessLink(p.userId, {
    externalUserId: p.lichessId,
    username: p.lichessId,
    scopes: PLAY_SCOPES.filter((s) => s !== shape.without),
    token: `lio_narrow_${p.lichessId}`,
  });
}

/** The reconnect itself: the player runs the link flow again and grants every play scope - exactly the write the OAuth
 *  callback makes (`upsertLichessLink`), over whatever row (or none) was there. */
export async function reconnectLichess(p: Pick<SeedPlayer, "userId" | "lichessId">): Promise<void> {
  await upsertLichessLink(p.userId, {
    externalUserId: p.lichessId,
    username: p.lichessId,
    scopes: [...PLAY_SCOPES],
    token: `lio_reconnect_${p.lichessId}`,
  });
}

export type SeedOnlineChessFixtureOpts = {
  onlinePlay: "off" | "lichess";
  divisionStarted: boolean;
  scheduledAt: Date;
  linked: boolean;
  /** Defaults to 15+10 (900s base, 10s increment) — a ship-1 curated control
   *  (time-controls.ts), because createDivision now REFUSES an online clock
   *  outside the catalogue (T6). The default used to be 15+0, which the
   *  gate refused until the owner ruled it onto the list (2026-10-09); the
   *  default stays 15+10. A clock the gate refuses (a delay, 1+0) can no
   *  longer be built through this helper with onlinePlay 'lichess': write it
   *  by SQL after a valid create, and say it models pre-gate legacy data. */
  clock?: { base: number; increment?: number; delay?: number };
  /** `divisions.camera_policy`, written by createDivision. Omitted ⇒ null
   *  (inherit), which is what every pre-existing division looks like. */
  cameraPolicy?: CameraPolicy;
  /** `stages.camera_policy`, the nearest level. Omitted ⇒ null (inherit). */
  stageCameraPolicy?: CameraPolicy;
  /** `competitions.camera_policy`, the NOT NULL floor. Omitted ⇒ the column
   *  default 'off'. */
  competitionCameraPolicy?: CameraPolicy;
  /** D12: inserts the `stage_round_opens` row for the fixture's round (1),
   *  opened by the seeded owner. Omitted ⇒ the round has never been opened,
   *  which is the DEFAULT state of a freshly paired round. */
  roundOpenedAt?: Date;
  /** Spec §3.2.1: the flag the round's open STORED (`stage_round_opens.staggered`): whether its check-in runs in timed batches.
   *  Omitted ⇒ false, which is what every row that existed before the capacity delta reads. */
  staggered?: boolean;
  /** The fixture's zero-based RANK among the round's fixture rows (spec §3.2.1): that many ABANDONED rows (a withdrawn board's
   *  shape - they count in the rank and are never played, so a round with them still opens) are inserted AHEAD of it
   *  (`seq_in_round` 1..rank), and it sits at seq rank + 1. Omitted ⇒ 0, the first board. */
  rank?: number;
  /** T14 (F5): the PERSON names. When given, the entrants' display_name
   *  snapshots become "Entry 1" / "Entry 2" — the text an entry flow leaves on
   *  a singles entrant — so a test can tell the resolved name from the
   *  snapshot. Omitted ⇒ both are "White" / "Black", as before. */
  homeFullName?: string;
  awayFullName?: string;
  /** Online Chess credits: the division's package, PAID by default (`paySeededPackage`); with `roundOpenedAt` it is also frozen,
   *  as an open freezes it (P8). Ignored when `onlinePlay` is 'off'. */
  onlinePackage?: SeedPackage;
};

export type SeedOnlineChessFixtureResult = {
  orgId: string;
  competitionId: string;
  divisionId: string;
  stageId: string;
  /** The seeded org owner — the actor for patchDivision / the round open. */
  ownerUserId: string;
  fixtureId: string;
  home: { entrantId: string; personId: string; userId: string; lichessId: string };
  away: { entrantId: string; personId: string; userId: string; lichessId: string };
};

/** One boardgame division, two individual entrants (White/Black — each with
 *  their own person + user, optionally Lichess-linked), one fixture. Mirrors
 *  the old `seedReadyFixture` shape but returns identity ids the guard suite
 *  needs (`loadSides`/`whiteSideOf`), not a bridge row (callers that need one
 *  insert it themselves — `ensureBridgeRow` or a raw SQL insert). */
export async function seedOnlineChessFixture(
  opts: SeedOnlineChessFixtureOpts,
): Promise<SeedOnlineChessFixtureResult> {
  const owner = await seedOwner();
  const ownerUserId = owner.userId;
  if (!ownerUserId) throw new Error("seedOwner returned a session with no userId");
  const competition = await createCompetition(owner, {
    name: "EP7 Cup",
    visibility: "public",
    branding: {},
    starts_on: "2026-10-01",
    ends_on: "2026-10-02",
  });
  // `createEntrants` refuses to attach an unlinked person to a division whose
  // config ALREADY reads onlinePlay 'lichess' (`createEntrants`' roster check,
  // `assertPersonIdsLinkedForOnlinePlay`) — a real product guard, not this
  // task's to relax. `linked: false` + `onlinePlay: 'lichess'` is still a
  // reachable state in production (a roster built before online play was
  // turned on, or a player who later unlinked), so it is built the same way
  // here: create the division 'off', attach the (unlinked) entrants, THEN
  // flip the config — mirroring the "forced into config" bypass the
  // non-boardgame guard test already uses.
  const deferOnlinePlay = opts.onlinePlay === "lichess" && !opts.linked;
  const division = await createDivision(owner, competition.id, {
    name: "Open",
    sport_key: "boardgame",
    variant_key: "classical",
    config: {
      variant: "classical",
      onlinePlay: deferOnlinePlay ? "off" : opts.onlinePlay,
      clock: opts.clock ?? { base: 900, increment: 10 },
    },
    // Through the product path (T6), not a raw UPDATE: the division's own
    // camera requirement is what createDivision stores.
    ...(opts.cameraPolicy ? { camera_policy: opts.cameraPolicy } : {}),
  });
  if (opts.competitionCameraPolicy) {
    await sql`update competitions set camera_policy = ${opts.competitionCameraPolicy}
               where id = ${competition.id}`;
  }
  // 12 hex characters: the accumulated test DB holds ~10^5 links, and 8 characters
  // collided (LICHESS_ALREADY_LINKED) about once in thirty property runs.
  const homeLichess = `w-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const awayLichess = `b-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const white = await seedPlayer(owner.orgId, opts.homeFullName ?? "White", homeLichess, opts.linked);
  const black = await seedPlayer(owner.orgId, opts.awayFullName ?? "Black", awayLichess, opts.linked);
  const named = opts.homeFullName !== undefined || opts.awayFullName !== undefined;
  const [home] = await createEntrants(owner, division.id, [
    {
      display_name: named ? "Entry 1" : "White",
      kind: "individual",
      members: [{ person_id: white.personId, is_captain: false, roles: [] }],
    },
  ]);
  const [away] = await createEntrants(owner, division.id, [
    {
      display_name: named ? "Entry 2" : "Black",
      kind: "individual",
      members: [{ person_id: black.personId, is_captain: false, roles: [] }],
    },
  ]);
  if (deferOnlinePlay) {
    await sql`update divisions set config = config || '{"onlinePlay":"lichess"}'::jsonb where id = ${division.id}`;
  }
  const [stage] = await createStagesOnLegacyOnline(owner, division.id, {
    seq: 1,
    kind: "league",
    name: "RR",
    config: {},
  });
  const rank = opts.rank ?? 0;
  for (let i = 1; i <= rank; i++) {
    await sql`
      insert into fixtures (stage_id, division_id, org_id, round_no, seq_in_round, ext_key, status, scheduled_at)
      values (${stage.id}, ${division.id}, ${owner.orgId}, 1, ${i}, ${`ep7-shell-${i}-${randomUUID().slice(0, 6)}`},
              'abandoned', ${opts.scheduledAt})`;
  }
  const [fixture] = await sql<{ id: string }[]>`
    insert into fixtures (stage_id, division_id, org_id, round_no, seq_in_round, ext_key,
                          status, home_entrant_id, away_entrant_id, scheduled_at)
    values (${stage.id}, ${division.id}, ${owner.orgId}, 1, ${rank + 1}, ${`ep7-${randomUUID().slice(0, 6)}`},
            'scheduled', ${home.id}, ${away.id}, ${opts.scheduledAt})
    returning id`;
  if (opts.stageCameraPolicy) {
    await sql`update stages set camera_policy = ${opts.stageCameraPolicy} where id = ${stage.id}`;
  }
  if (opts.roundOpenedAt) {
    await sql`
      insert into stage_round_opens (stage_id, org_id, round_no, opened_at, opened_by, staggered)
      values (${stage.id}, ${owner.orgId}, 1, ${opts.roundOpenedAt}, ${ownerUserId}, ${opts.staggered ?? false})`;
  }
  if (opts.divisionStarted) {
    await startDivision(owner, division.id);
  }
  if (opts.onlinePlay === "lichess" && (opts.onlinePackage ?? "paid") === "paid") {
    await paySeededPackage(owner, division.id);
    // A seeded open is a round that opened, and an open freezes the package (P8): the state the open-round gate leaves.
    if (opts.roundOpenedAt) await sql`update division_online_packages set frozen_at = now() where division_id = ${division.id} and refunded_at is null`;
  }
  return {
    orgId: owner.orgId,
    competitionId: competition.id,
    divisionId: division.id,
    stageId: stage.id,
    ownerUserId,
    fixtureId: fixture.id,
    home: { entrantId: home.id, personId: white.personId, userId: white.userId, lichessId: white.lichessId },
    away: { entrantId: away.id, personId: black.personId, userId: black.userId, lichessId: black.lichessId },
  };
}

// ---------------------------------------------------------------------------
// T19 — a whole ROUND of online boards (the organiser opens a round, not a
// fixture). Same building blocks as seedOnlineChessFixture: a real competition,
// division and entrants through the product usecases; the league boards
// themselves are inserted by SQL exactly as that seed inserts its one fixture.

export type SeedSide = SeedPlayer & { entrantId: string; email: string };

export type SeedRoundBoard = { fixtureId: string; home: SeedSide; away: SeedSide };

export type SeedOnlineChessRoundOpts = {
  /** The round the boards sit in. Defaults to 1. */
  roundNo?: number;
  /** Fully paired boards. */
  fixtures: number;
  /** One extra board with an EMPTY away seat that is not a bye — an unpaired
   *  slot (status scheduled, no outcome). */
  unpaired?: boolean;
  /** One extra one-sided award bye row, the shape swissGen writes
   *  (`home = winner, away = null, forfeited, {award, winner}`). */
  bye?: boolean;
  /** Linked pairs entered BEFORE Start but seated on no board — the players a
   *  board added to the round later (addFixture) seats. The entrant list
   *  locks at Start, so they cannot be entered afterwards. */
  spares?: number;
  /** Defaults to true (Start pressed). */
  divisionStarted?: boolean;
  /** Every board's scheduled_at. `null` ⇒ the boards carry no start time. */
  scheduledAt?: Date | null;
  /** Stored clock. Defaults to 15+10 (a ship-1 control). */
  clock?: { base: number; increment?: number; delay?: number };
  onlinePlay?: "off" | "lichess";
  cameraPolicy?: CameraPolicy;
  /** Online Chess credits: the division's package, PAID by default (`paySeededPackage`). Ignored when `onlinePlay` is 'off'. */
  onlinePackage?: SeedPackage;
};

export type SeedOnlineChessRoundResult = {
  orgId: string;
  competitionId: string;
  divisionId: string;
  stageId: string;
  roundNo: number;
  owner: AuthCtx;
  ownerUserId: string;
  boards: SeedRoundBoard[];
  /** The unpaired board, when asked for. */
  unpairedFixtureId: string | null;
  /** The bye row and its recipient, when asked for. */
  bye: { fixtureId: string; side: SeedSide } | null;
  spares: { home: SeedSide; away: SeedSide }[];
};

const ROUND_T = new Date("2026-10-01T12:10:00.000Z");

async function seedLinkedEntrant(owner: AuthCtx, divisionId: string, name: string): Promise<SeedSide> {
  const lichessId = `r-${randomUUID().slice(0, 10)}`;
  const p = await seedPlayer(owner.orgId, name, lichessId, true);
  const [e] = await createEntrants(owner, divisionId, [
    { display_name: name, kind: "individual", members: [{ person_id: p.personId, is_captain: false, roles: [] }] },
  ]);
  const [u] = await sql<{ email: string }[]>`select email from users where id = ${p.userId}`;
  return { ...p, entrantId: e!.id, email: u!.email };
}

/** Two new linked entrants in a division that has not started. */
export async function seedLinkedPair(
  owner: AuthCtx,
  divisionId: string,
): Promise<{ home: SeedSide; away: SeedSide }> {
  return {
    home: await seedLinkedEntrant(owner, divisionId, `Late ${randomUUID().slice(0, 4)} W`),
    away: await seedLinkedEntrant(owner, divisionId, `Late ${randomUUID().slice(0, 4)} B`),
  };
}

export async function seedOnlineChessRound(opts: SeedOnlineChessRoundOpts): Promise<SeedOnlineChessRoundResult> {
  const roundNo = opts.roundNo ?? 1;
  // Every entrant this seed will create: two per board, the lone and bye sides, two per spare pair.
  const onlineEntrants = opts.fixtures * 2 + (opts.unpaired ? 1 : 0) + (opts.bye ? 1 : 0) + (opts.spares ?? 0) * 2;
  const owner = await seedOwner();
  const ownerUserId = owner.userId;
  if (!ownerUserId) throw new Error("seedOwner returned a session with no userId");
  const competition = await createCompetition(owner, {
    name: "T19 Cup",
    visibility: "public",
    branding: {},
    starts_on: "2026-10-01",
    ends_on: "2026-10-02",
  });
  const division = await createDivision(owner, competition.id, {
    name: "Open",
    sport_key: "boardgame",
    variant_key: "classical",
    config: {
      variant: "classical",
      onlinePlay: opts.onlinePlay ?? "lichess",
      clock: opts.clock ?? { base: 900, increment: 10 },
    },
    ...(opts.cameraPolicy ? { camera_policy: opts.cameraPolicy } : {}),
    // A division made online opens at size 16 (Online Chess credits P14) and the size caps its entrants (Task 7): a round of more
    // boards than that names the size that holds every entrant it seeds, as an organiser who bought one would.
    ...(onlineEntrants > 16 && (opts.onlinePlay ?? "lichess") === "lichess" ? { online_size: sizeFor(onlineEntrants)! } : {}),
  });
  const [stage] = await createStagesOnLegacyOnline(owner, division.id, { seq: 1, kind: "league", name: "RR", config: {} });
  const at = opts.scheduledAt === undefined ? ROUND_T : opts.scheduledAt;
  let seq = 0;
  const insertBoard = async (home: string | null, away: string | null, extra?: { status: string; outcome: unknown }) => {
    seq += 1;
    const [row] = await sql<{ id: string }[]>`
      insert into fixtures (stage_id, division_id, org_id, round_no, seq_in_round, ext_key,
                            status, outcome, home_entrant_id, away_entrant_id, scheduled_at)
      values (${stage!.id}, ${division.id}, ${owner.orgId}, ${roundNo}, ${seq}, ${`t19-${randomUUID().slice(0, 8)}`},
              ${extra?.status ?? "scheduled"}, ${extra ? sql.json(extra.outcome as never) : null},
              ${home}, ${away}, ${at})
      returning id`;
    return row!.id;
  };
  const boards: SeedRoundBoard[] = [];
  for (let i = 0; i < opts.fixtures; i++) {
    const home = await seedLinkedEntrant(owner, division.id, `P${i + 1}W`);
    const away = await seedLinkedEntrant(owner, division.id, `P${i + 1}B`);
    boards.push({ fixtureId: await insertBoard(home.entrantId, away.entrantId), home, away });
  }
  let unpairedFixtureId: string | null = null;
  if (opts.unpaired) {
    const lone = await seedLinkedEntrant(owner, division.id, "Lone");
    unpairedFixtureId = await insertBoard(lone.entrantId, null);
  }
  let bye: SeedOnlineChessRoundResult["bye"] = null;
  if (opts.bye) {
    const side = await seedLinkedEntrant(owner, division.id, "Bye");
    const fixtureId = await insertBoard(side.entrantId, null, {
      status: "forfeited",
      outcome: { kind: "award", winner: side.entrantId },
    });
    bye = { fixtureId, side };
  }
  const spares: { home: SeedSide; away: SeedSide }[] = [];
  for (let i = 0; i < (opts.spares ?? 0); i++) spares.push(await seedLinkedPair(owner, division.id));
  if (seq === 0 && (opts.divisionStarted ?? true)) {
    // Start GENERATES a first stage that holds no fixture — this seed's boards
    // are its own SQL rows, so a board-less round cannot be started here.
    throw new Error("seedOnlineChessRound: a started division needs at least one board row");
  }
  if (opts.divisionStarted ?? true) await startDivision(owner, division.id);
  if ((opts.onlinePlay ?? "lichess") === "lichess" && (opts.onlinePackage ?? "paid") === "paid") await paySeededPackage(owner, division.id);
  return {
    orgId: owner.orgId,
    competitionId: competition.id,
    divisionId: division.id,
    stageId: stage!.id,
    roundNo,
    owner,
    ownerUserId,
    boards,
    unpairedFixtureId,
    bye,
    spares,
  };
}

/** A round with a REAL board at a chosen zero-based RANK among its fixture rows (spec §3.2.1): board 1 is rank 0, then `rank - 1`
 *  ABANDONED rows (a withdrawn board's shape: they count in the rank, are never played, and do not stop the round opening), then `ranked` - a second real board built from a spare
 *  linked pair - at rank `rank`. Both real boards go through the product's own producers (`openRound` invites them, the seat
 *  and the room read them); only the rows between them are filler, there to put the second board in a later batch. */
export async function seedOnlineChessRoundWithRankedBoard(
  opts: Omit<SeedOnlineChessRoundOpts, "fixtures" | "spares">,
  rank: number,
): Promise<SeedOnlineChessRoundResult & { ranked: SeedRoundBoard }> {
  if (!Number.isInteger(rank) || rank < 1) throw new Error(`seedOnlineChessRoundWithRankedBoard: rank must be an integer >= 1, got ${rank}`);
  const r = await seedOnlineChessRound({ ...opts, fixtures: 1, spares: 1 });
  const at = opts.scheduledAt === undefined ? ROUND_T : opts.scheduledAt;
  const roundNo = r.roundNo;
  for (let seq = 2; seq <= rank; seq++) {
    await sql`
      insert into fixtures (stage_id, division_id, org_id, round_no, seq_in_round, ext_key, status, scheduled_at)
      values (${r.stageId}, ${r.divisionId}, ${r.orgId}, ${roundNo}, ${seq}, ${`t19-shell-${seq}-${randomUUID().slice(0, 6)}`}, 'abandoned', ${at})`;
  }
  const pair = r.spares[0]!;
  const [row] = await sql<{ id: string }[]>`
    insert into fixtures (stage_id, division_id, org_id, round_no, seq_in_round, ext_key, status,
                          home_entrant_id, away_entrant_id, scheduled_at)
    values (${r.stageId}, ${r.divisionId}, ${r.orgId}, ${roundNo}, ${rank + 1}, ${`t19-ranked-${randomUUID().slice(0, 6)}`},
            'scheduled', ${pair.home.entrantId}, ${pair.away.entrantId}, ${at})
    returning id`;
  return { ...r, ranked: { fixtureId: row!.id, home: pair.home, away: pair.away } };
}

export type SeedOnlineSwissResult = {
  orgId: string;
  competitionId: string;
  divisionId: string;
  stageId: string;
  owner: AuthCtx;
  ownerUserId: string;
  players: SeedSide[];
};

/** A STARTED online Swiss stage with round 1 minted and paired through the
 *  real generator (`generateStageFixtures` twice: shells, then seats), its
 *  boards given a start time, then Start. The re-pair tests drive the REAL
 *  `unpairSwissRound` + `generateStageFixtures` against this. */
export async function seedOnlineSwiss(opts: {
  players: number;
  rounds?: number;
  pairing?: "fold" | "rank_adjacent";
  cameraPolicy?: CameraPolicy;
  /** Defaults to true (Start pressed). `false` leaves the division in `setup` with round 1 already paired - what the
   *  generator leaves before Start (check-in capacity R3: the pre-mint job serves that paired board). */
  divisionStarted?: boolean;
  /** Online Chess credits: the package size chosen at creation (the create door's default, P14, when omitted). */
  onlineSize?: OnlineSize;
  /** Online Chess credits: the division's package, PAID by default (`paySeededPackage`). */
  onlinePackage?: SeedPackage;
}): Promise<SeedOnlineSwissResult> {
  const owner = await seedOwner();
  const ownerUserId = owner.userId;
  if (!ownerUserId) throw new Error("seedOwner returned a session with no userId");
  const competition = await createCompetition(owner, {
    name: "T19 Swiss",
    visibility: "public",
    branding: {},
    starts_on: "2026-10-01",
    ends_on: "2026-10-02",
  });
  const division = await createDivision(owner, competition.id, {
    name: "Open",
    sport_key: "boardgame",
    variant_key: "classical",
    config: { variant: "classical", onlinePlay: "lichess", clock: { base: 900, increment: 10 } },
    ...(opts.cameraPolicy ? { camera_policy: opts.cameraPolicy } : {}),
    ...(opts.onlineSize !== undefined ? { online_size: opts.onlineSize } : {}),
  });
  const players: SeedSide[] = [];
  for (let i = 0; i < opts.players; i++) {
    const lichessId = `s-${randomUUID().slice(0, 10)}`;
    const p = await seedPlayer(owner.orgId, `S${i + 1}`, lichessId, true);
    const [e] = await createEntrants(owner, division.id, [
      { display_name: `S${i + 1}`, kind: "individual", seed: i + 1, members: [{ person_id: p.personId, is_captain: false, roles: [] }] },
    ]);
    const [u] = await sql<{ email: string }[]>`select email from users where id = ${p.userId}`;
    players.push({ ...p, entrantId: e!.id, email: u!.email });
  }
  const [stage] = await createStages(owner, division.id, {
    seq: 1,
    kind: "swiss",
    name: "Swiss",
    config: { rounds: opts.rounds ?? 3 },
    progression: null,
  });
  await generateStageFixtures(owner, stage!.id); // shells
  await generateStageFixtures(owner, stage!.id, opts.pairing ? { pairing: opts.pairing } : {}); // seat round 1
  // A start time on every board: the guard serves only scheduled fixtures, and
  // a timetable write is not what these tests are about.
  await sql`update fixtures set scheduled_at = ${ROUND_T} where stage_id = ${stage!.id}`;
  if (opts.divisionStarted ?? true) await startDivision(owner, division.id);
  if ((opts.onlinePackage ?? "paid") === "paid") await paySeededPackage(owner, division.id);
  return {
    orgId: owner.orgId,
    competitionId: competition.id,
    divisionId: division.id,
    stageId: stage!.id,
    owner,
    ownerUserId,
    players,
  };
}

// ---------------------------------------------------------------------------
// D16 - a RealtimeKit meeting per PLAYER. The rows preflight leaves, written directly for the suites that stage what
// the sweep, the room or the arbiter then read. A meeting is (fixture, side); a participant lives on one.
// ---------------------------------------------------------------------------

/** Check-in capacity plan 2 Task 8 (owner ruling R3): while ANY board of the scoped orgs is inside a check-in window (a round opened
 *  up to ROUND_WINDOW_TAIL_MS ago) the sweep defers its housekeeping - the teardown of rooms that are not stale-paired, and the camera
 *  evidence - and the pre-mint job makes nothing. The bound is conservative, so a case that opens its OWN round and then sweeps inside
 *  it meets the deferral. A case that is not about the deferral spreads this into the pass's deps and keeps every assertion; a case
 *  that IS about it passes no `windowsOpen` and lets the REAL scoped check read the round it opened. Fits SweepDeps and PremintDeps. */
export const NO_WINDOW = { windowsOpen: async (): Promise<boolean> => false };
/** A test's sweep pass that does NOT run the presence prune. The prune is retention, not scoped by org (presence.ts
 *  `prunePresence`): a pass deletes every presence row older than PRESENCE_RETENTION_MS, and other test files stamp theirs at fixed
 *  past instants (`_external-play-line-route.ts` OPENED) - so a concurrent file's pass deleted their rows mid-stay. Every test sweep
 *  helper spreads this FIRST; only the prune's own tests pass the real one. */
export const NO_PRUNE = { prunePresence: async () => ({ deliveries: 0, presence: 0, endedSessions: 0 }) };

export type VideoSide = "home" | "away";

/** A meeting row for one side of the board, made for the board's CURRENT pairing (the R2-2 stamp). Returns its vendor id. */
export async function putVideoMeeting(
  a: { fixtureId: string; orgId: string; side: VideoSide },
  over: { meetingId?: string; endedAt?: Date | null; evidenceAt?: Date | null } = {},
): Promise<string> {
  const meetingId = over.meetingId ?? `mtg-${a.side}-${randomUUID().slice(0, 10)}`;
  await sql`
    insert into fixture_video_meetings (fixture_id, side, org_id, meeting_id, home_entrant_id, away_entrant_id, ended_at, camera_evidence_at)
    select f.id, ${a.side}, ${a.orgId}, ${meetingId}, f.home_entrant_id, f.away_entrant_id, ${over.endedAt ?? null}, ${over.evidenceAt ?? null}
      from fixtures f where f.id = ${a.fixtureId}`;
  return meetingId;
}

/** A participant row on one side's meeting (the meeting must exist). `report` is the player's last camera report. */
export async function putVideoParticipant(
  a: { fixtureId: string; side: VideoSide; personId: string | null; preset?: "player" | "arbiter"; participantId?: string },
  over: { report?: { state: "live" | "off"; at: Date } | null; removedAt?: Date | null } = {},
): Promise<string> {
  const participantId = a.participantId ?? `pt-${a.side}-${randomUUID().slice(0, 10)}`;
  await sql`
    insert into fixture_video_participants (fixture_id, side, person_id, preset, participant_id, camera_reported, camera_reported_at, removed_at)
    values (${a.fixtureId}, ${a.side}, ${a.personId}, ${a.preset ?? "player"}, ${participantId},
            ${over.report?.state ?? null}, ${over.report?.at ?? null}, ${over.removedAt ?? null})`;
  return participantId;
}
